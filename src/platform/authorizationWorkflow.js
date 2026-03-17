const path = require("path");
const { randomUUID } = require("crypto");

const { ValidationError, nowUtcIso } = require("./contracts");
const { ensureDir, readJsonFile, resolveDataPath, writeJsonFile } = require("./appPaths");
const { JsonFilePolicyStore } = require("./policyStore");

class AuthorizationRequiredError extends ValidationError {
  constructor(message, options = {}) {
    super(message);
    this.name = "AuthorizationRequiredError";
    this.code = options.code || "AUTHORIZATION_REQUIRED";
    this.status = options.status || 202;
    this.request = options.request || null;
  }
}

class JsonFileAuthorizationRequestStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("authorization-requests.json");
    ensureDir(path.dirname(this.filePath));
    if (!readJsonFile(this.filePath, null)) {
      writeJsonFile(this.filePath, {
        requests: []
      });
    }
  }

  readState() {
    return readJsonFile(this.filePath, { requests: [] });
  }

  writeState(state) {
    writeJsonFile(this.filePath, state);
  }

  save(request) {
    const state = this.readState();
    const requests = state.requests.filter((item) => item.request_id !== request.request_id);
    requests.push(JSON.parse(JSON.stringify(request)));
    this.writeState({
      requests
    });
    return JSON.parse(JSON.stringify(request));
  }

  get(requestId) {
    const record = this.readState().requests.find((item) => item.request_id === requestId);
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  list(status = "") {
    const normalizedStatus = String(status || "").trim().toUpperCase();
    return this.readState().requests
      .filter((item) => !normalizedStatus || String(item.status || "").toUpperCase() === normalizedStatus)
      .map((item) => JSON.parse(JSON.stringify(item)));
  }
}

function inferPermanentGrant(note = "") {
  const normalized = String(note || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /以后.*准了|永久|permanent|always allow|allow future|always approve/.test(normalized);
}

class AuthorizationWorkflowManager {
  constructor(options = {}) {
    this.policyStore = options.policyStore || new JsonFilePolicyStore(options.policyStoreOptions || {});
    this.requestStore = options.requestStore || new JsonFileAuthorizationRequestStore(options.requestStoreOptions || {});
    this.notifier = options.notifier || null;
  }

  async requestAuthorization({
    trace_id,
    task_id,
    request_type,
    resource,
    actor = "system",
    options = {},
    rationale = ""
  }) {
    const request = {
      request_id: randomUUID(),
      trace_id,
      task_id,
      request_type: String(request_type || "").trim().toUpperCase(),
      resource,
      actor,
      options,
      rationale,
      status: "PENDING",
      created_at: nowUtcIso(),
      resolved_at: "",
      resolved_by: "",
      note: ""
    };
    this.requestStore.save(request);
    if (this.notifier && typeof this.notifier.sendAuthorizationRequired === "function") {
      request.notification = await this.notifier.sendAuthorizationRequired(request);
      this.requestStore.save(request);
    }
    return request;
  }

  async ensurePathAuthorized({
    trace_id,
    task_id,
    actor = "local-runner",
    targetPath,
    workspaceRoot
  }) {
    const decision = this.policyStore.isPathAllowed(targetPath, {
      workspaceRoot
    });
    if (decision.allowed) {
      if (decision.rule && decision.rule.mode === "single") {
        this.policyStore.consumeRule(decision.rule.rule_id);
      }
      return {
        authorized: true,
        reason: decision.reason
      };
    }
    const request = await this.requestAuthorization({
      trace_id,
      task_id,
      request_type: "PATH_ACCESS",
      resource: {
        target_path: path.resolve(targetPath),
        workspace_root: workspaceRoot ? path.resolve(workspaceRoot) : ""
      },
      actor,
      options: {
        grant_modes: ["single", "permanent"]
      },
      rationale: "Path is outside the workspace root and requires explicit approval."
    });
    throw new AuthorizationRequiredError(
      `Path access requires approval: ${path.resolve(targetPath)}`,
      {
        request
      }
    );
  }

  async ensureBudgetApproved({
    trace_id,
    task_id,
    actor = "orchestrator",
    estimated_cost
  }) {
    const request = await this.requestAuthorization({
      trace_id,
      task_id,
      request_type: "BUDGET_OVERRIDE",
      resource: {
        estimated_cost
      },
      actor,
      options: {
        grant_modes: ["single"]
      },
      rationale: "Estimated task cost exceeded the configured single-task threshold."
    });
    throw new AuthorizationRequiredError(
      `Estimated task cost requires approval: $${Number(estimated_cost || 0).toFixed(3)}`,
      {
        code: "BUDGET_CONFIRMATION_REQUIRED",
        request
      }
    );
  }

  resolveRequest({
    request_id,
    action,
    actor = "operator",
    note = "",
    mode = ""
  }) {
    const request = this.requestStore.get(request_id);
    if (!request) {
      throw new ValidationError(`Authorization request not found: ${request_id}`);
    }
    if (request.status !== "PENDING") {
      throw new ValidationError(`Authorization request already resolved: ${request_id}`);
    }
    const normalizedAction = String(action || "").trim().toUpperCase();
    if (!["APPROVE", "DENY"].includes(normalizedAction)) {
      throw new ValidationError(`Unsupported authorization action: ${action}`);
    }

    const normalizedMode = String(mode || "").trim().toLowerCase();
    const resolved = {
      ...request,
      status: normalizedAction === "APPROVE" ? "APPROVED" : "DENIED",
      resolved_at: nowUtcIso(),
      resolved_by: actor,
      note
    };

    if (resolved.status === "APPROVED" && request.request_type === "PATH_ACCESS") {
      const grantMode = inferPermanentGrant(note)
        ? "permanent"
        : (normalizedMode === "permanent" ? "permanent" : "single");
      this.policyStore.grantPathAccess(request.resource.target_path, {
        mode: grantMode,
        actor,
        trace_id: request.trace_id
      });
    }

    this.requestStore.save(resolved);
    return resolved;
  }
}

module.exports = {
  AuthorizationRequiredError,
  AuthorizationWorkflowManager,
  JsonFileAuthorizationRequestStore,
  inferPermanentGrant
};
