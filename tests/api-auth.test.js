const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { createTaskApiServer } = require("../src/api/taskApiServer");
const { buildSignedJwt } = require("../src/api/auth");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");

function createServerWithAuth(authConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-api-auth-"));
  const filePath = path.join(dir, "events.jsonl");
  const eventStore = new JsonlAuditEventStore({ filePath });
  const orchestrator = new TaskOrchestrator({
    eventStore,
    flags: {
      fallback_engine_enabled: false,
      takeover_engine_enabled: false,
      discussion_engine_enabled: false,
      adaptive_routing_enabled: false,
      openai_adapter_enabled: false,
      gemini_adapter_enabled: false,
      claude_adapter_enabled: false,
      local_model_adapter_enabled: true
    },
    auditMaintenanceHistoryPath: path.join(dir, "audit-maintenance-history.jsonl")
  });
  return createTaskApiServer({
    orchestrator,
    host: "127.0.0.1",
    port: 0,
    authConfig
  });
}

async function requestJson(baseUrl, method, pathname, body, headers = {}) {
  const target = new URL(`${baseUrl}${pathname}`);
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers
      }
    });
    req.on("error", reject);
    req.on("response", (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString("utf8");
      });
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode || 500,
            payload: raw ? JSON.parse(raw) : {}
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

test("task API rejects unauthorized calls when auth is enabled", async () => {
  const app = createServerWithAuth({
    auth_enabled: true,
    static_tokens: [
      {
        token: "token-admin",
        subject: "ops-admin",
        roles: ["super_admin"]
      }
    ]
  });
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unauthorized = await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "auth-task-1",
      trace_id: "auth-trace-1",
      task_type: "auth-test"
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.payload.error, "AUTH_REQUIRED");

    const authorized = await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "auth-task-1",
      trace_id: "auth-trace-1",
      task_type: "auth-test"
    }, {
      Authorization: "Bearer token-admin"
    });
    assert.equal(authorized.status, 201);

    const events = app.orchestrator.getTaskHistory("auth-task-1");
    assert.equal(events.length > 0, true);
    assert.equal(events[0].actor, "ops-admin");
  } finally {
    await app.stop();
  }
});

test("task API accepts HS256 JWT and records identity actor", async () => {
  const jwtSecret = "jwt-secret-for-tests";
  const app = createServerWithAuth({
    auth_enabled: true,
    jwt_secret: jwtSecret,
    jwt_issuer: "multi-agent-orchestrator",
    jwt_audience: "task-api",
    static_tokens: []
  });
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = buildSignedJwt({
    sub: "jwt-admin",
    roles: ["super_admin"],
    iss: "multi-agent-orchestrator",
    aud: "task-api"
  }, jwtSecret, {
    expiresInSeconds: 300
  });

  try {
    const created = await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "jwt-task-1",
      trace_id: "jwt-trace-1",
      task_type: "auth-test"
    }, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(created.status, 201);

    const events = app.orchestrator.getTaskHistory("jwt-task-1");
    assert.equal(events.length > 0, true);
    assert.equal(events[0].actor, "jwt-admin");
    assert.deepEqual(events[0].payload.task_snapshot.metadata.request_identity.roles, ["super_admin"]);
  } finally {
    await app.stop();
  }
});

