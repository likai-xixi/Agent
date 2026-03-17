// [FILE]: tests/BATCH_01.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CURRENT_VAULT_VERSION,
  FailClosedService,
  HardwareProfiler,
  MEMORY_PROFILES,
  SecretVault,
  SecurityGateway,
  SecurityGatewayError,
  classifyCoreTiers
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

test("HardwareProfiler detects PATH dependencies, hybrid affinity, and HIGH_END memory profile", () => {
  const profiler = new HardwareProfiler({
    platform: "win32",
    spawnSync: createSpawnSyncMock({
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
    }),
    osModule: {
      totalmem() {
        return 32 * 1024 * 1024 * 1024;
      },
      cpus() {
        return [
          { model: "Intel(R) Core(TM) i5-12490F", speed: 4600 },
          { model: "Intel(R) Core(TM) i5-12490F", speed: 4600 },
          { model: "Intel(R) Core(TM) i5-12490F", speed: 4600 },
          { model: "Intel(R) Core(TM) i5-12490F", speed: 4600 },
          { model: "Intel(R) Core(TM) i5-12490F", speed: 3200 },
          { model: "Intel(R) Core(TM) i5-12490F", speed: 3200 },
          { model: "Intel(R) Core(TM) i5-12490F", speed: 3200 },
          { model: "Intel(R) Core(TM) i5-12490F", speed: 3200 }
        ];
      }
    }
  });

  const profile = profiler.initialize();
  assert.equal(profile.runtimes.node.available, true);
  assert.equal(profile.runtimes.python.available, true);
  assert.equal(profile.runtimes.git.available, true);
  assert.equal(profile.MEMORY_PROFILE, MEMORY_PROFILES.HIGH_END);
  assert.equal(profile.memory_profile, MEMORY_PROFILES.HIGH_END);
  assert.equal(profile.core_affinity.strategy, "HYBRID");
  assert.deepEqual(profile.core_affinity.performance_core_ids, [0, 1, 2, 3]);
  assert.deepEqual(profile.core_affinity.efficiency_core_ids, [4, 5, 6, 7]);
  assert.deepEqual(profiler.getCoreAffinity().preferred_background_core_ids, [4, 5, 6, 7]);
});

test("classifyCoreTiers falls back to UNIFORM when CPU speeds do not expose tiers", () => {
  const affinity = classifyCoreTiers([
    { model: "Uniform CPU", speed: 3200 },
    { model: "Uniform CPU", speed: 3200 },
    { model: "Uniform CPU", speed: 3200 },
    { model: "Uniform CPU", speed: 3200 }
  ]);

  assert.equal(affinity.strategy, "UNIFORM");
  assert.deepEqual(affinity.efficiency_core_ids, []);
  assert.deepEqual(affinity.preferred_background_core_ids, [0, 1, 2, 3]);
});

test("SecurityGateway resolves physical path through junctions before write validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch01-security-"));
  const safeRoot = path.join(root, "safe-root");
  const workspace = path.join(safeRoot, "workspace");
  const outside = path.join(safeRoot, "outside");
  const linked = path.join(workspace, "linked-outside");

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");

  const gateway = new SecurityGateway({
    workspaceRoot: workspace,
    forbiddenZones: [
      path.join(root, "blocked-root")
    ]
  });
  gateway.initialize();

  const result = gateway.validateWrite(path.join(linked, "note.txt"));
  assert.equal(result.allowed, true);
  assert.equal(result.exists, false);
  assert.equal(result.target_path.startsWith(outside), true);
});

test("SecurityGateway blocks forbidden zones and rejects directory overwrite writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch01-security-block-"));
  const workspace = path.join(root, "workspace");
  const blocked = path.join(root, "blocked");
  const existingDir = path.join(workspace, "folder");

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(blocked, { recursive: true });
  fs.mkdirSync(existingDir, { recursive: true });

  const gateway = new SecurityGateway({
    workspaceRoot: workspace,
    forbiddenZones: [blocked]
  });
  gateway.initialize();

  assert.throws(() => gateway.validateWrite(path.join(blocked, "secret.txt")), (error) => (
    error instanceof SecurityGatewayError && error.code === "SECURITY_VIOLATION"
  ));
  assert.throws(() => gateway.validateWrite(existingDir), (error) => (
    error instanceof SecurityGatewayError && error.code === "PHYSICAL_CHECK_FAILED"
  ));
});

test("SecretVault encrypts with PBKDF2 + AES-256-GCM in worker_threads and preserves E-core hints", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch01-vault-"));
  const filePath = path.join(root, "vault.json");
  const hardwareProfiler = {
    getCoreAffinity() {
      return {
        strategy: "HYBRID",
        preferred_background_core_ids: [4, 5, 6, 7]
      };
    }
  };
  const vault = new SecretVault({
    filePath,
    masterKey: "phase1-master-key",
    hardwareProfiler
  });

  const profile = vault.initialize();
  assert.equal(profile.scheduling_hint.worker_lane, "E_CORE_BACKGROUND");
  const upserted = await vault.upsertSecret("OPENAI_API_KEY", "sk-phase1-secret-123456", {
    metadata: {
      owner: "ceo"
    }
  });
  assert.deepEqual(upserted.worker_metadata.scheduling_hint.preferred_core_ids, [4, 5, 6, 7]);

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(raw.version, CURRENT_VAULT_VERSION);
  assert.equal(raw.entries.OPENAI_API_KEY.algorithm, "aes-256-gcm");
  assert.equal(raw.entries.OPENAI_API_KEY.kdf.algorithm, "pbkdf2-sha512");
  assert.equal(raw.entries.OPENAI_API_KEY.kdf.iterations >= 210000, true);
  assert.equal(raw.entries.OPENAI_API_KEY.package.includes("sk-phase1-secret-123456"), false);

  const decrypted = await vault.getSecret("OPENAI_API_KEY");
  assert.equal(decrypted, "sk-phase1-secret-123456");

  const listed = await vault.listSecretsMasked();
  assert.equal(listed[0].masked_value.includes("***"), true);
});

test("FailClosedService panic exits with code 1 and initialization failures trigger fail-closed shutdown", () => {
  const exitCodes = [];
  const panicEvents = [];
  const failClosed = new FailClosedService({
    processModule: {
      exit(code) {
        exitCodes.push(code);
      }
    },
    onPanic(snapshot) {
      panicEvents.push(snapshot);
    }
  });

  const firstPanic = failClosed.panic("SECURITY_GATEWAY_BOOT_FAILED");
  assert.equal(firstPanic.reason, "SECURITY_GATEWAY_BOOT_FAILED");
  assert.deepEqual(exitCodes, [1]);

  const crashingGateway = {
    initialize() {
      throw new Error("workspace bootstrap failed");
    }
  };

  assert.throws(() => failClosed.initializeCriticalServices({
    SecurityGateway: crashingGateway
  }), /workspace bootstrap failed/);
  assert.deepEqual(exitCodes, [1, 1]);
  assert.equal(panicEvents.length, 2);
  assert.equal(failClosed.getLastPanic().service, "SecurityGateway");
});

test("FailClosedService seals boot when HardwareProfiler initialization fails", () => {
  const exitCodes = [];
  const failClosed = new FailClosedService({
    processModule: {
      exit(code) {
        exitCodes.push(code);
      }
    }
  });

  assert.throws(() => failClosed.initializeCriticalServices({
    HardwareProfiler: {
      initialize() {
        throw new Error("cpu topology unavailable");
      }
    }
  }), /cpu topology unavailable/);
  assert.deepEqual(exitCodes, [1]);
});
