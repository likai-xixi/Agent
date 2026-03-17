const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runDeploymentReadiness } = require("../scripts/deployment-readiness");

function createFeatureFlagsFile(root, overrides = {}) {
  const filePath = path.join(root, "config", "feature_flags.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    adaptive_routing_enabled: false,
    openai_adapter_enabled: false,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

test("runDeploymentReadiness passes with healthy command and smoke checks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-pass-"));
  const featureFlagPath = createFeatureFlagsFile(root);

  const outputs = {
    "node scripts/verify-governance.js": "Governance gate passed.",
    "npm test": "all tests passed",
    "npm run drill:continuity": "{\"overall_passed\": true}",
    "npm run test:load": "{\"successRate\":1,\"p95LatencyMs\":42}"
  };

  const result = await runDeploymentReadiness({
    cwd: root,
    featureFlagPath,
    commandRunner: (command) => ({
      command,
      exit_code: 0,
      duration_ms: 10,
      output: outputs[command] || ""
    }),
    apiSmokeRunner: async () => ({
      passed: true,
      checks: [
        { name: "health_endpoint", status: 200, passed: true },
        { name: "audit_integrity_endpoint", status: 200, passed: true }
      ]
    }),
    commands: [
      "node scripts/verify-governance.js",
      "npm test",
      "npm run drill:continuity",
      "npm run test:load"
    ]
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.feature_flag_safety.passed, true);
  assert.equal(result.load_thresholds.passed, true);
});

test("runDeploymentReadiness fails when load thresholds are exceeded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-load-fail-"));
  const featureFlagPath = createFeatureFlagsFile(root);

  const result = await runDeploymentReadiness({
    cwd: root,
    featureFlagPath,
    commandRunner: (command) => ({
      command,
      exit_code: 0,
      duration_ms: 10,
      output: command.includes("test:load") ? "{\"successRate\":0.98,\"p95LatencyMs\":260}" : "ok"
    }),
    apiSmokeRunner: async () => ({
      passed: true,
      checks: []
    }),
    commands: [
      "node scripts/verify-governance.js",
      "npm test",
      "npm run drill:continuity",
      "npm run test:load"
    ],
    minLoadSuccessRate: 0.99,
    maxLoadP95Ms: 150
  });

  assert.equal(result.overall_passed, false);
  assert.equal(result.load_thresholds.passed, false);
  assert.equal(result.load_thresholds.reason, "THRESHOLD_EXCEEDED");
});

test("runDeploymentReadiness fails when high-risk feature flags are enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-flag-fail-"));
  const featureFlagPath = createFeatureFlagsFile(root, {
    takeover_engine_enabled: true
  });

  const result = await runDeploymentReadiness({
    cwd: root,
    featureFlagPath,
    commandRunner: (command) => ({
      command,
      exit_code: 0,
      duration_ms: 10,
      output: command.includes("test:load") ? "{\"successRate\":1,\"p95LatencyMs\":50}" : "ok"
    }),
    apiSmokeRunner: async () => ({
      passed: true,
      checks: []
    }),
    commands: [
      "node scripts/verify-governance.js",
      "npm test",
      "npm run drill:continuity",
      "npm run test:load"
    ]
  });

  assert.equal(result.overall_passed, false);
  assert.equal(result.feature_flag_safety.passed, false);
  assert.equal(result.feature_flag_safety.reason, "HIGH_RISK_FLAGS_ENABLED");
});
