const { ValidationError } = require("../platform/contracts");

class RetryBudgetManager {
  constructor(options = {}) {
    this.defaultMaxAttempts = Number.isInteger(options.defaultMaxAttempts) ? options.defaultMaxAttempts : 3;
  }

  getMaxAttempts(task) {
    const fromMetadata = task && task.metadata ? task.metadata.retry_budget_max_attempts : undefined;
    if (Number.isInteger(fromMetadata) && fromMetadata > 0) {
      return fromMetadata;
    }
    return this.defaultMaxAttempts;
  }

  remainingAttempts(task, nextAttempt) {
    const maxAttempts = this.getMaxAttempts(task);
    return maxAttempts - nextAttempt;
  }

  assertCanUseAttempt(task, nextAttempt) {
    const maxAttempts = this.getMaxAttempts(task);
    if (nextAttempt > maxAttempts) {
      throw new ValidationError(
        `Retry budget exhausted for task ${task.task_id}: attempt ${nextAttempt} exceeds max ${maxAttempts}`
      );
    }
  }
}

module.exports = {
  RetryBudgetManager
};

