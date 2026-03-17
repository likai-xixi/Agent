const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyChanges,
  isHighRiskPath,
  parseStatusPaths,
  validateStepRecordText
} = require("../scripts/verify-governance");

const VALID_STEP = `# STEP_ID: STEP-20260316-001

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
git revert --no-edit abc123
## Next Step
x
`;

test("classifyChanges splits material and docs changes", () => {
  const { material, highRisk, docs } = classifyChanges([
    "src/platform/contracts.js",
    "docs/devlog/STEP-20260316-001.md",
    "config/feature_flags.json"
  ]);
  assert.equal(material.includes("src/platform/contracts.js"), true);
  assert.equal(highRisk.includes("config/feature_flags.json"), true);
  assert.equal(docs.includes("docs/devlog/STEP-20260316-001.md"), true);
});

test("isHighRiskPath catches provider and flag updates", () => {
  assert.equal(isHighRiskPath("src/platform/providers/openai-adapter.js"), true);
  assert.equal(isHighRiskPath("config/feature_flags.json"), true);
  assert.equal(isHighRiskPath("docs/backlog.md"), false);
});

test("validateStepRecordText rejects placeholders for strict rollback", () => {
  assert.deepEqual(validateStepRecordText(VALID_STEP, true), []);
  const invalid = VALID_STEP.replace("git revert --no-edit abc123", "TODO");
  const errors = validateStepRecordText(invalid, true);
  assert.equal(errors.some((item) => item.includes("placeholders")), true);
});

test("parseStatusPaths parses git porcelain output", () => {
  const parsed = parseStatusPaths(" M docs/handoff/CURRENT.md\nA  docs/devlog/STEP-20260316-002.md\nR  a.txt -> b.txt\n");
  assert.deepEqual(parsed, ["docs/handoff/CURRENT.md", "docs/devlog/STEP-20260316-002.md", "b.txt"]);
});
