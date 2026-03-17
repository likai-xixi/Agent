const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SelfHealingSupervisor } = require("../src/monitoring/selfHealingSupervisor");
const { decryptBackupPayload } = require("../src/platform/digitalSoulBackup");

test("SelfHealingSupervisor writes encrypted digital soul backups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-heal-backup-"));
  const sourceFile = path.join(root, "notes.txt");
  fs.writeFileSync(sourceFile, "plain text that must never be copied in clear", "utf8");

  const supervisor = new SelfHealingSupervisor({
    backupRoot: path.join(root, "backups"),
    backupMasterKey: "digital-soul-master-key"
  });

  const backup = supervisor.backupFiles([sourceFile]);
  assert.equal(backup.encrypted, true);
  assert.equal(backup.copied.length, 1);
  assert.equal(backup.copied[0].endsWith(".enc"), true);

  const encrypted = fs.readFileSync(backup.copied[0]);
  assert.equal(encrypted.includes("plain text that must never be copied in clear"), false);

  const decrypted = decryptBackupPayload(encrypted, "digital-soul-master-key");
  assert.equal(decrypted.content.toString("utf8"), "plain text that must never be copied in clear");
  assert.equal(decrypted.metadata.source_basename, "notes.txt");
});
