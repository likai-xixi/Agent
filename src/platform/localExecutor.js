const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { randomUUID } = require("crypto");

const { normalizePortablePath } = require("./appPaths");
const { ValidationError, nowUtcIso } = require("./contracts");
const { AuthorizationRequiredError, AuthorizationWorkflowManager } = require("./authorizationWorkflow");
const { JsonlStepJournal, STEP_STATUSES } = require("./checkpointJournal");
const { GitSafetyManager } = require("./gitSafety");
const { TASK_STATES } = require("../orchestrator/taskStateMachine");
const { scrubSensitiveData } = require("./sensitiveData");
const { ensureTraceId } = require("./trace");

const FORBIDDEN_ZONES = Object.freeze([
  "C:\\Windows",
  "C:\\System32",
  "C:\\Users\\Administrator",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "\\Device\\",
  "\\\\.\\"
].map((item) => String(item).toLowerCase()));
const FORBIDDEN_PATHS = FORBIDDEN_ZONES;
const DEFAULT_WORKSPACE_ROOT = path.resolve(process.env.STORAGE_PATH || "./data");

function normalizeTargetPath(targetPath) {
  return path.resolve(String(targetPath || ""));
}

function normalizeComparisonPath(targetPath) {
  return normalizeTargetPath(targetPath).toLowerCase();
}

function normalizeRawPath(targetPath) {
  return String(targetPath || "").trim().toLowerCase();
}

function createPathPrefixMatcher(rootPath) {
  const normalizedRoot = normalizeComparisonPath(rootPath).replace(/[\\/]+$/, "");
  return {
    exact: normalizedRoot,
    nested: `${normalizedRoot}${path.sep.toLowerCase()}`
  };
}

function isWithinRoot(targetPath, rootPath) {
  if (!rootPath) {
    return false;
  }
  const normalizedTarget = normalizeComparisonPath(targetPath);
  const matcher = createPathPrefixMatcher(rootPath);
  return normalizedTarget === matcher.exact || normalizedTarget.startsWith(matcher.nested);
}

function isInForbiddenZone(targetPath) {
  const normalizedTarget = normalizeComparisonPath(targetPath);
  const rawTarget = normalizeRawPath(targetPath);
  return FORBIDDEN_ZONES.some((zone) => (
    normalizedTarget.startsWith(zone) || rawTarget.startsWith(zone)
  ));
}

class LocalSecurityGatewayError extends ValidationError {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`);
    this.name = "LocalSecurityGatewayError";
    this.code = code;
    this.status = options.status || 409;
    this.details = options.details || {};
  }
}

function assertForbiddenPath(targetPath) {
  const absoluteTarget = normalizeTargetPath(targetPath);
  if (isInForbiddenZone(absoluteTarget)) {
    throw new LocalSecurityGatewayError(
      "SECURITY_VIOLATION",
      `AI attempted to access a protected system path: ${absoluteTarget}`,
      {
        status: 403,
        details: {
          target_path: absoluteTarget
        }
      }
    );
  }
}

function assertPathReality(targetPath, options = {}) {
  const normalized = normalizeTargetPath(targetPath);
  const {
    allowMissingLeaf = false,
    requireDirectory = false,
    requireFile = false,
    operation = "path access"
  } = options;
  assertForbiddenPath(normalized);

  if (fs.existsSync(normalized)) {
    const stats = fs.statSync(normalized);
    if (requireDirectory && !stats.isDirectory()) {
      throw new ValidationError(`Expected directory for ${operation}: ${normalized}`);
    }
    if (requireFile && !stats.isFile()) {
      throw new ValidationError(`Expected file for ${operation}: ${normalized}`);
    }
    return {
      normalized_path: normalized,
      exists: true,
      stats
    };
  }

  if (!allowMissingLeaf) {
    throw new LocalSecurityGatewayError(
      "PHYSICAL_CHECK_FAILED",
      `AI hallucinated a missing path during ${operation}: ${normalized}`,
      {
        details: {
          target_path: normalized,
          operation
        }
      }
    );
  }

  const parentDir = path.dirname(normalized);
  if (!fs.existsSync(parentDir)) {
    throw new LocalSecurityGatewayError(
      "PHYSICAL_CHECK_FAILED",
      `Parent directory does not exist for ${operation}: ${parentDir}`,
      {
        details: {
          parent_dir: parentDir,
          operation
        }
      }
    );
  }
  const parentStats = fs.statSync(parentDir);
  if (!parentStats.isDirectory()) {
    throw new LocalSecurityGatewayError(
      "PHYSICAL_CHECK_FAILED",
      `Parent directory is not a directory for ${operation}: ${parentDir}`,
      {
        details: {
          parent_dir: parentDir,
          operation
        }
      }
    );
  }
  return {
    normalized_path: normalized,
    exists: false,
    parent_dir: parentDir,
    parent_stats: parentStats,
    stats: null
  };
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
    this.workspaceRoot = path.resolve(options.workspaceRoot || DEFAULT_WORKSPACE_ROOT);
    this.workspaceRootComparison = normalizeComparisonPath(this.workspaceRoot);
    this.authorizationWorkflow = options.authorizationWorkflow || new AuthorizationWorkflowManager({
      notifier: options.notifier
    });
    this.gitSafety = options.gitSafety || new GitSafetyManager({
      cwd: this.workspaceRoot,
      enabled: options.gitSafetyEnabled !== false
    });
    this.stepJournal = options.stepJournal || new JsonlStepJournal(options.stepJournalOptions || {});
    this.resourceGuardian = options.resourceGuardian || new ResourceGuardian(options.resourceGuardianOptions || {});
    this.taskStateUpdater = typeof options.taskStateUpdater === "function" ? options.taskStateUpdater : null;
  }

  setTaskStateUpdater(taskStateUpdater) {
    this.taskStateUpdater = typeof taskStateUpdater === "function" ? taskStateUpdater : null;
  }

  appendSecurityEvidence({
    trace_id,
    task_id,
    actor = "local-runner",
    command = "",
    stage = "security_gate",
    status = STEP_STATUSES.CHECKPOINTED,
    target_path = "",
    metadata = {}
  }) {
    return this.stepJournal.append({
      step_run_id: randomUUID(),
      trace_id,
      task_id,
      operation: "LOCAL_SECURITY_GATEWAY",
      stage,
      resumable: false,
      metadata: {
        actor,
        command,
        target_path,
        ...metadata
      },
      resume_state: {
        target_path: target_path ? normalizePortablePath(target_path) : "",
        workspace_root: normalizePortablePath(this.workspaceRoot)
      },
      status,
      timestamp: nowUtcIso()
    });
  }

  async transitionTaskToWaitingForAuth({
    trace_id,
    task_id,
    actor = "local-runner",
    command = "",
    target_path = "",
    request_id = ""
  }) {
    if (!this.taskStateUpdater || !task_id) {
      return null;
    }
    try {
      return await Promise.resolve(this.taskStateUpdater({
        trace_id,
        task_id,
        actor,
        to_state: TASK_STATES.WAITING_FOR_AUTH,
        reason: "awaiting_user_consent",
        metadata: {
          command,
          target_path,
          request_id
        }
      }));
    } catch {
      return null;
    }
  }

  findLatestPathAuthorization(targetPath, taskId = "") {
    const targetComparison = normalizeComparisonPath(targetPath);
    const requests = this.authorizationWorkflow.requestStore.list()
      .filter((item) => item.request_type === "PATH_ACCESS")
      .filter((item) => !taskId || item.task_id === taskId)
      .filter((item) => normalizeComparisonPath(item.resource && item.resource.target_path ? item.resource.target_path : "") === targetComparison)
      .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")));
    if (requests.length === 0) {
      return null;
    }
    return requests[requests.length - 1];
  }

  async requestUserConsent({
    trace_id,
    task_id,
    actor = "local-runner",
    command,
    absoluteTarget
  }) {
    const latestDecision = this.findLatestPathAuthorization(absoluteTarget, task_id);
    if (latestDecision && latestDecision.status === "DENIED") {
      this.appendSecurityEvidence({
        trace_id,
        task_id,
        actor,
        command,
        target_path: absoluteTarget,
        stage: "authorization_denied",
        status: STEP_STATUSES.FAILED,
        metadata: {
          code: "USER_DENIED",
          request_id: latestDecision.request_id
        }
      });
      throw new LocalSecurityGatewayError(
        "USER_DENIED",
        "User denied access to a path outside the workspace",
        {
          status: 403,
          details: {
            target_path: absoluteTarget,
            request_id: latestDecision.request_id
          }
        }
      );
    }

    const request = latestDecision && latestDecision.status === "PENDING"
      ? latestDecision
      : await this.authorizationWorkflow.requestAuthorization({
          trace_id,
          task_id,
          request_type: "PATH_ACCESS",
          resource: {
            target_path: absoluteTarget,
            workspace_root: this.workspaceRoot
          },
          actor,
          options: {
            grant_modes: ["single", "permanent"]
          },
          rationale: "Cross-workspace path access requires explicit approval."
        });

    const waitingTask = await this.transitionTaskToWaitingForAuth({
      trace_id,
      task_id,
      actor,
      command,
      target_path: absoluteTarget,
      request_id: request.request_id
    });
    this.appendSecurityEvidence({
      trace_id,
      task_id,
      actor,
      command,
      target_path: absoluteTarget,
      stage: "authorization_requested",
      status: STEP_STATUSES.CHECKPOINTED,
      metadata: {
        code: "WAITING_FOR_AUTH",
        request_id: request.request_id,
        task_state: waitingTask && waitingTask.state ? waitingTask.state : TASK_STATES.WAITING_FOR_AUTH
      }
    });

    const error = new AuthorizationRequiredError(
      `WAITING_FOR_AUTH: user consent required for path access ${absoluteTarget}`,
      {
        code: "WAITING_FOR_AUTH",
        request
      }
    );
    error.failed_task = waitingTask || null;
    throw error;
  }

  async validatePathAccess({
    trace_id,
    task_id,
    actor = "local-runner",
    command,
    targetPath,
    requireDirectory = false,
    requireFile = false,
    requireExisting = false,
    allowMissingLeaf = false
  }) {
    const traceId = ensureTraceId(trace_id, "runner");
    const absoluteTarget = normalizeTargetPath(targetPath);
    const normalizedTarget = normalizeComparisonPath(targetPath);
    const normalizedCommand = String(command || "").toLowerCase();

    if (isInForbiddenZone(absoluteTarget)) {
      this.appendSecurityEvidence({
        trace_id: traceId,
        task_id,
        actor,
        command,
        target_path: absoluteTarget,
        stage: "forbidden_zone_blocked",
        status: STEP_STATUSES.FAILED,
        metadata: {
          code: "SECURITY_VIOLATION"
        }
      });
      throw new LocalSecurityGatewayError(
        "SECURITY_VIOLATION",
        `AI attempted to access a protected system path: ${absoluteTarget}`,
        {
          status: 403,
          details: {
            target_path: absoluteTarget
          }
        }
      );
    }

    if (requireExisting && !fs.existsSync(absoluteTarget) && !normalizedCommand.includes("mkdir")) {
      this.appendSecurityEvidence({
        trace_id: traceId,
        task_id,
        actor,
        command,
        target_path: absoluteTarget,
        stage: "physical_check_failed",
        status: STEP_STATUSES.FAILED,
        metadata: {
          code: "PHYSICAL_CHECK_FAILED"
        }
      });
      throw new LocalSecurityGatewayError(
        "PHYSICAL_CHECK_FAILED",
        `AI hallucinated that a path exists when it does not: ${absoluteTarget}`,
        {
          details: {
            target_path: absoluteTarget
          }
        }
      );
    }

    let reality;
    try {
      reality = assertPathReality(absoluteTarget, {
        allowMissingLeaf,
        requireDirectory,
        requireFile,
        operation: command
      });
    } catch (error) {
      this.appendSecurityEvidence({
        trace_id: traceId,
        task_id,
        actor,
        command,
        target_path: absoluteTarget,
        stage: "physical_check_failed",
        status: STEP_STATUSES.FAILED,
        metadata: {
          code: error.code || "PHYSICAL_CHECK_FAILED",
          message: error.message
        }
      });
      throw error;
    }

    const decision = this.authorizationWorkflow.policyStore.isPathAllowed(absoluteTarget, {
      workspaceRoot: this.workspaceRoot
    });
    const isInsideWorkspace = normalizedTarget === this.workspaceRootComparison
      || normalizedTarget.startsWith(`${this.workspaceRootComparison}${path.sep.toLowerCase()}`);
    if (!isInsideWorkspace && !decision.allowed) {
      await this.requestUserConsent({
        trace_id: traceId,
        task_id,
        actor,
        command,
        absoluteTarget
      });
    }
    if (decision.allowed && decision.rule && decision.rule.mode === "single") {
      this.authorizationWorkflow.policyStore.consumeRule(decision.rule.rule_id);
    }
    return {
      trace_id: traceId,
      absolute_target: absoluteTarget,
      normalized_target: normalizedTarget,
      reality
    };
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

  performPhysicalAction({
    trace_id,
    task_id,
    actor = "local-runner",
    command,
    args = [],
    cwd,
    env = {},
    network_isolation = true
  }) {
    const traceId = ensureTraceId(trace_id, "runner");
    const sanitizedCommand = sanitizeCommandText(command, args);
    return new Promise((resolve, reject) => {
      const child = cp.execFile(command, args, {
        cwd,
        env: network_isolation ? sanitizeEnv({ ...process.env, ...env }) : { ...process.env, ...env },
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      }, (error, stdout, stderr) => {
        guardian.stop();
        const payload = {
          trace_id: traceId,
          task_id,
          actor,
          command: sanitizedCommand,
          status: error ? "FAILED" : "COMPLETED",
          exit_code: error && Number.isInteger(error.code) ? error.code : 0,
          signal: error && error.signal ? error.signal : null,
          stdout: scrubSensitiveData(String(stdout || "")),
          stderr: scrubSensitiveData(String(stderr || "")),
          network_isolation,
          resource_limits: {
            cpu_ratio: 0.3,
            memory_mb: 1024,
            timeout_ms: 30000,
            max_buffer_bytes: 1024 * 1024
          }
        };
        if (error) {
          error.payload = payload;
          reject(error);
          return;
        }
        resolve(payload);
      });
      const guardian = this.resourceGuardian.watch(child, traceId);
      child.on("error", (error) => {
        guardian.stop();
        reject(error);
      });
    });
  }

  async validateAndExecute({
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
    const cwdValidation = await this.validatePathAccess({
      trace_id: traceId,
      task_id,
      actor,
      command: "execute",
      targetPath: cwd,
      requireDirectory: true,
      requireExisting: true
    });
    if (network_isolation && isNetworkSensitiveCommand(command, args)) {
      this.appendSecurityEvidence({
        trace_id: traceId,
        task_id,
        actor,
        command: sanitizeCommandText(command, args),
        target_path: cwdValidation.absolute_target,
        stage: "network_isolation_blocked",
        status: STEP_STATUSES.FAILED,
        metadata: {
          code: "NETWORK_ISOLATION_BLOCKED"
        }
      });
      throw new LocalSecurityGatewayError(
        "NETWORK_ISOLATION_BLOCKED",
        "Command is blocked by network isolation policy",
        {
          details: {
            command: sanitizeCommandText(command, args),
            target_path: cwdValidation.absolute_target
          }
        }
      );
    }
    return this.performPhysicalAction({
      trace_id: traceId,
      task_id,
      actor,
      command,
      args,
      cwd: cwdValidation.absolute_target,
      env,
      network_isolation
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
    const targetValidation = await this.validatePathAccess({
      trace_id: traceId,
      task_id,
      actor,
      command: "write",
      targetPath: target_path,
      allowMissingLeaf: true
    });
    const targetFile = targetValidation.absolute_target;
    if (targetValidation.reality.exists && targetValidation.reality.stats && targetValidation.reality.stats.isDirectory()) {
      throw new ValidationError(`Cannot overwrite directory with file write: ${targetFile}`);
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
    const targetValidation = await this.validatePathAccess({
      trace_id: traceId,
      task_id,
      actor,
      command: "delete",
      targetPath: target_path,
      requireFile: true,
      requireExisting: true
    });
    const targetFile = targetValidation.absolute_target;
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
    const sourceValidation = await this.validatePathAccess({
      trace_id: traceId,
      task_id,
      actor,
      command: "move_source",
      targetPath: source_path,
      requireFile: true,
      requireExisting: true
    });
    const destinationValidation = await this.validatePathAccess({
      trace_id: traceId,
      task_id,
      actor,
      command: "move_destination",
      targetPath: destination_path,
      allowMissingLeaf: true
    });
    const sourceFile = sourceValidation.absolute_target;
    const destinationFile = destinationValidation.absolute_target;
    if (destinationValidation.reality.exists) {
      throw new ValidationError(`Destination file already exists: ${destinationFile}`);
    }
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
    return this.validateAndExecute({
      trace_id,
      task_id,
      actor,
      command,
      args,
      cwd,
      env,
      network_isolation
    });
  }
}

module.exports = {
  AuthorizationRequiredError,
  FORBIDDEN_ZONES,
  FORBIDDEN_PATHS,
  LocalExecutor,
  LocalSecurityGatewayError,
  ResourceGuardian,
  assertPathReality,
  assertForbiddenPath,
  isNetworkSensitiveCommand,
  isWithinRoot,
  normalizeComparisonPath,
  sampleProcessUsage
};
