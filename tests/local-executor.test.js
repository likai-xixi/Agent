const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  AuthorizationWorkflowManager,
  JsonFileAuthorizationRequestStore
} = require("../src/platform/authorizationWorkflow");
const { JsonlStepJournal } = require("../src/platform/checkpointJournal");
const { LocalExecutor } = require("../src/platform/localExecutor");
const { JsonFilePolicyStore } = require("../src/platform/policyStore");

function createAuthorizationWorkflow(root) {
  return new AuthorizationWorkflowManager({
    policyStore: new JsonFilePolicyStore({
      filePath: path.join(root, "policies.json")
    }),
    requestStore: new JsonFileAuthorizationRequestStore({
      filePath: path.join(root, "authorization-requests.json")
    })
  });
}

test("local executor blocks forbidden system paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-forbidden-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const executor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow: createAuthorizationWorkflow(root),
    stepJournal: new JsonlStepJournal({
      filePath: path.join(root, "steps.jsonl")
    }),
    gitSafetyEnabled: false
  });

  await assert.rejects(() => executor.writeFile({
    trace_id: "trace-forbidden",
    task_id: "task-forbidden",
    target_path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
    content: "denied"
  }));
});

test("local executor requests authorization for non-workspace writes and can continue after approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-auth-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "external");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const authorizationWorkflow = createAuthorizationWorkflow(root);
  const executor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow,
    stepJournal: new JsonlStepJournal({
      filePath: path.join(root, "steps.jsonl")
    }),
    gitSafetyEnabled: false
  });
  const targetFile = path.join(outside, "portable.txt");

  await assert.rejects(() => executor.writeFile({
    trace_id: "trace-auth",
    task_id: "task-auth",
    target_path: targetFile,
    content: "needs approval"
  }));

  const pending = authorizationWorkflow.requestStore.list("PENDING");
  assert.equal(pending.length, 1);
  const resolved = authorizationWorkflow.resolveRequest({
    request_id: pending[0].request_id,
    action: "APPROVE",
    actor: "tester",
    mode: "permanent"
  });
  assert.equal(resolved.status, "APPROVED");

  const result = await executor.writeFile({
    trace_id: "trace-auth",
    task_id: "task-auth",
    target_path: targetFile,
    content: "authorized write"
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(fs.readFileSync(targetFile, "utf8"), "authorized write");
});

test("local executor resolves symlinked workspace paths to physical targets before authorization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-realpath-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const linkedDir = path.join(workspace, "linked-outside");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, linkedDir, process.platform === "win32" ? "junction" : "dir");

  const authorizationWorkflow = createAuthorizationWorkflow(root);
  const executor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow,
    stepJournal: new JsonlStepJournal({
      filePath: path.join(root, "steps.jsonl")
    }),
    gitSafetyEnabled: false
  });

  await assert.rejects(() => executor.writeFile({
    trace_id: "trace-realpath",
    task_id: "task-realpath",
    target_path: path.join(linkedDir, "symlinked.txt"),
    content: "should request auth"
  }));

  const pending = authorizationWorkflow.requestStore.list("PENDING");
  assert.equal(pending.length, 1);
  assert.equal(String(pending[0].resource.target_path).includes("outside"), true);
});

test("local executor can resume interrupted move operations from steps journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-resume-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const sourceFile = path.join(workspace, "source.txt");
  const destinationFile = path.join(workspace, "moved.txt");
  fs.writeFileSync(sourceFile, "resume-me", "utf8");

  const stepJournal = new JsonlStepJournal({
    filePath: path.join(root, "steps.jsonl")
  });
  const authorizationWorkflow = createAuthorizationWorkflow(root);
  authorizationWorkflow.policyStore.grantPathAccess(workspace, {
    mode: "permanent",
    actor: "tester",
    trace_id: "trace-resume"
  });
  const executor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow,
    stepJournal,
    gitSafetyEnabled: false
  });

  const checkpoint = stepJournal.beginStep({
    trace_id: "trace-resume",
    task_id: "task-resume",
    operation: "LOCAL_MOVE_FILE",
    resume_state: {
      source_file: sourceFile,
      destination_file: destinationFile
    }
  });
  stepJournal.interrupt(checkpoint.step_run_id, "move_interrupted", "simulated crash", {
    source_file: sourceFile,
    destination_file: destinationFile
  });

  const recovered = executor.resumeInterruptedWork();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].recovered, true);
  assert.equal(fs.existsSync(sourceFile), false);
  assert.equal(fs.readFileSync(destinationFile, "utf8"), "resume-me");
});

test("local executor records git sensitive scan blocks to steps journal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-git-safe-"));
  const workspace = path.join(root, "workspace");
  const skillsDir = path.join(workspace, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "tool.py"), "print('ok')\n", "utf8");
  const stepsPath = path.join(root, "steps.jsonl");
  const stepJournal = new JsonlStepJournal({
    filePath: stepsPath
  });
  const authorizationWorkflow = createAuthorizationWorkflow(root);
  authorizationWorkflow.policyStore.grantPathAccess(workspace, {
    mode: "permanent",
    actor: "tester",
    trace_id: "trace-git-block"
  });

  const { runGit } = require("../src/platform/gitSafety");
  runGit(workspace, ["init"]);
  runGit(workspace, ["config", "user.name", "local-executor-test"]);
  runGit(workspace, ["config", "user.email", "local-executor@example.com"]);
  runGit(workspace, ["add", "--", "skills/tool.py"]);
  runGit(workspace, ["commit", "-m", "baseline"]);
  fs.writeFileSync(path.join(skillsDir, "tool.py"), "API_TOKEN = 'sk-live-secret'\n", "utf8");

  const executor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow,
    stepJournal
  });

  await assert.rejects(() => executor.writeFile({
    trace_id: "trace-git-block",
    task_id: "task-git-block",
    target_path: path.join(skillsDir, "tool.py"),
    content: "updated"
  }), /SENSITIVE_SYNC_BLOCKED/);

  const records = stepJournal.getAllRecords();
  assert.equal(records.some((record) => (
    record.trace_id === "trace-git-block"
      && record.stage === "git_sensitive_scan_blocked"
      && record.metadata
      && record.metadata.code === "SENSITIVE_SYNC_BLOCKED"
  )), true);
});

test("local executor blocks obvious network commands when isolation is enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-network-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const authorizationWorkflow = createAuthorizationWorkflow(root);
  authorizationWorkflow.policyStore.grantPathAccess(workspace, {
    mode: "permanent",
    actor: "tester",
    trace_id: "trace-network"
  });
  const executor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow,
    gitSafetyEnabled: false
  });

  await assert.rejects(() => executor.execCommand({
    trace_id: "trace-network",
    task_id: "task-network",
    command: "curl",
    args: ["https://example.com"],
    cwd: workspace,
    network_isolation: true
  }));
});

test("local executor rejects exec when cwd does not physically exist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-executor-cwd-"));
  const workspace = path.join(root, "workspace");
  const missingCwd = path.join(root, "missing");
  fs.mkdirSync(workspace, { recursive: true });
  const authorizationWorkflow = createAuthorizationWorkflow(root);
  authorizationWorkflow.policyStore.grantPathAccess(workspace, {
    mode: "permanent",
    actor: "tester",
    trace_id: "trace-cwd"
  });
  authorizationWorkflow.policyStore.grantPathAccess(missingCwd, {
    mode: "permanent",
    actor: "tester",
    trace_id: "trace-cwd"
  });
  const executor = new LocalExecutor({
    workspaceRoot: workspace,
    authorizationWorkflow,
    gitSafetyEnabled: false
  });

  await assert.rejects(() => executor.execCommand({
    trace_id: "trace-cwd",
    task_id: "task-cwd",
    command: process.execPath,
    args: ["-e", "console.log('hello')"],
    cwd: missingCwd,
    network_isolation: false
  }));
});
