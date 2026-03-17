const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_ALLOWED_SYNC_PATHS = Object.freeze([
  /^skills(?:\/.*)?$/i,
  /^vault\/[^/]+\.enc$/i
]);
const DEFAULT_SENSITIVE_PATTERNS = Object.freeze([
  { id: "API_KEY_PREFIX", pattern: /\bsk-[A-Za-z0-9\-_]+\b/ },
  { id: "MASTER_KEY_LITERAL", pattern: /\bMasterKey\b/i },
  { id: "MASTER_KEY_ENV", pattern: /\bMASTER[_-]?KEY\b/i }
]);

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

function normalizeRepoPath(repoPath) {
  return String(repoPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function isPathInsideRepo(cwd, targetPath) {
  const absoluteTarget = path.resolve(cwd, String(targetPath || ""));
  const relativePath = normalizeRepoPath(path.relative(cwd, absoluteTarget));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }
  return relativePath;
}

function isAllowedSyncPath(repoPath, allowedPatterns = DEFAULT_ALLOWED_SYNC_PATHS) {
  const normalizedPath = normalizeRepoPath(repoPath);
  return allowedPatterns.some((pattern) => pattern.test(normalizedPath));
}

function collectExplicitPaths(cwd, explicitPaths = [], allowedPatterns = DEFAULT_ALLOWED_SYNC_PATHS) {
  const queue = Array.isArray(explicitPaths) ? explicitPaths : [explicitPaths];
  const collected = new Set();
  for (const item of queue) {
    if (!item) {
      continue;
    }
    const repoPath = isPathInsideRepo(cwd, item) || normalizeRepoPath(item);
    if (!repoPath || !isAllowedSyncPath(repoPath, allowedPatterns)) {
      continue;
    }
    const absoluteTarget = path.resolve(cwd, repoPath);
    if (fs.existsSync(absoluteTarget) && fs.statSync(absoluteTarget).isDirectory()) {
      for (const child of fs.readdirSync(absoluteTarget, { withFileTypes: true })) {
        const childPath = path.join(absoluteTarget, child.name);
        for (const nested of collectExplicitPaths(cwd, [childPath], allowedPatterns)) {
          collected.add(nested);
        }
      }
      continue;
    }
    collected.add(repoPath);
  }
  return [...collected].sort();
}

function scanSensitiveFiles(cwd, repoPaths = [], patterns = DEFAULT_SENSITIVE_PATTERNS) {
  const findings = [];
  for (const repoPath of repoPaths) {
    const absolutePath = path.resolve(cwd, repoPath);
    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    for (const definition of patterns) {
      if (!definition.pattern.test(content)) {
        continue;
      }
      findings.push({
        file: repoPath,
        pattern_id: definition.id
      });
    }
  }
  return findings;
}

class GitSafetyManager {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.enabled = options.enabled !== false;
    this.allowedSyncPatterns = options.allowedSyncPatterns || DEFAULT_ALLOWED_SYNC_PATHS;
    this.sensitivePatterns = options.sensitivePatterns || DEFAULT_SENSITIVE_PATTERNS;
    this.alertHandler = typeof options.alertHandler === "function" ? options.alertHandler : null;
  }

  isEnabled() {
    if (!this.enabled) {
      return false;
    }
    const repo = runGit(this.cwd, ["rev-parse", "--is-inside-work-tree"]);
    return repo.code === 0 && repo.output.endsWith("true");
  }

  createSnapshot(traceId, reason = "local-mutation", explicitPaths = []) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        commit: "",
        staged_paths: []
      };
    }
    const stagedPaths = collectExplicitPaths(this.cwd, explicitPaths, this.allowedSyncPatterns);
    const sensitiveFindings = scanSensitiveFiles(this.cwd, stagedPaths, this.sensitivePatterns);
    if (sensitiveFindings.length > 0) {
      const error = new Error(`SENSITIVE_SYNC_BLOCKED: ${JSON.stringify(sensitiveFindings)}`);
      error.code = "SENSITIVE_SYNC_BLOCKED";
      error.findings = sensitiveFindings;
      if (this.alertHandler) {
        this.alertHandler({
          code: error.code,
          findings: sensitiveFindings,
          trace_id: traceId || "",
          reason,
          staged_paths: stagedPaths
        });
      }
      throw error;
    }
    if (stagedPaths.length > 0) {
      const addResult = runGit(this.cwd, ["add", "--", ...stagedPaths]);
      if (addResult.code !== 0) {
        throw new Error(addResult.output || "git add failed");
      }
    }
    const message = `AUTO-SNAPSHOT ${traceId || "trace-unknown"} ${reason}`;
    const commitArgs = stagedPaths.length > 0
      ? ["commit", "--allow-empty", "-m", message, "--only", "--", ...stagedPaths]
      : ["commit", "--allow-empty", "-m", message];
    const commit = runGit(this.cwd, commitArgs);
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
      message,
      staged_paths: stagedPaths
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
  DEFAULT_ALLOWED_SYNC_PATHS,
  DEFAULT_SENSITIVE_PATTERNS,
  GitSafetyManager,
  collectExplicitPaths,
  isAllowedSyncPath,
  normalizeRepoPath,
  runGit,
  scanSensitiveFiles
};
