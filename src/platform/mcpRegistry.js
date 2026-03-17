const cp = require("child_process");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const { AuthorizationRequiredError, AuthorizationWorkflowManager } = require("./authorizationWorkflow");
const { ensureDir, readJsonFile, resolveDataPath, writeJsonFile } = require("./appPaths");
const { ValidationError, nowUtcIso } = require("./contracts");

const SATELLITE_PRIORITY = os.constants && os.constants.priority && Number.isInteger(os.constants.priority.PRIORITY_LOWEST)
  ? os.constants.priority.PRIORITY_LOWEST
  : 19;

function applySatellitePriority(prioritySetter, pid, nodeAssignment) {
  if (String(nodeAssignment || "").toUpperCase() !== "SATELLITE") {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || typeof prioritySetter !== "function") {
    return false;
  }
  try {
    prioritySetter(pid, SATELLITE_PRIORITY);
    return true;
  } catch {
    return false;
  }
}

class McpRegistry {
  constructor(options = {}) {
    this.authorizationWorkflow = options.authorizationWorkflow || new AuthorizationWorkflowManager();
    this.registryFile = options.registryFile || resolveDataPath("mcp-servers.json");
    this.spawn = options.spawn || cp.spawn;
    this.prioritySetter = typeof options.prioritySetter === "function" ? options.prioritySetter : os.setPriority;
    this.nodeAssignment = String(options.nodeAssignment || process.env.AGENT_NODE_ASSIGNMENT || "MASTER").trim().toUpperCase();
    ensureDir(path.dirname(this.registryFile));
    if (!readJsonFile(this.registryFile, null)) {
      writeJsonFile(this.registryFile, {
        mounts: []
      });
    }
  }

  readRegistry() {
    return readJsonFile(this.registryFile, { mounts: [] });
  }

  writeRegistry(state) {
    writeJsonFile(this.registryFile, state);
  }

  async mountServer({
    trace_id,
    actor = "operator",
    name,
    command,
    args = [],
    cwd = process.cwd(),
    approved = false
  }) {
    const normalizedCommand = String(command || "").trim();
    if (!/^npx(?:\.cmd)?$/i.test(normalizedCommand)) {
      throw new ValidationError("Only npx-based MCP mounts are allowed");
    }
    if (!approved) {
      const request = await this.authorizationWorkflow.requestAuthorization({
        trace_id,
        task_id: `mcp-${name || "server"}`,
        request_type: "MCP_MOUNT",
        resource: {
          name,
          command: normalizedCommand,
          args
        },
        actor,
        rationale: "Dynamic MCP mounting requires explicit approval."
      });
      throw new AuthorizationRequiredError("MCP mount requires approval", {
        request
      });
    }
    const child = this.spawn(normalizedCommand, args, {
      cwd,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 30000
    });
    const priorityApplied = applySatellitePriority(this.prioritySetter, child.pid, this.nodeAssignment);
    const mount = {
      mount_id: randomUUID(),
      trace_id,
      actor,
      name,
      command: normalizedCommand,
      args,
      cwd,
      pid: child.pid,
      status: "RUNNING",
      priority_applied: priorityApplied,
      mounted_at: nowUtcIso()
    };
    const state = this.readRegistry();
    state.mounts.push(mount);
    this.writeRegistry(state);
    return mount;
  }

  listMounts() {
    return this.readRegistry().mounts.map((item) => JSON.parse(JSON.stringify(item)));
  }
}

module.exports = {
  McpRegistry
};
