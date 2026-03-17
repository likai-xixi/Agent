const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ImCommandBridge } = require("../src/integrations/imCommandBridge");
const { LocalExecutor } = require("../src/platform/localExecutor");
const {
  AuthorizationWorkflowManager,
  JsonFileAuthorizationRequestStore
} = require("../src/platform/authorizationWorkflow");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");
const { JsonFilePolicyStore } = require("../src/platform/policyStore");

function createWorkflow(root) {
  return new AuthorizationWorkflowManager({
    policyStore: new JsonFilePolicyStore({
      filePath: path.join(root, "policies.json")
    }),
    requestStore: new JsonFileAuthorizationRequestStore({
      filePath: path.join(root, "authorization-requests.json")
    })
  });
}

test("IM bridge routes private messages into agent mailboxes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "im-bridge-mailbox-"));
  const eventStore = new JsonlAuditEventStore({
    filePath: path.join(root, "audit.jsonl")
  });
  const orchestrator = new TaskOrchestrator({
    eventStore,
    flags: {
      fallback_engine_enabled: false,
      takeover_engine_enabled: false,
      discussion_engine_enabled: true,
      adaptive_routing_enabled: false,
      shadow_execution_enabled: false,
      im_bridge_enabled: true,
      local_runner_enabled: true,
      self_healing_enabled: true,
      knowledge_transfer_enabled: true,
      tools_as_code_enabled: true,
      openai_adapter_enabled: false,
      gemini_adapter_enabled: false,
      claude_adapter_enabled: false,
      local_model_adapter_enabled: true
    }
  });
  const bridge = new ImCommandBridge({
    authorizationWorkflow: createWorkflow(root)
  });

  const result = await bridge.handleIncoming({
    payload: {
      trace_id: "trace-mailbox",
      task_id: "task-mailbox",
      actor: "tester",
      text: "@Coder please review the patch"
    },
    orchestrator
  });
  assert.equal(result.status, "ROUTED");
  const mailbox = orchestrator.getMailbox("Coder");
  assert.equal(mailbox.length, 1);
  assert.equal(mailbox[0].body, "please review the patch");
});

test("IM bridge can request authorization for local execution and then apply approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "im-bridge-auth-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const authorizationWorkflow = createWorkflow(root);
  const localExecutor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow,
    gitSafetyEnabled: false
  });
  const bridge = new ImCommandBridge({
    authorizationWorkflow,
    localExecutor
  });

  const initial = await bridge.handleIncoming({
    payload: {
      trace_id: "trace-im-auth",
      task_id: "task-im-auth",
      actor: "tester",
      command: "LOCAL_EXEC",
      operation: "WRITE_FILE",
      target_path: path.join(outside, "note.txt"),
      content: "hello"
    }
  });
  assert.equal(initial.status, "WAITING_AUTH");
  assert.equal(Boolean(initial.authorization.request_id), true);

  const approved = await bridge.handleIncoming({
    payload: {
      trace_id: "trace-im-auth",
      task_id: "task-im-auth",
      actor: "tester",
      request_id: initial.authorization.request_id,
      action: "APPROVE",
      mode: "permanent"
    }
  });
  assert.equal(approved.status, "APPROVED");

  const second = await bridge.handleIncoming({
    payload: {
      trace_id: "trace-im-auth",
      task_id: "task-im-auth",
      actor: "tester",
      command: "LOCAL_EXEC",
      operation: "WRITE_FILE",
      target_path: path.join(outside, "note.txt"),
      content: "hello"
    }
  });
  assert.equal(second.status, "COMPLETED");
  assert.equal(fs.readFileSync(path.join(outside, "note.txt"), "utf8"), "hello");
});
