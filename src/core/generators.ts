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
  buildPiArgv,
  codexCommand,
  piCommand,
  isCommandUnavailable,
  summarizeOutput,
  redactCodexArgv
} from "./agent-runner.js";
import { composePrompt, type AnchorConfig } from "./config.js";
import { contractPathForTask } from "./contracts.js";

const execFileAsync = promisify(execFile);

export type GeneratorAdapter = "fixture" | "codex" | "pi";
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
    | "CODEX_NO_CHANGES"
    | "PI_CLI_UNAVAILABLE"
    | "PI_COMMAND_FAILED"
    | "PI_NO_CHANGES";
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
  contractPath?: string;
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

export function validateGeneratorProvider(
  providerId: string,
  runner: CommandRunner = defaultCommandRunner
): { ok: true } | GeneratorError {
  const provider = resolveProvider(generatorProviders(runner), providerId, "generator");
  if ("ok" in provider) return generatorProviderError(provider);
  return { ok: true };
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
    },
    {
      id: "pi",
      roles: ["generator"],
      run: (input) => runPiGenerator(input, runner)
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
  const prompt = buildGeneratorPrompt(input);
  const allowNetwork = input.allowNetwork === true || input.config?.agent_allow_network === true;
  return runCommandGenerator(input, runner, {
    provider: "codex",
    label: "Codex",
    command: codexCommand(),
    argv: buildCodexArgv(input.workspace.worktreePath, prompt, allowNetwork),
    prompt,
    timeoutMs: providerTimeoutMs("CODEX"),
    unavailableCode: "CODEX_CLI_UNAVAILABLE",
    commandFailedCode: "CODEX_COMMAND_FAILED",
    noChangesCode: "CODEX_NO_CHANGES"
  });
}

async function runPiGenerator(
  input: RunGeneratorInput,
  runner: CommandRunner
): Promise<GeneratorOk | GeneratorError> {
  const prompt = buildGeneratorPrompt(input);
  const allowNetwork = input.allowNetwork === true || input.config?.agent_allow_network === true;
  return runCommandGenerator(input, runner, {
    provider: "pi",
    label: "Pi",
    command: piCommand(),
    argv: buildPiArgv(input.workspace.worktreePath, prompt, allowNetwork),
    prompt,
    timeoutMs: providerTimeoutMs("PI"),
    unavailableCode: "PI_CLI_UNAVAILABLE",
    commandFailedCode: "PI_COMMAND_FAILED",
    noChangesCode: "PI_NO_CHANGES"
  });
}

type CommandGeneratorConfig = {
  provider: "codex" | "pi";
  label: "Codex" | "Pi";
  command: string;
  argv: string[];
  prompt: string;
  timeoutMs: number;
  unavailableCode: "CODEX_CLI_UNAVAILABLE" | "PI_CLI_UNAVAILABLE";
  commandFailedCode: "CODEX_COMMAND_FAILED" | "PI_COMMAND_FAILED";
  noChangesCode: "CODEX_NO_CHANGES" | "PI_NO_CHANGES";
};

async function runCommandGenerator(
  input: RunGeneratorInput,
  runner: CommandRunner,
  providerConfig: CommandGeneratorConfig
): Promise<GeneratorOk | GeneratorError> {
  const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
  if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
    return {
      ok: false,
      code: "WORKSPACE_UNAVAILABLE",
      message: "Workspace must exist, be a git worktree, and not be cleaned before generation."
    };
  }

  const envAllowlist = providerEnvAllowlist();
  const startedAt = new Date().toISOString();

  const retryConfig: RetryConfig = {
    maxRetries: input.config?.agent_retry_max ?? defaultRetryConfig.maxRetries,
    backoffMs: input.config?.agent_retry_backoff_ms ?? defaultRetryConfig.backoffMs
  };

  let result: CommandResult;
  try {
    result = await runAgent(providerConfig.command, providerConfig.argv, input.workspace.worktreePath, runner, retryConfig, {
      env: buildProviderEnvironment(envAllowlist),
      envAllowlist,
      timeoutMs: providerConfig.timeoutMs,
      prompt: providerConfig.prompt,
      contract: input.contract
    });
  } catch (error) {
    if (isCommandUnavailable(error)) {
      return {
        ok: false,
        code: providerConfig.unavailableCode,
        message: `${providerConfig.label} CLI command is unavailable: ${providerConfig.command}`,
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
    adapter: providerConfig.provider,
    provider: providerConfig.provider,
    taskId: input.taskId,
    attempt: input.attempt,
    startedAt,
    finishedAt,
    command: providerConfig.command,
    argv: redactCodexArgv(providerConfig.argv),
    exitCode: result.exitCode,
    stdoutSummary: summarizeOutput(result.stdout),
    stderrSummary: summarizeOutput(result.stderr),
    filesChanged: changedFiles,
    policyResult,
    commitSha: await currentHead(input.workspace.worktreePath),
    summary: commandGeneratorSummary(providerConfig.label, input.attempt, changedFiles, policyResult, result.exitCode)
  };
  const reportPath = await writeGeneratorReport(input.artifactsDir, input.taskId, report, input.reportPath);

  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: providerConfig.commandFailedCode,
      message: `${providerConfig.label} generator exited with code ${result.exitCode}.`,
      report,
      reportPath
    };
  }

  if (changedFiles.length === 0) {
    return {
      ok: false,
      code: providerConfig.noChangesCode,
      message: `${providerConfig.label} generator completed without producing worktree changes.`,
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
    `Approved contract path: ${input.contractPath ?? contractPathForTask(input.artifactsDir, input.taskId)}`,
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
    "- Implement only the approved contract and leave validation to Anchor.",
    "",
    "Report expectation:",
    "- Leave worktree changes in place for Anchor to inspect.",
    "- Do not write secrets, tokens, environment dumps, or credentials to files or output.",
    "- Summarize changed files and any verification you ran in normal stdout/stderr only."
  ].join("\n");

  return composePrompt(input.config, "generator_prompt", base);
}

function providerTimeoutMs(providerEnvPrefix: "CODEX" | "PI") {
  const raw = process.env[`ANCHOR_${providerEnvPrefix}_TIMEOUT_MS`];
  if (!raw) return 10 * 60 * 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

function providerEnvAllowlist() {
  return [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME"
  ];
}

function buildProviderEnvironment(allowlist: string[]) {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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

function commandGeneratorSummary(
  label: "Codex" | "Pi",
  attempt: number,
  changedFiles: string[],
  policyResult: PermissionResult,
  exitCode: number
): string {
  if (exitCode !== 0) {
    return `${label} generator failed for attempt ${attempt}.`;
  }
  if (changedFiles.length === 0) {
    return `${label} generator produced no worktree changes for attempt ${attempt}.`;
  }
  return policyResult.ok
    ? `${label} generator changed ${changedFiles.length} file(s) for attempt ${attempt}.`
    : `${label} generator produced policy-violating changes for attempt ${attempt}.`;
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
