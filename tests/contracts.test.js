const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ValidationError,
  validateHandoffSnapshot,
  validateRollbackCheckpoint,
  validateStepRecord
} = require("../src/platform/contracts");
const { DEFAULT_AUDIT_TYPES, createAuditEvent } = require("../src/platform/audit");

test("validateStepRecord accepts valid payload", () => {
  const record = {
    step_id: "STEP-20260316-001",
    title: "Create governance baseline",
    objective: "Create mandatory governance files",
    change_scope: ["docs", "scripts"],
    commands_run: ["node scripts/verify-governance.js"],
    test_results: ["governance gate passes"],
    risks: ["none"],
    rollback_commands: ["git revert --no-edit abc123"],
    next_step: "Wire orchestrator state machine contracts.",
    status: "in_progress"
  };
  assert.doesNotThrow(() => validateStepRecord(record));
});

test("validateStepRecord rejects invalid ID", () => {
  assert.throws(
    () =>
      validateStepRecord({
        step_id: "BAD-ID",
        title: "x",
        objective: "y",
        change_scope: ["a"],
        commands_run: ["b"],
        test_results: ["c"],
        risks: ["d"],
        rollback_commands: ["e"],
        next_step: "f",
        status: "in_progress"
      }),
    ValidationError
  );
});

test("validateRollbackCheckpoint accepts valid payload", () => {
  assert.doesNotThrow(() =>
    validateRollbackCheckpoint({
      checkpoint_id: "CKPT-20260316-001",
      step_id: "STEP-20260316-001",
      git_commit: "abc123",
      db_down_migration: "N/A",
      config_rollback: "git checkout abc123 -- config/feature_flags.json",
      health_checks: ["node scripts/verify-governance.js"]
    })
  );
});

test("validateHandoffSnapshot accepts valid payload", () => {
  assert.doesNotThrow(() =>
    validateHandoffSnapshot({
      current_status: "in_progress",
      current_step_id: "STEP-20260316-001",
      blockers: ["none"],
      next_top3: ["a", "b", "c"],
      acceptance_criteria: ["x", "y", "z"]
    })
  );
});

test("createAuditEvent supports extension event types", () => {
  const event = createAuditEvent({
    trace_id: "trace-1",
    task_id: "task-1",
    attempt_id: "attempt-1",
    actor: "codex",
    source: "unit-test",
    event_type: "STEP_LOGGED",
    payload: { step_id: "STEP-20260316-001" }
  });
  assert.equal(DEFAULT_AUDIT_TYPES.has(event.event_type), true);
  assert.equal(event.payload_hash.length, 64);
});

test("provider execution audit events are registered", () => {
  assert.equal(DEFAULT_AUDIT_TYPES.has("PROVIDER_EXECUTION_REQUESTED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("PROVIDER_EXECUTION_COMPLETED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("PROVIDER_EXECUTION_FAILED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("FALLBACK_TRIGGERED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("RETRY_BUDGET_EXHAUSTED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("TAKEOVER_REQUESTED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("TAKEOVER_NOTIFICATION_SENT"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("TAKEOVER_ACTION_RECEIVED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("PROVIDER_DISCOVERY_RUN"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("PROVIDER_HEALTH_ALERT_CREATED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("PROVIDER_HEALTH_ALERT_ACKED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("DISCUSSION_STARTED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("DISCUSSION_COMPLETED"), true);
  assert.equal(DEFAULT_AUDIT_TYPES.has("DISCUSSION_DECISION_RECORDED"), true);
});
