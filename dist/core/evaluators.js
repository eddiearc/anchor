import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkspaceGitStatus } from "./workspaces.js";
import { generatorReportPath } from "./generators.js";
import { resolveProvider } from "./providers.js";
import { composePrompt } from "./config.js";
import { contractPathForTask } from "./contracts.js";
import { defaultCommandRunner, defaultRetryConfig, runAgent, buildCodexArgv, buildPiArgv, codexCommand, piCommand, isCommandUnavailable, summarizeOutput, redactCodexArgv } from "./agent-runner.js";
export async function runEvaluator(input, runner = defaultCommandRunner) {
    const provider = resolveProvider(evaluatorProviders(runner), input.adapter, "evaluator");
    if ("ok" in provider)
        return evaluatorProviderError(provider);
    return provider.run(input);
}
export function validateEvaluatorProvider(providerId, runner = defaultCommandRunner) {
    const provider = resolveProvider(evaluatorProviders(runner), providerId, "evaluator");
    if ("ok" in provider)
        return evaluatorProviderError(provider);
    return { ok: true };
}
function evaluatorProviders(runner) {
    return [
        {
            id: "fixture",
            roles: ["evaluator"],
            run: (input) => runFixtureEvaluator(input)
        },
        {
            id: "codex",
            roles: ["evaluator"],
            run: (input) => runCodexEvaluator(input, runner)
        },
        {
            id: "pi",
            roles: ["evaluator"],
            run: (input) => runPiEvaluator(input, runner)
        }
    ];
}
function evaluatorProviderError(error) {
    return {
        ok: false,
        code: error.code,
        message: error.message,
        detail: JSON.stringify({ provider: error.provider, role: error.role, availableProviders: error.availableProviders })
    };
}
export async function runFixtureEvaluator(input) {
    if (input.adapter !== "fixture") {
        return {
            ok: false,
            code: "UNSUPPORTED_ADAPTER",
            message: `Unsupported evaluator adapter: ${input.adapter}`
        };
    }
    const requestedVerdict = readFixtureVerdict(input.verdict ?? fixtureRetryVerdict(input));
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
    const report = {
        adapter: "fixture",
        provider: "fixture",
        verdict: requestedVerdict.verdict,
        taskId: input.taskId,
        attempt: input.attempt,
        startedAt,
        finishedAt,
        testsRun,
        testsFailed,
        feedback: requestedVerdict.verdict === "PASS"
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
async function runCodexEvaluator(input, runner) {
    return runCommandEvaluator(input, runner, {
        provider: "codex",
        label: "Codex",
        command: codexCommand(),
        buildArgv: buildCodexArgv,
        timeoutEnvPrefix: "CODEX",
        unavailableCode: "CODEX_CLI_UNAVAILABLE",
        commandFailedCode: "CODEX_COMMAND_FAILED",
        noVerdictCode: "CODEX_NO_VERDICT"
    });
}
async function runPiEvaluator(input, runner) {
    return runCommandEvaluator(input, runner, {
        provider: "pi",
        label: "Pi",
        command: piCommand(),
        buildArgv: buildPiArgv,
        timeoutEnvPrefix: "PI",
        unavailableCode: "PI_CLI_UNAVAILABLE",
        commandFailedCode: "PI_COMMAND_FAILED",
        noVerdictCode: "PI_NO_VERDICT"
    });
}
async function runCommandEvaluator(input, runner, providerConfig) {
    const status = await getWorkspaceGitStatus(input.workspace.worktreePath);
    if (!status.pathExists || !status.isGitWorktree || input.workspace.cleanedAt) {
        return {
            ok: false,
            code: "WORKSPACE_UNAVAILABLE",
            message: "Workspace must exist, be a git worktree, and not be cleaned before evaluation."
        };
    }
    // Auto-create evaluator sandbox directory
    const sandboxDir = path.join(input.workspace.worktreePath, ".anchor", "eval", "tests");
    await mkdir(sandboxDir, { recursive: true });
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
            code: providerConfig.noVerdictCode,
            message: "No changed files to evaluate in the workspace."
        };
    }
    const command = providerConfig.command;
    const prompt = buildEvaluatorPrompt(input, changedFiles, generatorReportPathStr, generatorReportContent);
    const allowNetwork = input.allowNetwork === true || input.config?.agent_allow_network === true;
    const argv = providerConfig.buildArgv(input.workspace.worktreePath, prompt, allowNetwork);
    const envAllowlist = providerEnvAllowlist();
    const retryConfig = {
        maxRetries: input.config?.agent_retry_max ?? defaultRetryConfig.maxRetries,
        backoffMs: input.config?.agent_retry_backoff_ms ?? defaultRetryConfig.backoffMs
    };
    const startedAt = new Date().toISOString();
    let result;
    try {
        result = await runAgent(command, argv, input.workspace.worktreePath, runner, retryConfig, {
            env: buildProviderEnvironment(envAllowlist),
            envAllowlist,
            timeoutMs: providerTimeoutMs(providerConfig.timeoutEnvPrefix),
            prompt,
            contract: input.contract
        });
    }
    catch (error) {
        if (isCommandUnavailable(error)) {
            return {
                ok: false,
                code: providerConfig.unavailableCode,
                message: `${providerConfig.label} CLI command is unavailable: ${command}`,
                detail: error instanceof Error ? error.message : String(error)
            };
        }
        throw error;
    }
    // Read the provider's structured verdict output
    const verdictPath = path.join(input.workspace.worktreePath, ".anchor", "eval", "verdict.json");
    const verdictResult = await readProviderVerdict(verdictPath, result, providerConfig);
    const finishedAt = new Date().toISOString();
    const filesInspected = (await getWorkspaceGitStatus(input.workspace.worktreePath)).changedFiles;
    const report = {
        adapter: providerConfig.provider,
        provider: providerConfig.provider,
        verdict: verdictResult.ok ? verdictResult.verdict : "FAIL",
        taskId: input.taskId,
        attempt: input.attempt,
        startedAt,
        finishedAt,
        testsRun: verdictResult.ok ? verdictResult.testsRun : 0,
        testsFailed: verdictResult.ok ? verdictResult.testsFailed : 1,
        feedback: verdictResult.ok ? verdictResult.feedback : verdictResult.message,
        filesInspected,
        generatorReportPath: generatorReportPathStr,
        command,
        argv: redactCodexArgv(argv),
        exitCode: result.exitCode,
        stdoutSummary: summarizeOutput(result.stdout),
        stderrSummary: summarizeOutput(result.stderr),
        summary: verdictResult.ok
            ? `${providerConfig.label} evaluator returned ${verdictResult.verdict} (exit ${result.exitCode}, ${verdictResult.testsRun} tests, ${verdictResult.testsFailed} failed).`
            : `${providerConfig.label} evaluator failed before a valid verdict (exit ${result.exitCode}): ${verdictResult.message}`
    };
    const reportPath = await writeEvaluatorReport(input.artifactsDir, input.taskId, report, input.reportPath);
    if (!verdictResult.ok) {
        return {
            ok: false,
            code: verdictResult.code,
            message: verdictResult.message,
            detail: verdictResult.detail,
            report,
            reportPath
        };
    }
    return {
        ok: true,
        report,
        reportPath
    };
}
function buildEvaluatorPrompt(input, changedFiles, generatorReportPathStr, generatorReportContent) {
    const base = [
        "You are the Evaluator role inside Anchor.",
        `Task ID: ${input.taskId}`,
        `Worktree path: ${input.workspace.worktreePath}`,
        `Approved contract path: ${input.contractPath ?? contractPathForTask(input.artifactsDir, input.taskId)}`,
        `Generator report path: ${generatorReportPathStr}`,
        "",
        "Approved contract:",
        input.contract,
        "",
        "Generator report:",
        generatorReportContent,
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
    return composePrompt(input.config, "evaluator_prompt", base);
}
async function readProviderVerdict(verdictPath, result, providerConfig) {
    const raw = await readOptional(verdictPath);
    if (raw !== null) {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed.verdict === "string" &&
                (parsed.verdict === "PASS" || parsed.verdict === "FAIL") &&
                typeof parsed.feedback === "string") {
                return {
                    ok: true,
                    verdict: parsed.verdict,
                    feedback: parsed.feedback,
                    testsRun: typeof parsed.testsRun === "number" ? parsed.testsRun : 0,
                    testsFailed: typeof parsed.testsFailed === "number" ? parsed.testsFailed : 0
                };
            }
            return {
                ok: false,
                code: providerConfig.noVerdictCode,
                message: `${providerConfig.label} evaluator wrote an invalid verdict file: ${verdictPath}`,
                detail: "Expected JSON object with verdict PASS|FAIL and string feedback."
            };
        }
        catch (error) {
            return {
                ok: false,
                code: providerConfig.noVerdictCode,
                message: `${providerConfig.label} evaluator wrote unparseable verdict JSON: ${verdictPath}`,
                detail: error instanceof Error ? error.message : String(error)
            };
        }
    }
    if (result.exitCode !== 0) {
        return {
            ok: false,
            code: providerConfig.commandFailedCode,
            message: `${providerConfig.label} evaluator exited with code ${result.exitCode} without a valid verdict file.`,
            detail: summarizeOutput(result.stderr || result.stdout)
        };
    }
    return {
        ok: false,
        code: providerConfig.noVerdictCode,
        message: `${providerConfig.label} evaluator completed without writing a valid verdict file: ${verdictPath}`,
        detail: summarizeOutput(result.stdout || result.stderr)
    };
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
export async function writeEvaluatorReport(artifactsDir, taskId, report, targetPath) {
    const reportPath = targetPath ?? evaluatorReportPath(artifactsDir, taskId);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return reportPath;
}
export function evaluatorReportPath(artifactsDir, taskId) {
    return path.join(artifactsDir, taskId, "evaluator-report.json");
}
export function evaluatorAttemptReportPath(artifactsDir, taskId, attempt) {
    return path.join(artifactsDir, taskId, "attempts", String(attempt), "evaluator-report.json");
}
async function readOptional(filePath) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
function readFixtureVerdict(verdict) {
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
function fixtureRetryVerdict(input) {
    if (typeof input.retryFailTimes !== "number" || typeof input.attempt !== "number")
        return undefined;
    return input.attempt <= input.retryFailTimes ? "fail" : "pass";
}
