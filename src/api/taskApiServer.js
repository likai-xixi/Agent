const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { URL } = require("url");

const { TaskOrchestrator } = require("../orchestrator/orchestratorService");
const {
  API_AUTH_ACCEPTED,
  API_AUTH_REJECTED,
  API_AUTHZ_ALLOWED,
  API_AUTHZ_DENIED,
  createAuditEvent
} = require("../platform/audit");
const { ValidationError } = require("../platform/contracts");
const { ProviderExecutionError } = require("../providers/adapterContract");
const { TASK_STATES } = require("../orchestrator/taskStateMachine");
const { fromMapping, loadFeatureFlags } = require("../platform/featureFlags");
const { JsonFileSecretVault } = require("../platform/secretVault");
const { loadProviderProfiles } = require("../orchestrator/providerRouter");
const {
  SqliteAuditEventStore,
  SqliteHealthAlarmStore,
  SqliteRuntimeDatabase,
  SqliteTakeoverStore,
  SqliteTaskSnapshotStore
} = require("../persistence/sqliteRuntimeStore");
const {
  AuthError,
  authenticateIncomingRequest,
  loadApiAuthConfig,
  normalizeApiAuthConfig
} = require("./auth");
const {
  RBAC_ROLES,
  authorizeRequest,
  loadRbacConfig,
  normalizeRbacConfig
} = require("./rbac");

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res, message = "Not found") {
  jsonResponse(res, 404, { error: "NOT_FOUND", message });
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { error: "METHOD_NOT_ALLOWED" });
}

function badRequest(res, message) {
  jsonResponse(res, 400, { error: "BAD_REQUEST", message });
}

function conflict(res, message) {
  jsonResponse(res, 409, { error: "CONFLICT", message });
}

function serverError(res, message) {
  jsonResponse(res, 500, { error: "INTERNAL_ERROR", message });
}

function textResponse(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

const PROVIDER_KEYS = Object.freeze(["openai", "gemini", "claude", "local"]);
const PROVIDER_SECRET_NAMES = Object.freeze([
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY"
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonConfig(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonConfig(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeProviderProfiles(raw = {}, fallback = {}) {
  const source = isRecord(raw) ? raw : {};
  const baseline = isRecord(fallback) ? fallback : {};
  const result = {};
  for (const provider of PROVIDER_KEYS) {
    const profile = isRecord(source[provider]) ? source[provider] : {};
    const previous = isRecord(baseline[provider]) ? baseline[provider] : {};
    const modelsByTaskType = isRecord(profile.models_by_task_type)
      ? profile.models_by_task_type
      : isRecord(previous.models_by_task_type) ? previous.models_by_task_type : {};
    const cost = Number(profile.cost_per_1k_tokens);
    const latencyHint = Number(profile.latency_weight_hint);
    result[provider] = {
      default_model: String(profile.default_model || previous.default_model || `${provider}-default-model`),
      cost_per_1k_tokens: Number.isFinite(cost) && cost > 0 ? cost : Number(previous.cost_per_1k_tokens || 0.02),
      latency_weight_hint: Number.isFinite(latencyHint) ? latencyHint : Number(previous.latency_weight_hint || 0.6),
      models_by_task_type: modelsByTaskType
    };
  }
  return result;
}

function loadSecretVaultConfig(pathValue = "config/secret_vault.json") {
  const fallback = {
    vault_file: "data/secret-vault.json",
    audit_log: "data/secret-vault-audit.jsonl",
    master_key_env: "SECRET_VAULT_MASTER_KEY"
  };
  const raw = readJsonConfig(pathValue, fallback);
  return {
    vault_file: String(raw.vault_file || fallback.vault_file),
    audit_log: String(raw.audit_log || fallback.audit_log),
    master_key_env: String(raw.master_key_env || fallback.master_key_env)
  };
}

function loadRuntimeDbConfig(pathValue = "config/runtime_db.json") {
  const fallback = {
    enabled: false,
    db_path: "data/runtime-state.db"
  };
  const raw = readJsonConfig(pathValue, fallback);
  return {
    enabled: raw.enabled === true,
    db_path: String(raw.db_path || fallback.db_path)
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function toActionTransition(action) {
  const normalized = String(action || "").toUpperCase();
  if (normalized === "APPROVE") {
    return {
      to_state: TASK_STATES.RUNNING,
      reason: "manual_approve"
    };
  }
  if (normalized === "RETRY") {
    return {
      to_state: TASK_STATES.RUNNING,
      reason: "manual_retry"
    };
  }
  if (normalized === "ABORT") {
    return {
      to_state: TASK_STATES.CANCELLED,
      reason: "manual_abort"
    };
  }
  if (normalized === "TAKEOVER") {
    return {
      to_state: TASK_STATES.RUNNING,
      reason: "manual_takeover"
    };
  }
  return null;
}

function parsePositiveInt(value, fallback, maximum = 500) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function resolveRequestActor(explicitActor, identity, fallback, forceIdentity = false) {
  if (forceIdentity && identity && identity.subject) {
    return identity.subject;
  }
  if (explicitActor && String(explicitActor).trim() !== "") {
    return String(explicitActor).trim();
  }
  if (identity && identity.subject) {
    return identity.subject;
  }
  return fallback;
}

function enrichMetadataWithIdentity(metadata, identity, includeIdentity) {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata }
    : {};
  if (!includeIdentity || !identity) {
    return base;
  }
  return {
    ...base,
    request_identity: {
      subject: identity.subject,
      roles: identity.roles,
      auth_type: identity.auth_type
    }
  };
}

function appendAuthAuditEvent(orchestrator, eventType, payload = {}, actor = "task-api") {
  try {
    if (!orchestrator || !orchestrator.eventStore || typeof orchestrator.eventStore.append !== "function") {
      return;
    }
    const event = createAuditEvent({
      trace_id: randomUUID(),
      task_id: `auth-${randomUUID()}`,
      attempt_id: "attempt-0",
      actor,
      source: "api-auth",
      event_type: eventType,
      payload
    });
    orchestrator.eventStore.append(event);
  } catch {
    // auth audit logging must not block request handling
  }
}

function createTaskApiServer(options = {}) {
  const featureFlagPath = options.featureFlagPath || "config/feature_flags.json";
  const providerProfilePath = options.providerProfilePath || "config/provider_profiles.json";
  const rbacConfigPath = options.rbacConfigPath || "config/rbac_policy.json";
  const secretVaultConfigPath = options.secretVaultConfigPath || "config/secret_vault.json";
  const runtimeDbConfigPath = options.runtimeDbConfigPath || "config/runtime_db.json";
  const runtimeDbConfig = loadRuntimeDbConfig(runtimeDbConfigPath);
  const hasProvidedOrchestrator = Boolean(options.orchestrator);
  const hasExplicitFlagConfig = Object.prototype.hasOwnProperty.call(options, "flags")
    || Object.prototype.hasOwnProperty.call(options, "featureFlagPath");
  const hasExplicitProfileConfig = Object.prototype.hasOwnProperty.call(options, "providerProfilePath");
  const initialFlags = options.flags
    ? fromMapping(options.flags)
    : hasProvidedOrchestrator && !hasExplicitFlagConfig
      ? fromMapping(options.orchestrator.flags || {})
      : loadFeatureFlags(featureFlagPath);
  let managedRuntimeDatabase = null;
  let orchestrator = options.orchestrator || null;
  if (!orchestrator) {
    if (runtimeDbConfig.enabled === true) {
      managedRuntimeDatabase = new SqliteRuntimeDatabase({
        dbPath: runtimeDbConfig.db_path,
        autoMigrate: true
      });
      orchestrator = new TaskOrchestrator({
        flags: initialFlags,
        eventStore: new SqliteAuditEventStore({
          database: managedRuntimeDatabase
        }),
        takeoverStore: new SqliteTakeoverStore({
          database: managedRuntimeDatabase
        }),
        healthAlarmStore: new SqliteHealthAlarmStore({
          database: managedRuntimeDatabase
        }),
        taskSnapshotStore: new SqliteTaskSnapshotStore({
          database: managedRuntimeDatabase
        }),
        auditMaintenanceHistoryPath: options.auditMaintenanceHistoryPath
      });
    } else {
      orchestrator = new TaskOrchestrator({
        flags: initialFlags,
        takeoverStorePath: options.takeoverStorePath,
        auditMaintenanceHistoryPath: options.auditMaintenanceHistoryPath
      });
    }
  }
  if (!hasProvidedOrchestrator || hasExplicitFlagConfig) {
    if (orchestrator.providerRegistry) {
      orchestrator.providerRegistry.flags = {
        ...orchestrator.providerRegistry.flags,
        ...initialFlags
      };
    }
    orchestrator.flags = {
      ...orchestrator.flags,
      ...initialFlags
    };
  }
  if (!hasProvidedOrchestrator || hasExplicitProfileConfig) {
    const initialProfiles = normalizeProviderProfiles(
      readJsonConfig(providerProfilePath, loadProviderProfiles(providerProfilePath)),
      orchestrator.providerRouter && orchestrator.providerRouter.profiles
        ? orchestrator.providerRouter.profiles
        : {}
    );
    if (orchestrator.providerRouter) {
      orchestrator.providerRouter.profiles = initialProfiles;
    }
  }
  const authConfig = normalizeApiAuthConfig(options.authConfig || loadApiAuthConfig(options.authConfigPath));
  const rbacConfig = normalizeRbacConfig(options.rbacConfig || loadRbacConfig(rbacConfigPath));
  const secretVaultConfig = loadSecretVaultConfig(secretVaultConfigPath);
  const secretVaultMasterKey = String(options.secretVaultMasterKey || process.env[secretVaultConfig.master_key_env] || "");
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const adminUiRoot = options.adminUiRoot || path.join(__dirname, "admin-ui");
  const adminAssets = {
    "/admin/styles.css": {
      file: "styles.css",
      contentType: "text/css; charset=utf-8"
    },
    "/admin/app.js": {
      file: "app.js",
      contentType: "application/javascript; charset=utf-8"
    }
  };

  function serveAdminFile(res, assetFile, contentType) {
    const filePath = path.join(adminUiRoot, assetFile);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      textResponse(res, 200, contentType, content);
      return true;
    } catch {
      notFound(res, "Admin UI asset not found");
      return false;
    }
  }

  function createVaultInstance() {
    if (!secretVaultMasterKey) {
      return {
        vault: null,
        error: "MASTER_KEY_MISSING"
      };
    }
    try {
      return {
        vault: new JsonFileSecretVault({
          filePath: secretVaultConfig.vault_file,
          auditLogPath: secretVaultConfig.audit_log,
          masterKey: secretVaultMasterKey
        }),
        error: ""
      };
    } catch (err) {
      return {
        vault: null,
        error: err && err.message ? err.message : "VAULT_INIT_FAILED"
      };
    }
  }

  function listProviderSecretsMasked() {
    const vaultResult = createVaultInstance();
    if (!vaultResult.vault) {
      return {
        available: false,
        master_key_env: secretVaultConfig.master_key_env,
        reason: vaultResult.error,
        secrets: []
      };
    }
    const all = vaultResult.vault.listSecretsMasked();
    const byName = new Map(all.map((item) => [item.name, item]));
    const secrets = PROVIDER_SECRET_NAMES.map((name) => {
      const existing = byName.get(name);
      return existing || {
        name,
        masked_value: "",
        updated_at: ""
      };
    });
    return {
      available: true,
      master_key_env: secretVaultConfig.master_key_env,
      reason: "",
      secrets
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
      const pathname = requestUrl.pathname;
      const method = req.method || "GET";
      const authResult = authenticateIncomingRequest(req, authConfig);
      const forceIdentityActor = authConfig.auth_enabled === true;
      const requestIdentity = authResult.identity;
      const requestSource = requestIdentity && requestIdentity.auth_type
        ? `http-${requestIdentity.auth_type}`
        : "http";

      if (forceIdentityActor && authResult.authenticated !== true) {
        const authError = authResult.error instanceof AuthError
          ? authResult.error
          : new AuthError("Unauthorized request", { code: "AUTH_REQUIRED", status: 401 });
        appendAuthAuditEvent(orchestrator, API_AUTH_REJECTED, {
          method,
          pathname,
          reason: authError.code
        }, "task-api");
        jsonResponse(res, authError.status || 401, {
          error: authError.code || "AUTH_REQUIRED",
          message: authError.message || "Unauthorized request"
        });
        return;
      }

      if (forceIdentityActor && requestIdentity) {
        appendAuthAuditEvent(orchestrator, API_AUTH_ACCEPTED, {
          method,
          pathname,
          subject: requestIdentity.subject,
          roles: requestIdentity.roles
        }, requestIdentity.subject);
      }

      const authorization = authorizeRequest({
        method,
        pathname,
        identity: requestIdentity,
        config: rbacConfig
      });
      if (rbacConfig.rbac_enabled === true && authorization.allowed !== true) {
        appendAuthAuditEvent(orchestrator, API_AUTHZ_DENIED, {
          method,
          pathname,
          subject: requestIdentity ? requestIdentity.subject : "anonymous",
          roles: requestIdentity ? requestIdentity.roles : [],
          rule_id: authorization.rule_id,
          required_roles: authorization.allowed_roles
        }, requestIdentity ? requestIdentity.subject : "task-api");
        jsonResponse(res, 403, {
          error: "FORBIDDEN",
          message: "Role is not allowed to access this endpoint",
          rule_id: authorization.rule_id
        });
        return;
      }
      if (rbacConfig.rbac_enabled === true && requestIdentity) {
        appendAuthAuditEvent(orchestrator, API_AUTHZ_ALLOWED, {
          method,
          pathname,
          subject: requestIdentity.subject,
          roles: requestIdentity.roles,
          rule_id: authorization.rule_id
        }, requestIdentity.subject);
      }

      if (method === "GET" && pathname === "/health") {
        const providerHealth = await orchestrator.getProviderHealth();
        const openAlerts = orchestrator.listProviderAlerts("OPEN");
        jsonResponse(res, 200, {
          status: "ok",
          providers: orchestrator.getAvailableProviders(),
          provider_health: providerHealth,
          pending_takeovers: orchestrator.getPendingTakeovers().length,
          active_alerts: openAlerts.length,
          adaptive_routing_enabled: orchestrator.flags.adaptive_routing_enabled === true,
          discussion_engine_enabled: orchestrator.flags.discussion_engine_enabled === true,
          auth_enabled: authConfig.auth_enabled === true,
          rbac_enabled: rbacConfig.rbac_enabled === true
        });
        return;
      }

      if (method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
        serveAdminFile(res, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (method === "GET" && Object.prototype.hasOwnProperty.call(adminAssets, pathname)) {
        const asset = adminAssets[pathname];
        serveAdminFile(res, asset.file, asset.contentType);
        return;
      }

      if (method === "GET" && pathname === "/settings/feature-flags") {
        jsonResponse(res, 200, {
          feature_flags: {
            ...orchestrator.flags
          }
        });
        return;
      }

      if (method === "PUT" && pathname === "/settings/feature-flags") {
        const body = await parseJsonBody(req);
        const raw = isRecord(body.feature_flags) ? body.feature_flags : body;
        const normalized = fromMapping(raw);
        writeJsonConfig(featureFlagPath, normalized);
        orchestrator.flags = {
          ...orchestrator.flags,
          ...normalized
        };
        if (orchestrator.providerRegistry) {
          orchestrator.providerRegistry.flags = {
            ...orchestrator.providerRegistry.flags,
            ...normalized
          };
        }
        jsonResponse(res, 200, {
          feature_flags: {
            ...orchestrator.flags
          }
        });
        return;
      }

      if (method === "GET" && pathname === "/settings/provider-profiles") {
        const profiles = normalizeProviderProfiles(
          orchestrator.providerRouter && orchestrator.providerRouter.profiles
            ? orchestrator.providerRouter.profiles
            : {},
          loadProviderProfiles(providerProfilePath)
        );
        jsonResponse(res, 200, {
          provider_profiles: profiles
        });
        return;
      }

      if (method === "PUT" && pathname === "/settings/provider-profiles") {
        const body = await parseJsonBody(req);
        const raw = isRecord(body.provider_profiles) ? body.provider_profiles : body;
        const normalized = normalizeProviderProfiles(
          raw,
          orchestrator.providerRouter && orchestrator.providerRouter.profiles
            ? orchestrator.providerRouter.profiles
            : loadProviderProfiles(providerProfilePath)
        );
        writeJsonConfig(providerProfilePath, normalized);
        if (orchestrator.providerRouter) {
          orchestrator.providerRouter.profiles = normalized;
        }
        jsonResponse(res, 200, {
          provider_profiles: normalized
        });
        return;
      }

      if (method === "GET" && pathname === "/settings/rbac") {
        jsonResponse(res, 200, {
          rbac: {
            ...rbacConfig
          },
          available_roles: Object.values(RBAC_ROLES)
        });
        return;
      }

      if (method === "PUT" && pathname === "/settings/rbac") {
        const body = await parseJsonBody(req);
        const raw = isRecord(body.rbac) ? body.rbac : body;
        const normalized = normalizeRbacConfig(raw);
        writeJsonConfig(rbacConfigPath, normalized);
        rbacConfig.rbac_enabled = normalized.rbac_enabled;
        rbacConfig.default_roles = [...normalized.default_roles];
        jsonResponse(res, 200, {
          rbac: {
            ...rbacConfig
          },
          available_roles: Object.values(RBAC_ROLES)
        });
        return;
      }

      if (method === "GET" && pathname === "/settings/provider-secrets") {
        jsonResponse(res, 200, listProviderSecretsMasked());
        return;
      }

      if (method === "POST" && pathname === "/settings/provider-secrets") {
        const body = await parseJsonBody(req);
        const name = String(body.name || "").trim();
        const value = String(body.value || "");
        if (!name || !value) {
          badRequest(res, "name and value are required");
          return;
        }
        const vaultResult = createVaultInstance();
        if (!vaultResult.vault) {
          conflict(res, `Secret vault is unavailable: ${vaultResult.error || "VAULT_UNAVAILABLE"}`);
          return;
        }
        const actor = resolveRequestActor(body.actor, requestIdentity, "settings-api", forceIdentityActor);
        const secret = vaultResult.vault.upsertSecret(name, value, {
          actor,
          metadata: {
            source: "admin-ui"
          }
        });
        jsonResponse(res, 200, {
          secret,
          ...listProviderSecretsMasked()
        });
        return;
      }

      if (method === "GET" && pathname === "/tasks") {
        const state = requestUrl.searchParams.get("state") || "";
        const limit = parsePositiveInt(requestUrl.searchParams.get("limit"), 50, 500);
        const tasks = orchestrator.listTasks({
          state,
          limit
        });
        const summary = {};
        for (const task of tasks) {
          const taskState = String(task.state || "UNKNOWN");
          summary[taskState] = (summary[taskState] || 0) + 1;
        }
        jsonResponse(res, 200, {
          count: tasks.length,
          summary,
          tasks
        });
        return;
      }

      if (method === "POST" && pathname === "/tasks") {
        const body = await parseJsonBody(req);
        const actor = resolveRequestActor(body.actor, requestIdentity, "task-api", forceIdentityActor);
        const task = orchestrator.createTask({
          task_id: body.task_id || randomUUID(),
          trace_id: body.trace_id || randomUUID(),
          task_type: body.task_type || "generic",
          metadata: enrichMetadataWithIdentity(body.metadata || {}, requestIdentity, forceIdentityActor),
          actor,
          source: requestSource
        });
        jsonResponse(res, 201, {
          task
        });
        return;
      }

      const taskGetMatch = pathname.match(/^\/tasks\/([^/]+)$/);
      if (method === "GET" && taskGetMatch) {
        const taskId = decodeURIComponent(taskGetMatch[1]);
        const task = orchestrator.getTask(taskId);
        if (!task) {
          notFound(res, `Task not found: ${taskId}`);
          return;
        }
        jsonResponse(res, 200, { task });
        return;
      }

      const taskReplayMatch = pathname.match(/^\/tasks\/([^/]+)\/replay$/);
      if (method === "GET" && taskReplayMatch) {
        const taskId = decodeURIComponent(taskReplayMatch[1]);
        const history = orchestrator.getTaskHistory(taskId);
        if (!history.length) {
          notFound(res, `Task history not found: ${taskId}`);
          return;
        }
        const rebuilt = orchestrator.getTask(taskId);
        jsonResponse(res, 200, {
          task: rebuilt,
          events: history
        });
        return;
      }

      const taskTakeoverMatch = pathname.match(/^\/tasks\/([^/]+)\/takeover$/);
      if (method === "GET" && taskTakeoverMatch) {
        const taskId = decodeURIComponent(taskTakeoverMatch[1]);
        const takeover = orchestrator.getTakeover(taskId);
        if (!takeover) {
          notFound(res, `Takeover record not found: ${taskId}`);
          return;
        }
        jsonResponse(res, 200, { takeover });
        return;
      }

      const taskTakeoverActionMatch = pathname.match(/^\/tasks\/([^/]+)\/takeover\/actions$/);
      if (method === "POST" && taskTakeoverActionMatch) {
        const taskId = decodeURIComponent(taskTakeoverActionMatch[1]);
        const body = await parseJsonBody(req);
        const actor = resolveRequestActor(body.actor, requestIdentity, "human-operator", forceIdentityActor);
        const resolved = orchestrator.handleTakeoverAction({
          task_id: taskId,
          action: body.action,
          actor,
          note: body.note || "",
          metadata: enrichMetadataWithIdentity(body.metadata || {}, requestIdentity, forceIdentityActor)
        });
        jsonResponse(res, 200, resolved);
        return;
      }

      const taskDiscussionMatch = pathname.match(/^\/tasks\/([^/]+)\/discussion$/);
      if (method === "POST" && taskDiscussionMatch) {
        const taskId = decodeURIComponent(taskDiscussionMatch[1]);
        const body = await parseJsonBody(req);
        const actor = resolveRequestActor(body.actor, requestIdentity, "operator", forceIdentityActor);
        const discussion = orchestrator.runTaskDiscussion({
          task_id: taskId,
          prompt: body.prompt || "",
          participants: body.participants || [],
          quorum: Number.isInteger(body.quorum) ? body.quorum : 2,
          actor,
          source: requestSource
        });
        jsonResponse(res, 200, { discussion });
        return;
      }

      const taskDiscussionLatestMatch = pathname.match(/^\/tasks\/([^/]+)\/discussion\/latest$/);
      if (method === "GET" && taskDiscussionLatestMatch) {
        const taskId = decodeURIComponent(taskDiscussionLatestMatch[1]);
        const discussion = orchestrator.getLatestDiscussion(taskId);
        if (!discussion) {
          notFound(res, `Discussion not found: ${taskId}`);
          return;
        }
        jsonResponse(res, 200, { discussion });
        return;
      }

      const taskActionMatch = pathname.match(/^\/tasks\/([^/]+)\/actions$/);
      if (method === "POST" && taskActionMatch) {
        const taskId = decodeURIComponent(taskActionMatch[1]);
        const body = await parseJsonBody(req);
        const actor = resolveRequestActor(body.actor, requestIdentity, "human-operator", forceIdentityActor);
        const actionMetadata = enrichMetadataWithIdentity(body.metadata || {}, requestIdentity, forceIdentityActor);
        const currentTask = orchestrator.getTask(taskId);
        if (!currentTask) {
          notFound(res, `Task not found: ${taskId}`);
          return;
        }
        const action = toActionTransition(body.action);
        if (!action) {
          badRequest(res, "Unsupported action. Use APPROVE, RETRY, ABORT, TAKEOVER.");
          return;
        }
        let task = currentTask;
        const actionName = String(body.action || "").toUpperCase();
        const shouldSkipTransition = actionName === "TAKEOVER" && currentTask.state === TASK_STATES.RUNNING;
        if (!shouldSkipTransition) {
          task = orchestrator.transitionTask({
            task_id: taskId,
            to_state: action.to_state,
            actor,
            source: requestSource,
            reason: body.reason || action.reason,
            metadata: actionMetadata
          });
        }

        if (body.input) {
          try {
            const execution = await orchestrator.executeTask({
              task_id: taskId,
              provider: body.provider || "",
              fallback_providers: body.fallback_providers || [],
              model: body.model || "",
              input: body.input,
              actor,
              source: requestSource,
              metadata: actionMetadata,
              execution_options: body.execution_options || {}
            });
            jsonResponse(res, 200, {
              task: orchestrator.getTask(taskId),
              execution
            });
            return;
          } catch (err) {
            if (err instanceof ProviderExecutionError) {
              jsonResponse(res, err.status || 503, {
                error: err.code || "PROVIDER_EXECUTION_ERROR",
                message: err.message,
                task: orchestrator.getTask(taskId),
                takeover: err.takeover || orchestrator.getTakeover(taskId)
              });
              return;
            }
            throw err;
          }
        }

        jsonResponse(res, 200, { task });
        return;
      }

      if (method === "GET" && pathname === "/audit/events") {
        const taskId = requestUrl.searchParams.get("task_id") || "";
        const traceId = requestUrl.searchParams.get("trace_id") || "";

        if (!taskId && !traceId) {
          badRequest(res, "Provide query parameter task_id or trace_id.");
          return;
        }

        const events = taskId ? orchestrator.getTaskHistory(taskId) : orchestrator.getTraceHistory(traceId);
        jsonResponse(res, 200, {
          count: events.length,
          events
        });
        return;
      }

      if (method === "GET" && pathname === "/audit/integrity") {
        const integrity = orchestrator.verifyAuditIntegrity();
        const status = integrity.valid ? 200 : 409;
        jsonResponse(res, status, {
          integrity
        });
        return;
      }

      if (method === "GET" && pathname === "/routing/preview") {
        const ranking = await orchestrator.previewRouting({
          preferred_provider: requestUrl.searchParams.get("preferred_provider") || "",
          fallback_providers: (requestUrl.searchParams.get("fallback_providers") || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          routing_mode: requestUrl.searchParams.get("routing_mode") || "balanced",
          task_type: requestUrl.searchParams.get("task_type") || "generic",
          desired_model: requestUrl.searchParams.get("model") || ""
        });
        jsonResponse(res, 200, {
          count: ranking.length,
          ranking
        });
        return;
      }

      if (method === "POST" && pathname === "/ops/discovery/run") {
        const body = await parseJsonBody(req);
        const actor = resolveRequestActor(body.actor, requestIdentity, "operator", forceIdentityActor);
        const result = await orchestrator.runProviderDiscovery({
          actor,
          source: requestSource
        });
        jsonResponse(res, 200, result);
        return;
      }

      if (method === "GET" && pathname === "/ops/discovery/latest") {
        const snapshot = orchestrator.getLatestProviderDiscovery();
        if (!snapshot) {
          notFound(res, "No discovery snapshot found");
          return;
        }
        jsonResponse(res, 200, { snapshot });
        return;
      }

      if (method === "GET" && pathname === "/ops/alerts") {
        const status = requestUrl.searchParams.get("status") || "";
        const alerts = orchestrator.listProviderAlerts(status);
        jsonResponse(res, 200, {
          count: alerts.length,
          alerts
        });
        return;
      }

      if (method === "GET" && pathname === "/ops/audit-maintenance/latest") {
        const run = orchestrator.getLatestAuditMaintenanceRun();
        if (!run) {
          notFound(res, "No audit maintenance run found");
          return;
        }
        jsonResponse(res, 200, { run });
        return;
      }

      if (method === "GET" && pathname === "/ops/audit-maintenance/runs") {
        const status = requestUrl.searchParams.get("status") || "";
        const limit = parsePositiveInt(requestUrl.searchParams.get("limit"), 20, 500);
        const runs = orchestrator.listAuditMaintenanceRuns({
          status,
          limit
        });
        jsonResponse(res, 200, {
          count: runs.length,
          runs
        });
        return;
      }

      if (method === "GET" && pathname === "/ops/audit-maintenance/failures") {
        const limit = parsePositiveInt(requestUrl.searchParams.get("limit"), 100, 500);
        const summary = orchestrator.summarizeAuditMaintenanceFailures({
          limit
        });
        jsonResponse(res, 200, {
          summary
        });
        return;
      }

      const alertAckMatch = pathname.match(/^\/ops\/alerts\/([^/]+)\/ack$/);
      if (method === "POST" && alertAckMatch) {
        const alertId = decodeURIComponent(alertAckMatch[1]);
        const body = await parseJsonBody(req);
        const actor = resolveRequestActor(body.actor, requestIdentity, "operator", forceIdentityActor);
        const alert = orchestrator.acknowledgeProviderAlert({
          alert_id: alertId,
          actor,
          note: body.note || ""
        });
        if (!alert) {
          notFound(res, `Alert not found: ${alertId}`);
          return;
        }
        jsonResponse(res, 200, { alert });
        return;
      }

      if (method === "GET" && pathname === "/takeovers/pending") {
        const records = orchestrator.getPendingTakeovers();
        jsonResponse(res, 200, {
          count: records.length,
          records
        });
        return;
      }

      if (method === "POST" && pathname === "/integrations/im/events") {
        const body = await parseJsonBody(req);
        if (!body.task_id || !body.action) {
          badRequest(res, "task_id and action are required");
          return;
        }
        const actor = resolveRequestActor(body.actor, requestIdentity, "im-bot", forceIdentityActor);
        const resolved = orchestrator.handleTakeoverAction({
          task_id: body.task_id,
          action: body.action,
          actor,
          note: body.note || "",
          metadata: enrichMetadataWithIdentity(body.metadata || {}, requestIdentity, forceIdentityActor)
        });
        jsonResponse(res, 200, resolved);
        return;
      }

      if (method === "GET" || method === "POST" || method === "PUT") {
        notFound(res);
        return;
      }

      methodNotAllowed(res);
    } catch (err) {
      if (err instanceof AuthError) {
        jsonResponse(res, err.status || 401, {
          error: err.code || "AUTH_REQUIRED",
          message: err.message
        });
        return;
      }
      if (err instanceof ValidationError) {
        conflict(res, err.message);
        return;
      }
      if (err instanceof ProviderExecutionError) {
        jsonResponse(res, err.status || 503, {
          error: err.code || "PROVIDER_EXECUTION_ERROR",
          message: err.message,
          takeover: err.takeover || null
        });
        return;
      }
      if (err && err.message && (err.message.includes("Invalid JSON") || err.message.includes("too large"))) {
        badRequest(res, err.message);
        return;
      }
      serverError(res, err && err.message ? err.message : "Unknown error");
    }
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        resolve({
          host,
          port: typeof address === "object" && address ? address.port : port
        });
      });
    });
  }

  function stop() {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (managedRuntimeDatabase && typeof managedRuntimeDatabase.close === "function") {
          try {
            managedRuntimeDatabase.close();
          } catch {
            // ignore close errors on shutdown
          } finally {
            managedRuntimeDatabase = null;
          }
        }
        resolve();
      });
    });
  }

  return {
    orchestrator,
    server,
    start,
    stop
  };
}

if (require.main === module) {
  const app = createTaskApiServer();
  app
    .start()
    .then(({ host, port }) => {
      // eslint-disable-next-line no-console
      console.log(`Task API listening on http://${host}:${port}`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  createTaskApiServer
};
