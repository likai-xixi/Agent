const { randomUUID } = require("crypto");

const { ValidationError } = require("../platform/contracts");
const { createImNotifierFromEnv } = require("./imNotifier");
const { InMemoryTakeoverStore } = require("./takeoverStore");

const TAKEOVER_STATUSES = Object.freeze({
  PENDING: "PENDING",
  RESOLVED: "RESOLVED"
});

const TAKEOVER_ACTIONS = Object.freeze({
  APPROVE: "APPROVE",
  RETRY: "RETRY",
  ABORT: "ABORT"
});

class TakeoverWorkflowManager {
  constructor(options = {}) {
    this.notifier = options.notifier || createImNotifierFromEnv(options.notifierOptions || {});
    this.store = options.store || new InMemoryTakeoverStore();
  }

  async requestTakeover({
    task,
    reason,
    actor = "orchestrator",
    actions = [TAKEOVER_ACTIONS.APPROVE, TAKEOVER_ACTIONS.RETRY, TAKEOVER_ACTIONS.ABORT],
    metadata = {}
  }) {
    if (!task || !task.task_id) {
      throw new ValidationError("task is required for takeover request");
    }
    const record = {
      takeover_id: randomUUID(),
      task_id: task.task_id,
      trace_id: task.trace_id,
      status: TAKEOVER_STATUSES.PENDING,
      reason: reason || "MANUAL_INTERVENTION_REQUIRED",
      requested_by: actor,
      requested_at: new Date().toISOString(),
      actions,
      metadata,
      resolved_action: "",
      resolved_by: "",
      resolved_at: "",
      note: "",
      notification: null
    };
    const notification = await this.notifier.sendTakeoverRequired({
      task_id: task.task_id,
      trace_id: task.trace_id,
      reason: record.reason,
      actions
    });
    record.notification = notification;
    return this.store.save(record);
  }

  getTakeover(taskId) {
    return this.store.getByTaskId(taskId);
  }

  listPending() {
    return this.store.list()
      .filter((item) => item.status === TAKEOVER_STATUSES.PENDING)
      .map((item) => ({ ...item }));
  }

  resolveTakeover({
    task_id,
    action,
    actor = "human-operator",
    note = ""
  }) {
    const record = this.store.getByTaskId(task_id);
    if (!record) {
      throw new ValidationError(`Takeover record not found for task: ${task_id}`);
    }
    if (record.status !== TAKEOVER_STATUSES.PENDING) {
      throw new ValidationError(`Takeover is already resolved for task: ${task_id}`);
    }
    const normalizedAction = String(action || "").toUpperCase();
    if (!Object.values(TAKEOVER_ACTIONS).includes(normalizedAction)) {
      throw new ValidationError(`Unsupported takeover action: ${action}`);
    }

    const resolved = {
      ...record,
      status: TAKEOVER_STATUSES.RESOLVED,
      resolved_action: normalizedAction,
      resolved_by: actor,
      resolved_at: new Date().toISOString(),
      note
    };
    return this.store.save(resolved);
  }
}

module.exports = {
  TAKEOVER_ACTIONS,
  TAKEOVER_STATUSES,
  TakeoverWorkflowManager
};
