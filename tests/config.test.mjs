import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Import from dist after build
import { composePrompt, loadAnchorConfig } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const originalHome = process.env.HOME;
const originalConfigPath = process.env.ANCHOR_CONFIG_PATH;
const configTestHome = await tempDir("anchor-config-home-");
process.env.HOME = configTestHome;
delete process.env.ANCHOR_CONFIG_PATH;

test.after(async () => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalConfigPath) process.env.ANCHOR_CONFIG_PATH = originalConfigPath;
  else delete process.env.ANCHOR_CONFIG_PATH;
  await rm(configTestHome, { recursive: true, force: true }).catch(() => {});
});

async function tempDir(prefix = "anchor-config-") {
  return await mkdtemp(path.join(tmpdir(), prefix));
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

// ── composePrompt ──

test("composePrompt returns base only when config is undefined", () => {
  const result = composePrompt(undefined, "generator_prompt", "Base prompt");
  assert.equal(result, "Base prompt");
});

test("composePrompt includes global prompt when present", () => {
  const result = composePrompt(
    { prompt: "Global instructions" },
    "generator_prompt",
    "Base prompt"
  );
  assert.ok(result.includes("Base prompt"));
  assert.ok(result.includes("Global instructions"));
});

test("composePrompt includes role override when present", () => {
  const result = composePrompt(
    { generator_prompt: "Generator specific" },
    "generator_prompt",
    "Base prompt"
  );
  assert.ok(result.includes("Base prompt"));
  assert.ok(result.includes("Generator specific"));
});

test("composePrompt includes both global and role overrides", () => {
  const result = composePrompt(
    { prompt: "Global", generator_prompt: "Gen role" },
    "generator_prompt",
    "Base"
  );
  const baseIndex = result.indexOf("Base");
  const globalIndex = result.indexOf("Global");
  const roleIndex = result.indexOf("Gen role");
  assert.ok(baseIndex < globalIndex);
  assert.ok(globalIndex < roleIndex);
});

test("composePrompt skips empty role prompt", () => {
  const result = composePrompt(
    { generator_prompt: "" },
    "generator_prompt",
    "Base"
  );
  assert.equal(result, "Base");
});

test("composePrompt handles reviewer_prompt key", () => {
  const result = composePrompt(
    { reviewer_prompt: "Review guidelines" },
    "reviewer_prompt",
    "Review base"
  );
  assert.ok(result.includes("Review base"));
  assert.ok(result.includes("Review guidelines"));
});

// ── loadAnchorConfig via parseConfig ──

// We can't directly import parseConfig (it's not exported). Test via loadAnchorConfig
// with a custom config path.

test("loadAnchorConfig parses single-line values", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, [
    "agent: codex",
    "agent_retry_max: 5",
    "agent_retry_backoff_ms: 2000",
    ""
  ].join("\n"));

  // Test parseConfig indirectly through a custom env.
  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.ANCHOR_CONFIG_PATH = configPath;
  try {
    const config = await loadAnchorConfig();
    assert.equal(config.agent, "codex");
    assert.equal(config.agent_retry_max, 5);
    assert.equal(config.agent_retry_backoff_ms, 2000);
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig parses boolean values", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, [
    "agent: codex",
    "agent_allow_network: true",
    ""
  ].join("\n"));

  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.ANCHOR_CONFIG_PATH = configPath;
  try {
    const config = await loadAnchorConfig();
    assert.equal(config.agent_allow_network, true);
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig returns undefined for missing optional fields", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, [
    "agent: codex",
    ""
  ].join("\n"));

  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.ANCHOR_CONFIG_PATH = configPath;
  try {
    const config = await loadAnchorConfig();
    assert.equal(config.agent, "codex");
    assert.equal(config.agent_retry_max, undefined);
    assert.ok(config.prompt);
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig parses multi-line values", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, [
    "agent: codex",
    "prompt: |",
    "  Line one",
    "  Line two",
    "  Line three",
    ""
  ].join("\n"));

  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.ANCHOR_CONFIG_PATH = configPath;
  try {
    const config = await loadAnchorConfig();
    assert.equal(config.prompt, "Line one\nLine two\nLine three");
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig parses folded scalar values", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, [
    "agent: codex",
    "prompt: >",
    "  Line one",
    "  Line two",
    ""
  ].join("\n"));

  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.ANCHOR_CONFIG_PATH = configPath;
  try {
    const config = await loadAnchorConfig();
    // Folded scalars: lines joined by spaces
    assert.ok(config.prompt?.includes("Line one"));
    assert.ok(config.prompt?.includes("Line two"));
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig ignores comments", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, [
    "# This is a comment",
    "agent: codex",
    "# Another comment",
    "  # indented comment",
    "agent_retry_max: 10",
    ""
  ].join("\n"));

  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.ANCHOR_CONFIG_PATH = configPath;
  try {
    const config = await loadAnchorConfig();
    assert.equal(config.agent, "codex");
    assert.equal(config.agent_retry_max, 10);
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig handles empty config", async () => {
  const dir = await tempDir();
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, "");

  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.ANCHOR_CONFIG_PATH = configPath;
  try {
    const config = await loadAnchorConfig();
    assert.equal(config.agent, "codex");
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig auto-creates global config when missing", async () => {
  const dir = await tempDir();
  const origHome = process.env.HOME;
  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  process.env.HOME = dir;
  delete process.env.ANCHOR_CONFIG_PATH;

  try {
    const config = await loadAnchorConfig();
    assert.equal(config.agent, "codex");
    assert.equal(await exists(path.join(dir, ".anchor", "config.yaml")), true);
  } finally {
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadAnchorConfig merges defaults, global config, repo config, and explicit config", async () => {
  const dir = await tempDir();
  const repo = path.join(dir, "repo");
  const repoAnchor = path.join(repo, ".anchor");
  const explicitPath = path.join(dir, "explicit.yaml");
  const origHome = process.env.HOME;
  const origConfigPath = process.env.ANCHOR_CONFIG_PATH;
  const origCwd = process.cwd();

  await mkdir(repoAnchor, { recursive: true });
  await mkdir(path.join(dir, ".anchor"), { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  await writeFile(path.join(dir, ".anchor", "config.yaml"), [
    "agent: global-agent",
    "planner_prompt: global planner",
    "generator_prompt: global generator",
    "agent_retry_max: 2",
    ""
  ].join("\n"));
  await writeFile(path.join(repoAnchor, "config.yaml"), [
    "agent: repo-agent",
    "generator_prompt: repo generator",
    "evaluator_prompt: repo evaluator",
    ""
  ].join("\n"));
  await writeFile(explicitPath, [
    "agent_allow_network: true",
    "evaluator_prompt: explicit evaluator",
    ""
  ].join("\n"));

  process.env.HOME = dir;
  process.env.ANCHOR_CONFIG_PATH = explicitPath;
  process.chdir(repo);

  try {
    const config = await loadAnchorConfig();
    assert.equal(config.agent, "repo-agent");
    assert.equal(config.planner_prompt, "global planner");
    assert.equal(config.generator_prompt, "repo generator");
    assert.equal(config.evaluator_prompt, "explicit evaluator");
    assert.equal(config.agent_retry_max, 2);
    assert.equal(config.agent_allow_network, true);
    assert.ok(config.prompt);
  } finally {
    process.chdir(origCwd);
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
