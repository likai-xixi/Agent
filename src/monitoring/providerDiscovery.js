const { randomUUID } = require("crypto");

const { HealthAlarmStore } = require("./healthAlarmStore");

class ProviderDiscoveryService {
  constructor(options = {}) {
    this.providerRegistry = options.providerRegistry;
    this.alarmStore = options.alarmStore || new HealthAlarmStore();
    this.snapshots = [];
    this.maxSnapshots = Number.isInteger(options.maxSnapshots) ? options.maxSnapshots : 200;
    this.thresholds = {
      unhealthySeverity: "CRITICAL",
      degradedSeverity: "WARNING",
      minScore: 0.55,
      maxLatencyMs: 700,
      ...(options.thresholds || {})
    };
  }

  evaluateProviderHealth(providerHealth) {
    const alerts = [];
    if (providerHealth.healthy === false) {
      alerts.push({
        provider: providerHealth.provider,
        severity: this.thresholds.unhealthySeverity,
        reason: "PROVIDER_UNHEALTHY",
        message: `Provider ${providerHealth.provider} reported unhealthy status`
      });
      return alerts;
    }

    const score = Number(providerHealth.score || 0);
    if (score < this.thresholds.minScore) {
      alerts.push({
        provider: providerHealth.provider,
        severity: this.thresholds.degradedSeverity,
        reason: "PROVIDER_SCORE_LOW",
        message: `Provider ${providerHealth.provider} score ${score} below threshold ${this.thresholds.minScore}`
      });
    }

    const latency = Number(providerHealth.latency_ms || 0);
    if (latency > this.thresholds.maxLatencyMs) {
      alerts.push({
        provider: providerHealth.provider,
        severity: this.thresholds.degradedSeverity,
        reason: "PROVIDER_LATENCY_HIGH",
        message: `Provider ${providerHealth.provider} latency ${latency}ms exceeds threshold ${this.thresholds.maxLatencyMs}ms`
      });
    }

    return alerts;
  }

  async runDiscovery({
    actor = "system",
    source = "scheduler"
  } = {}) {
    const providers = await this.providerRegistry.getEnabledProviderHealth();
    const snapshot = {
      discovery_id: randomUUID(),
      created_at: new Date().toISOString(),
      actor,
      source,
      providers
    };
    this.snapshots.unshift(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(0, this.maxSnapshots);
    }

    const createdAlerts = [];
    for (const providerHealth of providers) {
      const alerts = this.evaluateProviderHealth(providerHealth);
      for (const alertData of alerts) {
        const alert = this.alarmStore.createAlert({
          ...alertData,
          snapshot: {
            discovery_id: snapshot.discovery_id,
            created_at: snapshot.created_at
          }
        });
        createdAlerts.push(alert);
      }
    }

    return {
      snapshot: { ...snapshot },
      alerts_created: createdAlerts
    };
  }

  getLatestSnapshot() {
    return this.snapshots.length > 0 ? { ...this.snapshots[0] } : null;
  }

  listSnapshots(limit = 20) {
    return this.snapshots.slice(0, limit).map((item) => ({ ...item }));
  }

  listAlerts(status = "") {
    return this.alarmStore.listAlerts({ status });
  }

  acknowledgeAlert({
    alert_id,
    actor,
    note
  }) {
    return this.alarmStore.acknowledgeAlert({
      alert_id,
      actor,
      note
    });
  }
}

module.exports = {
  ProviderDiscoveryService
};

