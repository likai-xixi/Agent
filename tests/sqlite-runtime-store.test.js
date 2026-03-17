const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");
const { TASK_STATES } = require("../src/orchestrator/taskStateMachine");
const {
  SqliteAuditEventStore,
  SqliteHealthAlarmStore,
  SqliteRuntimeDatabase,
  SqliteTakeoverStore,
  SqliteTaskSnapshotStore
} = require("../src/persistence/sqliteRuntimeStore");

function buildFlags(overrides = {}) {
  return {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    adaptive_routing_enabled: false,
    openai_adapter_enabled: false,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
}

test("SQLite runtime stores persist audit/task/takeover/alert data across reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-runtime-store-"));
  const dbPath = path.join(dir, "runtime-state.db");
  const database = new SqliteRuntimeDatabase({ dbPath });
  const auditStore = new SqliteAuditEventStore({ database });
  const taskStore = new SqliteTaskSnapshotStore({ database });
  const takeoverStore = new SqliteTakeoverStore({ database });
  const alarmStore = new SqliteHealthAlarmStore({ database });

  const now = new Date().toISOString();
  auditStore.append({
    trace_id: "trace-1",
    task_id: "task-1",
    attempt_id: "attempt-0",
    actor: "unit-test",
    source: "test",
    event_type: "TASK_CREATED",
    timestamp: now,
    payload: {
      task_snapshot: {
        task_id: "task-1",
        trace_id: "trace-1"
      }
    }
  });
  taskStore.save({
    task_id: "task-1",
    trace_id: "trace-1",
    task_type: "db",
    state: "PENDING",
    attempt: 0,
    created_at: now,
    updated_at: now
  });
  takeoverStore.save({
    task_id: "task-1",
    status: "PENDING",
    updated_at: now
  });
  const createdAlert = alarmStore.createAlert({
    provider: "local",
    severity: "WARNING",
    reason: "PROVIDER_SCORE_LOW",
    message: "score low",
    snapshot: {
      discovery_id: "disc-1",
      created_at: now
    }
  });
  alarmStore.acknowledgeAlert({
    alert_id: createdAlert.alert_id,
    actor: "oncall",
    note: "acked"
  });

  database.close();

  const reopened = new SqliteRuntimeDatabase({ dbPath });
  const auditStore2 = new SqliteAuditEventStore({ database: reopened });
  const taskStore2 = new SqliteTaskSnapshotStore({ database: reopened });
  const takeoverStore2 = new SqliteTakeoverStore({ database: reopened });
  const alarmStore2 = new SqliteHealthAlarmStore({ database: reopened });

  assert.equal(auditStore2.queryByTaskId("task-1").length, 1);
  assert.equal(taskStore2.get("task-1").state, "PENDING");
  assert.equal(takeoverStore2.getByTaskId("task-1").status, "PENDING");
  assert.equal(alarmStore2.listAlerts({ status: "ACKED" }).length, 1);
  assert.equal(auditStore2.verifyIntegrity().valid, true);

  reopened.close();
});

test("TaskOrchestrator can recover task state from SQLite persistence after restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-orchestrator-"));
  const dbPath = path.join(dir, "runtime-state.db");
  const dbA = new SqliteRuntimeDatabase({ dbPath });

  const orchestratorA = new TaskOrchestrator({
    flags: buildFlags(),
    eventStore: new SqliteAuditEventStore({ database: dbA }),
    takeoverStore: new SqliteTakeoverStore({ database: dbA }),
    healthAlarmStore: new SqliteHealthAlarmStore({ database: dbA }),
    taskSnapshotStore: new SqliteTaskSnapshotStore({ database: dbA })
  });

  orchestratorA.createTask({
    task_id: "db-task-1",
    trace_id: "db-trace-1",
    task_type: "db"
  });
  orchestratorA.transitionTask({
    task_id: "db-task-1",
    to_state: TASK_STATES.RUNNING,
    reason: "start"
  });
  orchestratorA.transitionTask({
    task_id: "db-task-1",
    to_state: TASK_STATES.FAILED,
    reason: "simulated"
  });
  dbA.close();

  const dbB = new SqliteRuntimeDatabase({ dbPath });
  const orchestratorB = new TaskOrchestrator({
    flags: buildFlags(),
    eventStore: new SqliteAuditEventStore({ database: dbB }),
    takeoverStore: new SqliteTakeoverStore({ database: dbB }),
    healthAlarmStore: new SqliteHealthAlarmStore({ database: dbB }),
    taskSnapshotStore: new SqliteTaskSnapshotStore({ database: dbB })
  });
  const restored = orchestratorB.getTask("db-task-1");
  assert.equal(restored.state, TASK_STATES.FAILED);
  const listed = orchestratorB.listTasks({
    limit: 10
  });
  assert.equal(listed.some((item) => item.task_id === "db-task-1"), true);
  assert.equal(orchestratorB.getTaskHistory("db-task-1").length > 0, true);

  dbB.close();
});
