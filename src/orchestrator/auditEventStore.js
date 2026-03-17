const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveDataPath } = require("../platform/appPaths");

function computeEventHash(event, previousHash) {
  const body = JSON.stringify({
    previous_event_hash: previousHash,
    event
  });
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

class JsonlAuditEventStore {
  constructor(options = {}) {
    const filePath = options.filePath || resolveDataPath("audit-events.jsonl");
    this.filePath = filePath;
    this.ensureStorePath();
  }

  ensureStorePath() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  append(event) {
    const previousHash = this.getLastEventHash();
    const hashed = {
      ...event,
      previous_event_hash: previousHash,
      event_hash: computeEventHash(event, previousHash)
    };
    const serialized = `${JSON.stringify(hashed)}\n`;
    fs.appendFileSync(this.filePath, serialized, "utf8");
    return hashed;
  }

  appendMany(events) {
    if (!Array.isArray(events) || events.length === 0) {
      return [];
    }
    let previousHash = this.getLastEventHash();
    const hashed = events.map((event) => {
      const withHash = {
        ...event,
        previous_event_hash: previousHash,
        event_hash: computeEventHash(event, previousHash)
      };
      previousHash = withHash.event_hash;
      return withHash;
    });
    const serialized = `${hashed.map((item) => JSON.stringify(item)).join("\n")}\n`;
    fs.appendFileSync(this.filePath, serialized, "utf8");
    return hashed;
  }

  getAllEvents() {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const lines = fs
      .readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  queryByTaskId(taskId) {
    return this.getAllEvents().filter((event) => event.task_id === taskId);
  }

  queryByTraceId(traceId) {
    return this.getAllEvents().filter((event) => event.trace_id === traceId);
  }

  clear() {
    fs.writeFileSync(this.filePath, "", "utf8");
  }

  getLastEventHash() {
    const events = this.getAllEvents();
    if (events.length === 0) {
      return "";
    }
    const last = events[events.length - 1];
    return typeof last.event_hash === "string" ? last.event_hash : "";
  }

  verifyIntegrity() {
    const events = this.getAllEvents();
    let previousHash = "";
    for (let idx = 0; idx < events.length; idx += 1) {
      const event = events[idx];
      const normalizedEvent = { ...event };
      delete normalizedEvent.previous_event_hash;
      delete normalizedEvent.event_hash;

      const expectedPrevious = previousHash;
      const expectedHash = computeEventHash(normalizedEvent, expectedPrevious);
      if (event.previous_event_hash !== expectedPrevious) {
        return {
          valid: false,
          index: idx,
          reason: "PREVIOUS_HASH_MISMATCH"
        };
      }
      if (event.event_hash !== expectedHash) {
        return {
          valid: false,
          index: idx,
          reason: "EVENT_HASH_MISMATCH"
        };
      }
      previousHash = event.event_hash;
    }
    return {
      valid: true,
      index: -1,
      reason: "OK"
    };
  }
}

module.exports = {
  JsonlAuditEventStore,
  computeEventHash
};
