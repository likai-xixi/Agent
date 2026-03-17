const {
  DISCUSSION_COMPLETED,
  DISCUSSION_DECISION_RECORDED,
  DISCUSSION_STARTED,
  FALLBACK_TRIGGERED,
  PROVIDER_EXECUTION_COMPLETED,
  PROVIDER_DISCOVERY_RUN,
  PROVIDER_EXECUTION_FAILED,
  PROVIDER_HEALTH_ALERT_ACKED,
  PROVIDER_HEALTH_ALERT_CREATED,
  PROVIDER_EXECUTION_REQUESTED,
  RETRY_BUDGET_EXHAUSTED,
  TAKEOVER_ACTION_RECEIVED,
  TAKEOVER_NOTIFICATION_SENT,
  TAKEOVER_REQUESTED,
  createAuditEvent
} = require("../platform/audit");
const { ValidationError } = require("../platform/contracts");
const { loadFeatureFlags } = require("../platform/featureFlags");
const { JsonlAuditMaintenanceHistoryStore } = require("../monitoring/auditMaintenanceHistoryStore");
const { DiscussionEngine } = require("../discussion/discussionEngine");
const { ProviderDiscoveryService } = require("../monitoring/providerDiscovery");
const { ProviderExecutionError } = require("../providers/adapterContract");
const { buildDefaultProviderRegistry } = require("../providers/providerRegistry");
const { InMemoryTakeoverStore, JsonFileTakeoverStore } = require("../takeover/takeoverStore");
const { TAKEOVER_ACTIONS, TakeoverWorkflowManager } = require("../takeover/takeoverWorkflow");
const { JsonlAuditEventStore } = require("./auditEventStore");
const { FallbackPolicyEvaluator } = require("./fallbackPolicy");
const { AdaptiveProviderRouter } = require("./providerRouter");
const { RetryBudgetManager } = require("./retryBudgetManager");
const { TASK_STATES, applyTransition, createTaskSnapshot, isValidState } = require("./taskStateMachine");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createAttemptId(attempt) {
  return `attempt-${attempt}`;
}

function nextAttemptForTransition(task, toState) {
  if (toState !== TASK_STATES.RUNNING) {
    return task.attempt;
  }
  if ([TASK_STATES.PENDING, TASK_STATES.FAILED, TASK_STATES.TIMED_OUT].includes(task.state)) {
    return task.attempt + 1;
  }
  return task.attempt;
}

function isSystemTaskId(taskId) {
  const normalized = String(taskId || "");
  return normalized.startsWith("auth-")
    || normalized.startsWith("discovery-")
    || normalized.startsWith("discovery-alert-");
}

function replayTaskFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return null;
  }

  const ordered = [...events].sort((a, b) => {
    if (a.timestamp === b.timestamp) {
      return 0;
    }
    return a.timestamp < b.timestamp ? -1 : 1;
  });

  let task = null;
  for (const event of ordered) {
    if (event.event_type === "TASK_CREATED") {
      if (!event.payload || typeof event.payload.task_snapshot !== "object") {
        throw new ValidationError("TASK_CREATED payload.task_snapshot is required");
      }
      task = clone(event.payload.task_snapshot);
      continue;
    }

    if (event.event_type === "TASK_STATE_CHANGED") {
      if (!task) {
        throw new ValidationError("TASK_STATE_CHANGED found before TASK_CREATED");
      }
      const payload = event.payload || {};
      const toState = payload.to_state;
      if (!isValidState(toState)) {
        throw new ValidationError(`TASK_STATE_CHANGED has invalid to_state: ${toState}`);
      }
      task = applyTransition(task, toState, {
        timestamp: event.timestamp,
        error_message: payload.error_message || ""
      });
    }
  }
  return task;
}

class TaskOrchestrator {
  constructor(options = {}) {
    this.flags = options.flags || loadFeatureFlags(options.flagPath);
    this.eventStore = options.eventStore || new JsonlAuditEventStore(options.eventStoreOptions || {});
    this.providerRegistry = options.providerRegistry || buildDefaultProviderRegistry({
      flags: this.flags
    });
    this.providerDiscovery = options.providerDiscovery || new ProviderDiscoveryService({
      providerRegistry: this.providerRegistry,
      alarmStore: options.healthAlarmStore
    });
    this.auditMaintenanceHistoryStore = options.auditMaintenanceHistoryStore || new JsonlAuditMaintenanceHistoryStore({
      filePath: options.auditMaintenanceHistoryPath
    });
    const takeoverStore = options.takeoverStore || (
      options.takeoverStorePath
        ? new JsonFileTakeoverStore({ filePath: options.takeoverStorePath })
        : new InMemoryTakeoverStore()
    );
    this.takeoverWorkflow = options.takeoverWorkflow || new TakeoverWorkflowManager({
      notifier: options.imNotifier,
      store: takeoverStore
    });
    this.discussionEngine = options.discussionEngine || new DiscussionEngine();
    this.fallbackPolicy = options.fallbackPolicy || new FallbackPolicyEvaluator(options.fallbackPolicyOptions || {});
    this.providerRouter = options.providerRouter || new AdaptiveProviderRouter(options.providerRouterOptions || {});
    this.retryBudgetManager = options.retryBudgetManager || new RetryBudgetManager(options.retryBudgetOptions || {});
    this.taskSnapshotStore = options.taskSnapshotStore || null;
    this.tasks = new Map();
  }

  createTask({
    task_id,
    trace_id,
    task_type,
    metadata = {},
    actor = "orchestrator",
    source = "task-api"
  }) {
    if (this.tasks.has(task_id)) {
      throw new ValidationError(`Task already exists: ${task_id}`);
    }
    const task = createTaskSnapshot({
      task_id,
      trace_id,
      task_type,
      metadata,
      state: TASK_STATES.PENDING,
      attempt: 0,
      version: 1
    });

    const event = createAuditEvent({
      trace_id,
      task_id,
      attempt_id: createAttemptId(task.attempt),
      actor,
      source,
      event_type: "TASK_CREATED",
      payload: {
        task_snapshot: task
      }
    });

    this.eventStore.append(event);
    this.tasks.set(task_id, task);
    if (this.taskSnapshotStore && typeof this.taskSnapshotStore.save === "function") {
      this.taskSnapshotStore.save(task);
    }
    return clone(task);
  }

  getTask(taskId) {
    const existing = this.tasks.get(taskId);
    if (existing) {
      return clone(existing);
    }
    if (this.taskSnapshotStore && typeof this.taskSnapshotStore.get === "function") {
      const stored = this.taskSnapshotStore.get(taskId);
      if (stored) {
        this.tasks.set(taskId, stored);
        return clone(stored);
      }
    }
    const history = this.eventStore.queryByTaskId(taskId);
    const rebuilt = replayTaskFromEvents(history);
    if (!rebuilt) {
      return null;
    }
    this.tasks.set(taskId, rebuilt);
    if (this.taskSnapshotStore && typeof this.taskSnapshotStore.save === "function") {
      this.taskSnapshotStore.save(rebuilt);
    }
    return clone(rebuilt);
  }

  listTasks({
    state = "",
    limit = 100
  } = {}) {
    const effectiveState = String(state || "").trim().toUpperCase();
    const targetLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;
    if (this.taskSnapshotStore && typeof this.taskSnapshotStore.list === "function") {
      const snapshotTasks = this.taskSnapshotStore.list({
        state: effectiveState,
        limit: targetLimit
      });
      return snapshotTasks.map((task) => clone(task));
    }
    const taskIds = new Set();

    for (const taskId of this.tasks.keys()) {
      taskIds.add(taskId);
    }
    if (this.eventStore && typeof this.eventStore.getAllEvents === "function") {
      const allEvents = this.eventStore.getAllEvents();
      for (const event of allEvents) {
        if (!event || typeof event.task_id !== "string") {
          continue;
        }
        taskIds.add(event.task_id);
      }
    }

    const snapshots = [];
    for (const taskId of taskIds) {
      if (isSystemTaskId(taskId)) {
        continue;
      }
      const task = this.getTask(taskId);
      if (!task) {
        continue;
      }
      if (effectiveState && task.state !== effectiveState) {
        continue;
      }
      snapshots.push(task);
    }

    snapshots.sort((left, right) => {
      const leftAt = Date.parse(left.updated_at || left.created_at || 0);
      const rightAt = Date.parse(right.updated_at || right.created_at || 0);
      return rightAt - leftAt;
    });

    return snapshots.slice(0, targetLimit).map((task) => clone(task));
  }

  transitionTask({
    task_id,
    to_state,
    actor = "orchestrator",
    source = "orchestrator",
    reason = "",
    error_message = "",
    metadata = {}
  }) {
    const current = this.getTask(task_id);
    if (!current) {
      throw new ValidationError(`Task not found: ${task_id}`);
    }
    const projectedAttempt = nextAttemptForTransition(current, to_state);
    this.retryBudgetManager.assertCanUseAttempt(current, projectedAttempt);

    const updated = applyTransition(current, to_state, { error_message });
    const event = createAuditEvent({
      trace_id: updated.trace_id,
      task_id: updated.task_id,
      attempt_id: createAttemptId(updated.attempt),
      actor,
      source,
      event_type: "TASK_STATE_CHANGED",
      payload: {
        from_state: current.state,
        to_state,
        reason,
        error_message,
        metadata,
        version: updated.version,
        attempt: updated.attempt
      }
    });

    this.eventStore.append(event);
    this.tasks.set(task_id, updated);
    if (this.taskSnapshotStore && typeof this.taskSnapshotStore.save === "function") {
      this.taskSnapshotStore.save(updated);
    }
    return clone(updated);
  }

  getTaskHistory(taskId) {
    return this.eventStore.queryByTaskId(taskId).map((event) => clone(event));
  }

  getTraceHistory(traceId) {
    return this.eventStore.queryByTraceId(traceId).map((event) => clone(event));
  }

  verifyAuditIntegrity() {
    return this.eventStore.verifyIntegrity();
  }

  getAvailableProviders() {
    return this.providerRegistry.getEnabledProviders();
  }

  async getProviderHealth() {
    return this.providerRegistry.getEnabledProviderHealth();
  }

  async previewRouting({
    preferred_provider = "",
    fallback_providers = [],
    routing_mode = "balanced",
    task_type = "generic",
    desired_model = ""
  } = {}) {
    const enabledProviders = this.providerRegistry.getEnabledProviders();
    const healthList = await this.getProviderHealth();
    return this.providerRouter.rankProviders({
      enabledProviders,
      healthList,
      mode: routing_mode,
      preferredProvider: preferred_provider,
      fallbackProviders: fallback_providers,
      desiredModel: desired_model,
      taskType: task_type
    });
  }

  getTakeover(taskId) {
    return this.takeoverWorkflow.getTakeover(taskId);
  }

  getPendingTakeovers() {
    return this.takeoverWorkflow.listPending();
  }

  async runProviderDiscovery({
    actor = "system",
    source = "scheduler"
  } = {}) {
    const result = await this.providerDiscovery.runDiscovery({
      actor,
      source
    });
    const latestTaskId = result.snapshot.discovery_id;
    const discoveryEvent = createAuditEvent({
      trace_id: result.snapshot.discovery_id,
      task_id: `discovery-${latestTaskId}`,
      attempt_id: "attempt-0",
      actor,
      source,
      event_type: PROVIDER_DISCOVERY_RUN,
      payload: {
        provider_count: result.snapshot.providers.length,
        alerts_created: result.alerts_created.length
      }
    });
    this.eventStore.append(discoveryEvent);

    for (const alert of result.alerts_created) {
      const alertEvent = createAuditEvent({
        trace_id: result.snapshot.discovery_id,
        task_id: `discovery-${latestTaskId}`,
        attempt_id: "attempt-0",
        actor,
        source,
        event_type: PROVIDER_HEALTH_ALERT_CREATED,
        payload: {
          alert_id: alert.alert_id,
          provider: alert.provider,
          reason: alert.reason,
          severity: alert.severity
        }
      });
      this.eventStore.append(alertEvent);
    }

    return result;
  }

  getLatestProviderDiscovery() {
    return this.providerDiscovery.getLatestSnapshot();
  }

  listProviderAlerts(status = "") {
    return this.providerDiscovery.listAlerts(status);
  }

  getLatestAuditMaintenanceRun() {
    return this.auditMaintenanceHistoryStore.getLatestRun();
  }

  listAuditMaintenanceRuns({
    limit = 20,
    status = ""
  } = {}) {
    return this.auditMaintenanceHistoryStore.listRuns({
      limit,
      status
    });
  }

  summarizeAuditMaintenanceFailures({
    limit = 100
  } = {}) {
    return this.auditMaintenanceHistoryStore.summarizeFailures({
      limit
    });
  }

  acknowledgeProviderAlert({
    alert_id,
    actor = "operator",
    note = ""
  }) {
    const alert = this.providerDiscovery.acknowledgeAlert({
      alert_id,
      actor,
      note
    });
    if (!alert) {
      return null;
    }
    const ackEvent = createAuditEvent({
      trace_id: alert.alert_id,
      task_id: `discovery-alert-${alert.alert_id}`,
      attempt_id: "attempt-0",
      actor,
      source: "monitoring",
      event_type: PROVIDER_HEALTH_ALERT_ACKED,
      payload: {
        provider: alert.provider,
        reason: alert.reason
      }
    });
    this.eventStore.append(ackEvent);
    return alert;
  }

  handleTakeoverAction({
    task_id,
    action,
    actor = "human-operator",
    note = "",
    metadata = {}
  }) {
    const takeover = this.takeoverWorkflow.resolveTakeover({
      task_id,
      action,
      actor,
      note
    });

    const normalizedAction = takeover.resolved_action;
    let toState = TASK_STATES.RUNNING;
    let reason = "takeover_action";
    if (normalizedAction === TAKEOVER_ACTIONS.ABORT) {
      toState = TASK_STATES.CANCELLED;
      reason = "takeover_abort";
    } else if (normalizedAction === TAKEOVER_ACTIONS.RETRY) {
      toState = TASK_STATES.RUNNING;
      reason = "takeover_retry";
    } else if (normalizedAction === TAKEOVER_ACTIONS.APPROVE) {
      toState = TASK_STATES.RUNNING;
      reason = "takeover_approve";
    }

    const task = this.transitionTask({
      task_id,
      to_state: toState,
      actor,
      source: "takeover-workflow",
      reason,
      metadata
    });

    const actionEvent = createAuditEvent({
      trace_id: task.trace_id,
      task_id: task.task_id,
      attempt_id: createAttemptId(task.attempt),
      actor,
      source: "takeover-workflow",
      event_type: TAKEOVER_ACTION_RECEIVED,
      payload: {
        action: normalizedAction,
        note
      }
    });
    this.eventStore.append(actionEvent);

    return {
      task: clone(task),
      takeover: clone(takeover)
    };
  }

  runTaskDiscussion({
    task_id,
    prompt,
    participants = [],
    quorum = 2,
    actor = "operator",
    source = "discussion-api"
  }) {
    if (this.flags.discussion_engine_enabled !== true) {
      throw new ValidationError("Discussion engine is disabled by feature flag");
    }
    if (!prompt || String(prompt).trim() === "") {
      throw new ValidationError("prompt is required for discussion");
    }
    const task = this.getTask(task_id);
    if (!task) {
      throw new ValidationError(`Task not found: ${task_id}`);
    }

    const startedEvent = createAuditEvent({
      trace_id: task.trace_id,
      task_id: task.task_id,
      attempt_id: createAttemptId(task.attempt),
      actor,
      source,
      event_type: DISCUSSION_STARTED,
      payload: {
        participant_count: participants.length,
        quorum
      }
    });
    this.eventStore.append(startedEvent);

    const discussion = this.discussionEngine.run({
      task,
      prompt,
      participants,
      quorum,
      actor,
      source
    });

    const completedEvent = createAuditEvent({
      trace_id: task.trace_id,
      task_id: task.task_id,
      attempt_id: createAttemptId(task.attempt),
      actor,
      source,
      event_type: DISCUSSION_COMPLETED,
      payload: {
        discussion_id: discussion.discussion_id,
        approve_count: discussion.approve_count,
        reject_count: discussion.reject_count
      }
    });
    this.eventStore.append(completedEvent);

    const decisionEvent = createAuditEvent({
      trace_id: task.trace_id,
      task_id: task.task_id,
      attempt_id: createAttemptId(task.attempt),
      actor,
      source,
      event_type: DISCUSSION_DECISION_RECORDED,
      payload: {
        discussion_id: discussion.discussion_id,
        decision: discussion.decision
      }
    });
    this.eventStore.append(decisionEvent);

    return discussion;
  }

  getLatestDiscussion(taskId) {
    return this.discussionEngine.getLatest(taskId);
  }

  async executeTask({
    task_id,
    provider = "",
    fallback_providers = [],
    model = "",
    input,
    actor = "executor",
    source = "orchestrator",
    metadata = {},
    execution_options = {}
  }) {
    const current = this.getTask(task_id);
    if (!current) {
      throw new ValidationError(`Task not found: ${task_id}`);
    }
    if (current.state !== TASK_STATES.RUNNING) {
      throw new ValidationError(`Task must be RUNNING before execution, current state: ${current.state}`);
    }
    if (typeof input !== "string" || input.trim() === "") {
      throw new ValidationError("input is required for provider execution");
    }
    this.retryBudgetManager.assertCanUseAttempt(current, current.attempt);

    const enabledProviders = this.providerRegistry.getEnabledProviders();
    const preferredProvider = provider || current.metadata.preferred_provider || "";
    const routingMode = execution_options.routing_mode || current.metadata.routing_mode || "balanced";
    const routingPlan = this.flags.adaptive_routing_enabled
      ? this.providerRouter.rankProviders({
          enabledProviders,
          healthList: await this.getProviderHealth(),
          mode: routingMode,
          preferredProvider,
          fallbackProviders: fallback_providers,
          desiredModel: model,
          taskType: current.task_type
        })
      : this.fallbackPolicy.buildProviderCandidates({
          preferredProvider,
          fallbackProviders: fallback_providers,
          enabledProviders
        }).map((item) => ({
          provider: item,
          model: this.providerRouter.selectModel({
            provider: item,
            desiredModel: model,
            taskType: current.task_type
          }),
          score: 0
        }));

    const candidates = routingPlan.map((item) => item.provider);
    const modelByProvider = {};
    for (const item of routingPlan) {
      modelByProvider[item.provider] = item.model;
    }

    let failedCount = 0;
    let lastError = null;
    for (let idx = 0; idx < candidates.length; idx += 1) {
      const selectedProvider = candidates[idx];
      const selectedModel = modelByProvider[selectedProvider] || model;
      if (idx > 0) {
        const fallbackEvent = createAuditEvent({
          trace_id: current.trace_id,
          task_id: current.task_id,
          attempt_id: createAttemptId(current.attempt),
          actor,
          source,
          event_type: FALLBACK_TRIGGERED,
          payload: {
            from_provider: candidates[idx - 1],
            to_provider: selectedProvider,
            failed_count: failedCount
          }
        });
        this.eventStore.append(fallbackEvent);
      }

      const requestedEvent = createAuditEvent({
        trace_id: current.trace_id,
        task_id: current.task_id,
        attempt_id: createAttemptId(current.attempt),
        actor,
        source,
        event_type: PROVIDER_EXECUTION_REQUESTED,
        payload: {
          selected_provider: selectedProvider,
          model: selectedModel,
          input_preview: input.slice(0, 200),
          metadata,
          routing_mode: routingMode,
          adaptive_routing_enabled: this.flags.adaptive_routing_enabled === true
        }
      });
      this.eventStore.append(requestedEvent);

      try {
        const execution = await this.providerRegistry.execute({
          provider: selectedProvider,
          request: {
            task_id: current.task_id,
            trace_id: current.trace_id,
            model: selectedModel,
            input,
            simulation: execution_options.simulation || {}
          }
        });

        const completedEvent = createAuditEvent({
          trace_id: current.trace_id,
          task_id: current.task_id,
          attempt_id: createAttemptId(current.attempt),
          actor,
          source,
          event_type: PROVIDER_EXECUTION_COMPLETED,
          payload: {
            selected_provider: execution.selected_provider,
            status: execution.result.status,
            model: execution.result.model || selectedModel,
            usage: execution.result.usage,
            failed_before_success: failedCount
          }
        });
        this.eventStore.append(completedEvent);

        return clone({
          ...execution,
          retry_budget_remaining: this.retryBudgetManager.remainingAttempts(current, current.attempt)
        });
      } catch (err) {
        const normalized = err instanceof ProviderExecutionError
          ? err
          : new ProviderExecutionError(err && err.message ? err.message : "Provider execution failure", {
              provider: selectedProvider,
              code: "PROVIDER_EXECUTION_ERROR",
              retryable: true
            });
        failedCount += 1;
        lastError = normalized;

        const failedEvent = createAuditEvent({
          trace_id: current.trace_id,
          task_id: current.task_id,
          attempt_id: createAttemptId(current.attempt),
          actor,
          source,
          event_type: PROVIDER_EXECUTION_FAILED,
          payload: {
            selected_provider: selectedProvider,
            error_code: normalized.code,
            error_message: normalized.message,
            retryable: normalized.retryable !== false
          }
        });
        this.eventStore.append(failedEvent);

        const canFallback = this.fallbackPolicy.shouldFallback(normalized, failedCount, candidates.length);
        if (canFallback) {
          continue;
        }
        break;
      }
    }

    const exhaustedEvent = createAuditEvent({
      trace_id: current.trace_id,
      task_id: current.task_id,
      attempt_id: createAttemptId(current.attempt),
      actor,
      source,
      event_type: RETRY_BUDGET_EXHAUSTED,
      payload: {
        failed_count: failedCount,
        candidate_count: candidates.length,
        error_code: lastError && lastError.code ? lastError.code : "UNKNOWN"
      }
    });
    this.eventStore.append(exhaustedEvent);

    const shouldEscalateTakeover = this.flags.takeover_engine_enabled === true;
    if (shouldEscalateTakeover) {
      const waitingTask = this.transitionTask({
        task_id: current.task_id,
        to_state: TASK_STATES.WAITING_HUMAN,
        actor,
        source,
        reason: "takeover_required_after_provider_failures",
        error_message: lastError && lastError.message ? lastError.message : "Provider execution failed",
        metadata: {
          last_provider_error_code: lastError && lastError.code ? lastError.code : "UNKNOWN"
        }
      });

      const takeover = await this.takeoverWorkflow.requestTakeover({
        task: waitingTask,
        reason: "ALL_PROVIDERS_FAILED",
        actor,
        metadata: {
          failed_provider_code: lastError && lastError.code ? lastError.code : "UNKNOWN"
        }
      });

      const takeoverRequestedEvent = createAuditEvent({
        trace_id: waitingTask.trace_id,
        task_id: waitingTask.task_id,
        attempt_id: createAttemptId(waitingTask.attempt),
        actor,
        source,
        event_type: TAKEOVER_REQUESTED,
        payload: {
          takeover_id: takeover.takeover_id,
          reason: takeover.reason
        }
      });
      this.eventStore.append(takeoverRequestedEvent);

      const takeoverNotificationEvent = createAuditEvent({
        trace_id: waitingTask.trace_id,
        task_id: waitingTask.task_id,
        attempt_id: createAttemptId(waitingTask.attempt),
        actor,
        source,
        event_type: TAKEOVER_NOTIFICATION_SENT,
        payload: {
          takeover_id: takeover.takeover_id,
          notification_id: takeover.notification ? takeover.notification.notification_id : ""
        }
      });
      this.eventStore.append(takeoverNotificationEvent);

      const takeoverError = new ProviderExecutionError(
        `Takeover required for task ${current.task_id}: all provider attempts failed`,
        {
          provider: "",
          code: "TAKEOVER_REQUIRED",
          retryable: true,
          status: 202
        }
      );
      takeoverError.failed_task = waitingTask;
      takeoverError.takeover = takeover;
      throw takeoverError;
    }

    const failedTask = this.transitionTask({
      task_id: current.task_id,
      to_state: TASK_STATES.FAILED,
      actor,
      source,
      reason: "provider_execution_failed",
      error_message: lastError && lastError.message ? lastError.message : "Provider execution failed",
      metadata: {
        last_provider_error_code: lastError && lastError.code ? lastError.code : "UNKNOWN"
      }
    });

    const finalError = new ProviderExecutionError(
      `All provider execution attempts failed for task ${current.task_id}`,
      {
        provider: "",
        code: "ALL_PROVIDERS_FAILED",
        retryable: true,
        status: 503
      }
    );
    finalError.failed_task = failedTask;
    throw finalError;
  }
}

module.exports = {
  TaskOrchestrator,
  replayTaskFromEvents
};
