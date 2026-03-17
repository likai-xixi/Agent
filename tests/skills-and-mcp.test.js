const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  AuthorizationWorkflowManager,
  AuthorizationRequiredError,
  JsonFileAuthorizationRequestStore
} = require("../src/platform/authorizationWorkflow");
const { McpRegistry } = require("../src/platform/mcpRegistry");
const { JsonFilePolicyStore } = require("../src/platform/policyStore");
const { SkillRegistry } = require("../src/platform/skillsRegistry");

function createWorkflow(root) {
  return new AuthorizationWorkflowManager({
    policyStore: new JsonFilePolicyStore({
      filePath: path.join(root, "policies.json")
    }),
    requestStore: new JsonFileAuthorizationRequestStore({
      filePath: path.join(root, "authorization-requests.json")
    })
  });
}

test("skill registry scans, requests approval, and installs approved tools-as-code", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-registry-"));
  const workflow = createWorkflow(root);
  const registry = new SkillRegistry({
    authorizationWorkflow: workflow,
    skillDir: path.join(root, "skills"),
    proposalFile: path.join(root, "skill-proposals.json"),
    registryFile: path.join(root, "installed-skills.json")
  });

  const proposal = await registry.submitProposal({
    trace_id: "trace-skill",
    actor: "agent",
    name: "CSV Cleaner",
    code: "def run(rows):\n    return [row.strip() for row in rows]\n",
    level: 2
  });
  assert.equal(proposal.status, "PENDING_AUTH");
  assert.equal(Boolean(proposal.authorization_request_id), true);

  const installed = registry.resolveProposal({
    proposal_id: proposal.proposal_id,
    action: "APPROVE",
    actor: "tester"
  });
  assert.equal(installed.status, "INSTALLED");
  assert.equal(registry.listInstalled().length, 1);
  assert.equal(fs.existsSync(path.join(root, "skills", "csv-cleaner.py")), true);
});

test("MCP registry requires approval before mounting and stores approved npx mounts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-registry-"));
  const workflow = createWorkflow(root);
  const registry = new McpRegistry({
    authorizationWorkflow: workflow,
    registryFile: path.join(root, "mcp-servers.json"),
    spawn(command, args) {
      return {
        pid: 4242,
        unref() {},
        command,
        args
      };
    }
  });

  await assert.rejects(() => registry.mountServer({
    trace_id: "trace-mcp",
    actor: "tester",
    name: "filesystem",
    command: "npx",
    args: ["@modelcontextprotocol/server-filesystem", root]
  }), AuthorizationRequiredError);
  assert.equal(workflow.requestStore.list("PENDING").length, 1);

  const mount = await registry.mountServer({
    trace_id: "trace-mcp",
    actor: "tester",
    name: "filesystem",
    command: "npx",
    args: ["@modelcontextprotocol/server-filesystem", root],
    approved: true
  });
  assert.equal(mount.pid, 4242);
  assert.equal(registry.listMounts().length, 1);
});
