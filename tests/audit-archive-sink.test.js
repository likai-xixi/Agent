const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FileWormAuditArchiveSink } = require("../src/orchestrator/auditArchiveSink");

test("FileWormAuditArchiveSink archives events and verifies integrity", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-archive-"));
  const sink = new FileWormAuditArchiveSink({
    archiveDir: tempDir
  });

  const manifest = sink.appendBatch({
    events: [
      { event_type: "TASK_CREATED", task_id: "task-1" },
      { event_type: "TASK_STATE_CHANGED", task_id: "task-1" }
    ],
    source: "unit-test",
    actor: "tester"
  });
  assert.equal(Boolean(manifest.archive_id), true);
  assert.equal(manifest.events_count, 2);

  const listed = sink.listManifests();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].archive_id, manifest.archive_id);

  const verified = sink.verifyArchive(manifest.archive_id);
  assert.equal(verified.valid, true);
});

test("FileWormAuditArchiveSink detects archive tampering", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-archive-tamper-"));
  const sink = new FileWormAuditArchiveSink({
    archiveDir: tempDir
  });
  const manifest = sink.appendBatch({
    events: [{ event_type: "TASK_CREATED", task_id: "task-2" }],
    source: "unit-test",
    actor: "tester"
  });
  const archivePath = path.join(tempDir, manifest.archive_file);
  fs.appendFileSync(archivePath, "{\"tampered\":true}\n", "utf8");

  const verified = sink.verifyArchive(manifest.archive_id);
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, "ARCHIVE_HASH_MISMATCH");
});
