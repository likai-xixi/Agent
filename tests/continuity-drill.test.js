const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runContinuityDrill } = require("../scripts/continuity-drill");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function buildStep(stepId, rollbackCommand, status = "done") {
  return `# STEP_ID: ${stepId}

- Status: \`${status}\`

## Objective
x
## Change Scope
x
## Commands Run
x
## Test Results
x
## Risks
x
## Rollback
${rollbackCommand}
## Next Step
x
`;
}

test("runContinuityDrill passes with valid checkpoint/step/handoff trio", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-drill-"));
  const devlogDir = path.join(root, "docs", "devlog");
  const checkpointDir = path.join(devlogDir, "checkpoints");
  const handoffPath = path.join(root, "docs", "handoff", "CURRENT.md");
  const outputPath = path.join(root, "docs", "handoff", "DRILL-LAST.json");

  const stepId = "STEP-20260316-010";
  writeFile(
    path.join(devlogDir, `${stepId}.md`),
    buildStep(stepId, "git revert --no-edit checkpoint/CKPT-20260316-010")
  );
  writeFile(
    path.join(checkpointDir, "CKPT-20260316-010.json"),
    `${JSON.stringify({
      checkpoint_id: "CKPT-20260316-010",
      step_id: stepId,
      git_commit: "checkpoint/CKPT-20260316-010",
      git_tag: "checkpoint/CKPT-20260316-010",
      db_down_migration: "N/A",
      config_rollback: "git checkout HEAD~1 -- config/feature_flags.json",
      health_checks: ["npm test"],
      created_at: "2026-03-16T15:29:56Z"
    }, null, 2)}\n`
  );
  writeFile(
    handoffPath,
    `# Handoff Snapshot

- Updated At: \`2026-03-16T15:29:56Z\`
- Current Status: \`in_progress\`
- Current STEP_ID: \`${stepId}\`

## Blockers

1. None.

## Next Top 3

1. a
2. b
3. c

## Acceptance Criteria

1. x
2. y
3. z
`
  );

  const result = runContinuityDrill({
    checkpointDir,
    devlogDir,
    handoffPath,
    rollbackScriptPath: path.join(__dirname, "..", "scripts", "rollback-from-checkpoint.js"),
    sampleSize: 1,
    writePath: outputPath
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.flow_integrity.passed, true);
  assert.equal(result.rollback_drill.passed, true);
  assert.equal(result.handoff_drill.passed, true);
  assert.equal(fs.existsSync(outputPath), true);
});

test("runContinuityDrill fails when rollback section contains placeholders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-drill-bad-"));
  const devlogDir = path.join(root, "docs", "devlog");
  const checkpointDir = path.join(devlogDir, "checkpoints");
  const handoffPath = path.join(root, "docs", "handoff", "CURRENT.md");

  const stepId = "STEP-20260316-011";
  writeFile(path.join(devlogDir, `${stepId}.md`), buildStep(stepId, "TODO"));
  writeFile(
    path.join(checkpointDir, "CKPT-20260316-011.json"),
    `${JSON.stringify({
      checkpoint_id: "CKPT-20260316-011",
      step_id: stepId,
      git_commit: "checkpoint/CKPT-20260316-011",
      git_tag: "checkpoint/CKPT-20260316-011",
      db_down_migration: "N/A",
      config_rollback: "git checkout HEAD~1 -- config/feature_flags.json",
      health_checks: ["npm test"],
      created_at: "2026-03-16T15:29:56Z"
    }, null, 2)}\n`
  );
  writeFile(
    handoffPath,
    `# Handoff Snapshot

- Updated At: \`2026-03-16T15:29:56Z\`
- Current Status: \`in_progress\`
- Current STEP_ID: \`${stepId}\`

## Blockers

1. None.

## Next Top 3

1. a
2. b
3. c

## Acceptance Criteria

1. x
2. y
3. z
`
  );

  const result = runContinuityDrill({
    checkpointDir,
    devlogDir,
    handoffPath,
    rollbackScriptPath: path.join(__dirname, "..", "scripts", "rollback-from-checkpoint.js"),
    sampleSize: 1
  });

  assert.equal(result.overall_passed, false);
  assert.equal(result.flow_integrity.passed, false);
  assert.equal(
    result.flow_integrity.errors.some((item) => item.includes("Rollback section contains placeholders")),
    true
  );
});

test("runContinuityDrill skips in-progress step checkpoint by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-drill-skip-"));
  const devlogDir = path.join(root, "docs", "devlog");
  const checkpointDir = path.join(devlogDir, "checkpoints");
  const handoffPath = path.join(root, "docs", "handoff", "CURRENT.md");

  const stepId = "STEP-20260316-012";
  writeFile(path.join(devlogDir, `${stepId}.md`), buildStep(stepId, "TODO", "in_progress"));
  writeFile(
    path.join(checkpointDir, "CKPT-20260316-012.json"),
    `${JSON.stringify({
      checkpoint_id: "CKPT-20260316-012",
      step_id: stepId,
      git_commit: "checkpoint/CKPT-20260316-012",
      git_tag: "checkpoint/CKPT-20260316-012",
      db_down_migration: "N/A",
      config_rollback: "git checkout HEAD~1 -- config/feature_flags.json",
      health_checks: ["npm test"],
      created_at: "2026-03-16T15:29:56Z"
    }, null, 2)}\n`
  );
  writeFile(
    handoffPath,
    `# Handoff Snapshot

- Updated At: \`2026-03-16T15:29:56Z\`
- Current Status: \`in_progress\`
- Current STEP_ID: \`${stepId}\`

## Blockers

1. None.

## Next Top 3

1. a
2. b
3. c

## Acceptance Criteria

1. x
2. y
3. z
`
  );

  const result = runContinuityDrill({
    checkpointDir,
    devlogDir,
    handoffPath,
    rollbackScriptPath: path.join(__dirname, "..", "scripts", "rollback-from-checkpoint.js"),
    sampleSize: 1
  });

  assert.equal(result.flow_integrity.passed, true);
  assert.equal(result.rollback_drill.passed, true);
  assert.equal(result.overall_passed, true);
});
