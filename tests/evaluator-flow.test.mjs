import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createFileRunStore } from "../dist/index.js";
import { runCli } from "../dist/cli/index.js";

const execFileAsync = promisify(execFile);

async function tempPaths() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-evaluator-"));
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

async function generatedRun(paths) {
  const plan = await runJson(["plan", "Evaluate fixture output"], paths);
  await runJson(["approve", plan.runId], paths);
  const workspace = await runJson(["workspace", "create", plan.runId], paths);
  const generated = await runJson(["generate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(generated.state, "CHECK");
  return { plan, workspace, generated };
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

async function setRetriesLeft(storePath, runId, retriesLeft) {
  const records = (await readFile(storePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const rewritten = records
    .map((record) => {
      if (record.record_type === "run_created" && record.run.id === runId) {
        return JSON.stringify({ ...record, run: { ...record.run, context: { ...record.run.context, retriesLeft } } });
      }
      return JSON.stringify(record);
    })
    .join("\n");
  await writeFile(storePath, `${rewritten}\n`);
}

async function worktreeFiles(worktreePath) {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8"
  });
  return stdout.trim().split("\n").filter(Boolean);
}

test("fixture evaluator PASS writes report, appends event, and advances CHECK to DONE", async () => {
  const paths = await tempPaths();
  const { plan, workspace, generated } = await generatedRun(paths);
  const beforeFiles = await worktreeFiles(workspace.workspace.worktreePath);
  const evaluated = await runJson(["evaluate", plan.runId, "--adapter", "fixture", "--verdict", "pass"], paths);

  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.command, "evaluate");
  assert.equal(evaluated.state, "DONE");
  assert.equal(evaluated.verdict, "PASS");
  assert.equal(evaluated.testsRun, 1);
  assert.equal(evaluated.testsFailed, 0);
  assert.equal(evaluated.event.event_type, "EVAL_COMPLETE");
  assert.equal(evaluated.event.emitted_by, "evaluator");
  assert.equal(evaluated.event.state_before, "CHECK");
  assert.equal(evaluated.event.state_after, "DONE");
  assert.equal(evaluated.event.payload.report_path, evaluated.reportPath);
  assert.equal(evaluated.event.payload.verdict, "PASS");
  assert.equal(evaluated.event.payload.tests_run, 1);
  assert.equal(evaluated.event.payload.tests_failed, 0);

  const report = JSON.parse(await readFile(evaluated.reportPath, "utf8"));
  assert.equal(report.adapter, "fixture");
  assert.equal(report.verdict, "PASS");
  assert.equal(report.runId, plan.runId);
  assert.equal(report.testsRun, 1);
  assert.equal(report.testsFailed, 0);
  assert.equal(report.generatorReportPath, generated.reportPath);
  assert.deepEqual(report.filesInspected, generated.filesChanged);
  assert.match(report.summary, /Fixture evaluator returned PASS/);

  assert.deepEqual(await worktreeFiles(workspace.workspace.worktreePath), beforeFiles);
  const events = await runJson(["events", plan.runId], paths);
  assert.deepEqual(
    events.events.map((event) => event.event_type),
    ["TASK_RECEIVED", "CONTRACT_PRODUCED", "CONTRACT_APPROVED", "WORKSPACE_CREATED", "CODE_PRODUCED", "EVAL_COMPLETE"]
  );

  await cleanupWorktree(workspace.workspace);
});

test("fixture evaluator FAIL returns CHECK to BUILD and consumes retry budget", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await generatedRun(paths);
  const evaluated = await runJson(["evaluate", plan.runId, "--adapter", "fixture", "--verdict", "fail"], paths);

  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.state, "BUILD");
  assert.equal(evaluated.verdict, "FAIL");
  assert.equal(evaluated.testsFailed, 1);
  assert.equal(evaluated.event.state_before, "CHECK");
  assert.equal(evaluated.event.state_after, "BUILD");

  const status = await runJson(["status", plan.runId], paths);
  assert.equal(status.state, "BUILD");
  assert.equal(status.context.retriesLeft, 2);

  const report = JSON.parse(await readFile(evaluated.reportPath, "utf8"));
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.testsFailed, 1);

  await cleanupWorktree(workspace.workspace);
});

test("fixture evaluator FAIL with exhausted retries moves CHECK to HUMAN", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await generatedRun(paths);
  await setRetriesLeft(paths.storePath, plan.runId, 0);

  const evaluated = await runJson(["evaluate", plan.runId, "--adapter", "fixture", "--verdict", "fail"], paths);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.state, "HUMAN");
  assert.equal(evaluated.event.state_before, "CHECK");
  assert.equal(evaluated.event.state_after, "HUMAN");

  const status = await runJson(["status", plan.runId], paths);
  assert.equal(status.state, "HUMAN");
  assert.equal(status.context.retriesLeft, 0);

  await cleanupWorktree(workspace.workspace);
});

test("evaluate guards reject non-CHECK, missing report, cleaned workspace, and unsupported adapter without events", async () => {
  const paths = await tempPaths();
  const plan = await runJson(["plan", "Evaluate guard path"], paths);
  const nonCheck = await runJson(["evaluate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(nonCheck.ok, false);
  assert.equal(nonCheck.error, "evaluate_requires_check_state");

  await runJson(["approve", plan.runId], paths);
  const workspace = await runJson(["workspace", "create", plan.runId], paths);
  const store = createFileRunStore(paths.storePath);
  const codeProduced = await store.appendEvent(
    plan.runId,
    {
      type: "CODE_PRODUCED",
      report_path: path.join(paths.runsDir, plan.runId, "missing-generator-report.json"),
      files_changed: ["anchor-output/missing.txt"],
      attempt: 1
    },
    "generator"
  );
  assert.equal(codeProduced.ok, true);

  const missingReport = await runJson(["evaluate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(missingReport.ok, false);
  assert.equal(missingReport.error.code, "GENERATOR_REPORT_NOT_FOUND");
  assert.equal((await runJson(["events", plan.runId], paths)).events.some((event) => event.event_type === "EVAL_COMPLETE"), false);

  await cleanupWorktree(workspace.workspace);
});

test("evaluate rejects cleaned workspace and unsupported adapter without EVAL_COMPLETE", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await generatedRun(paths);
  const unsupported = await runJson(["evaluate", plan.runId, "--adapter", "command"], paths);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "UNSUPPORTED_ADAPTER");
  assert.equal((await runJson(["events", plan.runId], paths)).events.some((event) => event.event_type === "EVAL_COMPLETE"), false);

  await runJson(["workspace", "cleanup", plan.runId], paths);
  const cleaned = await runJson(["evaluate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(cleaned.ok, false);
  assert.equal(cleaned.error, "workspace_required");
  assert.equal((await exists(path.join(paths.runsDir, plan.runId, "evaluator-report.json"))), false);

  await cleanupWorktree(workspace.workspace);
});
