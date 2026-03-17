const crypto = require("crypto");

const STEP_ID_PATTERN = /^STEP-\d{8}-\d{3}$/;
const CHECKPOINT_ID_PATTERN = /^CKPT-\d{8}-\d{3}$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function nowUtcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ensure(condition, message) {
  if (!condition) {
    throw new ValidationError(message);
  }
}

function ensureNonEmptyList(name, value) {
  ensure(Array.isArray(value) && value.length > 0, `${name} must be a non-empty array`);
  ensure(value.every((item) => typeof item === "string" && item.trim() !== ""), `${name} must not contain empty strings`);
}

function validateStepRecord(stepRecord) {
  ensure(STEP_ID_PATTERN.test(stepRecord.step_id), "Invalid step_id format");
  ensure(stepRecord.title && stepRecord.title.trim() !== "", "title must not be empty");
  ensure(stepRecord.objective && stepRecord.objective.trim() !== "", "objective must not be empty");
  ensure(stepRecord.next_step && stepRecord.next_step.trim() !== "", "next_step must not be empty");
  ensure(["planned", "in_progress", "blocked", "done"].includes(stepRecord.status), "Invalid status");
  ensureNonEmptyList("change_scope", stepRecord.change_scope);
  ensureNonEmptyList("commands_run", stepRecord.commands_run);
  ensureNonEmptyList("test_results", stepRecord.test_results);
  ensureNonEmptyList("risks", stepRecord.risks);
  ensureNonEmptyList("rollback_commands", stepRecord.rollback_commands);
}

function validateRollbackCheckpoint(checkpoint) {
  ensure(CHECKPOINT_ID_PATTERN.test(checkpoint.checkpoint_id), "Invalid checkpoint_id format");
  ensure(STEP_ID_PATTERN.test(checkpoint.step_id), "Invalid step_id in checkpoint");
  ensure(typeof checkpoint.git_commit === "string" && checkpoint.git_commit.trim() !== "", "git_commit must not be empty");
  ensure(typeof checkpoint.db_down_migration === "string" && checkpoint.db_down_migration.trim() !== "", "db_down_migration must not be empty");
  ensure(typeof checkpoint.config_rollback === "string" && checkpoint.config_rollback.trim() !== "", "config_rollback must not be empty");
  ensureNonEmptyList("health_checks", checkpoint.health_checks);
}

function validateHandoffSnapshot(snapshot) {
  ensure(["planned", "in_progress", "blocked", "ready_for_review", "done"].includes(snapshot.current_status), "Invalid current_status");
  ensure(STEP_ID_PATTERN.test(snapshot.current_step_id), "Invalid current_step_id format");
  ensureNonEmptyList("blockers", snapshot.blockers);
  ensure(Array.isArray(snapshot.next_top3) && snapshot.next_top3.length >= 1 && snapshot.next_top3.length <= 3, "next_top3 must contain 1 to 3 items");
  ensureNonEmptyList("acceptance_criteria", snapshot.acceptance_criteria);
}

function hashPayload(payload) {
  const normalized = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function validateAuditEvent(event, allowedTypes) {
  ensure(event.trace_id, "trace_id must not be empty");
  ensure(event.task_id, "task_id must not be empty");
  ensure(event.attempt_id, "attempt_id must not be empty");
  ensure(event.actor, "actor must not be empty");
  ensure(event.source, "source must not be empty");
  ensure(allowedTypes.has(event.event_type), `Unknown event_type: ${event.event_type}`);
  ensure(typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload), "payload must be an object");
}

module.exports = {
  CHECKPOINT_ID_PATTERN,
  STEP_ID_PATTERN,
  ValidationError,
  hashPayload,
  nowUtcIso,
  validateAuditEvent,
  validateHandoffSnapshot,
  validateRollbackCheckpoint,
  validateStepRecord
};

