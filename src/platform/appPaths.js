const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function resolveProjectPath(...segments) {
  return path.resolve(PROJECT_ROOT, ...segments);
}

function resolveDataRoot(explicitRoot = "") {
  const configured = String(explicitRoot || process.env.AGENT_DATA_DIR || "").trim();
  const fallback = resolveProjectPath("data");
  const root = configured ? path.resolve(configured) : fallback;
  return ensureDir(root);
}

function resolveDataPath(...segments) {
  return path.resolve(resolveDataRoot(), ...segments);
}

function normalizePortablePath(targetPath, options = {}) {
  const dataRoot = resolveDataRoot(options.dataRoot);
  const absolute = path.resolve(targetPath);
  const relative = path.relative(dataRoot, absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, "/");
  }
  return absolute.replace(/\\/g, "/");
}

function materializePortablePath(portablePath, options = {}) {
  const value = String(portablePath || "").trim();
  if (!value) {
    return resolveDataRoot(options.dataRoot);
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(resolveDataRoot(options.dataRoot), value);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

module.exports = {
  PROJECT_ROOT,
  ensureDir,
  materializePortablePath,
  normalizePortablePath,
  readJsonFile,
  resolveDataPath,
  resolveDataRoot,
  resolveProjectPath,
  writeJsonFile
};
