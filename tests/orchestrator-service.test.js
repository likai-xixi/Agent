const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ValidationError } = require("../src/platform/contracts");
const { ProviderExecutionError } = require("../src/providers/adapterContract");
const { buildDefaultProviderRegistry } = require("../src/providers/providerRegistry");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator, replayTaskFromEvents } = require("../src/orchestrator/orchestratorService");
const { TASK_STATES } = require("../src/orchestrator/taskStateMachine");

function buildFlags(overrides = {}) {
  return {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    openai_adapter_enabled: false,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
}

function createOrchestrator(flags = buildFlags(), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
  const filePath = path.join(dir, "events.jsonl");
  const eventStore = new JsonlAuditEventStore({ filePath });
  return new TaskOrchestrator({ eventStore, flags, ...options });
}

test("TaskOrchestrator creates task and performs valid transitions", () => {
  const orchestrator = createOrchestrator();
  const task = orchestrator.createTask({
    task_id: "task-100",
    trace_id: "trace-100",
    task_type: "task-routing",
    metadata: { priority: "high" }
  });
  assert.equal(task.state, TASK_STATES.PENDING);
  assert.equal(task.attempt, 0);

  const running = orchestrator.transitionTask({
    task_id: "task-100",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });
  assert.equal(running.state, TASK_STATES.RUNNING);
  assert.equal(running.attempt, 1);

  const waiting = orchestrator.transitionTask({
    task_id: "task-100",
    to_state: TASK_STATES.WAITING_HUMAN,
    reason: "manual approval required"
  });
  assert.equal(waiting.state, TASK_STATES.WAITING_HUMAN);

  const resumed = orchestrator.transitionTask({
    task_id: "task-100",
    to_state: TASK_STATES.RUNNING,
    reason: "approved"
  });
  assert.equal(resumed.attempt, 1);

  const done = orchestrator.transitionTask({
    task_id: "task-100",
    to_state: TASK_STATES.SUCCEEDED,
    reason: "completed"
  });
  assert.equal(done.state, TASK_STATES.SUCCEEDED);
});

test("TaskOrchestrator rejects invalid transitions", () => {
  const orchestrator = createOrchestrator();
  orchestrator.createTask({
    task_id: "task-200",
    trace_id: "trace-200",
    task_type: "review"
  });
  assert.throws(
    () =>
      orchestrator.transitionTask({
        task_id: "task-200",
        to_state: TASK_STATES.SUCCEEDED,
        reason: "skip running"
      }),
    ValidationError
  );
});

test("replayTaskFromEvents can rebuild task state", () => {
  const orchestrator = createOrchestrator();
  orchestrator.createTask({
    task_id: "task-300",
    trace_id: "trace-300",
    task_type: "execution"
  });
  orchestrator.transitionTask({
    task_id: "task-300",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });
  orchestrator.transitionTask({
    task_id: "task-300",
    to_state: TASK_STATES.FAILED,
    reason: "provider timeout",
    error_message: "timeout"
  });
  orchestrator.transitionTask({
    task_id: "task-300",
    to_state: TASK_STATES.RUNNING,
    reason: "retry"
  });
  orchestrator.transitionTask({
    task_id: "task-300",
    to_state: TASK_STATES.SUCCEEDED,
    reason: "done"
  });

  const history = orchestrator.getTaskHistory("task-300");
  const rebuilt = replayTaskFromEvents(history);
  assert.equal(rebuilt.state, TASK_STATES.SUCCEEDED);
  assert.equal(rebuilt.attempt, 2);
});

test("TaskOrchestrator executes via enabled provider and records provider events", async () => {
  const orchestrator = createOrchestrator(
    buildFlags({
      openai_adapter_enabled: true,
      local_model_adapter_enabled: false
    })
  );

  orchestrator.createTask({
    task_id: "task-400",
    trace_id: "trace-400",
    task_type: "execution",
    metadata: { preferred_provider: "openai" }
  });
  orchestrator.transitionTask({
    task_id: "task-400",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });

  const execution = await orchestrator.executeTask({
    task_id: "task-400",
    input: "generate plan",
    model: "gpt-4.1"
  });

  assert.equal(execution.selected_provider, "openai");
  assert.equal(execution.result.status, "STUB_NOT_IMPLEMENTED");

  const history = orchestrator.getTaskHistory("task-400");
  const eventTypes = history.map((item) => item.event_type);
  assert.equal(eventTypes.includes("PROVIDER_EXECUTION_REQUESTED"), true);
  assert.equal(eventTypes.includes("PROVIDER_EXECUTION_COMPLETED"), true);
});

test("TaskOrchestrator falls back to next provider when first provider fails", async () => {
  const orchestrator = createOrchestrator(
    buildFlags({
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );

  orchestrator.createTask({
    task_id: "task-410",
    trace_id: "trace-410",
    task_type: "execution",
    metadata: { preferred_provider: "local" }
  });
  orchestrator.transitionTask({
    task_id: "task-410",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });

  const execution = await orchestrator.executeTask({
    task_id: "task-410",
    provider: "local",
    fallback_providers: ["openai"],
    input: "generate plan",
    execution_options: {
      simulation: {
        fail_providers: ["local"]
      }
    }
  });

  assert.equal(execution.selected_provider, "openai");
  const history = orchestrator.getTaskHistory("task-410");
  const eventTypes = history.map((item) => item.event_type);
  assert.equal(eventTypes.includes("PROVIDER_EXECUTION_FAILED"), true);
  assert.equal(eventTypes.includes("FALLBACK_TRIGGERED"), true);
  assert.equal(eventTypes.includes("PROVIDER_EXECUTION_COMPLETED"), true);
});

test("TaskOrchestrator marks task failed when all providers fail", async () => {
  const orchestrator = createOrchestrator(
    buildFlags({
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );

  orchestrator.createTask({
    task_id: "task-420",
    trace_id: "trace-420",
    task_type: "execution",
    metadata: { preferred_provider: "local" }
  });
  orchestrator.transitionTask({
    task_id: "task-420",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });

  await assert.rejects(
    () =>
      orchestrator.executeTask({
        task_id: "task-420",
        provider: "local",
        fallback_providers: ["openai"],
        input: "generate plan",
        execution_options: {
          simulation: {
            fail_providers: ["local", "openai"]
          }
        }
      }),
    ProviderExecutionError
  );

  const task = orchestrator.getTask("task-420");
  assert.equal(task.state, TASK_STATES.FAILED);
  const history = orchestrator.getTaskHistory("task-420");
  const eventTypes = history.map((item) => item.event_type);
  assert.equal(eventTypes.includes("RETRY_BUDGET_EXHAUSTED"), true);
});

test("TaskOrchestrator enforces retry budget on transitions to RUNNING", () => {
  const orchestrator = createOrchestrator(buildFlags());

  orchestrator.createTask({
    task_id: "task-430",
    trace_id: "trace-430",
    task_type: "execution",
    metadata: {
      retry_budget_max_attempts: 1
    }
  });
  orchestrator.transitionTask({
    task_id: "task-430",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });
  orchestrator.transitionTask({
    task_id: "task-430",
    to_state: TASK_STATES.FAILED,
    reason: "simulate failure"
  });

  assert.throws(
    () =>
      orchestrator.transitionTask({
        task_id: "task-430",
        to_state: TASK_STATES.RUNNING,
        reason: "retry should fail"
      }),
    ValidationError
  );
});

test("TaskOrchestrator uses adaptive routing when enabled", async () => {
  const flags = buildFlags({
    adaptive_routing_enabled: true,
    openai_adapter_enabled: true,
    local_model_adapter_enabled: true
  });
  const providerRegistry = buildDefaultProviderRegistry({
    flags,
    healthOverrides: {
      local: {
        healthy: false,
        score: 0.1,
        latency_ms: 900
      },
      openai: {
        healthy: true,
        score: 0.95,
        latency_ms: 260
      }
    }
  });
  const orchestrator = createOrchestrator(flags, { providerRegistry });

  orchestrator.createTask({
    task_id: "task-435",
    trace_id: "trace-435",
    task_type: "execution",
    metadata: {
      preferred_provider: "local",
      routing_mode: "balanced"
    }
  });
  orchestrator.transitionTask({
    task_id: "task-435",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });

  const execution = await orchestrator.executeTask({
    task_id: "task-435",
    input: "generate plan"
  });

  assert.equal(execution.selected_provider, "openai");
});

test("TaskOrchestrator escalates to takeover when enabled and all providers fail", async () => {
  const orchestrator = createOrchestrator(
    buildFlags({
      takeover_engine_enabled: true,
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );

  orchestrator.createTask({
    task_id: "task-440",
    trace_id: "trace-440",
    task_type: "execution",
    metadata: { preferred_provider: "local" }
  });
  orchestrator.transitionTask({
    task_id: "task-440",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });

  await assert.rejects(
    () =>
      orchestrator.executeTask({
        task_id: "task-440",
        provider: "local",
        fallback_providers: ["openai"],
        input: "generate plan",
        execution_options: {
          simulation: {
            fail_providers: ["local", "openai"]
          }
        }
      }),
    ProviderExecutionError
  );

  const task = orchestrator.getTask("task-440");
  assert.equal(task.state, TASK_STATES.WAITING_HUMAN);
  const takeover = orchestrator.getTakeover("task-440");
  assert.equal(Boolean(takeover), true);
  assert.equal(takeover.status, "PENDING");
});

test("TaskOrchestrator handles takeover actions and updates task state", async () => {
  const orchestrator = createOrchestrator(
    buildFlags({
      takeover_engine_enabled: true,
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );

  orchestrator.createTask({
    task_id: "task-450",
    trace_id: "trace-450",
    task_type: "execution",
    metadata: { preferred_provider: "local" }
  });
  orchestrator.transitionTask({
    task_id: "task-450",
    to_state: TASK_STATES.RUNNING,
    reason: "dispatch"
  });
  await assert.rejects(
    () =>
      orchestrator.executeTask({
        task_id: "task-450",
        provider: "local",
        fallback_providers: ["openai"],
        input: "generate plan",
        execution_options: {
          simulation: {
            fail_providers: ["local", "openai"]
          }
        }
      }),
    ProviderExecutionError
  );

  const resolved = orchestrator.handleTakeoverAction({
    task_id: "task-450",
    action: "RETRY",
    actor: "oncall"
  });
  assert.equal(resolved.takeover.status, "RESOLVED");
  assert.equal(resolved.task.state, TASK_STATES.RUNNING);
});

test("TaskOrchestrator runs provider discovery and acknowledges alerts", async () => {
  const flags = buildFlags({
    openai_adapter_enabled: true,
    local_model_adapter_enabled: true
  });
  const providerRegistry = buildDefaultProviderRegistry({
    flags,
    healthOverrides: {
      local: {
        healthy: false,
        score: 0.1,
        latency_ms: 999
      }
    }
  });
  const orchestrator = createOrchestrator(flags, { providerRegistry });
  const discovery = await orchestrator.runProviderDiscovery({
    actor: "test",
    source: "unit-test"
  });
  assert.equal(Boolean(discovery.snapshot.discovery_id), true);
  assert.equal(discovery.alerts_created.length > 0, true);

  const openAlerts = orchestrator.listProviderAlerts("OPEN");
  assert.equal(openAlerts.length > 0, true);
  const acked = orchestrator.acknowledgeProviderAlert({
    alert_id: openAlerts[0].alert_id,
    actor: "oncall"
  });
  assert.equal(acked.status, "ACKED");
});

test("TaskOrchestrator runs discussion when discussion engine is enabled", () => {
  const flags = buildFlags({
    discussion_engine_enabled: true,
    local_model_adapter_enabled: true
  });
  const orchestrator = createOrchestrator(flags);
  orchestrator.createTask({
    task_id: "task-460",
    trace_id: "trace-460",
    task_type: "discussion"
  });
  const discussion = orchestrator.runTaskDiscussion({
    task_id: "task-460",
    prompt: "Should we continue rollout?",
    quorum: 2,
    participants: ["planner", "reviewer", "executor"]
  });
  assert.equal(Boolean(discussion.discussion_id), true);
  const latest = orchestrator.getLatestDiscussion("task-460");
  assert.equal(latest.discussion_id, discussion.discussion_id);
  const history = orchestrator.getTaskHistory("task-460").map((item) => item.event_type);
  assert.equal(history.includes("DISCUSSION_STARTED"), true);
  assert.equal(history.includes("DISCUSSION_COMPLETED"), true);
  assert.equal(history.includes("DISCUSSION_DECISION_RECORDED"), true);
});

test("TaskOrchestrator rejects discussion when feature flag is disabled", () => {
  const orchestrator = createOrchestrator(buildFlags());
  orchestrator.createTask({
    task_id: "task-461",
    trace_id: "trace-461",
    task_type: "discussion"
  });
  assert.throws(
    () =>
      orchestrator.runTaskDiscussion({
        task_id: "task-461",
        prompt: "Should we continue rollout?"
      }),
    ValidationError
  );
});

test("TaskOrchestrator validates required discussion prompt", () => {
  const flags = buildFlags({
    discussion_engine_enabled: true
  });
  const orchestrator = createOrchestrator(flags);
  orchestrator.createTask({
    task_id: "task-462",
    trace_id: "trace-462",
    task_type: "discussion"
  });
  assert.throws(
    () =>
      orchestrator.runTaskDiscussion({
        task_id: "task-462",
        prompt: ""
      }),
    ValidationError
  );
});
