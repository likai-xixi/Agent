const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { JsonFileSecretVault } = require("../src/platform/secretVault");

function createVaultForTest() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-vault-"));
  const filePath = path.join(tempDir, "vault.json");
  const auditPath = path.join(tempDir, "vault-audit.jsonl");
  return {
    tempDir,
    filePath,
    auditPath,
    vault: new JsonFileSecretVault({
      filePath,
      auditLogPath: auditPath,
      masterKey: "master-key-1"
    })
  };
}

test("JsonFileSecretVault encrypts at rest and returns masked listing", () => {
  const { filePath, vault } = createVaultForTest();
  const upserted = vault.upsertSecret("OPENAI_API_KEY", "sk-test-openai-123456", {
    actor: "unit-test"
  });
  assert.equal(upserted.name, "OPENAI_API_KEY");
  assert.equal(upserted.masked_value.includes("***"), true);

  const raw = fs.readFileSync(filePath, "utf8");
  assert.equal(raw.includes("sk-test-openai-123456"), false);

  const value = vault.getSecret("OPENAI_API_KEY");
  assert.equal(value, "sk-test-openai-123456");

  const listed = vault.listSecretsMasked();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "OPENAI_API_KEY");
  assert.equal(listed[0].masked_value.includes("***"), true);
});

test("JsonFileSecretVault rotates master key and keeps secrets readable", () => {
  const { filePath, auditPath, vault } = createVaultForTest();
  vault.upsertSecret("CLAUDE_API_KEY", "sk-test-claude-abcdef", {
    actor: "unit-test"
  });
  const rotation = vault.rotateMasterKey("master-key-2", {
    actor: "unit-test"
  });
  assert.equal(rotation.rotated_count, 1);
  assert.equal(Boolean(rotation.key_fingerprint), true);

  const reopened = new JsonFileSecretVault({
    filePath,
    auditLogPath: auditPath,
    masterKey: "master-key-2"
  });
  assert.equal(reopened.getSecret("CLAUDE_API_KEY"), "sk-test-claude-abcdef");

  const auditLines = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(auditLines.length >= 2, true);
  assert.equal(auditLines.some((line) => line.includes("SECRET_KEY_ROTATED")), true);
});

