const fs = require("fs");

const DEFAULT_FLAGS = Object.freeze({
  fallback_engine_enabled: false,
  takeover_engine_enabled: false,
  discussion_engine_enabled: false,
  adaptive_routing_enabled: false,
  openai_adapter_enabled: false,
  gemini_adapter_enabled: false,
  claude_adapter_enabled: false,
  local_model_adapter_enabled: true
});

function fromMapping(mapping) {
  const result = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_FLAGS)) {
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      result[key] = Boolean(mapping[key]);
    } else {
      result[key] = defaultValue;
    }
  }
  return result;
}

function highRiskFlagsDisabled(flags) {
  return !(
    flags.fallback_engine_enabled ||
    flags.takeover_engine_enabled ||
    flags.discussion_engine_enabled ||
    flags.adaptive_routing_enabled ||
    flags.openai_adapter_enabled ||
    flags.gemini_adapter_enabled ||
    flags.claude_adapter_enabled
  );
}

function loadFeatureFlags(path = "config/feature_flags.json") {
  if (!fs.existsSync(path)) {
    return { ...DEFAULT_FLAGS };
  }
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_FLAGS };
  }
  return fromMapping(raw);
}

module.exports = {
  DEFAULT_FLAGS,
  fromMapping,
  highRiskFlagsDisabled,
  loadFeatureFlags
};
