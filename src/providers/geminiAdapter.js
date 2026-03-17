const {
  ProviderExecutionError,
  createStubExecutionResult,
  maybeSimulateProviderFailure,
  validateExecutionRequest
} = require("./adapterContract");
const { requestJsonWithRetry } = require("./httpJsonClient");

function normalizeGeminiError(error) {
  const status = Number(error && error.status ? error.status : 0);
  if (status === 401 || status === 403) {
    return new ProviderExecutionError("Gemini API key is invalid", {
      provider: "gemini",
      code: "KEY_INVALID",
      retryable: false,
      status: status || 401
    });
  }
  if (status === 429) {
    return new ProviderExecutionError("Gemini rate limited request", {
      provider: "gemini",
      code: "RATE_LIMITED",
      retryable: true,
      status: 429
    });
  }
  if (status === 504 || (error && error.code === "PROVIDER_TIMEOUT")) {
    return new ProviderExecutionError("Gemini request timed out", {
      provider: "gemini",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      status: 504
    });
  }
  if (status >= 500) {
    return new ProviderExecutionError("Gemini service unavailable", {
      provider: "gemini",
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      status
    });
  }
  return new ProviderExecutionError(
    error && error.message ? error.message : "Gemini execution failed",
    {
      provider: "gemini",
      code: error && error.code ? error.code : "PROVIDER_EXECUTION_ERROR",
      retryable: error && Object.prototype.hasOwnProperty.call(error, "retryable")
        ? error.retryable !== false
        : true,
      status: status || 502
    }
  );
}

function resolveGeminiApiKey(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "apiKey")) {
    return String(options.apiKey || "").trim();
  }
  if (options.useEnvApiKey === true) {
    return String(process.env.GEMINI_API_KEY || "").trim();
  }
  return "";
}

function createGeminiAdapter(options = {}) {
  const defaultModel = options.defaultModel || "gemini-2.0-flash";
  const baseUrl = String(options.baseUrl || process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const timeoutMs = Number.parseInt(String(options.timeoutMs || process.env.GEMINI_TIMEOUT_MS || 12000), 10);
  const maxRetries = Number.parseInt(String(options.maxRetries || process.env.GEMINI_MAX_RETRIES || 2), 10);
  const backoffMs = Number.parseInt(String(options.backoffMs || process.env.GEMINI_RETRY_BACKOFF_MS || 250), 10);
  const transport = options.transport || requestJsonWithRetry;
  const apiKeyResolver = options.apiKeyResolver || (() => resolveGeminiApiKey(options));
  const enableLiveHealthCheck = options.enableLiveHealthCheck === true;

  return {
    name: "gemini",
    async execute(request) {
      validateExecutionRequest(request);
      maybeSimulateProviderFailure("gemini", request);
      const apiKey = apiKeyResolver();
      if (!apiKey) {
        return createStubExecutionResult({
          provider: "gemini",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model: request.model || defaultModel,
          input: request.input,
          message: "Gemini API key is not configured; using safe stub fallback."
        });
      }

      const model = request.model || defaultModel;
      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: request.input
              }
            ]
          }
        ]
      };

      try {
        const response = await transport({
          url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: "POST",
          body: payload,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 12000,
          maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
          backoffMs: Number.isFinite(backoffMs) ? backoffMs : 250
        });
        const responseBody = response && response.body && typeof response.body === "object"
          ? response.body
          : {};
        const output = responseBody.candidates
          && responseBody.candidates[0]
          && responseBody.candidates[0].content
          && Array.isArray(responseBody.candidates[0].content.parts)
          ? responseBody.candidates[0].content.parts.map((item) => item.text || "").join("\n").trim()
          : "";
        const usage = responseBody.usageMetadata || {};
        return {
          provider: "gemini",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model,
          status: "COMPLETED",
          output,
          message: "Gemini execution completed",
          usage: {
            input_tokens: Number(usage.promptTokenCount || 0),
            output_tokens: Number(usage.candidatesTokenCount || 0),
            total_tokens: Number(usage.totalTokenCount || 0)
          }
        };
      } catch (error) {
        throw normalizeGeminiError(error);
      }
    },
    async healthCheck() {
      const apiKey = apiKeyResolver();
      if (!apiKey) {
        return {
          provider: "gemini",
          healthy: true,
          mode: "stub",
          score: 0.93,
          latency_ms: 280
        };
      }
      if (!enableLiveHealthCheck) {
        return {
          provider: "gemini",
          healthy: true,
          mode: "configured",
          score: 0.96,
          latency_ms: 280
        };
      }
      try {
        await transport({
          url: `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`,
          method: "GET",
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 12000,
          maxRetries: 0,
          backoffMs: 0
        });
        return {
          provider: "gemini",
          healthy: true,
          mode: "live",
          score: 0.96,
          latency_ms: 280
        };
      } catch {
        return {
          provider: "gemini",
          healthy: false,
          mode: "live",
          score: 0.2,
          latency_ms: 1100
        };
      }
    }
  };
}

module.exports = {
  createGeminiAdapter,
  normalizeGeminiError
};
