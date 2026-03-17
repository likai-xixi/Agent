const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { InMemoryImNotifier } = require("../src/takeover/imNotifier");
const { JsonFileTakeoverStore } = require("../src/takeover/takeoverStore");
const { TAKEOVER_ACTIONS, TakeoverWorkflowManager } = require("../src/takeover/takeoverWorkflow");

test("TakeoverWorkflowManager creates pending takeover and sends notification", async () => {
  const notifier = new InMemoryImNotifier();
  const manager = new TakeoverWorkflowManager({ notifier });
  const takeover = await manager.requestTakeover({
    task: {
      task_id: "task-1",
      trace_id: "trace-1"
    },
    reason: "ALL_PROVIDERS_FAILED"
  });

  assert.equal(takeover.status, "PENDING");
  assert.equal(Boolean(takeover.notification.notification_id), true);
  assert.equal(manager.listPending().length, 1);
});

test("TakeoverWorkflowManager resolves takeover action", async () => {
  const manager = new TakeoverWorkflowManager();
  await manager.requestTakeover({
    task: {
      task_id: "task-2",
      trace_id: "trace-2"
    },
    reason: "ALL_PROVIDERS_FAILED"
  });
  const resolved = manager.resolveTakeover({
    task_id: "task-2",
    action: TAKEOVER_ACTIONS.RETRY,
    actor: "oncall"
  });

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolved_action, TAKEOVER_ACTIONS.RETRY);
});

test("TakeoverWorkflowManager persists records with JsonFileTakeoverStore", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "takeover-store-"));
  const filePath = path.join(tempDir, "takeovers.json");

  const managerA = new TakeoverWorkflowManager({
    store: new JsonFileTakeoverStore({ filePath })
  });
  await managerA.requestTakeover({
    task: {
      task_id: "task-persist-1",
      trace_id: "trace-persist-1"
    },
    reason: "ALL_PROVIDERS_FAILED"
  });

  const managerB = new TakeoverWorkflowManager({
    store: new JsonFileTakeoverStore({ filePath })
  });
  const recovered = managerB.getTakeover("task-persist-1");
  assert.equal(Boolean(recovered), true);
  assert.equal(recovered.status, "PENDING");
});
