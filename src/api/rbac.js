const fs = require("fs");

const RBAC_ROLES = Object.freeze({
  SUPER_ADMIN: "super_admin",
  TASK_ADMIN: "task_admin",
  READ_ONLY_AUDITOR: "read_only_auditor"
});

const DEFAULT_RBAC_CONFIG = Object.freeze({
  rbac_enabled: false,
  default_roles: [RBAC_ROLES.SUPER_ADMIN]
});

const ALL_ROLES = Object.freeze([
  RBAC_ROLES.SUPER_ADMIN,
  RBAC_ROLES.TASK_ADMIN,
  RBAC_ROLES.READ_ONLY_AUDITOR
]);

const DEFAULT_ROUTE_RULES = Object.freeze([
  { id: "health_read", method: "GET", pattern: /^\/health$/, roles: ALL_ROLES },
  { id: "admin_ui_read", method: "GET", pattern: /^\/admin(?:\/.*)?$/, roles: ALL_ROLES },
  { id: "task_list_read", method: "GET", pattern: /^\/tasks$/, roles: ALL_ROLES },
  { id: "settings_flags_read", method: "GET", pattern: /^\/settings\/feature-flags$/, roles: ALL_ROLES },
  { id: "settings_profiles_read", method: "GET", pattern: /^\/settings\/provider-profiles$/, roles: ALL_ROLES },
  { id: "settings_rbac_read", method: "GET", pattern: /^\/settings\/rbac$/, roles: ALL_ROLES },
  { id: "settings_secrets_read", method: "GET", pattern: /^\/settings\/provider-secrets$/, roles: ALL_ROLES },
  { id: "audit_read", method: "GET", pattern: /^\/audit\/(events|integrity)$/, roles: ALL_ROLES },
  { id: "routing_preview", method: "GET", pattern: /^\/routing\/preview$/, roles: ALL_ROLES },
  { id: "task_read", method: "GET", pattern: /^\/tasks\/[^/]+$/, roles: ALL_ROLES },
  { id: "task_replay", method: "GET", pattern: /^\/tasks\/[^/]+\/replay$/, roles: ALL_ROLES },
  { id: "task_takeover_read", method: "GET", pattern: /^\/tasks\/[^/]+\/takeover$/, roles: ALL_ROLES },
  { id: "task_discussion_read", method: "GET", pattern: /^\/tasks\/[^/]+\/discussion\/latest$/, roles: ALL_ROLES },
  { id: "takeovers_read", method: "GET", pattern: /^\/takeovers\/pending$/, roles: ALL_ROLES },
  { id: "ops_discovery_latest", method: "GET", pattern: /^\/ops\/discovery\/latest$/, roles: ALL_ROLES },
  { id: "ops_alerts_read", method: "GET", pattern: /^\/ops\/alerts$/, roles: ALL_ROLES },
  { id: "ops_maint_read", method: "GET", pattern: /^\/ops\/audit-maintenance\/(latest|runs|failures)$/, roles: ALL_ROLES },
  {
    id: "settings_flags_write",
    method: "PUT",
    pattern: /^\/settings\/feature-flags$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "settings_profiles_write",
    method: "PUT",
    pattern: /^\/settings\/provider-profiles$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "settings_rbac_write",
    method: "PUT",
    pattern: /^\/settings\/rbac$/,
    roles: [RBAC_ROLES.SUPER_ADMIN]
  },
  {
    id: "settings_secrets_write",
    method: "POST",
    pattern: /^\/settings\/provider-secrets$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "task_write",
    method: "POST",
    pattern: /^\/tasks$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "task_action_write",
    method: "POST",
    pattern: /^\/tasks\/[^/]+\/actions$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "task_takeover_write",
    method: "POST",
    pattern: /^\/tasks\/[^/]+\/takeover\/actions$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "task_discussion_write",
    method: "POST",
    pattern: /^\/tasks\/[^/]+\/discussion$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "integration_im_write",
    method: "POST",
    pattern: /^\/integrations\/im\/events$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  },
  {
    id: "ops_discovery_run",
    method: "POST",
    pattern: /^\/ops\/discovery\/run$/,
    roles: [RBAC_ROLES.SUPER_ADMIN]
  },
  {
    id: "ops_alert_ack",
    method: "POST",
    pattern: /^\/ops\/alerts\/[^/]+\/ack$/,
    roles: [RBAC_ROLES.SUPER_ADMIN, RBAC_ROLES.TASK_ADMIN]
  }
]);

function normalizeRoles(input = []) {
  const source = Array.isArray(input) ? input : [input];
  return source
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => ALL_ROLES.includes(item));
}

function normalizeRbacConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_RBAC_CONFIG };
  }
  return {
    rbac_enabled: raw.rbac_enabled === true,
    default_roles: normalizeRoles(raw.default_roles || DEFAULT_RBAC_CONFIG.default_roles)
  };
}

function loadRbacConfig(path = "config/rbac_policy.json") {
  if (!fs.existsSync(path)) {
    return { ...DEFAULT_RBAC_CONFIG };
  }
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return normalizeRbacConfig(raw);
}

function resolveAllowedRoles(method, pathname, config) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedPath = String(pathname || "");
  for (const rule of DEFAULT_ROUTE_RULES) {
    if (rule.method !== normalizedMethod) {
      continue;
    }
    if (rule.pattern.test(normalizedPath)) {
      return {
        rule_id: rule.id,
        allowed_roles: rule.roles
      };
    }
  }
  return {
    rule_id: "default",
    allowed_roles: config.default_roles.length > 0
      ? config.default_roles
      : [RBAC_ROLES.SUPER_ADMIN]
  };
}

function authorizeRequest({
  method,
  pathname,
  identity,
  config = DEFAULT_RBAC_CONFIG
}) {
  const effectiveConfig = normalizeRbacConfig(config);
  if (effectiveConfig.rbac_enabled !== true) {
    return {
      allowed: true,
      reason: "RBAC_DISABLED",
      rule_id: "rbac-disabled",
      allowed_roles: []
    };
  }
  const roles = identity && Array.isArray(identity.roles)
    ? normalizeRoles(identity.roles)
    : [...effectiveConfig.default_roles];
  const policy = resolveAllowedRoles(method, pathname, effectiveConfig);
  const matched = roles.some((role) => policy.allowed_roles.includes(role));
  return {
    allowed: matched,
    reason: matched ? "ALLOWED" : "ROLE_FORBIDDEN",
    rule_id: policy.rule_id,
    allowed_roles: policy.allowed_roles,
    identity_roles: roles
  };
}

module.exports = {
  ALL_ROLES,
  DEFAULT_RBAC_CONFIG,
  RBAC_ROLES,
  authorizeRequest,
  loadRbacConfig,
  normalizeRbacConfig,
  normalizeRoles
};
