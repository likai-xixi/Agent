const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { InMemoryTakeoverStore, JsonFileTakeoverStore } = require("../src/takeover/takeoverStore");

test("InMemoryTakeoverStore saves and retrieves records", () => {
  const store = new InMemoryTakeoverStore();
  store.save({
    task_id: "task-store-1",
    status: "PENDING"
  });
  const loaded = store.getByTaskId("task-store-1");
  assert.equal(loaded.status, "PENDING");
  assert.equal(store.list().length, 1);
});

test("JsonFileTakeoverStore persists records to disk", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-store-"));
  const filePath = path.join(tempDir, "takeover-records.json");
  const storeA = new JsonFileTakeoverStore({ filePath });

  storeA.save({
    task_id: "task-store-2",
    status: "PENDING"
  });

  const storeB = new JsonFileTakeoverStore({ filePath });
  const loaded = storeB.getByTaskId("task-store-2");
  assert.equal(Boolean(loaded), true);
  assert.equal(loaded.status, "PENDING");
  assert.equal(storeB.list().length, 1);
});
