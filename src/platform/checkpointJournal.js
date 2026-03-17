const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { ensureDir, normalizePortablePath, resolveDataPath } = require("./appPaths");
const { nowUtcIso, ValidationError } = require("./contracts");

const STEP_STATUSES = Object.freeze({
  RUNNING: "RUNNING",
  CHECKPOINTED: "CHECKPOINTED",
  COMPLETED: "COMPLETED",
  INTERRUPTED: "INTERRUPTED",
  RESUMED: "RESUMED",
  FAILED: "FAILED"
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeResumeState(resumeState = {}, options = {}) {
  const nextState = {};
  for (const [key, value] of Object.entries(resumeState || {})) {
    if (typeof value === "string" && (value.includes("/") || value.includes("\\"))) {
      nextState[key] = normalizePortablePath(value, options);
    } else {
      nextState[key] = value;
    }
  }
  return nextState;
}

class JsonlStepJournal {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("steps.jsonl");
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  append(record) {
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    return clone(record);
  }

  beginStep({
    trace_id,
    task_id,
    operation,
    stage = "started",
    resumable = true,
    metadata = {},
    resume_state = {}
  }) {
    if (!trace_id || !task_id || !operation) {
      throw new ValidationError("trace_id, task_id, and operation are required for checkpoint journal");
    }
    const record = {
      step_run_id: randomUUID(),
      trace_id,
      task_id,
      operation,
      stage,
      resumable: resumable !== false,
      metadata,
      resume_state: normalizeResumeState(resume_state),
      status: STEP_STATUSES.RUNNING,
      timestamp: nowUtcIso()
    };
    return this.append(record);
  }

  checkpoint(stepRunId, stage, resumeState = {}, metadata = {}) {
    const latest = this.getLatest(stepRunId);
    if (!latest) {
      throw new ValidationError(`Unknown step_run_id: ${stepRunId}`);
    }
    return this.append({
      ...latest,
      stage,
      metadata: {
        ...latest.metadata,
        ...metadata
      },
      resume_state: {
        ...latest.resume_state,
        ...normalizeResumeState(resumeState)
      },
      status: STEP_STATUSES.CHECKPOINTED,
      timestamp: nowUtcIso()
    });
  }

  complete(stepRunId, stage = "completed", resumeState = {}, metadata = {}) {
    const latest = this.getLatest(stepRunId);
    if (!latest) {
      throw new ValidationError(`Unknown step_run_id: ${stepRunId}`);
    }
    return this.append({
      ...latest,
      stage,
      metadata: {
        ...latest.metadata,
        ...metadata
      },
      resume_state: {
        ...latest.resume_state,
        ...normalizeResumeState(resumeState)
      },
      status: STEP_STATUSES.COMPLETED,
      timestamp: nowUtcIso()
    });
  }

  interrupt(stepRunId, stage = "interrupted", errorMessage = "", resumeState = {}, metadata = {}) {
    const latest = this.getLatest(stepRunId);
    if (!latest) {
      throw new ValidationError(`Unknown step_run_id: ${stepRunId}`);
    }
    return this.append({
      ...latest,
      stage,
      metadata: {
        ...latest.metadata,
        ...metadata,
        error_message: errorMessage
      },
      resume_state: {
        ...latest.resume_state,
        ...normalizeResumeState(resumeState)
      },
      status: STEP_STATUSES.INTERRUPTED,
      timestamp: nowUtcIso()
    });
  }

  resume(stepRunId, stage = "resumed", resumeState = {}, metadata = {}) {
    const latest = this.getLatest(stepRunId);
    if (!latest) {
      throw new ValidationError(`Unknown step_run_id: ${stepRunId}`);
    }
    return this.append({
      ...latest,
      stage,
      metadata: {
        ...latest.metadata,
        ...metadata
      },
      resume_state: {
        ...latest.resume_state,
        ...normalizeResumeState(resumeState)
      },
      status: STEP_STATUSES.RESUMED,
      timestamp: nowUtcIso()
    });
  }

  fail(stepRunId, errorMessage = "", metadata = {}) {
    const latest = this.getLatest(stepRunId);
    if (!latest) {
      throw new ValidationError(`Unknown step_run_id: ${stepRunId}`);
    }
    return this.append({
      ...latest,
      metadata: {
        ...latest.metadata,
        ...metadata,
        error_message: errorMessage
      },
      status: STEP_STATUSES.FAILED,
      timestamp: nowUtcIso()
    });
  }

  getAllRecords() {
    const raw = fs.readFileSync(this.filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  getLatest(stepRunId) {
    const all = this.getAllRecords().filter((item) => item.step_run_id === stepRunId);
    if (all.length === 0) {
      return null;
    }
    return clone(all[all.length - 1]);
  }

  listLatest() {
    const latest = new Map();
    for (const record of this.getAllRecords()) {
      latest.set(record.step_run_id, record);
    }
    return [...latest.values()].map((item) => clone(item));
  }

  listInterrupted() {
    return this.listLatest().filter((item) => (
      item.resumable === true && [STEP_STATUSES.RUNNING, STEP_STATUSES.CHECKPOINTED, STEP_STATUSES.INTERRUPTED].includes(item.status)
    ));
  }

  autoRecover(handlers = {}) {
    const results = [];
    for (const record of this.listInterrupted()) {
      const handler = handlers[record.operation];
      if (typeof handler !== "function") {
        results.push({
          step_run_id: record.step_run_id,
          recovered: false,
          reason: "HANDLER_NOT_REGISTERED"
        });
        continue;
      }
      try {
        const payload = handler(clone(record));
        this.resume(record.step_run_id, "auto_recovered", payload && payload.resume_state ? payload.resume_state : {}, {
          recovery_result: payload || {}
        });
        results.push({
          step_run_id: record.step_run_id,
          recovered: true
        });
      } catch (err) {
        this.fail(record.step_run_id, err && err.message ? err.message : "AUTO_RECOVERY_FAILED");
        results.push({
          step_run_id: record.step_run_id,
          recovered: false,
          reason: err && err.message ? err.message : "AUTO_RECOVERY_FAILED"
        });
      }
    }
    return results;
  }
}

module.exports = {
  JsonlStepJournal,
  STEP_STATUSES
};
