const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createAuditEvent } = require("../src/platform/audit");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");

function createTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-store-"));
  const file = path.join(dir, "events.jsonl");
  return new JsonlAuditEventStore({ filePath: file });
}

test("JsonlAuditEventStore appends and queries events", () => {
  const store = createTempStore();
  const first = createAuditEvent({
    trace_id: "trace-1",
    task_id: "task-1",
    attempt_id: "attempt-1",
    actor: "tester",
    source: "unit-test",
    event_type: "TASK_CREATED",
    payload: { state: "PENDING" }
  });
  const second = createAuditEvent({
    trace_id: "trace-1",
    task_id: "task-1",
    attempt_id: "attempt-1",
    actor: "tester",
    source: "unit-test",
    event_type: "TASK_STATE_CHANGED",
    payload: { from_state: "PENDING", to_state: "RUNNING" }
  });
  const third = createAuditEvent({
    trace_id: "trace-2",
    task_id: "task-2",
    attempt_id: "attempt-1",
    actor: "tester",
    source: "unit-test",
    event_type: "TASK_CREATED",
    payload: { state: "PENDING" }
  });

  store.appendMany([first, second, third]);

  const all = store.getAllEvents();
  assert.equal(all.length, 3);
  assert.equal(typeof all[0].event_hash, "string");
  assert.equal(typeof all[0].previous_event_hash, "string");
  assert.equal(store.verifyIntegrity().valid, true);
  assert.equal(store.queryByTaskId("task-1").length, 2);
  assert.equal(store.queryByTraceId("trace-1").length, 2);
  assert.equal(store.queryByTraceId("trace-2").length, 1);
});

test("JsonlAuditEventStore verifyIntegrity detects tampering", () => {
  const store = createTempStore();
  const created = createAuditEvent({
    trace_id: "trace-sec-1",
    task_id: "task-sec-1",
    attempt_id: "attempt-1",
    actor: "tester",
    source: "unit-test",
    event_type: "TASK_CREATED",
    payload: { state: "PENDING" }
  });
  store.append(created);
  assert.equal(store.verifyIntegrity().valid, true);

  const lines = fs.readFileSync(store.filePath, "utf8").trim().split(/\r?\n/);
  const first = JSON.parse(lines[0]);
  first.payload.state = "TAMPERED";
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(store.filePath, `${lines.join("\n")}\n`, "utf8");

  const integrity = store.verifyIntegrity();
  assert.equal(integrity.valid, false);
  assert.equal(["PREVIOUS_HASH_MISMATCH", "EVENT_HASH_MISMATCH"].includes(integrity.reason), true);
});
