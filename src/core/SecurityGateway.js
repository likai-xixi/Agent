// [FILE]: src/core/SecurityGateway.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ValidationError, nowUtcIso } = require("../platform/contracts");

const RAW_FORBIDDEN_PREFIXES = Object.freeze([
  "\\\\.\\",
  "\\Device\\"
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePathPrefix(targetPath) {
  return path.resolve(String(targetPath || "")).toLowerCase().replace(/[\\/]+$/, "");
}

function buildDefaultForbiddenZones(options = {}) {
  const env = options.env || process.env;
  const osModule = options.osModule || os;
  const platform = options.platform || process.platform;
  const zones = [
    "C:\\Windows",
    "C:\\Windows\\System32",
    "C:\\Users\\Administrator",
    "C:\\Program Files",
    "C:\\Program Files (x86)"
  ];

  if (platform !== "win32") {
    zones.push("/etc");
  }
  if (env.APPDATA) {
    zones.push(env.APPDATA);
  }
  if (env.LOCALAPPDATA) {
    zones.push(env.LOCALAPPDATA);
  }
  if (platform === "win32") {
    zones.push(path.join(osModule.homedir(), "AppData"));
  }

  return [...new Set(zones.map((item) => normalizePathPrefix(item)).filter(Boolean))];
}

function realpathSyncNative(fsModule, targetPath) {
  if (fsModule.realpathSync && typeof fsModule.realpathSync.native === "function") {
    return fsModule.realpathSync.native(targetPath);
  }
  return fsModule.realpathSync(targetPath);
}

function resolvePhysicalCandidate(targetPath, fsModule = fs) {
  const absolutePath = path.resolve(String(targetPath || ""));
  if (fsModule.existsSync(absolutePath)) {
    const physicalPath = path.resolve(realpathSyncNative(fsModule, absolutePath));
    return {
      requested_path: String(targetPath || ""),
      absolute_path: absolutePath,
      physical_path: physicalPath,
      existing_path: absolutePath,
      physical_existing_path: physicalPath,
      exists: true
    };
  }

  let probe = absolutePath;
  while (!fsModule.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }

  if (!fsModule.existsSync(probe)) {
    return {
      requested_path: String(targetPath || ""),
      absolute_path: absolutePath,
      physical_path: absolutePath,
      existing_path: "",
      physical_existing_path: "",
      exists: false
    };
  }

  const physicalExistingPath = path.resolve(realpathSyncNative(fsModule, probe));
  const relativeTail = path.relative(probe, absolutePath);
  const physicalPath = relativeTail
    ? path.resolve(path.join(physicalExistingPath, relativeTail))
    : physicalExistingPath;

  return {
    requested_path: String(targetPath || ""),
    absolute_path: absolutePath,
    physical_path: physicalPath,
    existing_path: probe,
    physical_existing_path: physicalExistingPath,
    exists: false
  };
}

class SecurityGatewayError extends ValidationError {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "SecurityGatewayError";
    this.code = code;
    this.details = details;
  }
}

class SecurityGateway {
  constructor(options = {}) {
    this.fs = options.fsModule || fs;
    this.os = options.osModule || os;
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.forbiddenZones = Array.isArray(options.forbiddenZones) && options.forbiddenZones.length > 0
      ? [...new Set(options.forbiddenZones.map((item) => normalizePathPrefix(item)).filter(Boolean))]
      : buildDefaultForbiddenZones({
          env: this.env,
          osModule: this.os,
          platform: this.platform
        });
    this.rawForbiddenPrefixes = Array.isArray(options.rawForbiddenPrefixes) && options.rawForbiddenPrefixes.length > 0
      ? [...new Set(options.rawForbiddenPrefixes.map((item) => String(item || "").toLowerCase()))]
      : [...RAW_FORBIDDEN_PREFIXES].map((item) => item.toLowerCase());
    this.profile = null;
  }

  isForbiddenPath(physicalPath, requestedPath = "") {
    const normalizedPhysical = normalizePathPrefix(physicalPath);
    const normalizedRequested = String(requestedPath || "").trim().toLowerCase();
    if (this.rawForbiddenPrefixes.some((prefix) => normalizedRequested.startsWith(prefix))) {
      return true;
    }
    return this.forbiddenZones.some((zone) => (
      normalizedPhysical === zone || normalizedPhysical.startsWith(`${zone}${path.sep.toLowerCase()}`)
    ));
  }

  assertSafePath(physicalPath, requestedPath, operation = "path access") {
    if (this.isForbiddenPath(physicalPath, requestedPath)) {
      throw new SecurityGatewayError(
        "SECURITY_VIOLATION",
        `Blocked ${operation} against forbidden path ${physicalPath}`,
        {
          operation,
          target_path: physicalPath,
          requested_path: requestedPath
        }
      );
    }
  }

  resolvePhysicalPath(targetPath) {
    return resolvePhysicalCandidate(targetPath, this.fs);
  }

  initialize() {
    const workspace = this.resolvePhysicalPath(this.workspaceRoot);
    if (!workspace.existing_path) {
      throw new SecurityGatewayError(
        "PHYSICAL_CHECK_FAILED",
        `Workspace root does not exist: ${this.workspaceRoot}`,
        {
          workspace_root: this.workspaceRoot
        }
      );
    }
    const workspaceStats = this.fs.statSync(workspace.existing_path);
    if (!workspaceStats.isDirectory()) {
      throw new SecurityGatewayError(
        "PHYSICAL_CHECK_FAILED",
        `Workspace root is not a directory: ${workspace.physical_path}`,
        {
          workspace_root: workspace.physical_path
        }
      );
    }
    this.assertSafePath(workspace.physical_path, this.workspaceRoot, "initialize");
    this.profile = {
      initialized_at: nowUtcIso(),
      workspace_root: workspace.physical_path,
      forbidden_zones: [...this.forbiddenZones],
      raw_forbidden_prefixes: [...this.rawForbiddenPrefixes],
      fail_closed: true
    };
    return clone(this.profile);
  }

  validateWrite(targetPath) {
    const resolved = this.resolvePhysicalPath(targetPath);
    this.assertSafePath(resolved.physical_path, resolved.requested_path, "write");

    if (resolved.exists) {
      const targetStats = this.fs.statSync(resolved.absolute_path);
      if (targetStats.isDirectory()) {
        throw new SecurityGatewayError(
          "PHYSICAL_CHECK_FAILED",
          `Cannot write file content into directory ${resolved.physical_path}`,
          {
            target_path: resolved.physical_path
          }
        );
      }
      return {
        allowed: true,
        exists: true,
        target_path: resolved.physical_path,
        requested_path: resolved.requested_path,
        target_stats: targetStats
      };
    }

    if (!resolved.existing_path) {
      throw new SecurityGatewayError(
        "PHYSICAL_CHECK_FAILED",
        `Parent path does not exist for write target ${resolved.absolute_path}`,
        {
          target_path: resolved.absolute_path
        }
      );
    }

    const parentStats = this.fs.statSync(resolved.existing_path);
    if (!parentStats.isDirectory()) {
      throw new SecurityGatewayError(
        "PHYSICAL_CHECK_FAILED",
        `Parent path is not a directory for write target ${resolved.physical_path}`,
        {
          target_path: resolved.physical_path,
          parent_path: resolved.physical_existing_path
        }
      );
    }

    return {
      allowed: true,
      exists: false,
      target_path: resolved.physical_path,
      requested_path: resolved.requested_path,
      parent_path: resolved.physical_existing_path,
      parent_stats: parentStats
    };
  }
}

module.exports = {
  RAW_FORBIDDEN_PREFIXES,
  SecurityGateway,
  SecurityGatewayError,
  buildDefaultForbiddenZones,
  normalizePathPrefix,
  resolvePhysicalCandidate
};
