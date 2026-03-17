const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { AuthorizationRequiredError, AuthorizationWorkflowManager } = require("../platform/authorizationWorkflow");
const { ensureDir, resolveDataPath } = require("../platform/appPaths");
const { ValidationError, nowUtcIso } = require("../platform/contracts");
const {
  BudgetExceededError,
  HardBudgetCircuitBreaker,
  JsonFileBalanceStore,
  JsonlUsageLedger,
  estimateTokens
} = require("../platform/costControls");
const { scrubSensitiveData } = require("../platform/sensitiveData");
const { PromptBuilder } = require("../discussion/promptBuilder");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePrompt(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input) {
  return [...new Set(normalizePrompt(input).split(/\W+/).filter(Boolean))];
}

function computeSimilarity(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function summarizeContextHistory(history = []) {
  const items = Array.isArray(history) ? history : [];
  const selected = items.slice(-6).map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item.content === "string") {
      return `${item.role || "message"}: ${item.content}`;
    }
    return JSON.stringify(item);
  });
  return `Context summary:\n- ${selected.join("\n- ")}`.trim();
}

function classifyExecutionTier({ task, input, metadata = {} }) {
  const normalizedTaskType = String(task && task.task_type ? task.task_type : "").toLowerCase();
  const normalizedInput = String(input || "");
  const riskLevel = String(metadata.risk_level || metadata.risk || "").toLowerCase();
  const complexityScore = (
    normalizedInput.length / 800
    + (/code|refactor|migrate|security|audit|rollback/.test(normalizedTaskType) ? 1.2 : 0)
    + (/critical|high|write|delete|non-idempotent/.test(riskLevel) ? 1.5 : 0)
  );

  if (/critical|high/.test(riskLevel) || metadata.requires_committee === true) {
    return {
      tier: "committee",
      complexity_score: Number(complexityScore.toFixed(2)),
      requires_committee: true
    };
  }
  if (complexityScore >= 1.6) {
    return {
      tier: "pro",
      complexity_score: Number(complexityScore.toFixed(2)),
      requires_committee: false
    };
  }
  return {
    tier: "flash",
    complexity_score: Number(complexityScore.toFixed(2)),
    requires_committee: false
  };
}

function chooseProviderForTier(tier, enabledProviders = [], preferredProvider = "") {
  if (preferredProvider && enabledProviders.includes(preferredProvider)) {
    return preferredProvider;
  }
  const orderingByTier = {
    flash: ["gemini", "local", "openai", "claude"],
    pro: ["openai", "claude", "gemini", "local"],
    committee: ["openai", "claude", "gemini", "local"]
  };
  const ordering = orderingByTier[tier] || orderingByTier.pro;
  return ordering.find((provider) => enabledProviders.includes(provider)) || enabledProviders[0] || "";
}

function chooseModelForTier(provider, profiles = {}, tier = "pro") {
  const profile = profiles[provider] || {};
  const explicitKey = `${tier}_model`;
  if (profile[explicitKey]) {
    return String(profile[explicitKey]);
  }
  if (tier === "flash") {
    if (/gemini/i.test(provider)) {
      return "gemini-2.0-flash";
    }
    if (/openai/i.test(provider)) {
      return "gpt-4.1-mini";
    }
    if (/claude/i.test(provider)) {
      return "claude-3-5-haiku";
    }
  }
  if (tier === "committee" && /claude/i.test(provider)) {
    return "claude-3-7-sonnet";
  }
  return String(profile.default_model || `${provider}-default-model`);
}

class JsonlSemanticCacheStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("semantic-cache.jsonl");
    this.threshold = Number(options.threshold || 0.92);
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  save(entry) {
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return clone(entry);
  }

  getAll() {
    return fs.readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  findBestMatch({ task_type, input }) {
    let best = null;
    for (const entry of this.getAll()) {
      if (entry.task_type !== task_type) {
        continue;
      }
      const score = computeSimilarity(entry.normalized_prompt || "", input);
      if (score < this.threshold) {
        continue;
      }
      if (!best || score > best.score) {
        best = {
          score,
          entry
        };
      }
    }
    return best ? clone(best) : null;
  }
}

class JsonlKnowledgeTransferStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("knowledge-transfer.jsonl");
    this.threshold = Number(options.threshold || 0.75);
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  saveSuccess(record) {
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

  findRelevant({ task_type, input, limit = 3 }) {
    return this.getAll()
      .filter((item) => item.task_type === task_type)
      .map((item) => ({
        score: computeSimilarity(item.normalized_prompt || "", input),
        entry: item
      }))
      .filter((item) => item.score >= this.threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => clone(item));
  }
}

class JsonlHandoffSnapshotStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("handoff-snapshots.jsonl");
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  capture(snapshot) {
    fs.appendFileSync(this.filePath, `${JSON.stringify(snapshot)}\n`, "utf8");
    return clone(snapshot);
  }
}

class JsonlSelfReflectionStore {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDataPath("self-reflection.jsonl");
    this.guardrailPath = options.guardrailPath || path.join(process.cwd(), "config", "system_guardrails.json");
    ensureDir(path.dirname(this.filePath));
    ensureDir(path.dirname(this.guardrailPath));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
    if (!fs.existsSync(this.guardrailPath)) {
      fs.writeFileSync(this.guardrailPath, `${JSON.stringify({ guardrails: [] }, null, 2)}\n`, "utf8");
    }
  }

  inferLessons(error) {
    const message = String(error && error.message ? error.message : error || "");
    const lower = message.toLowerCase();
    if (lower.includes("budget")) {
      return ["Pre-flight cost check is mandatory before calling expensive providers."];
    }
    if (lower.includes("forbidden local path")) {
      return ["Never touch system directories without an explicit permanent rule."];
    }
    if (lower.includes("authorization")) {
      return ["Sensitive mutations must stop and wait for a user decision instead of guessing intent."];
    }
    return ["Capture resumable state before risky mutations and re-validate reality before retrying."];
  }

  record(task, error) {
    const lessons = this.inferLessons(error);
    const entry = {
      reflection_id: randomUUID(),
      trace_id: task.trace_id,
      task_id: task.task_id,
      task_type: task.task_type,
      lessons,
      error_message: String(error && error.message ? error.message : error || ""),
      created_at: nowUtcIso()
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    const current = JSON.parse(fs.readFileSync(this.guardrailPath, "utf8"));
    const guardrails = new Set(Array.isArray(current.guardrails) ? current.guardrails : []);
    for (const lesson of lessons) {
      guardrails.add(lesson);
    }
    fs.writeFileSync(this.guardrailPath, `${JSON.stringify({ guardrails: [...guardrails] }, null, 2)}\n`, "utf8");
    return clone(entry);
  }
}

class ExecutionGovernor {
  constructor(options = {}) {
    this.providerProfiles = options.providerProfiles || {};
    this.singleTaskBudgetThreshold = Number(options.singleTaskBudgetThreshold || 0.5);
    this.contextTokenThreshold = Number(options.contextTokenThreshold || 6000);
    this.authorizationWorkflow = options.authorizationWorkflow || new AuthorizationWorkflowManager();
    this.usageLedger = options.usageLedger || new JsonlUsageLedger(options.usageLedgerOptions || {});
    this.balanceStore = options.balanceStore || new JsonFileBalanceStore(options.balanceStoreOptions || {});
    this.budgetCircuitBreaker = options.budgetCircuitBreaker || new HardBudgetCircuitBreaker({
      providerProfiles: this.providerProfiles,
      dailyBudget: options.dailyBudget,
      usageLedger: this.usageLedger,
      balanceStore: this.balanceStore
    });
    this.dailyBudget = this.budgetCircuitBreaker.dailyBudget;
    this.semanticCache = options.semanticCache || new JsonlSemanticCacheStore(options.semanticCacheOptions || {});
    this.knowledgeStore = options.knowledgeStore || new JsonlKnowledgeTransferStore(options.knowledgeStoreOptions || {});
    this.handoffSnapshotStore = options.handoffSnapshotStore || new JsonlHandoffSnapshotStore(options.handoffSnapshotStoreOptions || {});
    this.selfReflectionStore = options.selfReflectionStore || new JsonlSelfReflectionStore(options.selfReflectionStoreOptions || {});
    this.promptBuilder = options.promptBuilder || new PromptBuilder();
  }

  estimateCost(provider, model, input) {
    return this.budgetCircuitBreaker.estimateRequest({
      provider,
      model,
      input
    });
  }

  async prepareExecution({
    task,
    input,
    provider = "",
    model = "",
    metadata = {},
    enabledProviders = []
  }) {
    const tierDecision = classifyExecutionTier({
      task,
      input,
      metadata
    });
    const selectedProvider = provider || chooseProviderForTier(
      tierDecision.tier,
      enabledProviders,
      metadata.preferred_provider || ""
    );
    const selectedModel = model || chooseModelForTier(selectedProvider, this.providerProfiles, tierDecision.tier);
    let outboundInput = String(input || "");
    let compressed = false;
    let knowledgeMatches = [];

    const contextHistory = Array.isArray(metadata.context_history) ? metadata.context_history : [];
    const rawContextTokens = estimateTokens(contextHistory.map((item) => (
      typeof item === "string" ? item : JSON.stringify(item)
    )).join("\n"));
    if (rawContextTokens >= this.contextTokenThreshold) {
      compressed = true;
      outboundInput = `${summarizeContextHistory(contextHistory)}\n\n${outboundInput}`.trim();
    }

    if (metadata.knowledge_transfer !== false) {
      knowledgeMatches = this.knowledgeStore.findRelevant({
        task_type: task.task_type,
        input: outboundInput,
        limit: 2
      });
      if (knowledgeMatches.length > 0) {
        const background = knowledgeMatches
          .map((item, index) => `${index + 1}. ${item.entry.summary}`)
          .join("\n");
        outboundInput = `Successful background:\n${background}\n\n${outboundInput}`.trim();
      }
    }

    const modelSafePrompt = this.promptBuilder.buildModelPrompt({
      prompt: outboundInput,
      sharedResults: metadata.shared_results || []
    });
    const scrubbedInput = scrubSensitiveData(modelSafePrompt, {
      allowedRoots: [process.cwd()]
    });
    const budget = this.budgetCircuitBreaker.assertRequestAllowed({
      trace_id: task.trace_id,
      task_id: task.task_id,
      provider: selectedProvider,
      model: selectedModel,
      input: scrubbedInput
    });

    if (budget.estimated_cost > this.singleTaskBudgetThreshold && metadata.budget_confirmed !== true) {
      await this.authorizationWorkflow.ensureBudgetApproved({
        trace_id: task.trace_id,
        task_id: task.task_id,
        estimated_cost: budget.estimated_cost
      });
    }

    const cacheHit = metadata.cache_bypass === true
      ? null
      : this.semanticCache.findBestMatch({
          task_type: task.task_type,
          input: scrubbedInput
        });

    return {
      tier_decision: tierDecision,
      provider: selectedProvider,
      model: selectedModel,
      outbound_input: scrubbedInput,
      estimated_cost: budget.estimated_cost,
      estimated_total_tokens: budget.total_tokens_estimate,
      cache_hit: cacheHit,
      context_compressed: compressed,
      knowledge_matches: knowledgeMatches
    };
  }

  buildCacheResponse(task, cacheHit) {
    return {
      selected_provider: cacheHit.entry.provider,
      result: {
        provider: cacheHit.entry.provider,
        task_id: task.task_id,
        trace_id: task.trace_id,
        model: cacheHit.entry.model,
        status: "CACHED",
        output: cacheHit.entry.output,
        message: `Semantic cache hit with similarity ${cacheHit.score.toFixed(3)}`,
        usage: cacheHit.entry.usage || {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0
        }
      },
      cache_hit: true
    };
  }

  recordExecutionResult({
    task,
    input,
    provider,
    model,
    result
  }) {
    const usage = result && result.usage ? result.usage : {};
    if (result && result.status && ["COMPLETED", "STUB_NOT_IMPLEMENTED", "CACHED"].includes(result.status)) {
      this.semanticCache.save({
        cache_id: randomUUID(),
        trace_id: task.trace_id,
        task_id: task.task_id,
        task_type: task.task_type,
        provider,
        model,
        normalized_prompt: normalizePrompt(input),
        output: result.output || "",
        usage: usage,
        created_at: nowUtcIso()
      });
      this.knowledgeStore.saveSuccess({
        record_id: randomUUID(),
        trace_id: task.trace_id,
        task_id: task.task_id,
        task_type: task.task_type,
        normalized_prompt: normalizePrompt(input),
        summary: String(result.output || "").slice(0, 400),
        provider,
        model,
        created_at: nowUtcIso()
      });
    }
  }

  recordExecutionFailure({
    task,
    input,
    error,
    metadata = {}
  }) {
    this.handoffSnapshotStore.capture({
      snapshot_id: randomUUID(),
      trace_id: task.trace_id,
      task_id: task.task_id,
      task_type: task.task_type,
      state: task.state,
      reason: String(error && error.code ? error.code : "EXECUTION_FAILURE"),
      progress_summary: `Task failed during governed execution for ${task.task_id}.`,
      variables: {
        provider_preferences: metadata.preferred_provider || "",
        routing_mode: metadata.routing_mode || "",
        input_preview: String(input || "").slice(0, 240)
      },
      created_at: nowUtcIso()
    });
    this.selfReflectionStore.record(task, error);
  }
}

module.exports = {
  BudgetExceededError,
  ExecutionGovernor,
  HardBudgetCircuitBreaker,
  JsonFileBalanceStore,
  JsonlHandoffSnapshotStore,
  JsonlKnowledgeTransferStore,
  JsonlSelfReflectionStore,
  JsonlSemanticCacheStore,
  JsonlUsageLedger,
  classifyExecutionTier,
  computeSimilarity,
  summarizeContextHistory
};
