const { randomUUID } = require("crypto");

class HealthAlarmStore {
  constructor() {
    this.alerts = new Map();
  }

  createAlert({
    provider,
    severity,
    reason,
    message,
    snapshot
  }) {
    const existing = this.findOpenAlert(provider, reason);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const alert = {
      alert_id: randomUUID(),
      provider,
      severity,
      reason,
      message,
      status: "OPEN",
      created_at: now,
      updated_at: now,
      snapshot,
      acked_by: "",
      acked_at: "",
      note: ""
    };
    this.alerts.set(alert.alert_id, alert);
    return { ...alert };
  }

  findOpenAlert(provider, reason) {
    for (const alert of this.alerts.values()) {
      if (alert.provider === provider && alert.reason === reason && alert.status === "OPEN") {
        return { ...alert };
      }
    }
    return null;
  }

  listAlerts({ status = "" } = {}) {
    const all = [...this.alerts.values()];
    const filtered = status ? all.filter((item) => item.status === status) : all;
    return filtered
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map((item) => ({ ...item }));
  }

  acknowledgeAlert({
    alert_id,
    actor = "operator",
    note = ""
  }) {
    const alert = this.alerts.get(alert_id);
    if (!alert) {
      return null;
    }
    const updated = {
      ...alert,
      status: "ACKED",
      updated_at: new Date().toISOString(),
      acked_by: actor,
      acked_at: new Date().toISOString(),
      note
    };
    this.alerts.set(alert_id, updated);
    return { ...updated };
  }
}

module.exports = {
  HealthAlarmStore
};

