const { DEFAULT_PARTICIPANTS, DEFAULT_PARTICIPANT_PROFILES, DiscussionEngine } = require("./discussionEngine");
const { AgentMailboxRouter } = require("./agentMailbox");
const { PromptBuilder, stripInnerMonologue } = require("./promptBuilder");

module.exports = {
  AgentMailboxRouter,
  DEFAULT_PARTICIPANTS,
  DEFAULT_PARTICIPANT_PROFILES,
  DiscussionEngine,
  PromptBuilder,
  stripInnerMonologue
};
