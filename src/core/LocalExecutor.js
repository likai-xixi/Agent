// [FILE]: src/core/LocalExecutor.js
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");

const { ValidationError, nowUtcIso } = require("../platform/contracts");
const { CPU_ARCHITECTURES, HardwareProfiler, NODE_CAPABILITY_TAGS } = require("./HardwareProfiler");

const TASK_TYPES = Object.freeze({
  CRYPTO: "CRYPTO",
  SCANNING: "SCANNING",
  LOCAL_LLM: "LOCAL_LLM",
  VIDEO_RENDER: "VIDEO_RENDER",
  IO: "IO",
  GENERIC: "GENERIC"
});

const GHOST_SLEEP_REASONS = Object.freeze({
  FOREGROUND_GPU_BUSY: "FOREGROUND_GPU_BUSY",
  IO_NODE_COMPUTE_BLOCKED: "IO_NODE_COMPUTE_BLOCKED"
});

const BELOW_NORMAL_PRIORITY = os.constants
  && os.constants.priority
  && Number.isInteger(os.constants.priority.PRIORITY_BELOW_NORMAL)
  ? os.constants.priority.PRIORITY_BELOW_NORMAL
  : 10;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultWorkerFactory(filename, options) {
  return new Worker(filename, options);
}

class ConcurrencyGate {
  constructor(maxConcurrency = 1) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency || 1));
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  async run(work) {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }
}

class VRAMWatcher {
  constructor(options = {}) {
    this.sampleProvider = typeof options.sampleProvider === "function"
      ? options.sampleProvider
      : (() => ({
          foreground_gpu_percent: 0,
          total_vram_bytes: 0,
          used_vram_bytes: 0
        }));
    this.ollamaController = options.ollamaController || {
      async unloadAll() {}
    };
    this.thresholdPercent = Number(options.thresholdPercent || 50);
    this.state = {
      ghost_sleep: false,
      reason: "",
      last_sample: null,
      last_transition_at: ""
    };
  }

  async sample() {
    const raw = await Promise.resolve(this.sampleProvider());
    const sample = {
      foreground_gpu_percent: Number(raw && raw.foreground_gpu_percent ? raw.foreground_gpu_percent : 0),
      total_vram_bytes: Number(raw && raw.total_vram_bytes ? raw.total_vram_bytes : 0),
      used_vram_bytes: Number(raw && raw.used_vram_bytes ? raw.used_vram_bytes : 0)
    };
    this.state.last_sample = sample;
    return sample;
  }

  async enforceGameMode() {
    const sample = await this.sample();
    if (sample.foreground_gpu_percent > this.thresholdPercent) {
      await Promise.resolve(this.ollamaController.unloadAll());
      this.state = {
        ghost_sleep: true,
        reason: GHOST_SLEEP_REASONS.FOREGROUND_GPU_BUSY,
        last_sample: sample,
        last_transition_at: nowUtcIso()
      };
      return clone(this.state);
    }

    this.state = {
      ghost_sleep: false,
      reason: "",
      last_sample: sample,
      last_transition_at: this.state.last_transition_at
    };
    return clone(this.state);
  }

  activateGhostSleep(reason, sample = null) {
    this.state = {
      ghost_sleep: true,
      reason: String(reason || GHOST_SLEEP_REASONS.FOREGROUND_GPU_BUSY),
      last_sample: sample,
      last_transition_at: nowUtcIso()
    };
    return clone(this.state);
  }

  clearGhostSleep() {
    this.state = {
      ghost_sleep: false,
      reason: "",
      last_sample: this.state.last_sample,
      last_transition_at: nowUtcIso()
    };
    return clone(this.state);
  }

  getState() {
    return clone(this.state);
  }
}

class LocalExecutor {
  constructor(options = {}) {
    this.os = options.osModule || os;
    this.hardwareProfiler = options.hardwareProfiler || new HardwareProfiler();
    this.workerFactory = options.workerFactory || defaultWorkerFactory;
    this.prioritySetter = typeof options.prioritySetter === "function" ? options.prioritySetter : this.os.setPriority;
    this.priorityGetter = typeof options.priorityGetter === "function" ? options.priorityGetter : this.os.getPriority;
    this.vramWatcher = options.vramWatcher || new VRAMWatcher({
      sampleProvider: options.gpuUsageProvider,
      ollamaController: options.ollamaController,
      thresholdPercent: options.gpuContentionThresholdPercent
    });
    this.nodeAssignment = String(options.nodeAssignment || process.env.AGENT_NODE_ASSIGNMENT || "MASTER").trim().toUpperCase();
    this._profileCache = null;
    this._backgroundGate = null;
  }

  ensureProfile() {
    if (this._profileCache) {
      return this._profileCache;
    }
    if (this.hardwareProfiler && this.hardwareProfiler.profile) {
      this._profileCache = clone(this.hardwareProfiler.profile);
      return this._profileCache;
    }
    if (this.hardwareProfiler && typeof this.hardwareProfiler.getCoreAffinity === "function") {
      const affinity = this.hardwareProfiler.getCoreAffinity();
      const cpuArchitecture = affinity && affinity.strategy === "HYBRID"
        ? CPU_ARCHITECTURES.INTEL_HYBRID
        : CPU_ARCHITECTURES.GENERIC_UNIFORM;
      const preferredBackground = Array.isArray(affinity.preferred_background_core_ids)
        ? affinity.preferred_background_core_ids
        : [];
      const preferredForeground = Array.isArray(affinity.preferred_foreground_core_ids)
        ? affinity.preferred_foreground_core_ids
        : [];
      this._profileCache = {
        core_affinity: affinity,
        cpu_architecture: {
          family: cpuArchitecture
        },
        node_capability: NODE_CAPABILITY_TAGS.BALANCED_NODE,
        execution_policy: {
          cpu_architecture: cpuArchitecture,
          background_thread_cap: Math.max(1, preferredBackground.length || Number(affinity.logical_core_count || 1)),
          preferred_background_core_ids: preferredBackground,
          preferred_foreground_core_ids: preferredForeground.length > 0
            ? preferredForeground
            : preferredBackground,
          node_capability: NODE_CAPABILITY_TAGS.BALANCED_NODE,
          background_priority: cpuArchitecture === CPU_ARCHITECTURES.INTEL_HYBRID
            ? "PRIORITY_BELOW_NORMAL"
            : "NORMAL",
          memory_mode: "UNKNOWN",
          vector_store_mount: "DISK_ONLY"
        }
      };
      return clone(this._profileCache);
    }
    if (!this.hardwareProfiler || typeof this.hardwareProfiler.initialize !== "function") {
      throw new ValidationError("LocalExecutor requires an initialized HardwareProfiler");
    }
    this._profileCache = this.hardwareProfiler.initialize();
    return this._profileCache;
  }

  getBackgroundGate() {
    if (this._backgroundGate) {
      return this._backgroundGate;
    }
    const profile = this.ensureProfile();
    const maxConcurrency = Number(
      profile.execution_policy && profile.execution_policy.background_thread_cap
        ? profile.execution_policy.background_thread_cap
        : 1
    );
    this._backgroundGate = new ConcurrencyGate(maxConcurrency);
    return this._backgroundGate;
  }

  getGhostSleepState() {
    return this.vramWatcher.getState();
  }

  buildExecutionPolicy(taskType) {
    const normalizedTaskType = String(taskType || TASK_TYPES.GENERIC).trim().toUpperCase() || TASK_TYPES.GENERIC;
    if (typeof this.hardwareProfiler.buildTaskExecutionPolicy === "function") {
      const policy = this.hardwareProfiler.buildTaskExecutionPolicy(normalizedTaskType);
      return {
        ...policy,
        task_type: normalizedTaskType
      };
    }

    const profile = this.ensureProfile();
    return {
      task_type: normalizedTaskType,
      background: normalizedTaskType === TASK_TYPES.CRYPTO || normalizedTaskType === TASK_TYPES.SCANNING,
      compute_intensive: normalizedTaskType === TASK_TYPES.LOCAL_LLM || normalizedTaskType === TASK_TYPES.VIDEO_RENDER,
      priority_class: profile.execution_policy && profile.execution_policy.background_priority
        ? profile.execution_policy.background_priority
        : "NORMAL",
      preferred_core_ids: profile.execution_policy && Array.isArray(profile.execution_policy.preferred_background_core_ids)
        ? profile.execution_policy.preferred_background_core_ids
        : [],
      max_concurrency: profile.execution_policy && Number(profile.execution_policy.background_thread_cap)
        ? Number(profile.execution_policy.background_thread_cap)
        : 1,
      node_capability: profile.node_capability || NODE_CAPABILITY_TAGS.BALANCED_NODE,
      cpu_architecture: profile.cpu_architecture && profile.cpu_architecture.family
        ? profile.cpu_architecture.family
        : CPU_ARCHITECTURES.GENERIC_UNIFORM
    };
  }

  async assertTaskAllowed(taskType, executionPolicy) {
    if (executionPolicy.compute_intensive === true) {
      const gpuState = await this.vramWatcher.enforceGameMode();
      if (gpuState.ghost_sleep) {
        throw new ValidationError(`GHOST_SLEEP_ACTIVE: ${gpuState.reason}`);
      }
    }

    if (executionPolicy.compute_intensive === true
      && executionPolicy.node_capability === NODE_CAPABILITY_TAGS.IO_NODE) {
      this.vramWatcher.activateGhostSleep(GHOST_SLEEP_REASONS.IO_NODE_COMPUTE_BLOCKED);
      throw new ValidationError("NODE_CAPABILITY_BLOCKED: IO_NODE cannot run LOCAL_LLM or VIDEO_RENDER tasks");
    }
  }

  applyPriorityClass(executionPolicy) {
    const shouldLowerPriority = executionPolicy.priority_class === "PRIORITY_BELOW_NORMAL"
      || (executionPolicy.background === true && executionPolicy.cpu_architecture === CPU_ARCHITECTURES.INTEL_HYBRID);
    if (!shouldLowerPriority || typeof this.prioritySetter !== "function") {
      return () => {};
    }

    let previousPriority = null;
    if (typeof this.priorityGetter === "function") {
      try {
        previousPriority = this.priorityGetter(process.pid);
      } catch {
        previousPriority = null;
      }
    }

    try {
      this.prioritySetter(process.pid, BELOW_NORMAL_PRIORITY);
    } catch {
      return () => {};
    }

    return () => {
      if (previousPriority === null || typeof this.prioritySetter !== "function") {
        return;
      }
      try {
        this.prioritySetter(process.pid, previousPriority);
      } catch {
        // Best effort restore only.
      }
    };
  }

  async launchWorkerTask({
    executionPolicy,
    workerFile,
    workerData,
    name,
    timeoutMs,
    resourceLimits
  }) {
    const absoluteWorkerFile = path.resolve(workerFile);
    const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs || 30000));
    const restorePriority = this.applyPriorityClass(executionPolicy);

    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = this.workerFactory(absoluteWorkerFile, {
        workerData,
        name,
        resourceLimits
      });

      const complete = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        restorePriority();
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      };

      const timer = setTimeout(() => {
        Promise.resolve(typeof worker.terminate === "function" ? worker.terminate() : undefined)
          .finally(() => {
            complete(new ValidationError(`Worker timeout after ${effectiveTimeoutMs}ms for ${executionPolicy.task_type}`));
          });
      }, effectiveTimeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }

      worker.once("message", (message) => complete(null, message));
      worker.once("error", (error) => complete(error));
      worker.once("exit", (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          complete(new ValidationError(`Worker exited with code ${code} for ${executionPolicy.task_type}`));
          return;
        }
        complete(new ValidationError(`Worker exited without response for ${executionPolicy.task_type}`));
      });
    });
  }

  async executeWorkerTask({
    taskType = TASK_TYPES.GENERIC,
    workerFile,
    workerData = {},
    timeoutMs = 30000,
    resourceLimits = {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32
    },
    name
  }) {
    const executionPolicy = this.buildExecutionPolicy(taskType);
    await this.assertTaskAllowed(taskType, executionPolicy);

    const runWorker = () => this.launchWorkerTask({
      executionPolicy,
      workerFile,
      workerData: {
        ...workerData,
        execution_policy: executionPolicy,
        node_assignment: this.nodeAssignment
      },
      name: name || `core-worker-${executionPolicy.task_type.toLowerCase()}`,
      timeoutMs,
      resourceLimits
    });

    if (executionPolicy.background === true) {
      return this.getBackgroundGate().run(runWorker);
    }
    return runWorker();
  }
}

module.exports = {
  BELOW_NORMAL_PRIORITY,
  GHOST_SLEEP_REASONS,
  LocalExecutor,
  TASK_TYPES,
  VRAMWatcher
};
