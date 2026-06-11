import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";
import { createFileRunStore } from "../dist/index.js";

async function tempDir(prefix = "anchor-retry-") {
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

async function planApproveWorkspace(dir, tasksDir, worktreesDir) {
  const storePath = path.join(dir, "events.jsonl");
  const plan = await runJson(["plan", "Retry integration test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });
  return { taskId: plan.taskId, storePath };
}

test("run-retry with fail-times 0 reaches DONE with one generator and evaluator attempt", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const retry = await runJson(["run-retry", taskId, "--fail-times", "0"], { storePath, tasksDir, worktreesDir });

  assert.equal(retry.ok, true);
  assert.equal(retry.state, "DONE");
  assert.equal(retry.steps.length, 2);
  assert.equal(retry.steps[0].role, "generator");
  assert.equal(retry.steps[0].provider, "fixture");
  assert.equal(retry.steps[1].role, "evaluator");
  assert.equal(retry.steps[1].provider, "fixture");
  assert.equal(retry.steps[1].verdict, "PASS");
  assert.equal(retry.generatorProvider, "fixture");
  assert.equal(retry.evaluatorProvider, "fixture");
});

test("run-retry with fail-times 1 retries once then reaches DONE", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const retry = await runJson(["run-retry", taskId, "--fail-times", "1"], { storePath, tasksDir, worktreesDir });

  assert.equal(retry.ok, true);
  assert.equal(retry.state, "DONE");
  assert.equal(retry.steps.length, 4);
  assert.equal(retry.steps[0].role, "generator");
  assert.equal(retry.steps[0].provider, "fixture");
  assert.equal(retry.steps[1].role, "evaluator");
  assert.equal(retry.steps[1].provider, "fixture");
  assert.equal(retry.steps[1].verdict, "FAIL");
  assert.equal(retry.steps[2].role, "generator");
  assert.equal(retry.steps[2].provider, "fixture");
  assert.equal(retry.steps[3].role, "evaluator");
  assert.equal(retry.steps[3].provider, "fixture");
  assert.equal(retry.steps[3].verdict, "PASS");
});

test("run-retry exhausts retry budget and reaches HUMAN", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const retry = await runJson(["run-retry", taskId, "--fail-times", "4"], { storePath, tasksDir, worktreesDir });

  assert.equal(retry.ok, true);
  assert.equal(retry.state, "HUMAN");
  assert.equal(retry.steps.length, 8);
});

test("run-retry guards invalid state and missing workspace", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Guard test"], { storePath, tasksDir });
  const badState = await runJson(["run-retry", plan.taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(badState.ok, false);
});

test("run-retry can resume from CHECK state produced by single-step generate", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  await runJson(["generate", taskId], { storePath, tasksDir, worktreesDir });

  const retry = await runJson(["run-retry", taskId, "--fail-times", "0"], { storePath, tasksDir, worktreesDir });
  assert.equal(retry.ok, true);
  assert.equal(retry.state, "DONE");
});

test("run-retry can use fake codex generator provider and keeps provider metadata", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const fakeCodex = path.join(dir, "fake-codex-generator.sh");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "last=''",
    "for arg in \"$@\"; do last=\"$arg\"; done",
    "case \"$last\" in *\"Approved contract path:\"*\"Approved contract:\"*\"Report expectation:\"*) ;; *) echo missing-prompt-boundary >&2; exit 3 ;; esac",
    "if [ -n \"$ANCHOR_CODEX_COMMAND\" ] || [ -n \"$ANCHOR_CODEX_ARGV_JSON\" ]; then echo leaked-env >&2; exit 4; fi",
    "mkdir -p \"$PWD/anchor-output\"",
    `echo "fake codex retry output" > "$PWD/anchor-output/codex-retry-${taskId}.txt"`
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec"]);
  try {
    const retry = await runJson([
      "run-retry",
      taskId,
      "--generator-provider",
      "codex",
      "--evaluator-provider",
      "fixture",
      "--fail-times",
      "0"
    ], { storePath, tasksDir, worktreesDir });

    assert.equal(retry.ok, true);
    assert.equal(retry.state, "DONE");
    assert.equal(retry.generatorProvider, "codex");
    assert.equal(retry.evaluatorProvider, "fixture");
    assert.equal(retry.steps[0].role, "generator");
    assert.equal(retry.steps[0].provider, "codex");
    assert.equal(retry.steps[1].role, "evaluator");
    assert.equal(retry.steps[1].provider, "fixture");
    assert.equal(retry.steps[0].event.payload.provider, "codex");

    const report = JSON.parse(await readFile(retry.steps[0].reportPath, "utf8"));
    assert.equal(report.provider, "codex");
    assert.equal(report.adapter, "codex");
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});

test("run-retry can use fake pi evaluator provider to drive FAIL then PASS transitions", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const fakePi = path.join(dir, "fake-pi-evaluator.sh");
  const piCountFile = path.join(dir, "pi-eval-count");
  await writeFile(fakePi, [
    "#!/bin/sh",
    "last=''",
    "for arg in \"$@\"; do last=\"$arg\"; done",
    "case \"$last\" in *\"Approved contract path:\"*\"Generator report path:\"*\"Generator report:\"*\"The Generator changed these files:\"*) ;; *) echo missing-prompt-boundary >&2; exit 3 ;; esac",
    "if [ -n \"$ANCHOR_PI_COMMAND\" ] || [ -n \"$ANCHOR_PI_ARGV_JSON\" ]; then echo leaked-env >&2; exit 4; fi",
    "mkdir -p \"$PWD/.anchor/eval\"",
    `count_file="${piCountFile}"`,
    "count=0",
    "if [ -f \"$count_file\" ]; then count=$(cat \"$count_file\"); fi",
    "count=$((count + 1))",
    "echo \"$count\" > \"$count_file\"",
    "if [ \"$count\" -eq 1 ]; then",
    "  printf '%s\\n' '{\"verdict\":\"FAIL\",\"feedback\":\"fake pi requested retry\",\"testsRun\":2,\"testsFailed\":1}' > \"$PWD/.anchor/eval/verdict.json\"",
    "else",
    "  printf '%s\\n' '{\"verdict\":\"PASS\",\"feedback\":\"fake pi accepted retry\",\"testsRun\":3,\"testsFailed\":0}' > \"$PWD/.anchor/eval/verdict.json\"",
    "fi"
  ].join("\n"));
  await chmod(fakePi, 0o755);

  process.env.ANCHOR_PI_COMMAND = fakePi;
  process.env.ANCHOR_PI_ARGV_JSON = JSON.stringify(["fake-exec"]);
  try {
    const retry = await runJson([
      "run-retry",
      taskId,
      "--generator-provider",
      "fixture",
      "--evaluator-provider",
      "pi"
    ], { storePath, tasksDir, worktreesDir });

    assert.equal(retry.ok, true);
    assert.equal(retry.state, "DONE");
    assert.equal(retry.generatorProvider, "fixture");
    assert.equal(retry.evaluatorProvider, "pi");
    assert.equal(retry.steps.length, 4);
    assert.equal(retry.steps[1].role, "evaluator");
    assert.equal(retry.steps[1].provider, "pi");
    assert.equal(retry.steps[1].verdict, "FAIL");
    assert.equal(retry.steps[3].role, "evaluator");
    assert.equal(retry.steps[3].provider, "pi");
    assert.equal(retry.steps[3].verdict, "PASS");
    assert.equal(retry.steps[1].event.payload.provider, "pi");
    assert.equal(retry.steps[3].event.payload.provider, "pi");

    const report = JSON.parse(await readFile(retry.steps[3].reportPath, "utf8"));
    assert.equal(report.provider, "pi");
    assert.equal(report.adapter, "pi");
  } finally {
    delete process.env.ANCHOR_PI_COMMAND;
    delete process.env.ANCHOR_PI_ARGV_JSON;
  }
});

test("run-retry rejects unknown providers before attempts or state changes", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);
  const result = await runJsonWithExit([
    "run-retry",
    taskId,
    "--generator-provider",
    "fixture",
    "--evaluator-provider",
    "unknown-provider"
  ], { storePath, tasksDir, worktreesDir });

  assert.equal(result.exitCode, 1);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, "UNKNOWN_PROVIDER");
  assert.equal(result.json.evaluatorProvider, "unknown-provider");

  const snapshot = await createFileRunStore(storePath).getCurrentState(taskId);
  assert.equal(snapshot.state, "BUILD");
  const events = await runJson(["events", taskId], { storePath });
  assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);
  assert.equal(events.events.some((event) => event.event_type === "EVAL_COMPLETE"), false);
});
