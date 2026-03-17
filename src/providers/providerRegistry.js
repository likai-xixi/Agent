const { ValidationError } = require("../platform/contracts");
const { loadFeatureFlags } = require("../platform/featureFlags");
const {
  PROVIDERS,
  PROVIDER_FLAG_MAP,
  ProviderExecutionError,
  validateAdapter
} = require("./adapterContract");
const { createClaudeAdapter } = require("./claudeAdapter");
const { createGeminiAdapter } = require("./geminiAdapter");
const { createLocalAdapter } = require("./localAdapter");
const { createOpenAIAdapter } = require("./openaiAdapter");

const DEFAULT_PROVIDER_ORDER = Object.freeze([PROVIDERS.LOCAL, PROVIDERS.OPENAI, PROVIDERS.GEMINI, PROVIDERS.CLAUDE]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class ProviderRegistry {
  constructor(options = {}) {
    this.flags = options.flags || loadFeatureFlags(options.flagPath);
    this.healthOverrides = { ...(options.healthOverrides || {}) };
    this.adapters = new Map();
  }

  registerAdapter(adapter) {
    validateAdapter(adapter);
    this.adapters.set(adapter.name, adapter);
  }

  getRegisteredProviders() {
    return [...this.adapters.keys()];
  }

  isProviderEnabled(providerName) {
    const flagKey = PROVIDER_FLAG_MAP[providerName];
    if (!flagKey) {
      return false;
    }
    return Boolean(this.flags[flagKey]);
  }

  getEnabledProviders() {
    return this.getRegisteredProviders().filter((name) => this.isProviderEnabled(name));
  }

  getAdapter(providerName) {
    const adapter = this.adapters.get(providerName);
    if (!adapter) {
      throw new ValidationError(`Provider adapter not registered: ${providerName}`);
    }
    if (!this.isProviderEnabled(providerName)) {
      throw new ValidationError(`Provider is disabled by feature flag: ${providerName}`);
    }
    return adapter;
  }

  async getProviderHealth(providerName) {
    const adapter = this.getAdapter(providerName);
    const baseHealth = await adapter.healthCheck();
    const override = this.healthOverrides[providerName] || {};
    return {
      ...baseHealth,
      ...override
    };
  }

  async getEnabledProviderHealth() {
    const enabled = this.getEnabledProviders();
    const result = [];
    for (const provider of enabled) {
      const health = await this.getProviderHealth(provider);
      result.push(health);
    }
    return result;
  }

  setProviderHealthOverride(providerName, override) {
    this.healthOverrides[providerName] = {
      ...(this.healthOverrides[providerName] || {}),
      ...override
    };
  }

  clearProviderHealthOverride(providerName) {
    delete this.healthOverrides[providerName];
  }

  selectProvider({ preferredProvider = "", fallbackProviders = [] } = {}) {
    const candidates = [];
    if (preferredProvider) {
      candidates.push(preferredProvider);
    }
    for (const item of fallbackProviders) {
      if (!candidates.includes(item)) {
        candidates.push(item);
      }
    }
    for (const item of DEFAULT_PROVIDER_ORDER) {
      if (!candidates.includes(item)) {
        candidates.push(item);
      }
    }

    for (const candidate of candidates) {
      if (this.adapters.has(candidate) && this.isProviderEnabled(candidate)) {
        return candidate;
      }
    }
    throw new ValidationError("No enabled provider adapters available");
  }

  async execute({
    provider = "",
    fallbackProviders = [],
    request
  }) {
    const selected = provider
      ? provider
      : this.selectProvider({
          preferredProvider: "",
          fallbackProviders
        });
    const adapter = this.getAdapter(selected);
    try {
      const result = await adapter.execute(request);
      return {
        selected_provider: selected,
        result: clone(result)
      };
    } catch (err) {
      if (err instanceof ProviderExecutionError) {
        throw err;
      }
      throw new ProviderExecutionError(err && err.message ? err.message : "Provider execution failed", {
        provider: selected,
        code: "PROVIDER_EXECUTION_ERROR",
        retryable: true,
        status: 502
      });
    }
  }
}

function buildDefaultProviderRegistry(options = {}) {
  const registry = new ProviderRegistry(options);
  registry.registerAdapter(createOpenAIAdapter(options.openai || {}));
  registry.registerAdapter(createGeminiAdapter(options.gemini || {}));
  registry.registerAdapter(createClaudeAdapter(options.claude || {}));
  registry.registerAdapter(createLocalAdapter(options.local || {}));
  return registry;
}

module.exports = {
  DEFAULT_PROVIDER_ORDER,
  PROVIDERS,
  ProviderRegistry,
  buildDefaultProviderRegistry
};
