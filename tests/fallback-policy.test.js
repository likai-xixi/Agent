const test = require("node:test");
const assert = require("node:assert/strict");

const { FallbackPolicyEvaluator } = require("../src/orchestrator/fallbackPolicy");

test("FallbackPolicyEvaluator builds ordered provider candidates", () => {
  const policy = new FallbackPolicyEvaluator({
    maxProviderFallbacks: 3
  });
  const candidates = policy.buildProviderCandidates({
    preferredProvider: "openai",
    fallbackProviders: ["gemini", "claude"],
    enabledProviders: ["local", "openai", "gemini", "claude"]
  });
  assert.deepEqual(candidates, ["openai", "gemini", "claude", "local"]);
});

test("FallbackPolicyEvaluator stops fallback on non-retryable error code", () => {
  const policy = new FallbackPolicyEvaluator();
  const shouldFallback = policy.shouldFallback(
    {
      code: "AUTHENTICATION_FAILED",
      retryable: false
    },
    1,
    3
  );
  assert.equal(shouldFallback, false);
});

