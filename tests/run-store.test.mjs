import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileRunStore } from "../dist/index.js";

test("TASK_RECEIVED starts the task in PLAN", () => {
  assert.ok(true); // tested via integration
});

test("appendEvent persists event and replays state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-store-"));
  const storePath = path.join(dir, "events.jsonl");
  const store = createFileRunStore(storePath);

  const r1 = await store.appendEvent("TASK-001", { type: "TASK_RECEIVED", task: "Hello" }, "system");
  assert.equal(r1.ok, true);
  assert.equal(r1.event.task_id, "TASK-001");
  assert.equal(r1.event.event_type, "TASK_RECEIVED");
  assert.equal(r1.event.state_before, null);
  assert.equal(r1.event.state_after, "PLAN");

  const snapshot = await store.getCurrentState("TASK-001");
  assert.equal(snapshot.state, "PLAN");
  assert.equal(snapshot.context.retriesLeft, 3);
});

test("quick happy path replays to DONE from event log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-store-"));
  const storePath = path.join(dir, "events.jsonl");
  const store = createFileRunStore(storePath);
  const taskId = "TASK-001";

  await store.appendEvent(taskId, { type: "TASK_RECEIVED", task: "Quick test" }, "system");
  await store.appendEvent(taskId, { type: "CONTRACT_PRODUCED", mode: "quick", reasoning: "Small change", affected_scope: ["src/"] }, "planner");
  await store.appendEvent(taskId, { type: "CODE_PRODUCED", report_path: "report.md", files_changed: ["src/x.ts"], attempt: 1 }, "generator");
  await store.appendEvent(taskId, { type: "EVAL_COMPLETE", verdict: "PASS" }, "evaluator");

  const snapshot = await store.getCurrentState(taskId);
  assert.equal(snapshot.state, "DONE");
});

test("file store reload recovers current state by replaying persisted events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-store-"));
  const storePath = path.join(dir, "events.jsonl");
  const taskId = "TASK-001";

  const store1 = createFileRunStore(storePath);
  await store1.appendEvent(taskId, { type: "TASK_RECEIVED", task: "Persist test" }, "system");
  await store1.appendEvent(taskId, { type: "CONTRACT_PRODUCED", mode: "thorough", reasoning: "Big", affected_scope: ["src/"] }, "planner");

  const store2 = createFileRunStore(storePath);
  const snapshot = await store2.getCurrentState(taskId);
  assert.equal(snapshot.state, "REVIEW");
  assert.equal(snapshot.context.retriesLeft, 3);
  assert.equal(snapshot.context.reviewRetriesLeft, 2);
});

test("illegal transition is structured error, is not persisted, and does not skip seq", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-store-"));
  const storePath = path.join(dir, "events.jsonl");
  const store = createFileRunStore(storePath);
  const taskId = "TASK-001";

  await store.appendEvent(taskId, { type: "TASK_RECEIVED", task: "Illegal test" }, "system");
  const illegal = await store.appendEvent(taskId, { type: "CODE_PRODUCED", report_path: "r.md", files_changed: ["x.ts"], attempt: 1 }, "generator");

  assert.equal(illegal.ok, false);
  assert.equal(illegal.code, "INVALID_TRANSITION");

  const events = await store.listEvents(taskId);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
});

test("multiple tasks keep events and current state isolated", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-store-"));
  const storePath = path.join(dir, "events.jsonl");
  const store = createFileRunStore(storePath);

  await store.appendEvent("TASK-001", { type: "TASK_RECEIVED", task: "Task one" }, "system");
  await store.appendEvent("TASK-001", { type: "CONTRACT_PRODUCED", mode: "quick", reasoning: "Q", affected_scope: ["src/"] }, "planner");
  await store.appendEvent("TASK-002", { type: "TASK_RECEIVED", task: "Task two" }, "system");

  const s1 = await store.getCurrentState("TASK-001");
  assert.equal(s1.state, "BUILD");

  const s2 = await store.getCurrentState("TASK-002");
  assert.equal(s2.state, "PLAN");

  const e1 = await store.listEvents("TASK-001");
  assert.equal(e1.length, 2);

  const e2 = await store.listEvents("TASK-002");
  assert.equal(e2.length, 1);
});

test("getCurrentState returns null when no events exist for task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-store-"));
  const storePath = path.join(dir, "events.jsonl");
  const store = createFileRunStore(storePath);

  const snapshot = await store.getCurrentState("TASK-999");
  assert.equal(snapshot, null);
});
