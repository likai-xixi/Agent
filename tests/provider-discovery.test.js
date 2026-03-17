const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDefaultProviderRegistry } = require("../src/providers/providerRegistry");
const { ProviderDiscoveryService } = require("../src/monitoring/providerDiscovery");

function buildFlags(overrides = {}) {
  return {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    adaptive_routing_enabled: false,
    openai_adapter_enabled: true,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
}

test("ProviderDiscoveryService creates alerts when provider health degrades", async () => {
  const registry = buildDefaultProviderRegistry({
    flags: buildFlags(),
    healthOverrides: {
      local: {
        healthy: false,
        score: 0.1,
        latency_ms: 1000
      }
    }
  });
  const discovery = new ProviderDiscoveryService({
    providerRegistry: registry
  });

  const result = await discovery.runDiscovery({
    actor: "test",
    source: "unit-test"
  });
  assert.equal(Boolean(result.snapshot.discovery_id), true);
  assert.equal(result.alerts_created.length > 0, true);
  assert.equal(discovery.listAlerts("OPEN").length > 0, true);
});

test("ProviderDiscoveryService supports acknowledging alerts", async () => {
  const registry = buildDefaultProviderRegistry({
    flags: buildFlags(),
    healthOverrides: {
      local: {
        healthy: false
      }
    }
  });
  const discovery = new ProviderDiscoveryService({
    providerRegistry: registry
  });
  await discovery.runDiscovery();
  const openAlerts = discovery.listAlerts("OPEN");
  assert.equal(openAlerts.length > 0, true);

  const acked = discovery.acknowledgeAlert({
    alert_id: openAlerts[0].alert_id,
    actor: "oncall",
    note: "acknowledged"
  });
  assert.equal(acked.status, "ACKED");
});

