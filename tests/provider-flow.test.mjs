import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runCli } from "../dist/cli/index.js";

const execFileAsync = promisify(execFile);

async function tempDir(prefix = "anchor-provider-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  return { exitCode: result.exitCode, json: JSON.parse(result.output) };
}

async function setupBuildTask() {
  const repo = await tempDir();
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["config", "user.email", "anchor@example.test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["config", "user.name", "Anchor Test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo, encoding: "utf8" });

  const storePath = path.join(repo, ".anchor", "events.jsonl");
  const tasksDir = path.join(repo, ".anchor", "tasks");
  const worktreesDir = path.join(repo, ".anchor", "worktrees");
  const paths = { storePath, tasksDir, worktreesDir };

  const plan = await runJson(["plan", "Provider metadata test"], paths);
  assert.equal(plan.exitCode, 0);
  await runJson(["approve", plan.json.taskId], paths);
  await runJson(["workspace", "create", plan.json.taskId], paths);
  return { repo, paths, taskId: plan.json.taskId };
}

test("fixture generator and evaluator use provider interface and emit provider metadata", async () => {
  const { paths, taskId } = await setupBuildTask();

  const generate = await runJson(["generate", taskId, "--adapter", "fixture"], paths);
  assert.equal(generate.exitCode, 0);
  assert.equal(generate.json.reportPath.endsWith("generator-report.json"), true);
  assert.equal(generate.json.event.payload.provider, "fixture");

  const generatorReport = JSON.parse(await readFile(generate.json.reportPath, "utf8"));
  assert.equal(generatorReport.adapter, "fixture");
  assert.equal(generatorReport.provider, "fixture");
  assert.equal(generatorReport.taskId, taskId);

  const evaluate = await runJson(["evaluate", taskId, "--provider", "fixture", "--verdict", "pass"], paths);
  assert.equal(evaluate.exitCode, 0);
  assert.equal(evaluate.json.event.payload.provider, "fixture");

  const evaluatorReport = JSON.parse(await readFile(evaluate.json.reportPath, "utf8"));
  assert.equal(evaluatorReport.adapter, "fixture");
  assert.equal(evaluatorReport.provider, "fixture");
  assert.equal(evaluatorReport.verdict, "PASS");

  const events = await runJson(["events", taskId], paths);
  const codeProduced = events.json.events.find((event) => event.event_type === "CODE_PRODUCED");
  const evalComplete = events.json.events.find((event) => event.event_type === "EVAL_COMPLETE");
  assert.equal(codeProduced.payload.provider, "fixture");
  assert.equal(evalComplete.payload.provider, "fixture");
});

test("unknown generator and evaluator providers return stable JSON errors", async () => {
  const { paths, taskId } = await setupBuildTask();

  const unknownGenerate = await runJson(["generate", taskId, "--provider", "pi"], paths);
  assert.equal(unknownGenerate.exitCode, 1);
  assert.equal(unknownGenerate.json.ok, false);
  assert.equal(unknownGenerate.json.error.code, "UNKNOWN_PROVIDER");
  assert.match(unknownGenerate.json.error.message, /pi/);

  const generate = await runJson(["generate", taskId, "--adapter", "fixture"], paths);
  assert.equal(generate.exitCode, 0);

  const unknownEvaluate = await runJson(["evaluate", taskId, "--provider", "pi", "--verdict", "pass"], paths);
  assert.equal(unknownEvaluate.exitCode, 1);
  assert.equal(unknownEvaluate.json.ok, false);
  assert.equal(unknownEvaluate.json.error.code, "UNKNOWN_PROVIDER");
  assert.match(unknownEvaluate.json.error.message, /pi/);
});
