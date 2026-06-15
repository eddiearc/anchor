import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../dist/cli/index.js";

async function tempDir(prefix = "anchor-handoff-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runJson(args, paths, config = { provider: "fixture" }) {
  const result = await runCli(args, { config, ...paths });
  return JSON.parse(result.output);
}

async function planApproveWorkspace(dir, tasksDir, worktreesDir, task = "Handoff flow test") {
  const storePath = path.join(dir, "events.jsonl");
  const plan = await runJson(["plan", task], { storePath, tasksDir });
  await runJson(["approve", plan.taskId], { storePath, tasksDir });
  await runJson(["workspace", "create", plan.taskId], { storePath, tasksDir, worktreesDir });
  return { taskId: plan.taskId, storePath };
}

test("run-wait stops before the next agent-owned action when AGENT_STOP exists", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");
  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);

  await writeFile(path.join(tasksDir, taskId, "AGENT_STOP"), "pause before generator\n");

  const result = await runJson(["run-wait", taskId], { storePath, tasksDir, worktreesDir });
  assert.equal(result.ok, true);
  assert.equal(result.state, "BUILD");
  assert.equal(result.stoppedReason, "agent_stop");
  assert.equal(result.steps.length, 0);

  const events = await runJson(["events", taskId], { storePath });
  assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);
});

test("STEER.md is surfaced once to the next generator prompt and then consumed", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");
  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);

  await writeFile(path.join(tasksDir, taskId, "STEER.md"), "Prefer a tiny implementation and mention steer receipt.\n");

  const fakeCodex = path.join(dir, "fake-codex-steer-generator.sh");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "last=''",
    "for arg in \"$@\"; do last=\"$arg\"; done",
    "case \"$last\" in *\"Operator steer:\"*\"Prefer a tiny implementation\"*) ;; *) echo missing-steer >&2; exit 3 ;; esac",
    "mkdir -p \"$PWD/anchor-output\"",
    `echo "steer received" > "$PWD/anchor-output/steer-${taskId}.txt"`
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  process.env.ANCHOR_CODEX_COMMAND = fakeCodex;
  try {
    const result = await runJson(["run-wait", taskId], { storePath, tasksDir, worktreesDir }, {
      planner_provider: "fixture",
      reviewer_provider: "fixture",
      generator_provider: "codex",
      evaluator_provider: "fixture"
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, "DONE");

    await assert.rejects(readFile(path.join(tasksDir, taskId, "STEER.md"), "utf8"), /ENOENT/);
    const consumed = await readFile(path.join(tasksDir, taskId, "STEER.md.consumed"), "utf8");
    assert.match(consumed, /Prefer a tiny implementation/);
  } finally {
    delete process.env.ANCHOR_CODEX_COMMAND;
  }
});

test("run-retry writes PROGRESS and NEXT_FINDINGS handoff artifacts after evaluator FAIL", async () => {
  const dir = await tempDir();
  const tasksDir = path.join(dir, "tasks");
  const worktreesDir = path.join(dir, "worktrees");
  const { taskId, storePath } = await planApproveWorkspace(dir, tasksDir, worktreesDir);

  const result = await runJson(["run-retry", taskId, "--fail-times", "1"], { storePath, tasksDir, worktreesDir });
  assert.equal(result.ok, true);
  assert.equal(result.state, "DONE");

  const progress = await readFile(path.join(tasksDir, taskId, "PROGRESS.md"), "utf8");
  assert.match(progress, /state: DONE/);
  assert.match(progress, /run-retry/);

  const findings = await readFile(path.join(tasksDir, taskId, "NEXT_FINDINGS.md"), "utf8");
  assert.match(findings, /Fixture evaluator rejected/);
  assert.match(findings, /attempt: 1/);
});
