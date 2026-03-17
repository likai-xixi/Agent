const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function hashText(input) {
  return crypto.createHash("sha256").update(String(input), "utf8").digest("hex");
}

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class FileWormAuditArchiveSink {
  constructor(options = {}) {
    this.archiveDir = options.archiveDir || path.join("data", "audit-archive");
    this.manifestPath = options.manifestPath || path.join(this.archiveDir, "manifest.jsonl");
    this.ensurePaths();
  }

  ensurePaths() {
    fs.mkdirSync(this.archiveDir, { recursive: true });
    if (!fs.existsSync(this.manifestPath)) {
      fs.writeFileSync(this.manifestPath, "", "utf8");
    }
  }

  appendBatch({
    events,
    source = "audit-event-store",
    actor = "system"
  }) {
    if (!Array.isArray(events) || events.length === 0) {
      return null;
    }
    const now = new Date().toISOString();
    const suffix = crypto.randomBytes(4).toString("hex");
    const archiveId = `ARCHIVE-${now.replace(/[-:TZ.]/g, "")}-${suffix}`;
    const archiveFile = `${archiveId}.jsonl`;
    const archivePath = path.join(this.archiveDir, archiveFile);
    const body = `${events.map((item) => JSON.stringify(item)).join("\n")}\n`;
    fs.writeFileSync(archivePath, body, {
      encoding: "utf8",
      flag: "wx"
    });

    const manifest = {
      archive_id: archiveId,
      archive_file: archiveFile,
      events_count: events.length,
      payload_hash: hashText(body),
      source,
      actor,
      created_at: now
    };
    fs.appendFileSync(this.manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    return manifest;
  }

  listManifests() {
    return parseJsonl(this.manifestPath);
  }

  verifyArchive(identifier) {
    const manifests = this.listManifests();
    const manifest = manifests.find((item) => item.archive_id === identifier || item.archive_file === identifier);
    if (!manifest) {
      return {
        valid: false,
        reason: "MANIFEST_NOT_FOUND",
        archive_id: identifier
      };
    }

    const archivePath = path.join(this.archiveDir, manifest.archive_file);
    if (!fs.existsSync(archivePath)) {
      return {
        valid: false,
        reason: "ARCHIVE_FILE_NOT_FOUND",
        archive_id: manifest.archive_id
      };
    }

    const body = fs.readFileSync(archivePath, "utf8");
    const actualHash = hashText(body);
    if (actualHash !== manifest.payload_hash) {
      return {
        valid: false,
        reason: "ARCHIVE_HASH_MISMATCH",
        archive_id: manifest.archive_id,
        expected_hash: manifest.payload_hash,
        actual_hash: actualHash
      };
    }

    return {
      valid: true,
      reason: "OK",
      archive_id: manifest.archive_id,
      expected_hash: manifest.payload_hash,
      actual_hash: actualHash
    };
  }
}

module.exports = {
  FileWormAuditArchiveSink,
  hashText,
  parseJsonl
};
