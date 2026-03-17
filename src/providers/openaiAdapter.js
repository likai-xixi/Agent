const {
  ProviderExecutionError,
  createStubExecutionResult,
  maybeSimulateProviderFailure,
  validateExecutionRequest
} = require("./adapterContract");
const { requestJsonWithRetry } = require("./httpJsonClient");

function normalizeOpenAIError(error) {
  const status = Number(error && error.status ? error.status : 0);
  if (status === 401 || status === 403) {
    return new ProviderExecutionError("OpenAI API key is invalid", {
      provider: "openai",
      code: "KEY_INVALID",
      retryable: false,
      status: status || 401
    });
  }
  if (status === 429) {
    return new ProviderExecutionError("OpenAI rate limited request", {
      provider: "openai",
      code: "RATE_LIMITED",
      retryable: true,
      status: 429
    });
  }
  if (status === 504 || (error && error.code === "PROVIDER_TIMEOUT")) {
    return new ProviderExecutionError("OpenAI request timed out", {
      provider: "openai",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      status: 504
    });
  }
  if (status >= 500) {
    return new ProviderExecutionError("OpenAI service unavailable", {
      provider: "openai",
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      status
    });
  }
  return new ProviderExecutionError(
    error && error.message ? error.message : "OpenAI execution failed",
    {
      provider: "openai",
      code: error && error.code ? error.code : "PROVIDER_EXECUTION_ERROR",
      retryable: error && Object.prototype.hasOwnProperty.call(error, "retryable")
        ? error.retryable !== false
        : true,
      status: status || 502
    }
  );
}

function resolveOpenAIApiKey(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "apiKey")) {
    return String(options.apiKey || "").trim();
  }
  if (options.useEnvApiKey === true) {
    return String(process.env.OPENAI_API_KEY || "").trim();
  }
  return "";
}

function createOpenAIAdapter(options = {}) {
  const defaultModel = options.defaultModel || "gpt-4.1";
  const baseUrl = String(options.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const timeoutMs = Number.parseInt(String(options.timeoutMs || process.env.OPENAI_TIMEOUT_MS || 12000), 10);
  const maxRetries = Number.parseInt(String(options.maxRetries || process.env.OPENAI_MAX_RETRIES || 2), 10);
  const backoffMs = Number.parseInt(String(options.backoffMs || process.env.OPENAI_RETRY_BACKOFF_MS || 250), 10);
  const transport = options.transport || requestJsonWithRetry;
  const apiKeyResolver = options.apiKeyResolver || (() => resolveOpenAIApiKey(options));
  const enableLiveHealthCheck = options.enableLiveHealthCheck === true;

  return {
    name: "openai",
    async execute(request) {
      validateExecutionRequest(request);
      maybeSimulateProviderFailure("openai", request);
      const apiKey = apiKeyResolver();
      if (!apiKey) {
        return createStubExecutionResult({
          provider: "openai",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model: request.model || defaultModel,
          input: request.input,
          message: "OpenAI API key is not configured; using safe stub fallback."
        });
      }

      const payload = {
        model: request.model || defaultModel,
        messages: [
          {
            role: "user",
            content: request.input
          }
        ],
        temperature: typeof options.temperature === "number" ? options.temperature : 0.2
      };

      try {
        const response = await transport({
          url: `${baseUrl}/chat/completions`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`
          },
          body: payload,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 12000,
          maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
          backoffMs: Number.isFinite(backoffMs) ? backoffMs : 250
        });
        const responseBody = response && response.body && typeof response.body === "object"
          ? response.body
          : {};
        const output = responseBody.choices && responseBody.choices[0] && responseBody.choices[0].message
          ? String(responseBody.choices[0].message.content || "")
          : "";
        const usage = responseBody.usage || {};
        return {
          provider: "openai",
          task_id: request.task_id,
          trace_id: request.trace_id,
          model: responseBody.model || payload.model,
          status: "COMPLETED",
          output,
          message: "OpenAI execution completed",
          usage: {
            input_tokens: Number(usage.prompt_tokens || 0),
            output_tokens: Number(usage.completion_tokens || 0),
            total_tokens: Number(usage.total_tokens || 0)
          }
        };
      } catch (error) {
        throw normalizeOpenAIError(error);
      }
    },
    async healthCheck() {
      const apiKey = apiKeyResolver();
      if (!apiKey) {
        return {
          provider: "openai",
          healthy: true,
          mode: "stub",
          score: 0.95,
          latency_ms: 320
        };
      }
      if (!enableLiveHealthCheck) {
        return {
          provider: "openai",
          healthy: true,
          mode: "configured",
          score: 0.98,
          latency_ms: 320
        };
      }
      try {
        await transport({
          url: `${baseUrl}/models`,
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`
          },
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 12000,
          maxRetries: 0,
          backoffMs: 0
        });
        return {
          provider: "openai",
          healthy: true,
          mode: "live",
          score: 0.98,
          latency_ms: 320
        };
      } catch {
        return {
          provider: "openai",
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
  createOpenAIAdapter,
  normalizeOpenAIError
};
