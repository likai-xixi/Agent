const { randomUUID, createHash } = require("crypto");

const DEFAULT_PARTICIPANTS = Object.freeze([
  "planner",
  "executor",
  "reviewer"
]);

function deterministicScore(input) {
  const hash = createHash("sha256").update(input, "utf8").digest("hex");
  const slice = hash.slice(0, 8);
  const numeric = Number.parseInt(slice, 16);
  return (numeric % 1000) / 1000;
}

function buildOpinion({
  participant,
  task,
  prompt
}) {
  const score = deterministicScore(`${participant}:${task.task_type}:${prompt}`);
  const recommendation = score >= 0.45 ? "APPROVE" : "REJECT";
  const confidence = Math.max(0.35, Math.min(0.98, score));
  return {
    participant,
    recommendation,
    confidence,
    rationale: `${participant} evaluated task ${task.task_id} with score ${score.toFixed(3)}`
  };
}

class DiscussionEngine {
  constructor(options = {}) {
    this.defaultParticipants = options.defaultParticipants || [...DEFAULT_PARTICIPANTS];
    this.history = new Map();
  }

  run({
    task,
    prompt,
    participants = [],
    quorum = 2,
    actor = "operator",
    source = "discussion"
  }) {
    const activeParticipants = participants.length > 0 ? participants : this.defaultParticipants;
    const opinions = activeParticipants.map((participant) => buildOpinion({
      participant,
      task,
      prompt
    }));

    const approveCount = opinions.filter((item) => item.recommendation === "APPROVE").length;
    const rejectCount = opinions.length - approveCount;
    const decision = approveCount >= quorum ? "APPROVE" : "REJECT";
    const record = {
      discussion_id: randomUUID(),
      task_id: task.task_id,
      trace_id: task.trace_id,
      actor,
      source,
      prompt,
      participants: activeParticipants,
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
}

module.exports = {
  DEFAULT_PARTICIPANTS,
  DiscussionEngine
};

