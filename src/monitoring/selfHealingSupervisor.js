const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { ensureDir, resolveDataPath } = require("../platform/appPaths");
const { nowUtcIso, ValidationError } = require("../platform/contracts");
const { writeEncryptedBackup } = require("../platform/digitalSoulBackup");

class SelfHealingSupervisor {
  constructor(options = {}) {
    this.staleAfterMs = Number(options.staleAfterMs || 30000);
    this.handoffSnapshotStore = options.handoffSnapshotStore || null;
    this.backupRoot = options.backupRoot || resolveDataPath("backups");
    this.backupMasterKey = String(options.backupMasterKey || process.env.DIGITAL_SOUL_MASTER_KEY || process.env.BACKUP_MASTER_KEY || "");
    this.watchers = new Map();
  }

  register(targetId, handler, metadata = {}) {
    this.watchers.set(targetId, {
      target_id: targetId,
      handler,
      metadata,
      last_beat_at: Date.now()
    });
  }

  beat(targetId, metadata = {}) {
    const current = this.watchers.get(targetId) || {
      target_id: targetId,
      handler: null,
      metadata: {},
      last_beat_at: Date.now()
    };
    current.last_beat_at = Date.now();
    current.metadata = {
      ...current.metadata,
      ...metadata
    };
    this.watchers.set(targetId, current);
    return current;
  }

  sweep() {
    const results = [];
    for (const [targetId, watcher] of this.watchers.entries()) {
      const stale = Date.now() - watcher.last_beat_at > this.staleAfterMs;
      if (!stale) {
        continue;
      }
      let recovered = false;
      let errorMessage = "";
      try {
        if (typeof watcher.handler === "function") {
          watcher.handler({
            target_id: targetId,
            metadata: watcher.metadata
          });
          recovered = true;
        }
      } catch (err) {
        errorMessage = err && err.message ? err.message : "SELF_HEAL_FAILED";
      }
      if (this.handoffSnapshotStore) {
        this.handoffSnapshotStore.capture({
          snapshot_id: randomUUID(),
          trace_id: watcher.metadata.trace_id || "",
          task_id: watcher.metadata.task_id || targetId,
          task_type: watcher.metadata.task_type || "self-heal",
          state: "STALE",
          reason: recovered ? "SELF_HEAL_TRIGGERED" : "SELF_HEAL_FAILED",
          progress_summary: recovered
            ? `Recovered stale target ${targetId}.`
            : `Failed to recover stale target ${targetId}: ${errorMessage}`,
          variables: watcher.metadata,
          created_at: nowUtcIso()
        });
      }
      results.push({
        target_id: targetId,
        recovered,
        error_message: errorMessage
      });
      this.watchers.delete(targetId);
    }
    return results;
  }

  backupFiles(filePaths = []) {
    if (!this.backupMasterKey) {
      throw new ValidationError("DIGITAL_SOUL_MASTER_KEY or BACKUP_MASTER_KEY is required for encrypted backups");
    }
    const timestamp = nowUtcIso().replace(/[:]/g, "-");
    const targetDir = path.join(this.backupRoot, timestamp);
    ensureDir(targetDir);
    const copied = [];
    for (const filePath of filePaths) {
      if (!filePath || !fs.existsSync(filePath)) {
        continue;
      }
      const targetFile = path.join(targetDir, `${path.basename(filePath)}.enc`);
      writeEncryptedBackup({
        sourcePath: filePath,
        targetFile,
        masterKey: this.backupMasterKey
      });
      copied.push(targetFile);
    }
    return {
      target_dir: targetDir,
      copied,
      encrypted: true
    };
  }
}

module.exports = {
  SelfHealingSupervisor
};
