const test = require("node:test");
const assert = require("node:assert/strict");

const { ProviderExecutionError } = require("../src/providers/adapterContract");
const { createClaudeAdapter } = require("../src/providers/claudeAdapter");

function buildRequest(overrides = {}) {
  return {
    task_id: "task-claude-1",
    trace_id: "trace-claude-1",
    input: "Write a concise answer",
    ...overrides
  };
}

test("Claude adapter falls back to stub when API key is missing", async () => {
  const adapter = createClaudeAdapter({
    apiKey: ""
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "STUB_NOT_IMPLEMENTED");
  assert.equal(result.provider, "claude");
});

test("Claude adapter executes live path with transport and normalizes output", async () => {
  const adapter = createClaudeAdapter({
    apiKey: "test-claude-key",
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        model: "claude-3-7-sonnet",
        content: [
          {
            type: "text",
            text: "Claude done"
          }
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7
        }
      }
    })
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.output, "Claude done");
  assert.equal(result.usage.total_tokens, 18);
});

test("Claude adapter normalizes auth failure as KEY_INVALID", async () => {
  const adapter = createClaudeAdapter({
    apiKey: "test-claude-key",
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

