const test = require("node:test");
const assert = require("node:assert/strict");

const { ValidationError } = require("../src/platform/contracts");
const { buildDefaultProviderRegistry } = require("../src/providers/providerRegistry");

function buildFlags(overrides = {}) {
  return {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    openai_adapter_enabled: false,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
}

test("registry exposes only enabled providers by feature flags", () => {
  const registry = buildDefaultProviderRegistry({
    flags: buildFlags()
  });
  assert.deepEqual(registry.getEnabledProviders(), ["local"]);
});

test("registry supports all providers when all adapter flags enabled", () => {
  const registry = buildDefaultProviderRegistry({
    flags: buildFlags({
      openai_adapter_enabled: true,
      gemini_adapter_enabled: true,
      claude_adapter_enabled: true
    })
  });
  const enabled = registry.getEnabledProviders().sort();
  assert.deepEqual(enabled, ["claude", "gemini", "local", "openai"]);
});

test("registry rejects disabled explicit provider", async () => {
  const registry = buildDefaultProviderRegistry({
    flags: buildFlags()
  });
  await assert.rejects(
    () =>
      registry.execute({
        provider: "openai",
        request: {
          task_id: "task-1",
          trace_id: "trace-1",
          input: "hello"
        }
      }),
    ValidationError
  );
});

test("registry falls back to enabled provider", async () => {
  const registry = buildDefaultProviderRegistry({
    flags: buildFlags({
      openai_adapter_enabled: true
    })
  });
  const result = await registry.execute({
    provider: "",
    fallbackProviders: ["openai"],
    request: {
      task_id: "task-1",
      trace_id: "trace-1",
      input: "hello"
    }
  });
  assert.equal(result.selected_provider, "openai");
  assert.equal(result.result.status, "STUB_NOT_IMPLEMENTED");
});

test("registry health override is applied", async () => {
  const registry = buildDefaultProviderRegistry({
    flags: buildFlags({
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    }),
    healthOverrides: {
      local: {
        healthy: false,
        score: 0.1
      }
    }
  });
  const health = await registry.getProviderHealth("local");
  assert.equal(health.healthy, false);
  assert.equal(health.score, 0.1);
});
