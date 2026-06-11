import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";
import { createFileRunStore, createTask, writeRawContract } from "../dist/index.js";

async function tempDir(prefix = "anchor-mode-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths = {}) {
  const result = await runCli(args, paths);
  return JSON.parse(result.output);
}

// ── plan --mode ──

test("plan --mode quick routes to BUILD", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const plan = await runJson(
    ["plan", "--mode", "quick", "Quick mode test"],
    { storePath, tasksDir }
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.state, "BUILD");
});

test("plan --mode standard routes to HUMAN", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const plan = await runJson(
    ["plan", "--mode", "standard", "Standard mode test"],
    { storePath, tasksDir }
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.state, "HUMAN");
});

test("plan --mode thorough routes to REVIEW", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const plan = await runJson(
    ["plan", "--mode", "thorough", "Thorough mode test"],
    { storePath, tasksDir }
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.state, "REVIEW");
});

test("plan defaults to standard mode when no --mode specified", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const plan = await runJson(
    ["plan", "Default mode test"],
    { storePath, tasksDir }
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.state, "HUMAN");
});

test("plan --mode with invalid value still produces valid contract (fixture ignores bad mode)", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  // parseMode returns undefined for invalid values, fixture defaults to standard
  const plan = await runJson(
    ["plan", "--mode", "invalid", "Invalid mode test"],
    { storePath, tasksDir }
  );

  assert.equal(plan.ok, true);
  // Fixture defaults to standard when mode is undefined
  assert.equal(plan.state, "HUMAN");
});

// ── RUN_COMPLETE and CONTRACT_REVISED audit events ──

test("generate command emits RUN_COMPLETE audit event after CODE_PRODUCED", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  // Standard mode: PLAN → HUMAN → (approve) → BUILD → (workspace create) → generate
  const plan = await runJson(
    ["plan", "--mode", "standard", "RUN_COMPLETE audit test"],
    { storePath, tasksDir, worktreesDir }
  );
  assert.equal(plan.state, "HUMAN");

  // Approve contract and create workspace
  await runJson(["approve", plan.taskId], { storePath, tasksDir, worktreesDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });

  const generate = await runJson(
    ["generate", plan.taskId, "--adapter", "fixture"],
    { storePath, tasksDir, worktreesDir }
  );

  assert.equal(generate.ok, true);
  assert.equal(generate.state, "CHECK");

  // Verify RUN_COMPLETE event is in the event log
  const events = await runJson(["events", plan.taskId], { storePath, tasksDir, worktreesDir });
  const eventTypes = events.events.map((e) => e.event_type);
  assert.ok(eventTypes.includes("CODE_PRODUCED"), "Should have CODE_PRODUCED");
  assert.ok(eventTypes.includes("RUN_COMPLETE"), "Should have RUN_COMPLETE");
});

test("amend-plan command emits CONTRACT_REVISED audit event", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  // Standard mode: PLAN → HUMAN
  const plan = await runJson(
    ["plan", "Audit event test"],
    { storePath, tasksDir }
  );
  assert.equal(plan.state, "HUMAN");

  // Amend plan
  const amend = await runJson(
    ["amend-plan", plan.taskId, "--reason", "Need revision"],
    { storePath, tasksDir }
  );
  assert.equal(amend.state, "PLAN");

  // Verify CONTRACT_REVISED event is in the event log
  const events = await runJson(["events", plan.taskId], { storePath, tasksDir });
  const eventTypes = events.events.map((e) => e.event_type);
  assert.ok(eventTypes.includes("HUMAN_AMEND_PLAN"), "Should have HUMAN_AMEND_PLAN");
  assert.ok(eventTypes.includes("CONTRACT_REVISED"), "Should have CONTRACT_REVISED");
});
