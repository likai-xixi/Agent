const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { AuthorizationRequiredError, AuthorizationWorkflowManager } = require("./authorizationWorkflow");
const { ensureDir, readJsonFile, resolveDataPath, writeJsonFile } = require("./appPaths");
const { ValidationError, nowUtcIso } = require("./contracts");

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function scanPythonCode(code = "") {
  const text = String(code || "");
  const findings = [];
  const rules = [
    { severity: "HIGH", pattern: /\bimport\s+socket\b|\bfrom\s+socket\s+import\b/, message: "socket networking is not allowed in stored skills" },
    { severity: "HIGH", pattern: /\bimport\s+requests\b|\bfrom\s+requests\s+import\b/, message: "requests networking is not allowed in stored skills" },
    { severity: "HIGH", pattern: /\bsubprocess\b|\bos\.system\b/, message: "subprocess execution requires a dedicated local-runner review path" },
    { severity: "MEDIUM", pattern: /\bshutil\.rmtree\b|\bos\.remove\b/, message: "destructive filesystem calls require elevated review" }
  ];
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      findings.push({
        severity: rule.severity,
        message: rule.message
      });
    }
  }
  return {
    passed: findings.every((item) => item.severity !== "HIGH"),
    findings
  };
}

class SkillRegistry {
  constructor(options = {}) {
    this.authorizationWorkflow = options.authorizationWorkflow || new AuthorizationWorkflowManager();
    this.skillDir = options.skillDir || resolveDataPath("skills");
    this.proposalFile = options.proposalFile || resolveDataPath("skill-proposals.json");
    this.registryFile = options.registryFile || resolveDataPath("installed-skills.json");
    ensureDir(this.skillDir);
    if (!readJsonFile(this.proposalFile, null)) {
      writeJsonFile(this.proposalFile, {
        proposals: []
      });
    }
    if (!readJsonFile(this.registryFile, null)) {
      writeJsonFile(this.registryFile, {
        skills: []
      });
    }
  }

  readProposals() {
    return readJsonFile(this.proposalFile, { proposals: [] });
  }

  readRegistry() {
    return readJsonFile(this.registryFile, { skills: [] });
  }

  writeProposals(state) {
    writeJsonFile(this.proposalFile, state);
  }

  writeRegistry(state) {
    writeJsonFile(this.registryFile, state);
  }

  async submitProposal({
    trace_id,
    actor = "agent",
    name,
    code,
    level = 1,
    language = "python"
  }) {
    if (!name || !code) {
      throw new ValidationError("name and code are required for a skill proposal");
    }
    const scan = scanPythonCode(code);
    const proposal = {
      proposal_id: randomUUID(),
      trace_id,
      actor,
      name,
      slug: slugify(name),
      language,
      level: Number(level || 1),
      code,
      scan,
      status: "PENDING_AUTH",
      created_at: nowUtcIso(),
      authorization_request_id: ""
    };
    const auth = await this.authorizationWorkflow.requestAuthorization({
      trace_id,
      task_id: `skill-${proposal.proposal_id}`,
      request_type: "SKILL_INSTALL",
      resource: {
        name,
        level: proposal.level,
        language
      },
      actor,
      rationale: "Tools-as-code requires auditor scan plus human authorization before installation."
    });
    proposal.authorization_request_id = auth.request_id;
    const state = this.readProposals();
    state.proposals.push(proposal);
    this.writeProposals(state);
    return proposal;
  }

  resolveProposal({
    proposal_id,
    action,
    actor = "operator",
    note = ""
  }) {
    const state = this.readProposals();
    const proposal = state.proposals.find((item) => item.proposal_id === proposal_id);
    if (!proposal) {
      throw new ValidationError(`Skill proposal not found: ${proposal_id}`);
    }
    if (proposal.status !== "PENDING_AUTH") {
      throw new ValidationError(`Skill proposal already resolved: ${proposal_id}`);
    }
    const normalizedAction = String(action || "").trim().toUpperCase();
    if (!["APPROVE", "DENY"].includes(normalizedAction)) {
      throw new ValidationError(`Unsupported proposal action: ${action}`);
    }
    if (normalizedAction === "DENY") {
      proposal.status = "DENIED";
      proposal.resolved_at = nowUtcIso();
      proposal.resolved_by = actor;
      proposal.note = note;
      this.writeProposals(state);
      return proposal;
    }
    if (!proposal.scan.passed) {
      throw new AuthorizationRequiredError("Skill proposal failed the auditor scan and cannot be installed");
    }
    const filePath = path.join(this.skillDir, `${proposal.slug}.py`);
    fs.writeFileSync(filePath, proposal.code, "utf8");
    const registry = this.readRegistry();
    registry.skills = registry.skills.filter((item) => item.slug !== proposal.slug);
    registry.skills.push({
      skill_id: proposal.proposal_id,
      name: proposal.name,
      slug: proposal.slug,
      level: proposal.level,
      language: proposal.language,
      file: filePath,
      installed_at: nowUtcIso(),
      installed_by: actor
    });
    this.writeRegistry(registry);
    proposal.status = "INSTALLED";
    proposal.resolved_at = nowUtcIso();
    proposal.resolved_by = actor;
    proposal.note = note;
    this.writeProposals(state);
    return proposal;
  }

  listProposals(status = "") {
    const normalized = String(status || "").trim().toUpperCase();
    return this.readProposals().proposals
      .filter((item) => !normalized || item.status === normalized)
      .map((item) => JSON.parse(JSON.stringify(item)));
  }

  listInstalled() {
    return this.readRegistry().skills.map((item) => JSON.parse(JSON.stringify(item)));
  }

  matchSkills({ level = 1 }) {
    const all = this.listInstalled();
    return {
      auto_injected: all.filter((item) => item.level <= 2 && item.level <= level),
      auth_required: all.filter((item) => item.level >= 3 && item.level <= level)
    };
  }
}

module.exports = {
  SkillRegistry,
  scanPythonCode
};
