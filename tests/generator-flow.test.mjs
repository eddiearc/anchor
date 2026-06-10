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

async function createFakeCodexScript(paths) {
  const scriptPath = path.join(path.dirname(paths.storePath), "fake-codex.mjs");
  await writeFile(
    scriptPath,
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "const prompt = process.argv.at(-1) ?? '';",
      "const runId = /Run ID: (\\S+)/.exec(prompt)?.[1] ?? 'unknown-run';",
      "const mode = process.env.ANCHOR_FAKE_CODEX_MODE ?? 'success';",
      "const allowedLine = prompt.split('\\n').find((line) => line.startsWith('- Stay inside allowed scope:')) ?? '';",
      "const deniedLine = prompt.split('\\n').find((line) => line.startsWith('- Do not change denied paths:')) ?? '';",
      "const denyItems = ['.env*', 'secrets/**', 'node_modules/**', 'dist/**', '.git/**'];",
      "const leakedDenyItems = denyItems.filter((item) => allowedLine.includes(item));",
      "const missingDenyItems = denyItems.filter((item) => !deniedLine.includes(item));",
      "if (leakedDenyItems.length || missingDenyItems.length) {",
      "  console.error(JSON.stringify({ allowedLine, deniedLine, leakedDenyItems, missingDenyItems }));",
      "  process.exit(19);",
      "}",
      "if (mode === 'nonzero') {",
      "  console.error('fake codex failure');",
      "  process.exit(17);",
      "}",
      "if (mode !== 'noop') {",
      "  const dir = mode === 'outside' ? 'outside-output' : 'anchor-output';",
      "  const filePath = path.join(process.cwd(), dir, `${runId}.txt`);",
      "  await mkdir(path.dirname(filePath), { recursive: true });",
      "  await writeFile(filePath, [`runId=${runId}`, `mode=${mode}`, `cwd=${process.cwd()}`, 'adapter=codex', ''].join('\\n'));",
      "}",
      "console.log('fake codex prompt policy ok');",
      "console.log(`fake codex ${mode}`);"
    ].join("\n")
  );
  return scriptPath;
}

async function runWithFakeCodex(args, paths, scriptPath, mode) {
  const previousCommand = process.env.ANCHOR_CODEX_COMMAND;
  const previousArgv = process.env.ANCHOR_CODEX_ARGV_JSON;
  const previousMode = process.env.ANCHOR_FAKE_CODEX_MODE;
  process.env.ANCHOR_CODEX_COMMAND = process.execPath;
  process.env.ANCHOR_CODEX_ARGV_JSON = JSON.stringify([scriptPath]);
  process.env.ANCHOR_FAKE_CODEX_MODE = mode;
  try {
    return await runJson(args, paths);
  } finally {
    restoreEnv("ANCHOR_CODEX_COMMAND", previousCommand);
    restoreEnv("ANCHOR_CODEX_ARGV_JSON", previousArgv);
    restoreEnv("ANCHOR_FAKE_CODEX_MODE", previousMode);
  }
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
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

test("codex generator runs fake command in worktree, writes report, and advances BUILD to CHECK", async () => {
  const paths = await tempPaths();
  const scriptPath = await createFakeCodexScript(paths);
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runWithFakeCodex(["generate", plan.runId, "--adapter", "codex"], paths, scriptPath, "success");

  assert.equal(generated.ok, true);
  assert.equal(generated.state, "CHECK");
  assert.deepEqual(generated.filesChanged, [`anchor-output/${plan.runId}.txt`]);
  assert.equal(generated.event.event_type, "CODE_PRODUCED");
  assert.equal(generated.event.payload.report_path, generated.reportPath);
  assert.deepEqual(generated.event.payload.files_changed, generated.filesChanged);

  const report = JSON.parse(await readFile(generated.reportPath, "utf8"));
  assert.equal(report.adapter, "codex");
  assert.equal(report.command, process.execPath);
  assert.deepEqual(report.argv, [scriptPath, "[prompt redacted]"]);
  assert.equal(report.exitCode, 0);
  assert.match(report.stdoutSummary, /fake codex prompt policy ok/);
  assert.match(report.stdoutSummary, /fake codex success/);
  assert.deepEqual(report.policyResult, { ok: true });
  assert.match(report.summary, /Codex generator changed 1 file/);

  const generatedFile = path.join(workspace.workspace.worktreePath, "anchor-output", `${plan.runId}.txt`);
  const content = await readFile(generatedFile, "utf8");
  assert.match(content, new RegExp(`cwd=.*\\/worktrees\\/${plan.runId}`));
  assert.equal(await exists(path.join(process.cwd(), "anchor-output", `${plan.runId}.txt`)), false);

  await cleanupWorktree(workspace.workspace);
  await rm(path.join(process.cwd(), "anchor-output"), { recursive: true, force: true });
});

test("codex generator policy violation writes report but does not append CODE_PRODUCED", async () => {
  const paths = await tempPaths();
  const scriptPath = await createFakeCodexScript(paths);
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runWithFakeCodex(["generate", plan.runId, "--adapter", "codex"], paths, scriptPath, "outside");

  assert.equal(generated.ok, false);
  assert.equal(generated.error.code, "POLICY_VIOLATION");
  assert.equal(generated.state, "BUILD");
  assert.equal(generated.error.report.adapter, "codex");
  assert.equal(generated.error.report.policyResult.code, "GENERATOR_WRITE_OUTSIDE_ALLOWLIST");
  assert.equal(generated.error.report.filesChanged.includes(`outside-output/${plan.runId}.txt`), true);
  assert.equal(await exists(generated.error.reportPath), true);

  const events = await runJson(["events", plan.runId], paths);
  assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);

  await cleanupWorktree(workspace.workspace);
  await rm(path.join(process.cwd(), "outside-output"), { recursive: true, force: true });
});

test("codex generator non-zero exit writes failure report without advancing state", async () => {
  const paths = await tempPaths();
  const scriptPath = await createFakeCodexScript(paths);
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runWithFakeCodex(["generate", plan.runId, "--adapter", "codex"], paths, scriptPath, "nonzero");

  assert.equal(generated.ok, false);
  assert.equal(generated.error.code, "CODEX_COMMAND_FAILED");
  assert.equal(generated.state, "BUILD");
  assert.equal(generated.error.report.adapter, "codex");
  assert.equal(generated.error.report.exitCode, 17);
  assert.match(generated.error.report.stderrSummary, /fake codex failure/);
  assert.equal(await exists(generated.error.reportPath), true);

  const events = await runJson(["events", plan.runId], paths);
  assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);

  await cleanupWorktree(workspace.workspace);
});

test("codex generator no-op and unavailable paths do not append CODE_PRODUCED", async () => {
  const paths = await tempPaths();
  const scriptPath = await createFakeCodexScript(paths);
  const { plan, workspace } = await preparedWorkspace(paths);
  const noop = await runWithFakeCodex(["generate", plan.runId, "--adapter", "codex"], paths, scriptPath, "noop");

  assert.equal(noop.ok, false);
  assert.equal(noop.error.code, "CODEX_NO_CHANGES");
  assert.equal(noop.state, "BUILD");
  assert.equal(noop.error.report.filesChanged.length, 0);
  assert.equal(await exists(noop.error.reportPath), true);

  const previousCommand = process.env.ANCHOR_CODEX_COMMAND;
  const previousArgv = process.env.ANCHOR_CODEX_ARGV_JSON;
  process.env.ANCHOR_CODEX_COMMAND = path.join(path.dirname(paths.storePath), "missing-codex");
  delete process.env.ANCHOR_CODEX_ARGV_JSON;
  try {
    const unavailable = await runJson(["generate", plan.runId, "--adapter", "codex"], paths);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error.code, "CODEX_CLI_UNAVAILABLE");
    assert.equal(unavailable.state, "BUILD");
    assert.equal(unavailable.error.reportPath, undefined);
  } finally {
    restoreEnv("ANCHOR_CODEX_COMMAND", previousCommand);
    restoreEnv("ANCHOR_CODEX_ARGV_JSON", previousArgv);
  }

  const events = await runJson(["events", plan.runId], paths);
  assert.equal(events.events.some((event) => event.event_type === "CODE_PRODUCED"), false);

  await cleanupWorktree(workspace.workspace);
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

test("workspace cleanup after CHECK records audit event and leaves consistent cleanup state", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runJson(["generate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(generated.state, "CHECK");

  const cleanup = await runJson(["workspace", "cleanup", plan.runId], paths);
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.cleaned, true);
  assert.equal(cleanup.state, "CHECK");
  assert.equal(cleanup.status.pathExists, false);
  assert.equal(cleanup.event.event_type, "WORKSPACE_CLEANED");
  assert.equal(cleanup.event.state_before, "CHECK");
  assert.equal(cleanup.event.state_after, "CHECK");
  assert.equal(await exists(workspace.workspace.worktreePath), false);

  const afterCleanup = await runJson(["workspace", "status", plan.runId], paths);
  assert.equal(afterCleanup.workspace.cleanedAt, cleanup.workspace.cleanedAt);
  assert.equal(afterCleanup.status.pathExists, false);

  const events = await runJson(["events", plan.runId], paths);
  assert.deepEqual(
    events.events.map((event) => event.event_type),
    [
      "TASK_RECEIVED",
      "CONTRACT_PRODUCED",
      "CONTRACT_APPROVED",
      "WORKSPACE_CREATED",
      "CODE_PRODUCED",
      "WORKSPACE_CLEANED"
    ]
  );

  await cleanupWorktree(workspace.workspace);
});

test("workspace cleanup rejected in terminal state has no filesystem or metadata side effects", async () => {
  const paths = await tempPaths();
  const { plan, workspace } = await preparedWorkspace(paths);
  const generated = await runJson(["generate", plan.runId, "--adapter", "fixture"], paths);
  assert.equal(generated.state, "CHECK");

  const store = createFileRunStore(paths.storePath);
  const evalResult = await store.appendEvent(plan.runId, { type: "EVAL_COMPLETE", verdict: "PASS" }, "evaluator");
  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.event.state_after, "DONE");

  const rejected = await runJson(["workspace", "cleanup", plan.runId], paths);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "workspace_cleanup_rejected_in_terminal_state");
  assert.equal(rejected.state, "DONE");
  assert.equal(await exists(workspace.workspace.worktreePath), true);

  const afterReject = await runJson(["workspace", "status", plan.runId], paths);
  assert.equal(afterReject.workspace.cleanedAt, undefined);
  assert.equal(afterReject.status.pathExists, true);

  const events = await runJson(["events", plan.runId], paths);
  assert.equal(events.events.some((event) => event.event_type === "WORKSPACE_CLEANED"), false);

  await cleanupWorktree(workspace.workspace);
});
