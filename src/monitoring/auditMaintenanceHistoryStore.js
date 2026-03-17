const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildFailureReasons(report) {
  const reasons = new Set();
  const runs = Array.isArray(report && report.runs) ? report.runs : [];
  for (const run of runs) {
    if (run && run.archive && run.archive.success === false) {
      reasons.add("ARCHIVE_FAILURE");
    }
    if (run && run.retention && run.retention.success === false) {
      const retentionReasons = Array.isArray(run.retention.reasons) ? run.retention.reasons : [];
      if (retentionReasons.length === 0) {
        reasons.add("RETENTION_FAILURE");
      } else {
        for (const reason of retentionReasons) {
          reasons.add(String(reason));
        }
      }
    }
    if (run && run.success === false && !run.archive && !run.retention) {
      reasons.add("RUN_FAILED");
    }
  }

  const reportSuccess = report && report.success === true;
  if (!reportSuccess && reasons.size === 0) {
    reasons.add("UNKNOWN_FAILURE");
  }
  return [...reasons];
}

function normalizeRunReport(report = {}) {
  const runs = Array.isArray(report.runs) ? clone(report.runs) : [];
  const success = report.success === true;
  return {
    run_id: randomUUID(),
    recorded_at: new Date().toISOString(),
    timestamp: report.timestamp || new Date().toISOString(),
    started_at: report.started_at || "",
    completed_at: report.completed_at || "",
    status: success ? "SUCCESS" : "FAILED",
    success,
    interval_seconds: Number.isFinite(Number(report.interval_seconds)) ? Number(report.interval_seconds) : 0,
    iterations_requested: Number.isFinite(Number(report.iterations_requested)) ? Number(report.iterations_requested) : runs.length,
    run_count: runs.length,
    failed_reasons: buildFailureReasons(report),
    runs
  };
}

function normalizeLimit(value, fallback = 20) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 500);
}

function filterByStatus(items, status = "") {
  if (!status) {
    return items;
  }
  const normalized = String(status).toUpperCase();
  return items.filter((item) => String(item.status).toUpperCase() === normalized);
}

function summarizeFailureReasons(items) {
  const counts = new Map();
  for (const item of items) {
    const reasons = Array.isArray(item.failed_reasons) ? item.failed_reasons : [];
    const candidateReasons = reasons.length > 0 ? reasons : ["UNKNOWN_FAILURE"];
    for (const reason of candidateReasons) {
      const key = String(reason);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => {
      if (a.count === b.count) {
        return a.reason < b.reason ? -1 : 1;
      }
      return b.count - a.count;
    });
}

class InMemoryAuditMaintenanceHistoryStore {
  constructor(options = {}) {
    this.maxRecords = normalizeLimit(options.maxRecords, 500);
    this.records = [];
  }

  appendRun(report) {
    const entry = normalizeRunReport(report);
    this.records.unshift(entry);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(0, this.maxRecords);
    }
    return clone(entry);
  }

  getLatestRun() {
    return this.records.length > 0 ? clone(this.records[0]) : null;
  }

  listRuns({ limit = 20, status = "" } = {}) {
    const filtered = filterByStatus(this.records, status);
    return filtered.slice(0, normalizeLimit(limit, 20)).map((item) => clone(item));
  }

  summarizeFailures({ limit = 100 } = {}) {
    const all = this.listRuns({
      limit: normalizeLimit(limit, 100),
      status: ""
    });
    const failed = all.filter((item) => item.success === false);
    return {
      inspected_runs: all.length,
      failed_runs: failed.length,
      reasons: summarizeFailureReasons(failed)
    };
  }
}

class JsonlAuditMaintenanceHistoryStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join("data", "audit-maintenance-history.jsonl");
    this.maxRecords = normalizeLimit(options.maxRecords, 500);
    this.ensureStorePath();
  }

  ensureStorePath() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  readAll() {
    return parseJsonl(this.filePath);
  }

  writeAll(items) {
    const lines = items.map((item) => JSON.stringify(item)).join("\n");
    const text = lines ? `${lines}\n` : "";
    fs.writeFileSync(this.filePath, text, "utf8");
  }

  appendRun(report) {
    const entry = normalizeRunReport(report);
    const current = this.readAll();
    current.unshift(entry);
    this.writeAll(current.slice(0, this.maxRecords));
    return clone(entry);
  }

  getLatestRun() {
    const all = this.readAll();
    return all.length > 0 ? clone(all[0]) : null;
  }

  listRuns({ limit = 20, status = "" } = {}) {
    const all = this.readAll();
    const filtered = filterByStatus(all, status);
    return filtered.slice(0, normalizeLimit(limit, 20)).map((item) => clone(item));
  }

  summarizeFailures({ limit = 100 } = {}) {
    const all = this.listRuns({
      limit: normalizeLimit(limit, 100),
      status: ""
    });
    const failed = all.filter((item) => item.success === false);
    return {
      inspected_runs: all.length,
      failed_runs: failed.length,
      reasons: summarizeFailureReasons(failed)
    };
  }
}

module.exports = {
  InMemoryAuditMaintenanceHistoryStore,
  JsonlAuditMaintenanceHistoryStore,
  buildFailureReasons,
  normalizeLimit,
  normalizeRunReport,
  parseJsonl,
  summarizeFailureReasons
};

