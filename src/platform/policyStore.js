const path = require("path");
const { randomUUID } = require("crypto");

const { nowUtcIso } = require("./contracts");
const { ensureDir, readJsonFile, resolveDataPath, writeJsonFile } = require("./appPaths");
const { resolvePhysicalPath, startsWithPathPrefix } = require("./physicalPaths");

const PATH_RULE_SCOPE = "PATH_ACCESS";
const SKILL_RULE_SCOPE = "SKILL_LEVEL";
const BUDGET_RULE_SCOPE = "BUDGET_OVERRIDE";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRulePath(targetPath) {
  return resolvePhysicalPath(targetPath).physical_path.toLowerCase();
}

class JsonFilePolicyStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("policies.json");
    ensureDir(path.dirname(this.filePath));
    if (!readJsonFile(this.filePath, null)) {
      writeJsonFile(this.filePath, {
        rules: []
      });
    }
  }

  readState() {
    return readJsonFile(this.filePath, { rules: [] });
  }

  writeState(state) {
    writeJsonFile(this.filePath, state);
  }

  listRules(scope = "") {
    const normalizedScope = String(scope || "").trim().toUpperCase();
    return this.readState().rules
      .filter((item) => !normalizedScope || item.scope === normalizedScope)
      .map((item) => clone(item));
  }

  saveRule(rule) {
    const state = this.readState();
    const rules = state.rules.filter((item) => item.rule_id !== rule.rule_id);
    rules.push(clone(rule));
    this.writeState({
      rules
    });
    return clone(rule);
  }

  grantPathAccess(targetPath, options = {}) {
    const normalizedPath = normalizeRulePath(targetPath);
    const mode = options.mode === "permanent" ? "permanent" : "single";
    return this.saveRule({
      rule_id: options.rule_id || randomUUID(),
      scope: PATH_RULE_SCOPE,
      decision: "allow",
      mode,
      selector: {
        path_prefix: normalizedPath
      },
      remaining_uses: mode === "single" ? 1 : null,
      created_by: options.actor || "operator",
      created_at: nowUtcIso(),
      trace_id: options.trace_id || ""
    });
  }

  isPathAllowed(targetPath, options = {}) {
    const normalizedTarget = normalizeRulePath(targetPath);
    const workspaceRoot = String(options.workspaceRoot || "").trim()
      ? resolvePhysicalPath(options.workspaceRoot).physical_path
      : "";
    if (workspaceRoot && startsWithPathPrefix(normalizedTarget, workspaceRoot)) {
      return {
        allowed: true,
        reason: "WORKSPACE_SCOPE"
      };
    }
    const state = this.readState();
    for (const rule of state.rules) {
      if (rule.scope !== PATH_RULE_SCOPE || rule.decision !== "allow") {
        continue;
      }
      const prefix = normalizeRulePath(rule.selector && rule.selector.path_prefix ? rule.selector.path_prefix : "");
      if (!prefix || !startsWithPathPrefix(normalizedTarget, prefix)) {
        continue;
      }
      if (rule.mode === "single" && Number(rule.remaining_uses || 0) <= 0) {
        continue;
      }
      return {
        allowed: true,
        reason: rule.mode === "permanent" ? "POLICY_PERMANENT_ALLOW" : "POLICY_SINGLE_ALLOW",
        rule
      };
    }
    return {
      allowed: false,
      reason: "AUTHORIZATION_REQUIRED"
    };
  }

  consumeRule(ruleId) {
    const state = this.readState();
    let updated = null;
    const rules = state.rules.map((item) => {
      if (item.rule_id !== ruleId) {
        return item;
      }
      if (item.mode !== "single") {
        updated = item;
        return item;
      }
      const next = {
        ...item,
        remaining_uses: Math.max(0, Number(item.remaining_uses || 0) - 1)
      };
      updated = next;
      return next;
    });
    this.writeState({
      rules
    });
    return updated ? clone(updated) : null;
  }
}

module.exports = {
  BUDGET_RULE_SCOPE,
  JsonFilePolicyStore,
  PATH_RULE_SCOPE,
  SKILL_RULE_SCOPE
};
