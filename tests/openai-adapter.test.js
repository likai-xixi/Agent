const test = require("node:test");
const assert = require("node:assert/strict");

const { ProviderExecutionError } = require("../src/providers/adapterContract");
const { createOpenAIAdapter } = require("../src/providers/openaiAdapter");

function buildRequest(overrides = {}) {
  return {
    task_id: "task-openai-1",
    trace_id: "trace-openai-1",
    input: "Summarize this task",
    ...overrides
  };
}

test("OpenAI adapter falls back to stub when API key is missing", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: ""
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "STUB_NOT_IMPLEMENTED");
  assert.equal(result.provider, "openai");
});

test("OpenAI adapter executes live path with transport and normalizes output", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: "test-api-key",
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        model: "gpt-4.1",
        choices: [
          {
            message: {
              content: "Done"
            }
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20
        }
      }
    })
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.output, "Done");
  assert.equal(result.usage.total_tokens, 20);
});

test("OpenAI adapter normalizes auth failure as KEY_INVALID", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: "test-api-key",
    transport: async () => {
      const err = new Error("Unauthorized");
      err.status = 401;
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

