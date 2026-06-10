import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runCli } from "../dist/cli/index.js";

const execFileAsync = promisify(execFile);

async function tempPaths() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-workspace-"));
  return {
    storePath: path.join(dir, "runs.jsonl"),
    runsDir: path.join(dir, "runs"),
    worktreesDir: path.join(dir, "worktrees")
  };
}

async function runJson(args, paths) {
  const result = await runCli(args, paths);
  assert.equal(result.exitCode, 0);
  return JSON.parse(result.output);
}

async function approvedRun(paths) {
  const plan = await runJson(["plan", "Add hello function"], paths);
  const approve = await runJson(["approve", plan.runId], paths);
  assert.equal(approve.state, "BUILD");
  return plan;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function deleteBranch(branch) {
  try {
    await execFileAsync("git", ["branch", "-D", branch], { encoding: "utf8" });
  } catch {
    // Best-effort cleanup for test-created branches.
  }
}

test("workspace create requires an approved BUILD run and does not create directories before approval", async () => {
  const paths = await tempPaths();
  const plan = await runJson(["plan", "Unapproved workspace"], paths);
  const result = await runJson(["workspace", "create", plan.runId], paths);

  assert.equal(result.ok, false);
  assert.equal(result.error, "workspace_requires_approved_build_state");
  assert.equal(result.state, "HUMAN");
  assert.equal(await exists(paths.worktreesDir), false);
});

test("workspace create is idempotent and records metadata plus WORKSPACE_CREATED event", async () => {
  const paths = await tempPaths();
  const plan = await approvedRun(paths);
  const created = await runJson(["workspace", "create", plan.runId], paths);

  assert.equal(created.ok, true);
  assert.equal(created.command, "workspace create");
  assert.equal(created.created, true);
  assert.equal(created.state, "BUILD");
  assert.equal(created.workspace.runId, plan.runId);
  assert.equal(created.workspace.contractSha, plan.contractSha);
  assert.match(created.workspace.baseCommit, /^[0-9a-f]{40}$/);
  assert.equal(created.workspace.branch, `anchor/${plan.runId}`);
  assert.equal(created.workspace.worktreePath, path.join(paths.worktreesDir, plan.runId));
  assert.equal(created.status.pathExists, true);
  assert.equal(created.status.isGitWorktree, true);
  assert.equal(created.status.clean, true);
  assert.deepEqual(created.status.changedFiles, []);
  assert.equal(created.event.event_type, "WORKSPACE_CREATED");
  assert.equal(created.event.emitted_by, "system");
  assert.equal(created.event.payload.contract_sha, plan.contractSha);

  const duplicate = await runJson(["workspace", "create", plan.runId], paths);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.workspace.worktreePath, created.workspace.worktreePath);

  const events = await runJson(["events", plan.runId], paths);
  assert.equal(events.events.filter((event) => event.event_type === "WORKSPACE_CREATED").length, 1);

  await runJson(["workspace", "cleanup", plan.runId], paths);
  await deleteBranch(created.workspace.branch);
});

test("workspace status reports clean, dirty, and cleaned states", async () => {
  const paths = await tempPaths();
  const plan = await approvedRun(paths);
  const created = await runJson(["workspace", "create", plan.runId], paths);

  const clean = await runJson(["workspace", "status", plan.runId], paths);
  assert.equal(clean.ok, true);
  assert.equal(clean.status.clean, true);

  await writeFile(path.join(created.workspace.worktreePath, "r6-dirty.txt"), "dirty\n");
  const dirty = await runJson(["workspace", "status", plan.runId], paths);
  assert.equal(dirty.status.clean, false);
  assert.deepEqual(dirty.status.changedFiles, ["r6-dirty.txt"]);

  const cleanup = await runJson(["workspace", "cleanup", plan.runId], paths);
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.cleaned, true);
  assert.equal(cleanup.status.pathExists, false);
  assert.equal(cleanup.event.event_type, "WORKSPACE_CLEANED");
  assert.equal(cleanup.event.emitted_by, "system");

  const afterCleanup = await runJson(["workspace", "status", plan.runId], paths);
  assert.equal(afterCleanup.ok, true);
  assert.equal(afterCleanup.workspace.cleanedAt, cleanup.workspace.cleanedAt);
  assert.equal(afterCleanup.status.pathExists, false);
  assert.equal(await exists(created.workspace.worktreePath), false);

  const list = await execFileAsync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.equal(list.stdout.includes(created.workspace.worktreePath), false);

  await deleteBranch(created.workspace.branch);
});
