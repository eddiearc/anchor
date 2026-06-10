import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateWorkspacePolicy, type PermissionResult } from "./permissions.js";
import { getWorkspaceGitStatus, type WorkspaceMetadata } from "./workspaces.js";

const execFileAsync = promisify(execFile);

export type GeneratorAdapter = "fixture" | "codex";
export type FixtureVariant = "allowed" | "outside";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export type GeneratorReport = {
  adapter: GeneratorAdapter;
  fixture?: FixtureVariant;
  runId: string;
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
  runId: string;
  runsDir: string;
  workspace: WorkspaceMetadata;
  contract: string;
  adapter: string;
  fixture?: string;
  attempt: number;
  reportPath?: string;
};

export async function runGenerator(input: RunGeneratorInput, runner: CommandRunner = defaultCommandRunner): Promise<GeneratorOk | GeneratorError> {
  if (input.adapter === "fixture") {
    return runFixtureGenerator(input);
  }
  if (input.adapter === "codex") {
    return runCodexGenerator(input, runner);
  }
  return {
    ok: false,
    code: "UNSUPPORTED_ADAPTER",
    message: `Unsupported generator adapter: ${input.adapter}`
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
  await writeFixtureOutput(input.workspace.worktreePath, input.runId, fixture);
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
    fixture,
    runId: input.runId,
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
  const reportPath = await writeGeneratorReport(input.runsDir, input.runId, report, input.reportPath);

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

async function runCodexGenerator(input: RunGeneratorInput, runner: CommandRunner): Promise<GeneratorOk | GeneratorError> {
  const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
  if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
    return {
      ok: false,
      code: "WORKSPACE_UNAVAILABLE",
      message: "Workspace must exist, be a git worktree, and not be cleaned before generation."
    };
  }

  const command = process.env.ANCHOR_CODEX_COMMAND ?? "codex";
  const argv = readCodexArgv(input);
  const startedAt = new Date().toISOString();
  let result: CommandResult;
  try {
    result = await runner(command, argv, { cwd: input.workspace.worktreePath });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (isCommandUnavailable(error)) {
      return {
        ok: false,
        code: "CODEX_CLI_UNAVAILABLE",
        message: `Codex CLI command is unavailable: ${command}`,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
    result = {
      exitCode: readExitCode(error),
      stdout: readProcessOutput(error, "stdout"),
      stderr: readProcessOutput(error, "stderr") || (error instanceof Error ? error.message : String(error))
    };
    return writeCodexFailureReport({
      input,
      command,
      argv,
      startedAt,
      finishedAt,
      result,
      code: "CODEX_COMMAND_FAILED",
      message: `Codex generator exited with code ${result.exitCode}.`
    });
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
    runId: input.runId,
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
  const reportPath = await writeGeneratorReport(input.runsDir, input.runId, report, input.reportPath);

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

async function writeCodexFailureReport(input: {
  input: RunGeneratorInput;
  command: string;
  argv: string[];
  startedAt: string;
  finishedAt: string;
  result: CommandResult;
  code: "CODEX_COMMAND_FAILED";
  message: string;
}): Promise<GeneratorError> {
  const status = await getWorkspaceGitStatus(input.input.workspace.worktreePath);
  const report: GeneratorReport = {
    adapter: "codex",
    runId: input.input.runId,
    attempt: input.input.attempt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    command: input.command,
    argv: redactCodexArgv(input.argv),
    exitCode: input.result.exitCode,
    stdoutSummary: summarizeOutput(input.result.stdout),
    stderrSummary: summarizeOutput(input.result.stderr),
    filesChanged: status.changedFiles,
    policyResult: { ok: true },
    commitSha: await currentHead(input.input.workspace.worktreePath),
    summary: input.message
  };
  const reportPath = await writeGeneratorReport(input.input.runsDir, input.input.runId, report, input.input.reportPath);
  return {
    ok: false,
    code: input.code,
    message: input.message,
    report,
    reportPath
  };
}

export async function writeGeneratorReport(runsDir: string, runId: string, report: GeneratorReport, targetPath?: string) {
  const reportPath = targetPath ?? generatorReportPath(runsDir, runId);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

export function generatorReportPath(runsDir: string, runId: string) {
  return path.join(runsDir, runId, "generator-report.json");
}

export function generatorAttemptReportPath(runsDir: string, runId: string, attempt: number) {
  return path.join(runsDir, runId, "attempts", String(attempt), "generator-report.json");
}

export function readContractPolicy(contract: string) {
  return {
    allowlist: readYamlList(contract, "allowlist"),
    denylist: readYamlList(contract, "denylist")
  };
}

async function writeFixtureOutput(worktreePath: string, runId: string, fixture: FixtureVariant) {
  const relativePath = fixture === "allowed" ? path.join("anchor-output", `${runId}.txt`) : path.join("outside-output", `${runId}.txt`);
  const outputPath = path.join(worktreePath, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, [`runId=${runId}`, `fixture=${fixture}`, "adapter=fixture", ""].join("\n"));
}

async function defaultCommandRunner(command: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return { exitCode: 0, stdout, stderr };
}

function readCodexArgv(input: RunGeneratorInput) {
  const customArgv = process.env.ANCHOR_CODEX_ARGV_JSON;
  if (customArgv) {
    const parsed = JSON.parse(customArgv);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("ANCHOR_CODEX_ARGV_JSON must be a JSON string array.");
    }
    return [...parsed, buildCodexPrompt(input)];
  }
  return [
    "exec",
    "--cd",
    input.workspace.worktreePath,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    buildCodexPrompt(input)
  ];
}

function buildCodexPrompt(input: RunGeneratorInput) {
  const policy = readContractPolicy(input.contract);
  return [
    "You are the Generator role inside Anchor.",
    `Run ID: ${input.runId}`,
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
}

function redactCodexArgv(argv: string[]) {
  return argv.map((arg, index) => (index === argv.length - 1 ? "[prompt redacted]" : arg));
}

function summarizeOutput(output: string) {
  const normalized = output.trim().replace(/\s+/g, " ");
  return normalized.length > 1000 ? `${normalized.slice(0, 1000)}...` : normalized;
}

function codexSummary(attempt: number, changedFiles: string[], policyResult: PermissionResult, exitCode: number) {
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

function isCommandUnavailable(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (error as Record<string, unknown>).code === "ENOENT";
}

function readExitCode(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return 1;
}

function readProcessOutput(error: unknown, key: "stdout" | "stderr") {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return "";
}

async function currentHead(worktreePath: string) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

function readFixtureVariant(fixture: string | undefined): FixtureVariant {
  return fixture === "outside" ? "outside" : "allowed";
}

function readYamlList(contract: string, key: "allowlist" | "denylist") {
  const lines = contract.split("\n");
  const keyLine = lines.findIndex((line) => line.trim() === `${key}:`);
  if (keyLine === -1) {
    return [];
  }

  const keyIndent = indentOf(lines[keyLine]);
  const values: string[] = [];
  for (const line of lines.slice(keyLine + 1)) {
    if (line.trim() && indentOf(line) <= keyIndent) {
      break;
    }
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) {
      values.push(unquote(match[1]));
    }
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
