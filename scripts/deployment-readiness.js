#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const http = require("http");

const { createTaskApiServer } = require("../src/api/taskApiServer");
const { JsonlAuditEventStore } = require("../src/orchestrator/auditEventStore");
const { TaskOrchestrator } = require("../src/orchestrator/orchestratorService");
const { highRiskFlagsDisabled, loadFeatureFlags } = require("../src/platform/featureFlags");

const DEFAULT_COMMANDS = Object.freeze([
  "node scripts/verify-governance.js",
  "npm test",
  "npm run drill:continuity",
  "npm run test:load",
  "npm run audit:maintenance"
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function runCommand(command, cwd = process.cwd()) {
  const started = Date.now();
  const result = cp.spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8"
  });
  return {
    command,
    exit_code: result.status ?? 1,
    duration_ms: Date.now() - started,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim()
  };
}

function parseJsonFromOutput(output) {
  const text = String(output || "");
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function summarizeCommandCheck(check, maxLines = 8) {
  const lines = String(check.output || "").split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }
  return lines.slice(lines.length - maxLines).join("\n");
}

function requestJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString("utf8");
      });
      res.on("end", () => {
        try {
          const payload = raw ? JSON.parse(raw) : {};
          resolve({
            status: res.statusCode || 500,
            payload
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
  });
}

async function runApiSmokeCheck() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-audit-"));
  const eventStore = new JsonlAuditEventStore({
    filePath: path.join(tempDir, "events.jsonl")
  });
  const orchestrator = new TaskOrchestrator({
    eventStore
  });
  const app = createTaskApiServer({
    orchestrator,
    host: "127.0.0.1",
    port: 0
  });

  const { port } = await app.start();
  try {
    const health = await requestJson(`http://127.0.0.1:${port}/health`);
    const integrity = await requestJson(`http://127.0.0.1:${port}/audit/integrity`);
    const healthPassed = health.status === 200 && health.payload && health.payload.status === "ok";
    const integrityPassed = integrity.status === 200 && integrity.payload && integrity.payload.integrity && integrity.payload.integrity.valid === true;

    return {
      passed: healthPassed && integrityPassed,
      checks: [
        {
          name: "health_endpoint",
          status: health.status,
          passed: healthPassed
        },
        {
          name: "audit_integrity_endpoint",
          status: integrity.status,
          passed: integrityPassed
        }
      ]
    };
  } finally {
    await app.stop();
  }
}

async function runDeploymentReadiness(options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const apiSmokeRunner = options.apiSmokeRunner || runApiSmokeCheck;
  const commands = Array.isArray(options.commands) && options.commands.length > 0
    ? options.commands
    : [...DEFAULT_COMMANDS];
  const writePath = options.writePath || "";
  const cwd = options.cwd || process.cwd();
  const featureFlagPath = options.featureFlagPath || path.join(cwd, "config", "feature_flags.json");
  const minLoadSuccessRate = toNumber(options.minLoadSuccessRate, 0.99);
  const maxLoadP95Ms = toNumber(options.maxLoadP95Ms, 150);

  const commandChecks = commands.map((command) => {
    const raw = commandRunner(command, cwd);
    return {
      ...raw,
      passed: raw.exit_code === 0,
      summary: summarizeCommandCheck(raw)
    };
  });

  const loadCheck = commandChecks.find((item) => item.command.includes("test:load"));
  let loadMetrics = null;
  let loadThresholds = {
    passed: true,
    reason: "SKIPPED"
  };
  if (loadCheck) {
    loadMetrics = parseJsonFromOutput(loadCheck.output);
    if (!loadMetrics) {
      loadThresholds = {
        passed: false,
        reason: "LOAD_METRICS_NOT_FOUND"
      };
    } else {
      const successRate = toNumber(loadMetrics.successRate, 0);
      const p95LatencyMs = toNumber(loadMetrics.p95LatencyMs, Number.POSITIVE_INFINITY);
      const passed = successRate >= minLoadSuccessRate && p95LatencyMs <= maxLoadP95Ms;
      loadThresholds = {
        passed,
        reason: passed ? "OK" : "THRESHOLD_EXCEEDED",
        success_rate: successRate,
        p95_latency_ms: p95LatencyMs,
        min_success_rate: minLoadSuccessRate,
        max_p95_latency_ms: maxLoadP95Ms
      };
    }
  }

  const flags = loadFeatureFlags(featureFlagPath);
  const flagCheck = {
    passed: highRiskFlagsDisabled(flags),
    reason: highRiskFlagsDisabled(flags) ? "OK" : "HIGH_RISK_FLAGS_ENABLED",
    flags
  };

  let apiSmoke = {
    passed: false,
    checks: [],
    reason: "NOT_EXECUTED"
  };
  try {
    apiSmoke = await apiSmokeRunner();
  } catch (err) {
    apiSmoke = {
      passed: false,
      checks: [],
      reason: err && err.message ? err.message : "api smoke check failed"
    };
  }

  const checksPassed = commandChecks.every((item) => item.passed);
  const overallPassed = checksPassed && loadThresholds.passed && flagCheck.passed && apiSmoke.passed;
  const result = {
    timestamp: new Date().toISOString(),
    command_checks: commandChecks,
    load_thresholds: loadThresholds,
    feature_flag_safety: flagCheck,
    api_smoke: apiSmoke,
    overall_passed: overallPassed
  };

  if (writePath) {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runDeploymentReadiness({
    writePath: args.write || path.join("docs", "handoff", "READINESS-LAST.json"),
    minLoadSuccessRate: args["min-success-rate"],
    maxLoadP95Ms: args["max-p95-ms"]
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (!result.overall_passed) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_COMMANDS,
  parseArgs,
  parseJsonFromOutput,
  requestJson,
  runApiSmokeCheck,
  runCommand,
  runDeploymentReadiness,
  summarizeCommandCheck,
  toNumber
};
