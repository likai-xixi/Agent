const {
  PROVIDERS,
  PROVIDER_FLAG_MAP,
  ProviderExecutionError,
  validateAdapter,
  validateExecutionRequest
} = require("./adapterContract");
const { createClaudeAdapter } = require("./claudeAdapter");
const { createGeminiAdapter } = require("./geminiAdapter");
const { createLocalAdapter } = require("./localAdapter");
const { createOpenAIAdapter } = require("./openaiAdapter");
const { DEFAULT_PROVIDER_ORDER, ProviderRegistry, buildDefaultProviderRegistry } = require("./providerRegistry");

module.exports = {
  DEFAULT_PROVIDER_ORDER,
  PROVIDERS,
  PROVIDER_FLAG_MAP,
  ProviderExecutionError,
  ProviderRegistry,
  buildDefaultProviderRegistry,
  createClaudeAdapter,
  createGeminiAdapter,
  createLocalAdapter,
  createOpenAIAdapter,
  validateAdapter,
  validateExecutionRequest
};
