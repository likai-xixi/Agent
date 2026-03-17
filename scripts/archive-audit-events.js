#!/usr/bin/env node
const path = require("path");

const { FileWormAuditArchiveSink } = require("../src/orchestrator/auditArchiveSink");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");

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

function archiveAuditEvents(options = {}) {
  const source = options.source || path.join("data", "audit-events.jsonl");
  const archiveDir = options.archiveDir || path.join("data", "audit-archive");
  const actor = options.actor || "operator";

  const store = new JsonlAuditEventStore({
    filePath: source
  });
  const sink = new FileWormAuditArchiveSink({
    archiveDir
  });
  const events = store.getAllEvents();
  if (events.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      source,
      archive_dir: archiveDir,
      events_count: 0,
      archived: false,
      reason: "NO_EVENTS"
    };
  }

  const manifest = sink.appendBatch({
    events,
    source,
    actor
  });
  const verification = sink.verifyArchive(manifest.archive_id);
  return {
    timestamp: new Date().toISOString(),
    source,
    archive_dir: archiveDir,
    events_count: events.length,
    archived: true,
    manifest,
    verification,
    success: verification.valid === true
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = archiveAuditEvents({
    source: args.source,
    archiveDir: args["archive-dir"],
    actor: args.actor
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (result.success === false) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  archiveAuditEvents,
  parseArgs
};
