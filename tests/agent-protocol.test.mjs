import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist", "cli", "index.js");

async function tempDir(prefix = "anchor-agent-protocol-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runCliJson(args, cwd) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ANCHOR_CONFIG_PATH: path.join(cwd, ".test-anchor-home", "config.yaml") }
    });
    return { exitCode: 0, json: JSON.parse(stdout) };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "code" in error) {
      return { exitCode: error.code, json: JSON.parse(String(error.stdout)) };
    }
    throw error;
  }
}

test("agent protocol exposes structured nextActions for HUMAN BUILD CHECK and DONE", async () => {
  const repo = await tempDir();
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["config", "user.email", "anchor@example.test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["config", "user.name", "Anchor Test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo, encoding: "utf8" });

  const init = await runCliJson(["init"], repo);
  assert.equal(init.exitCode, 0);
  assert.equal(init.json.ok, true);

  const run = await runCliJson(["run", "test task"], repo);
  assert.equal(run.exitCode, 0);
  assert.equal(run.json.ok, true);
  assert.equal(run.json.taskId, "TASK-001");
  assert.equal(run.json.state, "HUMAN");
  assert.deepEqual(run.json.nextActions.map((action) => action.action), [
    "view_contract",
    "approve_contract",
    "create_workspace"
  ]);
  assert.deepEqual(run.json.nextActions[0].command, ["anchor", "contract", "TASK-001"]);
  assert.equal(run.json.artifacts.contractPath, ".anchor/tasks/TASK-001/contract.yaml");

  const humanNext = await runCliJson(["next", "TASK-001"], repo);
  assert.equal(humanNext.exitCode, 0);
  assert.deepEqual(humanNext.json.nextActions.map((action) => action.action), [
    "view_contract",
    "approve_contract",
    "create_workspace"
  ]);

  const approve = await runCliJson(["approve", "TASK-001"], repo);
  assert.equal(approve.exitCode, 0);
  assert.equal(approve.json.state, "BUILD");
  const buildNext = await runCliJson(["next", "TASK-001"], repo);
  assert.deepEqual(buildNext.json.nextActions.map((action) => action.action), ["create_workspace", "generate"]);

  const workspace = await runCliJson(["workspace", "create", "TASK-001"], repo);
  assert.equal(workspace.exitCode, 0);
  const generate = await runCliJson(["generate", "TASK-001", "--adapter", "fixture"], repo);
  assert.equal(generate.exitCode, 0);
  assert.equal(generate.json.state, "CHECK");
  const checkNext = await runCliJson(["next", "TASK-001"], repo);
  assert.deepEqual(checkNext.json.nextActions.map((action) => action.action), ["evaluate"]);
  assert.deepEqual(checkNext.json.nextActions[0].command, ["anchor", "evaluate", "TASK-001", "--adapter", "fixture", "--verdict", "pass"]);

  const evaluate = await runCliJson(["evaluate", "TASK-001", "--adapter", "fixture", "--verdict", "pass"], repo);
  assert.equal(evaluate.exitCode, 0);
  assert.equal(evaluate.json.state, "DONE");
  const doneNext = await runCliJson(["next", "TASK-001"], repo);
  assert.equal(doneNext.exitCode, 0);
  assert.equal(doneNext.json.state, "DONE");
  assert.deepEqual(doneNext.json.nextActions.map((action) => action.action), ["done"]);
  assert.deepEqual(doneNext.json.nextCommands, []);
});

test("agent protocol returns non-zero exit with JSON errors for predictable failures", async () => {
  const outside = await tempDir();
  const nonGit = await runCliJson(["init"], outside);
  assert.equal(nonGit.exitCode, 1);
  assert.equal(nonGit.json.ok, false);
  assert.equal(nonGit.json.error, "not_git_repo");

  const repo = await tempDir();
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  await runCliJson(["init"], repo);

  const unknownNext = await runCliJson(["next", "TASK-404"], repo);
  assert.equal(unknownNext.exitCode, 1);
  assert.equal(unknownNext.json.ok, false);
  assert.equal(unknownNext.json.error, "task_not_found");

  const unknownStatus = await runCliJson(["status", "TASK-404"], repo);
  assert.equal(unknownStatus.exitCode, 1);
  assert.equal(unknownStatus.json.ok, false);
  assert.equal(unknownStatus.json.error, "task_not_started");

  const run = await runCliJson(["run", "test task"], repo);
  assert.equal(run.exitCode, 0);

  const illegalGenerate = await runCliJson(["generate", run.json.taskId, "--adapter", "fixture"], repo);
  assert.equal(illegalGenerate.exitCode, 1);
  assert.equal(illegalGenerate.json.ok, false);
  assert.equal(illegalGenerate.json.error, "generate_requires_build_state");

  await execFileAsync("git", ["config", "user.email", "anchor@example.test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["config", "user.name", "Anchor Test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo, encoding: "utf8" });
  await runCliJson(["approve", run.json.taskId], repo);
  await runCliJson(["workspace", "create", run.json.taskId], repo);
  await runCliJson(["generate", run.json.taskId, "--adapter", "fixture"], repo);

  const invalidVerdict = await runCliJson(["evaluate", run.json.taskId, "--adapter", "fixture", "--verdict", "maybe"], repo);
  assert.equal(invalidVerdict.exitCode, 1);
  assert.equal(invalidVerdict.json.ok, false);
  assert.equal(invalidVerdict.json.error.code, "INVALID_VERDICT");
});
