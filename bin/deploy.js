#!/usr/bin/env node

import { cli } from "../lib/index.js";

cli(process.argv.slice(2)).catch((error) => {
  console.error(`Error: ${error.code} - ${error.message}`);
  process.exit(2);
});
