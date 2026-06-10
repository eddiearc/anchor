import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";

async function tempDir(prefix = "anchor-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths = {}) {
  const result = await runCli(args, paths);
  assert.equal(result.exitCode, 0, `CLI exited non-zero: ${result.output}`);
  return JSON.parse(result.output);
}

// ── Help and version ──

test("Anchor CLI still prints help and version", async () => {
  let helpResult = await runCli(["--help"], {});
  assert.equal(helpResult.exitCode, 0);
  assert.match(helpResult.output, /Anchor/);
  assert.match(helpResult.output, /Usage:/);

  let versionResult = await runCli(["--version"], {});
  assert.equal(versionResult.exitCode, 0);
  assert.equal(typeof versionResult.output, "string");
});

// ── Demo ──

test("CLI demo happy path creates a DONE task and exposes status/events", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");

  const demo = await runJson(["demo"], { storePath });
  assert.equal(demo.ok, true);
  assert.equal(demo.command, "demo");
  assert.equal(demo.fixture, "happy");
  assert.match(demo.taskId, /^demo_happy_/);
  assert.equal(demo.finalState, "DONE");

  const status = await runJson(["status", demo.taskId], { storePath });
  assert.equal(status.state, "DONE");

  const events = await runJson(["events", demo.taskId], { storePath });
  assert.equal(events.events.length, 4);
});

test("CLI demo retry fixture records CHECK FAIL -> BUILD retry -> CHECK PASS -> DONE", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");

  const demo = await runJson(["demo", "--fixture", "retry"], { storePath });
  assert.equal(demo.ok, true);
  assert.equal(demo.finalState, "DONE");

  const events = await runJson(["events", demo.taskId], { storePath });
  assert.equal(events.events.length, 6);
  const types = events.events.map((e) => e.event_type);
  assert.deepEqual(types, ["TASK_RECEIVED", "CONTRACT_PRODUCED", "CODE_PRODUCED", "EVAL_COMPLETE", "CODE_PRODUCED", "EVAL_COMPLETE"]);
  assert.equal(events.events[3].payload.verdict, "FAIL");
  assert.equal(events.events[5].payload.verdict, "PASS");
});

test("CLI status/events can read a previous task from a fresh CLI call", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");

  const demo = await runJson(["demo"], { storePath });
  const status = await runJson(["status", demo.taskId], { storePath });
  assert.equal(status.state, "DONE");

  const events = await runJson(["events", demo.taskId], { storePath });
  assert.equal(events.events.length, 4);
});
