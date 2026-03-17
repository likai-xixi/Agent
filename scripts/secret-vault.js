#!/usr/bin/env node
const { JsonFileSecretVault } = require("../src/platform/secretVault");

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return {
    command: positional[0] || "list",
    args
  };
}

function createVault(args = {}) {
  return new JsonFileSecretVault({
    filePath: args.file || "",
    auditLogPath: args["audit-log"] || "",
    masterKey: args.key || ""
  });
}

function printJson(payload) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

function runCommand(command, args) {
  const vault = createVault(args);
  if (command === "set") {
    if (!args.name || !args.value) {
      throw new Error("set requires --name and --value");
    }
    const result = vault.upsertSecret(args.name, args.value, {
      actor: args.actor || "operator"
    });
    printJson({
      status: "ok",
      action: "set",
      secret: result
    });
    return;
  }
  if (command === "get") {
    if (!args.name) {
      throw new Error("get requires --name");
    }
    const value = vault.getSecret(args.name);
    printJson({
      status: "ok",
      action: "get",
      secret: {
        name: args.name,
        exists: Boolean(value),
        masked_value: value ? `${value.slice(0, 2)}***${value.slice(-2)}` : ""
      }
    });
    return;
  }
  if (command === "rotate") {
    const newKey = args["new-key"] || args.newKey || "";
    if (!newKey) {
      throw new Error("rotate requires --new-key");
    }
    const result = vault.rotateMasterKey(newKey, {
      actor: args.actor || "operator"
    });
    printJson({
      status: "ok",
      action: "rotate",
      result
    });
    return;
  }
  if (command === "list") {
    printJson({
      status: "ok",
      action: "list",
      secrets: vault.listSecretsMasked()
    });
    return;
  }
  throw new Error(`unsupported command: ${command}`);
}

function main() {
  const { command, args } = parseArgs(process.argv);
  runCommand(command, args);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  createVault,
  parseArgs,
  runCommand
};
