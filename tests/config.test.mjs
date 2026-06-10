import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Import from dist after build
import { composePrompt, loadAnchorConfig } from "../dist/index.js";

async function tempDir(prefix = "anchor-config-") {
  return await mkdtemp(path.join(homedir(), ".anchor-test-"));
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

  // Note: loadAnchorConfig uses ANCHOR_CONFIG_PATH env var or ~/.anchor/config.yaml
  // We test parseConfig indirectly through a custom env
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
    assert.equal(config.prompt, undefined);
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
    assert.equal(config.agent, undefined);
  } finally {
    if (origConfigPath) process.env.ANCHOR_CONFIG_PATH = origConfigPath;
    else delete process.env.ANCHOR_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
