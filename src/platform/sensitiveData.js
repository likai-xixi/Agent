const path = require("path");

const CHINA_ID_RE = /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
const API_KEY_RE = /\b(?:sk-[a-zA-Z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z-_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^<>:"/\\|?*\r\n]+\\)*[^<>:"/\\|?*\r\n]*/g;
const UNIX_PATH_RE = /(?:\/[^/\s]+)+/g;

function shouldMaskAbsolutePath(value, options = {}) {
  const allowedRoots = Array.isArray(options.allowedRoots)
    ? options.allowedRoots.map((item) => path.resolve(String(item)))
    : [];
  const absolute = path.resolve(String(value));
  return !allowedRoots.some((root) => absolute.startsWith(root));
}

function scrubString(input, options = {}) {
  let output = String(input || "");
  output = output.replace(CHINA_ID_RE, "[REDACTED_ID]");
  output = output.replace(API_KEY_RE, "[REDACTED_API_KEY]");
  output = output.replace(WINDOWS_PATH_RE, (match) => (
    shouldMaskAbsolutePath(match, options) ? "[REDACTED_PATH]" : match
  ));
  output = output.replace(UNIX_PATH_RE, (match) => (
    shouldMaskAbsolutePath(match, options) ? "[REDACTED_PATH]" : match
  ));
  return output;
}

function scrubSensitiveData(value, options = {}) {
  if (typeof value === "string") {
    return scrubString(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveData(item, options));
  }
  if (value && typeof value === "object") {
    const clone = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = scrubSensitiveData(item, options);
    }
    return clone;
  }
  return value;
}

module.exports = {
  scrubSensitiveData,
  scrubString
};
