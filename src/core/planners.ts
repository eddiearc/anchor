import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildCodexArgv,
  codexCommand,
  runAgent,
  type CommandRunner,
  type CommandResult,
  defaultCommandRunner,
  summarizeOutput,
  redactCodexArgv
} from "./agent-runner.js";
import { composePrompt, type AnchorConfig } from "./config.js";

// ── types ──

export type RunPlannerInput = {
  taskId: string;
  taskDescription: string;
  artifactsDir: string;
  adapter: string;
  repoPath: string;
  config?: AnchorConfig;
  mode?: "quick" | "standard" | "thorough";
};

export type PlannerOk = {
  ok: true;
  mode: "quick" | "standard" | "thorough";
  reasoning: string;
  affectedScope: string[];
  contractYaml: string;
};

export type PlannerError = {
  ok: false;
  code: string;
  message: string;
};

// ── dispatch ──

export async function runPlanner(
  input: RunPlannerInput,
  runner: CommandRunner = defaultCommandRunner
): Promise<PlannerOk | PlannerError> {
  if (input.adapter === "fixture") {
    return runFixturePlanner(input);
  }
  if (input.adapter === "codex") {
    return runCodexPlanner(input, runner);
  }
  return {
    ok: false,
    code: "UNSUPPORTED_ADAPTER",
    message: `Unsupported planner adapter: ${input.adapter}`
  };
}

// ── fixture ──

export async function runFixturePlanner(input: RunPlannerInput): Promise<PlannerOk | PlannerError> {
  const mode = input.mode ?? "standard";
  return {
    ok: true,
    mode,
    reasoning: `Deterministic fixture contract (${mode} mode).`,
    affectedScope: ["anchor-output/**", "src/**", "tests/**", "README.md", "package.json", "tsconfig*.json"],
    contractYaml: buildTemplateContract(input.taskDescription, input.taskId, mode)
  };
}

// ── codex ──

async function runCodexPlanner(
  input: RunPlannerInput,
  runner: CommandRunner
): Promise<PlannerOk | PlannerError> {
  const cmd = codexCommand();
  if (!cmd) {
    return {
      ok: false,
      code: "CODEX_CLI_UNAVAILABLE",
      message: "Codex CLI not found. Install with: npm install -g @openai/codex"
    };
  }

  const planDir = path.join(input.artifactsDir, input.taskId, "plan");
  await mkdir(planDir, { recursive: true });
  const contractPath = path.join(planDir, "contract.yaml");

  const prompt = buildPlannerPrompt(input, contractPath);
  const argv = buildCodexArgv(input.repoPath, prompt);

  const result: CommandResult = await runAgent(cmd, argv, input.repoPath, runner);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "CODEX_COMMAND_FAILED",
      message: `Codex planner failed (exit ${result.exitCode}): ${summarizeOutput(result.stderr) || summarizeOutput(result.stdout)}`
    };
  }

  // Parse Codex output — expect YAML with mode, reasoning, affected_scope, contract
  try {
    const contractYaml = await readFile(contractPath, "utf8");
    const parsed = parsePlannerOutput(contractYaml);
    if (!parsed) {
      return {
        ok: false,
        code: "CODEX_INVALID_OUTPUT",
        message: `Codex planner output missing required fields. Expected mode, reasoning, and contract YAML in ${contractPath}`
      };
    }
    return { ok: true, ...parsed };
  } catch {
    // If no contract file, try to parse from stdout
    const parsed = parsePlannerOutput(result.stdout);
    if (parsed) {
      // Also write it for record
      await writeFile(contractPath, parsed.contractYaml, "utf8");
      return { ok: true, ...parsed };
    }
    return {
      ok: false,
      code: "CODEX_NO_OUTPUT",
      message: `Codex planner produced no parseable contract output. stdout: ${summarizeOutput(result.stdout)}`
    };
  }
}

// ── prompt ──

function buildPlannerPrompt(input: RunPlannerInput, contractPath: string): string {
  const base = [
    "You are the Planner role inside Anchor, a contract-driven coding harness.",
    "Your job: analyze the task, explore the codebase, and produce a structured contract.",
    "",
    "TASK:",
    input.taskDescription,
    "",
    "OUTPUT INSTRUCTIONS:",
    `1. Explore the codebase to understand scope, existing patterns, and affected files.`,
    `2. Determine execution mode:`,
    `   - quick: trivial single-file change (rename, CSS, typo, dependency bump)`,
    `   - standard: feature, refactor, new endpoint (default)`,
    `   - thorough: cross-domain, auth, data migration, payment, security`,
    `3. Write the complete contract to: ${contractPath}`,
    "",
    "The contract file must contain:",
    "```yaml",
    "mode: quick|standard|thorough",
    "reasoning: <why this mode, what scope was analyzed>",
    "affected_scope:",
    "  - src/path/**",
    "  - tests/path/**",
    "",
    "contract:",
    "  id: <task-id>",
    "  goal:",
    "    summary: <1-2 sentences>",
    "  files:",
    "    allowlist:",
    "      - src/...",
    "    denylist:",
    "      - src/...",
    "  constraints:",
    "    - <concrete invariant>",
    "  steps:",
    "    - id: '1'",
    "      description: <what to do>",
    "      acceptance:",
    "        - <testable criterion>",
    "  completion_gate:",
    "    type: all",
    "    conditions:",
    "      - <condition>",
    "```",
    "",
    "After writing the contract, output a brief summary of your mode decision and affected scope.",
    "",
    "CRITICAL:",
    "- Mode must be quick, standard, or thorough (exactly).",
    "- Every acceptance criterion must be mechanically verifiable.",
    "- Do NOT write implementation code. You are the architect."
  ].join("\n");

  return composePrompt(input.config, "planner_prompt", base);
}

// ── parse ──

function parsePlannerOutput(yaml: string): { mode: "quick" | "standard" | "thorough"; reasoning: string; affectedScope: string[]; contractYaml: string } | null {
  const modeMatch = yaml.match(/^mode:\s*(quick|standard|thorough)\s*$/m);
  const reasoningMatch = yaml.match(/^reasoning:\s*(.+)$/m);
  if (!modeMatch) return null;

  const mode = modeMatch[1] as "quick" | "standard" | "thorough";
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : "No reasoning provided.";

  // Extract affected_scope lines
  const scopeSection = yaml.match(/^affected_scope:\s*\n((?:\s*-\s*.+\n?)*)/m);
  const affectedScope: string[] = [];
  if (scopeSection) {
    for (const line of scopeSection[1].split("\n")) {
      const m = line.match(/^\s*-\s*(.+)/);
      if (m) affectedScope.push(m[1].trim());
    }
  }
  if (affectedScope.length === 0) {
    affectedScope.push("src/**", "tests/**");
  }

  return { mode, reasoning, affectedScope, contractYaml: yaml };
}

// ── template contract (for fixture fallback) ──

function buildTemplateContract(taskDescription: string, taskId: string, mode: "quick" | "standard" | "thorough" = "standard"): string {
  return [
    `mode: ${mode}`,
    `reasoning: Deterministic fixture contract.`,
    `affected_scope:`,
    `  - src/**`,
    `  - tests/**`,
    `  - README.md`,
    `  - package.json`,
    `  - tsconfig*.json`,
    ``,
    `contract:`,
    `  id: "${taskId}"`,
    `  goal:`,
    `    summary: "${taskDescription.replace(/"/g, '\\"')}"`,
    `  files:`,
    `    allowlist:`,
    `      - anchor-output/**`,
    `      - src/**`,
    `      - tests/**`,
    `    denylist:`,
    `      - .env*`,
    `      - secrets/**`,
    `      - node_modules/**`,
    `      - dist/**`,
    `      - .git/**`,
    `  constraints:`,
    `    - Must maintain backward compatibility`,
    `    - All existing tests must pass`,
    `  steps:`,
    `    - id: "1"`,
    `      description: "Implement the requested change"`,
    `      acceptance:`,
    `        - "All existing tests pass"`,
    `        - "TypeScript compilation succeeds with --strict"`,
    `  completion_gate:`,
    `    type: all`,
    `    conditions:`,
    `      - "All acceptance criteria pass"`,
    `      - "TypeScript compilation succeeds"`,
    `      - "All existing tests pass"`
  ].join("\n");
}
