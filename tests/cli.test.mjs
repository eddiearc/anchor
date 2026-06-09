import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";

async function tempStorePath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-cli-"));
  return path.join(dir, "runs.jsonl");
}

async function runJson(args, storePath) {
  const result = await runCli(args, { storePath });
  assert.equal(result.exitCode, 0);
  return JSON.parse(result.output);
}

test("CLI demo happy path creates a DONE run and exposes status/events", async () => {
  const storePath = await tempStorePath();
  const demo = await runJson(["demo"], storePath);

  assert.equal(demo.ok, true);
  assert.equal(demo.fixture, "happy");
  assert.equal(demo.finalState, "DONE");
  assert.equal(demo.storePath, storePath);
  assert.deepEqual(
    demo.events.map((event) => [event.seq, event.event_type, event.emitted_by, event.state_before, event.state_after]),
    [
      [1, "TASK_RECEIVED", "system", null, "PLAN"],
      [2, "CONTRACT_PRODUCED", "planner", "PLAN", "BUILD"],
      [3, "CODE_PRODUCED", "generator", "BUILD", "CHECK"],
      [4, "EVAL_COMPLETE", "evaluator", "CHECK", "DONE"]
    ]
  );

  const status = await runJson(["status", demo.runId], storePath);
  assert.equal(status.state, "DONE");

  const events = await runJson(["events", demo.runId], storePath);
  assert.deepEqual(events.events, demo.events);

  const lines = (await readFile(storePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line.record_type === "event").length, 4);
});

test("CLI demo retry fixture records CHECK FAIL -> BUILD retry -> CHECK PASS -> DONE", async () => {
  const storePath = await tempStorePath();
  const demo = await runJson(["demo", "--fixture", "retry"], storePath);

  assert.equal(demo.ok, true);
  assert.equal(demo.fixture, "retry");
  assert.equal(demo.finalState, "DONE");
  assert.deepEqual(
    demo.events.map((event) => [event.seq, event.event_type, event.emitted_by, event.state_before, event.state_after]),
    [
      [1, "TASK_RECEIVED", "system", null, "PLAN"],
      [2, "CONTRACT_PRODUCED", "planner", "PLAN", "BUILD"],
      [3, "CODE_PRODUCED", "generator", "BUILD", "CHECK"],
      [4, "EVAL_COMPLETE", "evaluator", "CHECK", "BUILD"],
      [5, "CODE_PRODUCED", "generator", "BUILD", "CHECK"],
      [6, "EVAL_COMPLETE", "evaluator", "CHECK", "DONE"]
    ]
  );
});

test("CLI status/events can read a previous run from a fresh CLI call", async () => {
  const storePath = await tempStorePath();
  const demo = await runJson(["demo"], storePath);

  const status = await runJson(["status", demo.runId], storePath);
  const events = await runJson(["events", demo.runId], storePath);

  assert.equal(status.state, "DONE");
  assert.equal(events.state, "DONE");
  assert.equal(events.events.length, 4);
});
