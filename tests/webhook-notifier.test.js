const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemoryImNotifier, createImNotifierFromEnv } = require("../src/takeover/imNotifier");
const { InMemoryOpsNotifier, createOpsNotifierFromEnv } = require("../src/monitoring/opsNotifier");

test("createImNotifierFromEnv falls back to in-memory without webhook URL", () => {
  const notifier = createImNotifierFromEnv({
    env: {}
  });
  assert.equal(notifier instanceof InMemoryImNotifier, true);
});

test("createImNotifierFromEnv sends takeover alert via webhook adapter", async () => {
  const calls = [];
  const notifier = createImNotifierFromEnv({
    env: {
      TAKEOVER_WEBHOOK_URL: "https://example.invalid/im",
      TAKEOVER_WEBHOOK_ADAPTER: "wecom"
    },
    dispatcher: async (request) => {
      calls.push(request);
      return {
        ok: true,
        attempts: 1,
        status_code: 200,
        response_body: "{\"ok\":true}"
      };
    }
  });
  const result = await notifier.sendTakeoverRequired({
    task_id: "task-001",
    trace_id: "trace-001",
    reason: "ALL_PROVIDERS_FAILED",
    actions: ["APPROVE", "RETRY", "ABORT"]
  });
  assert.equal(result.status, "SENT");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.invalid/im");
  assert.equal(calls[0].payload.msgtype, "markdown");
  assert.equal(calls[0].payload.markdown.content.includes("task_id: task-001"), true);
});

test("createOpsNotifierFromEnv falls back to in-memory without webhook URL", () => {
  const notifier = createOpsNotifierFromEnv({
    env: {}
  });
  assert.equal(notifier instanceof InMemoryOpsNotifier, true);
});

test("createOpsNotifierFromEnv routes critical alerts to critical webhook URL", async () => {
  const calls = [];
  const notifier = createOpsNotifierFromEnv({
    env: {
      OPS_WEBHOOK_ADAPTER: "dingtalk",
      OPS_WARNING_WEBHOOK_URL: "https://example.invalid/warning",
      OPS_CRITICAL_WEBHOOK_URL: "https://example.invalid/critical"
    },
    dispatcher: async (request) => {
      calls.push(request);
      return {
        ok: true,
        attempts: 1,
        status_code: 200,
        response_body: "{\"ok\":true}"
      };
    }
  });

  const notification = await notifier.sendOperationalAlert({
    type: "AUDIT_RETENTION_FAILURE",
    reasons: ["INTEGRITY_FAILURE"]
  }, {
    channel: "ops-critical",
    severity: "CRITICAL"
  });

  assert.equal(notification.status, "SENT");
  assert.equal(notification.channel, "ops-critical");
  assert.equal(notification.severity, "CRITICAL");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.invalid/critical");
  assert.equal(calls[0].payload.msgtype, "markdown");
  assert.equal(calls[0].payload.markdown.text.includes("severity: CRITICAL"), true);
});

