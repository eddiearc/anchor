import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateWorkspacePolicy, type PermissionResult } from "./permissions.js";
import { resolveProvider, type ProviderDefinition, type ProviderError } from "./providers.js";
import { getWorkspaceGitStatus, type WorkspaceMetadata } from "./workspaces.js";
import {
  type CommandRunner,
  type CommandResult,
  type RetryConfig,
  defaultCommandRunner,
  defaultRetryConfig,
  runAgent,
  buildCodexArgv,
  codexCommand,
  isCommandUnavailable,
  summarizeOutput,
  redactCodexArgv
} from "./agent-runner.js";
import { composePrompt, type AnchorConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type GeneratorAdapter = "fixture" | "codex";
export type FixtureVariant = "allowed" | "outside";

export type GeneratorReport = {
  adapter: GeneratorAdapter;
  provider: GeneratorAdapter;
  fixture?: FixtureVariant;
  taskId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  command?: string;
  argv?: string[];
  exitCode?: number | null;
  stdoutSummary?: string;
  stderrSummary?: string;
  filesChanged: string[];
  policyResult: PermissionResult;
  commitSha: string | null;
  summary: string;
};

export type GeneratorOk = {
  ok: true;
  report: GeneratorReport;
  reportPath: string;
  filesChanged: string[];
};

export type GeneratorError = {
  ok: false;
  code:
    | "UNSUPPORTED_ADAPTER"
    | "UNKNOWN_PROVIDER"
    | "UNSUPPORTED_PROVIDER_ROLE"
    | "WORKSPACE_UNAVAILABLE"
    | "POLICY_VIOLATION"
    | "GIT_COMMAND_FAILED"
    | "CODEX_CLI_UNAVAILABLE"
    | "CODEX_COMMAND_FAILED"
    | "CODEX_NO_CHANGES";
  message: string;
  report?: GeneratorReport;
  reportPath?: string;
  detail?: string;
};

export type RunGeneratorInput = {
  taskId: string;
  artifactsDir: string;
  workspace: WorkspaceMetadata;
  contract: string;
  adapter: string;
  fixture?: string;
  attempt: number;
  reportPath?: string;
  config?: AnchorConfig;
  allowNetwork?: boolean;
};

export async function runGenerator(
  input: RunGeneratorInput,
  runner: CommandRunner = defaultCommandRunner
): Promise<GeneratorOk | GeneratorError> {
  const provider = resolveProvider(generatorProviders(runner), input.adapter, "generator");
  if ("ok" in provider) return generatorProviderError(provider);
  return provider.run(input);
}

function generatorProviders(runner: CommandRunner): Array<ProviderDefinition<RunGeneratorInput, GeneratorOk | GeneratorError>> {
  return [
    {
      id: "fixture",
      roles: ["generator"],
      run: (input) => runFixtureGenerator(input)
    },
    {
      id: "codex",
      roles: ["generator"],
      run: (input) => runCodexGenerator(input, runner)
    }
  ];
}

function generatorProviderError(error: ProviderError): GeneratorError {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    detail: JSON.stringify({ provider: error.provider, role: error.role, availableProviders: error.availableProviders })
  };
}

export async function runFixtureGenerator(input: RunGeneratorInput): Promise<GeneratorOk | GeneratorError> {
  if (input.adapter !== "fixture") {
    return {
      ok: false,
      code: "UNSUPPORTED_ADAPTER",
      message: `Unsupported generator adapter: ${input.adapter}`
    };
  }

  const fixture = readFixtureVariant(input.fixture);
  const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
  if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
    return {
      ok: false,
      code: "WORKSPACE_UNAVAILABLE",
      message: "Workspace must exist, be a git worktree, and not be cleaned before generation."
    };
  }

  const startedAt = new Date().toISOString();
  await writeFixtureOutput(input.workspace.worktreePath, input.taskId, fixture);
  const changedFiles = (await getWorkspaceGitStatus(input.workspace.worktreePath)).changedFiles;
  const contractPolicy = readContractPolicy(input.contract);
  const policyResult = validateWorkspacePolicy({
    role: "generator",
    changedFiles,
    allowlist: contractPolicy.allowlist,
    denylist: contractPolicy.denylist
  });
  const finishedAt = new Date().toISOString();
  const report: GeneratorReport = {
    adapter: "fixture",
    provider: "fixture",
    fixture,
    taskId: input.taskId,
    attempt: input.attempt,
    startedAt,
    finishedAt,
    filesChanged: changedFiles,
    policyResult,
    commitSha: await currentHead(input.workspace.worktreePath),
    summary:
      policyResult.ok
        ? `Fixture generator wrote ${changedFiles.length} changed file(s) for attempt ${input.attempt}.`
        : `Fixture generator produced policy-violating changes for attempt ${input.attempt}.`
  };
  const reportPath = await writeGeneratorReport(input.artifactsDir, input.taskId, report, input.reportPath);

  if (!policyResult.ok) {
    return {
      ok: false,
      code: "POLICY_VIOLATION",
      message: policyResult.message,
      report,
      reportPath
    };
  }

  return {
    ok: true,
    report,
    reportPath,
    filesChanged: changedFiles
  };
}

async function runCodexGenerator(
  input: RunGeneratorInput,
  runner: CommandRunner
): Promise<GeneratorOk | GeneratorError> {
  const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
  if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
    return {
      ok: false,
      code: "WORKSPACE_UNAVAILABLE",
      message: "Workspace must exist, be a git worktree, and not be cleaned before generation."
    };
  }

  const command = codexCommand();
  const prompt = buildGeneratorPrompt(input);
  const allowNetwork = input.config?.agent_allow_network === true;
  const argv = buildCodexArgv(input.workspace.worktreePath, prompt, allowNetwork);
  const startedAt = new Date().toISOString();

  const retryConfig: RetryConfig = {
    maxRetries: input.config?.agent_retry_max ?? defaultRetryConfig.maxRetries,
    backoffMs: input.config?.agent_retry_backoff_ms ?? defaultRetryConfig.backoffMs
  };

  let result: CommandResult;
  try {
    result = await runAgent(command, argv, input.workspace.worktreePath, runner, retryConfig);
  } catch (error) {
    if (isCommandUnavailable(error)) {
      return {
        ok: false,
        code: "CODEX_CLI_UNAVAILABLE",
        message: `Codex CLI command is unavailable: ${command}`,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
    throw error;
  }

  const changedFiles = (await getWorkspaceGitStatus(input.workspace.worktreePath)).changedFiles;
  const contractPolicy = readContractPolicy(input.contract);
  const policyResult = validateWorkspacePolicy({
    role: "generator",
    changedFiles,
    allowlist: contractPolicy.allowlist,
    denylist: contractPolicy.denylist
  });
  const finishedAt = new Date().toISOString();
  const report: GeneratorReport = {
    adapter: "codex",
    provider: "codex",
    taskId: input.taskId,
    attempt: input.attempt,
    startedAt,
    finishedAt,
    command,
    argv: redactCodexArgv(argv),
    exitCode: result.exitCode,
    stdoutSummary: summarizeOutput(result.stdout),
    stderrSummary: summarizeOutput(result.stderr),
    filesChanged: changedFiles,
    policyResult,
    commitSha: await currentHead(input.workspace.worktreePath),
    summary: codexSummary(input.attempt, changedFiles, policyResult, result.exitCode)
  };
  const reportPath = await writeGeneratorReport(input.artifactsDir, input.taskId, report, input.reportPath);

  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "CODEX_COMMAND_FAILED",
      message: `Codex generator exited with code ${result.exitCode}.`,
      report,
      reportPath
    };
  }

  if (changedFiles.length === 0) {
    return {
      ok: false,
      code: "CODEX_NO_CHANGES",
      message: "Codex generator completed without producing worktree changes.",
      report,
      reportPath
    };
  }

  if (!policyResult.ok) {
    return {
      ok: false,
      code: "POLICY_VIOLATION",
      message: policyResult.message,
      report,
      reportPath
    };
  }

  return {
    ok: true,
    report,
    reportPath,
    filesChanged: changedFiles
  };
}

function buildGeneratorPrompt(input: RunGeneratorInput): string {
  const policy = readContractPolicy(input.contract);
  const base = [
    "You are the Generator role inside Anchor.",
    `Task ID: ${input.taskId}`,
    `Worktree path: ${input.workspace.worktreePath}`,
    "",
    "Approved contract:",
    input.contract,
    "",
    "Execution rules:",
    "- Modify files only inside the provided worktree.",
    `- Stay inside allowed scope: ${policy.allowlist.join(", ") || "(none specified)"}.`,
    `- Do not change denied paths: ${policy.denylist.join(", ") || "(none specified)"}.`,
    "- Do not read, write, print, or persist secrets or authentication tokens.",
    "- Do not perform network operations or install dependencies.",
    "- Do not approve, evaluate, merge, commit, or push.",
    "- Implement only the approved contract and leave validation to Anchor."
  ].join("\n");

  return composePrompt(input.config, "generator_prompt", base);
}

async function writeCodexFailureReport(params: {
  input: RunGeneratorInput;
  command: string;
  argv: string[];
  startedAt: string;
  finishedAt: string;
  result: CommandResult;
  code: "CODEX_COMMAND_FAILED";
  message: string;
}): Promise<GeneratorError> {
  const status = await getWorkspaceGitStatus(params.input.workspace.worktreePath);
  const report: GeneratorReport = {
    adapter: "codex",
    provider: "codex",
    taskId: params.input.taskId,
    attempt: params.input.attempt,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    command: params.command,
    argv: redactCodexArgv(params.argv),
    exitCode: params.result.exitCode,
    stdoutSummary: summarizeOutput(params.result.stdout),
    stderrSummary: summarizeOutput(params.result.stderr),
    filesChanged: status.changedFiles,
    policyResult: { ok: true },
    commitSha: await currentHead(params.input.workspace.worktreePath),
    summary: params.message
  };
  const reportPath = await writeGeneratorReport(params.input.artifactsDir, params.input.taskId, report, params.input.reportPath);
  return {
    ok: false,
    code: params.code,
    message: params.message,
    report,
    reportPath
  };
}

export async function writeGeneratorReport(
  artifactsDir: string,
  taskId: string,
  report: GeneratorReport,
  targetPath?: string
) {
  const reportPath = targetPath ?? generatorReportPath(artifactsDir, taskId);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

export function generatorReportPath(artifactsDir: string, taskId: string) {
  return path.join(artifactsDir, taskId, "generator-report.json");
}

export function generatorAttemptReportPath(artifactsDir: string, taskId: string, attempt: number) {
  return path.join(artifactsDir, taskId, "attempts", String(attempt), "generator-report.json");
}

export function readContractPolicy(contract: string) {
  return {
    allowlist: readYamlList(contract, "allowlist"),
    denylist: readYamlList(contract, "denylist")
  };
}

async function writeFixtureOutput(worktreePath: string, taskId: string, fixture: FixtureVariant) {
  const relativePath =
    fixture === "allowed"
      ? path.join("anchor-output", `${taskId}.txt`)
      : path.join("outside-output", `${taskId}.txt`);
  const outputPath = path.join(worktreePath, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, [`taskId=${taskId}`, `fixture=${fixture}`, "adapter=fixture", ""].join("\n"));
}

function codexSummary(
  attempt: number,
  changedFiles: string[],
  policyResult: PermissionResult,
  exitCode: number
): string {
  if (exitCode !== 0) {
    return `Codex generator failed for attempt ${attempt}.`;
  }
  if (changedFiles.length === 0) {
    return `Codex generator produced no worktree changes for attempt ${attempt}.`;
  }
  return policyResult.ok
    ? `Codex generator changed ${changedFiles.length} file(s) for attempt ${attempt}.`
    : `Codex generator produced policy-violating changes for attempt ${attempt}.`;
}

async function currentHead(worktreePath: string) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      encoding: "utf8"
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function readFixtureVariant(fixture: string | undefined): FixtureVariant {
  return fixture === "outside" ? "outside" : "allowed";
}

function readYamlList(contract: string, key: "allowlist" | "denylist"): string[] {
  const lines = contract.split("\n");
  const keyLine = lines.findIndex((line) => line.trim() === `${key}:`);
  if (keyLine === -1) return [];

  const keyIndent = indentOf(lines[keyLine]);
  const values: string[] = [];
  for (const line of lines.slice(keyLine + 1)) {
    if (line.trim() && indentOf(line) <= keyIndent) break;
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) values.push(unquote(match[1]));
  }
  return values;
}

function indentOf(line: string) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function unquote(value: string) {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, "");
  }
}
