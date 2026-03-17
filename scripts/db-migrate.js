#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const {
  SqliteRuntimeDatabase,
  migrateRuntimeDatabaseDown,
  migrateRuntimeDatabaseUp
} = require("../src/persistence/sqliteRuntimeStore");

function parseArgs(argv) {
  const args = {};
  for (let idx = 2; idx < argv.length; idx += 1) {
    const token = argv[idx];
    if (token === "--up") {
      args.direction = "up";
      continue;
    }
    if (token === "--down") {
      args.direction = "down";
      continue;
    }
    if (token === "--db" && argv[idx + 1]) {
      args.dbPath = argv[idx + 1];
      idx += 1;
      continue;
    }
    if (token === "--config" && argv[idx + 1]) {
      args.configPath = argv[idx + 1];
      idx += 1;
    }
  }
  return args;
}

function loadRuntimeDbConfig(configPath = "config/runtime_db.json") {
  const fallback = {
    enabled: false,
    db_path: "data/runtime-state.db"
  };
  if (!fs.existsSync(configPath)) {
    return fallback;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fallback;
    }
    return {
      enabled: raw.enabled === true,
      db_path: String(raw.db_path || fallback.db_path)
    };
  } catch {
    return fallback;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const config = loadRuntimeDbConfig(args.configPath || "config/runtime_db.json");
  const dbPath = args.dbPath || config.db_path;
  const direction = args.direction || "up";

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const runtimeDb = new SqliteRuntimeDatabase({
    dbPath,
    autoMigrate: false
  });

  try {
    if (direction === "down") {
      migrateRuntimeDatabaseDown(runtimeDb.db);
    } else {
      migrateRuntimeDatabaseUp(runtimeDb.db);
    }
    const result = {
      direction,
      db_path: dbPath,
      success: true,
      timestamp: new Date().toISOString()
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } finally {
    runtimeDb.close();
  }
}

if (require.main === module) {
  main();
}
