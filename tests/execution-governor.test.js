const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  AuthorizationWorkflowManager,
  JsonFileAuthorizationRequestStore
} = require("../src/platform/authorizationWorkflow");
const { ExecutionGovernor, BudgetExceededError } = require("../src/orchestrator/executionGovernor");
const { JsonFilePolicyStore } = require("../src/platform/policyStore");

function createGovernor(root, overrides = {}) {
  const authorizationWorkflow = new AuthorizationWorkflowManager({
    policyStore: new JsonFilePolicyStore({
      filePath: path.join(root, "policies.json")
    }),
    requestStore: new JsonFileAuthorizationRequestStore({
      filePath: path.join(root, "authorization-requests.json")
    })
  });
  return new ExecutionGovernor({
    providerProfiles: {
      openai: {
        default_model: "gpt-4.1",
        flash_model: "gpt-4.1-mini",
        pro_model: "gpt-4.1",
        committee_model: "gpt-4.1",
        cost_per_1k_tokens: 0.05
      },
      gemini: {
        default_model: "gemini-2.0-flash",
        flash_model: "gemini-2.0-flash",
        pro_model: "gemini-2.0-pro",
        committee_model: "gemini-2.0-pro",
        cost_per_1k_tokens: 0.01
      }
    },
    authorizationWorkflow,
    usageLedgerOptions: {
      filePath: path.join(root, "usage.jsonl")
    },
    balanceStoreOptions: {
      filePath: path.join(root, "balance.json"),
      currency: "USD"
    },
    semanticCacheOptions: {
      filePath: path.join(root, "cache.jsonl"),
      threshold: 0.9
    },
    knowledgeStoreOptions: {
      filePath: path.join(root, "knowledge.jsonl")
    },
    handoffSnapshotStoreOptions: {
      filePath: path.join(root, "handoff.jsonl")
    },
    selfReflectionStoreOptions: {
      filePath: path.join(root, "reflection.jsonl"),
      guardrailPath: path.join(root, "guardrails.json")
    },
    ...overrides
  });
}

test("execution governor compresses context and returns semantic cache hit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-governor-cache-"));
  const governor = createGovernor(root, {
    contextTokenThreshold: 10
  });
  const task = {
    trace_id: "trace-cache",
    task_id: "task-cache",
    task_type: "analysis",
    metadata: {}
  };

  const first = await governor.prepareExecution({
    task,
    input: "Summarize the deployment runbook and operator notes.",
    metadata: {
      knowledge_transfer: false,
      context_history: new Array(20).fill("long context message")
    },
    enabledProviders: ["gemini", "openai"]
  });
  assert.equal(first.context_compressed, true);
  assert.equal(first.provider, "gemini");
  governor.recordExecutionResult({
    task,
    input: first.outbound_input,
    provider: first.provider,
    model: first.model,
    result: {
      status: "COMPLETED",
      output: "Cached answer",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      }
    }
  });

  const second = await governor.prepareExecution({
    task,
    input: "Summarize the deployment runbook and operator notes.",
    metadata: {
      knowledge_transfer: false,
      context_history: new Array(20).fill("long context message")
    },
    enabledProviders: ["gemini", "openai"]
  });
  assert.equal(Boolean(second.cache_hit), true);
  assert.equal(second.cache_hit.entry.output, "Cached answer");
});

test("execution governor enforces daily budget cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-governor-budget-"));
  const governor = createGovernor(root, {
    dailyBudget: 0.001
  });
  const task = {
    trace_id: "trace-budget",
    task_id: "task-budget",
    task_type: "analysis",
    metadata: {}
  };

  await assert.rejects(() => governor.prepareExecution({
    task,
    input: "A".repeat(4000),
    enabledProviders: ["openai"]
  }), BudgetExceededError);
});

test("execution governor requires approval for expensive single task estimates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-governor-auth-"));
  const governor = createGovernor(root, {
    singleTaskBudgetThreshold: 0.001
  });
  const task = {
    trace_id: "trace-approval",
    task_id: "task-approval",
    task_type: "analysis",
    metadata: {}
  };

  await assert.rejects(() => governor.prepareExecution({
    task,
    input: "B".repeat(2000),
    enabledProviders: ["openai"]
  }));
  assert.equal(governor.authorizationWorkflow.requestStore.list("PENDING").length, 1);
});

test("execution governor blocks when provider balance is exhausted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-governor-balance-"));
  const governor = createGovernor(root);
  governor.balanceStore.setBalance({
    remaining_balance: 0,
    actor: "tester"
  });
  const task = {
    trace_id: "trace-balance",
    task_id: "task-balance",
    task_type: "analysis",
    metadata: {}
  };

  await assert.rejects(() => governor.prepareExecution({
    task,
    input: "C".repeat(200),
    enabledProviders: ["openai"]
  }), (error) => {
    assert.equal(error instanceof BudgetExceededError, true);
    assert.equal(error.code, "BALANCE_EXHAUSTED");
    return true;
  });
});
