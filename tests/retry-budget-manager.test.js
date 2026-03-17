const test = require("node:test");
const assert = require("node:assert/strict");

const { ValidationError } = require("../src/platform/contracts");
const { RetryBudgetManager } = require("../src/orchestrator/retryBudgetManager");

test("RetryBudgetManager allows attempts within budget", () => {
  const manager = new RetryBudgetManager({ defaultMaxAttempts: 3 });
  const task = {
    task_id: "task-1",
    metadata: {}
  };
  assert.doesNotThrow(() => manager.assertCanUseAttempt(task, 1));
  assert.doesNotThrow(() => manager.assertCanUseAttempt(task, 3));
  assert.equal(manager.remainingAttempts(task, 1), 2);
});

test("RetryBudgetManager rejects attempts beyond budget", () => {
  const manager = new RetryBudgetManager({ defaultMaxAttempts: 2 });
  const task = {
    task_id: "task-2",
    metadata: {}
  };
  assert.throws(() => manager.assertCanUseAttempt(task, 3), ValidationError);
});

