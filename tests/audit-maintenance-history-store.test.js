const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  InMemoryAuditMaintenanceHistoryStore,
  JsonlAuditMaintenanceHistoryStore
} = require("../src/monitoring/auditMaintenanceHistoryStore");

function createReport({
  success = true,
  reasons = ["OK"]
} = {}) {
  return {
    timestamp: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    interval_seconds: 0,
    iterations_requested: 1,
    runs: [
      {
        success,
        archive: {
          success: true
        },
        retention: {
          success,
          reasons
        }
      }
    ],
    success
  };
}

test("InMemoryAuditMaintenanceHistoryStore lists latest and failure summary", () => {
  const store = new InMemoryAuditMaintenanceHistoryStore();
  store.appendRun(createReport({
    success: false,
    reasons: ["INTEGRITY_FAILURE", "STALE_ARCHIVES_FOUND"]
  }));
  store.appendRun(createReport({
    success: true,
    reasons: ["OK"]
  }));

  const latest = store.getLatestRun();
  assert.equal(latest.success, true);

  const failedRuns = store.listRuns({
    status: "FAILED",
    limit: 10
  });
  assert.equal(failedRuns.length, 1);
  assert.ok(failedRuns[0].failed_reasons.includes("INTEGRITY_FAILURE"));

  const summary = store.summarizeFailures({
    limit: 10
  });
  assert.equal(summary.failed_runs, 1);
  assert.equal(summary.reasons[0].reason, "INTEGRITY_FAILURE");
});

test("JsonlAuditMaintenanceHistoryStore persists and truncates records", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-history-store-"));
  const filePath = path.join(tempDir, "history.jsonl");
  const store = new JsonlAuditMaintenanceHistoryStore({
    filePath,
    maxRecords: 2
  });

  store.appendRun(createReport({ success: true }));
  store.appendRun(createReport({
    success: false,
    reasons: ["ARCHIVE_COUNT_ABOVE_MAX"]
  }));
  store.appendRun(createReport({
    success: false,
    reasons: ["STALE_ARCHIVES_FOUND"]
  }));

  const runs = store.listRuns({
    limit: 10
  });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].success, false);

  const summary = store.summarizeFailures({
    limit: 10
  });
  assert.equal(summary.failed_runs, 2);
  assert.equal(summary.reasons.length > 0, true);
  assert.equal(fs.existsSync(filePath), true);
});

