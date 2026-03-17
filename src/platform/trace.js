const { randomUUID } = require("crypto");

function createTraceId(prefix = "trace") {
  return `${String(prefix || "trace").trim()}-${randomUUID()}`;
}

function ensureTraceId(traceId, prefix = "trace") {
  const normalized = String(traceId || "").trim();
  return normalized || createTraceId(prefix);
}

function createChildTraceId(parentTraceId, label = "child") {
  const base = ensureTraceId(parentTraceId);
  const segment = String(label || "child")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "child";
  return `${base}:${segment}:${randomUUID().slice(0, 8)}`;
}

module.exports = {
  createChildTraceId,
  createTraceId,
  ensureTraceId
};
