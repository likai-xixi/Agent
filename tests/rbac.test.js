const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { createTaskApiServer } = require("../src/api/taskApiServer");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");
const { RBAC_ROLES, authorizeRequest } = require("../src/api/rbac");

function createServerWithRbac(authConfig, rbacConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-api-rbac-"));
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
    authConfig,
    rbacConfig
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

test("authorizeRequest enforces route-level role policy", () => {
  const allowedRead = authorizeRequest({
    method: "GET",
    pathname: "/audit/events",
    identity: {
      roles: [RBAC_ROLES.READ_ONLY_AUDITOR]
    },
    config: {
      rbac_enabled: true
    }
  });
  assert.equal(allowedRead.allowed, true);

  const deniedWrite = authorizeRequest({
    method: "POST",
    pathname: "/tasks",
    identity: {
      roles: [RBAC_ROLES.READ_ONLY_AUDITOR]
    },
    config: {
      rbac_enabled: true
    }
  });
  assert.equal(deniedWrite.allowed, false);
  assert.equal(deniedWrite.reason, "ROLE_FORBIDDEN");
});

test("authorizeRequest denies when identity is missing", () => {
  const denied = authorizeRequest({
    method: "POST",
    pathname: "/tasks",
    identity: null,
    config: {
      rbac_enabled: true,
      default_roles: [RBAC_ROLES.TASK_ADMIN]
    }
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "ROLE_MISSING");
});

test("task API RBAC allows auditor read but denies write", async () => {
  const app = createServerWithRbac({
    auth_enabled: true,
    static_tokens: [
      {
        token: "token-auditor",
        subject: "auditor-user",
        roles: [RBAC_ROLES.READ_ONLY_AUDITOR]
      }
    ]
  }, {
    rbac_enabled: true
  });
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: "Bearer token-auditor"
  };

  try {
    const readHealth = await requestJson(baseUrl, "GET", "/health", null, headers);
    assert.equal(readHealth.status, 200);

    const deniedCreate = await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "rbac-task-1",
      trace_id: "rbac-trace-1",
      task_type: "rbac"
    }, headers);
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.payload.error, "FORBIDDEN");
  } finally {
    await app.stop();
  }
});

test("authorizeRequest locks down when RBAC is disabled", () => {
  const denied = authorizeRequest({
    method: "GET",
    pathname: "/health",
    identity: {
      roles: [RBAC_ROLES.SUPER_ADMIN]
    },
    config: {
      rbac_enabled: false
    }
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "RBAC_LOCKDOWN");
});

test("task API RBAC allows task_admin task writes and denies discovery run", async () => {
  const app = createServerWithRbac({
    auth_enabled: true,
    static_tokens: [
      {
        token: "token-task-admin",
        subject: "task-admin-user",
        roles: [RBAC_ROLES.TASK_ADMIN]
      }
    ]
  }, {
    rbac_enabled: true
  });
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: "Bearer token-task-admin"
  };

  try {
    const created = await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "rbac-task-2",
      trace_id: "rbac-trace-2",
      task_type: "rbac"
    }, headers);
    assert.equal(created.status, 201);

    const discoveryDenied = await requestJson(baseUrl, "POST", "/ops/discovery/run", {
      actor: "task-admin-user"
    }, headers);
    assert.equal(discoveryDenied.status, 403);
    assert.equal(discoveryDenied.payload.error, "FORBIDDEN");
  } finally {
    await app.stop();
  }
});
