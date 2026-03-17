const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createTaskApiServer } = require("../src/api/taskApiServer");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");
const { TASK_STATES } = require("../src/orchestrator/taskStateMachine");

function buildFlags(overrides = {}) {
  return {
    fallback_engine_enabled: false,
    takeover_engine_enabled: false,
    discussion_engine_enabled: false,
    openai_adapter_enabled: false,
    gemini_adapter_enabled: false,
    claude_adapter_enabled: false,
    local_model_adapter_enabled: true,
    ...overrides
  };
}

function createServerForTest(flags = buildFlags()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-api-"));
  const filePath = path.join(dir, "events.jsonl");
  const eventStore = new JsonlAuditEventStore({ filePath });
  const orchestrator = new TaskOrchestrator({
    eventStore,
    flags,
    auditMaintenanceHistoryPath: path.join(dir, "audit-maintenance-history.jsonl")
  });
  return createTaskApiServer({
    orchestrator,
    host: "127.0.0.1",
    port: 0
  });
}

async function requestJson(baseUrl, method, pathname, body) {
  async function attemptRequest() {
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

  try {
    return await attemptRequest();
  } catch (err) {
    if (err && err.code === "ECONNRESET") {
      return attemptRequest();
    }
    throw err;
  }
}

test("task API creates, fetches, and transitions tasks", async () => {
  const app = createServerForTest();
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await requestJson(baseUrl, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(Array.isArray(health.payload.provider_health), true);
    assert.equal(typeof health.payload.pending_takeovers, "number");
    assert.equal(typeof health.payload.active_alerts, "number");
    assert.equal(health.payload.discussion_engine_enabled, false);

    const routingPreview = await requestJson(baseUrl, "GET", "/routing/preview?task_type=api-test");
    assert.equal(routingPreview.status, 200);
    assert.equal(Array.isArray(routingPreview.payload.ranking), true);

    const integrity = await requestJson(baseUrl, "GET", "/audit/integrity");
    assert.equal(integrity.status, 200);
    assert.equal(integrity.payload.integrity.valid, true);

    const created = await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-1",
      trace_id: "api-trace-1",
      task_type: "api-test"
    });
    assert.equal(created.status, 201);
    assert.equal(created.payload.task.state, TASK_STATES.PENDING);

    const fetched = await requestJson(baseUrl, "GET", "/tasks/api-task-1");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.payload.task.task_id, "api-task-1");

    const approved = await requestJson(baseUrl, "POST", "/tasks/api-task-1/actions", {
      action: "APPROVE"
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.task.state, TASK_STATES.RUNNING);

    const aborted = await requestJson(baseUrl, "POST", "/tasks/api-task-1/actions", {
      action: "ABORT"
    });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.payload.task.state, TASK_STATES.CANCELLED);
  } finally {
    await app.stop();
  }
});

test("task API supports TAKEOVER with provider execution and audit queries", async () => {
  const app = createServerForTest(
    buildFlags({
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-2",
      trace_id: "api-trace-2",
      task_type: "api-exec"
    });

    const toRunning = await requestJson(baseUrl, "POST", "/tasks/api-task-2/actions", {
      action: "APPROVE"
    });
    assert.equal(toRunning.status, 200);

    const toWaiting = app.orchestrator.transitionTask({
      task_id: "api-task-2",
      to_state: TASK_STATES.WAITING_HUMAN,
      reason: "manual wait"
    });
    assert.equal(toWaiting.state, TASK_STATES.WAITING_HUMAN);

    const takeover = await requestJson(baseUrl, "POST", "/tasks/api-task-2/actions", {
      action: "TAKEOVER",
      input: "run delegated execution",
      provider: "local",
      fallback_providers: ["openai"],
      execution_options: {
        simulation: {
          fail_providers: ["local"]
        }
      }
    });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.payload.task.state, TASK_STATES.RUNNING);
    assert.equal(takeover.payload.execution.selected_provider, "openai");
    assert.equal(takeover.payload.execution.result.status, "STUB_NOT_IMPLEMENTED");

    const audit = await requestJson(baseUrl, "GET", "/audit/events?task_id=api-task-2");
    assert.equal(audit.status, 200);
    assert.equal(audit.payload.count > 0, true);

    const replay = await requestJson(baseUrl, "GET", "/tasks/api-task-2/replay");
    assert.equal(replay.status, 200);
    assert.equal(Array.isArray(replay.payload.events), true);
    assert.equal(replay.payload.task.task_id, "api-task-2");
  } finally {
    await app.stop();
  }
});

test("task API returns 503 when all provider attempts fail and task becomes FAILED", async () => {
  const app = createServerForTest(
    buildFlags({
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-3",
      trace_id: "api-trace-3",
      task_type: "api-failure"
    });
    await requestJson(baseUrl, "POST", "/tasks/api-task-3/actions", {
      action: "APPROVE"
    });
    app.orchestrator.transitionTask({
      task_id: "api-task-3",
      to_state: TASK_STATES.WAITING_HUMAN,
      reason: "manual wait"
    });

    const failedExecution = await requestJson(baseUrl, "POST", "/tasks/api-task-3/actions", {
      action: "TAKEOVER",
      provider: "local",
      fallback_providers: ["openai"],
      input: "run delegated execution",
      execution_options: {
        simulation: {
          fail_providers: ["local", "openai"]
        }
      }
    });
    assert.equal(failedExecution.status, 503);
    assert.equal(failedExecution.payload.error, "ALL_PROVIDERS_FAILED");
    assert.equal(failedExecution.payload.task.state, TASK_STATES.FAILED);
  } finally {
    await app.stop();
  }
});

test("task API takeover endpoints work when takeover engine is enabled", async () => {
  const app = createServerForTest(
    buildFlags({
      takeover_engine_enabled: true,
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-4",
      trace_id: "api-trace-4",
      task_type: "api-takeover"
    });
    await requestJson(baseUrl, "POST", "/tasks/api-task-4/actions", {
      action: "APPROVE"
    });

    const takeoverRequired = await requestJson(baseUrl, "POST", "/tasks/api-task-4/actions", {
      action: "TAKEOVER",
      provider: "local",
      fallback_providers: ["openai"],
      input: "run delegated execution",
      execution_options: {
        simulation: {
          fail_providers: ["local", "openai"]
        }
      }
    });
    assert.equal(takeoverRequired.status, 202);
    assert.equal(takeoverRequired.payload.error, "TAKEOVER_REQUIRED");
    assert.equal(takeoverRequired.payload.task.state, TASK_STATES.WAITING_HUMAN);
    assert.equal(Boolean(takeoverRequired.payload.takeover), true);

    const pending = await requestJson(baseUrl, "GET", "/takeovers/pending");
    assert.equal(pending.status, 200);
    assert.equal(pending.payload.count, 1);

    const takeoverRecord = await requestJson(baseUrl, "GET", "/tasks/api-task-4/takeover");
    assert.equal(takeoverRecord.status, 200);
    assert.equal(takeoverRecord.payload.takeover.status, "PENDING");

    const resolved = await requestJson(baseUrl, "POST", "/integrations/im/events", {
      task_id: "api-task-4",
      action: "RETRY",
      actor: "im-bot"
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.payload.task.state, TASK_STATES.RUNNING);
    assert.equal(resolved.payload.takeover.status, "RESOLVED");
  } finally {
    await app.stop();
  }
});

test("task API execution follows adaptive routing when enabled", async () => {
  const flags = buildFlags({
    adaptive_routing_enabled: true,
    openai_adapter_enabled: true,
    local_model_adapter_enabled: true
  });
  const app = createServerForTest(flags);
  app.orchestrator.providerRegistry.setProviderHealthOverride("local", {
    healthy: false,
    score: 0.1,
    latency_ms: 900
  });
  app.orchestrator.providerRegistry.setProviderHealthOverride("openai", {
    healthy: true,
    score: 0.95,
    latency_ms: 250
  });

  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-5",
      trace_id: "api-trace-5",
      task_type: "adaptive-routing",
      metadata: {
        preferred_provider: "local",
        routing_mode: "balanced"
      }
    });
    await requestJson(baseUrl, "POST", "/tasks/api-task-5/actions", {
      action: "APPROVE"
    });
    const execution = await requestJson(baseUrl, "POST", "/tasks/api-task-5/actions", {
      action: "TAKEOVER",
      input: "adaptive route execution"
    });
    assert.equal(execution.status, 200);
    assert.equal(execution.payload.execution.selected_provider, "openai");
  } finally {
    await app.stop();
  }
});

test("task API ops endpoints expose discovery snapshots and alert ack flow", async () => {
  const flags = buildFlags({
    openai_adapter_enabled: true,
    local_model_adapter_enabled: true
  });
  const app = createServerForTest(flags);
  app.orchestrator.providerRegistry.setProviderHealthOverride("local", {
    healthy: false,
    score: 0.1,
    latency_ms: 1200
  });

  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const discovery = await requestJson(baseUrl, "POST", "/ops/discovery/run", {
      actor: "ops-user"
    });
    assert.equal(discovery.status, 200);
    assert.equal(Boolean(discovery.payload.snapshot.discovery_id), true);

    const latest = await requestJson(baseUrl, "GET", "/ops/discovery/latest");
    assert.equal(latest.status, 200);
    assert.equal(Boolean(latest.payload.snapshot.discovery_id), true);

    const alerts = await requestJson(baseUrl, "GET", "/ops/alerts?status=OPEN");
    assert.equal(alerts.status, 200);
    assert.equal(alerts.payload.count > 0, true);

    const alertId = alerts.payload.alerts[0].alert_id;
    const ack = await requestJson(baseUrl, "POST", `/ops/alerts/${encodeURIComponent(alertId)}/ack`, {
      actor: "ops-user",
      note: "acknowledged"
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.payload.alert.status, "ACKED");
  } finally {
    await app.stop();
  }
});

test("task API exposes audit maintenance history endpoints", async () => {
  const app = createServerForTest();
  app.orchestrator.auditMaintenanceHistoryStore.appendRun({
    timestamp: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    interval_seconds: 0,
    iterations_requested: 1,
    runs: [
      {
        success: false,
        archive: { success: true },
        retention: {
          success: false,
          reasons: ["INTEGRITY_FAILURE"]
        }
      }
    ],
    success: false
  });
  app.orchestrator.auditMaintenanceHistoryStore.appendRun({
    timestamp: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    interval_seconds: 0,
    iterations_requested: 1,
    runs: [
      {
        success: true,
        archive: { success: true },
        retention: {
          success: true,
          reasons: ["OK"]
        }
      }
    ],
    success: true
  });

  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const latest = await requestJson(baseUrl, "GET", "/ops/audit-maintenance/latest");
    assert.equal(latest.status, 200);
    assert.equal(latest.payload.run.success, true);

    const failedRuns = await requestJson(baseUrl, "GET", "/ops/audit-maintenance/runs?status=FAILED&limit=10");
    assert.equal(failedRuns.status, 200);
    assert.equal(failedRuns.payload.count, 1);
    assert.equal(failedRuns.payload.runs[0].success, false);

    const failures = await requestJson(baseUrl, "GET", "/ops/audit-maintenance/failures?limit=10");
    assert.equal(failures.status, 200);
    assert.equal(failures.payload.summary.failed_runs, 1);
    assert.equal(failures.payload.summary.reasons[0].reason, "INTEGRITY_FAILURE");
  } finally {
    await app.stop();
  }
});

test("task API discussion endpoints run and return latest discussion", async () => {
  const app = createServerForTest(
    buildFlags({
      discussion_engine_enabled: true
    })
  );
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-6",
      trace_id: "api-trace-6",
      task_type: "discussion"
    });

    const started = await requestJson(baseUrl, "POST", "/tasks/api-task-6/discussion", {
      prompt: "Should we proceed?",
      quorum: 2,
      participants: ["planner", "executor", "reviewer"]
    });
    assert.equal(started.status, 200);
    assert.equal(Boolean(started.payload.discussion.discussion_id), true);

    const latest = await requestJson(baseUrl, "GET", "/tasks/api-task-6/discussion/latest");
    assert.equal(latest.status, 200);
    assert.equal(latest.payload.discussion.discussion_id, started.payload.discussion.discussion_id);
  } finally {
    await app.stop();
  }
});

test("task API discussion endpoint rejects when discussion engine is disabled", async () => {
  const app = createServerForTest();
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-7",
      trace_id: "api-trace-7",
      task_type: "discussion"
    });
    const response = await requestJson(baseUrl, "POST", "/tasks/api-task-7/discussion", {
      prompt: "Should we proceed?"
    });
    assert.equal(response.status, 409);
    assert.equal(response.payload.error, "CONFLICT");
  } finally {
    await app.stop();
  }
});

test("task API fault injection supports timeout fallback and key-invalid takeover", async () => {
  const app = createServerForTest(
    buildFlags({
      takeover_engine_enabled: true,
      openai_adapter_enabled: true,
      local_model_adapter_enabled: true
    })
  );
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-8",
      trace_id: "api-trace-8",
      task_type: "fault-injection"
    });
    await requestJson(baseUrl, "POST", "/tasks/api-task-8/actions", {
      action: "APPROVE"
    });

    const timeoutFallback = await requestJson(baseUrl, "POST", "/tasks/api-task-8/actions", {
      action: "TAKEOVER",
      provider: "local",
      fallback_providers: ["openai"],
      input: "simulate timeout fallback",
      execution_options: {
        simulation: {
          timeout_providers: ["local"]
        }
      }
    });
    assert.equal(timeoutFallback.status, 200);
    assert.equal(timeoutFallback.payload.execution.selected_provider, "openai");

    await requestJson(baseUrl, "POST", "/tasks/api-task-8/actions", {
      action: "ABORT"
    });
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-9",
      trace_id: "api-trace-9",
      task_type: "fault-injection"
    });
    await requestJson(baseUrl, "POST", "/tasks/api-task-9/actions", {
      action: "APPROVE"
    });

    const keyInvalid = await requestJson(baseUrl, "POST", "/tasks/api-task-9/actions", {
      action: "TAKEOVER",
      provider: "local",
      fallback_providers: ["openai"],
      input: "simulate invalid key takeover",
      execution_options: {
        simulation: {
          invalid_key_providers: ["local", "openai"]
        }
      }
    });
    assert.equal(keyInvalid.status, 202);
    assert.equal(keyInvalid.payload.error, "TAKEOVER_REQUIRED");
    assert.equal(keyInvalid.payload.task.state, TASK_STATES.WAITING_HUMAN);
  } finally {
    await app.stop();
  }
});

test("task API audit integrity endpoint reports tampered audit log", async () => {
  const app = createServerForTest();
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await requestJson(baseUrl, "POST", "/tasks", {
      task_id: "api-task-10",
      trace_id: "api-trace-10",
      task_type: "integrity-check"
    });
    const filePath = app.orchestrator.eventStore.filePath;
    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
    const first = JSON.parse(lines[0]);
    first.payload.task_snapshot.task_type = "tampered";
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

    const integrity = await requestJson(baseUrl, "GET", "/audit/integrity");
    assert.equal(integrity.status, 409);
    assert.equal(integrity.payload.integrity.valid, false);
  } finally {
    await app.stop();
  }
});

test("task API can recover task state after restart with runtime SQLite persistence enabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-api-runtime-db-"));
  const configDir = path.join(dir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const featureFlagPath = path.join(configDir, "feature_flags.json");
  const providerProfilePath = path.join(configDir, "provider_profiles.json");
  const rbacConfigPath = path.join(configDir, "rbac_policy.json");
  const secretVaultConfigPath = path.join(configDir, "secret_vault.json");
  const runtimeDbConfigPath = path.join(configDir, "runtime_db.json");
  const runtimeDbPath = path.join(dir, "runtime-state.db");

  fs.writeFileSync(featureFlagPath, `${JSON.stringify(buildFlags(), null, 2)}\n`, "utf8");
  fs.writeFileSync(providerProfilePath, `${JSON.stringify({
    openai: { default_model: "gpt-4.1", cost_per_1k_tokens: 0.02, latency_weight_hint: 0.6 },
    gemini: { default_model: "gemini-2.0-flash", cost_per_1k_tokens: 0.012, latency_weight_hint: 0.7 },
    claude: { default_model: "claude-3-7-sonnet", cost_per_1k_tokens: 0.018, latency_weight_hint: 0.65 },
    local: { default_model: "llama3.1:8b", cost_per_1k_tokens: 0.002, latency_weight_hint: 0.5 }
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(rbacConfigPath, `${JSON.stringify({
    rbac_enabled: false,
    default_roles: ["super_admin"]
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(secretVaultConfigPath, `${JSON.stringify({
    vault_file: path.join(dir, "secret-vault.json"),
    audit_log: path.join(dir, "secret-vault-audit.jsonl"),
    master_key_env: "SECRET_VAULT_MASTER_KEY"
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(runtimeDbConfigPath, `${JSON.stringify({
    enabled: true,
    db_path: runtimeDbPath
  }, null, 2)}\n`, "utf8");

  let app = createTaskApiServer({
    host: "127.0.0.1",
    port: 0,
    featureFlagPath,
    providerProfilePath,
    rbacConfigPath,
    secretVaultConfigPath,
    runtimeDbConfigPath
  });
  let started = await app.start();
  let baseUrl = `http://127.0.0.1:${started.port}`;

  await requestJson(baseUrl, "POST", "/tasks", {
    task_id: "runtime-db-task-1",
    trace_id: "runtime-db-trace-1",
    task_type: "runtime-db"
  });
  await requestJson(baseUrl, "POST", "/tasks/runtime-db-task-1/actions", {
    action: "APPROVE"
  });
  await app.stop();

  app = createTaskApiServer({
    host: "127.0.0.1",
    port: 0,
    featureFlagPath,
    providerProfilePath,
    rbacConfigPath,
    secretVaultConfigPath,
    runtimeDbConfigPath
  });
  started = await app.start();
  baseUrl = `http://127.0.0.1:${started.port}`;
  try {
    const restored = await requestJson(baseUrl, "GET", "/tasks/runtime-db-task-1");
    assert.equal(restored.status, 200);
    assert.equal(restored.payload.task.state, TASK_STATES.RUNNING);

    const listed = await requestJson(baseUrl, "GET", "/tasks?limit=10");
    assert.equal(listed.status, 200);
    assert.equal(listed.payload.tasks.some((item) => item.task_id === "runtime-db-task-1"), true);
  } finally {
    await app.stop();
  }
});
