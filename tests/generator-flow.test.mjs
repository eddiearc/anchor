import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runCli } from "../dist/cli/index.js";

const execFileAsync = promisify(execFile);

async function tempPaths() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-generator-"));
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

async function preparedWorkspace(paths) {
  const plan = await runJson(["plan", "Generate allowed demo file"], paths);
  const approve = await runJson(["approve", plan.runId], paths);
  assert.equal(approve.state, "BUILD");
  const workspace = await runJson(["workspace", "create", plan.runId], paths);
  assert.equal(workspace.created, true);
  return { plan, workspace };
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

async function cleanupWorktree(workspace) {
  await execFileAsync("git", ["worktree", "remove", "--force", workspace.worktreePath], { encoding: "utf8" }).catch(() => {});
  await execFileAsync("git", ["branch", "-D", workspace.branch], { encoding: "utf8" }).catch(() => {});
}

test("fixture generator runs in worktree, writes report, and advances BUILD to CHECK", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runJson(["generate", plan.runId, "--adapter", "fixture"], paths);

  assert.equal(generated.ok, true);
  assert.equal(generated.command, "generate");
  assert.equal(generated.state, "CHECK");
  assert.deepEqual(generated.filesChanged, [`anchor-output/${plan.runId}.txt`]);
  assert.equal(generated.event.event_type, "CODE_PRODUCED");
  assert.equal(generated.event.emitted_by, "generator");
  assert.equal(generated.event.state_before, "BUILD");
  assert.equal(generated.event.state_after, "CHECK");
  assert.equal(generated.event.payload.report_path, generated.reportPath);
  assert.deepEqual(generated.event.payload.files_changed, generated.filesChanged);
  assert.equal(generated.event.payload.attempt, 1);

  const report = JSON.parse(await readFile(generated.reportPath, "utf8"));
  assert.equal(report.adapter, "fixture");
  assert.equal(report.fixture, "allowed");
  assert.equal(report.runId, plan.runId);
  assert.deepEqual(report.filesChanged, generated.filesChanged);
  assert.deepEqual(report.policyResult, { ok: true });
  assert.match(report.summary, /Fixture generator wrote 1 changed file/);
  assert.match(report.commitSha, /^[0-9a-f]{40}$/);

  const generatedFile = path.join(workspace.workspace.worktreePath, "anchor-output", `${plan.runId}.txt`);
  assert.equal(await exists(generatedFile), true);
  assert.equal(await exists(path.join(process.cwd(), "anchor-output", `${plan.runId}.txt`)), false);

  const status = await runJson(["status", plan.runId], paths);
  assert.equal(status.state, "CHECK");

  const events = await runJson(["events", plan.runId], paths);
  assert.deepEqual(
    events.events.map((event) => event.event_type),
    ["TASK_RECEIVED", "CONTRACT_PRODUCED", "CONTRACT_APPROVED", "WORKSPACE_CREATED", "CODE_PRODUCED"]
  );

  await cleanupWorktree(workspace.workspace);
  await rm(path.join(process.cwd(), "anchor-output"), { recursive: true, force: true });
});

test("fixture generator policy violation writes report but does not append CODE_PRODUCED", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runJson(["generate", plan.runId, "--adapter", "fixture", "--fixture", "outside"], paths);

  assert.equal(generated.ok, false);
  assert.equal(generated.error.code, "POLICY_VIOLATION");
  assert.equal(generated.state, "BUILD");
  assert.equal(generated.error.report.filesChanged.includes(`outside-output/${plan.runId}.txt`), true);
  assert.equal(generated.error.report.policyResult.ok, false);
  assert.equal(generated.error.report.policyResult.code, "GENERATOR_WRITE_OUTSIDE_ALLOWLIST");
  assert.equal(await exists(generated.error.reportPath), true);

  const status = await runJson(["status", plan.runId], paths);
  assert.equal(status.state, "BUILD");

  const events = await runJson(["events", plan.runId], paths);
  assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);

  const generatedFile = path.join(workspace.workspace.worktreePath, "outside-output", `${plan.runId}.txt`);
  assert.equal(await exists(generatedFile), true);
  assert.equal(await exists(path.join(process.cwd(), "outside-output", `${plan.runId}.txt`)), false);

  await cleanupWorktree(workspace.workspace);
  await rm(path.join(process.cwd(), "outside-output"), { recursive: true, force: true });
});

test("generate requires BUILD state and an active workspace", async () => {
  const paths = await tempPaths();
  const plan = await runJson(["plan", "Missing generator prerequisites"], paths);
  const unapproved = await runJson(["generate", plan.runId, "--adapter", "fixture"], paths);

  assert.equal(unapproved.ok, false);
  assert.equal(unapproved.error, "generate_requires_build_state");
  assert.equal(unapproved.state, "HUMAN");

  await runJson(["approve", plan.runId], paths);
  const missingWorkspace = await runJson(["generate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(missingWorkspace.ok, false);
  assert.equal(missingWorkspace.error, "workspace_required");
});
