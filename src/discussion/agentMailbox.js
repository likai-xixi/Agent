const { randomUUID } = require("crypto");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class AgentMailboxRouter {
  constructor(options = {}) {
    this.defaultAgent = options.defaultAgent || "coordinator";
    this.mailboxes = new Map();
  }

  parseRoute(text = "") {
    const normalized = String(text || "").trim();
    const match = normalized.match(/^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/);
    if (!match) {
      return {
        direct: false,
        agent: this.defaultAgent,
        body: normalized
      };
    }
    return {
      direct: true,
      agent: match[1],
      body: match[2].trim()
    };
  }

  routeMessage({
    trace_id,
    actor = "operator",
    text
  }) {
    const route = this.parseRoute(text);
    const mailbox = this.mailboxes.get(route.agent) || [];
    const record = {
      message_id: randomUUID(),
      trace_id,
      actor,
      direct: route.direct,
      agent: route.agent,
      body: route.body,
      created_at: new Date().toISOString()
    };
    mailbox.unshift(record);
    this.mailboxes.set(route.agent, mailbox);
    return clone(record);
  }

  getMailbox(agent) {
    return (this.mailboxes.get(agent) || []).map((item) => clone(item));
  }
}

module.exports = {
  AgentMailboxRouter
};
