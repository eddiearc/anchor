import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";
import { createFileRunStore } from "../dist/index.js";

async function tempDir(prefix = "anchor-ws-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  return JSON.parse(result.output);
}

test("workspace create requires an approved BUILD task", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Workspace test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  const ws = await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });

  assert.equal(ws.ok, true);
  assert.equal(ws.command, "workspace create");
  assert.equal(ws.workspace.taskId, plan.taskId);
  assert.equal(ws.status.isGitWorktree, true);

  const events = await runJson(["events", plan.taskId], { storePath });
  const wsEvent = events.events.find((e) => e.event_type === "WORKSPACE_CREATED");
  assert.ok(wsEvent);
  assert.equal(wsEvent.emitted_by, "system");
});

test("workspace status reports clean state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Status test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });

  const status = await runJson(["workspace", "status", plan.taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(status.ok, true);
  assert.equal(status.status.isGitWorktree, true);
});

test("workspace cleanup after CHECK records audit event", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Cleanup test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });
  await runJson(["generate", plan.taskId], { storePath, tasksDir, worktreesDir });

  const cleanup = await runJson(["workspace", "cleanup", plan.taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.cleaned, true);
  assert.equal(cleanup.event.event_type, "WORKSPACE_CLEANED");
  assert.equal(cleanup.event.emitted_by, "system");
});

test("workspace cleanup rejected in terminal state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Terminal test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });
  await runJson(["generate", plan.taskId], { storePath, tasksDir, worktreesDir });
  await runJson(["evaluate", plan.taskId, "--adapter", "fixture", "--verdict", "pass"], { storePath, tasksDir, worktreesDir });

  const cleanup = await runJson(["workspace", "cleanup", plan.taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.error, /terminal/);
});
