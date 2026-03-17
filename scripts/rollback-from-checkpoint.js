#!/usr/bin/env node
const fs = require("fs");
const cp = require("child_process");

const PLACEHOLDER_MARKERS = ["TO_BE_FILLED", "<", "N/A"];

function parseArgs(argv) {
  const args = { execute: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--execute") {
      args.execute = true;
      continue;
    }
    if (token === "--checkpoint" && argv[i + 1]) {
      args.checkpoint = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function shouldSkip(command) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return true;
  }
  return PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
}

function run(command) {
  console.log(`[RUN] ${command}`);
  const result = cp.spawnSync(command, { shell: true, stdio: "inherit" });
  return result.status ?? 1;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.checkpoint) {
    console.error("Missing required arg: --checkpoint <path-to-ckpt.json>");
    process.exit(1);
  }
  if (!fs.existsSync(args.checkpoint)) {
    console.error(`Checkpoint file not found: ${args.checkpoint}`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(args.checkpoint, "utf8"));
  const commit = String(payload.git_commit || "").trim();
  const dbDown = String(payload.db_down_migration || "").trim();
  const configRollback = String(payload.config_rollback || "").trim();
  const healthChecks = Array.isArray(payload.health_checks) ? payload.health_checks : [];

  const commands = [];
  if (commit) {
    commands.push(`git revert --no-edit ${commit}`);
  }
  commands.push(dbDown);
  commands.push(configRollback);

  console.log("Rollback plan:");
  commands.forEach((command) => {
    if (!shouldSkip(command)) {
      console.log(`- ${command}`);
    }
  });
  console.log("Post-rollback health checks:");
  healthChecks.forEach((check) => console.log(`- ${check}`));

  if (!args.execute) {
    console.log("Dry-run mode. Add --execute to run commands.");
    return;
  }

  for (const command of commands) {
    if (shouldSkip(command)) {
      continue;
    }
    const code = run(command);
    if (code !== 0) {
      console.error(`Command failed with code ${code}: ${command}`);
      process.exit(code);
    }
  }

  for (const check of healthChecks) {
    const code = run(String(check));
    if (code !== 0) {
      console.error(`Health check failed with code ${code}: ${check}`);
      process.exit(code);
    }
  }
  console.log("Rollback execution completed.");
}

main();

