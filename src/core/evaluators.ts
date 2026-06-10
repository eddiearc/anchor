import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkspaceGitStatus, type WorkspaceMetadata } from "./workspaces.js";
import { generatorReportPath } from "./generators.js";
import { type EvalVerdict } from "./state-machine.js";
import {
  type CommandRunner,
  type CommandResult,
  defaultCommandRunner,
  runAgent,
  buildCodexArgv,
  codexCommand,
  isCommandUnavailable,
  summarizeOutput,
  redactCodexArgv
} from "./agent-runner.js";

export type EvaluatorAdapter = "fixture" | "codex";

export type EvaluatorReport = {
  adapter: EvaluatorAdapter;
  verdict: EvalVerdict;
  taskId: string;
  attempt?: number;
  startedAt: string;
  finishedAt: string;
  testsRun: number;
  testsFailed: number;
  feedback: string;
  filesInspected: string[];
  generatorReportPath: string;
  summary: string;
  command?: string;
  argv?: string[];
  exitCode?: number | null;
  stdoutSummary?: string;
  stderrSummary?: string;
};

export type EvaluatorOk = {
  ok: true;
  report: EvaluatorReport;
  reportPath: string;
};

export type EvaluatorError = {
  ok: false;
  code:
    | "UNSUPPORTED_ADAPTER"
    | "INVALID_VERDICT"
    | "WORKSPACE_UNAVAILABLE"
    | "GENERATOR_REPORT_NOT_FOUND"
    | "CODEX_CLI_UNAVAILABLE"
    | "CODEX_COMMAND_FAILED"
    | "CODEX_NO_VERDICT";
  message: string;
  detail?: string;
  report?: EvaluatorReport;
  reportPath?: string;
};

export type RunEvaluatorInput = {
  taskId: string;
  artifactsDir: string;
  workspace: WorkspaceMetadata;
  contract: string;
  adapter: string;
  verdict?: string; // fixture-specific: forced verdict
  attempt?: number;
  generatorReportPath?: string;
  reportPath?: string;
};

export async function runEvaluator(
  input: RunEvaluatorInput,
  runner: CommandRunner = defaultCommandRunner
): Promise<EvaluatorOk | EvaluatorError> {
  if (input.adapter === "fixture") {
    return runFixtureEvaluator(input);
  }
  if (input.adapter === "codex") {
    return runCodexEvaluator(input, runner);
  }
  return {
    ok: false,
    code: "UNSUPPORTED_ADAPTER",
    message: `Unsupported evaluator adapter: ${input.adapter}`
  };
}

export async function runFixtureEvaluator(
  input: RunEvaluatorInput
): Promise<EvaluatorOk | EvaluatorError> {
  if (input.adapter !== "fixture") {
    return {
      ok: false,
      code: "UNSUPPORTED_ADAPTER",
      message: `Unsupported evaluator adapter: ${input.adapter}`
    };
  }

  const requestedVerdict = readFixtureVerdict(input.verdict);
  if (!requestedVerdict.ok) {
    return requestedVerdict;
  }

  const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
  if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
    return {
      ok: false,
      code: "WORKSPACE_UNAVAILABLE",
      message: "Workspace must exist, be a git worktree, and not be cleaned before evaluation."
    };
  }

  const generatorReport = input.generatorReportPath ?? generatorReportPath(input.artifactsDir, input.taskId);
  const generatorReportContent = await readOptional(generatorReport);
  if (generatorReportContent === null) {
    return {
      ok: false,
      code: "GENERATOR_REPORT_NOT_FOUND",
      message: `Generator report not found: ${generatorReport}`
    };
  }

  const startedAt = new Date().toISOString();
  const filesInspected = status.changedFiles;
  const testsRun = 1;
  const testsFailed = requestedVerdict.verdict === "PASS" ? 0 : 1;
  const finishedAt = new Date().toISOString();
  const report: EvaluatorReport = {
    adapter: "fixture",
    verdict: requestedVerdict.verdict,
    taskId: input.taskId,
    attempt: input.attempt,
    startedAt,
    finishedAt,
    testsRun,
    testsFailed,
    feedback:
      requestedVerdict.verdict === "PASS"
        ? "Fixture evaluator accepted the generated worktree changes."
        : "Fixture evaluator rejected the generated worktree changes.",
    filesInspected,
    generatorReportPath: generatorReport,
    summary: `Fixture evaluator returned ${requestedVerdict.verdict} after inspecting ${filesInspected.length} file(s).`
  };
  const reportPath = await writeEvaluatorReport(input.artifactsDir, input.taskId, report, input.reportPath);

  return {
    ok: true,
    report,
    reportPath
  };
}

async function runCodexEvaluator(
  input: RunEvaluatorInput,
  runner: CommandRunner
): Promise<EvaluatorOk | EvaluatorError> {
  const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
  if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
    return {
      ok: false,
      code: "WORKSPACE_UNAVAILABLE",
      message: "Workspace must exist, be a git worktree, and not be cleaned before evaluation."
    };
  }

  const generatorReportPathStr = input.generatorReportPath ?? generatorReportPath(input.artifactsDir, input.taskId);
  const generatorReportContent = await readOptional(generatorReportPathStr);
  if (generatorReportContent === null) {
    return {
      ok: false,
      code: "GENERATOR_REPORT_NOT_FOUND",
      message: `Generator report not found: ${generatorReportPathStr}`
    };
  }

  const changedFiles = status.changedFiles;
  if (changedFiles.length === 0) {
    return {
      ok: false,
      code: "CODEX_NO_VERDICT",
      message: "No changed files to evaluate in the workspace."
    };
  }

  const command = codexCommand();
  const prompt = buildEvaluatorPrompt(input, changedFiles);
  const argv = buildCodexArgv(input.workspace.worktreePath, prompt);
  const startedAt = new Date().toISOString();

  let result: CommandResult;
  try {
    result = await runAgent(command, argv, input.workspace.worktreePath, runner);
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

  // Read Codex's structured verdict output
  const verdictPath = path.join(input.workspace.worktreePath, ".anchor", "eval", "verdict.json");
  const verdictResult = await readCodexVerdict(verdictPath, result);

  const finishedAt = new Date().toISOString();
  const filesInspected = (await getWorkspaceGitStatus(input.workspace.worktreePath)).changedFiles;
  const report: EvaluatorReport = {
    adapter: "codex",
    verdict: verdictResult.verdict,
    taskId: input.taskId,
    attempt: input.attempt,
    startedAt,
    finishedAt,
    testsRun: verdictResult.testsRun,
    testsFailed: verdictResult.testsFailed,
    feedback: verdictResult.feedback,
    filesInspected,
    generatorReportPath: generatorReportPathStr,
    command,
    argv: redactCodexArgv(argv),
    exitCode: result.exitCode,
    stdoutSummary: summarizeOutput(result.stdout),
    stderrSummary: summarizeOutput(result.stderr),
    summary: `Codex evaluator returned ${verdictResult.verdict} (exit ${result.exitCode}, ${verdictResult.testsRun} tests, ${verdictResult.testsFailed} failed).`
  };
  const reportPath = await writeEvaluatorReport(input.artifactsDir, input.taskId, report, input.reportPath);

  return {
    ok: true,
    report,
    reportPath
  };
}

function buildEvaluatorPrompt(input: RunEvaluatorInput, changedFiles: string[]): string {
  return [
    "You are the Evaluator role inside Anchor.",
    `Task ID: ${input.taskId}`,
    `Worktree path: ${input.workspace.worktreePath}`,
    "",
    "Approved contract:",
    input.contract,
    "",
    "The Generator changed these files:",
    ...changedFiles.map((f) => `  - ${f}`),
    "",
    "Your job:",
    "1. Review the generated changes against the contract.",
    "2. Write verification tests to `.anchor/eval/tests/`.",
    "3. Run the tests and observe results.",
    "4. Write your evaluation verdict to `.anchor/eval/verdict.json` with this exact format:",
    '   {"verdict":"PASS","feedback":"<detailed explanation>","testsRun":<number>,"testsFailed":<number>}',
    "   Use \"FAIL\" if the implementation is incorrect, incomplete, or violates the contract.",
    "5. Exit with code 0 for PASS, code 1 for FAIL.",
    "",
    "Constraints:",
    "- ONLY write to `.anchor/eval/` directory.",
    "- Do NOT modify the generated source files (they belong to the Generator).",
    "- Do NOT read, write, or persist secrets or authentication tokens.",
    "- Do NOT perform network operations or install dependencies."
  ].join("\n");
}

type CodexVerdictResult = {
  verdict: EvalVerdict;
  feedback: string;
  testsRun: number;
  testsFailed: number;
};

async function readCodexVerdict(verdictPath: string, result: CommandResult): Promise<CodexVerdictResult> {
  const raw = await readOptional(verdictPath);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.verdict === "string" &&
        (parsed.verdict === "PASS" || parsed.verdict === "FAIL") &&
        typeof parsed.feedback === "string"
      ) {
        return {
          verdict: parsed.verdict as EvalVerdict,
          feedback: parsed.feedback,
          testsRun: typeof parsed.testsRun === "number" ? parsed.testsRun : 0,
          testsFailed: typeof parsed.testsFailed === "number" ? parsed.testsFailed : 0
        };
      }
    } catch {
      // fall through to exit-code heuristic
    }
  }

  // Fallback: use exit code to determine verdict
  const verdict = result.exitCode === 0 ? "PASS" : "FAIL";
  return {
    verdict,
    feedback:
      raw !== null
        ? `Unexpected verdict format in ${verdictPath}. Falling back to exit code (${result.exitCode}). Raw: ${raw.slice(0, 500)}`
        : `No verdict file at ${verdictPath}. Falling back to exit code (${result.exitCode}).`,
    testsRun: 0,
    testsFailed: verdict === "PASS" ? 0 : 1
  };
}

export async function writeEvaluatorReport(
  artifactsDir: string,
  taskId: string,
  report: EvaluatorReport,
  targetPath?: string
) {
  const reportPath = targetPath ?? evaluatorReportPath(artifactsDir, taskId);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

export function evaluatorReportPath(artifactsDir: string, taskId: string) {
  return path.join(artifactsDir, taskId, "evaluator-report.json");
}

export function evaluatorAttemptReportPath(artifactsDir: string, taskId: string, attempt: number) {
  return path.join(artifactsDir, taskId, "attempts", String(attempt), "evaluator-report.json");
}

async function readOptional(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readFixtureVerdict(
  verdict: string | undefined
): { ok: true; verdict: EvalVerdict } | EvaluatorError {
  const normalized = verdict?.trim().toLowerCase();
  if (normalized === "pass") {
    return { ok: true, verdict: "PASS" };
  }
  if (normalized === "fail") {
    return { ok: true, verdict: "FAIL" };
  }
  return {
    ok: false,
    code: "INVALID_VERDICT",
    message: "Fixture evaluator verdict must be pass or fail.",
    detail: verdict ?? ""
  };
}
