const {
  DEFAULT_ESCALATION_POLICY,
  InMemoryAlertSuppressionStore,
  JsonFileAlertSuppressionStore,
  buildAlertFingerprint,
  getProfileForSeverity,
  loadEscalationPolicy,
  markAlertSent,
  resolveSeverity,
  shouldSuppressAlert
} = require("./alertEscalationPolicy");
const {
  InMemoryAuditMaintenanceHistoryStore,
  JsonlAuditMaintenanceHistoryStore
} = require("./auditMaintenanceHistoryStore");
const { HealthAlarmStore } = require("./healthAlarmStore");
const { InMemoryOpsNotifier, WebhookOpsNotifier, createOpsNotifierFromEnv } = require("./opsNotifier");
const { ProviderDiscoveryService } = require("./providerDiscovery");

module.exports = {
  DEFAULT_ESCALATION_POLICY,
  InMemoryAlertSuppressionStore,
  InMemoryAuditMaintenanceHistoryStore,
  JsonFileAlertSuppressionStore,
  JsonlAuditMaintenanceHistoryStore,
  buildAlertFingerprint,
  getProfileForSeverity,
  HealthAlarmStore,
  InMemoryOpsNotifier,
  WebhookOpsNotifier,
  createOpsNotifierFromEnv,
  loadEscalationPolicy,
  markAlertSent,
  ProviderDiscoveryService,
  resolveSeverity,
  shouldSuppressAlert
};
