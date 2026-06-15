import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist", "cli", "index.js");

async function tempDir(prefix = "anchor-quickstart-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function runJson(args, cwd) {
  const configPath = path.join(cwd, ".test-anchor-home", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "provider: fixture\n");
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HOME: path.join(cwd, ".test-home"),
        ANCHOR_CONFIG_PATH: configPath
      }
    });
    return { ...JSON.parse(stdout), exitCode: 0 };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "code" in error) {
      return { ...JSON.parse(String(error.stdout)), exitCode: error.code };
    }
    throw error;
  }
}

async function initRepo(repo) {
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["config", "user.email", "anchor@example.test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["config", "user.name", "Anchor Test"], { cwd: repo, encoding: "utf8" });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo, encoding: "utf8" });
}

test("anchor run and next guide the quickstart path without generating code", async () => {
  const repo = await tempDir();
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  const repoRoot = await realpath(repo);

  const run = await runJson(["run", "test task"], repo);
  assert.equal(run.ok, true);
  assert.equal(run.command, "run");
  assert.equal(run.state, "HUMAN");
  assert.equal(run.taskId, "TASK-001");
  assert.equal(run.contractPath, path.join(repoRoot, ".anchor", "tasks", "TASK-001", "contract.yaml"));
  assert.deepEqual(run.nextCommands, [
    "anchor contract TASK-001",
    "anchor approve TASK-001",
    "anchor workspace create TASK-001"
  ]);
  assert.equal(await exists(run.contractPath), true);
  assert.equal(await exists(path.join(repoRoot, ".anchor", "events.jsonl")), true);
  assert.equal(await exists(path.join(repoRoot, ".anchor", "config.yaml")), false);

  const humanNext = await runJson(["next", run.taskId], repo);
  assert.equal(humanNext.ok, true);
  assert.equal(humanNext.state, "HUMAN");
  assert.deepEqual(humanNext.nextCommands, run.nextCommands);

  const contract = await runJson(["contract", run.taskId], repo);
  assert.equal(contract.ok, true);
  assert.match(contract.contract, /acceptance:/);

  const status = await runJson(["status", run.taskId], repo);
  assert.equal(status.state, "HUMAN");

  const events = await runJson(["events", run.taskId], repo);
  assert.deepEqual(
    events.events.map((event) => event.event_type),
    ["TASK_RECEIVED", "CONTRACT_PRODUCED"]
  );

  const approved = await runJson(["approve", run.taskId], repo);
  assert.equal(approved.state, "BUILD");
  const buildNext = await runJson(["next", run.taskId], repo);
  assert.equal(buildNext.state, "BUILD");
  assert.deepEqual(buildNext.nextCommands, [
    "anchor workspace create TASK-001",
    "anchor generate TASK-001 --provider fixture"
  ]);

  const { createFileRunStore } = await import("../dist/index.js");
  const store = createFileRunStore(path.join(repo, ".anchor", "events.jsonl"));
  const produced = await store.appendEvent(
    run.taskId,
    { type: "CODE_PRODUCED", report_path: "generator-report.json", files_changed: ["anchor-output/TASK-001.txt"], attempt: 1 },
    "generator"
  );
  assert.equal(produced.ok, true);
  const checkNext = await runJson(["next", run.taskId], repo);
  assert.equal(checkNext.state, "CHECK");
  assert.deepEqual(checkNext.nextCommands, ["anchor evaluate TASK-001 --provider fixture --verdict pass"]);

  const evaluated = await store.appendEvent(run.taskId, { type: "EVAL_COMPLETE", verdict: "PASS" }, "evaluator");
  assert.equal(evaluated.ok, true);
  const doneNext = await runJson(["next", run.taskId], repo);
  assert.equal(doneNext.state, "DONE");
  assert.deepEqual(doneNext.nextCommands, []);
  assert.equal(doneNext.message, "Task is complete.");
});

test("anchor run requires a git repository", async () => {
  const dir = await tempDir();

  const result = await runJson(["run", "test task"], dir);
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_git_repo");
  assert.match(result.message, /git repository/);
});

test("anchor run from a subdirectory uses the git root .anchor directory", async () => {
  const repo = await tempDir();
  const subdir = path.join(repo, "packages", "app");
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  await mkdir(subdir, { recursive: true });
  const repoRoot = await realpath(repo);

  const run = await runJson(["run", "test task"], subdir);
  assert.equal(run.ok, true);
  assert.equal(run.storePath, path.join(repoRoot, ".anchor", "events.jsonl"));
  assert.equal(run.tasksDir, path.join(repoRoot, ".anchor", "tasks"));
  assert.equal(await exists(run.contractPath), true);
  assert.equal(await exists(path.join(subdir, ".anchor")), false);
});

test("anchor run-wait stops at HUMAN for standard mode contract approval", async () => {
  const repo = await tempDir();
  await initRepo(repo);

  const result = await runJson(["run-wait", "test task"], repo);
  assert.equal(result.ok, true);
  assert.equal(result.command, "run-wait");
  assert.equal(result.state, "HUMAN");
  assert.equal(result.stoppedReason, "human_required");
  assert.equal(result.taskId, "TASK-001");
  assert.deepEqual(result.steps.map((step) => step.command), ["run"]);
  assert.deepEqual(result.nextCommands, [
    "anchor contract TASK-001",
    "anchor approve TASK-001",
    "anchor workspace create TASK-001"
  ]);
});

test("anchor run-wait drives quick mode to DONE without human intervention", async () => {
  const repo = await tempDir();
  await initRepo(repo);

  const result = await runJson(["run-wait", "--mode", "quick", "test quick task"], repo);
  assert.equal(result.ok, true);
  assert.equal(result.state, "DONE");
  assert.equal(result.stoppedReason, "terminal_state");
  assert.deepEqual(result.context.completedStepIds, ["1"]);
  assert.deepEqual(
    result.steps.map((step) => step.command),
    ["run", "workspace create", "generate", "evaluate"]
  );
  assert.equal(result.steps.find((step) => step.command === "generate").stepId, "1");
  assert.equal(result.steps.find((step) => step.command === "evaluate").stepId, "1");
  assert.deepEqual(result.nextCommands, []);
});

test("anchor run-wait auto-reviews thorough mode then stops for human approval", async () => {
  const repo = await tempDir();
  await initRepo(repo);

  const result = await runJson(["run-wait", "--mode", "thorough", "test thorough task"], repo);
  assert.equal(result.ok, true);
  assert.equal(result.state, "HUMAN");
  assert.equal(result.stoppedReason, "human_required");
  assert.deepEqual(
    result.steps.map((step) => step.command),
    ["run", "review"]
  );
});

test("anchor run-wait stops at the agent loop limit", async () => {
  const repo = await tempDir();
  await initRepo(repo);

  const result = await runJson(["run-wait", "--max-steps", "2", "--mode", "quick", "test quick task"], repo);
  assert.equal(result.ok, true);
  assert.equal(result.state, "BUILD");
  assert.equal(result.stoppedReason, "agent_loop_limit");
  assert.equal(result.context.currentStepId, "1");
  assert.deepEqual(
    result.steps.map((step) => step.command),
    ["run", "workspace create"]
  );
});

test("anchor run-wait resumes after human approval and finishes agent-owned work", async () => {
  const repo = await tempDir();
  await initRepo(repo);

  const first = await runJson(["run-wait", "test task"], repo);
  assert.equal(first.state, "HUMAN");

  const approved = await runJson(["approve", first.taskId], repo);
  assert.equal(approved.state, "BUILD");

  const resumed = await runJson(["run-wait", first.taskId], repo);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state, "DONE");
  assert.equal(resumed.stoppedReason, "terminal_state");
  assert.deepEqual(
    resumed.steps.map((step) => step.command),
    ["workspace create", "generate", "evaluate"]
  );
});

test("anchor next reports a clear error for unknown tasks", async () => {
  const repo = await tempDir();
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });

  const result = await runJson(["next", "TASK-404"], repo);
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "task_not_found");
  assert.equal(result.taskId, "TASK-404");
});
