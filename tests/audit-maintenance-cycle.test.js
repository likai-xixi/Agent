const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createAuditEvent } = require("../src/platform/audit");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const {
  runAuditMaintenanceCycle,
  runAuditMaintenanceScheduler
} = require("../scripts/audit-maintenance-cycle");
const {
  InMemoryAlertSuppressionStore,
  SEVERITIES
} = require("../src/monitoring/alertEscalationPolicy");
const { JsonlAuditMaintenanceHistoryStore } = require("../src/monitoring/auditMaintenanceHistoryStore");

function seedAuditEventStore(filePath) {
  const store = new JsonlAuditEventStore({ filePath });
  store.append(createAuditEvent({
    trace_id: "trace-maint-1",
    task_id: "task-maint-1",
    attempt_id: "attempt-1",
    actor: "unit-test",
    source: "tests",
    event_type: "TASK_CREATED",
    payload: {
      task_snapshot: {
        task_id: "task-maint-1",
        trace_id: "trace-maint-1",
        task_type: "generic",
        state: "PENDING",
        attempt: 0,
        version: 1,
        metadata: {}
      }
    }
  }));
}

test("runAuditMaintenanceCycle succeeds and does not notify on healthy retention", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-maint-pass-"));
  const sourcePath = path.join(tempDir, "events.jsonl");
  const archiveDir = path.join(tempDir, "archive");
  const alertLogPath = path.join(tempDir, "alerts.jsonl");
  seedAuditEventStore(sourcePath);

  const notifications = [];
  const result = await runAuditMaintenanceCycle({
    source: sourcePath,
    archiveDir,
    maxAgeDays: 30,
    maxArchives: 50,
    minArchives: 1,
    alertLogPath
  }, {
    notifier: {
      async sendOperationalAlert(payload) {
        notifications.push(payload);
        return { status: "SENT", payload };
      }
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.archive.archived, true);
  assert.equal(result.retention.success, true);
  assert.equal(result.escalation, null);
  assert.equal(result.notification, null);
  assert.equal(notifications.length, 0);
  assert.equal(fs.existsSync(alertLogPath), true);
  assert.equal(fs.readFileSync(alertLogPath, "utf8"), "");
});

test("runAuditMaintenanceCycle notifies when retention policy fails", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-maint-fail-"));
  const sourcePath = path.join(tempDir, "events.jsonl");
  const archiveDir = path.join(tempDir, "archive");
  const alertLogPath = path.join(tempDir, "alerts.jsonl");
  seedAuditEventStore(sourcePath);

  const result = await runAuditMaintenanceCycle({
    source: sourcePath,
    archiveDir,
    maxAgeDays: 30,
    maxArchives: 0,
    minArchives: 0,
    alertLogPath
  }, {
    notifier: {
      async sendOperationalAlert(payload, options = {}) {
        return {
          notification_id: "notif-1",
          channel: options.channel || "ops-warning",
          severity: options.severity || "WARNING",
          status: "SENT",
          payload
        };
      }
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.retention.success, false);
  assert.ok(result.retention.reasons.includes("ARCHIVE_COUNT_ABOVE_MAX"));
  assert.ok(result.notification);
  assert.equal(result.escalation.severity, SEVERITIES.WARNING);
  assert.equal(result.escalation.channel, "ops-warning");
  assert.equal(fs.existsSync(alertLogPath), true);
  const logged = fs.readFileSync(alertLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(logged.length, 1);
});

test("runAuditMaintenanceCycle suppresses duplicate critical alerts within dedupe window", async () => {
  const suppressionStore = new InMemoryAlertSuppressionStore();
  let sentCount = 0;
  const notifier = {
    async sendOperationalAlert(payload, options = {}) {
      sentCount += 1;
      return {
        notification_id: `notif-${sentCount}`,
        channel: options.channel || "ops-warning",
        severity: options.severity || "WARNING",
        status: "SENT",
        payload
      };
    }
  };
  const retentionRunner = () => ({
    timestamp: new Date().toISOString(),
    archive_dir: "archive",
    policy: {
      min_archives: 0,
      max_archives: 500,
      max_age_days: 30
    },
    archive_count: 12,
    integrity_failures: [{ archive_id: "a1", reason: "ARCHIVE_HASH_MISMATCH" }],
    stale_archives: [],
    success: false,
    reasons: ["INTEGRITY_FAILURE"]
  });
  const archiveRunner = () => ({
    timestamp: new Date().toISOString(),
    events_count: 1,
    archived: true,
    success: true
  });

  const first = await runAuditMaintenanceCycle({
    archiveDir: "data/audit-archive"
  }, {
    notifier,
    archiveRunner,
    retentionRunner,
    suppressionStore
  });
  const second = await runAuditMaintenanceCycle({
    archiveDir: "data/audit-archive"
  }, {
    notifier,
    archiveRunner,
    retentionRunner,
    suppressionStore
  });

  assert.equal(first.escalation.severity, SEVERITIES.CRITICAL);
  assert.equal(first.escalation.suppressed, false);
  assert.equal(first.notification.status, "SENT");
  assert.equal(second.escalation.severity, SEVERITIES.CRITICAL);
  assert.equal(second.escalation.suppressed, true);
  assert.equal(second.notification.status, "SUPPRESSED");
  assert.equal(sentCount, 1);
});

test("runAuditMaintenanceScheduler executes requested iterations", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-maint-loop-"));
  const sourcePath = path.join(tempDir, "events.jsonl");
  const archiveDir = path.join(tempDir, "archive");
  const historyPath = path.join(tempDir, "maintenance-history.jsonl");
  seedAuditEventStore(sourcePath);

  const result = await runAuditMaintenanceScheduler({
    source: sourcePath,
    archiveDir,
    historyPath,
    iterations: 3,
    intervalSeconds: 0,
    maxAgeDays: 30,
    maxArchives: 500,
    minArchives: 0
  });

  assert.equal(result.runs.length, 3);
  assert.equal(result.success, true);
  assert.equal(Boolean(result.history_entry && result.history_entry.run_id), true);
  assert.ok(result.runs.every((item) => item.retention.success === true));
  const store = new JsonlAuditMaintenanceHistoryStore({ filePath: historyPath });
  const latest = store.getLatestRun();
  assert.equal(Boolean(latest), true);
  assert.equal(latest.run_count, 3);
  assert.equal(latest.success, true);
});
