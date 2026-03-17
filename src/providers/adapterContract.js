const { ValidationError } = require("../platform/contracts");

const PROVIDERS = Object.freeze({
  OPENAI: "openai",
  GEMINI: "gemini",
  CLAUDE: "claude",
  LOCAL: "local"
});

const PROVIDER_FLAG_MAP = Object.freeze({
  [PROVIDERS.OPENAI]: "openai_adapter_enabled",
  [PROVIDERS.GEMINI]: "gemini_adapter_enabled",
  [PROVIDERS.CLAUDE]: "claude_adapter_enabled",
  [PROVIDERS.LOCAL]: "local_model_adapter_enabled"
});

class ProviderExecutionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderExecutionError";
    this.code = options.code || "PROVIDER_EXECUTION_ERROR";
    this.provider = options.provider || "";
    this.retryable = options.retryable !== false;
    this.status = options.status || 502;
  }
}

function ensure(condition, message) {
  if (!condition) {
    throw new ValidationError(message);
  }
}

function validateAdapter(adapter) {
  ensure(adapter && typeof adapter === "object", "adapter must be an object");
  ensure(typeof adapter.name === "string" && adapter.name.trim() !== "", "adapter.name is required");
  ensure(Object.values(PROVIDERS).includes(adapter.name), `unsupported adapter name: ${adapter.name}`);
  ensure(typeof adapter.execute === "function", "adapter.execute must be a function");
  ensure(typeof adapter.healthCheck === "function", "adapter.healthCheck must be a function");
}

function validateExecutionRequest(request) {
  ensure(request && typeof request === "object", "execution request is required");
  ensure(typeof request.task_id === "string" && request.task_id.trim() !== "", "request.task_id is required");
  ensure(typeof request.trace_id === "string" && request.trace_id.trim() !== "", "request.trace_id is required");
  ensure(typeof request.input === "string" && request.input.trim() !== "", "request.input is required");
}

function createStubExecutionResult({
  provider,
  task_id,
  trace_id,
  model,
  input,
  message
}) {
  return {
    provider,
    task_id,
    trace_id,
    model,
    status: "STUB_NOT_IMPLEMENTED",
    output: "",
    message,
    usage: {
      input_chars: input.length,
      output_chars: 0
    }
  };
}

function shouldSimulateProviderFailure(provider, request) {
  return Boolean(resolveSimulationFailure(provider, request));
}

function resolveSimulationFailure(provider, request) {
  const simulation = request && request.simulation ? request.simulation : {};
  if (simulation.fail_all === true) {
    return {
      message: `Simulated provider failure: ${provider}`,
      code: "SIMULATED_PROVIDER_FAILURE",
      retryable: true,
      status: 503
    };
  }

  const timeoutProviders = Array.isArray(simulation.timeout_providers) ? simulation.timeout_providers : [];
  if (timeoutProviders.includes(provider)) {
    return {
      message: `Simulated provider timeout: ${provider}`,
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      status: 504
    };
  }

  const rateLimitProviders = Array.isArray(simulation.rate_limit_providers) ? simulation.rate_limit_providers : [];
  if (rateLimitProviders.includes(provider)) {
    return {
      message: `Simulated provider rate limit: ${provider}`,
      code: "RATE_LIMITED",
      retryable: true,
      status: 429
    };
  }

  const invalidKeyProviders = Array.isArray(simulation.invalid_key_providers) ? simulation.invalid_key_providers : [];
  if (invalidKeyProviders.includes(provider)) {
    return {
      message: `Simulated provider key invalid: ${provider}`,
      code: "KEY_INVALID",
      retryable: true,
      status: 401
    };
  }

  const providerFailures = simulation.failure_by_provider && typeof simulation.failure_by_provider === "object"
    ? simulation.failure_by_provider
    : {};
  if (providerFailures[provider] && typeof providerFailures[provider] === "object") {
    const failure = providerFailures[provider];
    return {
      message: failure.message || `Simulated provider failure: ${provider}`,
      code: failure.code || "SIMULATED_PROVIDER_FAILURE",
      retryable: failure.retryable !== false,
      status: Number.isInteger(failure.status) ? failure.status : 503
    };
  }

  const failProviders = Array.isArray(simulation.fail_providers) ? simulation.fail_providers : [];
  if (failProviders.includes(provider)) {
    return {
      message: `Simulated provider failure: ${provider}`,
      code: "SIMULATED_PROVIDER_FAILURE",
      retryable: true,
      status: 503
    };
  }
  return null;
}

function maybeSimulateProviderFailure(provider, request) {
  const failure = resolveSimulationFailure(provider, request);
  if (!failure) {
    return;
  }
  throw new ProviderExecutionError(failure.message, {
    provider,
    code: failure.code,
    retryable: failure.retryable,
    status: failure.status
  });
}

module.exports = {
  PROVIDERS,
  ProviderExecutionError,
  PROVIDER_FLAG_MAP,
  createStubExecutionResult,
  maybeSimulateProviderFailure,
  resolveSimulationFailure,
  shouldSimulateProviderFailure,
  validateAdapter,
  validateExecutionRequest
};
