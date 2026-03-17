const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { ValidationError, nowUtcIso } = require("./contracts");

const BACKUP_MAGIC = Buffer.from("DSB1", "utf8");
const BACKUP_VERSION = 1;
const BACKUP_KDF = Object.freeze({
  iterations: 210000,
  keyLength: 32,
  digest: "sha512",
  saltBytes: 32,
  ivBytes: 12
});

function deriveBackupKey(masterKey, salt) {
  const normalized = String(masterKey || "");
  if (!normalized) {
    throw new ValidationError("backup master key is required");
  }
  return crypto.pbkdf2Sync(
    normalized,
    salt,
    BACKUP_KDF.iterations,
    BACKUP_KDF.keyLength,
    BACKUP_KDF.digest
  );
}

function encryptBackupPayload(contentBuffer, masterKey, metadata = {}) {
  const plaintext = Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer || "");
  const salt = crypto.randomBytes(BACKUP_KDF.saltBytes);
  const iv = crypto.randomBytes(BACKUP_KDF.ivBytes);
  const key = deriveBackupKey(masterKey, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const metadataJson = Buffer.from(JSON.stringify({
    ...metadata,
    encrypted_at: nowUtcIso()
  }), "utf8");
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  const header = Buffer.alloc(12);
  header.writeUInt8(BACKUP_VERSION, 0);
  header.writeUInt8(salt.length, 1);
  header.writeUInt8(iv.length, 2);
  header.writeUInt8(authTag.length, 3);
  header.writeUInt32BE(metadataJson.length, 4);
  header.writeUInt32BE(ciphertext.length, 8);
  return Buffer.concat([
    BACKUP_MAGIC,
    header,
    salt,
    iv,
    authTag,
    metadataJson,
    ciphertext
  ]);
}

function decryptBackupPayload(payloadBuffer, masterKey) {
  const packaged = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer || "");
  const magic = packaged.subarray(0, 4).toString("utf8");
  if (magic !== BACKUP_MAGIC.toString("utf8")) {
    throw new ValidationError("invalid digital soul backup header");
  }
  const version = packaged.readUInt8(4);
  if (version !== BACKUP_VERSION) {
    throw new ValidationError(`unsupported digital soul backup version: ${version}`);
  }
  const saltLength = packaged.readUInt8(5);
  const ivLength = packaged.readUInt8(6);
  const tagLength = packaged.readUInt8(7);
  const metadataLength = packaged.readUInt32BE(8);
  const ciphertextLength = packaged.readUInt32BE(12);
  let offset = 16;
  const salt = packaged.subarray(offset, offset + saltLength);
  offset += saltLength;
  const iv = packaged.subarray(offset, offset + ivLength);
  offset += ivLength;
  const authTag = packaged.subarray(offset, offset + tagLength);
  offset += tagLength;
  const metadataBuffer = packaged.subarray(offset, offset + metadataLength);
  offset += metadataLength;
  const ciphertext = packaged.subarray(offset, offset + ciphertextLength);
  const key = deriveBackupKey(masterKey, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  return {
    metadata: JSON.parse(metadataBuffer.toString("utf8")),
    content: plaintext
  };
}

function writeEncryptedBackup({ sourcePath, targetFile, masterKey }) {
  const absoluteSource = path.resolve(String(sourcePath || ""));
  if (!fs.existsSync(absoluteSource)) {
    throw new ValidationError(`backup source does not exist: ${absoluteSource}`);
  }
  const content = fs.readFileSync(absoluteSource);
  const payload = encryptBackupPayload(content, masterKey, {
    source_path: absoluteSource,
    source_basename: path.basename(absoluteSource),
    source_sha256: crypto.createHash("sha256").update(content).digest("hex"),
    source_size_bytes: content.length
  });
  fs.writeFileSync(targetFile, payload);
  return {
    target_file: targetFile,
    source_path: absoluteSource,
    encrypted_size_bytes: payload.length
  };
}

module.exports = {
  BACKUP_KDF,
  BACKUP_VERSION,
  decryptBackupPayload,
  deriveBackupKey,
  encryptBackupPayload,
  writeEncryptedBackup
};
