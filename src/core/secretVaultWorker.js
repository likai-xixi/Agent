// [FILE]: src/core/secretVaultWorker.js
const crypto = require("crypto");
const { parentPort, threadId, workerData } = require("worker_threads");

function normalizeKdfConfig(raw = {}) {
  const iterations = Number(raw.iterations);
  const keyLength = Number(raw.key_length);
  const digest = String(raw.digest || "sha512").trim() || "sha512";
  const salt = String(raw.salt || "").trim();

  if (!salt) {
    throw new Error("SecretVault worker requires a PBKDF2 salt");
  }
  if (!Number.isInteger(iterations) || iterations < 100000) {
    throw new Error("SecretVault worker requires PBKDF2 iterations >= 100000");
  }
  if (!Number.isInteger(keyLength) || keyLength < 32) {
    throw new Error("SecretVault worker requires a 256-bit key length");
  }

  return {
    algorithm: "pbkdf2-sha512",
    digest,
    iterations,
    key_length: keyLength,
    salt
  };
}

function deriveKey(masterKey, kdfConfig) {
  const normalizedKdf = normalizeKdfConfig(kdfConfig);
  return crypto.pbkdf2Sync(
    String(masterKey || ""),
    Buffer.from(normalizedKdf.salt, "base64"),
    normalizedKdf.iterations,
    normalizedKdf.key_length,
    normalizedKdf.digest
  );
}

function hashKeyFingerprint(masterKey, kdfConfig) {
  return crypto.createHash("sha256").update(deriveKey(masterKey, kdfConfig)).digest("hex");
}

function encryptInWorker(payload = {}) {
  const name = String(payload.name || "").trim();
  const plaintext = String(payload.plaintext || "");
  const key = deriveKey(payload.master_key, payload.kdf);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: {
      name,
      kdf: normalizeKdfConfig(payload.kdf),
      package: Buffer.concat([authTag, ciphertext]).toString("base64"),
      iv: iv.toString("base64"),
      tag_length: authTag.length,
      algorithm: "aes-256-gcm",
      key_fingerprint: hashKeyFingerprint(payload.master_key, payload.kdf),
      worker_metadata: {
        thread_id: threadId,
        scheduling_hint: payload.scheduling_hint || {},
        background_priority_requested: payload.background_priority_requested === true,
        execution_policy: workerData.execution_policy || {},
        node_assignment: workerData.node_assignment || "MASTER"
      }
    }
  };
}

function decryptInWorker(payload = {}) {
  const name = String(payload.name || "").trim();
  const entry = payload.entry || {};
  const key = deriveKey(payload.master_key, entry.kdf);
  const packaged = Buffer.from(String(entry.package || ""), "base64");
  const tagLength = Number(entry.tag_length || 16);
  const authTag = packaged.subarray(0, tagLength);
  const ciphertext = packaged.subarray(tagLength);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(entry.iv || ""), "base64"));
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");

  return {
    plaintext,
    worker_metadata: {
      thread_id: threadId,
      scheduling_hint: payload.scheduling_hint || {},
      background_priority_requested: payload.background_priority_requested === true,
      execution_policy: workerData.execution_policy || {},
      node_assignment: workerData.node_assignment || "MASTER"
    }
  };
}

function main() {
  try {
    const operation = String(workerData.operation || "").trim();
    let result;
    if (operation === "encrypt") {
      result = encryptInWorker(workerData.payload || {});
    } else if (operation === "decrypt") {
      result = decryptInWorker(workerData.payload || {});
    } else {
      throw new Error(`Unknown SecretVault worker operation: ${operation}`);
    }
    parentPort.postMessage({
      ok: true,
      result
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        name: error && error.name ? error.name : "Error",
        message: error && error.message ? error.message : "SecretVault worker failed"
      }
    });
  }
}

main();
