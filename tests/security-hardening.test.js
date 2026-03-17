const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditEvent, REDACTED_VALUE } = require("../src/platform/audit");
const { DEFAULT_FLAGS, highRiskFlagsDisabled } = require("../src/platform/featureFlags");

test("createAuditEvent redacts sensitive payload fields", () => {
  const event = createAuditEvent({
    trace_id: "trace-security-1",
    task_id: "task-security-1",
    attempt_id: "attempt-1",
    actor: "security-test",
    source: "unit-test",
    event_type: "TASK_CREATED",
    payload: {
      api_key: "sk-live-123",
      auth_token: "token-abc",
      nested: {
        password: "p@ssw0rd",
        safe: "ok"
      },
      headers: {
        authorization: "Bearer abc"
      }
    }
  });

  assert.equal(event.payload.api_key, REDACTED_VALUE);
  assert.equal(event.payload.auth_token, REDACTED_VALUE);
  assert.equal(event.payload.nested.password, REDACTED_VALUE);
  assert.equal(event.payload.headers.authorization, REDACTED_VALUE);
  assert.equal(event.payload.nested.safe, "ok");
});

test("default feature flags satisfy least-privilege posture", () => {
  assert.equal(highRiskFlagsDisabled(DEFAULT_FLAGS), true);
  assert.equal(
    highRiskFlagsDisabled({
      ...DEFAULT_FLAGS,
      takeover_engine_enabled: true
    }),
    false
  );
});
