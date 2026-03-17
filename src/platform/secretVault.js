const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { ValidationError } = require("./contracts");
const { resolveDataPath } = require("./appPaths");

const DEFAULT_SECRET_VAULT_PATH = resolveDataPath("secret-vault.json");
const DEFAULT_SECRET_AUDIT_PATH = resolveDataPath("secret-vault-audit.jsonl");
const CURRENT_VAULT_VERSION = 3;
const LEGACY_VAULT_VERSION = 1;
const DEFAULT_KDF_CONFIG = Object.freeze({
  algorithm: "pbkdf2-sha512",
  digest: "sha512",
  iterations: 210000,
  key_length: 32,
  salt_bytes: 32
});

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createKdfConfig() {
  return {
    algorithm: DEFAULT_KDF_CONFIG.algorithm,
    digest: DEFAULT_KDF_CONFIG.digest,
    iterations: DEFAULT_KDF_CONFIG.iterations,
    key_length: DEFAULT_KDF_CONFIG.key_length,
    salt: crypto.randomBytes(DEFAULT_KDF_CONFIG.salt_bytes).toString("base64")
  };
}

function normalizeKdfConfig(raw = {}) {
  const salt = String(raw.salt || "").trim();
  const iterations = Number(raw.iterations);
  const keyLength = Number(raw.key_length);
  const digest = String(raw.digest || DEFAULT_KDF_CONFIG.digest).trim() || DEFAULT_KDF_CONFIG.digest;
  if (!salt) {
    throw new ValidationError("Secret vault KDF salt is missing");
  }
  if (!Number.isInteger(iterations) || iterations < 100000) {
    throw new ValidationError("Secret vault KDF iterations are invalid");
  }
  if (!Number.isInteger(keyLength) || keyLength < 32) {
    throw new ValidationError("Secret vault KDF key length is invalid");
  }
  return {
    algorithm: DEFAULT_KDF_CONFIG.algorithm,
    digest,
    iterations,
    key_length: keyLength,
    salt
  };
}

function deriveEncryptionKey(masterKey, kdfConfig) {
  const normalizedKdf = normalizeKdfConfig(kdfConfig);
  return crypto.pbkdf2Sync(
    String(masterKey),
    Buffer.from(normalizedKdf.salt, "base64"),
    normalizedKdf.iterations,
    normalizedKdf.key_length,
    normalizedKdf.digest
  );
}

function hashKeyFingerprint(masterKey, kdfConfig) {
  return crypto
    .createHash("sha256")
    .update(deriveEncryptionKey(masterKey, kdfConfig))
    .digest("hex");
}

function legacyDeriveEncryptionKey(masterKey) {
  return crypto.createHash("sha256").update(String(masterKey), "utf8").digest();
}

function maskSecretValue(secretValue) {
  const value = String(secretValue || "");
  if (!value) {
    return "";
  }
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function encryptSecret(secretValue, masterKey, kdfConfig) {
  const key = deriveEncryptionKey(masterKey, kdfConfig);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(secretValue), "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  const sealedPackage = Buffer.concat([authTag, ciphertext]).toString("base64");
  return {
    package: sealedPackage,
    iv: iv.toString("base64"),
    tag_length: authTag.length
  };
}

function decryptSecret(payload, masterKey, kdfConfig = null) {
  const key = kdfConfig
    ? deriveEncryptionKey(masterKey, kdfConfig)
    : legacyDeriveEncryptionKey(masterKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(payload.iv || ""), "base64"));
  let plaintext = "";
  if (payload.package) {
    const packaged = Buffer.from(String(payload.package || ""), "base64");
    const tagLength = Number(payload.tag_length || 16);
    const authTag = packaged.subarray(0, tagLength);
    const ciphertext = packaged.subarray(tagLength);
    decipher.setAuthTag(authTag);
    plaintext = decipher.update(ciphertext, undefined, "utf8");
  } else {
    decipher.setAuthTag(Buffer.from(String(payload.tag || ""), "base64"));
    plaintext = decipher.update(String(payload.ciphertext || ""), "base64", "utf8");
  }
  plaintext += decipher.final("utf8");
  return plaintext;
}

class JsonFileSecretVault {
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_SECRET_VAULT_PATH;
    this.auditLogPath = options.auditLogPath || DEFAULT_SECRET_AUDIT_PATH;
    this.masterKey = String(options.masterKey || process.env.SECRET_VAULT_MASTER_KEY || "");
    if (!this.masterKey) {
      throw new ValidationError("SECRET_VAULT_MASTER_KEY is required for vault access");
    }
  }

  createEmptyStore() {
    const kdf = createKdfConfig();
    return {
      version: CURRENT_VAULT_VERSION,
      kdf,
      key_fingerprint: hashKeyFingerprint(this.masterKey, kdf),
      updated_at: new Date().toISOString(),
      entries: {}
    };
  }

  maybeUpgradeLegacyStore(store) {
    const sourceKdf = store.kdf ? normalizeKdfConfig(store.kdf) : null;
    const needsPackageUpgrade = Object.values(store.entries || {}).some((entry) => !entry.package);
    if (store.version >= CURRENT_VAULT_VERSION && sourceKdf && !needsPackageUpgrade) {
      return store;
    }
    const upgraded = sourceKdf
      ? {
          version: CURRENT_VAULT_VERSION,
          kdf: sourceKdf,
          key_fingerprint: hashKeyFingerprint(this.masterKey, sourceKdf),
          updated_at: new Date().toISOString(),
          entries: {}
        }
      : this.createEmptyStore();
    for (const [name, entry] of Object.entries(store.entries || {})) {
      const plaintext = decryptSecret(entry, this.masterKey, sourceKdf);
      upgraded.entries[name] = {
        ...encryptSecret(plaintext, this.masterKey, upgraded.kdf),
        name,
        created_at: entry.created_at || new Date().toISOString(),
        updated_at: entry.updated_at || new Date().toISOString(),
        metadata: entry.metadata || {}
      };
    }
    upgraded.updated_at = new Date().toISOString();
    this.saveStore(upgraded);
    this.appendAudit("SECRET_VAULT_UPGRADED", {
      actor: "system",
      from_version: Number(store.version || LEGACY_VAULT_VERSION),
      to_version: CURRENT_VAULT_VERSION,
      secret_count: Object.keys(upgraded.entries).length
    });
    return upgraded;
  }

  loadStore() {
    if (!fs.existsSync(this.filePath)) {
      return this.createEmptyStore();
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Secret vault file is invalid");
    }
    if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
      raw.entries = {};
    }
    if (!raw.version || Number(raw.version) < CURRENT_VAULT_VERSION || !raw.kdf) {
      return this.maybeUpgradeLegacyStore({
        ...raw,
        version: Number(raw.version || LEGACY_VAULT_VERSION)
      });
    }
    raw.kdf = normalizeKdfConfig(raw.kdf);
    if (Object.values(raw.entries).some((entry) => !entry.package)) {
      return this.maybeUpgradeLegacyStore(raw);
    }
    raw.key_fingerprint = String(raw.key_fingerprint || hashKeyFingerprint(this.masterKey, raw.kdf));
    return raw;
  }

  saveStore(store) {
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  appendAudit(eventType, payload = {}) {
    ensureDir(this.auditLogPath);
    const event = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      payload
    };
    fs.appendFileSync(this.auditLogPath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  upsertSecret(name, secretValue, options = {}) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      throw new ValidationError("secret name is required");
    }
    const value = String(secretValue || "");
    if (!value) {
      throw new ValidationError("secret value is required");
    }
    const store = this.loadStore();
    const encrypted = encryptSecret(value, this.masterKey, store.kdf);
    const existing = store.entries[normalizedName] || {};
    store.entries[normalizedName] = {
      ...encrypted,
      name: normalizedName,
      created_at: existing.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: options.metadata && typeof options.metadata === "object" ? options.metadata : {}
    };
    store.version = CURRENT_VAULT_VERSION;
    store.key_fingerprint = hashKeyFingerprint(this.masterKey, store.kdf);
    store.updated_at = new Date().toISOString();
    this.saveStore(store);
    this.appendAudit("SECRET_UPSERTED", {
      name: normalizedName,
      actor: options.actor || "system"
    });
    return {
      name: normalizedName,
      masked_value: maskSecretValue(value),
      updated_at: store.entries[normalizedName].updated_at
    };
  }

  getSecret(name) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      throw new ValidationError("secret name is required");
    }
    const store = this.loadStore();
    const entry = store.entries[normalizedName];
    if (!entry) {
      return "";
    }
    return decryptSecret(entry, this.masterKey, store.kdf);
  }

  listSecretsMasked() {
    const store = this.loadStore();
    return Object.entries(store.entries)
      .map(([name, entry]) => {
        let plaintext = "";
        try {
          plaintext = decryptSecret(entry, this.masterKey, store.kdf);
        } catch {
          plaintext = "";
        }
        return {
          name,
          masked_value: plaintext ? maskSecretValue(plaintext) : "",
          updated_at: entry.updated_at || ""
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  rotateMasterKey(newMasterKey, options = {}) {
    const targetKey = String(newMasterKey || "").trim();
    if (!targetKey) {
      throw new ValidationError("new master key is required for rotation");
    }
    const store = this.loadStore();
    const rotatedKdf = createKdfConfig();
    const rotated = {};
    for (const [name, entry] of Object.entries(store.entries)) {
      const plaintext = decryptSecret(entry, this.masterKey, store.kdf);
      rotated[name] = {
        ...encryptSecret(plaintext, targetKey, rotatedKdf),
        name,
        created_at: entry.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: entry.metadata || {}
      };
    }
    store.version = CURRENT_VAULT_VERSION;
    store.kdf = rotatedKdf;
    store.entries = rotated;
    store.key_fingerprint = hashKeyFingerprint(targetKey, rotatedKdf);
    store.updated_at = new Date().toISOString();
    this.saveStore(store);
    this.appendAudit("SECRET_KEY_ROTATED", {
      actor: options.actor || "system",
      secret_count: Object.keys(rotated).length
    });
    this.masterKey = targetKey;
    return {
      rotated_count: Object.keys(rotated).length,
      key_fingerprint: store.key_fingerprint
    };
  }
}

module.exports = {
  CURRENT_VAULT_VERSION,
  DEFAULT_KDF_CONFIG,
  DEFAULT_SECRET_AUDIT_PATH,
  DEFAULT_SECRET_VAULT_PATH,
  JsonFileSecretVault,
  decryptSecret,
  deriveEncryptionKey,
  encryptSecret,
  hashKeyFingerprint,
  maskSecretValue
};
