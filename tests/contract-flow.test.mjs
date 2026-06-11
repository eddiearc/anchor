import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";

async function tempDir(prefix = "anchor-contract-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  return JSON.parse(result.output);
}

test("plan creates deterministic contract artifact and waits in HUMAN", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const plan = await runJson(["plan", "Add", "a", "hello", "function"], { storePath, tasksDir });

  assert.equal(plan.ok, true);
  assert.equal(plan.command, "plan");
  assert.equal(plan.state, "HUMAN");
  assert.equal(plan.storePath, storePath);
  assert.equal(plan.tasksDir, tasksDir);
  assert.match(plan.taskId, /^TASK-/);
  assert.match(plan.contractPath, new RegExp(`${plan.taskId}/contract\\.yaml$`));

  const content = await readFile(plan.contractPath, "utf8");
  assert.match(content, /^mode: standard/m);
  assert.match(content, /^reasoning: Deterministic fixture/m);
  assert.match(content, /^affected_scope:/m);
  assert.match(content, /^contract:/m);
  assert.match(content, /id: "TASK-/m);
  assert.match(content, /summary: "Add a hello function"/m);
  assert.match(content, /allowlist:/m);
  assert.match(content, /denylist:/m);
  assert.match(content, /steps:/m);
  assert.match(content, /acceptance:/m);
  assert.match(content, /completion_gate:/m);
  assert.match(content, /constraints:/m);

  const events = await runJson(["events", plan.taskId], { storePath });
  assert.deepEqual(
    events.events.map((event) => [event.seq, event.event_type, event.emitted_by, event.state_before, event.state_after]),
    [
      [1, "TASK_RECEIVED", "system", null, "PLAN"],
      [2, "CONTRACT_PRODUCED", "planner", "PLAN", "HUMAN"]
    ]
  );

  // Check task was created
  const taskResult = await runJson(["task", "show", plan.taskId], { storePath, tasksDir });
  assert.equal(taskResult.ok, true);
  assert.equal(taskResult.task.status, "in_progress");
  assert.ok(taskResult.stateMachine);
  assert.equal(taskResult.stateMachine.state, "HUMAN");
});

test("contract approve records approved sha and status detects dirty artifact", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const plan = await runJson(["plan", "Add login audit logging"], { storePath, tasksDir });
  const contract = await runJson(["contract", plan.taskId], { storePath, tasksDir });
  const manualSha = createHash("sha256").update(await readFile(plan.contractPath, "utf8")).digest("hex");

  assert.equal(contract.ok, true);
  assert.equal(contract.contractSha, manualSha);
  assert.equal(contract.approvedContractSha, null);
  assert.equal(contract.dirty, false);
  assert.equal(contract.contract, await readFile(plan.contractPath, "utf8"));

  const approved = await runJson(["approve", plan.taskId], { storePath, tasksDir });
  assert.equal(approved.ok, true);
  assert.equal(approved.state, "BUILD");
  assert.equal(approved.contractSha, manualSha);
  assert.equal(approved.event.event_type, "CONTRACT_APPROVED");
  assert.equal(approved.event.emitted_by, "human");
  assert.equal(approved.event.payload.contract_sha, manualSha);

  const cleanStatus = await runJson(["status", plan.taskId], { storePath, tasksDir });
  assert.equal(cleanStatus.state, "BUILD");
  assert.equal(cleanStatus.contract.approvedContractSha, manualSha);
  assert.equal(cleanStatus.contract.dirty, false);
  assert.deepEqual(cleanStatus.contract.warnings, []);

  const events = await runJson(["events", plan.taskId], { storePath });
  const approvalEvent = events.events.find((event) => event.event_type === "CONTRACT_APPROVED");
  assert.equal(approvalEvent.emitted_by, "human");
  assert.equal(approvalEvent.payload.contract_sha, manualSha);

  await appendFile(plan.contractPath, "\n# local edit after approval\n");
  const dirtyStatus = await runJson(["status", plan.taskId], { storePath, tasksDir });
  assert.equal(dirtyStatus.contract.dirty, true);
  assert.notEqual(dirtyStatus.contract.contractSha, manualSha);
  assert.deepEqual(dirtyStatus.contract.warnings, ["contract_sha_mismatch: artifact was modified after approval"]);

  const dirtyContract = await runJson(["contract", plan.taskId], { storePath, tasksDir });
  assert.equal(dirtyContract.dirty, true);
});

test("approve fails when a task has no contract artifact", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const demo = await runJson(["demo"], { storePath });
  const result = await runJson(["approve", demo.taskId], { storePath, tasksDir });

  assert.equal(result.ok, false);
  assert.equal(result.error, "contract_not_found");
});

test("plan --task uses an existing task", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const created = await runJson(["task", "create", "Pre-created task"], { tasksDir });
  assert.equal(created.ok, true);

  const plan = await runJson(["plan", "--task", created.taskId], { storePath, tasksDir });
  assert.equal(plan.ok, true);
  assert.equal(plan.taskId, created.taskId);
  assert.equal(plan.state, "HUMAN");

  const taskResult = await runJson(["task", "show", created.taskId], { storePath, tasksDir });
  assert.equal(taskResult.task.status, "in_progress");
});

test("plan --task fails for nonexistent task", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const result = await runJson(["plan", "--task", "TASK-999"], { storePath, tasksDir });
  assert.equal(result.ok, false);
  assert.equal(result.error, "task_not_found");
});

test("plan --task fails when task already started", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");

  const created = await runJson(["task", "create", "Already started"], { tasksDir });
  await runJson(["plan", "--task", created.taskId], { storePath, tasksDir });
  const second = await runJson(["plan", "--task", created.taskId], { storePath, tasksDir });

  assert.equal(second.ok, false);
  assert.equal(second.error, "task_already_started");
});
