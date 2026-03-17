const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  CURRENT_VAULT_VERSION,
  JsonFileSecretVault
} = require("../src/platform/secretVault");

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
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, CURRENT_VAULT_VERSION);
  assert.equal(parsed.kdf.algorithm, "pbkdf2-sha512");
  assert.equal(parsed.kdf.iterations >= 210000, true);
  assert.equal(Boolean(parsed.kdf.salt), true);
  assert.equal(Boolean(parsed.entries.OPENAI_API_KEY.package), true);
  assert.equal(typeof parsed.entries.OPENAI_API_KEY.tag, "undefined");

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

test("JsonFileSecretVault upgrades legacy sha256-derived vaults to PBKDF2", () => {
  const { filePath, auditPath } = createVaultForTest();
  const legacyKey = crypto.createHash("sha256").update("master-key-1", "utf8").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
  let ciphertext = cipher.update("sk-legacy-value-123", "utf8", "base64");
  ciphertext += cipher.final("base64");
  const tag = cipher.getAuthTag().toString("base64");

  fs.writeFileSync(filePath, `${JSON.stringify({
    version: 1,
    key_fingerprint: crypto.createHash("sha256").update("master-key-1", "utf8").digest("hex"),
    updated_at: new Date().toISOString(),
    entries: {
      OPENAI_API_KEY: {
        name: "OPENAI_API_KEY",
        ciphertext,
        iv: iv.toString("base64"),
        tag,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {}
      }
    }
  }, null, 2)}\n`, "utf8");

  const reopened = new JsonFileSecretVault({
    filePath,
    auditLogPath: auditPath,
    masterKey: "master-key-1"
  });
  assert.equal(reopened.getSecret("OPENAI_API_KEY"), "sk-legacy-value-123");

  const upgraded = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(upgraded.version, CURRENT_VAULT_VERSION);
  assert.equal(Boolean(upgraded.kdf && upgraded.kdf.salt), true);
  assert.equal(Boolean(upgraded.entries.OPENAI_API_KEY.package), true);

  const auditLines = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(auditLines.some((line) => line.includes("SECRET_VAULT_UPGRADED")), true);
});

test("JsonFileSecretVault upgrades version 2 payloads to package-header format", () => {
  const { filePath, auditPath } = createVaultForTest();
  const vault = new JsonFileSecretVault({
    filePath,
    auditLogPath: auditPath,
    masterKey: "master-key-1"
  });
  const kdf = {
    algorithm: "pbkdf2-sha512",
    digest: "sha512",
    iterations: 210000,
    key_length: 32,
    salt: crypto.randomBytes(32).toString("base64")
  };
  const key = crypto.pbkdf2Sync("master-key-1", Buffer.from(kdf.salt, "base64"), kdf.iterations, kdf.key_length, kdf.digest);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let ciphertext = cipher.update("upgradable-secret", "utf8", "base64");
  ciphertext += cipher.final("base64");
  const tag = cipher.getAuthTag().toString("base64");

  fs.writeFileSync(filePath, `${JSON.stringify({
    version: 2,
    kdf,
    key_fingerprint: "legacy-v2",
    updated_at: new Date().toISOString(),
    entries: {
      OPENAI_API_KEY: {
        name: "OPENAI_API_KEY",
        ciphertext,
        iv: iv.toString("base64"),
        tag,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {}
      }
    }
  }, null, 2)}\n`, "utf8");

  assert.equal(vault.getSecret("OPENAI_API_KEY"), "upgradable-secret");
  const upgraded = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(upgraded.version, CURRENT_VAULT_VERSION);
  assert.equal(Boolean(upgraded.entries.OPENAI_API_KEY.package), true);
  assert.equal(Boolean(upgraded.entries.OPENAI_API_KEY.tag), false);
});
