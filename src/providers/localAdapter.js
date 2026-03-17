const {
  ProviderExecutionError,
  createStubExecutionResult,
  maybeSimulateProviderFailure,
  validateExecutionRequest
} = require("./adapterContract");
const { requestJsonWithRetry } = require("./httpJsonClient");

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "");
}

function toArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value;
}

function resolveLocalRuntimeUrl(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "runtimeUrl")) {
    return normalizeBaseUrl(options.runtimeUrl);
  }
  if (options.useEnvRuntime === true) {
    return normalizeBaseUrl(process.env.LOCAL_MODEL_RUNTIME_URL || process.env.OLLAMA_BASE_URL || "");
  }
  return "";
}

function resolveCapacitySignals(options = {}, body = null) {
  const models = body && Array.isArray(body.models)
    ? body.models
        .map((item) => {
          if (item && typeof item.name === "string") {
            return item.name;
          }
          return "";
        })
        .filter(Boolean)
    : [];
  return {
    max_concurrency: parsePositiveInt(options.maxConcurrency || process.env.LOCAL_MODEL_MAX_CONCURRENCY || 2, 2),
    queue_depth: parseNonNegativeInt(options.queueDepth || process.env.LOCAL_MODEL_QUEUE_DEPTH || 0, 0),
    available_models: models
  };
}

function normalizeLocalError(error) {
  const status = Number(error && error.status ? error.status : 0);
  const code = String(error && error.code ? error.code : "").toUpperCase();
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || status === 502 || status === 503) {
    return new ProviderExecutionError("Local runtime is unavailable", {
      provider: "local",
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      status: 503
    });
  }
  if (status === 404) {
    return new ProviderExecutionError("Local model endpoint or model is not found", {
      provider: "local",
      code: "MODEL_NOT_FOUND",
      retryable: false,
      status: 404
    });
  }
  if (status === 429) {
    return new ProviderExecutionError("Local runtime is saturated", {
      provider: "local",
      code: "RATE_LIMITED",
      retryable: true,
      status: 429
    });
  }
  if (status === 504 || code === "PROVIDER_TIMEOUT") {
    return new ProviderExecutionError("Local runtime request timed out", {
      provider: "local",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      status: 504
    });
  }
  if (status >= 500) {
    return new ProviderExecutionError("Local runtime service error", {
      provider: "local",
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      status
    });
  }
  return new ProviderExecutionError(error && error.message ? error.message : "Local runtime execution failed", {
    provider: "local",
    code: error && error.code ? error.code : "PROVIDER_EXECUTION_ERROR",
    retryable: error && Object.prototype.hasOwnProperty.call(error, "retryable")
      ? error.retryable !== false
      : true,
    status: status || 502
  });
}

function createLocalAdapter(options = {}) {
  const defaultModel = options.defaultModel || "llama3.1:8b";
  const runtimeUrl = resolveLocalRuntimeUrl(options);
  const generatePath = String(options.generatePath || "/api/generate");
  const healthPath = String(options.healthPath || "/api/tags");
  const timeoutMs = parsePositiveInt(options.timeoutMs || process.env.LOCAL_MODEL_TIMEOUT_MS || 12000, 12000);
  const maxRetries = parseNonNegativeInt(options.maxRetries || process.env.LOCAL_MODEL_MAX_RETRIES || 1, 1);
  const backoffMs = parsePositiveInt(options.backoffMs || process.env.LOCAL_MODEL_RETRY_BACKOFF_MS || 200, 200);
  const transport = options.transport || requestJsonWithRetry;
  const runtimeEnabledResolver = options.runtimeEnabledResolver || (() => Boolean(runtimeUrl));
  const capacityResolver = options.capacityResolver || ((body) => resolveCapacitySignals(options, body));
  const enableLiveHealthCheck = options.enableLiveHealthCheck === true;

  return {
    name: "local",
    async execute(request) {
      validateExecutionRequest(request);
      maybeSimulateProviderFailure("local", request);
      const runtimeEnabled = runtimeEnabledResolver();
      if (!runtimeEnabled || !runtimeUrl) {
        return createStubExecutionResult({
          provider: "local",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model: request.model || defaultModel,
          input: request.input,
          message: "Local runtime is not configured; using safe stub fallback."
        });
      }

      const payload = {
        model: request.model || defaultModel,
        prompt: request.input,
        stream: false
      };
      if (options.keepAlive) {
        payload.keep_alive = options.keepAlive;
      }
      if (options.generationOptions && typeof options.generationOptions === "object") {
        payload.options = options.generationOptions;
      }

      try {
        const response = await transport({
          url: `${runtimeUrl}${generatePath}`,
          method: "POST",
          body: payload,
          timeoutMs,
          maxRetries,
          backoffMs
        });
        const responseBody = response && response.body && typeof response.body === "object"
          ? response.body
          : {};
        const output = typeof responseBody.response === "string"
          ? responseBody.response.trim()
          : toArray(responseBody.output).join("\n").trim();
        const inputTokens = Number(responseBody.prompt_eval_count || responseBody.input_tokens || 0);
        const outputTokens = Number(responseBody.eval_count || responseBody.output_tokens || 0);
        return {
          provider: "local",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model: responseBody.model || payload.model,
          status: "COMPLETED",
          output,
          message: "Local runtime execution completed",
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens
          },
          runtime: {
            done: Boolean(responseBody.done),
            done_reason: responseBody.done_reason || "",
            load_duration_ns: Number(responseBody.load_duration || 0),
            eval_duration_ns: Number(responseBody.eval_duration || 0)
          }
        };
      } catch (error) {
        throw normalizeLocalError(error);
      }
    },
    async healthCheck() {
      const runtimeEnabled = runtimeEnabledResolver();
      if (!runtimeEnabled || !runtimeUrl) {
        return {
          provider: "local",
          healthy: true,
          mode: "stub",
          score: 0.9,
          latency_ms: 180,
          capacity_signals: capacityResolver(null)
        };
      }
      if (!enableLiveHealthCheck) {
        return {
          provider: "local",
          healthy: true,
          mode: "configured",
          score: 0.95,
          latency_ms: 160,
          capacity_signals: capacityResolver(null)
        };
      }
      try {
        const response = await transport({
          url: `${runtimeUrl}${healthPath}`,
          method: "GET",
          timeoutMs,
          maxRetries: 0,
          backoffMs: 0
        });
        const responseBody = response && response.body && typeof response.body === "object"
          ? response.body
          : {};
        return {
          provider: "local",
          healthy: true,
          mode: "live",
          score: 0.97,
          latency_ms: 120,
          capacity_signals: capacityResolver(responseBody)
        };
      } catch {
        return {
          provider: "local",
          healthy: false,
          mode: "live",
          score: 0.2,
          latency_ms: 1000,
          capacity_signals: capacityResolver(null)
        };
      }
    }
  };
}

module.exports = {
  createLocalAdapter,
  normalizeLocalError,
  resolveCapacitySignals,
  resolveLocalRuntimeUrl
};
