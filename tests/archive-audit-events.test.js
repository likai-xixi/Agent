const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { archiveAuditEvents } = require("../scripts/archive-audit-events");

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
}

test("archiveAuditEvents archives source events and verifies archive", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-script-"));
  const source = path.join(tempDir, "audit-events.jsonl");
  const archiveDir = path.join(tempDir, "archive");

  writeJsonl(source, [
    { event_type: "TASK_CREATED", task_id: "task-1" },
    { event_type: "TASK_STATE_CHANGED", task_id: "task-1" }
  ]);

  const result = archiveAuditEvents({
    source,
    archiveDir,
    actor: "tester"
  });

  assert.equal(result.archived, true);
  assert.equal(result.events_count, 2);
  assert.equal(result.success, true);
  assert.equal(result.verification.valid, true);
});

test("archiveAuditEvents returns NO_EVENTS when source is empty", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-script-empty-"));
  const source = path.join(tempDir, "audit-events.jsonl");
  const archiveDir = path.join(tempDir, "archive");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "", "utf8");

  const result = archiveAuditEvents({
    source,
    archiveDir
  });

  assert.equal(result.archived, false);
  assert.equal(result.reason, "NO_EVENTS");
});
