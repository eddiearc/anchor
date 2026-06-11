import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";
import { createFileRunStore } from "../dist/index.js";

async function tempDir(prefix = "anchor-gen-") {
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

async function planAndApproveAndWorkspace(dir, tasksDir, worktreesDir) {
  const storePath = path.join(dir, "events.jsonl");
  const plan = await runJson(["plan", "Generator integration test"], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  const ws = await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });
  return { taskId: plan.taskId, storePath, ws };
}

test("fixture generator runs in worktree, writes report, and advances BUILD to CHECK", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId } = await planAndApproveAndWorkspace(dir, tasksDir, worktreesDir);
  const gen = await runJson(["generate", taskId], { storePath, tasksDir, worktreesDir });

  assert.equal(gen.ok, true);
  assert.equal(gen.command, "generate");
  assert.equal(gen.state, "CHECK");
  assert.ok(gen.filesChanged.length > 0);
  assert.equal(gen.event.event_type, "CODE_PRODUCED");
  assert.equal(gen.event.emitted_by, "generator");
  assert.ok(gen.reportPath.endsWith("generator-report.json"));

  const events = await runJson(["events", taskId], { storePath });
  assert.equal(events.events[events.events.length - 1].state_after, "CHECK");
});

test("fixture generator policy violation writes report but does not advance state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId } = await planAndApproveAndWorkspace(dir, tasksDir, worktreesDir);
  const result = await runCli(["generate", taskId, "--fixture", "outside"], { storePath, tasksDir, worktreesDir });

  const gen = JSON.parse(result.output);
  assert.equal(gen.ok, false);

  const snapshot = await ((await import("../dist/index.js")).createFileRunStore(storePath)).getCurrentState(taskId);
  assert.equal(snapshot.state, "BUILD");
});

test("codex generator runs fake command in worktree, writes report, and advances BUILD to CHECK", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const { taskId } = await planAndApproveAndWorkspace(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex.sh");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "last=''",
    "for arg in \"$@\"; do last=\"$arg\"; done",
    "case \"$last\" in *\"Approved contract path:\"*\"Approved contract:\"*\"Report expectation:\"*) ;; *) echo missing-prompt-boundary >&2; exit 3 ;; esac",
    "if [ -n \"$ANCHOR_CODEX_COMMAND\" ]; then echo leaked-anchor-env >&2; exit 4; fi",
    "mkdir -p \"$PWD/anchor-output\" 2>/dev/null || true",
    `echo "fake codex output" > "$PWD/anchor-output/codex-${taskId}.txt"`,
    "printf '%s\\n' \"$last\" | grep 'Approved contract path:' > \"$PWD/anchor-output/prompt-boundary.txt\""
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec", "--cd", "__worktree__", "--sandbox", "workspace-write", "--ask-for-approval", "never"]);
  try {
    const gen = await runJson(["generate", taskId, "--provider", "codex"], { storePath, tasksDir, worktreesDir });
    assert.equal(gen.ok, true);
    assert.equal(gen.state, "CHECK");
    assert.equal(gen.event.event_type, "CODE_PRODUCED");
    assert.equal(gen.event.payload.provider, "codex");

    const report = JSON.parse(await readFile(gen.reportPath, "utf8"));
    assert.equal(report.adapter, "codex");
    assert.equal(report.provider, "codex");
    assert.equal(report.taskId, taskId);
    assert.equal(report.exitCode, 0);
    assert.ok(report.filesChanged.some((file) => file.startsWith("anchor-output/")));
    assert.equal(report.argv.at(-1), "[prompt redacted]");
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});

test("codex generator fake command failure returns JSON error and does not advance state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");
  const { taskId } = await planAndApproveAndWorkspace(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex-fail.sh");
  await writeFile(fakeCodex, ["#!/bin/sh", "echo fake codex failure >&2", "exit 42"].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec"]);
  try {
    const result = await runJsonWithExit(["generate", taskId, "--provider", "codex"], { storePath, tasksDir, worktreesDir });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, "CODEX_COMMAND_FAILED");
    assert.equal(result.json.error.report.provider, "codex");
    assert.equal(result.json.error.report.exitCode, 42);

    const snapshot = await createFileRunStore(storePath).getCurrentState(taskId);
    assert.equal(snapshot.state, "BUILD");
    const events = await runJson(["events", taskId], { storePath });
    assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});

test("codex generator fake command with no changes fails without CODE_PRODUCED", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");
  const { taskId } = await planAndApproveAndWorkspace(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex-noop.sh");
  await writeFile(fakeCodex, ["#!/bin/sh", "echo no changes"].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec"]);
  try {
    const result = await runJsonWithExit(["generate", taskId, "--adapter", "codex"], { storePath, tasksDir, worktreesDir });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, "CODEX_NO_CHANGES");
    assert.equal(result.json.error.report.provider, "codex");

    const snapshot = await createFileRunStore(storePath).getCurrentState(taskId);
    assert.equal(snapshot.state, "BUILD");
    const events = await runJson(["events", taskId], { storePath });
    assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});

test("codex generator fake command policy violation fails without CODE_PRODUCED", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");
  const { taskId } = await planAndApproveAndWorkspace(dir, tasksDir, worktreesDir);

  const fakeCodex = path.join(dir, "fake-codex-policy.sh");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "mkdir -p \"$PWD/outside-output\"",
    `echo outside > "$PWD/outside-output/codex-${taskId}.txt"`
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify(["fake-exec"]);
  try {
    const result = await runJsonWithExit(["generate", taskId, "--provider", "codex"], { storePath, tasksDir, worktreesDir });
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, "POLICY_VIOLATION");
    assert.equal(result.json.error.report.provider, "codex");
    assert.equal(result.json.error.report.policyResult.ok, false);

    const snapshot = await createFileRunStore(storePath).getCurrentState(taskId);
    assert.equal(snapshot.state, "BUILD");
    const events = await runJson(["events", taskId], { storePath });
    assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
    delete process.env.ANCHOR_CODEX_ARGV_JSON;
  }
});

test("generate requires BUILD state", async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, "events.jsonl");
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");

  const plan = await runJson(["plan", "Test"], { storePath, tasksDir });
  const result = await runJson(["generate", plan.taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(result.ok, false);
  assert.match(result.error, /build/);
});
