const cp = require("child_process");
const path = require("path");
const { randomUUID } = require("crypto");

const { AuthorizationRequiredError, AuthorizationWorkflowManager } = require("./authorizationWorkflow");
const { ensureDir, readJsonFile, resolveDataPath, writeJsonFile } = require("./appPaths");
const { ValidationError, nowUtcIso } = require("./contracts");

class McpRegistry {
  constructor(options = {}) {
    this.authorizationWorkflow = options.authorizationWorkflow || new AuthorizationWorkflowManager();
    this.registryFile = options.registryFile || resolveDataPath("mcp-servers.json");
    this.spawn = options.spawn || cp.spawn;
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
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
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
