const test = require("node:test");
const assert = require("node:assert/strict");

const { DiscussionEngine } = require("../src/discussion/discussionEngine");

test("DiscussionEngine returns quorum decision and stores history", () => {
  const engine = new DiscussionEngine();
  const result = engine.run({
    task: {
      task_id: "task-1",
      trace_id: "trace-1",
      task_type: "analysis"
    },
    prompt: "Should we proceed with this change?",
    quorum: 2
  });
  assert.equal(Boolean(result.discussion_id), true);
  assert.equal(["APPROVE", "REJECT"].includes(result.decision), true);
  const latest = engine.getLatest("task-1");
  assert.equal(latest.discussion_id, result.discussion_id);
});

