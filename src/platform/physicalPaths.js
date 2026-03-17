const fs = require("fs");
const path = require("path");

function resolveRealpathSync(targetPath) {
  if (fs.realpathSync.native) {
    return fs.realpathSync.native(targetPath);
  }
  return fs.realpathSync(targetPath);
}

function normalizeComparisonPath(targetPath) {
  return path.resolve(String(targetPath || "")).toLowerCase().replace(/[\\/]+$/, "");
}

function createPathPrefixMatcher(rootPath) {
  const normalizedRoot = normalizeComparisonPath(rootPath);
  return {
    exact: normalizedRoot,
    nested: `${normalizedRoot}${path.sep.toLowerCase()}`
  };
}

function startsWithPathPrefix(targetPath, rootPath) {
  if (!rootPath) {
    return false;
  }
  const normalizedTarget = normalizeComparisonPath(targetPath);
  const matcher = createPathPrefixMatcher(rootPath);
  return normalizedTarget === matcher.exact || normalizedTarget.startsWith(matcher.nested);
}

function resolvePhysicalPath(targetPath) {
  const absolutePath = path.resolve(String(targetPath || ""));
  const exists = fs.existsSync(absolutePath);
  if (exists) {
    const physicalPath = resolveRealpathSync(absolutePath);
    return {
      absolute_path: absolutePath,
      physical_path: path.resolve(physicalPath),
      existing_path: absolutePath,
      physical_existing_path: path.resolve(physicalPath),
      exists: true
    };
  }

  let probe = absolutePath;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }

  if (!fs.existsSync(probe)) {
    return {
      absolute_path: absolutePath,
      physical_path: absolutePath,
      existing_path: "",
      physical_existing_path: "",
      exists: false
    };
  }

  const physicalExisting = path.resolve(resolveRealpathSync(probe));
  const relativeTail = path.relative(probe, absolutePath);
  const physicalPath = relativeTail
    ? path.resolve(path.join(physicalExisting, relativeTail))
    : physicalExisting;

  return {
    absolute_path: absolutePath,
    physical_path: physicalPath,
    existing_path: probe,
    physical_existing_path: physicalExisting,
    exists: false
  };
}

module.exports = {
  createPathPrefixMatcher,
  normalizeComparisonPath,
  resolvePhysicalPath,
  resolveRealpathSync,
  startsWithPathPrefix
};
