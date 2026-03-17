// [FILE]: src/core/index.js
const {
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
} = require("./HardwareProfiler");
const {
  RAW_FORBIDDEN_PREFIXES,
  SecurityGateway,
  SecurityGatewayError,
  buildDefaultForbiddenZones,
  normalizePathPrefix,
  resolvePhysicalCandidate
} = require("./SecurityGateway");
const {
  FailClosedPanicError,
  FailClosedService
} = require("./FailClosedService");
const {
  CURRENT_VAULT_VERSION,
  DEFAULT_KDF_CONFIG,
  SecretVault,
  createKdfConfig,
  maskSecretValue
} = require("./SecretVault");
const {
  BELOW_NORMAL_PRIORITY,
  GHOST_SLEEP_REASONS,
  LocalExecutor,
  TASK_TYPES,
  VRAMWatcher
} = require("./LocalExecutor");

module.exports = {
  BELOW_NORMAL_PRIORITY,
  CPU_ARCHITECTURES,
  DEFAULT_DEPENDENCY_DEFINITIONS,
  CURRENT_VAULT_VERSION,
  DEFAULT_KDF_CONFIG,
  FailClosedPanicError,
  FailClosedService,
  GHOST_SLEEP_REASONS,
  HardwareProfiler,
  LocalExecutor,
  MEMORY_PROFILES,
  NODE_CAPABILITY_TAGS,
  RAW_FORBIDDEN_PREFIXES,
  SecretVault,
  SELF_HEAL_RECIPES,
  SecurityGateway,
  SecurityGatewayError,
  TASK_TYPES,
  VRAMWatcher,
  buildMemoryRuntimeProfile,
  buildDefaultForbiddenZones,
  classifyCoreTiers,
  classifyCpuArchitecture,
  classifyGpuNode,
  createKdfConfig,
  defaultGpuInfoProvider,
  maskSecretValue,
  normalizePathPrefix,
  probeDependency,
  resolveCommandOnPath,
  resolvePhysicalCandidate
};
