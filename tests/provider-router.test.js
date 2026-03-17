const test = require("node:test");
const assert = require("node:assert/strict");

const { AdaptiveProviderRouter } = require("../src/orchestrator/providerRouter");

test("AdaptiveProviderRouter ranks providers by balanced score", () => {
  const router = new AdaptiveProviderRouter({
    profiles: {
      local: { default_model: "local", cost_per_1k_tokens: 0.001 },
      openai: { default_model: "gpt-4.1", cost_per_1k_tokens: 0.02 }
    }
  });
  const ranking = router.rankProviders({
    enabledProviders: ["local", "openai"],
    healthList: [
      { provider: "local", healthy: true, score: 0.95, latency_ms: 130 },
      { provider: "openai", healthy: true, score: 0.95, latency_ms: 320 }
    ],
    mode: "balanced",
    preferredProvider: "",
    fallbackProviders: [],
    taskType: "generic",
    desiredModel: ""
  });
  assert.equal(ranking[0].provider, "local");
});

test("AdaptiveProviderRouter supports preferred provider boost", () => {
  const router = new AdaptiveProviderRouter({
    profiles: {
      local: { default_model: "local", cost_per_1k_tokens: 0.001 },
      openai: { default_model: "gpt-4.1", cost_per_1k_tokens: 0.02 }
    }
  });
  const ranking = router.rankProviders({
    enabledProviders: ["local", "openai"],
    healthList: [
      { provider: "local", healthy: true, score: 0.8, latency_ms: 130 },
      { provider: "openai", healthy: true, score: 0.9, latency_ms: 260 }
    ],
    mode: "performance",
    preferredProvider: "openai",
    fallbackProviders: [],
    taskType: "generic",
    desiredModel: ""
  });
  assert.equal(ranking[0].provider, "openai");
});

