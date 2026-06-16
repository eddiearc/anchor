#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const tscBin = path.join("node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(tscBin)) {
  run("npm", ["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"]);
}

run("npm", ["run", "build"]);
