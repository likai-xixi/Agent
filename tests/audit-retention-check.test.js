const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FileWormAuditArchiveSink } = require("../src/orchestrator/auditArchiveSink");
const { evaluateAuditRetention } = require("../scripts/audit-retention-check");

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("evaluateAuditRetention passes for healthy archive set", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-pass-"));
  const sink = new FileWormAuditArchiveSink({ archiveDir: tempDir });
  sink.appendBatch({
    events: [{ task_id: "task-1", event_type: "TASK_CREATED" }],
    source: "unit-test",
    actor: "tester"
  });

  const result = evaluateAuditRetention({
    archiveDir: tempDir,
    maxAgeDays: 30,
    maxArchives: 5,
    minArchives: 1
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.integrity_failures, []);
  assert.deepEqual(result.stale_archives, []);
});

test("evaluateAuditRetention fails when archive file is tampered", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-tamper-"));
  const sink = new FileWormAuditArchiveSink({ archiveDir: tempDir });
  const manifest = sink.appendBatch({
    events: [{ task_id: "task-2", event_type: "TASK_CREATED" }],
    source: "unit-test",
    actor: "tester"
  });
  fs.appendFileSync(path.join(tempDir, manifest.archive_file), "{\"tampered\":true}\n", "utf8");

  const result = evaluateAuditRetention({
    archiveDir: tempDir
  });

  assert.equal(result.success, false);
  assert.equal(result.integrity_failures.length, 1);
  assert.equal(result.reasons.includes("INTEGRITY_FAILURE"), true);
});

test("evaluateAuditRetention fails when archives are older than policy", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-stale-"));
  const sink = new FileWormAuditArchiveSink({ archiveDir: tempDir });
  sink.appendBatch({
    events: [{ task_id: "task-3", event_type: "TASK_CREATED" }],
    source: "unit-test",
    actor: "tester"
  });

  const manifestPath = path.join(tempDir, "manifest.jsonl");
  const lines = readJsonl(manifestPath);
  lines[0].created_at = "2020-01-01T00:00:00Z";
  fs.writeFileSync(manifestPath, `${lines.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

  const result = evaluateAuditRetention({
    archiveDir: tempDir,
    maxAgeDays: 30
  });

  assert.equal(result.success, false);
  assert.equal(result.stale_archives.length, 1);
  assert.equal(result.reasons.includes("STALE_ARCHIVES_FOUND"), true);
});
