const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DEFAULT_FLAGS,
  highRiskFlagsDisabled,
  loadFeatureFlags
} = require("../src/platform/featureFlags");

test("default flags keep high-risk features off", () => {
  assert.equal(highRiskFlagsDisabled(DEFAULT_FLAGS), true);
  assert.equal(DEFAULT_FLAGS.local_model_adapter_enabled, true);
});

test("loadFeatureFlags loads override values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flags-"));
  const file = path.join(tempDir, "flags.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      fallback_engine_enabled: true,
      local_model_adapter_enabled: false
    }),
    "utf8"
  );

  const loaded = loadFeatureFlags(file);
  assert.equal(loaded.fallback_engine_enabled, true);
  assert.equal(loaded.local_model_adapter_enabled, false);
  assert.equal(highRiskFlagsDisabled(loaded), false);
});

