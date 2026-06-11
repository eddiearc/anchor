import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";
import { createFileRunStore } from "../dist/index.js";

async function tempDir(prefix = "anchor-eval-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  return JSON.parse(result.output);
}

async function runJsonWithExit(args, paths) {
  const result = await runCli(args, paths);
  return { exitCode: result.exitCode, json: JSON.parse(result.output) };
}

async function planApproveGenerate(dir, tasksDir, worktreesDir) {
  const storePath = path.join(dir, "events.jsonl");
  const plan = await runJson(["plan", "Eval integration test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });
  await runJson(["generate", plan.taskId], { storePath, tasksDir, worktreesDir });
  return { taskId: plan.taskId, storePath };
}

test("fixture evaluator PASS writes report, appends event, and advances CHECK to DONE", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);
  const evalResult = await runJson(["evaluate", taskId, "--adapter", "fixture", "--verdict", "pass"], { storePath, tasksDir, worktreesDir });

  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.state, "DONE");
  assert.equal(evalResult.verdict, "PASS");
  assert.equal(evalResult.event.event_type, "EVAL_COMPLETE");
  assert.equal(evalResult.event.emitted_by, "evaluator");

  const events = await runJson(["events", taskId], { storePath });
  assert.equal(events.events[events.events.length - 1].state_after, "DONE");

  // Task status updated to done
  const taskResult = await runJson(["task", "show", taskId], { storePath, tasksDir });
  assert.equal(taskResult.task.status, "done");
});

test("fixture evaluator FAIL returns CHECK to BUILD and consumes retry budget", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);
  const evalResult = await runJson(["evaluate", taskId, "--adapter", "fixture", "--verdict", "fail"], { storePath, tasksDir, worktreesDir });

  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.state, "BUILD");
  assert.equal(evalResult.verdict, "FAIL");

  const snapshot = await ((await import("../dist/index.js")).createFileRunStore(storePath)).getCurrentState(taskId);
  assert.equal(snapshot.state, "BUILD");
  assert.equal(snapshot.context.retriesLeft, 2);
});

test("fixture evaluator rejects invalid verdicts without report, event, or state changes", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);
  const badVerdict = await runJson(["evaluate", taskId, "--adapter", "fixture", "--verdict", "maybe"], { storePath, tasksDir, worktreesDir });
  assert.equal(badVerdict.ok, false);
  assert.match(badVerdict.error.message || badVerdict.error.code || "", /verdict/i);

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  assert.equal(snapshot.state, "CHECK");
});

test("fixture evaluator FAIL with exhausted retries moves CHECK to HUMAN", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);
  // Fail 4 times to exhaust retries (retries default = 3, needs 4th FAIL to go HUMAN)
  await runJson(["evaluate", taskId, "--adapter", "fixture", "--verdict", "fail"], { storePath, tasksDir, worktreesDir });
  await runJson(["generate", taskId], { storePath, tasksDir, worktreesDir });
  await runJson(["evaluate", taskId, "--adapter", "fixture", "--verdict", "fail"], { storePath, tasksDir, worktreesDir });
  await runJson(["generate", taskId], { storePath, tasksDir, worktreesDir });
  await runJson(["evaluate", taskId, "--adapter", "fixture", "--verdict", "fail"], { storePath, tasksDir, worktreesDir });
  await runJson(["generate", taskId], { storePath, tasksDir, worktreesDir });
  const final = await runJson(["evaluate", taskId, "--adapter", "fixture", "--verdict", "fail"], { storePath, tasksDir, worktreesDir });

  assert.equal(final.ok, true);
  assert.equal(final.state, "HUMAN");
});

test("evaluate requires CHECK state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Test"], { storePath, tasksDir });
  const result = await runJson(["evaluate", plan.taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(result.ok, false);
  assert.match(result.error, /check/);
});

test("codex evaluator runs fake script, reads verdict.json, and advances CHECK to DONE", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex.sh");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "last=''",
    "for arg in \"$@\"; do last=\"$arg\"; done",
    "case \"$last\" in *\"Approved contract path:\"*\"Generator report path:\"*\"Generator report:\"*\"The Generator changed these files:\"*) ;; *) echo missing-prompt-boundary >&2; exit 3 ;; esac",
    "if [ -n \"$ANCHOR_CODEX_COMMAND\" ] || [ -n \"$ANCHOR_CODEX_ARGV_JSON\" ] || [ -n \"$SECRET_TOKEN\" ]; then echo leaked-env >&2; exit 4; fi",
    "mkdir -p \"$PWD/.anchor/eval\" 2>/dev/null || true",
    `echo '{"verdict":"PASS","feedback":"All tests pass. Implementation matches contract.","testsRun":3,"testsFailed":0}' > "$PWD/.anchor/eval/verdict.json"`
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec", "--cd", "__worktree__"]);
  process.env.SECRET_TOKEN = "do-not-leak";
  try {
    const evalResult = await runJson(["evaluate", taskId, "--provider", "codex"], { storePath, tasksDir, worktreesDir });

    assert.equal(evalResult.ok, true);
    assert.equal(evalResult.state, "DONE");
    assert.equal(evalResult.verdict, "PASS");
    assert.equal(evalResult.testsRun, 3);
    assert.equal(evalResult.testsFailed, 0);
    assert.equal(evalResult.event.event_type, "EVAL_COMPLETE");
    assert.equal(evalResult.event.emitted_by, "evaluator");
    assert.equal(evalResult.event.payload.provider, "codex");

    const report = JSON.parse(await readFile(evalResult.reportPath, "utf8"));
    assert.equal(report.adapter, "codex");
    assert.equal(report.provider, "codex");
    assert.equal(report.taskId, taskId);
    assert.equal(report.generatorReportPath.endsWith("generator-report.json"), true);
    assert.equal(report.argv.at(-1), "[prompt redacted]");
    assert.equal(report.exitCode, 0);

    const events = await runJson(["events", taskId], { storePath });
    assert.equal(events.events[events.events.length - 1].state_after, "DONE");
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
    delete process.env.SECRET_TOKEN;
  }
});

test("codex evaluator valid FAIL verdict returns CHECK to BUILD", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex-fail.sh");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "mkdir -p \"$PWD/.anchor/eval\" 2>/dev/null || true",
    `echo '{"verdict":"FAIL","feedback":"Missing required behavior.","testsRun":2,"testsFailed":1}' > "$PWD/.anchor/eval/verdict.json"`
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec", "--cd", "__worktree__"]);
  try {
    const evalResult = await runJson(["evaluate", taskId, "--adapter", "codex"], { storePath, tasksDir, worktreesDir });

    assert.equal(evalResult.ok, true);
    assert.equal(evalResult.verdict, "FAIL");
    assert.equal(evalResult.state, "BUILD");
    assert.equal(evalResult.testsRun, 2);
    assert.equal(evalResult.testsFailed, 1);
    assert.equal(evalResult.event.payload.provider, "codex");

    const report = JSON.parse(await readFile(evalResult.reportPath, "utf8"));
    assert.equal(report.provider, "codex");
    assert.equal(report.verdict, "FAIL");
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});

test("codex evaluator invalid verdict returns JSON error without state migration or EVAL_COMPLETE", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex-invalid.sh");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "mkdir -p \"$PWD/.anchor/eval\" 2>/dev/null || true",
    "echo '{not json' > \"$PWD/.anchor/eval/verdict.json\"",
    "exit 42"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec"]);
  try {
    const result = await runJsonWithExit(["evaluate", taskId, "--provider", "codex"], { storePath, tasksDir, worktreesDir });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, "CODEX_NO_VERDICT");
    assert.equal(result.json.error.report.provider, "codex");

    const snapshot = await createFileRunStore(storePath).getCurrentState(taskId);
    assert.equal(snapshot.state, "CHECK");
    const events = await runJson(["events", taskId], { storePath });
    assert.equal(events.events.some((event) => event.event_type === "EVAL_COMPLETE"), false);
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});

test("codex evaluator command failure returns JSON error without state migration or prompt leakage", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveGenerate(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex-command-failure.sh");
  await writeFile(fakeCodex, ["#!/bin/sh", "exit 42"].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec"]);
  try {
    const result = await runJsonWithExit(["evaluate", taskId, "--provider", "codex"], { storePath, tasksDir, worktreesDir });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, "CODEX_COMMAND_FAILED");
    assert.equal(result.json.error.report.provider, "codex");
    assert.equal(result.json.error.report.exitCode, 42);
    assert.doesNotMatch(result.json.error.report.stderrSummary, /Task ID|Approved contract|Generator report/);

    const snapshot = await createFileRunStore(storePath).getCurrentState(taskId);
    assert.equal(snapshot.state, "CHECK");
    const events = await runJson(["events", taskId], { storePath });
    assert.equal(events.events.some((event) => event.event_type === "EVAL_COMPLETE"), false);
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});
