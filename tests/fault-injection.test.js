const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ProviderExecutionError } = require("../src/providers/adapterContract");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");
const { TASK_STATES } = require("../src/orchestrator/taskStateMachine");
const { JsonFileTakeoverStore } = require("../src/takeover/takeoverStore");

function buildFlags(overrides = {}) {
  return {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    adaptive_routing_enabled: false,
    openai_adapter_enabled: true,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
}

function createEventStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fault-injection-"));
  return new JsonlAuditEventStore({
    filePath: path.join(dir, "events.jsonl")
  });
}

function createRunningTask(orchestrator, taskId) {
  orchestrator.createTask({
    task_id: taskId,
    trace_id: `${taskId}-trace`,
    task_type: "fault-injection",
    metadata: {
      preferred_provider: "local"
    }
  });
  orchestrator.transitionTask({
    task_id: taskId,
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });
}

test("timeout fault injection falls back to next provider", async () => {
  const orchestrator = new TaskOrchestrator({
    flags: buildFlags(),
    eventStore: createEventStore()
  });
  createRunningTask(orchestrator, "fault-timeout");

  const execution = await orchestrator.executeTask({
    task_id: "fault-timeout",
    provider: "local",
    fallback_providers: ["openai"],
    input: "run timeout simulation",
    execution_options: {
      simulation: {
        timeout_providers: ["local"]
      }
    }
  });

  assert.equal(execution.selected_provider, "openai");
  const failedEvents = orchestrator
    .getTaskHistory("fault-timeout")
    .filter((event) => event.event_type === "PROVIDER_EXECUTION_FAILED");
  assert.equal(failedEvents.some((event) => event.payload.error_code === "PROVIDER_TIMEOUT"), true);
});

test("rate limit fault injection falls back to next provider", async () => {
  const orchestrator = new TaskOrchestrator({
    flags: buildFlags(),
    eventStore: createEventStore()
  });
  createRunningTask(orchestrator, "fault-rate-limit");

  const execution = await orchestrator.executeTask({
    task_id: "fault-rate-limit",
    provider: "local",
    fallback_providers: ["openai"],
    input: "run rate-limit simulation",
    execution_options: {
      simulation: {
        rate_limit_providers: ["local"]
      }
    }
  });

  assert.equal(execution.selected_provider, "openai");
  const failedEvents = orchestrator
    .getTaskHistory("fault-rate-limit")
    .filter((event) => event.event_type === "PROVIDER_EXECUTION_FAILED");
  assert.equal(failedEvents.some((event) => event.payload.error_code === "RATE_LIMITED"), true);
});

test("invalid key fault injection escalates to takeover when all providers fail", async () => {
  const orchestrator = new TaskOrchestrator({
    flags: buildFlags({
      takeover_engine_enabled: true
    }),
    eventStore: createEventStore()
  });
  createRunningTask(orchestrator, "fault-key-invalid");

  await assert.rejects(
    () =>
      orchestrator.executeTask({
        task_id: "fault-key-invalid",
        provider: "local",
        fallback_providers: ["openai"],
        input: "run key invalid simulation",
        execution_options: {
          simulation: {
            invalid_key_providers: ["local", "openai"]
          }
        }
      }),
    ProviderExecutionError
  );

  const task = orchestrator.getTask("fault-key-invalid");
  assert.equal(task.state, TASK_STATES.WAITING_HUMAN);
  const history = orchestrator.getTaskHistory("fault-key-invalid");
  const failedCodes = history
    .filter((event) => event.event_type === "PROVIDER_EXECUTION_FAILED")
    .map((event) => event.payload.error_code);
  assert.equal(failedCodes.includes("KEY_INVALID"), true);
  assert.equal(history.some((event) => event.event_type === "TAKEOVER_REQUESTED"), true);
});

test("node restart can recover waiting-human task and allow manual takeover", async () => {
  const eventStore = createEventStore();
  const takeoverDir = fs.mkdtempSync(path.join(os.tmpdir(), "takeover-recovery-"));
  const takeoverStore = new JsonFileTakeoverStore({
    filePath: path.join(takeoverDir, "takeover-records.json")
  });
  const flags = buildFlags({
    takeover_engine_enabled: true
  });

  const orchestrator = new TaskOrchestrator({
    flags,
    eventStore,
    takeoverStore
  });
  createRunningTask(orchestrator, "fault-restart");
  await assert.rejects(
    () =>
      orchestrator.executeTask({
        task_id: "fault-restart",
        provider: "local",
        fallback_providers: ["openai"],
        input: "restart simulation",
        execution_options: {
          simulation: {
            invalid_key_providers: ["local", "openai"]
          }
        }
      }),
    ProviderExecutionError
  );

  const restarted = new TaskOrchestrator({
    flags,
    eventStore,
    takeoverStore: new JsonFileTakeoverStore({
      filePath: path.join(takeoverDir, "takeover-records.json")
    })
  });
  const recovered = restarted.getTask("fault-restart");
  assert.equal(recovered.state, TASK_STATES.WAITING_HUMAN);
  const takeover = restarted.getTakeover("fault-restart");
  assert.equal(Boolean(takeover), true);
  assert.equal(takeover.status, "PENDING");

  const resumed = restarted.transitionTask({
    task_id: "fault-restart",
    to_state: TASK_STATES.RUNNING,
    actor: "operator",
    source: "manual-takeover",
    reason: "manual_takeover_after_restart"
  });
  assert.equal(resumed.state, TASK_STATES.RUNNING);
});
