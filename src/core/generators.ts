import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateWorkspacePolicy, type PermissionResult } from "./permissions.js";
import { getWorkspaceGitStatus, type WorkspaceMetadata } from "./workspaces.js";

const execFileAsync = promisify(execFile);

export type GeneratorAdapter = "fixture";
export type FixtureVariant = "allowed" | "outside";

export type GeneratorReport = {
  adapter: GeneratorAdapter;
  fixture: FixtureVariant;
  runId: string;
  startedAt: string;
  finishedAt: string;
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
  code: "UNSUPPORTED_ADAPTER" | "WORKSPACE_UNAVAILABLE" | "POLICY_VIOLATION" | "GIT_COMMAND_FAILED";
  message: string;
  report?: GeneratorReport;
  reportPath?: string;
  detail?: string;
};

export type RunFixtureGeneratorInput = {
  runId: string;
  runsDir: string;
  workspace: WorkspaceMetadata;
  contract: string;
  adapter: string;
  fixture?: string;
  attempt: number;
};

export async function runFixtureGenerator(input: RunFixtureGeneratorInput): Promise<GeneratorOk | GeneratorError> {
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
  const reportPath = await writeGeneratorReport(input.runsDir, input.runId, report);

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

export async function writeGeneratorReport(runsDir: string, runId: string, report: GeneratorReport) {
  const reportPath = generatorReportPath(runsDir, runId);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

export function generatorReportPath(runsDir: string, runId: string) {
  return path.join(runsDir, runId, "generator-report.json");
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

  const values: string[] = [];
  for (const line of lines.slice(keyLine + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) {
      values.push(unquote(match[1]));
    }
  }
  return values;
}

function unquote(value: string) {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, "");
  }
}
