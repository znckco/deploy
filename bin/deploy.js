#!/usr/bin/env node

const { cli } = require("../lib/cli");

cli(process.argv.slice(2)).catch((error) => {
  console.error(`Error: ${error.code} - ${error.message}`);
  process.exit(2);
});
