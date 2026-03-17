const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  InMemoryAlertSuppressionStore,
  JsonFileAlertSuppressionStore,
  SEVERITIES,
  buildAlertFingerprint,
  getProfileForSeverity,
  loadEscalationPolicy,
  markAlertSent,
  resolveSeverity,
  shouldSuppressAlert
} = require("../src/monitoring/alertEscalationPolicy");

test("loadEscalationPolicy resolves severity and profile mapping", () => {
  const policy = loadEscalationPolicy();
  const warning = resolveSeverity(["ARCHIVE_COUNT_ABOVE_MAX"], policy);
  const critical = resolveSeverity(["INTEGRITY_FAILURE"], policy);
  assert.equal(warning, SEVERITIES.WARNING);
  assert.equal(critical, SEVERITIES.CRITICAL);

  const profile = getProfileForSeverity(policy, critical);
  assert.equal(profile.channel, "ops-critical");
  assert.equal(profile.dedupe_window_seconds > 0, true);
});

test("suppression stores dedupe repeated alerts within window", () => {
  const store = new InMemoryAlertSuppressionStore();
  const policy = loadEscalationPolicy();
  const profile = getProfileForSeverity(policy, SEVERITIES.WARNING);
  const fingerprint = buildAlertFingerprint({
    type: "AUDIT_RETENTION_FAILURE",
    scope: "data/audit-archive",
    reasons: ["ARCHIVE_COUNT_ABOVE_MAX"],
    severity: SEVERITIES.WARNING
  });
  const now = new Date();

  const before = shouldSuppressAlert({
    now,
    fingerprint,
    profile,
    suppressionStore: store
  });
  assert.equal(before, false);

  markAlertSent({
    now,
    fingerprint,
    profile,
    suppressionStore: store
  });
  const after = shouldSuppressAlert({
    now: new Date(now.getTime() + 1000),
    fingerprint,
    profile,
    suppressionStore: store
  });
  assert.equal(after, true);
});

test("JsonFileAlertSuppressionStore persists suppression state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "suppression-store-"));
  const filePath = path.join(tempDir, "suppression.json");
  const store = new JsonFileAlertSuppressionStore({ filePath });
  const fingerprint = "fp-1";
  store.set(fingerprint, {
    last_sent_at: "2026-01-01T00:00:00Z",
    dedupe_window_seconds: 120,
    channel: "ops-warning",
    severity: "WARNING"
  });

  const loaded = new JsonFileAlertSuppressionStore({ filePath });
  const item = loaded.get(fingerprint);
  assert.equal(Boolean(item), true);
  assert.equal(item.channel, "ops-warning");
});

