import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";
import { createFileRunStore, createTask, writeRawContract, updateTask, taskStatusFromState } from "../dist/index.js";

async function tempDir(prefix = "anchor-human-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths = {}) {
  const result = await runCli(args, paths);
  assert.equal(result.exitCode, 0);
  return JSON.parse(result.output);
}

// Helper: set up a task in HUMAN state (standard mode plan)
async function setupHumanState(storePath, tasksDir) {
  const taskResult = await createTask({ title: "Human interaction test" }, tasksDir);
  if (!taskResult.ok) throw new Error("Failed to create task: " + JSON.stringify(taskResult));
  const taskId = taskResult.task.id;

  const contract = await writeRawContract(tasksDir, taskId, [
    "mode: standard",
    "reasoning: Test standard mode",
    "affected_scope:",
    "  - src/",
    "contract:",
    "  id: \"contract-human-test\"",
    "  summary: \"Test human commands\"",
    "allowlist:",
    "  - src/**",
    "  - tests/**",
    "denylist:",
    "  - secrets/**",
    "steps:",
    "  - step: 1",
    "    description: Test step",
    "    acceptance:",
    "      - All tests pass",
    "completion_gate:",
    "  - Tests pass",
    "constraints:",
    "  - No breaking changes"
  ].join("\n"));

  const store = createFileRunStore(storePath);

  // Event 1: TASK_RECEIVED
  await store.appendEvent(taskId, { type: "TASK_RECEIVED", task: "Human interaction test" }, "system");

  // Event 2: CONTRACT_PRODUCED (standard mode → HUMAN)
  await store.appendEvent(taskId, {
    type: "CONTRACT_PRODUCED",
    mode: "standard",
    reasoning: "Test standard mode routing",
    affected_scope: ["src/"],
    contract_id: contract.contractId
  }, "planner");

  return { taskId, store, storePath, tasksDir };
}

// ── abort ──

test("abort from HUMAN state moves to ABORT", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);

  const result = await runJson(
    ["abort", taskId],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.command, "abort");
  assert.equal(result.state, "ABORT");
  assert.equal(result.event.event_type, "HUMAN_ABORT");
  assert.equal(result.event.emitted_by, "human");
  assert.equal(result.event.state_before, "HUMAN");
  assert.equal(result.event.state_after, "ABORT");
});

test("abort from any active state works", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  // Test abort from PLAN state
  const taskResult1 = await createTask({ title: "Abort from PLAN test" }, tasksDir);
  if (!taskResult1.ok) throw new Error("Failed to create task");
  const taskId1 = taskResult1.task.id;
  const store1 = createFileRunStore(storePath);
  await store1.appendEvent(taskId1, { type: "TASK_RECEIVED", task: "Abort from PLAN test" }, "system");

  const result1 = await runJson(
    ["abort", taskId1],
    { storePath, tasksDir }
  );
  assert.equal(result1.ok, true);
  assert.equal(result1.state, "ABORT");
  assert.equal(result1.event.state_before, "PLAN");
});

test("abort requires task to be started", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const result = await runJson(
    ["abort", "TASK-999"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "task_not_started");
});

test("abort is rejected when task is already in terminal state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);
  // First abort
  await runJson(["abort", taskId], { storePath, tasksDir });
  // Now in ABORT (terminal) — second abort should fail
  const result = await runJson(
    ["abort", taskId],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "abort_requires_active_state");
  assert.equal(result.state, "ABORT");
});

test("abort updates task status to aborted", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);

  await runJson(["abort", taskId], { storePath, tasksDir });

  const show = await runJson(
    ["task", "show", taskId],
    { storePath, tasksDir }
  );
  assert.equal(show.task.status, "aborted");
  assert.equal(show.stateMachine.state, "ABORT");
});

// ── force-pass ──

test("force-pass from HUMAN state moves to DONE", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);

  const result = await runJson(
    ["force-pass", taskId],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.command, "force-pass");
  assert.equal(result.state, "DONE");
  assert.equal(result.event.event_type, "HUMAN_FORCE_PASS");
  assert.equal(result.event.emitted_by, "human");
  assert.equal(result.event.state_before, "HUMAN");
  assert.equal(result.event.state_after, "DONE");
});

test("force-pass requires HUMAN state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  // Create a task in PLAN state
  const taskResult = await createTask({ title: "Force-pass guard test" }, tasksDir);
  if (!taskResult.ok) throw new Error("Failed to create task");
  const taskId = taskResult.task.id;
  const store = createFileRunStore(storePath);
  await store.appendEvent(taskId, { type: "TASK_RECEIVED", task: "Force-pass guard test" }, "system");
  // Quick mode → BUILD (skip to BUILD to test guard)
  await store.appendEvent(taskId, {
    type: "CONTRACT_PRODUCED",
    mode: "quick",
    reasoning: "Quick mode skip",
    affected_scope: ["src/"]
  }, "planner");
  // Now in BUILD state

  const result = await runJson(
    ["force-pass", taskId],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "force_pass_requires_human_state");
  assert.equal(result.state, "BUILD");
});

test("force-pass requires task to be started", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const result = await runJson(
    ["force-pass", "TASK-999"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "task_not_started");
});

test("force-pass updates task status to done", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);

  await runJson(["force-pass", taskId], { storePath, tasksDir });

  const show = await runJson(
    ["task", "show", taskId],
    { storePath, tasksDir }
  );
  assert.equal(show.task.status, "done");
  assert.equal(show.stateMachine.state, "DONE");
});

// ── amend-plan ──

test("amend-plan from HUMAN state returns to PLAN", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);

  const result = await runJson(
    ["amend-plan", taskId, "--reason", "Need more detail on auth flow"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.command, "amend-plan");
  assert.equal(result.state, "PLAN");
  assert.equal(result.event.event_type, "HUMAN_AMEND_PLAN");
  assert.equal(result.event.emitted_by, "human");
  assert.equal(result.event.state_before, "HUMAN");
  assert.equal(result.event.state_after, "PLAN");
  assert.equal(result.event.payload.reason, "Need more detail on auth flow");
});

test("amend-plan requires HUMAN state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  // Create a task in BUILD state (quick mode)
  const taskResult = await createTask({ title: "Amend-plan guard test" }, tasksDir);
  if (!taskResult.ok) throw new Error("Failed to create task");
  const taskId = taskResult.task.id;
  const store = createFileRunStore(storePath);
  await store.appendEvent(taskId, { type: "TASK_RECEIVED", task: "Amend-plan guard test" }, "system");
  await store.appendEvent(taskId, {
    type: "CONTRACT_PRODUCED",
    mode: "quick",
    reasoning: "Quick mode",
    affected_scope: ["src/"]
  }, "planner");
  // Now in BUILD state

  const result = await runJson(
    ["amend-plan", taskId, "--reason", "change scope"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "amend_plan_requires_human_state");
  assert.equal(result.state, "BUILD");
});

test("amend-plan requires task to be started", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const result = await runJson(
    ["amend-plan", "TASK-999", "--reason", "change"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "task_not_started");
});

test("amend-plan updates task status", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);

  await runJson(["amend-plan", taskId, "--reason", "Revise contract"], { storePath, tasksDir });

  const show = await runJson(
    ["task", "show", taskId],
    { storePath, tasksDir }
  );
  assert.equal(show.task.status, "in_progress");
  assert.equal(show.stateMachine.state, "PLAN");
});

test("amend-plan with default reason when --reason not provided", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupHumanState(storePath, tasksDir);

  const result = await runJson(
    ["amend-plan", taskId],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.state, "PLAN");
  assert.equal(result.event.payload.reason, "Human amended plan");
});

// ── Combined workflow ──

test("full human interaction workflow: review → amend-plan → re-plan → approve", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  // Start in standard mode (goes to HUMAN)
  const { taskId } = await setupHumanState(storePath, tasksDir);

  // Amend the plan
  const amendResult = await runJson(
    ["amend-plan", taskId, "--reason", "Needs more acceptance criteria"],
    { storePath, tasksDir }
  );
  assert.equal(amendResult.state, "PLAN");

  // Re-plan (produce new contract) to go back to HUMAN
  const store = createFileRunStore(storePath);
  await store.appendEvent(taskId, {
    type: "CONTRACT_PRODUCED",
    mode: "standard",
    reasoning: "Revised contract with more criteria",
    affected_scope: ["src/", "tests/"]
  }, "planner");

  // Now in HUMAN — approve it
  const approveResult = await runJson(
    ["approve", taskId],
    { storePath, tasksDir }
  );
  assert.equal(approveResult.ok, true);
  assert.equal(approveResult.state, "BUILD");
});
