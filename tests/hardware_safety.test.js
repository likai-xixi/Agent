// [FILE]: tests/hardware_safety.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const path = require("path");

const {
  BELOW_NORMAL_PRIORITY,
  GHOST_SLEEP_REASONS,
  HardwareProfiler,
  LocalExecutor,
  TASK_TYPES
} = require("../src/core");

function createSpawnSyncMock(available = {}) {
  return (command, args = []) => {
    const lookup = String(command || "");
    const normalizedArgs = Array.isArray(args) ? args : [];

    if (lookup === "where" || lookup === "which") {
      const candidate = String(normalizedArgs[0] || "");
      if (available[candidate]) {
        return {
          status: 0,
          stdout: `${available[candidate].path}\n`,
          stderr: ""
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: ""
      };
    }

    if (available[lookup]) {
      return {
        status: 0,
        stdout: `${available[lookup].version}\n`,
        stderr: ""
      };
    }

    return {
      status: 1,
      stdout: "",
      stderr: `${lookup} missing`
    };
  };
}

function createAvailableToolchain() {
  return {
    node: {
      path: "C:\\Program Files\\nodejs\\node.exe",
      version: "v24.13.1"
    },
    python: {
      path: "C:\\Python311\\python.exe",
      version: "Python 3.11.7"
    },
    git: {
      path: "C:\\Program Files\\Git\\bin\\git.exe",
      version: "git version 2.49.0.windows.1"
    }
  };
}

function createHybridIntelProfiler() {
  return new HardwareProfiler({
    platform: "win32",
    spawnSync: createSpawnSyncMock(createAvailableToolchain()),
    osModule: {
      totalmem() {
        return 32 * 1024 * 1024 * 1024;
      },
      cpus() {
        return [
          { model: "Intel(R) Core(TM) i7-12700K", speed: 4900 },
          { model: "Intel(R) Core(TM) i7-12700K", speed: 4900 },
          { model: "Intel(R) Core(TM) i7-12700K", speed: 4900 },
          { model: "Intel(R) Core(TM) i7-12700K", speed: 4900 },
          { model: "Intel(R) Core(TM) i7-12700K", speed: 3300 },
          { model: "Intel(R) Core(TM) i7-12700K", speed: 3300 },
          { model: "Intel(R) Core(TM) i7-12700K", speed: 3300 },
          { model: "Intel(R) Core(TM) i7-12700K", speed: 3300 }
        ];
      }
    },
    gpuInfoProvider() {
      return [
        {
          name: "NVIDIA GeForce RTX 4070",
          vram_bytes: 8 * 1024 * 1024 * 1024
        }
      ];
    }
  });
}

function createAmdProfiler() {
  return new HardwareProfiler({
    platform: "win32",
    spawnSync: createSpawnSyncMock(createAvailableToolchain()),
    osModule: {
      totalmem() {
        return 32 * 1024 * 1024 * 1024;
      },
      cpus() {
        return Array.from({ length: 10 }, () => ({
          model: "AMD Ryzen 9 7950X",
          speed: 4500
        }));
      }
    },
    gpuInfoProvider() {
      return [
        {
          name: "AMD Radeon RX 7800 XT",
          vram_bytes: 16 * 1024 * 1024 * 1024
        }
      ];
    }
  });
}

test("LocalExecutor downgrades Intel hybrid crypto workers to below-normal priority", async () => {
  const profiler = createHybridIntelProfiler();
  profiler.initialize();

  const priorityCalls = [];
  const workerFactory = (filename, options) => {
    const worker = new EventEmitter();
    worker.terminate = () => Promise.resolve(0);
    setImmediate(() => {
      worker.emit("message", {
        ok: true,
        received_policy: options.workerData.execution_policy
      });
      setImmediate(() => worker.emit("exit", 0));
    });
    return worker;
  };

  const executor = new LocalExecutor({
    hardwareProfiler: profiler,
    workerFactory,
    priorityGetter() {
      return 0;
    },
    prioritySetter(pid, priority) {
      priorityCalls.push({ pid, priority });
    },
    gpuUsageProvider() {
      return {
        foreground_gpu_percent: 0
      };
    }
  });

  const result = await executor.executeWorkerTask({
    taskType: TASK_TYPES.CRYPTO,
    workerFile: path.join(__dirname, "..", "src", "core", "secretVaultWorker.js"),
    workerData: {
      operation: "noop"
    },
    timeoutMs: 5000
  });

  assert.equal(priorityCalls[0].priority, BELOW_NORMAL_PRIORITY);
  assert.equal(priorityCalls[1].priority, 0);
  assert.equal(result.received_policy.priority_class, "PRIORITY_BELOW_NORMAL");
  assert.deepEqual(result.received_policy.preferred_core_ids, [4, 5, 6, 7]);
});

test("LocalExecutor caps AMD background worker concurrency at thirty percent of total cores", async () => {
  const profiler = createAmdProfiler();
  const profile = profiler.initialize();
  let activeWorkers = 0;
  let maxActiveWorkers = 0;

  const workerFactory = () => {
    const worker = new EventEmitter();
    worker.terminate = () => Promise.resolve(0);
    activeWorkers += 1;
    maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
    setTimeout(() => {
      worker.emit("message", { ok: true });
      activeWorkers -= 1;
      worker.emit("exit", 0);
    }, 25);
    return worker;
  };

  const executor = new LocalExecutor({
    hardwareProfiler: profiler,
    workerFactory,
    gpuUsageProvider() {
      return {
        foreground_gpu_percent: 0
      };
    }
  });

  await Promise.all(Array.from({ length: 6 }, (_, index) => executor.executeWorkerTask({
    taskType: TASK_TYPES.SCANNING,
    workerFile: path.join(__dirname, "..", "src", "core", "secretVaultWorker.js"),
    workerData: {
      index
    },
    timeoutMs: 5000
  })));

  assert.equal(profile.execution_policy.background_thread_cap, 3);
  assert.equal(maxActiveWorkers <= 3, true);
});

test("VRAM watcher unloads Ollama and enters ghost sleep when foreground GPU usage spikes", async () => {
  const profiler = createHybridIntelProfiler();
  profiler.initialize();

  let unloadCount = 0;
  const executor = new LocalExecutor({
    hardwareProfiler: profiler,
    ollamaController: {
      async unloadAll() {
        unloadCount += 1;
      }
    },
    gpuUsageProvider() {
      return {
        foreground_gpu_percent: 78,
        total_vram_bytes: 8 * 1024 * 1024 * 1024,
        used_vram_bytes: 6 * 1024 * 1024 * 1024
      };
    },
    workerFactory() {
      throw new Error("worker should not spawn while ghost sleep is active");
    }
  });

  await assert.rejects(() => executor.executeWorkerTask({
    taskType: TASK_TYPES.LOCAL_LLM,
    workerFile: path.join(__dirname, "..", "src", "core", "secretVaultWorker.js")
  }), /GHOST_SLEEP_ACTIVE/);

  assert.equal(unloadCount, 1);
  assert.equal(executor.getGhostSleepState().ghost_sleep, true);
  assert.equal(executor.getGhostSleepState().reason, GHOST_SLEEP_REASONS.FOREGROUND_GPU_BUSY);
});
