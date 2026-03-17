const { randomUUID, createHash } = require("crypto");
const { AgentMailboxRouter } = require("./agentMailbox");

const DEFAULT_PARTICIPANTS = Object.freeze([
  "planner",
  "executor",
  "reviewer"
]);

const DEFAULT_PARTICIPANT_PROFILES = Object.freeze({
  planner: {
    temperature: 0.9,
    provider: "gemini",
    model: "gemini-2.0-flash"
  },
  executor: {
    temperature: 0.6,
    provider: "local",
    model: "llama3.1:8b"
  },
  reviewer: {
    temperature: 0.1,
    provider: "claude",
    model: "claude-3-7-sonnet"
  }
});

function deterministicScore(input) {
  const hash = createHash("sha256").update(input, "utf8").digest("hex");
  const slice = hash.slice(0, 8);
  const numeric = Number.parseInt(slice, 16);
  return (numeric % 1000) / 1000;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildOpinion({
  participant,
  task,
  prompt,
  profile = {}
}) {
  const score = deterministicScore(`${participant}:${task.task_type}:${prompt}:${profile.temperature || 0.5}:${profile.provider || ""}:${profile.model || ""}`);
  const recommendation = score >= 0.45 ? "APPROVE" : "REJECT";
  const confidence = Math.max(0.35, Math.min(0.98, score));
  const innerMonologue = `${participant} privately reasoned about ${task.task_id} with temperature ${profile.temperature || 0.5}`;
  return {
    participant,
    provider: profile.provider || "local",
    model: profile.model || "local-default",
    temperature: Number(profile.temperature || 0.5),
    recommendation,
    confidence,
    rationale: `${participant} independently evaluated task ${task.task_id} with score ${score.toFixed(3)}`,
    conclusion: `${participant} recommends ${recommendation} with confidence ${confidence.toFixed(2)}`,
    inner_monologue: innerMonologue
  };
}

class DiscussionEngine {
  constructor(options = {}) {
    this.defaultParticipants = options.defaultParticipants || [...DEFAULT_PARTICIPANTS];
    this.participantProfiles = {
      ...DEFAULT_PARTICIPANT_PROFILES,
      ...(options.participantProfiles || {})
    };
    this.history = new Map();
    this.privateBuffers = new Map();
    this.mailboxRouter = options.mailboxRouter || new AgentMailboxRouter();
  }

  run({
    task,
    prompt,
    participants = [],
    participant_profiles = {},
    quorum = 2,
    actor = "operator",
    source = "discussion"
  }) {
    const activeParticipants = participants.length > 0 ? participants : this.defaultParticipants;
    const blindRoundOpinions = activeParticipants.map((participant) => {
      const profile = {
        ...(this.participantProfiles[participant] || {}),
        ...(participant_profiles[participant] || {})
      };
      return buildOpinion({
        participant,
        task,
        prompt,
        profile
      });
    });
    const opinions = blindRoundOpinions.map((item) => ({
      participant: item.participant,
      provider: item.provider,
      model: item.model,
      temperature: item.temperature,
      recommendation: item.recommendation,
      confidence: item.confidence,
      rationale: item.rationale,
      conclusion: item.conclusion
    }));

    const approveCount = opinions.filter((item) => item.recommendation === "APPROVE").length;
    const rejectCount = opinions.length - approveCount;
    const decision = approveCount >= quorum ? "APPROVE" : "REJECT";
    const discussionId = randomUUID();
    this.privateBuffers.set(discussionId, blindRoundOpinions.map((item) => ({
      participant: item.participant,
      inner_monologue: item.inner_monologue,
      created_at: new Date().toISOString()
    })));
    const record = {
      discussion_id: discussionId,
      task_id: task.task_id,
      trace_id: task.trace_id,
      actor,
      source,
      prompt,
      participants: activeParticipants,
      blind_review_enabled: true,
      quorum,
      opinions,
      approve_count: approveCount,
      reject_count: rejectCount,
      decision,
      created_at: new Date().toISOString()
    };

    const existing = this.history.get(task.task_id) || [];
    this.history.set(task.task_id, [record, ...existing]);
    return { ...record };
  }

  getLatest(taskId) {
    const items = this.history.get(taskId) || [];
    return items.length > 0 ? { ...items[0] } : null;
  }

  listByTask(taskId) {
    return (this.history.get(taskId) || []).map((item) => ({ ...item }));
  }

  getPrivateBuffer(discussionId) {
    return (this.privateBuffers.get(discussionId) || []).map((item) => clone(item));
  }

  routePrivateMessage(payload) {
    return this.mailboxRouter.routeMessage(payload);
  }

  getMailbox(agent) {
    return this.mailboxRouter.getMailbox(agent);
  }
}

module.exports = {
  DEFAULT_PARTICIPANTS,
  DEFAULT_PARTICIPANT_PROFILES,
  DiscussionEngine
};
