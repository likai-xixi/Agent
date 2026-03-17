const fs = require("fs");

const DEFAULT_PROFILE_PATH = "config/provider_profiles.json";

function loadProviderProfiles(path = DEFAULT_PROFILE_PATH) {
  if (!fs.existsSync(path)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return raw;
}

function modeWeights(mode) {
  if (mode === "cost") {
    return {
      health: 0.3,
      latency: 0.1,
      cost: 0.6
    };
  }
  if (mode === "performance") {
    return {
      health: 0.4,
      latency: 0.5,
      cost: 0.1
    };
  }
  return {
    health: 0.5,
    latency: 0.2,
    cost: 0.3
  };
}

function normalizeLatency(latencyMs) {
  if (!latencyMs || latencyMs <= 0) {
    return 0.5;
  }
  return 1 / (1 + latencyMs / 1000);
}

function normalizeCost(costPer1kTokens) {
  if (!costPer1kTokens || costPer1kTokens <= 0) {
    return 1;
  }
  return 1 / (1 + costPer1kTokens * 30);
}

class AdaptiveProviderRouter {
  constructor(options = {}) {
    this.profiles = options.profiles || loadProviderProfiles(options.profilePath || DEFAULT_PROFILE_PATH);
  }

  scoreProvider({
    provider,
    health = {},
    mode = "balanced",
    preferredProvider = "",
    fallbackProviders = []
  }) {
    const profile = this.profiles[provider] || {};
    const weights = modeWeights(mode);
    const healthScore = health.healthy === false ? 0 : Number(health.score || 0.7);
    const latencyScore = normalizeLatency(Number(health.latency_ms || 0));
    const costScore = normalizeCost(Number(profile.cost_per_1k_tokens || 0.02));
    const preferredBoost = preferredProvider === provider ? 0.12 : 0;
    const fallbackBoost = fallbackProviders.includes(provider) ? 0.06 : 0;
    const baseScore = healthScore * weights.health + latencyScore * weights.latency + costScore * weights.cost;
    return baseScore + preferredBoost + fallbackBoost;
  }

  rankProviders({
    enabledProviders,
    healthList,
    mode = "balanced",
    preferredProvider = "",
    fallbackProviders = [],
    desiredModel = "",
    taskType = "generic"
  }) {
    const healthMap = {};
    for (const item of healthList || []) {
      healthMap[item.provider] = item;
    }

    const ranked = enabledProviders
      .map((provider) => {
        const health = healthMap[provider] || {
          provider,
          healthy: true,
          score: 0.7,
          latency_ms: 300
        };
        const score = this.scoreProvider({
          provider,
          health,
          mode,
          preferredProvider,
          fallbackProviders
        });
        return {
          provider,
          score,
          health,
          model: this.selectModel({
            provider,
            taskType,
            desiredModel
          }),
          cost_per_1k_tokens: Number((this.profiles[provider] || {}).cost_per_1k_tokens || 0.02)
        };
      })
      .sort((a, b) => b.score - a.score);

    return ranked;
  }

  selectModel({
    provider,
    desiredModel = "",
    taskType = "generic"
  }) {
    if (desiredModel) {
      return desiredModel;
    }
    const profile = this.profiles[provider] || {};
    const byTaskType = profile.models_by_task_type || {};
    if (byTaskType[taskType]) {
      return byTaskType[taskType];
    }
    return profile.default_model || "default-model";
  }
}

module.exports = {
  AdaptiveProviderRouter,
  DEFAULT_PROFILE_PATH,
  loadProviderProfiles
};

