import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AnchorAgent = "codex" | string;

export type AnchorConfig = {
  agent?: AnchorAgent;
  prompt?: string;
  planner_prompt?: string;
  reviewer_prompt?: string;
  generator_prompt?: string;
  evaluator_prompt?: string;
};

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
  const configPath = configFilePath();
  try {
    const raw = await readFile(configPath, "utf8");
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const defaultContent = await readDefaultConfigContent();
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, defaultContent);
      return parseConfig(defaultContent);
    }
    throw error;
  }
}

function configFilePath(): string {
  return process.env.ANCHOR_CONFIG_PATH ?? path.join(homedir(), ".anchor", "config.yaml");
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
    }

    config[key] = value;
  }

  return {
    agent: config.agent as AnchorConfig["agent"],
    prompt: config.prompt,
    planner_prompt: config.planner_prompt,
    reviewer_prompt: config.reviewer_prompt,
    generator_prompt: config.generator_prompt,
    evaluator_prompt: config.evaluator_prompt
  };
}

function isIndented(line: string): boolean {
  return (line.match(/^(\s+)/)?.[0].length ?? 0) > 0 && line.trim().length > 0;
}
