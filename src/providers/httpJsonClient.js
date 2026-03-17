function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status) {
  const code = Number(status || 0);
  return code === 429 || code >= 500;
}

function normalizeTransportError(error, status = 0, responseBody = null) {
  if (error && error.name === "AbortError") {
    const timeoutError = new Error("Provider request timeout");
    timeoutError.code = "PROVIDER_TIMEOUT";
    timeoutError.status = 504;
    timeoutError.retryable = true;
    timeoutError.response_body = responseBody;
    return timeoutError;
  }
  const normalized = new Error(error && error.message ? error.message : "Provider request failed");
  normalized.code = error && error.code ? error.code : "PROVIDER_REQUEST_FAILED";
  normalized.status = Number.isInteger(error && error.status) ? error.status : status || 502;
  normalized.retryable = error && Object.prototype.hasOwnProperty.call(error, "retryable")
    ? error.retryable !== false
    : normalized.status === 429 || normalized.status >= 500;
  normalized.response_body = responseBody;
  return normalized;
}

async function requestJsonWithRetry(options = {}) {
  const {
    url,
    method = "POST",
    headers = {},
    body = {},
    timeoutMs = 10000,
    maxRetries = 2,
    backoffMs = 200
  } = options;
  const attempts = Math.max(1, Number.parseInt(String(maxRetries), 10) + 1);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetchOptions = {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers
        },
        signal: controller.signal
      };
      if (!["GET", "HEAD"].includes(String(method).toUpperCase())) {
        fetchOptions.body = JSON.stringify(body);
      }
      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);
      const text = await response.text();
      let jsonBody = null;
      try {
        jsonBody = text ? JSON.parse(text) : null;
      } catch {
        jsonBody = null;
      }
      if (response.ok) {
        return {
          ok: true,
          attempt,
          status: response.status,
          body: jsonBody,
          raw: text
        };
      }
      const error = new Error(`Provider returned status ${response.status}`);
      error.code = "PROVIDER_HTTP_ERROR";
      error.status = response.status;
      error.retryable = isRetryableStatus(response.status);
      error.response_body = jsonBody || text;
      throw error;
    } catch (error) {
      clearTimeout(timer);
      lastError = normalizeTransportError(error, error && error.status ? error.status : 0, error && error.response_body ? error.response_body : null);
      const canRetry = attempt < attempts && lastError.retryable === true;
      if (!canRetry) {
        break;
      }
      await sleep(backoffMs * (2 ** (attempt - 1)));
    }
  }
  throw lastError || new Error("Provider request failed");
}

module.exports = {
  isRetryableStatus,
  requestJsonWithRetry,
  sleep
};
