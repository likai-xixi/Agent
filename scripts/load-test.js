#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const { createTaskApiServer } = require("../src/api/taskApiServer");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");
const { DEFAULT_FLAGS } = require("../src/platform/featureFlags");

const SCRIPT_API_TOKEN = "load-test-static-token";
const SCRIPT_AUTH_CONFIG = Object.freeze({
  auth_enabled: true,
  static_tokens: [
    {
      token: SCRIPT_API_TOKEN,
      subject: "load-test-runner",
      roles: ["task_admin", "read_only_auditor"],
      mfa_verified: true
    }
  ]
});
const SCRIPT_AUTH_HEADERS = Object.freeze({
  Authorization: `Bearer ${SCRIPT_API_TOKEN}`
});

function requestJson(baseUrl, method, pathname, body, headers = {}) {
  const target = new URL(`${baseUrl}${pathname}`);
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        ...headers,
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
        const ended = performance.now();
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (err) {
          reject(err);
          return;
        }
        resolve({
          status: res.statusCode || 500,
          payload: parsed,
          latencyMs: ended - started
        });
      });
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await worker(items[index], index);
      results[index] = result;
    }
  });
  await Promise.all(runners);
  return results;
}

async function runScenario(baseUrl, index) {
  const taskId = `load-task-${index}`;
  const traceId = `load-trace-${index}`;
  const latencies = [];

  const created = await requestJson(baseUrl, "POST", "/tasks", {
    task_id: taskId,
    trace_id: traceId,
    task_type: "load-test"
  }, SCRIPT_AUTH_HEADERS);
  latencies.push(created.latencyMs);
  if (created.status !== 201) {
    return { ok: false, latencies, stage: "create", status: created.status };
  }

  const approved = await requestJson(baseUrl, "POST", `/tasks/${taskId}/actions`, {
    action: "APPROVE"
  }, SCRIPT_AUTH_HEADERS);
  latencies.push(approved.latencyMs);
  if (approved.status !== 200) {
    return { ok: false, latencies, stage: "approve", status: approved.status };
  }

  const takeover = await requestJson(baseUrl, "POST", `/tasks/${taskId}/actions`, {
    action: "TAKEOVER",
    provider: "local",
    fallback_providers: ["openai"],
    input: "load test execution",
    execution_options: {
      simulation: index % 2 === 0 ? { fail_providers: ["local"] } : {}
    }
  }, SCRIPT_AUTH_HEADERS);
  latencies.push(takeover.latencyMs);
  if (takeover.status !== 200) {
    return { ok: false, latencies, stage: "takeover", status: takeover.status };
  }

  return {
    ok: true,
    latencies
  };
}

async function main() {
  const taskCount = Number.parseInt(process.env.LOAD_TASKS || "80", 10);
  const concurrency = Number.parseInt(process.env.LOAD_CONCURRENCY || "16", 10);
  const p95Threshold = Number.parseFloat(process.env.LOAD_P95_THRESHOLD_MS || "500");
  const successThreshold = Number.parseFloat(process.env.LOAD_SUCCESS_THRESHOLD || "0.99");

  const flags = {
    ...DEFAULT_FLAGS,
    adaptive_routing_enabled: true,
    openai_adapter_enabled: true,
    local_model_adapter_enabled: true
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "load-test-"));
  const eventStore = new JsonlAuditEventStore({
    filePath: path.join(tempDir, "events.jsonl")
  });
  const orchestrator = new TaskOrchestrator({
    eventStore,
    flags
  });
  const app = createTaskApiServer({
    host: "127.0.0.1",
    port: 0,
    orchestrator,
    authConfig: SCRIPT_AUTH_CONFIG
  });

  const start = performance.now();
  const { port } = await app.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const items = new Array(taskCount).fill(0);
    const results = await runWithConcurrency(items, concurrency, (_, idx) => runScenario(baseUrl, idx));
    const ended = performance.now();

    const allLatencies = results.flatMap((item) => item.latencies);
    const passed = results.filter((item) => item.ok).length;
    const failed = results.length - passed;
    const successRate = results.length === 0 ? 0 : passed / results.length;
    const p95 = percentile(allLatencies, 95);

    const summary = {
      taskCount,
      concurrency,
      passed,
      failed,
      successRate,
      p95LatencyMs: p95,
      durationMs: ended - start
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    if (successRate < successThreshold) {
      // eslint-disable-next-line no-console
      console.error(`Load test failed: successRate ${successRate} < threshold ${successThreshold}`);
      process.exitCode = 1;
      return;
    }
    if (p95 > p95Threshold) {
      // eslint-disable-next-line no-console
      console.error(`Load test failed: p95 ${p95}ms > threshold ${p95Threshold}ms`);
      process.exitCode = 1;
      return;
    }
  } finally {
    await app.stop();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
