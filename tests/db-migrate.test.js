const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");

test("db-migrate script applies and rolls back runtime schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-migrate-"));
  const dbPath = path.join(dir, "runtime.db");
  const up = cp.spawnSync("node", ["scripts/db-migrate.js", "--up", "--db", dbPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(up.status, 0);
  const db = new DatabaseSync(dbPath);
  const tableRow = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'audit_events'
  `).get();
  assert.equal(Boolean(tableRow), true);
  db.close();

  const down = cp.spawnSync("node", ["scripts/db-migrate.js", "--down", "--db", dbPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(down.status, 0);
  const dbAfterDown = new DatabaseSync(dbPath);
  const droppedRow = dbAfterDown.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'audit_events'
  `).get();
  assert.equal(Boolean(droppedRow), false);
  dbAfterDown.close();
});
