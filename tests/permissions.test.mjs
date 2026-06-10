import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileRunStore, validateEventSource, validateWorkspacePolicy } from "../dist/index.js";

const quickContract = {
  type: "CONTRACT_PRODUCED",
  mode: "quick",
  reasoning: "simple path",
  affected_scope: ["src/"]
};

const codeProduced = {
  type: "CODE_PRODUCED",
  report_path: "reports/generator.md",
  files_changed: ["src/index.ts"],
  attempt: 1
};

const pass = {
  type: "EVAL_COMPLETE",
  verdict: "PASS"
};

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-permissions-"));
  return createFileRunStore(path.join(dir, "events.jsonl"));
}

test("event source guard allows only the R3 permission matrix", () => {
  assert.equal(validateEventSource("system", "TASK_RECEIVED").ok, true);
  assert.equal(validateEventSource("system", "WORKSPACE_CREATED").ok, true);
  assert.equal(validateEventSource("system", "WORKSPACE_CLEANED").ok, true);
  assert.equal(validateEventSource("planner", "CONTRACT_PRODUCED").ok, true);
  assert.equal(validateEventSource("reviewer", "REVIEW_COMPLETE").ok, true);
  assert.equal(validateEventSource("generator", "CODE_PRODUCED").ok, true);
  assert.equal(validateEventSource("generator", "RUN_COMPLETE").ok, true);
  assert.equal(validateEventSource("evaluator", "EVAL_COMPLETE").ok, true);
  assert.equal(validateEventSource("human", "CONTRACT_APPROVED").ok, true);
  assert.equal(validateEventSource("human", "HUMAN_FORCE_PASS").ok, true);
  assert.equal(validateEventSource("human", "HUMAN_AMEND_PLAN").ok, true);
  assert.equal(validateEventSource("human", "HUMAN_ABORT").ok, true);
  assert.equal(validateEventSource("human", "CONTRACT_REVISED").ok, true);
});

test("event source guard denies unauthorized source/event pairs", () => {
  assert.deepEqual(validateEventSource("planner", "EVAL_COMPLETE"), {
    ok: false,
    code: "EVENT_SOURCE_DENIED",
    message: "planner is not authorized to emit EVAL_COMPLETE"
  });
  assert.equal(validateEventSource("generator", "CONTRACT_PRODUCED").ok, false);
  assert.equal(validateEventSource("planner", "WORKSPACE_CREATED").ok, false);
  assert.equal(validateEventSource("evaluator", "CODE_PRODUCED").ok, false);
  assert.equal(validateEventSource("human", "TASK_RECEIVED").ok, false);
  assert.equal(validateEventSource("unknown", "TASK_RECEIVED").code, "UNKNOWN_ROLE");
});

test("store append rejects unauthorized emittedBy before transition and does not consume seq", async () => {
  const store = await tempStore();
  await store.appendEvent("TASK-001", { type: "TASK_RECEIVED", task: "Guard test" }, "system");

  const unauthorized = await store.appendEvent("TASK-001", pass, "planner");
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, "UNAUTHORIZED_EVENT_SOURCE");

  let events = await store.listEvents("TASK-001");
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);

  const legal = await store.appendEvent("TASK-001", quickContract, "planner");
  assert.equal(legal.ok, true);
  assert.equal(legal.event.seq, 2);

  events = await store.listEvents("TASK-001");
  assert.deepEqual(
    events.map((event) => [event.seq, event.event_type, event.emitted_by]),
    [
      [1, "TASK_RECEIVED", "system"],
      [2, "CONTRACT_PRODUCED", "planner"]
    ]
  );
});

test("legal source quick path still appends and reaches DONE", async () => {
  const store = await tempStore();
  await store.appendEvent("TASK-002", { type: "TASK_RECEIVED", task: "Auth path" }, "system");

  assert.equal((await store.appendEvent("TASK-002", quickContract, "planner")).ok, true);
  assert.equal((await store.appendEvent("TASK-002", codeProduced, "generator")).ok, true);
  assert.equal((await store.appendEvent("TASK-002", pass, "evaluator")).ok, true);

  assert.equal((await store.getCurrentState("TASK-002")).state, "DONE");
});

test("workspace guard allows generator files inside allowlist and outside denylist", () => {
  assert.deepEqual(
    validateWorkspacePolicy({
      role: "generator",
      changedFiles: ["src/core/state-machine.ts", "tests/state-machine.test.mjs"],
      allowlist: ["src/**", "tests/**"],
      denylist: ["secrets/**"]
    }),
    { ok: true }
  );
});

test("workspace guard rejects generator files outside allowlist", () => {
  const result = validateWorkspacePolicy({
    role: "generator",
    changedFiles: ["README.md"],
    allowlist: ["src/**", "tests/**"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_WRITE_OUTSIDE_ALLOWLIST");
});

test("workspace guard rejects generator denylist matches before allowlist", () => {
  const result = validateWorkspacePolicy({
    role: "generator",
    changedFiles: ["src/secrets/token.ts"],
    allowlist: ["src/**"],
    denylist: ["src/secrets/**"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_WRITE_IN_DENYLIST");
});

test("workspace guard allows evaluator writes only in .anchor/eval/tests", () => {
  assert.equal(
    validateWorkspacePolicy({
      role: "evaluator",
      changedFiles: [".anchor/eval/tests/state-machine.spec.ts"]
    }).ok,
    true
  );

  const result = validateWorkspacePolicy({
    role: "evaluator",
    changedFiles: ["tests/state-machine.test.mjs"]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "EVALUATOR_WRITE_OUTSIDE_SANDBOX");
});

test("workspace guard denies planner and reviewer source/test writes", () => {
  for (const role of ["planner", "reviewer"]) {
    const result = validateWorkspacePolicy({
      role,
      changedFiles: ["src/index.ts"]
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ROLE_WRITE_DENIED");
  }
});
