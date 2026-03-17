const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { ValidationError } = require("./contracts");
const { resolveDataPath } = require("./appPaths");

const DEFAULT_SECRET_VAULT_PATH = resolveDataPath("secret-vault.json");
const DEFAULT_SECRET_AUDIT_PATH = resolveDataPath("secret-vault-audit.jsonl");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function hashKeyFingerprint(masterKey) {
  return crypto.createHash("sha256").update(String(masterKey), "utf8").digest("hex");
}

function deriveEncryptionKey(masterKey) {
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

function encryptSecret(secretValue, masterKey) {
  const key = deriveEncryptionKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let ciphertext = cipher.update(String(secretValue), "utf8", "base64");
  ciphertext += cipher.final("base64");
  const tag = cipher.getAuthTag().toString("base64");
  return {
    ciphertext,
    iv: iv.toString("base64"),
    tag
  };
}

function decryptSecret(payload, masterKey) {
  const key = deriveEncryptionKey(masterKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(payload.iv || ""), "base64"));
  decipher.setAuthTag(Buffer.from(String(payload.tag || ""), "base64"));
  let plaintext = decipher.update(String(payload.ciphertext || ""), "base64", "utf8");
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

  loadStore() {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 1,
        key_fingerprint: hashKeyFingerprint(this.masterKey),
        updated_at: new Date().toISOString(),
        entries: {}
      };
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("Secret vault file is invalid");
    }
    if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
      raw.entries = {};
    }
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
    const encrypted = encryptSecret(value, this.masterKey);
    const existing = store.entries[normalizedName] || {};
    store.entries[normalizedName] = {
      ...encrypted,
      name: normalizedName,
      created_at: existing.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: options.metadata && typeof options.metadata === "object" ? options.metadata : {}
    };
    store.key_fingerprint = hashKeyFingerprint(this.masterKey);
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
    return decryptSecret(entry, this.masterKey);
  }

  listSecretsMasked() {
    const store = this.loadStore();
    return Object.entries(store.entries)
      .map(([name, entry]) => {
        let plaintext = "";
        try {
          plaintext = decryptSecret(entry, this.masterKey);
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
    const rotated = {};
    for (const [name, entry] of Object.entries(store.entries)) {
      const plaintext = decryptSecret(entry, this.masterKey);
      rotated[name] = {
        ...encryptSecret(plaintext, targetKey),
        name,
        created_at: entry.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: entry.metadata || {}
      };
    }
    store.entries = rotated;
    store.key_fingerprint = hashKeyFingerprint(targetKey);
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
  DEFAULT_SECRET_AUDIT_PATH,
  DEFAULT_SECRET_VAULT_PATH,
  JsonFileSecretVault,
  decryptSecret,
  encryptSecret,
  maskSecretValue
};
