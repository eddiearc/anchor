import test from "node:test";
import assert from "node:assert/strict";

import { getAnchorHelp } from "../dist/index.js";
import { runCli } from "../dist/cli/index.js";
import { transition } from "../dist/core/state-machine.js";

const context = () => ({
  retriesLeft: 3,
  reviewRetriesLeft: 2
});

const taskReceived = {
  type: "TASK_RECEIVED",
  task: "Build a harness"
};

const contractProduced = (mode) => ({
  type: "CONTRACT_PRODUCED",
  mode,
  reasoning: `${mode} route`,
  affected_scope: ["src/"]
});

const reviewComplete = (verdict) => ({
  type: "REVIEW_COMPLETE",
  verdict
});

const evalComplete = (verdict) => ({
  type: "EVAL_COMPLETE",
  verdict
});

const codeProduced = {
  type: "CODE_PRODUCED",
  report_path: "reports/generator.md",
  files_changed: ["src/index.ts"],
  attempt: 1
};

test("Anchor CLI still prints help and version", async () => {
  assert.match((await runCli(["--help"])).output, /Usage:/);
  assert.match(getAnchorHelp(), /permission guards/);
  assert.equal((await runCli(["--version"])).output, "0.0.0");
});

test("TASK_RECEIVED starts the task in PLAN", () => {
  assert.deepEqual(transition(null, taskReceived, context()), {
    ok: true,
    state: "PLAN",
    context: context()
  });
});

test("CONTRACT_PRODUCED routes quick, standard, and thorough modes", () => {
  assert.equal(transition("PLAN", contractProduced("quick"), context()).state, "BUILD");
  assert.equal(transition("PLAN", contractProduced("standard"), context()).state, "HUMAN");
  assert.equal(transition("PLAN", contractProduced("thorough"), context()).state, "REVIEW");
});

test("REVIEW_COMPLETE READY moves to HUMAN", () => {
  assert.equal(transition("REVIEW", reviewComplete("READY"), context()).state, "HUMAN");
});

test("REVIEW_COMPLETE NEEDS_REVISION consumes retry budget and returns to PLAN", () => {
  const result = transition("REVIEW", reviewComplete("NEEDS_REVISION"), context());

  assert.equal(result.ok, true);
  assert.equal(result.state, "PLAN");
  assert.equal(result.context.reviewRetriesLeft, 1);
});

test("REVIEW_COMPLETE NEEDS_REVISION escalates to HUMAN when retry budget is exhausted", () => {
  const result = transition("REVIEW", reviewComplete("NEEDS_REVISION"), {
    retriesLeft: 3,
    reviewRetriesLeft: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, "HUMAN");
  assert.equal(result.context.reviewRetriesLeft, 0);
});

test("HUMAN contract approval, force pass, and amend plan transitions", () => {
  assert.equal(
    transition("HUMAN", { type: "CONTRACT_APPROVED", contract_id: "contract-1" }, context()).state,
    "BUILD"
  );
  assert.equal(transition("HUMAN", { type: "HUMAN_FORCE_PASS", reason: "manual override" }, context()).state, "DONE");
  assert.equal(transition("HUMAN", { type: "HUMAN_AMEND_PLAN", reason: "scope changed" }, context()).state, "PLAN");
});

test("CODE_PRODUCED moves BUILD to CHECK", () => {
  assert.equal(transition("BUILD", codeProduced, context()).state, "CHECK");
});

test("workspace audit events keep active states unchanged", () => {
  for (const state of ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"]) {
    assert.equal(
      transition(
        state,
        {
          type: "WORKSPACE_CREATED",
          base_commit: "a".repeat(40),
          branch: "anchor/run_1",
          worktree_path: ".anchor/worktrees/run_1",
          contract_sha: "b".repeat(64)
        },
        context()
      ).state,
      state
    );
    assert.equal(
      transition(
        state,
        {
          type: "WORKSPACE_CLEANED",
          worktree_path: ".anchor/worktrees/run_1"
        },
        context()
      ).state,
      state
    );
  }
});

test("EVAL_COMPLETE PASS moves CHECK to DONE", () => {
  assert.equal(transition("CHECK", evalComplete("PASS"), context()).state, "DONE");
});

test("EVAL_COMPLETE FAIL consumes retry budget and returns to BUILD", () => {
  const result = transition("CHECK", evalComplete("FAIL"), context());

  assert.equal(result.ok, true);
  assert.equal(result.state, "BUILD");
  assert.equal(result.context.retriesLeft, 2);
});

test("EVAL_COMPLETE FAIL escalates to HUMAN when retry budget is exhausted", () => {
  const result = transition("CHECK", evalComplete("FAIL"), {
    retriesLeft: 0,
    reviewRetriesLeft: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, "HUMAN");
  assert.equal(result.context.retriesLeft, 0);
});

test("HUMAN_ABORT moves any active state to ABORT", () => {
  for (const state of ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"]) {
    assert.equal(transition(state, { type: "HUMAN_ABORT", reason: "stop" }, context()).state, "ABORT");
  }
});

test("quick happy path reaches DONE", () => {
  let state = null;
  let runContext = context();

  for (const event of [taskReceived, contractProduced("quick"), codeProduced, evalComplete("PASS")]) {
    const result = transition(state, event, runContext);
    assert.equal(result.ok, true);
    state = result.state;
    runContext = result.context;
  }

  assert.equal(state, "DONE");
});

test("illegal: initial state rejects non TASK_RECEIVED events", () => {
  const result = transition(null, contractProduced("quick"), context());

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_INITIAL_EVENT");
});

test("illegal: terminal states reject further events", () => {
  const doneResult = transition("DONE", taskReceived, context());
  const abortResult = transition("ABORT", { type: "HUMAN_ABORT", reason: "again" }, context());

  assert.equal(doneResult.ok, false);
  assert.equal(doneResult.code, "INVALID_TERMINAL_TRANSITION");
  assert.equal(abortResult.ok, false);
  assert.equal(abortResult.code, "INVALID_TERMINAL_TRANSITION");
});

test("illegal: wrong state and event pairing returns structured error", () => {
  const result = transition("BUILD", contractProduced("quick"), context());

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_STATE_EVENT");
});

test("illegal: invalid mode returns structured error", () => {
  const result = transition("PLAN", contractProduced("turbo"), context());

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_MODE");
});

test("illegal: invalid review verdict returns structured error", () => {
  const result = transition("REVIEW", reviewComplete("BLOCKED"), context());

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_REVIEW_VERDICT");
});

test("illegal: invalid eval verdict returns structured error", () => {
  const result = transition("CHECK", evalComplete("PARTIAL"), context());

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_EVAL_VERDICT");
});

test("RUN_COMPLETE passes through any active state unchanged", () => {
  for (const state of ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"]) {
    const result = transition(state, { type: "RUN_COMPLETE", report_path: "report.md", attempt: 1 }, context());
    assert.equal(result.ok, true);
    assert.equal(result.state, state);
  }
});

test("CONTRACT_REVISED passes through any active state unchanged", () => {
  for (const state of ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"]) {
    const result = transition(state, { type: "CONTRACT_REVISED", reason: "scope changed" }, context());
    assert.equal(result.ok, true);
    assert.equal(result.state, state);
  }
});

test("MERGED passes through any active state unchanged", () => {
  for (const state of ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"]) {
    const result = transition(state, { type: "MERGED", branch: "main", commit_sha: "abc123" }, context());
    assert.equal(result.ok, true);
    assert.equal(result.state, state);
  }
});

test("info events are rejected in terminal states", () => {
  assert.equal(transition("DONE", { type: "RUN_COMPLETE", report_path: "r", attempt: 1 }, context()).ok, false);
  assert.equal(transition("ABORT", { type: "CONTRACT_REVISED", reason: "r" }, context()).ok, false);
});
