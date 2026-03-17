const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const {
  WEBHOOK_ADAPTERS,
  buildMarkdownWebhookPayload,
  dispatchWebhook
} = require("../src/integrations/webhookClient");

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start test server"));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/webhook`
      });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

test("buildMarkdownWebhookPayload builds DingTalk markdown payload", () => {
  const payload = buildMarkdownWebhookPayload({
    adapter: WEBHOOK_ADAPTERS.DINGTALK,
    title: "Takeover",
    lines: ["task_id: t-1", "reason: ALL_PROVIDERS_FAILED"]
  });
  assert.equal(payload.msgtype, "markdown");
  assert.equal(payload.markdown.title, "Takeover");
  assert.equal(payload.markdown.text.includes("task_id: t-1"), true);
});

test("buildMarkdownWebhookPayload builds WeCom markdown payload", () => {
  const payload = buildMarkdownWebhookPayload({
    adapter: WEBHOOK_ADAPTERS.WECOM,
    title: "Ops Alert",
    lines: ["severity: CRITICAL"]
  });
  assert.equal(payload.msgtype, "markdown");
  assert.equal(payload.markdown.content.includes("### Ops Alert"), true);
  assert.equal(payload.markdown.content.includes("severity: CRITICAL"), true);
});

test("dispatchWebhook retries and sends signature header", async () => {
  let attempts = 0;
  let capturedSignature = "";
  const { server, url } = await startServer((req, res) => {
    attempts += 1;
    capturedSignature = String(req.headers["x-signature"] || "");
    if (attempts < 2) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "retry" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });

  try {
    const result = await dispatchWebhook({
      url,
      payload: { hello: "world" },
      retries: 2,
      backoffMs: 10,
      signatureSecret: "secret-1",
      signatureHeader: "x-signature"
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
    assert.equal(capturedSignature.startsWith("sha256="), true);
  } finally {
    await stopServer(server);
  }
});

