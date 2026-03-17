const fs = require("fs");
const path = require("path");

const SEVERITIES = Object.freeze({
  WARNING: "WARNING",
  CRITICAL: "CRITICAL"
});

const DEFAULT_ESCALATION_POLICY = Object.freeze({
  default_severity: SEVERITIES.WARNING,
  profiles: {
    WARNING: {
      channel: "ops-warning",
      dedupe_window_seconds: 600
    },
    CRITICAL: {
      channel: "ops-critical",
      dedupe_window_seconds: 120
    }
  },
  reason_severity: {
    INTEGRITY_FAILURE: SEVERITIES.CRITICAL,
    ARCHIVE_HASH_MISMATCH: SEVERITIES.CRITICAL,
    ARCHIVE_FILE_NOT_FOUND: SEVERITIES.CRITICAL,
    ARCHIVE_COUNT_ABOVE_MAX: SEVERITIES.WARNING,
    ARCHIVE_COUNT_BELOW_MIN: SEVERITIES.WARNING,
    STALE_ARCHIVES_FOUND: SEVERITIES.WARNING,
    RETENTION_FAILURE: SEVERITIES.WARNING,
    UNKNOWN_FAILURE: SEVERITIES.WARNING
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeSeverity(value, fallback = SEVERITIES.WARNING) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === SEVERITIES.CRITICAL) {
    return SEVERITIES.CRITICAL;
  }
  if (normalized === SEVERITIES.WARNING) {
    return SEVERITIES.WARNING;
  }
  return fallback;
}

function mergeEscalationPolicy(base, override = {}) {
  const merged = clone(base);
  if (override.default_severity) {
    merged.default_severity = normalizeSeverity(override.default_severity, merged.default_severity);
  }
  if (override.profiles && typeof override.profiles === "object") {
    for (const [severity, profile] of Object.entries(override.profiles)) {
      const normalizedSeverity = normalizeSeverity(severity, "");
      if (!normalizedSeverity) {
        continue;
      }
      const current = merged.profiles[normalizedSeverity] || {};
      merged.profiles[normalizedSeverity] = {
        channel: profile && profile.channel ? String(profile.channel) : current.channel || "ops-warning",
        dedupe_window_seconds: toInt(
          profile && profile.dedupe_window_seconds,
          toInt(current.dedupe_window_seconds, 0)
        )
      };
    }
  }
  if (override.reason_severity && typeof override.reason_severity === "object") {
    for (const [reason, severity] of Object.entries(override.reason_severity)) {
      merged.reason_severity[String(reason)] = normalizeSeverity(severity, merged.default_severity);
    }
  }
  return merged;
}

function loadEscalationPolicy(policyPath = path.join("config", "alert_escalation_policy.json")) {
  let override = {};
  if (fs.existsSync(policyPath)) {
    try {
      const raw = fs.readFileSync(policyPath, "utf8");
      override = JSON.parse(raw);
    } catch {
      override = {};
    }
  }
  return mergeEscalationPolicy(DEFAULT_ESCALATION_POLICY, override);
}

function resolveSeverity(reasons = [], policy = DEFAULT_ESCALATION_POLICY) {
  const normalizedReasons = Array.isArray(reasons)
    ? reasons.map((reason) => String(reason))
    : [];
  let severity = normalizeSeverity(policy.default_severity, SEVERITIES.WARNING);
  for (const reason of normalizedReasons) {
    const candidate = normalizeSeverity(
      (policy.reason_severity || {})[reason],
      severity
    );
    if (candidate === SEVERITIES.CRITICAL) {
      return SEVERITIES.CRITICAL;
    }
    severity = candidate;
  }
  return severity;
}

function getProfileForSeverity(policy, severity) {
  const normalized = normalizeSeverity(severity, normalizeSeverity(policy.default_severity, SEVERITIES.WARNING));
  const profile = (policy.profiles || {})[normalized] || {};
  return {
    severity: normalized,
    channel: profile.channel || "ops-warning",
    dedupe_window_seconds: toInt(profile.dedupe_window_seconds, 0)
  };
}

function buildAlertFingerprint({
  type = "ALERT",
  scope = "",
  reasons = [],
  severity = ""
} = {}) {
  const normalizedReasons = Array.isArray(reasons)
    ? [...reasons].map((reason) => String(reason)).sort()
    : [];
  return [
    String(type),
    String(scope),
    normalizeSeverity(severity, SEVERITIES.WARNING),
    normalizedReasons.join("|")
  ].join("::");
}

class InMemoryAlertSuppressionStore {
  constructor() {
    this.items = new Map();
  }

  get(fingerprint) {
    const value = this.items.get(fingerprint);
    return value ? clone(value) : null;
  }

  set(fingerprint, payload) {
    this.items.set(fingerprint, clone(payload));
    return clone(payload);
  }

  clear() {
    this.items.clear();
  }
}

class JsonFileAlertSuppressionStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join("data", "alert-suppression-window.json");
    this.ensurePath();
  }

  ensurePath() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "{}\n", "utf8");
    }
  }

  readAll() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8").trim();
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  }

  writeAll(value) {
    fs.writeFileSync(this.filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  get(fingerprint) {
    const all = this.readAll();
    return all[fingerprint] ? clone(all[fingerprint]) : null;
  }

  set(fingerprint, payload) {
    const all = this.readAll();
    all[fingerprint] = clone(payload);
    this.writeAll(all);
    return clone(payload);
  }
}

function shouldSuppressAlert({
  now = new Date(),
  fingerprint,
  profile,
  suppressionStore
}) {
  if (!suppressionStore || typeof suppressionStore.get !== "function") {
    return false;
  }
  const dedupeWindowSeconds = toInt(profile && profile.dedupe_window_seconds, 0);
  if (dedupeWindowSeconds <= 0) {
    return false;
  }
  const previous = suppressionStore.get(fingerprint);
  if (!previous || !previous.last_sent_at) {
    return false;
  }
  const lastSentAt = new Date(previous.last_sent_at).getTime();
  const current = now.getTime();
  if (!Number.isFinite(lastSentAt) || !Number.isFinite(current)) {
    return false;
  }
  return (current - lastSentAt) < dedupeWindowSeconds * 1000;
}

function markAlertSent({
  now = new Date(),
  fingerprint,
  profile,
  suppressionStore
}) {
  if (!suppressionStore || typeof suppressionStore.set !== "function") {
    return null;
  }
  return suppressionStore.set(fingerprint, {
    last_sent_at: now.toISOString(),
    dedupe_window_seconds: toInt(profile && profile.dedupe_window_seconds, 0),
    channel: profile && profile.channel ? profile.channel : "ops-warning",
    severity: profile && profile.severity ? profile.severity : SEVERITIES.WARNING
  });
}

module.exports = {
  DEFAULT_ESCALATION_POLICY,
  InMemoryAlertSuppressionStore,
  JsonFileAlertSuppressionStore,
  SEVERITIES,
  buildAlertFingerprint,
  getProfileForSeverity,
  loadEscalationPolicy,
  markAlertSent,
  mergeEscalationPolicy,
  normalizeSeverity,
  resolveSeverity,
  shouldSuppressAlert
};

