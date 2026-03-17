const fs = require("fs");
const path = require("path");

const { ensureDir, readJsonFile, resolveDataPath, writeJsonFile } = require("./appPaths");
const { ValidationError, nowUtcIso } = require("./contracts");

class BudgetExceededError extends ValidationError {
  constructor(message, options = {}) {
    super(message);
    this.name = "BudgetExceededError";
    this.code = options.code || "DAILY_BUDGET_EXCEEDED";
    this.status = options.status || 429;
    this.details = options.details || {};
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function estimateTokens(text) {
  const length = String(text || "").trim().length;
  return Math.max(1, Math.ceil(length / 4));
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ValidationError(`Invalid monetary amount: ${value}`);
  }
  return Number(numeric.toFixed(6));
}

class JsonlUsageLedger {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("token-usage.jsonl");
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  append(record) {
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    return clone(record);
  }

  getAll() {
    return fs.readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  summarizeDay(day = nowUtcIso().slice(0, 10)) {
    const entries = this.getAll().filter((item) => String(item.timestamp || "").startsWith(day));
    const totals = entries.reduce((summary, item) => {
      summary.input_tokens += Number(item.input_tokens || 0);
      summary.output_tokens += Number(item.output_tokens || 0);
      summary.total_tokens += Number(item.total_tokens || 0);
      summary.estimated_cost += Number(item.estimated_cost || 0);
      return summary;
    }, {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      estimated_cost: 0
    });
    return {
      day,
      entries: entries.length,
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      total_tokens: totals.total_tokens,
      estimated_cost: Number(totals.estimated_cost.toFixed(6))
    };
  }
}

class JsonFileBalanceStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("provider-balance.json");
    this.defaultCurrency = String(options.currency || "USD").trim() || "USD";
    const configuredBalance = options.initialBalance;
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      writeJsonFile(this.filePath, {
        remaining_balance: normalizeAmount(configuredBalance),
        currency: this.defaultCurrency,
        updated_at: nowUtcIso(),
        transactions: []
      });
    }
  }

  getState() {
    const raw = readJsonFile(this.filePath, {});
    return {
      remaining_balance: normalizeAmount(raw.remaining_balance),
      currency: String(raw.currency || this.defaultCurrency),
      updated_at: String(raw.updated_at || ""),
      transactions: Array.isArray(raw.transactions) ? raw.transactions : []
    };
  }

  setBalance({ remaining_balance, currency = this.defaultCurrency, reason = "manual_update", actor = "system" }) {
    const state = this.getState();
    const updated = {
      remaining_balance: normalizeAmount(remaining_balance),
      currency: String(currency || state.currency || this.defaultCurrency),
      updated_at: nowUtcIso(),
      transactions: [
        ...(state.transactions || []),
        {
          type: "SET_BALANCE",
          amount: normalizeAmount(remaining_balance),
          reason,
          actor,
          created_at: nowUtcIso()
        }
      ].slice(-200)
    };
    writeJsonFile(this.filePath, updated);
    return updated;
  }

  decrement(amount, metadata = {}) {
    const normalizedAmount = normalizeAmount(amount);
    if (normalizedAmount === null || normalizedAmount <= 0) {
      return this.getState();
    }
    const state = this.getState();
    if (state.remaining_balance === null) {
      return state;
    }
    const next = Number((state.remaining_balance - normalizedAmount).toFixed(6));
    const updated = {
      remaining_balance: next < 0 ? 0 : next,
      currency: state.currency,
      updated_at: nowUtcIso(),
      transactions: [
        ...(state.transactions || []),
        {
          type: "DEBIT",
          amount: normalizedAmount,
          reason: metadata.reason || "provider_execution",
          actor: metadata.actor || "provider-registry",
          provider: metadata.provider || "",
          task_id: metadata.task_id || "",
          trace_id: metadata.trace_id || "",
          created_at: nowUtcIso()
        }
      ].slice(-200)
    };
    writeJsonFile(this.filePath, updated);
    return updated;
  }
}

function resolveProviderCost(providerProfiles = {}, provider = "") {
  const profile = providerProfiles[provider] || {};
  const numeric = Number(profile.cost_per_1k_tokens || 0);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function estimateRequestCost(providerProfiles = {}, provider = "", model = "", input = "") {
  const per1k = resolveProviderCost(providerProfiles, provider);
  const inputTokens = estimateTokens(input);
  const totalTokens = inputTokens * 2;
  const estimatedCost = Number(((totalTokens / 1000) * per1k).toFixed(6));
  return {
    provider,
    model,
    input_tokens_estimate: inputTokens,
    total_tokens_estimate: totalTokens,
    estimated_cost: estimatedCost,
    cost_per_1k_tokens: per1k
  };
}

class HardBudgetCircuitBreaker {
  constructor(options = {}) {
    this.providerProfiles = options.providerProfiles || {};
    this.dailyBudget = Number(options.dailyBudget || process.env.DAILY_BUDGET || 10);
    this.usageLedger = options.usageLedger || new JsonlUsageLedger(options.usageLedgerOptions || {});
    this.balanceStore = options.balanceStore || new JsonFileBalanceStore({
      initialBalance: options.initialBalance,
      filePath: options.balanceStoreOptions && options.balanceStoreOptions.filePath,
      currency: options.balanceStoreOptions && options.balanceStoreOptions.currency
    });
  }

  estimateRequest({ provider, model, input }) {
    return estimateRequestCost(this.providerProfiles, provider, model, input);
  }

  getBudgetStatus(day = nowUtcIso().slice(0, 10)) {
    const dailySummary = this.usageLedger.summarizeDay(day);
    const balance = this.balanceStore.getState();
    return {
      day,
      daily_budget: this.dailyBudget,
      daily_spent: dailySummary.estimated_cost,
      daily_remaining: Number((this.dailyBudget - dailySummary.estimated_cost).toFixed(6)),
      remaining_balance: balance.remaining_balance,
      currency: balance.currency
    };
  }

  assertRequestAllowed({ provider, model, input, trace_id = "", task_id = "" }) {
    const estimate = this.estimateRequest({ provider, model, input });
    const dailySummary = this.usageLedger.summarizeDay();
    const balance = this.balanceStore.getState();
    const projectedDaily = Number((dailySummary.estimated_cost + estimate.estimated_cost).toFixed(6));

    if (balance.remaining_balance !== null && balance.remaining_balance <= 0) {
      throw new BudgetExceededError("Provider balance exhausted", {
        code: "BALANCE_EXHAUSTED",
        details: {
          provider,
          trace_id,
          task_id,
          remaining_balance: balance.remaining_balance,
          estimated_cost: estimate.estimated_cost
        }
      });
    }

    if (balance.remaining_balance !== null && estimate.estimated_cost > balance.remaining_balance) {
      throw new BudgetExceededError(
        `Provider balance exhausted: $${estimate.estimated_cost.toFixed(3)} > $${balance.remaining_balance.toFixed(3)}`,
        {
          code: "BALANCE_EXHAUSTED",
          details: {
            provider,
            trace_id,
            task_id,
            remaining_balance: balance.remaining_balance,
            estimated_cost: estimate.estimated_cost
          }
        }
      );
    }

    if (projectedDaily > this.dailyBudget) {
      throw new BudgetExceededError(
        `Daily provider budget exceeded: $${projectedDaily.toFixed(3)} > $${this.dailyBudget.toFixed(3)}`,
        {
          code: "DAILY_BUDGET_EXCEEDED",
          details: {
            provider,
            trace_id,
            task_id,
            current_cost: dailySummary.estimated_cost,
            estimated_increment: estimate.estimated_cost
          }
        }
      );
    }

    return {
      ...estimate,
      daily_summary: dailySummary,
      remaining_balance: balance.remaining_balance,
      currency: balance.currency
    };
  }

  recordActualUsage({ provider, model, input, result, trace_id = "", task_id = "" }) {
    const usage = result && result.usage && typeof result.usage === "object" ? result.usage : {};
    const normalizedTotalTokens = Number(usage.total_tokens || 0);
    const normalizedInputTokens = Number(usage.input_tokens || 0);
    const normalizedOutputTokens = Number(usage.output_tokens || 0);
    const estimated = this.estimateRequest({ provider, model, input });
    const totalTokens = normalizedTotalTokens > 0 ? normalizedTotalTokens : estimated.total_tokens_estimate;
    const inputTokens = normalizedInputTokens > 0 ? normalizedInputTokens : estimated.input_tokens_estimate;
    const outputTokens = normalizedOutputTokens > 0 ? normalizedOutputTokens : Math.max(0, totalTokens - inputTokens);
    const shouldCharge = !(result && result.status === "STUB_NOT_IMPLEMENTED");
    const costPer1k = resolveProviderCost(this.providerProfiles, provider);
    const actualCost = shouldCharge
      ? Number(((totalTokens / 1000) * costPer1k).toFixed(6))
      : 0;

    const entry = this.usageLedger.append({
      trace_id,
      task_id,
      provider,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      estimated_cost: actualCost,
      timestamp: nowUtcIso()
    });

    if (shouldCharge && actualCost > 0) {
      this.balanceStore.decrement(actualCost, {
        provider,
        task_id,
        trace_id
      });
    }
    return entry;
  }
}

module.exports = {
  BudgetExceededError,
  HardBudgetCircuitBreaker,
  JsonFileBalanceStore,
  JsonlUsageLedger,
  estimateRequestCost,
  estimateTokens
};
