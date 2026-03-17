const { randomUUID } = require("crypto");
const {
  WEBHOOK_ADAPTERS,
  buildMarkdownWebhookPayload,
  dispatchWebhook,
  normalizeWebhookAdapter
} = require("../integrations/webhookClient");

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

class InMemoryOpsNotifier {
  constructor(options = {}) {
    this.channel = options.channel || "ops-im-stub";
    this.notifications = [];
  }

  async sendOperationalAlert(payload, options = {}) {
    const channel = options.channel || this.channel;
    const severity = options.severity || payload.severity || "WARNING";
    const notification = {
      notification_id: randomUUID(),
      channel,
      severity,
      status: "SENT",
      payload,
      sent_at: new Date().toISOString()
    };
    this.notifications.push(notification);
    return notification;
  }

  getAllNotifications() {
    return [...this.notifications];
  }
}

function createOperationalLines(payload = {}, severity = "WARNING", channel = "") {
  const reasons = Array.isArray(payload.reasons) && payload.reasons.length > 0
    ? payload.reasons.join(", ")
    : "UNKNOWN";
  return [
    `type: ${payload.type || "OPERATIONAL_ALERT"}`,
    `severity: ${severity}`,
    `channel: ${channel || payload.channel || "ops-webhook"}`,
    `archive_dir: ${payload.archive_dir || "UNKNOWN"}`,
    `reasons: ${reasons}`,
    `source: ${payload.source || "ops"}`
  ];
}

class WebhookOpsNotifier {
  constructor(options = {}) {
    this.adapter = normalizeWebhookAdapter(options.adapter, WEBHOOK_ADAPTERS.DINGTALK);
    this.channel = options.channel || `${this.adapter}-ops-webhook`;
    this.signatureSecret = options.signatureSecret || "";
    this.signatureHeader = options.signatureHeader || "x-webhook-signature";
    this.signatureAlgorithm = options.signatureAlgorithm || "sha256";
    this.signaturePrefix = options.signaturePrefix || "sha256=";
    this.timeoutMs = toPositiveInt(options.timeoutMs, 5000);
    this.retries = toPositiveInt(options.retries, 2);
    this.backoffMs = toPositiveInt(options.backoffMs, 200);
    this.headers = options.headers || {};
    this.dispatcher = options.dispatcher || dispatchWebhook;
    this.notifications = [];
    this.urlByChannel = {};
    if (options.url) {
      this.urlByChannel[this.channel] = options.url;
    }
    if (options.defaultUrl) {
      this.urlByChannel.default = options.defaultUrl;
    }
    if (options.urlByChannel && typeof options.urlByChannel === "object") {
      Object.assign(this.urlByChannel, options.urlByChannel);
    }
  }

  resolveWebhookUrl(channel) {
    return this.urlByChannel[channel] || this.urlByChannel.default || "";
  }

  async sendOperationalAlert(payload = {}, options = {}) {
    const channel = options.channel || this.channel;
    const severity = options.severity || payload.severity || "WARNING";
    const now = new Date().toISOString();
    const notificationId = randomUUID();
    const base = {
      notification_id: notificationId,
      channel,
      severity,
      status: "SENT",
      payload,
      sent_at: now
    };
    const url = this.resolveWebhookUrl(channel);
    if (!url) {
      const skipped = {
        ...base,
        status: "SKIPPED",
        error_message: "WEBHOOK_URL_NOT_CONFIGURED"
      };
      this.notifications.push(skipped);
      return skipped;
    }

    const title = `[Ops Alert] ${severity}`;
    const webhookPayload = buildMarkdownWebhookPayload({
      adapter: this.adapter,
      title,
      lines: createOperationalLines(payload, severity, channel)
    });
    try {
      const response = await this.dispatcher({
        url,
        payload: webhookPayload,
        headers: this.headers,
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        backoffMs: this.backoffMs,
        signatureSecret: this.signatureSecret,
        signatureHeader: this.signatureHeader,
        signatureAlgorithm: this.signatureAlgorithm,
        signaturePrefix: this.signaturePrefix
      });
      const notification = {
        ...base,
        status: response.ok ? "SENT" : "FAILED",
        attempts: response.attempts,
        status_code: response.status_code,
        response_body: response.response_body
      };
      this.notifications.push(notification);
      return notification;
    } catch (err) {
      const failed = {
        ...base,
        status: "FAILED",
        error_message: err && err.message ? err.message : "WEBHOOK_DISPATCH_FAILED"
      };
      this.notifications.push(failed);
      return failed;
    }
  }

  getAllNotifications() {
    return [...this.notifications];
  }
}

function createOpsNotifierFromEnv(options = {}) {
  const env = options.env || process.env;
  const defaultUrl = options.defaultUrl || env.OPS_WEBHOOK_URL || "";
  const warningUrl = options.warningUrl || env.OPS_WARNING_WEBHOOK_URL || "";
  const criticalUrl = options.criticalUrl || env.OPS_CRITICAL_WEBHOOK_URL || "";
  const channel = options.channel || env.OPS_WEBHOOK_CHANNEL || "ops-warning";
  const channelMap = {
    default: defaultUrl || warningUrl || criticalUrl || "",
    "ops-warning": warningUrl || defaultUrl || "",
    "ops-critical": criticalUrl || defaultUrl || ""
  };

  const hasAnyUrl = Object.values(channelMap).some((item) => Boolean(item));
  if (!hasAnyUrl) {
    return new InMemoryOpsNotifier(options);
  }
  return new WebhookOpsNotifier({
    adapter: options.adapter || env.OPS_WEBHOOK_ADAPTER || WEBHOOK_ADAPTERS.DINGTALK,
    channel,
    defaultUrl: channelMap.default,
    urlByChannel: {
      "ops-warning": channelMap["ops-warning"],
      "ops-critical": channelMap["ops-critical"]
    },
    signatureSecret: options.signatureSecret || env.OPS_WEBHOOK_SECRET || "",
    signatureHeader: options.signatureHeader || env.OPS_WEBHOOK_SIGNATURE_HEADER || "x-webhook-signature",
    signatureAlgorithm: options.signatureAlgorithm || env.OPS_WEBHOOK_SIGNATURE_ALGO || "sha256",
    signaturePrefix: options.signaturePrefix || env.OPS_WEBHOOK_SIGNATURE_PREFIX || "sha256=",
    timeoutMs: options.timeoutMs || env.OPS_WEBHOOK_TIMEOUT_MS || 5000,
    retries: options.retries || env.OPS_WEBHOOK_RETRIES || 2,
    backoffMs: options.backoffMs || env.OPS_WEBHOOK_BACKOFF_MS || 200,
    headers: options.headers || {},
    dispatcher: options.dispatcher
  });
}

module.exports = {
  InMemoryOpsNotifier,
  WebhookOpsNotifier,
  createOpsNotifierFromEnv
};
