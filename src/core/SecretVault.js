// [FILE]: src/core/SecretVault.js
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { ValidationError, nowUtcIso } = require("../platform/contracts");
const { LocalExecutor, TASK_TYPES } = require("./LocalExecutor");

const CURRENT_VAULT_VERSION = 1;
const DEFAULT_KDF_CONFIG = Object.freeze({
  algorithm: "pbkdf2-sha512",
  digest: "sha512",
  iterations: 210000,
  key_length: 32,
  salt_bytes: 32
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

class SecretVault {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), "data", "core-secret-vault.json");
    this.masterKey = String(options.masterKey || process.env.CORE_SECRET_MASTER_KEY || "").trim();
    this.hardwareProfiler = options.hardwareProfiler || null;
    this.workerFactory = options.workerFactory || null;
    this.localExecutor = options.localExecutor || new LocalExecutor({
      hardwareProfiler: this.hardwareProfiler || undefined,
      workerFactory: this.workerFactory || undefined,
      prioritySetter: options.prioritySetter,
      priorityGetter: options.priorityGetter,
      gpuUsageProvider: options.gpuUsageProvider,
      ollamaController: options.ollamaController
    });
    this.profile = null;
  }

  buildSchedulingHint() {
    const affinity = this.hardwareProfiler && typeof this.hardwareProfiler.getCoreAffinity === "function"
      ? this.hardwareProfiler.getCoreAffinity()
      : {
          strategy: "UNIFORM",
          preferred_background_core_ids: []
        };
    return {
      strategy: affinity.strategy || "UNIFORM",
      preferred_core_ids: Array.isArray(affinity.preferred_background_core_ids) ? affinity.preferred_background_core_ids : [],
      worker_lane: "E_CORE_BACKGROUND"
    };
  }

  createEmptyStore() {
    return {
      version: CURRENT_VAULT_VERSION,
      algorithm: "aes-256-gcm",
      updated_at: nowUtcIso(),
      entries: {}
    };
  }

  loadStore() {
    if (!fs.existsSync(this.filePath)) {
      return this.createEmptyStore();
    }
    const store = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (!store || typeof store !== "object" || Array.isArray(store)) {
      throw new ValidationError("SecretVault file is invalid");
    }
    if (!store.entries || typeof store.entries !== "object" || Array.isArray(store.entries)) {
      throw new ValidationError("SecretVault entries payload is invalid");
    }
    if (Number(store.version || 0) !== CURRENT_VAULT_VERSION) {
      throw new ValidationError(`Unsupported SecretVault version: ${store.version}`);
    }
    return store;
  }

  saveStore(store) {
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  initialize() {
    if (!this.masterKey) {
      throw new ValidationError("CORE_SECRET_MASTER_KEY is required for SecretVault initialization");
    }
    const store = this.loadStore();
    this.profile = {
      initialized_at: nowUtcIso(),
      file_path: this.filePath,
      entry_count: Object.keys(store.entries).length,
      scheduling_hint: this.buildSchedulingHint()
    };
    return clone(this.profile);
  }

  runCryptoWorker(operation, payload) {
    const workerFile = path.join(__dirname, "secretVaultWorker.js");
    const schedulingHint = this.buildSchedulingHint();
    return this.localExecutor.executeWorkerTask({
      taskType: TASK_TYPES.CRYPTO,
      workerFile,
      workerData: {
        operation,
        payload: {
          ...payload,
          scheduling_hint: schedulingHint,
          background_priority_requested: true
        }
      },
      timeoutMs: 30000,
      name: `secret-vault-${operation}`,
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16
      }
    }).then((message) => {
      if (!message || message.ok !== true) {
        throw new ValidationError(message && message.error && message.error.message
          ? message.error.message
          : "SecretVault worker failed");
      }
      return message.result;
    });
  }

  async upsertSecret(name, secretValue, options = {}) {
    const normalizedName = String(name || "").trim();
    const value = String(secretValue || "");
    if (!normalizedName) {
      throw new ValidationError("secret name is required");
    }
    if (!value) {
      throw new ValidationError("secret value is required");
    }
    if (!this.masterKey) {
      throw new ValidationError("CORE_SECRET_MASTER_KEY is required for SecretVault writes");
    }

    const store = this.loadStore();
    const existing = store.entries[normalizedName] || {};
    const result = await this.runCryptoWorker("encrypt", {
      name: normalizedName,
      plaintext: value,
      master_key: this.masterKey,
      kdf: createKdfConfig()
    });

    store.entries[normalizedName] = {
      ...result.encrypted,
      name: normalizedName,
      created_at: existing.created_at || nowUtcIso(),
      updated_at: nowUtcIso(),
      metadata: options.metadata && typeof options.metadata === "object" ? options.metadata : {}
    };
    store.updated_at = nowUtcIso();
    this.saveStore(store);

    return {
      name: normalizedName,
      masked_value: maskSecretValue(value),
      updated_at: store.entries[normalizedName].updated_at,
      worker_metadata: result.encrypted.worker_metadata
    };
  }

  async getSecret(name) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      throw new ValidationError("secret name is required");
    }
    const store = this.loadStore();
    const entry = store.entries[normalizedName];
    if (!entry) {
      return "";
    }
    const result = await this.runCryptoWorker("decrypt", {
      name: normalizedName,
      entry,
      master_key: this.masterKey
    });
    return result.plaintext;
  }

  async listSecretsMasked() {
    const store = this.loadStore();
    const entries = [];
    for (const [name] of Object.entries(store.entries)) {
      const plaintext = await this.getSecret(name);
      entries.push({
        name,
        masked_value: maskSecretValue(plaintext),
        updated_at: store.entries[name].updated_at || ""
      });
    }
    return entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  async rotateMasterKey(newMasterKey) {
    const targetKey = String(newMasterKey || "").trim();
    if (!targetKey) {
      throw new ValidationError("new master key is required");
    }
    const store = this.loadStore();
    const rotatedEntries = {};

    for (const [name, entry] of Object.entries(store.entries)) {
      const plaintext = await this.runCryptoWorker("decrypt", {
        name,
        entry,
        master_key: this.masterKey
      });
      const encrypted = await this.runCryptoWorker("encrypt", {
        name,
        plaintext: plaintext.plaintext,
        master_key: targetKey,
        kdf: createKdfConfig()
      });
      rotatedEntries[name] = {
        ...encrypted.encrypted,
        name,
        created_at: entry.created_at || nowUtcIso(),
        updated_at: nowUtcIso(),
        metadata: entry.metadata || {}
      };
    }

    store.entries = rotatedEntries;
    store.updated_at = nowUtcIso();
    this.saveStore(store);
    this.masterKey = targetKey;

    return {
      rotated_count: Object.keys(rotatedEntries).length,
      scheduling_hint: this.buildSchedulingHint()
    };
  }
}

module.exports = {
  CURRENT_VAULT_VERSION,
  DEFAULT_KDF_CONFIG,
  SecretVault,
  createKdfConfig,
  maskSecretValue
};
