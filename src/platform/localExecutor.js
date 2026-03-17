const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const { ValidationError } = require("./contracts");
const { AuthorizationRequiredError, AuthorizationWorkflowManager } = require("./authorizationWorkflow");
const { JsonlStepJournal } = require("./checkpointJournal");
const { GitSafetyManager } = require("./gitSafety");
const { scrubSensitiveData } = require("./sensitiveData");
const { ensureTraceId } = require("./trace");

const FORBIDDEN_PATHS = Object.freeze([
  "C:/Windows",
  "C:/Windows/System32",
  "C:/Program Files",
  "C:/Program Files (x86)"
].map((item) => path.resolve(item)));

function normalizeTargetPath(targetPath) {
  return path.resolve(String(targetPath || ""));
}

function isWithinRoot(targetPath, rootPath) {
  if (!rootPath) {
    return false;
  }
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertForbiddenPath(targetPath) {
  const normalized = normalizeTargetPath(targetPath);
  for (const forbiddenRoot of FORBIDDEN_PATHS) {
    if (normalized === forbiddenRoot || normalized.startsWith(`${forbiddenRoot}${path.sep}`)) {
      throw new ValidationError(`Forbidden local path: ${normalized}`);
    }
  }
}

function sanitizeCommandText(command, args = []) {
  return scrubSensitiveData([command, ...args].join(" "));
}

function sanitizeEnv(env = {}) {
  const clone = { ...env };
  for (const key of Object.keys(clone)) {
    if (/proxy|token|secret|password|key/i.test(key)) {
      delete clone[key];
    }
  }
  clone.HTTP_PROXY = "";
  clone.HTTPS_PROXY = "";
  clone.ALL_PROXY = "";
  clone.NO_PROXY = "*";
  return clone;
}

function isNetworkSensitiveCommand(command, args = []) {
  const text = `${command} ${args.join(" ")}`.toLowerCase();
  return /(curl|wget|invoke-webrequest|invoke-restmethod|npm\s+install|pip\s+install|git\s+clone|telnet|ssh|scp)/.test(text);
}

function sampleProcessUsage(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 3 }; \"$($p.Id)|$([math]::Round($p.CPU,4))|$([math]::Round($p.WorkingSet64 / 1MB,2))\"`;
    const result = cp.spawnSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8"
    });
    if ((result.status ?? 1) !== 0) {
      return null;
    }
    const [id, cpuSeconds, memoryMb] = String(result.stdout || "").trim().split("|");
    if (!id) {
      return null;
    }
    return {
      pid: Number(id),
      cpu_seconds: Number(cpuSeconds || 0),
      memory_mb: Number(memoryMb || 0)
    };
  }
  const result = cp.spawnSync("ps", ["-o", "pid=,cputime=,rss=", "-p", String(pid)], {
    encoding: "utf8"
  });
  if ((result.status ?? 1) !== 0) {
    return null;
  }
  const output = String(result.stdout || "").trim();
  if (!output) {
    return null;
  }
  const parts = output.split(/\s+/);
  const cpuTime = String(parts[1] || "0:0").split(":").map((item) => Number(item || 0));
  const cpuSeconds = cpuTime.reduce((total, item) => (total * 60) + item, 0);
  return {
    pid: Number(parts[0]),
    cpu_seconds: cpuSeconds,
    memory_mb: Number(parts[2] || 0) / 1024
  };
}

class ResourceGuardian {
  constructor(options = {}) {
    this.cpuLimitRatio = Number(options.cpuLimitRatio || 0.3);
    this.memoryLimitMb = Number(options.memoryLimitMb || 1024);
    this.sampleIntervalMs = Number(options.sampleIntervalMs || 1000);
    this.cpuCount = Number(options.cpuCount || os.cpus().length || 1);
    this.sampler = options.sampler || sampleProcessUsage;
  }

  watch(child, traceId) {
    if (!child || !child.pid) {
      return {
        stop() {}
      };
    }
    let previousSample = this.sampler(child.pid);
    let previousAt = Date.now();
    const timer = setInterval(() => {
      const current = this.sampler(child.pid);
      if (!current) {
        clearInterval(timer);
        return;
      }
      if (current.memory_mb > this.memoryLimitMb) {
        child.kill("SIGKILL");
        clearInterval(timer);
        return;
      }
      if (previousSample) {
        const elapsedSeconds = Math.max(1, (Date.now() - previousAt) / 1000);
        const cpuDelta = Math.max(0, current.cpu_seconds - previousSample.cpu_seconds);
        const ratio = cpuDelta / (elapsedSeconds * this.cpuCount);
        if (ratio > this.cpuLimitRatio) {
          child.kill("SIGKILL");
          clearInterval(timer);
          return;
        }
      }
      previousSample = current;
      previousAt = Date.now();
    }, this.sampleIntervalMs);
    timer.unref();
    return {
      stop() {
        clearInterval(timer);
      },
      trace_id: traceId
    };
  }
}

class LocalExecutor {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.authorizationWorkflow = options.authorizationWorkflow || new AuthorizationWorkflowManager({
      notifier: options.notifier
    });
    this.gitSafety = options.gitSafety || new GitSafetyManager({
      cwd: this.workspaceRoot,
      enabled: options.gitSafetyEnabled !== false
    });
    this.stepJournal = options.stepJournal || new JsonlStepJournal(options.stepJournalOptions || {});
    this.resourceGuardian = options.resourceGuardian || new ResourceGuardian(options.resourceGuardianOptions || {});
  }

  async assertAuthorizedPath({ trace_id, task_id, actor, targetPath }) {
    assertForbiddenPath(targetPath);
    return this.authorizationWorkflow.ensurePathAuthorized({
      trace_id,
      task_id,
      actor,
      targetPath,
      workspaceRoot: this.workspaceRoot
    });
  }

  resumeInterruptedWork() {
    return this.stepJournal.autoRecover({
      LOCAL_WRITE_FILE: (record) => {
        const tempFile = normalizeTargetPath(record.resume_state.temp_file || "");
        const targetFile = normalizeTargetPath(record.resume_state.target_file || "");
        if (tempFile && fs.existsSync(tempFile) && !fs.existsSync(targetFile)) {
          fs.renameSync(tempFile, targetFile);
        }
        return {
          resume_state: {
            target_file: targetFile,
            temp_file: tempFile
          }
        };
      },
      LOCAL_MOVE_FILE: (record) => {
        const sourceFile = normalizeTargetPath(record.resume_state.source_file || "");
        const destinationFile = normalizeTargetPath(record.resume_state.destination_file || "");
        if (!destinationFile) {
          throw new Error("destination_file is required to resume move");
        }
        if (sourceFile && fs.existsSync(sourceFile) && !fs.existsSync(destinationFile)) {
          fs.copyFileSync(sourceFile, destinationFile);
          fs.unlinkSync(sourceFile);
        } else if (sourceFile && fs.existsSync(sourceFile) && fs.existsSync(destinationFile)) {
          fs.unlinkSync(sourceFile);
        }
        return {
          resume_state: {
            source_file: sourceFile,
            destination_file: destinationFile
          }
        };
      }
    });
  }

  async writeFile({
    trace_id,
    task_id,
    actor = "local-runner",
    target_path,
    content
  }) {
    const traceId = ensureTraceId(trace_id, "runner");
    await this.assertAuthorizedPath({
      trace_id: traceId,
      task_id,
      actor,
      targetPath: target_path
    });
    const targetFile = normalizeTargetPath(target_path);
    const parentDir = path.dirname(targetFile);
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      throw new ValidationError(`Parent directory does not exist: ${parentDir}`);
    }
    const snapshot = this.gitSafety.createSnapshot(traceId, "local-write-file");
    const checkpoint = this.stepJournal.beginStep({
      trace_id: traceId,
      task_id,
      operation: "LOCAL_WRITE_FILE",
      metadata: {
        actor,
        snapshot_commit: snapshot.commit
      },
      resume_state: {
        target_file: targetFile,
        temp_file: `${targetFile}.codex-tmp`
      }
    });

    try {
      const tempFile = `${targetFile}.codex-tmp`;
      fs.writeFileSync(tempFile, String(content || ""), "utf8");
      this.stepJournal.checkpoint(checkpoint.step_run_id, "temp_written", {
        temp_file: tempFile
      });
      fs.renameSync(tempFile, targetFile);
      const result = {
        trace_id: traceId,
        target_path: targetFile,
        status: "COMPLETED",
        snapshot_commit: snapshot.commit
      };
      this.stepJournal.complete(checkpoint.step_run_id, "write_complete", {
        target_file: targetFile,
        temp_file: tempFile
      });
      return result;
    } catch (err) {
      this.stepJournal.interrupt(checkpoint.step_run_id, "write_interrupted", err && err.message ? err.message : "WRITE_FAILED", {
        target_file: targetFile,
        temp_file: `${targetFile}.codex-tmp`
      });
      throw err;
    }
  }

  async deleteFile({
    trace_id,
    task_id,
    actor = "local-runner",
    target_path
  }) {
    const traceId = ensureTraceId(trace_id, "runner");
    await this.assertAuthorizedPath({
      trace_id: traceId,
      task_id,
      actor,
      targetPath: target_path
    });
    const targetFile = normalizeTargetPath(target_path);
    if (!fs.existsSync(targetFile)) {
      throw new ValidationError(`Target file does not exist: ${targetFile}`);
    }
    fs.statSync(targetFile);
    const snapshot = this.gitSafety.createSnapshot(traceId, "local-delete-file");
    const checkpoint = this.stepJournal.beginStep({
      trace_id: traceId,
      task_id,
      operation: "LOCAL_DELETE_FILE",
      metadata: {
        actor,
        snapshot_commit: snapshot.commit
      },
      resume_state: {
        target_file: targetFile
      }
    });
    try {
      fs.unlinkSync(targetFile);
      this.stepJournal.complete(checkpoint.step_run_id, "delete_complete");
      return {
        trace_id: traceId,
        target_path: targetFile,
        status: "COMPLETED",
        snapshot_commit: snapshot.commit
      };
    } catch (err) {
      this.stepJournal.interrupt(checkpoint.step_run_id, "delete_interrupted", err && err.message ? err.message : "DELETE_FAILED");
      throw err;
    }
  }

  async moveFile({
    trace_id,
    task_id,
    actor = "local-runner",
    source_path,
    destination_path
  }) {
    const traceId = ensureTraceId(trace_id, "runner");
    await this.assertAuthorizedPath({
      trace_id: traceId,
      task_id,
      actor,
      targetPath: source_path
    });
    await this.assertAuthorizedPath({
      trace_id: traceId,
      task_id,
      actor,
      targetPath: destination_path
    });
    const sourceFile = normalizeTargetPath(source_path);
    const destinationFile = normalizeTargetPath(destination_path);
    if (!fs.existsSync(sourceFile)) {
      throw new ValidationError(`Source file does not exist: ${sourceFile}`);
    }
    fs.statSync(sourceFile);
    const snapshot = this.gitSafety.createSnapshot(traceId, "local-move-file");
    const checkpoint = this.stepJournal.beginStep({
      trace_id: traceId,
      task_id,
      operation: "LOCAL_MOVE_FILE",
      metadata: {
        actor,
        snapshot_commit: snapshot.commit
      },
      resume_state: {
        source_file: sourceFile,
        destination_file: destinationFile
      }
    });
    try {
      fs.copyFileSync(sourceFile, destinationFile);
      this.stepJournal.checkpoint(checkpoint.step_run_id, "copied", {
        source_file: sourceFile,
        destination_file: destinationFile
      });
      fs.unlinkSync(sourceFile);
      this.stepJournal.complete(checkpoint.step_run_id, "move_complete");
      return {
        trace_id: traceId,
        source_path: sourceFile,
        destination_path: destinationFile,
        status: "COMPLETED",
        snapshot_commit: snapshot.commit
      };
    } catch (err) {
      this.stepJournal.interrupt(checkpoint.step_run_id, "move_interrupted", err && err.message ? err.message : "MOVE_FAILED", {
        source_file: sourceFile,
        destination_file: destinationFile
      });
      throw err;
    }
  }

  async execCommand({
    trace_id,
    task_id,
    actor = "local-runner",
    command,
    args = [],
    cwd = this.workspaceRoot,
    env = {},
    network_isolation = true
  }) {
    const traceId = ensureTraceId(trace_id, "runner");
    await this.assertAuthorizedPath({
      trace_id: traceId,
      task_id,
      actor,
      targetPath: cwd
    });
    if (network_isolation && isNetworkSensitiveCommand(command, args)) {
      throw new ValidationError("Command is blocked by network isolation policy");
    }
    const sanitizedCommand = sanitizeCommandText(command, args);
    const child = cp.spawn(command, args, {
      cwd,
      env: network_isolation ? sanitizeEnv({ ...process.env, ...env }) : { ...process.env, ...env },
      windowsHide: true
    });
    const guardian = this.resourceGuardian.watch(child, traceId);
    const stdout = [];
    const stderr = [];

    return new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout.push(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk) => {
        stderr.push(chunk.toString("utf8"));
      });
      child.on("error", (err) => {
        guardian.stop();
        reject(err);
      });
      child.on("close", (code, signal) => {
        guardian.stop();
        const payload = {
          trace_id: traceId,
          task_id,
          actor,
          command: sanitizedCommand,
          status: code === 0 ? "COMPLETED" : "FAILED",
          exit_code: code,
          signal,
          stdout: scrubSensitiveData(stdout.join("")),
          stderr: scrubSensitiveData(stderr.join("")),
          network_isolation,
          resource_limits: {
            cpu_ratio: 0.3,
            memory_mb: 1024
          }
        };
        if (code === 0) {
          resolve(payload);
          return;
        }
        const error = new Error(payload.stderr || `Command failed: ${sanitizedCommand}`);
        error.payload = payload;
        reject(error);
      });
    });
  }
}

module.exports = {
  AuthorizationRequiredError,
  FORBIDDEN_PATHS,
  LocalExecutor,
  ResourceGuardian,
  assertForbiddenPath,
  isNetworkSensitiveCommand,
  sampleProcessUsage
};
