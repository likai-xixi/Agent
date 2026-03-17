const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createTaskApiServer } = require("../src/api/taskApiServer");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");

function buildFlags(overrides = {}) {
  return {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    adaptive_routing_enabled: false,
    openai_adapter_enabled: false,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createServerForTest(flags = buildFlags(), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-ui-api-"));
  const configDir = path.join(dir, "config");
  const filePath = path.join(dir, "events.jsonl");
  const featureFlagPath = path.join(configDir, "feature_flags.json");
  const providerProfilePath = path.join(configDir, "provider_profiles.json");
  const rbacConfigPath = path.join(configDir, "rbac_policy.json");
  const secretVaultConfigPath = path.join(configDir, "secret_vault.json");
  writeJson(featureFlagPath, flags);
  writeJson(providerProfilePath, {
    openai: {
      default_model: "gpt-4.1",
      cost_per_1k_tokens: 0.02,
      latency_weight_hint: 0.6
    },
    gemini: {
      default_model: "gemini-2.0-flash",
      cost_per_1k_tokens: 0.012,
      latency_weight_hint: 0.7
    },
    claude: {
      default_model: "claude-3-7-sonnet",
      cost_per_1k_tokens: 0.018,
      latency_weight_hint: 0.65
    },
    local: {
      default_model: "llama3.1:8b",
      cost_per_1k_tokens: 0.002,
      latency_weight_hint: 0.5
    }
  });
  writeJson(rbacConfigPath, {
    rbac_enabled: false,
    default_roles: ["super_admin"]
  });
  writeJson(secretVaultConfigPath, {
    vault_file: path.join(dir, "secret-vault.json"),
    audit_log: path.join(dir, "secret-vault-audit.jsonl"),
    master_key_env: "SECRET_VAULT_MASTER_KEY"
  });
  const eventStore = new JsonlAuditEventStore({ filePath });
  const orchestrator = new TaskOrchestrator({
    eventStore,
    flags,
    auditMaintenanceHistoryPath: path.join(dir, "audit-maintenance-history.jsonl")
  });
  return createTaskApiServer({
    orchestrator,
    host: "127.0.0.1",
    port: 0,
    featureFlagPath,
    providerProfilePath,
    rbacConfigPath,
    secretVaultConfigPath,
    secretVaultMasterKey: options.secretVaultMasterKey || ""
  });
}

async function requestRaw(baseUrl, method, pathname, body = null) {
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
        "Content-Length": Buffer.byteLength(payload)
      }
    });
    req.on("error", reject);
    req.on("response", (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString("utf8");
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode || 500,
          headers: res.headers,
          text: raw
        });
      });
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function requestJson(baseUrl, method, pathname, body = null) {
  const response = await requestRaw(baseUrl, method, pathname, body);
  return {
    status: response.status,
    payload: response.text ? JSON.parse(response.text) : {}
  };
}

test("admin UI assets are served by task API", async () => {
  const app = createServerForTest();
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const html = await requestRaw(baseUrl, "GET", "/admin");
    assert.equal(html.status, 200);
    assert.equal(String(html.headers["content-type"] || "").includes("text/html"), true);
    assert.equal(html.text.includes("Admin Console"), true);

    const css = await requestRaw(baseUrl, "GET", "/admin/styles.css");
    assert.equal(css.status, 200);
    assert.equal(String(css.headers["content-type"] || "").includes("text/css"), true);
    assert.equal(css.text.includes("--accent"), true);

    const js = await requestRaw(baseUrl, "GET", "/admin/app.js");
    assert.equal(js.status, 200);
    assert.equal(String(js.headers["content-type"] || "").includes("application/javascript"), true);
    assert.equal(js.text.includes("loadTasks"), true);
  } finally {
    await app.stop();
  }
});

test("task list endpoint returns summary and records for admin UI", async () => {
  const app = createServerForTest();
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "admin-ui-task-1",
      trace_id: "admin-ui-trace-1",
      task_type: "admin-ui"
    });
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "admin-ui-task-2",
      trace_id: "admin-ui-trace-2",
      task_type: "admin-ui"
    });

    const list = await requestJson(baseUrl, "GET", "/tasks?limit=20");
    assert.equal(list.status, 200);
    assert.equal(list.payload.count >= 2, true);
    assert.equal(Array.isArray(list.payload.tasks), true);
    assert.equal(typeof list.payload.summary.PENDING, "number");
  } finally {
    await app.stop();
  }
});

test("settings endpoints update runtime config and keep secrets masked", async () => {
  const app = createServerForTest(buildFlags(), {
    secretVaultMasterKey: "unit-test-master-key"
  });
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const flags = await requestJson(baseUrl, "GET", "/settings/feature-flags");
    assert.equal(flags.status, 200);
    assert.equal(flags.payload.feature_flags.local_model_adapter_enabled, true);

    const updatedFlags = await requestJson(baseUrl, "PUT", "/settings/feature-flags", {
      feature_flags: {
        ...flags.payload.feature_flags,
        openai_adapter_enabled: true
      }
    });
    assert.equal(updatedFlags.status, 200);
    assert.equal(updatedFlags.payload.feature_flags.openai_adapter_enabled, true);

    const health = await requestJson(baseUrl, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.payload.providers.includes("openai"), true);

    const updatedProfiles = await requestJson(baseUrl, "PUT", "/settings/provider-profiles", {
      provider_profiles: {
        openai: {
          default_model: "gpt-4.1-mini",
          cost_per_1k_tokens: 0.015
        },
        gemini: {
          default_model: "gemini-2.0-flash",
          cost_per_1k_tokens: 0.012
        },
        claude: {
          default_model: "claude-3-7-sonnet",
          cost_per_1k_tokens: 0.018
        },
        local: {
          default_model: "llama3.1:8b",
          cost_per_1k_tokens: 0.002
        }
      }
    });
    assert.equal(updatedProfiles.status, 200);
    assert.equal(updatedProfiles.payload.provider_profiles.openai.default_model, "gpt-4.1-mini");

    const routing = await requestJson(baseUrl, "GET", "/routing/preview?preferred_provider=openai");
    assert.equal(routing.status, 200);
    const openaiRanking = routing.payload.ranking.find((item) => item.provider === "openai");
    assert.equal(Boolean(openaiRanking), true);
    assert.equal(openaiRanking.model, "gpt-4.1-mini");

    const updatedRbac = await requestJson(baseUrl, "PUT", "/settings/rbac", {
      rbac: {
        rbac_enabled: false,
        default_roles: ["super_admin", "task_admin"]
      }
    });
    assert.equal(updatedRbac.status, 200);
    assert.equal(updatedRbac.payload.rbac.default_roles.includes("task_admin"), true);

    const upsertedSecret = await requestJson(baseUrl, "POST", "/settings/provider-secrets", {
      name: "OPENAI_API_KEY",
      value: "sk-unit-test-123456",
      actor: "test-admin"
    });
    assert.equal(upsertedSecret.status, 200);
    assert.equal(upsertedSecret.payload.available, true);

    const secrets = await requestJson(baseUrl, "GET", "/settings/provider-secrets");
    assert.equal(secrets.status, 200);
    assert.equal(secrets.payload.available, true);
    const openaiSecret = secrets.payload.secrets.find((item) => item.name === "OPENAI_API_KEY");
    assert.equal(Boolean(openaiSecret), true);
    assert.equal(openaiSecret.masked_value.includes("***"), true);
  } finally {
    await app.stop();
  }
});
