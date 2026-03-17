#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const STEP_FILE_PATTERN = /^STEP-(\d{8})-(\d{3})\.md$/;

function nowUtcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function todayUtc() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

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
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      if (Array.isArray(args[key])) {
        args[key].push(next);
      } else {
        args[key] = [args[key], next];
      }
    } else {
      args[key] = next;
    }
    i += 1;
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nextStepId(devlogDir, day) {
  const files = fs.existsSync(devlogDir) ? fs.readdirSync(devlogDir) : [];
  let maxIndex = 0;
  for (const file of files) {
    const match = STEP_FILE_PATTERN.exec(file);
    if (match && match[1] === day) {
      maxIndex = Math.max(maxIndex, Number.parseInt(match[2], 10));
    }
  }
  return `STEP-${day}-${String(maxIndex + 1).padStart(3, "0")}`;
}

function renderStep(stepId, title, objective, owner, status, nextStep) {
  return `# STEP_ID: ${stepId}

- Title: \`${title}\`
- Owner: \`${owner}\`
- Status: \`${status}\`
- Created At: \`${nowUtcIso()}\`

## Objective

${objective}

## Change Scope

1. Fill changed files/components.
2. Fill behavior impact.

## Commands Run

\`\`\`text
Fill exact commands used in this step.
\`\`\`

## Test Results

1. Fill test command + pass/fail.
2. Fill key output summary.

## Risks

1. Fill known risks.
2. Fill mitigations.

## Rollback

\`\`\`text
git revert --no-edit <commit_hash>
<db down migration command or N/A>
<config rollback command>
\`\`\`

## Next Step

${nextStep}
`;
}

function renderHandoff(stepId, status, blockers, acceptance, nextStep) {
  const blockerList = blockers.length > 0 ? blockers : ["None."];
  const acceptanceList = acceptance.length > 0
    ? acceptance
    : [
        "Governance gate passes.",
        "Required docs paths exist and are current.",
        "Rollback instructions are executable."
      ];
  const nextTop3 = [
    nextStep,
    "Complete checkpoint metadata with commit hash/tag.",
    "Run governance gate and unit tests."
  ];
  return `# Handoff Snapshot

- Updated At: \`${nowUtcIso()}\`
- Current Status: \`${status}\`
- Current STEP_ID: \`${stepId}\`

## Blockers

${blockerList.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}

## Next Top 3

${nextTop3.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}

## Acceptance Criteria

${acceptanceList.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}
`;
}

function listArg(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function main() {
  const args = parseArgs(process.argv);
  const title = args.title;
  const objective = args.objective;
  const owner = args.owner || "codex";
  const status = args.status || "in_progress";
  const nextStep = args["next-step"] || "Pick the next atomic implementation task.";
  const blockers = listArg(args.blocker);
  const acceptance = listArg(args.acceptance);
  const dryRun = Boolean(args["dry-run"]);

  if (!title || !objective) {
    console.error("Missing required args: --title and --objective");
    process.exit(1);
  }

  const devlogDir = path.join("docs", "devlog");
  const checkpointDir = path.join("docs", "devlog", "checkpoints");
  const handoffPath = path.join("docs", "handoff", "CURRENT.md");
  ensureDir(devlogDir);
  ensureDir(checkpointDir);
  ensureDir(path.dirname(handoffPath));

  const stepId = nextStepId(devlogDir, todayUtc());
  const checkpointId = stepId.replace("STEP-", "CKPT-");
  const stepPath = path.join(devlogDir, `${stepId}.md`);
  const checkpointPath = path.join(checkpointDir, `${checkpointId}.json`);

  const checkpointPayload = {
    checkpoint_id: checkpointId,
    step_id: stepId,
    git_commit: "TO_BE_FILLED_AFTER_COMMIT",
    git_tag: "",
    db_down_migration: "N/A",
    config_rollback: "git checkout <stable_commit> -- config/feature_flags.json",
    health_checks: ["node scripts/verify-governance.js", "npm test"],
    created_at: nowUtcIso()
  };

  if (dryRun) {
    console.log(stepPath);
    console.log(checkpointPath);
    console.log(handoffPath);
    return;
  }

  fs.writeFileSync(stepPath, renderStep(stepId, title, objective, owner, status, nextStep), "utf8");
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpointPayload, null, 2)}\n`, "utf8");
  fs.writeFileSync(handoffPath, renderHandoff(stepId, status, blockers, acceptance, nextStep), "utf8");

  console.log(`Created ${stepPath}`);
  console.log(`Created ${checkpointPath}`);
  console.log(`Updated ${handoffPath}`);
}

main();

