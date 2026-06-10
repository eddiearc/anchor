import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkspaceGitStatus, type WorkspaceMetadata } from "./workspaces.js";
import { generatorReportPath } from "./generators.js";
import { type EvalVerdict } from "./state-machine.js";

export type EvaluatorAdapter = "fixture";
export type EvaluatorFixtureVerdict = "pass" | "fail";

export type EvaluatorReport = {
  adapter: EvaluatorAdapter;
  verdict: EvalVerdict;
  runId: string;
  startedAt: string;
  finishedAt: string;
  testsRun: number;
  testsFailed: number;
  feedback: string;
  filesInspected: string[];
  generatorReportPath: string;
  summary: string;
};

export type EvaluatorOk = {
  ok: true;
  report: EvaluatorReport;
  reportPath: string;
};

export type EvaluatorError = {
  ok: false;
  code: "UNSUPPORTED_ADAPTER" | "WORKSPACE_UNAVAILABLE" | "GENERATOR_REPORT_NOT_FOUND";
  message: string;
  detail?: string;
};

export type RunFixtureEvaluatorInput = {
  runId: string;
  runsDir: string;
  workspace: WorkspaceMetadata;
  contract: string;
  adapter: string;
  verdict?: string;
};

export async function runFixtureEvaluator(input: RunFixtureEvaluatorInput): Promise<EvaluatorOk | EvaluatorError> {
  if (input.adapter !== "fixture") {
    return {
      ok: false,
      code: "UNSUPPORTED_ADAPTER",
      message: `Unsupported evaluator adapter: ${input.adapter}`
    };
  }

  const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
  if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
    return {
      ok: false,
      code: "WORKSPACE_UNAVAILABLE",
      message: "Workspace must exist, be a git worktree, and not be cleaned before evaluation."
    };
  }

  const generatorReport = generatorReportPath(input.runsDir, input.runId);
  const generatorReportContent = await readOptional(generatorReport);
  if (generatorReportContent === null) {
    return {
      ok: false,
      code: "GENERATOR_REPORT_NOT_FOUND",
      message: `Generator report not found: ${generatorReport}`
    };
  }

  const requestedVerdict = readFixtureVerdict(input.verdict);
  const startedAt = new Date().toISOString();
  const filesInspected = status.changedFiles;
  const testsRun = 1;
  const testsFailed = requestedVerdict === "PASS" ? 0 : 1;
  const finishedAt = new Date().toISOString();
  const report: EvaluatorReport = {
    adapter: "fixture",
    verdict: requestedVerdict,
    runId: input.runId,
    startedAt,
    finishedAt,
    testsRun,
    testsFailed,
    feedback:
      requestedVerdict === "PASS"
        ? "Fixture evaluator accepted the generated worktree changes."
        : "Fixture evaluator rejected the generated worktree changes.",
    filesInspected,
    generatorReportPath: generatorReport,
    summary: `Fixture evaluator returned ${requestedVerdict} after inspecting ${filesInspected.length} file(s).`
  };
  const reportPath = await writeEvaluatorReport(input.runsDir, input.runId, report);

  return {
    ok: true,
    report,
    reportPath
  };
}

export async function writeEvaluatorReport(runsDir: string, runId: string, report: EvaluatorReport) {
  const reportPath = evaluatorReportPath(runsDir, runId);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

export function evaluatorReportPath(runsDir: string, runId: string) {
  return path.join(runsDir, runId, "evaluator-report.json");
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

function readFixtureVerdict(verdict: string | undefined): EvalVerdict {
  return verdict === "fail" || verdict === "FAIL" ? "FAIL" : "PASS";
}
