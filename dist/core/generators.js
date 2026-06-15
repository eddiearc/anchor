import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateWorkspacePolicy } from "./permissions.js";
import { resolveProvider } from "./providers.js";
import { getWorkspaceGitStatus } from "./workspaces.js";
import { defaultCommandRunner, defaultRetryConfig, runAgent, buildCodexArgv, buildPiArgv, codexCommand, piCommand, isCommandUnavailable, summarizeOutput, redactCodexArgv } from "./agent-runner.js";
import { composePrompt } from "./config.js";
import { contractPathForTask } from "./contracts.js";
const execFileAsync = promisify(execFile);
export async function runGenerator(input, runner = defaultCommandRunner) {
    const provider = resolveProvider(generatorProviders(runner), input.adapter, "generator");
    if ("ok" in provider)
        return generatorProviderError(provider);
    return provider.run(input);
}
export function validateGeneratorProvider(providerId, runner = defaultCommandRunner) {
    const provider = resolveProvider(generatorProviders(runner), providerId, "generator");
    if ("ok" in provider)
        return generatorProviderError(provider);
    return { ok: true };
}
function generatorProviders(runner) {
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
function generatorProviderError(error) {
    return {
        ok: false,
        code: error.code,
        message: error.message,
        detail: JSON.stringify({ provider: error.provider, role: error.role, availableProviders: error.availableProviders })
    };
}
export async function runFixtureGenerator(input) {
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
    const report = {
        adapter: "fixture",
        provider: "fixture",
        fixture,
        taskId: input.taskId,
        currentStepId: input.currentStepId ?? null,
        previousEvaluatorFeedback: input.previousEvaluatorFeedback ?? null,
        previousEvaluatorReportPath: input.previousEvaluatorReportPath ?? null,
        attempt: input.attempt,
        startedAt,
        finishedAt,
        filesChanged: changedFiles,
        policyResult,
        commitSha: await currentHead(input.workspace.worktreePath),
        summary: policyResult.ok
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
async function runCodexGenerator(input, runner) {
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
async function runPiGenerator(input, runner) {
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
async function runCommandGenerator(input, runner, providerConfig) {
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
    const retryConfig = {
        maxRetries: input.config?.agent_retry_max ?? defaultRetryConfig.maxRetries,
        backoffMs: input.config?.agent_retry_backoff_ms ?? defaultRetryConfig.backoffMs
    };
    let result;
    try {
        result = await runAgent(providerConfig.command, providerConfig.argv, input.workspace.worktreePath, runner, retryConfig, {
            env: buildProviderEnvironment(envAllowlist),
            envAllowlist,
            timeoutMs: providerConfig.timeoutMs,
            prompt: providerConfig.prompt,
            contract: input.contract
        });
    }
    catch (error) {
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
    const report = {
        adapter: providerConfig.provider,
        provider: providerConfig.provider,
        taskId: input.taskId,
        currentStepId: input.currentStepId ?? null,
        previousEvaluatorFeedback: input.previousEvaluatorFeedback ?? null,
        previousEvaluatorReportPath: input.previousEvaluatorReportPath ?? null,
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
function buildGeneratorPrompt(input) {
    const policy = readContractPolicy(input.contract);
    const previousFindings = input.previousEvaluatorFeedback?.trim();
    const previousFindingsSection = previousFindings
        ? [
            "",
            "Previous evaluator findings:",
            `Report path: ${input.previousEvaluatorReportPath ?? "(not recorded)"}`,
            previousFindings,
            "",
            "Before doing any other work, address these findings in the current step and include how you addressed them in the Step delivery section."
        ]
        : [];
    const operatorSteer = input.operatorSteer?.trim();
    const operatorSteerSection = operatorSteer
        ? [
            "",
            "Operator steer:",
            operatorSteer,
            "",
            "Apply this steering only when it does not conflict with the approved contract, current step, or safety constraints."
        ]
        : [];
    const base = [
        "You are the Generator role inside Anchor.",
        `Task ID: ${input.taskId}`,
        `Current step ID: ${input.currentStepId ?? "(contract-level)"}`,
        ...operatorSteerSection,
        `Worktree path: ${input.workspace.worktreePath}`,
        `Approved contract path: ${input.contractPath ?? contractPathForTask(input.artifactsDir, input.taskId)}`,
        "",
        "Approved contract:",
        input.contract,
        ...previousFindingsSection,
        "",
        "Execution rules:",
        "- Implement only Current step ID. Treat the full contract as context and constraints, not permission to implement future steps.",
        "- Do not implement future steps, even if they look obvious or cheap.",
        "- If Current step ID is blocked by missing prior work or an invalid contract, stop and report BLOCKED in normal output.",
        "- Keep the diff minimal for the current step.",
        "- Modify files only inside the provided worktree.",
        `- Stay inside allowed scope: ${policy.allowlist.join(", ") || "(none specified)"}.`,
        `- Do not change denied paths: ${policy.denylist.join(", ") || "(none specified)"}.`,
        "- Do not read, write, print, or persist secrets or authentication tokens.",
        "- Do not perform network operations or install dependencies.",
        "- Do not approve, evaluate, merge, commit, or push.",
        "- Implement only the approved contract and leave validation to Anchor.",
        "",
        "Generator delivery:",
        "- In normal stdout/stderr, include a short Step delivery section with: step id, files changed, criteria addressed, verification run, Evidence paths, and blockers.",
        "- If Previous evaluator findings are present, include a Previous findings addressed item for each finding.",
        "- Evidence paths should point to files you created or command outputs you saved when practical.",
        "- Do not mark criteria as PASS. Evaluator owns verdicts.",
        "",
        "Report expectation:",
        "- Leave worktree changes in place for Anchor to inspect.",
        "- Do not write secrets, tokens, environment dumps, or credentials to files or output.",
        "- Summarize changed files and any verification you ran in normal stdout/stderr only."
    ].join("\n");
    return composePrompt(input.config, "generator_prompt", base);
}
function providerTimeoutMs(providerEnvPrefix) {
    const raw = process.env[`ANCHOR_${providerEnvPrefix}_TIMEOUT_MS`];
    if (!raw)
        return 10 * 60 * 1000;
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
function buildProviderEnvironment(allowlist) {
    const env = {};
    for (const key of allowlist) {
        const value = process.env[key];
        if (value !== undefined)
            env[key] = value;
    }
    return env;
}
async function writeCodexFailureReport(params) {
    const status = await getWorkspaceGitStatus(params.input.workspace.worktreePath);
    const report = {
        adapter: "codex",
        provider: "codex",
        taskId: params.input.taskId,
        currentStepId: params.input.currentStepId ?? null,
        previousEvaluatorFeedback: params.input.previousEvaluatorFeedback ?? null,
        previousEvaluatorReportPath: params.input.previousEvaluatorReportPath ?? null,
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
export async function writeGeneratorReport(artifactsDir, taskId, report, targetPath) {
    const reportPath = targetPath ?? generatorReportPath(artifactsDir, taskId);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return reportPath;
}
export function generatorReportPath(artifactsDir, taskId) {
    return path.join(artifactsDir, taskId, "generator-report.json");
}
export function generatorAttemptReportPath(artifactsDir, taskId, attempt) {
    return path.join(artifactsDir, taskId, "attempts", String(attempt), "generator-report.json");
}
export function readContractPolicy(contract) {
    return {
        allowlist: readYamlList(contract, "allowlist"),
        denylist: readYamlList(contract, "denylist")
    };
}
async function writeFixtureOutput(worktreePath, taskId, fixture) {
    const relativePath = fixture === "allowed"
        ? path.join("anchor-output", `${taskId}.txt`)
        : path.join("outside-output", `${taskId}.txt`);
    const outputPath = path.join(worktreePath, relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, [`taskId=${taskId}`, `fixture=${fixture}`, "adapter=fixture", ""].join("\n"));
}
function commandGeneratorSummary(label, attempt, changedFiles, policyResult, exitCode) {
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
async function currentHead(worktreePath) {
    try {
        const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
            encoding: "utf8"
        });
        return stdout.trim();
    }
    catch {
        return null;
    }
}
function readFixtureVariant(fixture) {
    return fixture === "outside" ? "outside" : "allowed";
}
function readYamlList(contract, key) {
    const lines = contract.split("\n");
    const keyLine = lines.findIndex((line) => line.trim() === `${key}:`);
    if (keyLine === -1)
        return [];
    const keyIndent = indentOf(lines[keyLine]);
    const values = [];
    for (const line of lines.slice(keyLine + 1)) {
        if (line.trim() && indentOf(line) <= keyIndent)
            break;
        const match = /^\s*-\s*(.+?)\s*$/.exec(line);
        if (match)
            values.push(unquote(match[1]));
    }
    return values;
}
function indentOf(line) {
    return line.match(/^\s*/)?.[0].length ?? 0;
}
function unquote(value) {
    const trimmed = value.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return trimmed.replace(/^['"]|['"]$/g, "");
    }
}
