#!/usr/bin/env node
const { parseArgs, runCommand } = require("./secret-vault");

function main() {
  const parsed = parseArgs(process.argv);
  const args = {
    ...parsed.args
  };
  runCommand("rotate", args);
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

