import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runCli } from "../dist/cli/index.js";

const execFileAsync = promisify(execFile);

async function tempPaths() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-retry-"));
  return {
    storePath: path.join(dir, "runs.jsonl"),
    runsDir: path.join(dir, "runs"),
    worktreesDir: path.join(dir, "worktrees")
  };
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  assert.equal(result.exitCode, 0);
  return JSON.parse(result.output);
}

async function preparedWorkspace(paths) {
  const plan = await runJson(["plan", "Retry fixture orchestration"], paths);
  await runJson(["approve", plan.runId], paths);
  const workspace = await runJson(["workspace", "create", plan.runId], paths);
  return { plan, workspace };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function cleanupWorktree(workspace) {
  await execFileAsync("git", ["worktree", "remove", "--force", workspace.worktreePath], { encoding: "utf8" }).catch(() => {});
  await execFileAsync("git", ["branch", "-D", workspace.branch], { encoding: "utf8" }).catch(() => {});
}

async function worktreeFiles(worktreePath) {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8"
  });
  return stdout.trim().split("\n").filter(Boolean);
}

function attemptReport(paths, runId, attempt, role) {
  return path.join(paths.runsDir, runId, "attempts", String(attempt), `${role}-report.json`);
}

test("run-retry with fail-times 0 reaches DONE with one generator and evaluator attempt", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const retried = await runJson(["run-retry", plan.runId, "--fail-times", "0"], paths);

  assert.equal(retried.ok, true);
  assert.equal(retried.command, "run-retry");
  assert.equal(retried.state, "DONE");
  assert.equal(retried.failTimes, 0);
  assert.equal(retried.steps.length, 2);
  assert.deepEqual(
    retried.steps.map((step) => [step.role, step.attempt]),
    [
      ["generator", 1],
      ["evaluator", 1]
    ]
  );
  assert.match(retried.steps[0].reportPath, /attempts\/1\/generator-report\.json$/);
  assert.match(retried.steps[1].reportPath, /attempts\/1\/evaluator-report\.json$/);

  const events = await runJson(["events", plan.runId], paths);
  assert.deepEqual(
    events.events.map((event) => event.event_type),
    ["TASK_RECEIVED", "CONTRACT_PRODUCED", "CONTRACT_APPROVED", "WORKSPACE_CREATED", "CODE_PRODUCED", "EVAL_COMPLETE"]
  );
  const codeEvent = events.events.find((event) => event.event_type === "CODE_PRODUCED");
  const evalEvent = events.events.find((event) => event.event_type === "EVAL_COMPLETE");
  assert.equal(codeEvent.payload.attempt, 1);
  assert.equal(evalEvent.payload.attempt, 1);
  assert.equal(evalEvent.payload.verdict, "PASS");
  assert.equal(codeEvent.payload.report_path, retried.steps[0].reportPath);
  assert.equal(evalEvent.payload.report_path, retried.steps[1].reportPath);

  const generatorReport = JSON.parse(await readFile(attemptReport(paths, plan.runId, 1, "generator"), "utf8"));
  const evaluatorReport = JSON.parse(await readFile(attemptReport(paths, plan.runId, 1, "evaluator"), "utf8"));
  assert.equal(generatorReport.attempt, 1);
  assert.equal(evaluatorReport.attempt, 1);
  assert.equal(evaluatorReport.generatorReportPath, retried.steps[0].reportPath);
  assert.equal(await exists(path.join(process.cwd(), "anchor-output", `${plan.runId}.txt`)), false);

  await cleanupWorktree(workspace.workspace);
});

test("run-retry with fail-times 1 retries once then reaches DONE", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const retried = await runJson(["run-retry", plan.runId, "--fail-times", "1"], paths);

  assert.equal(retried.ok, true);
  assert.equal(retried.state, "DONE");
  assert.deepEqual(
    retried.steps.map((step) => [step.role, step.attempt, step.verdict ?? null]),
    [
      ["generator", 1, null],
      ["evaluator", 1, "FAIL"],
      ["generator", 2, null],
      ["evaluator", 2, "PASS"]
    ]
  );

  const events = await runJson(["events", plan.runId], paths);
  assert.deepEqual(
    events.events.filter((event) => event.event_type === "CODE_PRODUCED").map((event) => event.payload.attempt),
    [1, 2]
  );
  assert.deepEqual(
    events.events.filter((event) => event.event_type === "EVAL_COMPLETE").map((event) => [event.payload.attempt, event.payload.verdict]),
    [
      [1, "FAIL"],
      [2, "PASS"]
    ]
  );
  assert.notEqual(attemptReport(paths, plan.runId, 1, "generator"), attemptReport(paths, plan.runId, 2, "generator"));
  assert.equal(await exists(attemptReport(paths, plan.runId, 1, "generator")), true);
  assert.equal(await exists(attemptReport(paths, plan.runId, 2, "generator")), true);
  assert.equal((await runJson(["status", plan.runId], paths)).state, "DONE");

  await cleanupWorktree(workspace.workspace);
});

test("run-retry exhausts retry budget and reaches HUMAN", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const retried = await runJson(["run-retry", plan.runId, "--fail-times", "99"], paths);

  assert.equal(retried.ok, true);
  assert.equal(retried.state, "HUMAN");
  assert.equal(retried.context.retriesLeft, 0);
  assert.deepEqual(
    retried.steps.filter((step) => step.role === "evaluator").map((step) => [step.attempt, step.verdict]),
    [
      [1, "FAIL"],
      [2, "FAIL"],
      [3, "FAIL"],
      [4, "FAIL"]
    ]
  );

  const status = await runJson(["status", plan.runId], paths);
  assert.equal(status.state, "HUMAN");
  assert.equal(status.context.retriesLeft, 0);
  for (const attempt of [1, 2, 3, 4]) {
    assert.equal(await exists(attemptReport(paths, plan.runId, attempt, "generator")), true);
    assert.equal(await exists(attemptReport(paths, plan.runId, attempt, "evaluator")), true);
  }

  await cleanupWorktree(workspace.workspace);
});

test("run-retry guards invalid state, fail-times, and missing workspace", async () => {
  const paths = await tempPaths();
  const plan = await runJson(["plan", "Retry guard path"], paths);
  const human = await runJson(["run-retry", plan.runId], paths);
  assert.equal(human.ok, false);
  assert.equal(human.error, "run_retry_requires_build_or_check_state");

  await runJson(["approve", plan.runId], paths);
  const invalidFailTimes = await runJson(["run-retry", plan.runId, "--fail-times", "maybe"], paths);
  assert.equal(invalidFailTimes.ok, false);
  assert.equal(invalidFailTimes.error.code, "INVALID_FAIL_TIMES");

  const missingWorkspace = await runJson(["run-retry", plan.runId, "--fail-times", "0"], paths);
  assert.equal(missingWorkspace.ok, false);
  assert.equal(missingWorkspace.error, "workspace_required");
});

test("run-retry can resume from CHECK state produced by single-step generate", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runJson(["generate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(generated.state, "CHECK");

  const beforeFiles = await worktreeFiles(workspace.workspace.worktreePath);
  const retried = await runJson(["run-retry", plan.runId, "--fail-times", "0"], paths);
  assert.equal(retried.state, "DONE");
  assert.deepEqual(
    retried.steps.map((step) => [step.role, step.attempt]),
    [["evaluator", 1]]
  );
  const evaluatorReport = JSON.parse(await readFile(attemptReport(paths, plan.runId, 1, "evaluator"), "utf8"));
  assert.equal(evaluatorReport.generatorReportPath, generated.reportPath);
  assert.deepEqual(await worktreeFiles(workspace.workspace.worktreePath), beforeFiles);

  await cleanupWorktree(workspace.workspace);
});
