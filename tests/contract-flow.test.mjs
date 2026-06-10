import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { createFileRunStore } from "../dist/index.js";
import { runCli } from "../dist/cli/index.js";

async function tempPaths() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-contract-"));
  return {
    storePath: path.join(dir, "runs.jsonl"),
    runsDir: path.join(dir, "runs")
  };
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  assert.equal(result.exitCode, 0);
  return JSON.parse(result.output);
}

test("plan creates deterministic contract artifact and waits in HUMAN", async () => {
  const paths = await tempPaths();
  const plan = await runJson(["plan", "Add", "a", "hello", "function"], paths);

  assert.equal(plan.ok, true);
  assert.equal(plan.command, "plan");
  assert.equal(plan.state, "HUMAN");
  assert.equal(plan.storePath, paths.storePath);
  assert.equal(plan.runsDir, paths.runsDir);
  assert.match(plan.contractPath, new RegExp(`${plan.runId}/contract\\.yaml$`));

  const content = await readFile(plan.contractPath, "utf8");
  assert.match(content, /^id: "contract_run_/m);
  assert.match(content, /^version: 1/m);
  assert.match(content, /^  summary: "Add a hello function"/m);
  assert.match(content, /^mode: "standard"/m);
  assert.match(content, /^steps:/m);
  assert.match(content, /^acceptance_criteria:/m);
  assert.match(content, /^  allowlist:/m);
  assert.match(content, /^  denylist:/m);
  assert.match(content, /^commands:/m);
  assert.match(content, /^non_goals:/m);

  const events = await runJson(["events", plan.runId], paths);
  assert.deepEqual(
    events.events.map((event) => [event.seq, event.event_type, event.emitted_by, event.state_before, event.state_after]),
    [
      [1, "TASK_RECEIVED", "system", null, "PLAN"],
      [2, "CONTRACT_PRODUCED", "planner", "PLAN", "HUMAN"]
    ]
  );
  assert.equal(events.events[1].payload.contract_id, plan.contractId);
});

test("contract approve records approved sha and status detects dirty artifact", async () => {
  const paths = await tempPaths();
  const plan = await runJson(["plan", "Add login audit logging"], paths);
  const contract = await runJson(["contract", plan.runId], paths);
  const manualSha = createHash("sha256").update(await readFile(plan.contractPath, "utf8")).digest("hex");

  assert.equal(contract.ok, true);
  assert.equal(contract.contractSha, manualSha);
  assert.equal(contract.approvedContractSha, null);
  assert.equal(contract.dirty, false);
  assert.equal(contract.contract, await readFile(plan.contractPath, "utf8"));

  const approved = await runJson(["approve", plan.runId], paths);
  assert.equal(approved.ok, true);
  assert.equal(approved.state, "BUILD");
  assert.equal(approved.contractSha, manualSha);
  assert.equal(approved.event.event_type, "CONTRACT_APPROVED");
  assert.equal(approved.event.emitted_by, "human");
  assert.equal(approved.event.payload.contract_sha, manualSha);

  const cleanStatus = await runJson(["status", plan.runId], paths);
  assert.equal(cleanStatus.state, "BUILD");
  assert.equal(cleanStatus.contract.approvedContractSha, manualSha);
  assert.equal(cleanStatus.contract.dirty, false);
  assert.deepEqual(cleanStatus.contract.warnings, []);

  const events = await runJson(["events", plan.runId], paths);
  const approvalEvent = events.events.find((event) => event.event_type === "CONTRACT_APPROVED");
  assert.equal(approvalEvent.emitted_by, "human");
  assert.equal(approvalEvent.payload.contract_sha, manualSha);

  await appendFile(plan.contractPath, "\n# local edit after approval\n");
  const dirtyStatus = await runJson(["status", plan.runId], paths);
  assert.equal(dirtyStatus.contract.dirty, true);
  assert.notEqual(dirtyStatus.contract.contractSha, manualSha);
  assert.deepEqual(dirtyStatus.contract.warnings, ["contract_sha_mismatch: artifact was modified after approval"]);

  const dirtyContract = await runJson(["contract", plan.runId], paths);
  assert.equal(dirtyContract.dirty, true);
});

test("approve fails when a run has no contract artifact", async () => {
  const paths = await tempPaths();
  const demo = await runJson(["demo"], paths);
  const result = await runJson(["approve", demo.runId], paths);

  assert.equal(result.ok, false);
  assert.equal(result.error, "contract_not_found");
});

test("store still rejects non-human contract approval through source guard", async () => {
  const paths = await tempPaths();
  const plan = await runJson(["plan", "Guard approval source"], paths);
  const store = createFileRunStore(paths.storePath);
  const unauthorized = await store.appendEvent(
    plan.runId,
    {
      type: "CONTRACT_APPROVED",
      contract_id: plan.contractId,
      contract_sha: plan.contractSha
    },
    "planner"
  );

  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, "UNAUTHORIZED_EVENT_SOURCE");
  assert.equal((await store.getCurrentState(plan.runId)).state, "HUMAN");
});
