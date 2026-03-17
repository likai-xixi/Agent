const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const WEBHOOK_ADAPTERS = Object.freeze({
  DINGTALK: "dingtalk",
  WECOM: "wecom"
});

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(statusCode) {
  const code = Number(statusCode || 0);
  if (!Number.isFinite(code) || code <= 0) {
    return true;
  }
  return code === 429 || code >= 500;
}

function normalizeWebhookUrl(url) {
  const parsed = new URL(String(url));
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported webhook protocol: ${parsed.protocol}`);
  }
  return parsed;
}

function buildSignature(payloadText, secret, algorithm = "sha256", prefix = "sha256=") {
  if (!secret) {
    return "";
  }
  const digest = crypto
    .createHmac(algorithm, String(secret))
    .update(payloadText, "utf8")
    .digest("hex");
  return `${prefix}${digest}`;
}

function isSupportedWebhookAdapter(adapter) {
  return Object.values(WEBHOOK_ADAPTERS).includes(adapter);
}

function normalizeWebhookAdapter(adapter, fallback = WEBHOOK_ADAPTERS.DINGTALK) {
  const normalized = String(adapter || "").trim().toLowerCase();
  if (isSupportedWebhookAdapter(normalized)) {
    return normalized;
  }
  const fallbackNormalized = String(fallback || "").trim().toLowerCase();
  if (isSupportedWebhookAdapter(fallbackNormalized)) {
    return fallbackNormalized;
  }
  throw new Error(`Unsupported webhook adapter: ${adapter}`);
}

function normalizeMarkdownLines(lines = []) {
  const source = Array.isArray(lines) ? lines : [lines];
  return source
    .map((line) => String(line || "").trim())
    .filter(Boolean);
}

function buildMarkdownWebhookPayload({
  adapter = WEBHOOK_ADAPTERS.DINGTALK,
  title = "Notification",
  lines = []
} = {}) {
  const normalizedAdapter = normalizeWebhookAdapter(adapter);
  const normalizedTitle = String(title || "").trim() || "Notification";
  const normalizedLines = normalizeMarkdownLines(lines);
  const textBody = normalizedLines.join("\n");

  if (normalizedAdapter === WEBHOOK_ADAPTERS.WECOM) {
    const content = [`### ${normalizedTitle}`]
      .concat(textBody ? ["", textBody] : [])
      .join("\n");
    return {
      msgtype: "markdown",
      markdown: {
        content
      }
    };
  }

  const text = [normalizedTitle]
    .concat(textBody ? ["", textBody] : [])
    .join("\n");
  return {
    msgtype: "markdown",
    markdown: {
      title: normalizedTitle,
      text
    }
  };
}

function sendOnce({
  url,
  payloadText,
  headers = {},
  timeoutMs = 5000
}) {
  return new Promise((resolve, reject) => {
    const parsed = normalizeWebhookUrl(url);
    const client = parsed.protocol === "https:" ? https : http;

    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payloadText),
        ...headers
      }
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString("utf8");
      });
      res.on("end", () => {
        resolve({
          status_code: res.statusCode || 0,
          response_body: raw
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("WEBHOOK_TIMEOUT"));
    });
    req.on("error", reject);
    req.write(payloadText);
    req.end();
  });
}

async function dispatchWebhook({
  url,
  payload,
  headers = {},
  timeoutMs = 5000,
  retries = 2,
  backoffMs = 200,
  signatureSecret = "",
  signatureHeader = "x-webhook-signature",
  signatureAlgorithm = "sha256",
  signaturePrefix = "sha256="
}) {
  if (!url) {
    throw new Error("webhook url is required");
  }
  const payloadText = JSON.stringify(payload);
  const signature = buildSignature(payloadText, signatureSecret, signatureAlgorithm, signaturePrefix);
  const effectiveHeaders = {
    ...headers
  };
  if (signature) {
    effectiveHeaders[signatureHeader] = signature;
  }

  const maxAttempts = Math.max(1, Number.parseInt(String(retries), 10) + 1);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await sendOnce({
        url,
        payloadText,
        headers: effectiveHeaders,
        timeoutMs
      });
      if (response.status_code >= 200 && response.status_code < 300) {
        return {
          ok: true,
          attempts: attempt,
          ...response
        };
      }
      if (attempt < maxAttempts && isRetryableStatus(response.status_code)) {
        await sleep(backoffMs * (2 ** (attempt - 1)));
        continue;
      }
      return {
        ok: false,
        attempts: attempt,
        ...response
      };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(backoffMs * (2 ** (attempt - 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("WEBHOOK_DISPATCH_FAILED");
}

module.exports = {
  WEBHOOK_ADAPTERS,
  buildMarkdownWebhookPayload,
  buildSignature,
  dispatchWebhook,
  isRetryableStatus,
  normalizeWebhookAdapter,
  normalizeWebhookUrl,
  sleep
};
