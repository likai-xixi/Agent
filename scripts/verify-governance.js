#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const REQUIRED_PATHS = [
  "docs/handoff",
  "docs/devlog",
  "docs/runbooks/rollback.md",
  "docs/backlog.md",
  "config/feature_flags.json"
];
const STEP_RECORD_RE = /^docs\/devlog\/STEP-\d{8}-\d{3}\.md$/;
const CHECKPOINT_RE = /^docs\/devlog\/checkpoints\/CKPT-\d{8}-\d{3}\.json$/;
const REQUIRED_SECTIONS = [
  "## Objective",
  "## Change Scope",
  "## Commands Run",
  "## Test Results",
  "## Risks",
  "## Rollback",
  "## Next Step"
];
const MATERIAL_PREFIXES = ["src/", "scripts/", "config/", ".github/workflows/"];
const HIGH_RISK_HINTS = ["fallback", "takeover", "discussion", "provider", "adapter"];

function runGit(args) {
  const proc = cp.spawnSync("git", args, { encoding: "utf8" });
  const out = `${proc.stdout || ""}${proc.stderr || ""}`;
  return { code: proc.status ?? 1, out };
}

function parseStatusPaths(statusOutput) {
  return statusOutput
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^.{1,2}\s(.+)$/);
      const payload = match ? match[1].trim() : line.trim();
      if (payload.includes(" -> ")) {
        return payload.split(" -> ").pop();
      }
      return payload;
    })
    .filter(Boolean);
}

function inGitRepo() {
  const result = runGit(["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.out.trim().toLowerCase().endsWith("true");
}

function parseArgs(argv) {
  const changedFile = [];
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--changed-file" && argv[i + 1]) {
      changedFile.push(argv[i + 1]);
      i += 1;
    }
  }
  return { changedFile };
}

function getChangedFiles(explicit) {
  if (explicit.length > 0) {
    return [...new Set(explicit)].sort();
  }
  if (!inGitRepo()) {
    return [];
  }
  const hasHead = runGit(["rev-parse", "--verify", "HEAD"]).code === 0;
  if (!hasHead) {
    return [];
  }

  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    runGit(["fetch", "origin", baseRef, "--depth", "1"]);
    const mergeBase = runGit(["merge-base", "HEAD", `origin/${baseRef}`]);
    if (mergeBase.code === 0 && mergeBase.out) {
      const diff = runGit(["diff", "--name-only", `${mergeBase.out}...HEAD`]);
      if (diff.code === 0) {
        return diff.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      }
    }
  }

  const status = runGit(["status", "--porcelain"]);
  if (status.code === 0) {
    const statusPaths = parseStatusPaths(status.out);
    if (statusPaths.length > 0) {
      return [...new Set(statusPaths)].sort();
    }
  }

  const hasPrev = runGit(["rev-parse", "--verify", "HEAD~1"]).code === 0;
  const diff = hasPrev ? runGit(["diff", "--name-only", "HEAD~1...HEAD"]) : runGit(["show", "--pretty=", "--name-only", "HEAD"]);
  if (diff.code !== 0) {
    return [];
  }
  return diff.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isMaterialChange(filePath) {
  return MATERIAL_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isHighRiskPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower === "config/feature_flags.json") {
    return true;
  }
  return lower.startsWith("src/") && HIGH_RISK_HINTS.some((hint) => lower.includes(hint));
}

function classifyChanges(changed) {
  const material = changed.filter(isMaterialChange);
  const highRisk = changed.filter(isHighRiskPath);
  const docs = changed.filter((item) => item.startsWith("docs/"));
  return { material, highRisk, docs };
}

function extractSection(text, heading) {
  const headingRegex = new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+[^\\n]+\\n|$)`);
  const match = text.match(headingRegex);
  return match ? match[1].trim() : "";
}

function validateStepRecordText(text, strictRollback) {
  const errors = [];
  for (const section of REQUIRED_SECTIONS) {
    if (!text.includes(section)) {
      errors.push(`Missing section: ${section}`);
    }
  }
  const rollback = extractSection(text, "## Rollback");
  if (!rollback) {
    errors.push("Rollback section is empty");
  } else if (strictRollback) {
    const lower = rollback.toLowerCase();
    if (lower.includes("todo") || lower.includes("<commit_hash>") || lower.includes("fill")) {
      errors.push("Rollback section contains placeholders for high-risk change");
    }
  }
  return errors;
}

function validateCheckpointFile(filePath) {
  const errors = [];
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return [`${filePath}: invalid JSON (${err.message})`];
  }
  const required = [
    "checkpoint_id",
    "step_id",
    "git_commit",
    "git_tag",
    "db_down_migration",
    "config_rollback",
    "health_checks",
    "created_at"
  ];
  for (const key of required) {
    if (!(key in payload)) {
      errors.push(`${filePath}: missing key ${key}`);
    }
  }
  if (!/^STEP-\d{8}-\d{3}$/.test(String(payload.step_id || ""))) {
    errors.push(`${filePath}: invalid step_id format`);
  }
  if (!/^CKPT-\d{8}-\d{3}$/.test(String(payload.checkpoint_id || ""))) {
    errors.push(`${filePath}: invalid checkpoint_id format`);
  }
  if (!Array.isArray(payload.health_checks) || payload.health_checks.length === 0) {
    errors.push(`${filePath}: health_checks must be a non-empty array`);
  }
  return errors;
}

function validateRequiredPaths() {
  const missing = [];
  for (const item of REQUIRED_PATHS) {
    if (!fs.existsSync(item)) {
      missing.push(`Missing required path: ${item}`);
    }
  }
  return missing;
}

function validate(changedFiles) {
  const errors = [...validateRequiredPaths()];
  const { material, highRisk } = classifyChanges(changedFiles);

  const stepFiles = changedFiles.filter((filePath) => STEP_RECORD_RE.test(filePath));
  const checkpointFiles = changedFiles.filter((filePath) => CHECKPOINT_RE.test(filePath));
  const handoffUpdated = changedFiles.includes("docs/handoff/CURRENT.md");

  if (material.length > 0 && stepFiles.length === 0) {
    errors.push("Material changes detected but no StepRecord updated under docs/devlog/STEP-*.md");
  }
  if (material.length > 0 && !handoffUpdated) {
    errors.push("Material changes detected but docs/handoff/CURRENT.md was not updated");
  }
  if (highRisk.length > 0 && checkpointFiles.length === 0) {
    errors.push("High-risk changes detected but no rollback checkpoint file updated");
  }

  const strictRollback = highRisk.length > 0;
  for (const stepFile of stepFiles) {
    if (!fs.existsSync(stepFile)) {
      errors.push(`StepRecord file missing: ${stepFile}`);
      continue;
    }
    const text = fs.readFileSync(stepFile, "utf8");
    const stepErrors = validateStepRecordText(text, strictRollback);
    for (const err of stepErrors) {
      errors.push(`${stepFile}: ${err}`);
    }
  }

  for (const checkpointFile of checkpointFiles) {
    if (!fs.existsSync(checkpointFile)) {
      errors.push(`Checkpoint file missing: ${checkpointFile}`);
      continue;
    }
    errors.push(...validateCheckpointFile(checkpointFile));
  }

  return errors;
}

function main() {
  const args = parseArgs(process.argv);
  const changedFiles = getChangedFiles(args.changedFile);
  const errors = validate(changedFiles);
  if (errors.length > 0) {
    console.error("Governance gate failed:");
    errors.forEach((error, idx) => console.error(`${idx + 1}. ${error}`));
    process.exit(1);
  }

  console.log("Governance gate passed.");
  if (changedFiles.length > 0) {
    console.log("Validated changed files:");
    changedFiles.forEach((item) => console.log(`- ${item}`));
  } else {
    console.log("No changed files detected. Structure-only validation completed.");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyChanges,
  extractSection,
  getChangedFiles,
  isHighRiskPath,
  isMaterialChange,
  parseStatusPaths,
  validate,
  validateCheckpointFile,
  validateStepRecordText
};
