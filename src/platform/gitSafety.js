const cp = require("child_process");

function runGit(cwd, args) {
  const result = cp.spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim()
  };
}

class GitSafetyManager {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.enabled = options.enabled !== false;
  }

  isEnabled() {
    if (!this.enabled) {
      return false;
    }
    const repo = runGit(this.cwd, ["rev-parse", "--is-inside-work-tree"]);
    return repo.code === 0 && repo.output.endsWith("true");
  }

  createSnapshot(traceId, reason = "local-mutation") {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        commit: ""
      };
    }
    runGit(this.cwd, ["add", "."]);
    const message = `AUTO-SNAPSHOT ${traceId || "trace-unknown"} ${reason}`;
    const commit = runGit(this.cwd, ["commit", "--allow-empty", "-m", message]);
    const head = runGit(this.cwd, ["rev-parse", "HEAD"]);
    if (commit.code !== 0 && !commit.output.includes("nothing to commit")) {
      throw new Error(commit.output || "git commit failed");
    }
    if (head.code !== 0) {
      throw new Error(head.output || "git rev-parse HEAD failed");
    }
    return {
      enabled: true,
      commit: head.output.split(/\r?\n/)[0].trim(),
      message
    };
  }

  rollbackLastSnapshot(mode = "hard") {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        rolled_back: false
      };
    }
    const args = mode === "hard"
      ? ["reset", "--hard", "HEAD~1"]
      : ["reset", "--soft", "HEAD~1"];
    const result = runGit(this.cwd, args);
    if (result.code !== 0) {
      throw new Error(result.output || "git reset failed");
    }
    return {
      enabled: true,
      rolled_back: true,
      mode
    };
  }
}

module.exports = {
  GitSafetyManager,
  runGit
};
