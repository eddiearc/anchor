import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export type AnchorAgent = "codex" | string;

export type AnchorConfig = {
  agent?: AnchorAgent;
  prompt?: string;
  planner_prompt?: string;
  reviewer_prompt?: string;
  generator_prompt?: string;
  evaluator_prompt?: string;
  agent_retry_max?: number;
  agent_retry_backoff_ms?: number;
  agent_allow_network?: boolean;
};

const execFileAsync = promisify(execFile);

function templatePath(): string {
  // From dist/core/config.js → repo root
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, "..", "..", "config.default.yaml");
}

async function readDefaultConfigContent(): Promise<string> {
  try {
    return await readFile(templatePath(), "utf8");
  } catch {
    // Fallback: minimal embedded config if template file is missing
    return [
      "# Anchor global configuration",
      "# ~/.anchor/config.yaml",
      "",
      "agent: codex",
      "",
      "prompt: |",
      "  I am a full-stack TypeScript engineer inside Anchor, a contract-driven",
      "  multi-role coding harness. Roles run in isolated contexts and communicate",
      "  only through structured contracts.",
      ""
    ].join("\n");
  }
}

export async function loadAnchorConfig(): Promise<AnchorConfig> {
  const defaultContent = await readDefaultConfigContent();
  const configs: AnchorConfig[] = [parseConfig(defaultContent)];

  const globalPath = globalConfigPath();
  configs.push(parseConfig(await readOrCreateConfig(globalPath, defaultContent)));

  const repoPath = await repoConfigPath();
  if (repoPath && await exists(repoPath)) {
    configs.push(parseConfig(await readFile(repoPath, "utf8")));
  }

  const explicitPath = process.env.ANCHOR_CONFIG_PATH;
  if (explicitPath) {
    configs.push(parseConfig(await readOrCreateConfig(explicitPath, defaultContent)));
  }

  return mergeConfigs(configs);
}

function globalConfigPath(): string {
  return path.join(homedir(), ".anchor", "config.yaml");
}

async function repoConfigPath(): Promise<string | undefined> {
  const git = await gitRoot();
  if (!git) return undefined;
  return path.join(git, ".anchor", "config.yaml");
}

async function gitRoot(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function readOrCreateConfig(configPath: string, defaultContent: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, defaultContent);
      return defaultContent;
    }
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function mergeConfigs(configs: AnchorConfig[]): AnchorConfig {
  return configs.reduce<AnchorConfig>((merged, config) => {
    return {
      ...merged,
      ...definedEntries(config)
    };
  }, {});
}

function definedEntries(config: AnchorConfig): AnchorConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined)
  ) as AnchorConfig;
}

export function composePrompt(config: AnchorConfig | undefined, roleKey: keyof AnchorConfig, base: string): string {
  const blocks: string[] = [base];
  if (config?.prompt) blocks.push("", "---", "", config.prompt);
  // roleKey is e.g. 'generator_prompt' — map to config field
  const rolePrompt = config?.[roleKey];
  if (typeof rolePrompt === "string" && rolePrompt) blocks.push("", "---", "", rolePrompt);
  return blocks.join("\n");
}

function parseConfig(raw: string): AnchorConfig {
  const config: Record<string, string> = {};
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const match = /^(\w[\w_]*):\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    let value = match[2].trim();

    // Multi-line string (| indicator or empty value with indented continuation)
    if (value === "|" || value === ">" || (value === "" && i + 1 < lines.length && isIndented(lines[i + 1]))) {
      if (value === "|" || value === ">") {
        i++; // skip the indicator line
        // Skip empty line after | if present (chomping indicator)
        while (i < lines.length && lines[i].trim() === "") i++;
      } else {
        i++; // value was empty, move to next line which should be indented
      }

      const indent = lines[i] ? (lines[i].match(/^(\s*)/)?.[0].length ?? 2) : 2;
      const valueLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim() === "") {
          valueLines.push("");
          i++;
          // Empty line inside a block doesn't break it if next line is still indented
          continue;
        }
        const nextIndent = nextLine.match(/^(\s*)/)?.[0].length ?? 0;
        if (nextIndent < indent && nextLine.trim() !== "") break;
        valueLines.push(nextLine.slice(indent));
        i++;
      }
      value = valueLines.join("\n").trimEnd();
    } else {
      i++; // advance past single-line value
    }

    config[key] = value;
  }

  return {
    agent: config.agent as AnchorConfig["agent"],
    prompt: config.prompt,
    planner_prompt: config.planner_prompt,
    reviewer_prompt: config.reviewer_prompt,
    generator_prompt: config.generator_prompt,
    evaluator_prompt: config.evaluator_prompt,
    agent_retry_max: parseOptionalInt(config.agent_retry_max),
    agent_retry_backoff_ms: parseOptionalInt(config.agent_retry_backoff_ms),
    agent_allow_network: parseOptionalBool(config.agent_allow_network)
  };
}

function isIndented(line: string): boolean {
  return (line.match(/^(\s+)/)?.[0].length ?? 0) > 0 && line.trim().length > 0;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseOptionalBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === "true" || lower === "yes") return true;
  if (lower === "false" || lower === "no") return false;
  return undefined;
}
