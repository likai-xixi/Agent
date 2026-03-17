// [FILE]: src/core/HardwareProfiler.js
const cp = require("child_process");
const os = require("os");

const { ValidationError, nowUtcIso } = require("../platform/contracts");

const MEMORY_PROFILES = Object.freeze({
  HIGH_END: "HIGH_END",
  STANDARD: "STANDARD",
  CONSTRAINED: "CONSTRAINED"
});

const CPU_ARCHITECTURES = Object.freeze({
  INTEL_HYBRID: "INTEL_HYBRID",
  INTEL_LEGACY: "INTEL_LEGACY",
  AMD_ALL_BIG_CORES: "AMD_ALL_BIG_CORES",
  GENERIC_UNIFORM: "GENERIC_UNIFORM"
});

const NODE_CAPABILITY_TAGS = Object.freeze({
  COMPUTE_NODE: "COMPUTE_NODE",
  IO_NODE: "IO_NODE",
  BALANCED_NODE: "BALANCED_NODE"
});

const SELF_HEAL_RECIPES = Object.freeze({
  node: "RESTORE_NODE_RUNTIME",
  python: "INSTALL_OR_REPAIR_PYTHON_3_10_PLUS",
  git: "INSTALL_OR_REPAIR_GIT"
});

const DEFAULT_DEPENDENCY_DEFINITIONS = Object.freeze([
  {
    name: "node",
    candidates: ["node"],
    version_args: ["--version"]
  },
  {
    name: "python",
    candidates: ["python", "python3"],
    version_args: ["--version"]
  },
  {
    name: "git",
    candidates: ["git"],
    version_args: ["--version"]
  }
]);

const BACKGROUND_TASK_TYPES = new Set(["CRYPTO", "SCANNING"]);
const COMPUTE_TASK_TYPES = new Set(["LOCAL_LLM", "VIDEO_RENDER"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstNonEmptyLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function resolveCommandOnPath(command, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSync = options.spawnSync || cp.spawnSync;
  const locator = platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [String(command || "")], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  if ((result.status ?? 1) !== 0) {
    return "";
  }
  return firstNonEmptyLine(result.stdout || "");
}

function probeDependency(definition, options = {}) {
  const spawnSync = options.spawnSync || cp.spawnSync;
  const platform = options.platform || process.platform;
  const candidates = Array.isArray(definition.candidates) ? definition.candidates : [definition.name];

  for (const candidate of candidates) {
    const locatedPath = resolveCommandOnPath(candidate, {
      platform,
      spawnSync
    });
    const result = spawnSync(candidate, definition.version_args || ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    });
    if ((result.status ?? 1) !== 0) {
      continue;
    }
    return {
      name: definition.name,
      available: true,
      command: candidate,
      path: locatedPath || candidate,
      version: firstNonEmptyLine(`${result.stdout || ""}\n${result.stderr || ""}`)
    };
  }

  return {
    name: definition.name,
    available: false,
    command: "",
    path: "",
    version: "",
    error: `${definition.name} is not available in PATH`
  };
}

function parseCpuVendor(model) {
  const normalized = String(model || "").toLowerCase();
  if (normalized.includes("intel")) {
    return "INTEL";
  }
  if (normalized.includes("amd") || normalized.includes("ryzen") || normalized.includes("epyc")) {
    return "AMD";
  }
  return "UNKNOWN";
}

function parseIntelGeneration(model) {
  const normalized = String(model || "");
  const match = normalized.match(/i[3579]-([0-9]{4,5})/i) || normalized.match(/intel\(r\).+?([0-9]{4,5})/i);
  if (!match) {
    return 0;
  }
  const sku = String(match[1] || "");
  if (sku.length === 5) {
    return Number(sku.slice(0, 2));
  }
  return Number(sku.slice(0, 1));
}

function classifyCoreTiers(cpuEntries = []) {
  const normalized = cpuEntries.map((cpu, index) => ({
    core_index: index,
    model: String(cpu && cpu.model ? cpu.model : "").trim(),
    speed_mhz: Number(cpu && cpu.speed ? cpu.speed : 0)
  }));
  const allIndices = normalized.map((entry) => entry.core_index);
  const uniqueSpeeds = [...new Set(normalized.map((entry) => entry.speed_mhz).filter((speed) => speed > 0))]
    .sort((left, right) => right - left);

  let strategy = "UNIFORM";
  let detectionConfidence = "low";
  let performanceCoreIds = [...allIndices];
  let efficiencyCoreIds = [];

  if (uniqueSpeeds.length >= 2) {
    strategy = "HYBRID";
    detectionConfidence = "medium";
    const maxSpeed = uniqueSpeeds[0];
    const minSpeed = uniqueSpeeds[uniqueSpeeds.length - 1];
    const threshold = (maxSpeed + minSpeed) / 2;

    performanceCoreIds = normalized
      .filter((entry) => entry.speed_mhz > threshold)
      .map((entry) => entry.core_index);
    efficiencyCoreIds = normalized
      .filter((entry) => entry.speed_mhz <= threshold)
      .map((entry) => entry.core_index);

    if (performanceCoreIds.length === 0 || efficiencyCoreIds.length === 0) {
      performanceCoreIds = normalized
        .filter((entry) => entry.speed_mhz === maxSpeed)
        .map((entry) => entry.core_index);
      efficiencyCoreIds = normalized
        .filter((entry) => entry.speed_mhz !== maxSpeed)
        .map((entry) => entry.core_index);
    }
  }

  return {
    strategy,
    detection_confidence: detectionConfidence,
    logical_core_count: normalized.length,
    performance_core_ids: performanceCoreIds,
    efficiency_core_ids: efficiencyCoreIds,
    preferred_foreground_core_ids: performanceCoreIds.length > 0 ? performanceCoreIds : allIndices,
    preferred_background_core_ids: efficiencyCoreIds.length > 0 ? efficiencyCoreIds : allIndices,
    speed_buckets_mhz: uniqueSpeeds,
    cores: normalized
  };
}

function classifyCpuArchitecture(cpuEntries = [], affinity = classifyCoreTiers(cpuEntries)) {
  const models = cpuEntries
    .map((entry) => String(entry && entry.model ? entry.model : "").trim())
    .filter(Boolean);
  const primaryModel = models[0] || "";
  const vendor = parseCpuVendor(primaryModel);
  const intelGeneration = vendor === "INTEL" ? parseIntelGeneration(primaryModel) : 0;

  if (vendor === "AMD") {
    return {
      family: CPU_ARCHITECTURES.AMD_ALL_BIG_CORES,
      vendor,
      intel_generation: 0,
      hybrid_expected: false,
      all_big_cores: true
    };
  }

  if (vendor === "INTEL" && (affinity.strategy === "HYBRID" || intelGeneration >= 12)) {
    return {
      family: CPU_ARCHITECTURES.INTEL_HYBRID,
      vendor,
      intel_generation: intelGeneration,
      hybrid_expected: true,
      all_big_cores: false
    };
  }

  if (vendor === "INTEL") {
    return {
      family: CPU_ARCHITECTURES.INTEL_LEGACY,
      vendor,
      intel_generation: intelGeneration,
      hybrid_expected: false,
      all_big_cores: false
    };
  }

  return {
    family: CPU_ARCHITECTURES.GENERIC_UNIFORM,
    vendor,
    intel_generation: 0,
    hybrid_expected: affinity.strategy === "HYBRID",
    all_big_cores: affinity.strategy !== "HYBRID"
  };
}

function normalizeGpuController(raw = {}) {
  const name = String(raw.Name || raw.name || "").trim();
  const compatibility = String(raw.AdapterCompatibility || raw.adapter_compatibility || "").trim();
  const videoProcessor = String(raw.VideoProcessor || raw.video_processor || "").trim();
  const rawBytes = Number(raw.AdapterRAM || raw.adapter_ram_bytes || raw.vram_bytes || 0);
  const normalizedName = `${name} ${compatibility} ${videoProcessor}`.toLowerCase();
  const isIntegrated = /(intel|uhd|iris|igpu|integrated|apu)/i.test(normalizedName);

  return {
    name,
    adapter_compatibility: compatibility,
    video_processor: videoProcessor,
    vram_bytes: Number.isFinite(rawBytes) && rawBytes > 0 ? rawBytes : 0,
    vram_gb: Number.isFinite(rawBytes) && rawBytes > 0 ? Number((rawBytes / (1024 ** 3)).toFixed(2)) : 0,
    integrated: isIntegrated,
    dedicated: !isIntegrated && rawBytes > 0
  };
}

function defaultGpuInfoProvider(options = {}) {
  const platform = options.platform || process.platform;
  const spawnSync = options.spawnSync || cp.spawnSync;

  if (platform !== "win32") {
    return [];
  }

  const result = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,VideoProcessor,AdapterCompatibility | ConvertTo-Json -Compress"
  ], {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true
  });

  if ((result.status ?? 1) !== 0) {
    return [];
  }

  const rawOutput = String(result.stdout || "").trim();
  if (!rawOutput) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawOutput);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((entry) => normalizeGpuController(entry));
  } catch {
    return [];
  }
}

function classifyGpuNode(controllers = []) {
  const normalized = controllers.map((entry) => normalizeGpuController(entry));
  const dedicated = normalized.filter((entry) => entry.dedicated);
  const maxDedicatedVram = dedicated.reduce((maxValue, entry) => Math.max(maxValue, entry.vram_gb), 0);
  const maxAnyVram = normalized.reduce((maxValue, entry) => Math.max(maxValue, entry.vram_gb), 0);

  let nodeCapability = NODE_CAPABILITY_TAGS.BALANCED_NODE;
  if (maxDedicatedVram > 6) {
    nodeCapability = NODE_CAPABILITY_TAGS.COMPUTE_NODE;
  } else if (dedicated.length === 0 || maxAnyVram < 2) {
    nodeCapability = NODE_CAPABILITY_TAGS.IO_NODE;
  }

  return {
    node_capability: nodeCapability,
    gpu_count: normalized.length,
    dedicated_gpu_count: dedicated.length,
    max_dedicated_vram_gb: maxDedicatedVram,
    max_vram_gb: maxAnyVram,
    controllers: normalized
  };
}

function buildMemoryRuntimeProfile(totalMemoryBytes) {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new ValidationError("Unable to determine total system memory");
  }

  if (totalMemoryBytes >= 32 * 1024 * 1024 * 1024) {
    return {
      profile_name: MEMORY_PROFILES.HIGH_END,
      ram_buffer_bytes: 2 * 1024 * 1024 * 1024,
      vector_store_mount: "MEMORY",
      preload_enabled: true,
      aggressive_reclaim: false
    };
  }

  if (totalMemoryBytes >= 16 * 1024 * 1024 * 1024) {
    return {
      profile_name: MEMORY_PROFILES.STANDARD,
      ram_buffer_bytes: 512 * 1024 * 1024,
      vector_store_mount: "HYBRID",
      preload_enabled: true,
      aggressive_reclaim: false
    };
  }

  return {
    profile_name: MEMORY_PROFILES.CONSTRAINED,
    ram_buffer_bytes: 0,
    vector_store_mount: "DISK_ONLY",
    preload_enabled: false,
    aggressive_reclaim: true
  };
}

class HardwareProfiler {
  constructor(options = {}) {
    this.os = options.osModule || os;
    this.spawnSync = options.spawnSync || cp.spawnSync;
    this.platform = options.platform || process.platform;
    this.dependencies = options.dependencies || DEFAULT_DEPENDENCY_DEFINITIONS;
    this.gpuInfoProvider = options.gpuInfoProvider || (() => defaultGpuInfoProvider({
      platform: this.platform,
      spawnSync: this.spawnSync
    }));
    this.profile = null;
    this.MEMORY_PROFILE = MEMORY_PROFILES.CONSTRAINED;
  }

  detectRuntimeDependencies() {
    const runtimes = {};
    for (const definition of this.dependencies) {
      runtimes[definition.name] = probeDependency(definition, {
        spawnSync: this.spawnSync,
        platform: this.platform
      });
    }
    return runtimes;
  }

  detectMemoryProfile() {
    return buildMemoryRuntimeProfile(Number(this.os.totalmem())).profile_name;
  }

  buildMemoryRuntime() {
    return buildMemoryRuntimeProfile(Number(this.os.totalmem()));
  }

  calculateBackgroundThreadCap(affinity, cpuArchitecture) {
    const logicalCoreCount = Number(affinity.logical_core_count || 1);
    if (cpuArchitecture.family === CPU_ARCHITECTURES.AMD_ALL_BIG_CORES) {
      return Math.max(1, Math.floor(logicalCoreCount * 0.3));
    }
    if (cpuArchitecture.family === CPU_ARCHITECTURES.INTEL_HYBRID && affinity.preferred_background_core_ids.length > 0) {
      return Math.max(1, affinity.preferred_background_core_ids.length);
    }
    return Math.max(1, Math.floor(logicalCoreCount * 0.5));
  }

  buildCpuTopology() {
    const cpuEntries = this.os.cpus();
    if (!Array.isArray(cpuEntries) || cpuEntries.length === 0) {
      throw new ValidationError("Unable to read CPU topology from os.cpus()");
    }
    const affinity = classifyCoreTiers(cpuEntries);
    const architecture = classifyCpuArchitecture(cpuEntries, affinity);
    return {
      logical_core_count: cpuEntries.length,
      models: [...new Set(cpuEntries.map((entry) => String(entry.model || "").trim()).filter(Boolean))],
      speed_buckets_mhz: affinity.speed_buckets_mhz,
      affinity,
      architecture,
      background_thread_cap: this.calculateBackgroundThreadCap(affinity, architecture)
    };
  }

  detectGpuControllers() {
    const controllers = this.gpuInfoProvider();
    if (!controllers) {
      return [];
    }
    return Array.isArray(controllers) ? controllers.map((entry) => normalizeGpuController(entry)) : [];
  }

  buildGpuProfile() {
    return classifyGpuNode(this.detectGpuControllers());
  }

  buildExecutionPolicy(cpuTopology, gpuProfile, memoryRuntime) {
    return {
      cpu_architecture: cpuTopology.architecture.family,
      background_thread_cap: cpuTopology.background_thread_cap,
      preferred_background_core_ids: [...cpuTopology.affinity.preferred_background_core_ids],
      preferred_foreground_core_ids: [...cpuTopology.affinity.preferred_foreground_core_ids],
      node_capability: gpuProfile.node_capability,
      background_priority: cpuTopology.architecture.family === CPU_ARCHITECTURES.INTEL_HYBRID
        ? "PRIORITY_BELOW_NORMAL"
        : "NORMAL",
      memory_mode: memoryRuntime.profile_name,
      vector_store_mount: memoryRuntime.vector_store_mount
    };
  }

  getCoreAffinity() {
    if (this.profile && this.profile.core_affinity) {
      return clone(this.profile.core_affinity);
    }
    return clone(this.buildCpuTopology().affinity);
  }

  getExecutionPolicy() {
    if (this.profile && this.profile.execution_policy) {
      return clone(this.profile.execution_policy);
    }
    const cpuTopology = this.buildCpuTopology();
    const gpuProfile = this.buildGpuProfile();
    const memoryRuntime = this.buildMemoryRuntime();
    return clone(this.buildExecutionPolicy(cpuTopology, gpuProfile, memoryRuntime));
  }

  getNodeCapability() {
    if (this.profile && this.profile.gpu_profile) {
      return this.profile.gpu_profile.node_capability;
    }
    return this.buildGpuProfile().node_capability;
  }

  buildTaskExecutionPolicy(taskType) {
    const executionPolicy = this.getExecutionPolicy();
    const normalizedTaskType = String(taskType || "GENERIC").trim().toUpperCase() || "GENERIC";
    const isBackgroundTask = BACKGROUND_TASK_TYPES.has(normalizedTaskType);
    const isComputeTask = COMPUTE_TASK_TYPES.has(normalizedTaskType);

    return {
      task_type: normalizedTaskType,
      background: isBackgroundTask,
      compute_intensive: isComputeTask,
      node_capability: executionPolicy.node_capability,
      cpu_architecture: executionPolicy.cpu_architecture,
      priority_class: isBackgroundTask && executionPolicy.cpu_architecture === CPU_ARCHITECTURES.INTEL_HYBRID
        ? "PRIORITY_BELOW_NORMAL"
        : "NORMAL",
      preferred_core_ids: isBackgroundTask
        ? executionPolicy.preferred_background_core_ids
        : executionPolicy.preferred_foreground_core_ids,
      max_concurrency: isBackgroundTask
        ? executionPolicy.background_thread_cap
        : Math.max(1, executionPolicy.preferred_foreground_core_ids.length || 1),
      vector_store_mount: executionPolicy.vector_store_mount
    };
  }

  initialize() {
    const runtimes = this.detectRuntimeDependencies();
    const cpuTopology = this.buildCpuTopology();
    const gpuProfile = this.buildGpuProfile();
    const memoryRuntime = this.buildMemoryRuntime();
    const memoryProfile = memoryRuntime.profile_name;
    const missingDependencies = Object.values(runtimes)
      .filter((entry) => entry.available !== true)
      .map((entry) => entry.name);
    const executionPolicy = this.buildExecutionPolicy(cpuTopology, gpuProfile, memoryRuntime);

    this.MEMORY_PROFILE = memoryProfile;
    this.profile = {
      initialized_at: nowUtcIso(),
      runtimes,
      missing_dependencies: missingDependencies,
      self_heal_required: missingDependencies.length > 0,
      self_heal_actions: missingDependencies.map((name) => SELF_HEAL_RECIPES[name] || `REPAIR_${String(name || "").toUpperCase()}`),
      cpu_topology: cpuTopology,
      core_affinity: cpuTopology.affinity,
      cpu_architecture: cpuTopology.architecture,
      gpu_profile: gpuProfile,
      node_capability: gpuProfile.node_capability,
      memory_profile: memoryProfile,
      MEMORY_PROFILE: memoryProfile,
      memory_runtime: memoryRuntime,
      execution_policy: executionPolicy,
      total_memory_bytes: Number(this.os.totalmem())
    };

    return clone(this.profile);
  }
}

module.exports = {
  CPU_ARCHITECTURES,
  DEFAULT_DEPENDENCY_DEFINITIONS,
  HardwareProfiler,
  MEMORY_PROFILES,
  NODE_CAPABILITY_TAGS,
  SELF_HEAL_RECIPES,
  buildMemoryRuntimeProfile,
  classifyCoreTiers,
  classifyCpuArchitecture,
  classifyGpuNode,
  defaultGpuInfoProvider,
  probeDependency,
  resolveCommandOnPath
};
