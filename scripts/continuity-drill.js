#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const REQUIRED_STEP_SECTIONS = [
  "## Objective",
  "## Change Scope",
  "## Commands Run",
  "## Test Results",
  "## Risks",
  "## Rollback",
  "## Next Step"
];

const STEP_ID_RE = /^STEP-\d{8}-\d{3}$/;
const CHECKPOINT_ID_RE = /^CKPT-\d{8}-\d{3}$/;
const CHECKPOINT_FILE_RE = /^CKPT-\d{8}-\d{3}\.json$/;
const PLACEHOLDER_MARKERS = ["todo", "fill", "<commit_hash>", "<stable_commit>", "to_be_filled"];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function listCheckpointFiles(checkpointDir) {
  if (!fs.existsSync(checkpointDir)) {
    return [];
  }
  return fs
    .readdirSync(checkpointDir)
    .filter((item) => CHECKPOINT_FILE_RE.test(item))
    .sort()
    .reverse()
    .map((item) => path.join(checkpointDir, item));
}

function extractSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+[^\\n]+\\n|$)`));
  return match ? match[1].trim() : "";
}

function containsPlaceholders(text) {
  const normalized = String(text || "").toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
}

function parseStepStatus(stepText) {
  const match = String(stepText || "").match(/- Status:\s*`([^`]+)`/);
  return match ? match[1].trim().toLowerCase() : "";
}

function validateStepRecordFile(stepPath, options = {}) {
  const strictRollback = options.strictRollback !== false;
  const errors = [];
  if (!fs.existsSync(stepPath)) {
    return { errors: [`Step file not found: ${stepPath}`], text: "", status: "" };
  }
  const text = fs.readFileSync(stepPath, "utf8");
  const status = parseStepStatus(text);
  for (const section of REQUIRED_STEP_SECTIONS) {
    if (!text.includes(section)) {
      errors.push(`Missing section ${section} in ${stepPath}`);
    }
  }
  const rollback = extractSection(text, "## Rollback");
  if (!rollback) {
    errors.push(`Rollback section is empty in ${stepPath}`);
  } else if (strictRollback && containsPlaceholders(rollback)) {
    errors.push(`Rollback section contains placeholders in ${stepPath}`);
  }
  return { errors, text, status };
}

function validateCheckpointFile(checkpointPath, devlogDir, options = {}) {
  const strictRollback = options.strictRollback !== false;
  const errors = [];
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  } catch (err) {
    return {
      passed: false,
      errors: [`Invalid checkpoint JSON ${checkpointPath}: ${err.message}`],
      payload: null,
      step_status: "",
      stepPath: ""
    };
  }

  if (!CHECKPOINT_ID_RE.test(String(payload.checkpoint_id || ""))) {
    errors.push(`Invalid checkpoint_id in ${checkpointPath}`);
  }
  if (!STEP_ID_RE.test(String(payload.step_id || ""))) {
    errors.push(`Invalid step_id in ${checkpointPath}`);
  }
  if (!Array.isArray(payload.health_checks) || payload.health_checks.length === 0) {
    errors.push(`health_checks must be a non-empty array in ${checkpointPath}`);
  }

  const stepPath = path.join(devlogDir, `${payload.step_id || "UNKNOWN"}.md`);
  const stepValidation = validateStepRecordFile(stepPath, { strictRollback });
  errors.push(...stepValidation.errors);

  return {
    passed: errors.length === 0,
    errors,
    payload,
    step_status: stepValidation.status,
    stepPath
  };
}

function runRollbackDryRun({
  rollbackScriptPath,
  checkpointPath
}) {
  const proc = cp.spawnSync("node", [rollbackScriptPath, "--checkpoint", checkpointPath], {
    encoding: "utf8"
  });
  return {
    checkpoint_path: checkpointPath,
    exit_code: proc.status ?? 1,
    output: `${proc.stdout || ""}${proc.stderr || ""}`.trim()
  };
}

function countNumberedLines(text, heading) {
  const section = extractSection(text, heading);
  if (!section) {
    return 0;
  }
  return section
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => /^\d+\.\s+/.test(item)).length;
}

function parseCurrentStepId(handoffText) {
  const match = handoffText.match(/Current STEP_ID:\s*`([^`]+)`/);
  return match ? match[1].trim() : "";
}

function runHandoffDrill({
  handoffPath,
  devlogDir
}) {
  const errors = [];
  if (!fs.existsSync(handoffPath)) {
    return {
      passed: false,
      errors: [`Handoff file not found: ${handoffPath}`],
      current_step_id: "",
      next_top3_count: 0
    };
  }
  const text = fs.readFileSync(handoffPath, "utf8");
  const currentStepId = parseCurrentStepId(text);
  if (!STEP_ID_RE.test(currentStepId)) {
    errors.push(`Invalid current step id in handoff: ${currentStepId || "EMPTY"}`);
  } else {
    const stepPath = path.join(devlogDir, `${currentStepId}.md`);
    if (!fs.existsSync(stepPath)) {
      errors.push(`Current handoff step file does not exist: ${stepPath}`);
    }
  }

  const nextTop3Count = countNumberedLines(text, "## Next Top 3");
  if (nextTop3Count < 3) {
    errors.push(`Next Top 3 must contain at least 3 entries, current: ${nextTop3Count}`);
  }

  const acceptanceCount = countNumberedLines(text, "## Acceptance Criteria");
  if (acceptanceCount < 3) {
    errors.push(`Acceptance Criteria must contain at least 3 entries, current: ${acceptanceCount}`);
  }

  return {
    passed: errors.length === 0,
    errors,
    current_step_id: currentStepId,
    next_top3_count: nextTop3Count
  };
}

function runContinuityDrill(options = {}) {
  const checkpointDir = options.checkpointDir || path.join("docs", "devlog", "checkpoints");
  const devlogDir = options.devlogDir || path.join("docs", "devlog");
  const handoffPath = options.handoffPath || path.join("docs", "handoff", "CURRENT.md");
  const rollbackScriptPath = options.rollbackScriptPath || path.join("scripts", "rollback-from-checkpoint.js");
  const sampleSizeRaw = Number.parseInt(String(options.sampleSize || 3), 10);
  const sampleSize = Number.isInteger(sampleSizeRaw) && sampleSizeRaw > 0 ? sampleSizeRaw : 3;
  const excludeInProgress = options.excludeInProgress !== false;
  const writePath = options.writePath || "";

  const checkpoints = listCheckpointFiles(checkpointDir).slice(0, sampleSize);
  const flowChecks = [];
  const rollbackChecks = [];
  const flowErrors = [];
  const rollbackErrors = [];
  let expectedRollbackCount = 0;

  for (const checkpointPath of checkpoints) {
    const structureValidation = validateCheckpointFile(checkpointPath, devlogDir, { strictRollback: false });
    if (excludeInProgress && structureValidation.step_status === "in_progress") {
      flowChecks.push({
        checkpoint_path: checkpointPath,
        passed: true,
        skipped: true,
        reason: "step_in_progress"
      });
      continue;
    }

    const validation = validateCheckpointFile(checkpointPath, devlogDir, { strictRollback: true });
    flowChecks.push({
      checkpoint_path: checkpointPath,
      passed: validation.passed,
      errors: validation.errors
    });
    if (!validation.passed) {
      flowErrors.push(...validation.errors);
      continue;
    }
    expectedRollbackCount += 1;

    const rollbackResult = runRollbackDryRun({
      rollbackScriptPath,
      checkpointPath
    });
    rollbackChecks.push(rollbackResult);
    if (rollbackResult.exit_code !== 0) {
      rollbackErrors.push(`Rollback dry-run failed for ${checkpointPath}`);
    }
  }

  const handoff = runHandoffDrill({
    handoffPath,
    devlogDir
  });

  const flowPassed = flowErrors.length === 0 && checkpoints.length > 0;
  const rollbackPassed = rollbackErrors.length === 0 && rollbackChecks.length === expectedRollbackCount;
  const handoffPassed = handoff.passed;
  const overallPassed = flowPassed && rollbackPassed && handoffPassed;

  const result = {
    timestamp: new Date().toISOString(),
    sample_size: sampleSize,
    sampled_checkpoints: checkpoints.map((item) => path.basename(item, ".json")),
    flow_integrity: {
      passed: flowPassed,
      checks: flowChecks,
      errors: flowErrors
    },
    rollback_drill: {
      passed: rollbackPassed,
      checks: rollbackChecks,
      errors: rollbackErrors
    },
    handoff_drill: handoff,
    overall_passed: overallPassed
  };

  if (writePath) {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const result = runContinuityDrill({
    checkpointDir: args["checkpoint-dir"],
    devlogDir: args["devlog-dir"],
    handoffPath: args["handoff-file"],
    rollbackScriptPath: args["rollback-script"],
    sampleSize: args["sample-size"],
    excludeInProgress: args["exclude-in-progress"] === "false" ? false : true,
    writePath: args.write
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (!result.overall_passed) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CHECKPOINT_ID_RE,
  CHECKPOINT_FILE_RE,
  REQUIRED_STEP_SECTIONS,
  STEP_ID_RE,
  containsPlaceholders,
  countNumberedLines,
  extractSection,
  listCheckpointFiles,
  parseArgs,
  parseCurrentStepId,
  parseStepStatus,
  runContinuityDrill,
  runHandoffDrill,
  runRollbackDryRun,
  validateCheckpointFile,
  validateStepRecordFile
};
