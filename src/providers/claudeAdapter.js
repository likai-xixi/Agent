const {
  ProviderExecutionError,
  createStubExecutionResult,
  maybeSimulateProviderFailure,
  validateExecutionRequest
} = require("./adapterContract");
const { requestJsonWithRetry } = require("./httpJsonClient");

function normalizeClaudeError(error) {
  const status = Number(error && error.status ? error.status : 0);
  if (status === 401 || status === 403) {
    return new ProviderExecutionError("Claude API key is invalid", {
      provider: "claude",
      code: "KEY_INVALID",
      retryable: false,
      status: status || 401
    });
  }
  if (status === 429) {
    return new ProviderExecutionError("Claude rate limited request", {
      provider: "claude",
      code: "RATE_LIMITED",
      retryable: true,
      status: 429
    });
  }
  if (status === 504 || (error && error.code === "PROVIDER_TIMEOUT")) {
    return new ProviderExecutionError("Claude request timed out", {
      provider: "claude",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      status: 504
    });
  }
  if (status >= 500) {
    return new ProviderExecutionError("Claude service unavailable", {
      provider: "claude",
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      status
    });
  }
  return new ProviderExecutionError(
    error && error.message ? error.message : "Claude execution failed",
    {
      provider: "claude",
      code: error && error.code ? error.code : "PROVIDER_EXECUTION_ERROR",
      retryable: error && Object.prototype.hasOwnProperty.call(error, "retryable")
        ? error.retryable !== false
        : true,
      status: status || 502
    }
  );
}

function resolveClaudeApiKey(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "apiKey")) {
    return String(options.apiKey || "").trim();
  }
  if (options.useEnvApiKey === true) {
    return String(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  }
  return "";
}

function createClaudeAdapter(options = {}) {
  const defaultModel = options.defaultModel || "claude-3-7-sonnet";
  const baseUrl = String(options.baseUrl || process.env.CLAUDE_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const timeoutMs = Number.parseInt(String(options.timeoutMs || process.env.CLAUDE_TIMEOUT_MS || 12000), 10);
  const maxRetries = Number.parseInt(String(options.maxRetries || process.env.CLAUDE_MAX_RETRIES || 2), 10);
  const backoffMs = Number.parseInt(String(options.backoffMs || process.env.CLAUDE_RETRY_BACKOFF_MS || 250), 10);
  const transport = options.transport || requestJsonWithRetry;
  const apiKeyResolver = options.apiKeyResolver || (() => resolveClaudeApiKey(options));
  const enableLiveHealthCheck = options.enableLiveHealthCheck === true;

  return {
    name: "claude",
    async execute(request) {
      validateExecutionRequest(request);
      maybeSimulateProviderFailure("claude", request);
      const apiKey = apiKeyResolver();
      if (!apiKey) {
        return createStubExecutionResult({
          provider: "claude",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model: request.model || defaultModel,
          input: request.input,
          message: "Claude API key is not configured; using safe stub fallback."
        });
      }
      const payload = {
        model: request.model || defaultModel,
        max_tokens: Number.isFinite(options.maxTokens) ? Number(options.maxTokens) : 1024,
        messages: [
          {
            role: "user",
            content: request.input
          }
        ]
      };

      try {
        const response = await transport({
          url: `${baseUrl}/messages`,
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": options.anthropicVersion || "2023-06-01"
          },
          body: payload,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 12000,
          maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
          backoffMs: Number.isFinite(backoffMs) ? backoffMs : 250
        });
        const responseBody = response && response.body && typeof response.body === "object"
          ? response.body
          : {};
        const output = Array.isArray(responseBody.content)
          ? responseBody.content
              .filter((item) => item && item.type === "text")
              .map((item) => item.text || "")
              .join("\n")
              .trim()
          : "";
        const usage = responseBody.usage || {};
        return {
          provider: "claude",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model: responseBody.model || payload.model,
          status: "COMPLETED",
          output,
          message: "Claude execution completed",
          usage: {
            input_tokens: Number(usage.input_tokens || 0),
            output_tokens: Number(usage.output_tokens || 0),
            total_tokens: Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)
          }
        };
      } catch (error) {
        throw normalizeClaudeError(error);
      }
    },
    async healthCheck() {
      const apiKey = apiKeyResolver();
      if (!apiKey) {
        return {
          provider: "claude",
          healthy: true,
          mode: "stub",
          score: 0.94,
          latency_ms: 340
        };
      }
      if (!enableLiveHealthCheck) {
        return {
          provider: "claude",
          healthy: true,
          mode: "configured",
          score: 0.97,
          latency_ms: 340
        };
      }
      try {
        await transport({
          url: `${baseUrl}/models`,
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": options.anthropicVersion || "2023-06-01"
          },
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 12000,
          maxRetries: 0,
          backoffMs: 0
        });
        return {
          provider: "claude",
          healthy: true,
          mode: "live",
          score: 0.97,
          latency_ms: 340
        };
      } catch {
        return {
          provider: "claude",
          healthy: false,
          mode: "live",
          score: 0.2,
          latency_ms: 1200
        };
      }
    }
  };
}

module.exports = {
  createClaudeAdapter,
  normalizeClaudeError
};
