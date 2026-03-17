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

class InMemoryImNotifier {
  constructor(options = {}) {
    this.channel = options.channel || "im-stub";
    this.notifications = [];
  }

  async sendTakeoverRequired(payload) {
    const notification = {
      notification_id: randomUUID(),
      channel: this.channel,
      status: "SENT",
      payload,
      sent_at: new Date().toISOString()
    };
    this.notifications.push(notification);
    return notification;
  }

  async sendAuthorizationRequired(payload) {
    const notification = {
      notification_id: randomUUID(),
      channel: this.channel,
      status: "SENT",
      payload,
      sent_at: new Date().toISOString()
    };
    this.notifications.push(notification);
    return notification;
  }

  async sendStatusUpdate(payload) {
    const notification = {
      notification_id: randomUUID(),
      channel: this.channel,
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

function createTakeoverLines(payload = {}) {
  return [
    `task_id: ${payload.task_id || "UNKNOWN"}`,
    `trace_id: ${payload.trace_id || "UNKNOWN"}`,
    `reason: ${payload.reason || "MANUAL_INTERVENTION_REQUIRED"}`,
    `actions: ${Array.isArray(payload.actions) ? payload.actions.join(", ") : ""}`
  ];
}

function createAuthorizationLines(payload = {}) {
  const resource = payload.resource && typeof payload.resource === "object"
    ? JSON.stringify(payload.resource)
    : String(payload.resource || "UNKNOWN");
  return [
    `request_id: ${payload.request_id || "UNKNOWN"}`,
    `trace_id: ${payload.trace_id || "UNKNOWN"}`,
    `task_id: ${payload.task_id || "UNKNOWN"}`,
    `request_type: ${payload.request_type || "AUTHORIZATION"}`,
    `resource: ${resource}`,
    `grant_modes: ${Array.isArray(payload.options && payload.options.grant_modes) ? payload.options.grant_modes.join(", ") : ""}`
  ];
}

function createStatusLines(payload = {}) {
  return [
    `trace_id: ${payload.trace_id || "UNKNOWN"}`,
    `task_id: ${payload.task_id || "UNKNOWN"}`,
    `status: ${payload.status || "UNKNOWN"}`,
    `summary: ${payload.summary || ""}`
  ];
}

class WebhookImNotifier {
  constructor(options = {}) {
    this.adapter = normalizeWebhookAdapter(options.adapter, WEBHOOK_ADAPTERS.DINGTALK);
    this.channel = options.channel || `${this.adapter}-webhook`;
    this.url = options.url || "";
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
  }

  async sendTakeoverRequired(payload = {}) {
    const now = new Date().toISOString();
    const notificationId = randomUUID();
    const base = {
      notification_id: notificationId,
      channel: this.channel,
      status: "SENT",
      payload,
      sent_at: now
    };
    if (!this.url) {
      const skipped = {
        ...base,
        status: "SKIPPED",
        error_message: "WEBHOOK_URL_NOT_CONFIGURED"
      };
      this.notifications.push(skipped);
      return skipped;
    }

    const title = `[Takeover Required] ${payload.task_id || "UNKNOWN"}`;
    const webhookPayload = buildMarkdownWebhookPayload({
      adapter: this.adapter,
      title,
      lines: createTakeoverLines(payload)
    });
    try {
      const response = await this.dispatcher({
        url: this.url,
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

  async sendAuthorizationRequired(payload = {}) {
    return this.sendStructuredMessage({
      payload,
      title: `[Authorization Required] ${payload.request_type || "AUTHORIZATION"}`,
      lines: createAuthorizationLines(payload)
    });
  }

  async sendStatusUpdate(payload = {}) {
    return this.sendStructuredMessage({
      payload,
      title: `[Agent Status] ${payload.status || "UNKNOWN"}`,
      lines: createStatusLines(payload)
    });
  }

  async sendStructuredMessage({ payload, title, lines }) {
    const now = new Date().toISOString();
    const notificationId = randomUUID();
    const base = {
      notification_id: notificationId,
      channel: this.channel,
      status: "SENT",
      payload,
      sent_at: now
    };
    if (!this.url) {
      const skipped = {
        ...base,
        status: "SKIPPED",
        error_message: "WEBHOOK_URL_NOT_CONFIGURED"
      };
      this.notifications.push(skipped);
      return skipped;
    }
    const webhookPayload = buildMarkdownWebhookPayload({
      adapter: this.adapter,
      title,
      lines
    });
    try {
      const response = await this.dispatcher({
        url: this.url,
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

function createImNotifierFromEnv(options = {}) {
  const env = options.env || process.env;
  const url = options.url || env.TAKEOVER_WEBHOOK_URL || "";
  if (!url) {
    return new InMemoryImNotifier(options);
  }
  return new WebhookImNotifier({
    adapter: options.adapter || env.TAKEOVER_WEBHOOK_ADAPTER || WEBHOOK_ADAPTERS.DINGTALK,
    channel: options.channel || env.TAKEOVER_WEBHOOK_CHANNEL || "",
    url,
    signatureSecret: options.signatureSecret || env.TAKEOVER_WEBHOOK_SECRET || "",
    signatureHeader: options.signatureHeader || env.TAKEOVER_WEBHOOK_SIGNATURE_HEADER || "x-webhook-signature",
    signatureAlgorithm: options.signatureAlgorithm || env.TAKEOVER_WEBHOOK_SIGNATURE_ALGO || "sha256",
    signaturePrefix: options.signaturePrefix || env.TAKEOVER_WEBHOOK_SIGNATURE_PREFIX || "sha256=",
    timeoutMs: options.timeoutMs || env.TAKEOVER_WEBHOOK_TIMEOUT_MS || 5000,
    retries: options.retries || env.TAKEOVER_WEBHOOK_RETRIES || 2,
    backoffMs: options.backoffMs || env.TAKEOVER_WEBHOOK_BACKOFF_MS || 200,
    headers: options.headers || {},
    dispatcher: options.dispatcher
  });
}

module.exports = {
  InMemoryImNotifier,
  WebhookImNotifier,
  createImNotifierFromEnv
};
