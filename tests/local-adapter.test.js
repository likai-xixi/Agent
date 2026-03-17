const test = require("node:test");
const assert = require("node:assert/strict");

const { ProviderExecutionError } = require("../src/providers/adapterContract");
const { createLocalAdapter } = require("../src/providers/localAdapter");

function buildRequest(overrides = {}) {
  return {
    task_id: "task-local-1",
    trace_id: "trace-local-1",
    input: "Draft a concise local answer",
    ...overrides
  };
}

test("Local adapter falls back to stub when runtime is not configured", async () => {
  const adapter = createLocalAdapter({
    runtimeUrl: ""
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "STUB_NOT_IMPLEMENTED");
  assert.equal(result.provider, "local");
});

test("Local adapter executes live path with transport and normalizes output", async () => {
  const adapter = createLocalAdapter({
    runtimeUrl: "http://127.0.0.1:11434",
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        model: "qwen2.5:7b",
        response: "Local done",
        prompt_eval_count: 9,
        eval_count: 4,
        done: true
      }
    })
  });
  const result = await adapter.execute(buildRequest());
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.output, "Local done");
  assert.equal(result.usage.total_tokens, 13);
});

test("Local adapter normalizes runtime unavailable error", async () => {
  const adapter = createLocalAdapter({
    runtimeUrl: "http://127.0.0.1:11434",
    transport: async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1");
      err.code = "ECONNREFUSED";
      throw err;
    }
  });
  await assert.rejects(
    () => adapter.execute(buildRequest()),
    (error) => {
      assert.equal(error instanceof ProviderExecutionError, true);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test("Local adapter health check exposes live capacity signals", async () => {
  const adapter = createLocalAdapter({
    runtimeUrl: "http://127.0.0.1:11434",
    enableLiveHealthCheck: true,
    maxConcurrency: 4,
    queueDepth: 2,
    transport: async () => ({
      ok: true,
      status: 200,
      body: {
        models: [
          { name: "qwen2.5:7b" },
          { name: "llama3.1:8b" }
        ]
      }
    })
  });
  const health = await adapter.healthCheck();
  assert.equal(health.healthy, true);
  assert.equal(health.mode, "live");
  assert.equal(health.capacity_signals.max_concurrency, 4);
  assert.equal(health.capacity_signals.queue_depth, 2);
  assert.deepEqual(health.capacity_signals.available_models, ["qwen2.5:7b", "llama3.1:8b"]);
});
