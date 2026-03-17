const test = require("node:test");
const assert = require("node:assert/strict");

const { ValidationError } = require("../src/platform/contracts");
const { TASK_STATES, applyTransition, canTransition, createTaskSnapshot } = require("../src/orchestrator/taskStateMachine");

test("state machine allows expected transitions", () => {
  assert.equal(canTransition(TASK_STATES.PENDING, TASK_STATES.RUNNING), true);
  assert.equal(canTransition(TASK_STATES.RUNNING, TASK_STATES.WAITING_FOR_AUTH), true);
  assert.equal(canTransition(TASK_STATES.WAITING_FOR_AUTH, TASK_STATES.RUNNING), true);
  assert.equal(canTransition(TASK_STATES.RUNNING, TASK_STATES.WAITING_HUMAN), true);
  assert.equal(canTransition(TASK_STATES.WAITING_HUMAN, TASK_STATES.RUNNING), true);
  assert.equal(canTransition(TASK_STATES.RUNNING, TASK_STATES.SUCCEEDED), true);
});

test("state machine rejects invalid transitions", () => {
  assert.equal(canTransition(TASK_STATES.PENDING, TASK_STATES.SUCCEEDED), false);
  assert.equal(canTransition(TASK_STATES.SUCCEEDED, TASK_STATES.RUNNING), false);
});

test("applyTransition increments attempt on retry paths", () => {
  const pending = createTaskSnapshot({
    task_id: "task-1",
    trace_id: "trace-1",
    task_type: "analysis"
  });
  const running = applyTransition(pending, TASK_STATES.RUNNING);
  assert.equal(running.attempt, 1);

  const failed = applyTransition(running, TASK_STATES.FAILED, { error_message: "provider_error" });
  assert.equal(failed.state, TASK_STATES.FAILED);

  const retry = applyTransition(failed, TASK_STATES.RUNNING);
  assert.equal(retry.attempt, 2);
});

test("applyTransition rejects illegal transitions", () => {
  const task = createTaskSnapshot({
    task_id: "task-2",
    trace_id: "trace-2",
    task_type: "analysis"
  });

  assert.throws(() => applyTransition(task, TASK_STATES.SUCCEEDED), ValidationError);
});
