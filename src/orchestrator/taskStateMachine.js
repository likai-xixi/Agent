const { ValidationError, nowUtcIso } = require("../platform/contracts");

const TASK_STATES = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  WAITING_HUMAN: "WAITING_HUMAN",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
  CANCELLED: "CANCELLED"
});

const TERMINAL_STATES = new Set([TASK_STATES.SUCCEEDED, TASK_STATES.FAILED, TASK_STATES.TIMED_OUT, TASK_STATES.CANCELLED]);

const TRANSITIONS = Object.freeze({
  [TASK_STATES.PENDING]: new Set([TASK_STATES.RUNNING, TASK_STATES.FAILED, TASK_STATES.CANCELLED]),
  [TASK_STATES.RUNNING]: new Set([TASK_STATES.WAITING_HUMAN, TASK_STATES.SUCCEEDED, TASK_STATES.FAILED, TASK_STATES.TIMED_OUT, TASK_STATES.CANCELLED]),
  [TASK_STATES.WAITING_HUMAN]: new Set([TASK_STATES.RUNNING, TASK_STATES.FAILED, TASK_STATES.TIMED_OUT, TASK_STATES.CANCELLED]),
  [TASK_STATES.SUCCEEDED]: new Set([]),
  [TASK_STATES.FAILED]: new Set([TASK_STATES.RUNNING, TASK_STATES.CANCELLED]),
  [TASK_STATES.TIMED_OUT]: new Set([TASK_STATES.RUNNING, TASK_STATES.CANCELLED]),
  [TASK_STATES.CANCELLED]: new Set([])
});

function isValidState(state) {
  return Object.values(TASK_STATES).includes(state);
}

function canTransition(fromState, toState) {
  if (!isValidState(fromState) || !isValidState(toState)) {
    return false;
  }
  return TRANSITIONS[fromState].has(toState);
}

function shouldIncrementAttempt(fromState, toState) {
  if (toState !== TASK_STATES.RUNNING) {
    return false;
  }
  return fromState === TASK_STATES.PENDING || fromState === TASK_STATES.FAILED || fromState === TASK_STATES.TIMED_OUT;
}

function createTaskSnapshot({
  task_id,
  trace_id,
  task_type,
  metadata = {},
  state = TASK_STATES.PENDING,
  attempt = 0,
  version = 1,
  created_at = nowUtcIso(),
  updated_at = created_at,
  last_error = ""
}) {
  if (!task_id || !trace_id || !task_type) {
    throw new ValidationError("task_id, trace_id, and task_type are required");
  }
  if (!isValidState(state)) {
    throw new ValidationError(`Unknown task state: ${state}`);
  }
  return {
    task_id,
    trace_id,
    task_type,
    state,
    attempt,
    version,
    metadata,
    created_at,
    updated_at,
    last_error
  };
}

function applyTransition(task, toState, options = {}) {
  const fromState = task.state;
  if (!isValidState(fromState)) {
    throw new ValidationError(`Unknown current state: ${fromState}`);
  }
  if (!isValidState(toState)) {
    throw new ValidationError(`Unknown target state: ${toState}`);
  }
  if (!canTransition(fromState, toState)) {
    throw new ValidationError(`Invalid transition: ${fromState} -> ${toState}`);
  }

  const timestamp = options.timestamp || nowUtcIso();
  const attempt = shouldIncrementAttempt(fromState, toState) ? task.attempt + 1 : task.attempt;
  const lastError = options.error_message || (toState === TASK_STATES.FAILED ? "TASK_FAILED" : "");

  return {
    ...task,
    state: toState,
    attempt,
    version: task.version + 1,
    updated_at: timestamp,
    last_error: lastError
  };
}

module.exports = {
  TASK_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  applyTransition,
  canTransition,
  createTaskSnapshot,
  isValidState
};

