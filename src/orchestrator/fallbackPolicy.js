const { ValidationError } = require("../platform/contracts");

const NON_RETRYABLE_ERROR_CODES = new Set(["INVALID_REQUEST", "AUTHENTICATION_FAILED", "PROVIDER_DISABLED"]);

class FallbackPolicyEvaluator {
  constructor(options = {}) {
    this.maxProviderFallbacks = Number.isInteger(options.maxProviderFallbacks) ? options.maxProviderFallbacks : 2;
  }

  buildProviderCandidates({
    preferredProvider = "",
    fallbackProviders = [],
    enabledProviders = []
  }) {
    const sequence = [];
    const push = (item) => {
      if (!item || !enabledProviders.includes(item) || sequence.includes(item)) {
        return;
      }
      sequence.push(item);
    };

    push(preferredProvider);
    for (const item of fallbackProviders) {
      push(item);
    }
    for (const item of enabledProviders) {
      push(item);
    }

    if (sequence.length === 0) {
      throw new ValidationError("No enabled providers available for fallback policy");
    }

    return sequence.slice(0, this.maxProviderFallbacks + 1);
  }

  shouldFallback(error, failedCount, totalCandidates) {
    if (failedCount >= totalCandidates) {
      return false;
    }
    const code = error && error.code ? String(error.code) : "";
    if (NON_RETRYABLE_ERROR_CODES.has(code)) {
      return false;
    }
    if (error && error.retryable === false) {
      return false;
    }
    return true;
  }
}

module.exports = {
  FallbackPolicyEvaluator,
  NON_RETRYABLE_ERROR_CODES
};

