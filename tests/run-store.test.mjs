import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileRunStore } from "../dist/index.js";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-store-"));
  const filePath = path.join(dir, "events.jsonl");
  return {
    filePath,
    store: createFileRunStore(filePath)
  };
}

async function appendOk(store, runId, event, emittedBy) {
  const result = await store.appendEvent(runId, event, emittedBy);
  assert.equal(result.ok, true);
  return result.event;
}

test("createRun persists initial TASK_RECEIVED event and enters PLAN", async () => {
  const { store } = await tempStore();

  const result = await store.createRun("Build Anchor", { id: "run_create" });
  assert.equal(result.ok, true);

  const snapshot = await store.getCurrentState("run_create");
  assert.equal(snapshot.state, "PLAN");

  const events = await store.listEvents("run_create");
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].event_type, "TASK_RECEIVED");
  assert.equal(events[0].state_before, null);
  assert.equal(events[0].state_after, "PLAN");
  assert.equal(events[0].emitted_by, "system");
});

test("quick happy path replays to DONE from event log", async () => {
  const { store } = await tempStore();
  await store.createRun("Quick path", { id: "run_quick" });

  await appendOk(store, "run_quick", quickContract, "planner");
  await appendOk(store, "run_quick", codeProduced, "generator");
  await appendOk(store, "run_quick", pass, "evaluator");

  const snapshot = await store.getCurrentState("run_quick");
  assert.equal(snapshot.state, "DONE");

  const events = await store.listEvents("run_quick");
  assert.deepEqual(
    events.map((event) => [event.seq, event.event_type, event.state_before, event.state_after]),
    [
      [1, "TASK_RECEIVED", null, "PLAN"],
      [2, "CONTRACT_PRODUCED", "PLAN", "BUILD"],
      [3, "CODE_PRODUCED", "BUILD", "CHECK"],
      [4, "EVAL_COMPLETE", "CHECK", "DONE"]
    ]
  );
});

test("file store reload recovers current state by replaying persisted events", async () => {
  const { filePath, store } = await tempStore();
  await store.createRun("Reload path", { id: "run_reload" });
  await appendOk(store, "run_reload", quickContract, "planner");
  await appendOk(store, "run_reload", codeProduced, "generator");
  await appendOk(store, "run_reload", pass, "evaluator");

  const reloadedStore = createFileRunStore(filePath);
  const snapshot = await reloadedStore.getCurrentState("run_reload");

  assert.equal(snapshot.state, "DONE");
  assert.equal((await reloadedStore.listEvents("run_reload")).length, 4);
});

test("illegal transition is structured error, is not persisted, and does not skip seq", async () => {
  const { filePath, store } = await tempStore();
  await store.createRun("Illegal path", { id: "run_illegal" });

  const illegal = await store.appendEvent("run_illegal", codeProduced, "generator");
  assert.equal(illegal.ok, false);
  assert.equal(illegal.code, "INVALID_TRANSITION");
  assert.equal(illegal.transition.code, "INVALID_STATE_EVENT");

  let events = await store.listEvents("run_illegal");
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);

  const next = await appendOk(store, "run_illegal", quickContract, "planner");
  assert.equal(next.seq, 2);

  events = await store.listEvents("run_illegal");
  assert.equal(events.length, 2);

  const lines = (await readFile(filePath, "utf8")).trim().split("\n");
  const persistedEvents = lines.map((line) => JSON.parse(line)).filter((record) => record.record_type === "event");
  assert.equal(persistedEvents.length, 2);
});

test("multiple runs keep events and current state isolated", async () => {
  const { store } = await tempStore();
  await store.createRun("Run A", { id: "run_a" });
  await store.createRun("Run B", { id: "run_b" });

  await appendOk(store, "run_a", quickContract, "planner");
  await appendOk(store, "run_a", codeProduced, "generator");
  await appendOk(store, "run_a", pass, "evaluator");

  const runA = await store.getCurrentState("run_a");
  const runB = await store.getCurrentState("run_b");

  assert.equal(runA.state, "DONE");
  assert.equal(runB.state, "PLAN");
  assert.equal((await store.listEvents("run_a")).length, 4);
  assert.equal((await store.listEvents("run_b")).length, 1);
  assert.deepEqual(
    (await store.listEvents("run_b")).map((event) => event.seq),
    [1]
  );
});

test("appendEvent returns RUN_NOT_FOUND for missing run", async () => {
  const { store } = await tempStore();

  const result = await store.appendEvent("missing", quickContract, "planner");

  assert.equal(result.ok, false);
  assert.equal(result.code, "RUN_NOT_FOUND");
});
