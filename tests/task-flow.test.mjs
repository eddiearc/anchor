import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTask, listTasks, readTask, updateTask, nextTaskId, serializeTask, taskStatusFromState } from "../dist/index.js";
import { runCli } from "../dist/cli/index.js";

async function tempDir(prefix = "anchor-tasks-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths = {}) {
  const result = await runCli(args, paths);
  assert.equal(result.exitCode, 0);
  return JSON.parse(result.output);
}

// ── Core task module ──

test("createTask creates YAML file with auto-incrementing TASK-XXX id", async () => {
  const dir = await tempDir();
  const result1 = await createTask({ title: "Add rate limiting" }, dir);

  assert.equal(result1.ok, true);
  assert.equal(result1.task.id, "TASK-001");
  assert.equal(result1.task.title, "Add rate limiting");
  assert.equal(result1.task.description, "");
  assert.equal(result1.task.status, "backlog");
  assert.ok(result1.path.endsWith("TASK-001.yaml"));

  const content = await readFile(result1.path, "utf8");
  assert.match(content, /^id: "TASK-001"/m);
  assert.match(content, /^title: "Add rate limiting"/m);
  assert.match(content, /^status: "backlog"/m);

  const result2 = await createTask({ title: "Migrate billing" }, dir);
  assert.equal(result2.task.id, "TASK-002");
});

test("nextTaskId handles gaps and non-matching ids", () => {
  assert.equal(nextTaskId([{ id: "TASK-001" }, { id: "TASK-003" }]), "TASK-004");
  assert.equal(nextTaskId([{ id: "something-else" }]), "TASK-001");
  assert.equal(nextTaskId([]), "TASK-001");
});

test("createTask with custom status and description", async () => {
  const dir = await tempDir();
  const result = await createTask(
    { title: "OAuth device flow", description: "Add device code flow for CLI auth", status: "in_progress" },
    dir
  );

  assert.equal(result.ok, true);
  assert.equal(result.task.status, "in_progress");
  assert.equal(result.task.description, "Add device code flow for CLI auth");
});

test("readTask returns task by id", async () => {
  const dir = await tempDir();
  await createTask({ title: "Fix login bug" }, dir);

  const result = await readTask("TASK-001", dir);
  assert.equal(result.ok, true);
  assert.equal(result.task.id, "TASK-001");
  assert.equal(result.task.title, "Fix login bug");
});

test("readTask returns TASK_NOT_FOUND for missing task", async () => {
  const dir = await tempDir();
  const result = await readTask("TASK-999", dir);
  assert.equal(result.ok, false);
  assert.equal(result.code, "TASK_NOT_FOUND");
});

test("updateTask modifies fields", async () => {
  const dir = await tempDir();
  await createTask({ title: "Original title" }, dir);

  const result = await updateTask("TASK-001", { title: "Updated title", status: "done" }, dir);
  assert.equal(result.ok, true);
  assert.equal(result.task.title, "Updated title");
  assert.equal(result.task.status, "done");

  const reread = await readTask("TASK-001", dir);
  assert.equal(reread.task.title, "Updated title");
});

test("listTasks returns all tasks sorted", async () => {
  const dir = await tempDir();
  await createTask({ title: "First" }, dir);
  await createTask({ title: "Second", status: "done" }, dir);

  const all = await listTasks(dir);
  assert.equal(all.total, 2);
  assert.equal(all.tasks[0].title, "First");
  assert.equal(all.tasks[1].title, "Second");
});

test("listTasks filters by status", async () => {
  const dir = await tempDir();
  await createTask({ title: "Backlog task" }, dir);
  await createTask({ title: "Done task", status: "done" }, dir);

  const backlog = await listTasks(dir, "backlog");
  assert.equal(backlog.total, 1);

  const done = await listTasks(dir, "done");
  assert.equal(done.total, 1);
});

test("listTasks returns empty when dir does not exist", async () => {
  const result = await listTasks(path.join(os.tmpdir(), "nonexistent-tasks"));
  assert.equal(result.total, 0);
});

test("serializeTask creates valid YAML-like format", () => {
  const task = {
    id: "TASK-001",
    title: "Fix bug",
    description: "Fix login redirect",
    status: "backlog",
    created_at: "2026-06-10T00:00:00Z",
    updated_at: "2026-06-10T00:00:00Z"
  };

  const yaml = serializeTask(task);
  assert.match(yaml, /^id: "TASK-001"/m);
  assert.match(yaml, /^status: "backlog"/m);
});

test("taskStatusFromState maps state machine states to task statuses", () => {
  assert.equal(taskStatusFromState(null), "backlog");
  assert.equal(taskStatusFromState("PLAN"), "in_progress");
  assert.equal(taskStatusFromState("BUILD"), "in_progress");
  assert.equal(taskStatusFromState("CHECK"), "in_progress");
  assert.equal(taskStatusFromState("DONE"), "done");
  assert.equal(taskStatusFromState("ABORT"), "aborted");
});

// ── CLI task commands ──

test("anchor task create via CLI", async () => {
  const dir = await tempDir();
  const result = await runJson(["task", "create", "Add login audit logging"], { tasksDir: dir });

  assert.equal(result.ok, true);
  assert.equal(result.command, "task create");
  assert.equal(result.taskId, "TASK-001");
  assert.equal(result.task.title, "Add login audit logging");
  assert.equal(result.task.status, "backlog");
});

test("anchor task list and show", async () => {
  const dir = await tempDir();
  await runJson(["task", "create", "Task A"], { tasksDir: dir });
  await runJson(["task", "create", "Task B", "--status", "done"], { tasksDir: dir });

  const all = await runJson(["task", "list"], { tasksDir: dir });
  assert.equal(all.total, 2);

  const show = await runJson(["task", "show", "TASK-001"], { tasksDir: dir });
  assert.equal(show.task.id, "TASK-001");
  assert.equal(show.stateMachine, null);
});

test("anchor plan creates task and shows it in task list with state machine info", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const plan = await runJson(["plan", "Plan creates task test"], { storePath, tasksDir });
  assert.ok(plan.taskId);

  const show = await runJson(["task", "show", plan.taskId], { storePath, tasksDir });
  assert.equal(show.task.status, "in_progress");
  assert.ok(show.stateMachine);
  assert.equal(show.stateMachine.state, "HUMAN");
});

test("unknown task subcommand returns error", async () => {
  const dir = await tempDir();
  const result = await runJson(["task", "delete", "TASK-001"], { tasksDir: dir });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_task_subcommand");
});
