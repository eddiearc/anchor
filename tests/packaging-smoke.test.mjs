import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function execJson(command, args, options) {
  const { stdout } = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
  return JSON.parse(stdout);
}

async function execText(command, args, options) {
  const { stdout } = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
  return stdout.trim();
}

test("npm tarball installs an anchor binary that works outside the source repo", async () => {
  const repoRoot = process.cwd();
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const tmp = await mkdtemp(path.join(os.tmpdir(), "anchor-packaging-"));
  const packDir = path.join(tmp, "pack");
  const prefix = path.join(tmp, "prefix");
  const fixtureRepo = path.join(tmp, "fixture-repo");
  await mkdir(packDir, { recursive: true });

  const pack = await execJson("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: repoRoot });
  assert.equal(pack.length, 1);
  assert.equal(pack[0].name, packageJson.name);
  assert.equal(pack[0].version, packageJson.version);
  assert.match(pack[0].filename, /^anchor-0\.0\.0\.tgz$/);

  const tarballFiles = pack[0].files.map((file) => file.path);
  assert(tarballFiles.includes("dist/cli/index.js"));
  assert(tarballFiles.includes("dist/index.js"));
  assert(tarballFiles.includes("README.md"));
  for (const filePath of tarballFiles) {
    assert.equal(filePath.startsWith("src/"), false, `${filePath} should not be packed`);
    assert.equal(filePath.startsWith("tests/"), false, `${filePath} should not be packed`);
    assert.equal(filePath.startsWith(".anchor/"), false, `${filePath} should not be packed`);
    assert.equal(filePath.includes("worktrees"), false, `${filePath} should not be packed`);
    assert.equal(filePath.includes("logs"), false, `${filePath} should not be packed`);
    assert.equal(filePath.includes("secret"), false, `${filePath} should not be packed`);
    assert.equal(filePath.includes(".env"), false, `${filePath} should not be packed`);
  }

  const tarballPath = path.join(packDir, pack[0].filename);
  await execFileAsync("npm", ["install", "-g", "--prefix", prefix, tarballPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  const anchorBin = path.join(prefix, "bin", "anchor");

  const help = await execText(anchorBin, ["--help"]);
  assert.match(help, /Usage:/);
  assert.equal(await execText(anchorBin, ["--version"]), packageJson.version);

  await execFileAsync("git", ["init", fixtureRepo], { encoding: "utf8" });
  const init = await execJson(anchorBin, ["init"], { cwd: fixtureRepo });
  assert.equal(init.ok, true);
  assert.equal(init.command, "init");
  assert.equal(await exists(path.join(fixtureRepo, ".anchor", "config.yaml")), true);

  const demo = await execJson(anchorBin, ["demo"], { cwd: fixtureRepo });
  assert.equal(demo.ok, true);
  assert.equal(demo.finalState, "DONE");
  assert.equal(await exists(path.join(fixtureRepo, ".anchor", "events.jsonl")), true);

  const run = await execJson(anchorBin, ["run", "test task"], { cwd: fixtureRepo });
  assert.equal(run.ok, true);
  assert.equal(run.command, "run");
  assert.equal(run.state, "HUMAN");
  assert.equal(await exists(path.resolve(fixtureRepo, run.contractPath)), true);
  assert.deepEqual(run.nextCommands, [
    `anchor contract ${run.taskId}`,
    `anchor approve ${run.taskId}`,
    `anchor workspace create ${run.taskId}`
  ]);

  const next = await execJson(anchorBin, ["next", run.taskId], { cwd: fixtureRepo });
  assert.equal(next.ok, true);
  assert.equal(next.state, "HUMAN");
  assert.deepEqual(next.nextCommands, run.nextCommands);

  const contract = await execJson(anchorBin, ["contract", run.taskId], { cwd: fixtureRepo });
  assert.equal(contract.ok, true);

  const status = await execJson(anchorBin, ["status", run.taskId], { cwd: fixtureRepo });
  assert.equal(status.ok, true);
  assert.equal(status.taskId, run.taskId);
  assert.equal(status.state, "HUMAN");

  const events = await execJson(anchorBin, ["events", run.taskId], { cwd: fixtureRepo });
  assert.equal(events.ok, true);
  assert.equal(events.taskId, run.taskId);
  assert.deepEqual(
    events.events.map((event) => event.event_type),
    ["TASK_RECEIVED", "CONTRACT_PRODUCED"]
  );
});
