#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const {
  JsonFileAlertSuppressionStore,
  buildAlertFingerprint,
  getProfileForSeverity,
  loadEscalationPolicy,
  markAlertSent,
  resolveSeverity,
  shouldSuppressAlert
} = require("../src/monitoring/alertEscalationPolicy");
const { JsonlAuditMaintenanceHistoryStore } = require("../src/monitoring/auditMaintenanceHistoryStore");
const { createOpsNotifierFromEnv } = require("../src/monitoring/opsNotifier");
const { archiveAuditEvents } = require("./archive-audit-events");
const { evaluateAuditRetention } = require("./audit-retention-check");

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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendJsonl(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function runAuditMaintenanceCycle(options = {}, dependencies = {}) {
  const source = options.source || path.join("data", "audit-events.jsonl");
  const archiveDir = options.archiveDir || path.join("data", "audit-archive");
  const actor = options.actor || "ops-scheduler";
  const sourceLabel = options.sourceLabel || "audit-maintenance";
  const maxAgeDays = toInt(options.maxAgeDays, 30);
  const maxArchives = toInt(options.maxArchives, 500);
  const minArchives = toInt(options.minArchives, 0);
  const retentionWritePath = options.retentionWritePath || "";
  const alertLogPath = options.alertLogPath || "";
  const escalationPolicyPath = options.escalationPolicyPath || path.join("config", "alert_escalation_policy.json");
  const suppressionStorePath = options.suppressionStorePath || path.join("data", "alert-suppression-window.json");

  const archiveRunner = dependencies.archiveRunner || archiveAuditEvents;
  const retentionRunner = dependencies.retentionRunner || evaluateAuditRetention;
  const notifier = dependencies.notifier || createOpsNotifierFromEnv({
    channel: options.alertChannel || "ops-warning",
    adapter: options.alertWebhookAdapter || "",
    defaultUrl: options.alertWebhookUrl || "",
    warningUrl: options.alertWarningWebhookUrl || "",
    criticalUrl: options.alertCriticalWebhookUrl || "",
    signatureSecret: options.alertWebhookSecret || "",
    signatureHeader: options.alertWebhookSignatureHeader || "",
    retries: options.alertWebhookRetries || "",
    backoffMs: options.alertWebhookBackoffMs || "",
    timeoutMs: options.alertWebhookTimeoutMs || ""
  });
  const escalationPolicy = dependencies.escalationPolicy || loadEscalationPolicy(escalationPolicyPath);
  const suppressionStore = dependencies.suppressionStore || new JsonFileAlertSuppressionStore({
    filePath: suppressionStorePath
  });

  const now = new Date();
  const startedAt = now.toISOString();
  const archiveResult = await Promise.resolve(archiveRunner({
    source,
    archiveDir,
    actor
  }));
  const retentionResult = await Promise.resolve(retentionRunner({
    archiveDir,
    maxAgeDays,
    maxArchives,
    minArchives,
    writePath: retentionWritePath
  }));

  let notification = null;
  let escalation = null;
  if (!retentionResult.success && notifier && typeof notifier.sendOperationalAlert === "function") {
    const reasons = retentionResult.reasons || [];
    const severity = resolveSeverity(reasons, escalationPolicy);
    const profile = getProfileForSeverity(escalationPolicy, severity);
    const fingerprint = buildAlertFingerprint({
      type: "AUDIT_RETENTION_FAILURE",
      scope: archiveDir,
      reasons,
      severity
    });
    const suppressed = shouldSuppressAlert({
      now,
      fingerprint,
      profile,
      suppressionStore
    });
    escalation = {
      severity,
      channel: profile.channel,
      dedupe_window_seconds: profile.dedupe_window_seconds,
      fingerprint,
      suppressed
    };

    const payload = {
      type: "AUDIT_RETENTION_FAILURE",
      actor,
      source: sourceLabel,
      severity,
      channel: profile.channel,
      archive_dir: archiveDir,
      reasons,
      policy: retentionResult.policy || {},
      archive_count: retentionResult.archive_count
    };

    if (suppressed) {
      notification = {
        notification_id: "",
        channel: profile.channel,
        severity,
        status: "SUPPRESSED",
        payload,
        sent_at: now.toISOString()
      };
    } else {
      notification = await notifier.sendOperationalAlert(payload, {
        channel: profile.channel,
        severity
      });
      markAlertSent({
        now,
        fingerprint,
        profile,
        suppressionStore
      });
    }
    if (alertLogPath) {
      appendJsonl(alertLogPath, notification);
    }
  }
  if (alertLogPath && !fs.existsSync(alertLogPath)) {
    fs.mkdirSync(path.dirname(alertLogPath), { recursive: true });
    fs.writeFileSync(alertLogPath, "", "utf8");
  }

  const archiveOk = archiveResult.success !== false;
  return {
    timestamp: new Date().toISOString(),
    started_at: startedAt,
    source,
    archive_dir: archiveDir,
    actor,
    archive: archiveResult,
    retention: retentionResult,
    escalation,
    notification,
    success: archiveOk && retentionResult.success === true
  };
}

async function runAuditMaintenanceScheduler(options = {}, dependencies = {}) {
  const iterations = Math.max(1, toInt(options.iterations, 1));
  const intervalSeconds = Math.max(0, toInt(options.intervalSeconds, 0));
  const intervalMs = intervalSeconds * 1000;
  const runs = [];
  const historyPath = options.historyPath || path.join("data", "audit-maintenance-history.jsonl");
  const startedAt = new Date().toISOString();
  const historyStore = dependencies.historyStore || new JsonlAuditMaintenanceHistoryStore({
    filePath: historyPath
  });

  for (let idx = 0; idx < iterations; idx += 1) {
    const run = await runAuditMaintenanceCycle(options, dependencies);
    runs.push(run);
    if (idx < iterations - 1 && intervalMs > 0) {
      await wait(intervalMs);
    }
  }

  const result = {
    timestamp: new Date().toISOString(),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    interval_seconds: intervalSeconds,
    iterations_requested: iterations,
    runs,
    success: runs.every((item) => item.success === true)
  };
  const historyEntry = historyStore && typeof historyStore.appendRun === "function"
    ? historyStore.appendRun(result)
    : null;
  return {
    ...result,
    history_entry: historyEntry
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runAuditMaintenanceScheduler({
    source: args.source,
    archiveDir: args["archive-dir"],
    actor: args.actor,
    sourceLabel: args["source-label"],
    maxAgeDays: args["max-age-days"],
    maxArchives: args["max-archives"],
    minArchives: args["min-archives"],
    escalationPolicyPath: args["escalation-policy"],
    suppressionStorePath: args["suppression-store"],
    intervalSeconds: args["interval-seconds"],
    iterations: args.iterations,
    historyPath: args["history-path"],
    retentionWritePath: args["retention-write"],
    alertLogPath: args["alert-log"],
    alertChannel: args["alert-channel"],
    alertWebhookAdapter: args["alert-webhook-adapter"],
    alertWebhookUrl: args["alert-webhook-url"],
    alertWarningWebhookUrl: args["alert-warning-webhook-url"],
    alertCriticalWebhookUrl: args["alert-critical-webhook-url"],
    alertWebhookSecret: args["alert-webhook-secret"],
    alertWebhookSignatureHeader: args["alert-webhook-signature-header"],
    alertWebhookRetries: args["alert-webhook-retries"],
    alertWebhookBackoffMs: args["alert-webhook-backoff-ms"],
    alertWebhookTimeoutMs: args["alert-webhook-timeout-ms"]
  });
  const writePath = args.write || "";
  if (writePath) {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  appendJsonl,
  parseArgs,
  runAuditMaintenanceCycle,
  runAuditMaintenanceScheduler,
  toInt,
  wait
};
