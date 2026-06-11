import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";
import { createFileRunStore } from "../dist/index.js";

async function tempDir(prefix = "anchor-retry-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  return JSON.parse(result.output);
}

async function planApproveWorkspace(dir, tasksDir, worktreesDir) {
  const storePath = path.join(dir, "events.jsonl");
  const plan = await runJson(["plan", "Retry integration test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });
  return { taskId: plan.taskId, storePath };
}

test("run-retry with fail-times 0 reaches DONE with one generator and evaluator attempt", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const retry = await runJson(["run-retry", taskId, "--fail-times", "0"], { storePath, tasksDir, worktreesDir });

  assert.equal(retry.ok, true);
  assert.equal(retry.state, "DONE");
  assert.equal(retry.steps.length, 2);
  assert.equal(retry.steps[0].role, "generator");
  assert.equal(retry.steps[1].role, "evaluator");
  assert.equal(retry.steps[1].verdict, "PASS");
});

test("run-retry with fail-times 1 retries once then reaches DONE", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const retry = await runJson(["run-retry", taskId, "--fail-times", "1"], { storePath, tasksDir, worktreesDir });

  assert.equal(retry.ok, true);
  assert.equal(retry.state, "DONE");
  assert.equal(retry.steps.length, 4);
  assert.equal(retry.steps[0].role, "generator");
  assert.equal(retry.steps[1].role, "evaluator");
  assert.equal(retry.steps[1].verdict, "FAIL");
  assert.equal(retry.steps[2].role, "generator");
  assert.equal(retry.steps[3].role, "evaluator");
  assert.equal(retry.steps[3].verdict, "PASS");
});

test("run-retry exhausts retry budget and reaches HUMAN", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const retry = await runJson(["run-retry", taskId, "--fail-times", "4"], { storePath, tasksDir, worktreesDir });

  assert.equal(retry.ok, true);
  assert.equal(retry.state, "HUMAN");
  assert.equal(retry.steps.length, 8);
});

test("run-retry guards invalid state and missing workspace", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Guard test"], { storePath, tasksDir });
  const badState = await runJson(["run-retry", plan.taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(badState.ok, false);
});

test("run-retry can resume from CHECK state produced by single-step generate", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  await runJson(["generate", taskId], { storePath, tasksDir, worktreesDir });

  const retry = await runJson(["run-retry", taskId, "--fail-times", "0"], { storePath, tasksDir, worktreesDir });
  assert.equal(retry.ok, true);
  assert.equal(retry.state, "DONE");
});
