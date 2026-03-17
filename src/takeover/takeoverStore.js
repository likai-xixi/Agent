const fs = require("fs");
const path = require("path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class InMemoryTakeoverStore {
  constructor() {
    this.records = new Map();
  }

  save(record) {
    this.records.set(record.task_id, clone(record));
    return clone(record);
  }

  getByTaskId(taskId) {
    const record = this.records.get(taskId);
    return record ? clone(record) : null;
  }

  list() {
    return [...this.records.values()].map((item) => clone(item));
  }

  clear() {
    this.records.clear();
  }
}

class JsonFileTakeoverStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join("data", "takeover-records.json");
    this.ensureStorePath();
  }

  ensureStorePath() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "{}\n", "utf8");
    }
  }

  readAll() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8").trim();
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  }

  writeAll(records) {
    fs.writeFileSync(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }

  save(record) {
    const all = this.readAll();
    all[record.task_id] = clone(record);
    this.writeAll(all);
    return clone(record);
  }

  getByTaskId(taskId) {
    const all = this.readAll();
    if (!all[taskId]) {
      return null;
    }
    return clone(all[taskId]);
  }

  list() {
    const all = this.readAll();
    return Object.values(all).map((item) => clone(item));
  }

  clear() {
    this.writeAll({});
  }
}

module.exports = {
  InMemoryTakeoverStore,
  JsonFileTakeoverStore
};
