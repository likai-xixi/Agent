#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const { FileWormAuditArchiveSink } = require("../src/orchestrator/auditArchiveSink");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function daysBetween(now, timestamp) {
  const then = new Date(timestamp).getTime();
  const current = now.getTime();
  if (!Number.isFinite(then)) {
    return Number.POSITIVE_INFINITY;
  }
  return (current - then) / (1000 * 60 * 60 * 24);
}

function evaluateAuditRetention(options = {}) {
  const archiveDir = options.archiveDir || path.join("data", "audit-archive");
  const maxAgeDays = toInt(options.maxAgeDays, 30);
  const maxArchives = toInt(options.maxArchives, 500);
  const minArchives = toInt(options.minArchives, 0);
  const writePath = options.writePath || "";

  const sink = new FileWormAuditArchiveSink({
    archiveDir
  });
  const manifests = sink.listManifests();
  const now = new Date();
  const integrityFailures = [];
  const staleArchives = [];

  for (const manifest of manifests) {
    const verification = sink.verifyArchive(manifest.archive_id);
    if (!verification.valid) {
      integrityFailures.push({
        archive_id: manifest.archive_id,
        reason: verification.reason
      });
    }
    const ageDays = daysBetween(now, manifest.created_at);
    if (ageDays > maxAgeDays) {
      staleArchives.push({
        archive_id: manifest.archive_id,
        age_days: Number(ageDays.toFixed(2))
      });
    }
  }

  const archiveCount = manifests.length;
  const countTooLow = archiveCount < minArchives;
  const countTooHigh = archiveCount > maxArchives;
  const hasIntegrityFailure = integrityFailures.length > 0;
  const hasStaleArchives = staleArchives.length > 0;

  const reasons = [];
  if (countTooLow) {
    reasons.push("ARCHIVE_COUNT_BELOW_MIN");
  }
  if (countTooHigh) {
    reasons.push("ARCHIVE_COUNT_ABOVE_MAX");
  }
  if (hasIntegrityFailure) {
    reasons.push("INTEGRITY_FAILURE");
  }
  if (hasStaleArchives) {
    reasons.push("STALE_ARCHIVES_FOUND");
  }
  if (reasons.length === 0) {
    reasons.push(archiveCount === 0 ? "NO_ARCHIVES" : "OK");
  }

  const result = {
    timestamp: now.toISOString(),
    archive_dir: archiveDir,
    policy: {
      min_archives: minArchives,
      max_archives: maxArchives,
      max_age_days: maxAgeDays
    },
    archive_count: archiveCount,
    integrity_failures: integrityFailures,
    stale_archives: staleArchives,
    success: reasons.length === 1 && (reasons[0] === "OK" || reasons[0] === "NO_ARCHIVES"),
    reasons
  };

  if (writePath) {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const result = evaluateAuditRetention({
    archiveDir: args["archive-dir"],
    maxAgeDays: args["max-age-days"],
    maxArchives: args["max-archives"],
    minArchives: args["min-archives"],
    writePath: args.write
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  daysBetween,
  evaluateAuditRetention,
  parseArgs,
  toInt
};
