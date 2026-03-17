const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const { computeEventHash } = require("../orchestrator/auditEventStore");

const DEFAULT_DB_PATH = path.join("data", "runtime-state.db");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDbDir(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return fallback;
  }
}

function normalizeDatabaseHandle(database) {
  if (!database) {
    return null;
  }
  if (database.db && typeof database.db.prepare === "function") {
    return database.db;
  }
  if (typeof database.prepare === "function") {
    return database;
  }
  return null;
}

function migrateRuntimeDatabaseUp(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      previous_event_hash TEXT,
      event_hash TEXT NOT NULL,
      event_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_task_id ON audit_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_trace_id ON audit_events(trace_id);

    CREATE TABLE IF NOT EXISTS task_snapshots (
      task_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_snapshots_state ON task_snapshots(state);
    CREATE INDEX IF NOT EXISTS idx_task_snapshots_updated_at ON task_snapshots(updated_at);

    CREATE TABLE IF NOT EXISTS takeover_records (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_takeover_status ON takeover_records(status);

    CREATE TABLE IF NOT EXISTS provider_alerts (
      alert_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      alert_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_provider_alerts_status ON provider_alerts(status);
    CREATE INDEX IF NOT EXISTS idx_provider_alerts_provider_reason ON provider_alerts(provider, reason);
  `);

  const stmt = db.prepare("INSERT OR REPLACE INTO schema_migrations(id, applied_at) VALUES(?, ?)");
  stmt.run("runtime-v1", new Date().toISOString());
}

function migrateRuntimeDatabaseDown(db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_alerts;
    DROP TABLE IF EXISTS takeover_records;
    DROP TABLE IF EXISTS task_snapshots;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS schema_migrations;
  `);
}

class SqliteRuntimeDatabase {
  constructor(options = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    ensureDbDir(this.dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    if (options.autoMigrate !== false) {
      migrateRuntimeDatabaseUp(this.db);
    }
  }

  migrateUp() {
    migrateRuntimeDatabaseUp(this.db);
  }

  migrateDown() {
    migrateRuntimeDatabaseDown(this.db);
  }

  close() {
    this.db.close();
  }
}

class SqliteAuditEventStore {
  constructor(options = {}) {
    this.runtimeDatabase = options.database || new SqliteRuntimeDatabase({
      dbPath: options.dbPath,
      autoMigrate: options.autoMigrate
    });
    this.db = normalizeDatabaseHandle(this.runtimeDatabase);
    this.ownsDatabase = !options.database;
    if (!this.db) {
      throw new Error("Invalid SQLite database handle");
    }
  }

  append(event) {
    const previousHash = this.getLastEventHash();
    const hashed = {
      ...event,
      previous_event_hash: previousHash,
      event_hash: computeEventHash(event, previousHash)
    };
    this.db.prepare(`
      INSERT INTO audit_events(
        trace_id, task_id, attempt_id, actor, source, event_type, timestamp,
        previous_event_hash, event_hash, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      hashed.trace_id,
      hashed.task_id,
      hashed.attempt_id,
      hashed.actor,
      hashed.source,
      hashed.event_type,
      hashed.timestamp,
      hashed.previous_event_hash || "",
      hashed.event_hash,
      JSON.stringify(hashed)
    );
    return clone(hashed);
  }

  appendMany(events) {
    if (!Array.isArray(events) || events.length === 0) {
      return [];
    }
    const insert = this.db.prepare(`
      INSERT INTO audit_events(
        trace_id, task_id, attempt_id, actor, source, event_type, timestamp,
        previous_event_hash, event_hash, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const output = [];
    let previousHash = this.getLastEventHash();
    this.db.exec("BEGIN");
    try {
      for (const event of events) {
        const hashed = {
          ...event,
          previous_event_hash: previousHash,
          event_hash: computeEventHash(event, previousHash)
        };
        previousHash = hashed.event_hash;
        insert.run(
          hashed.trace_id,
          hashed.task_id,
          hashed.attempt_id,
          hashed.actor,
          hashed.source,
          hashed.event_type,
          hashed.timestamp,
          hashed.previous_event_hash || "",
          hashed.event_hash,
          JSON.stringify(hashed)
        );
        output.push(clone(hashed));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return output;
  }

  getAllEvents() {
    const rows = this.db.prepare("SELECT event_json FROM audit_events ORDER BY id ASC").all();
    return rows.map((row) => parseJson(row.event_json, {}));
  }

  queryByTaskId(taskId) {
    const rows = this.db.prepare("SELECT event_json FROM audit_events WHERE task_id = ? ORDER BY id ASC").all(taskId);
    return rows.map((row) => parseJson(row.event_json, {}));
  }

  queryByTraceId(traceId) {
    const rows = this.db.prepare("SELECT event_json FROM audit_events WHERE trace_id = ? ORDER BY id ASC").all(traceId);
    return rows.map((row) => parseJson(row.event_json, {}));
  }

  clear() {
    this.db.exec("DELETE FROM audit_events");
  }

  getLastEventHash() {
    const row = this.db.prepare("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1").get();
    return row && typeof row.event_hash === "string" ? row.event_hash : "";
  }

  verifyIntegrity() {
    const events = this.getAllEvents();
    let previousHash = "";
    for (let idx = 0; idx < events.length; idx += 1) {
      const event = events[idx];
      const normalized = { ...event };
      delete normalized.previous_event_hash;
      delete normalized.event_hash;
      const expectedHash = computeEventHash(normalized, previousHash);
      if (event.previous_event_hash !== previousHash) {
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

  close() {
    if (this.ownsDatabase && this.runtimeDatabase && typeof this.runtimeDatabase.close === "function") {
      this.runtimeDatabase.close();
    }
  }
}

class SqliteTaskSnapshotStore {
  constructor(options = {}) {
    this.runtimeDatabase = options.database || new SqliteRuntimeDatabase({
      dbPath: options.dbPath,
      autoMigrate: options.autoMigrate
    });
    this.db = normalizeDatabaseHandle(this.runtimeDatabase);
    this.ownsDatabase = !options.database;
  }

  save(task) {
    const updatedAt = String(task.updated_at || task.created_at || new Date().toISOString());
    this.db.prepare(`
      INSERT INTO task_snapshots(task_id, trace_id, state, updated_at, task_json)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        trace_id=excluded.trace_id,
        state=excluded.state,
        updated_at=excluded.updated_at,
        task_json=excluded.task_json
    `).run(
      task.task_id,
      task.trace_id,
      task.state,
      updatedAt,
      JSON.stringify(task)
    );
    return clone(task);
  }

  get(taskId) {
    const row = this.db.prepare("SELECT task_json FROM task_snapshots WHERE task_id = ?").get(taskId);
    if (!row) {
      return null;
    }
    return parseJson(row.task_json, null);
  }

  list({
    state = "",
    limit = 100
  } = {}) {
    const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;
    const normalizedState = String(state || "").trim().toUpperCase();
    let rows = [];
    if (normalizedState) {
      rows = this.db.prepare(`
        SELECT task_json FROM task_snapshots
        WHERE state = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(normalizedState, effectiveLimit);
    } else {
      rows = this.db.prepare(`
        SELECT task_json FROM task_snapshots
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(effectiveLimit);
    }
    return rows.map((row) => parseJson(row.task_json, {}));
  }

  clear() {
    this.db.exec("DELETE FROM task_snapshots");
  }

  close() {
    if (this.ownsDatabase && this.runtimeDatabase && typeof this.runtimeDatabase.close === "function") {
      this.runtimeDatabase.close();
    }
  }
}

class SqliteTakeoverStore {
  constructor(options = {}) {
    this.runtimeDatabase = options.database || new SqliteRuntimeDatabase({
      dbPath: options.dbPath,
      autoMigrate: options.autoMigrate
    });
    this.db = normalizeDatabaseHandle(this.runtimeDatabase);
    this.ownsDatabase = !options.database;
  }

  save(record) {
    const updatedAt = String(record.updated_at || new Date().toISOString());
    this.db.prepare(`
      INSERT INTO takeover_records(task_id, status, updated_at, record_json)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        status=excluded.status,
        updated_at=excluded.updated_at,
        record_json=excluded.record_json
    `).run(
      record.task_id,
      String(record.status || ""),
      updatedAt,
      JSON.stringify(record)
    );
    return clone(record);
  }

  getByTaskId(taskId) {
    const row = this.db.prepare("SELECT record_json FROM takeover_records WHERE task_id = ?").get(taskId);
    if (!row) {
      return null;
    }
    return parseJson(row.record_json, null);
  }

  list() {
    const rows = this.db.prepare("SELECT record_json FROM takeover_records ORDER BY updated_at DESC").all();
    return rows.map((row) => parseJson(row.record_json, {}));
  }

  clear() {
    this.db.exec("DELETE FROM takeover_records");
  }

  close() {
    if (this.ownsDatabase && this.runtimeDatabase && typeof this.runtimeDatabase.close === "function") {
      this.runtimeDatabase.close();
    }
  }
}

class SqliteHealthAlarmStore {
  constructor(options = {}) {
    this.runtimeDatabase = options.database || new SqliteRuntimeDatabase({
      dbPath: options.dbPath,
      autoMigrate: options.autoMigrate
    });
    this.db = normalizeDatabaseHandle(this.runtimeDatabase);
    this.ownsDatabase = !options.database;
  }

  findOpenAlert(provider, reason) {
    const row = this.db.prepare(`
      SELECT alert_json
      FROM provider_alerts
      WHERE provider = ? AND reason = ? AND status = 'OPEN'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(provider, reason);
    return row ? parseJson(row.alert_json, null) : null;
  }

  createAlert({
    provider,
    severity,
    reason,
    message,
    snapshot
  }) {
    const existing = this.findOpenAlert(provider, reason);
    if (existing) {
      return clone(existing);
    }
    const now = new Date().toISOString();
    const alert = {
      alert_id: randomUUID(),
      provider,
      severity,
      reason,
      message,
      status: "OPEN",
      created_at: now,
      updated_at: now,
      snapshot,
      acked_by: "",
      acked_at: "",
      note: ""
    };
    this.db.prepare(`
      INSERT INTO provider_alerts(alert_id, provider, reason, status, updated_at, alert_json)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(
      alert.alert_id,
      alert.provider,
      alert.reason,
      alert.status,
      alert.updated_at,
      JSON.stringify(alert)
    );
    return clone(alert);
  }

  listAlerts({
    status = ""
  } = {}) {
    let rows = [];
    if (status) {
      rows = this.db.prepare(`
        SELECT alert_json
        FROM provider_alerts
        WHERE status = ?
        ORDER BY updated_at DESC
      `).all(status);
    } else {
      rows = this.db.prepare(`
        SELECT alert_json
        FROM provider_alerts
        ORDER BY updated_at DESC
      `).all();
    }
    return rows.map((row) => parseJson(row.alert_json, {}));
  }

  acknowledgeAlert({
    alert_id,
    actor = "operator",
    note = ""
  }) {
    const row = this.db.prepare("SELECT alert_json FROM provider_alerts WHERE alert_id = ?").get(alert_id);
    if (!row) {
      return null;
    }
    const alert = parseJson(row.alert_json, null);
    if (!alert) {
      return null;
    }
    const updated = {
      ...alert,
      status: "ACKED",
      updated_at: new Date().toISOString(),
      acked_by: actor,
      acked_at: new Date().toISOString(),
      note
    };
    this.db.prepare(`
      UPDATE provider_alerts
      SET status = ?, updated_at = ?, alert_json = ?
      WHERE alert_id = ?
    `).run(
      updated.status,
      updated.updated_at,
      JSON.stringify(updated),
      alert_id
    );
    return clone(updated);
  }

  clear() {
    this.db.exec("DELETE FROM provider_alerts");
  }

  close() {
    if (this.ownsDatabase && this.runtimeDatabase && typeof this.runtimeDatabase.close === "function") {
      this.runtimeDatabase.close();
    }
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  SqliteAuditEventStore,
  SqliteHealthAlarmStore,
  SqliteRuntimeDatabase,
  SqliteTakeoverStore,
  SqliteTaskSnapshotStore,
  migrateRuntimeDatabaseDown,
  migrateRuntimeDatabaseUp
};
