// [FILE]: src/core/FailClosedService.js
const processModule = require("process");

const { ValidationError, nowUtcIso } = require("../platform/contracts");

class FailClosedPanicError extends ValidationError {
  constructor(message, details = {}) {
    super(message);
    this.name = "FailClosedPanicError";
    this.details = details;
  }
}

class FailClosedService {
  constructor(options = {}) {
    this.process = options.processModule || processModule;
    this.logger = options.logger || null;
    this.onPanic = typeof options.onPanic === "function" ? options.onPanic : null;
    this.history = [];
  }

  panic(reason, options = {}) {
    const snapshot = {
      reason: String(reason || "UNKNOWN_PANIC"),
      service: String(options.service || "").trim(),
      exit_code: Number.isInteger(options.exitCode) && options.exitCode > 0 ? options.exitCode : 1,
      timestamp: nowUtcIso(),
      error_name: options.error instanceof Error ? options.error.name : "",
      error_message: options.error instanceof Error ? options.error.message : ""
    };
    this.history.push(snapshot);
    if (this.logger && typeof this.logger.error === "function") {
      this.logger.error(`[FAIL_CLOSED] ${snapshot.reason}`);
    }
    if (this.onPanic) {
      this.onPanic(snapshot);
    }
    this.process.exit(snapshot.exit_code);
    return snapshot;
  }

  getLastPanic() {
    if (this.history.length === 0) {
      return null;
    }
    return {
      ...this.history[this.history.length - 1]
    };
  }

  guardInitialization(label, initializer) {
    try {
      return initializer();
    } catch (error) {
      this.panic(`INITIALIZATION_FAILURE:${label}`, {
        service: label,
        error,
        exitCode: 1
      });
      throw error;
    }
  }

  initializeCriticalServices(services = {}) {
    const results = {};
    for (const [label, service] of Object.entries(services)) {
      results[label] = this.guardInitialization(label, () => {
        if (!service || typeof service.initialize !== "function") {
          throw new FailClosedPanicError(`Critical service ${label} must expose initialize()`, {
            service: label
          });
        }
        return service.initialize();
      });
    }
    return results;
  }
}

module.exports = {
  FailClosedPanicError,
  FailClosedService
};
