const test = require("node:test");
const assert = require("node:assert/strict");

const { ProviderExecutionError } = require("../src/providers/adapterContract");
const { createGeminiAdapter } = require("../src/providers/geminiAdapter");

function buildRequest(overrides = {}) {
  return {
    task_id: "task-gemini-1",
    trace_id: "trace-gemini-1",
    input: "Draft a short summary",
    ...overrides
  };
}

test("Gemini adapter falls back to stub when API key is missing", async () => {
  const adapter = createGeminiAdapter({
    apiKey: ""
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "STUB_NOT_IMPLEMENTED");
  assert.equal(result.provider, "gemini");
});

test("Gemini adapter executes live path with transport and normalizes output", async () => {
  const adapter = createGeminiAdapter({
    apiKey: "test-gemini-key",
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        candidates: [
          {
            content: {
              parts: [
                { text: "Gemini done" }
              ]
            }
          }
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15
        }
      }
    })
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.output, "Gemini done");
  assert.equal(result.usage.total_tokens, 15);
});

test("Gemini adapter normalizes auth failure as KEY_INVALID", async () => {
  const adapter = createGeminiAdapter({
    apiKey: "test-gemini-key",
    transport: async () => {
      const err = new Error("Forbidden");
      err.status = 403;
      err.code = "PROVIDER_HTTP_ERROR";
      err.retryable = false;
      throw err;
    }
  });
  await assert.rejects(
    () => adapter.execute(buildRequest()),
    (error) => {
      assert.equal(error instanceof ProviderExecutionError, true);
      assert.equal(error.code, "KEY_INVALID");
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

