import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";

async function tempDir(prefix = "anchor-reviewer-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths = {}) {
  const result = await runCli(args, paths);
  return JSON.parse(result.output);
}

// Helper: create a task and plan with thorough mode to reach REVIEW state.
// We use the planner's fixture adapter which always produces "standard" mode.
// To reach REVIEW we need "thorough" mode, so we'll use demo-like event injection.
// But for real CLI testing, we can use the demo + manual plan approach, or we
// write events directly via run-store. Here we test the reviewer CLI by injecting
// events to set up the REVIEW state.

import { createFileRunStore, createTask, writeRawContract, readContractArtifact, updateTask, taskStatusFromState } from "../dist/index.js";

async function setupReviewState(storePath, tasksDir) {
  // Create a task and manually inject events to reach REVIEW state (thorough mode)
  const taskResult = await createTask({ title: "Thorough mode review test" }, tasksDir);
  if (!taskResult.ok) throw new Error("Failed to create task: " + JSON.stringify(taskResult));
  const taskId = taskResult.task.id;

  // Write a contract artifact
  const contract = await writeRawContract(tasksDir, taskId, [
    "mode: thorough",
    "reasoning: Test thorough mode",
    "affected_scope:",
    "  - src/",
    "contract:",
    "  id: \"contract-test\"",
    "  summary: \"Test thorough review\"",
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
  await store.appendEvent(taskId, { type: "TASK_RECEIVED", task: "Thorough mode review test" }, "system");

  // Event 2: CONTRACT_PRODUCED (thorough mode → REVIEW)
  await store.appendEvent(taskId, {
    type: "CONTRACT_PRODUCED",
    mode: "thorough",
    reasoning: "Test thorough mode routing",
    affected_scope: ["src/"],
    contract_id: contract.contractId
  }, "planner");

  return { taskId, store, storePath, tasksDir };
}

test("fixture reviewer READY moves REVIEW to HUMAN", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  const result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "ready"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.command, "review");
  assert.equal(result.verdict, "READY");
  assert.equal(result.state, "HUMAN");
  assert.ok(result.reportPath);
  assert.equal(result.event.event_type, "REVIEW_COMPLETE");
  assert.equal(result.event.emitted_by, "reviewer");
  assert.equal(result.event.payload.verdict, "READY");
});

test("fixture reviewer defaults to READY when no verdict specified", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  const result = await runJson(
    ["review", taskId],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.verdict, "READY");
  assert.equal(result.state, "HUMAN");
});

test("fixture reviewer NEEDS_REVISION returns to PLAN and consumes review retry", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  const result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "needs_revision"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.command, "review");
  assert.equal(result.verdict, "NEEDS_REVISION");
  assert.equal(result.state, "PLAN");
  assert.equal(result.event.event_type, "REVIEW_COMPLETE");
  assert.equal(result.event.payload.verdict, "NEEDS_REVISION");
});

test("review requires REVIEW state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  // Create a task in PLAN state (not REVIEW)
  const { taskId } = await setupReviewState(storePath, tasksDir);
  // Move it past REVIEW to HUMAN by sending REVIEW_COMPLETE READY
  const store = createFileRunStore(storePath);
  await store.appendEvent(taskId, { type: "REVIEW_COMPLETE", verdict: "READY" }, "reviewer");
  // Now it's in HUMAN, not REVIEW

  const result = await runJson(
    ["review", taskId, "--adapter", "fixture"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "review_requires_review_state");
  assert.equal(result.state, "HUMAN");
});

test("review requires task to be started", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const result = await runJson(
    ["review", "TASK-999"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "task_not_started");
});

test("fixture reviewer rejects invalid verdict", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  const result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "blocked"],
    { storePath, tasksDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_VERDICT");
});

test("fixture reviewer NEEDS_REVISION escalates to HUMAN when retries exhausted", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  // First NEEDS_REVISION consumes one retry (2 → 1) and goes to PLAN
  let result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "needs_revision"],
    { storePath, tasksDir }
  );
  assert.equal(result.state, "PLAN");

  // Need to produce a new contract to get back to REVIEW
  const store = createFileRunStore(storePath);
  await store.appendEvent(taskId, {
    type: "CONTRACT_PRODUCED",
    mode: "thorough",
    reasoning: "Revised contract",
    affected_scope: ["src/"]
  }, "planner");

  // Second NEEDS_REVISION consumes second retry (1 → 0) → PLAN
  result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "needs_revision"],
    { storePath, tasksDir }
  );
  assert.equal(result.state, "PLAN");

  // Produce a contract again to return to REVIEW with 0 retries
  await store.appendEvent(taskId, {
    type: "CONTRACT_PRODUCED",
    mode: "thorough",
    reasoning: "Third revision",
    affected_scope: ["src/"]
  }, "planner");

  // Third NEEDS_REVISION with 0 retries left → HUMAN
  result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "needs_revision"],
    { storePath, tasksDir }
  );
  assert.equal(result.state, "HUMAN");
});

test("fixture reviewer writes reporter report file", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  const result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "ready"],
    { storePath, tasksDir }
  );

  assert.ok(result.reportPath);
  // Verify report file exists and has expected content
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(result.reportPath, "utf8");
  const report = JSON.parse(content);
  assert.equal(report.adapter, "fixture");
  assert.equal(report.verdict, "READY");
  assert.equal(report.taskId, taskId);
});

test("review updates task status after transition", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  const result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "ready"],
    { storePath, tasksDir }
  );

  const show = await runJson(
    ["task", "show", taskId],
    { storePath, tasksDir }
  );
  assert.equal(show.task.status, "in_progress");
  assert.equal(show.stateMachine.state, "HUMAN");
});

test("fixture reviewer with NEEDS_REVISION verdict updates task status", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const { taskId } = await setupReviewState(storePath, tasksDir);

  const result = await runJson(
    ["review", taskId, "--adapter", "fixture", "--verdict", "needs_revision"],
    { storePath, tasksDir }
  );

  const show = await runJson(
    ["task", "show", taskId],
    { storePath, tasksDir }
  );
  assert.equal(show.task.status, "in_progress");
  assert.equal(show.stateMachine.state, "PLAN");
});
