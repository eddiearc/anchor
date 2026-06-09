#!/usr/bin/env node

import { anchorVersion, getAnchorHelp } from "../index.js";

export function runCli(args: string[]) {
  if (args.includes("--version") || args.includes("-v")) {
    return anchorVersion;
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return getAnchorHelp();
  }

  const [command] = args;
  return [`Unknown command: ${command}`, "", getAnchorHelp()].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(runCli(process.argv.slice(2)));
}
