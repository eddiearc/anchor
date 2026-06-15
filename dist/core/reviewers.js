import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultCommandRunner, runAgent, buildCodexArgv, codexCommand, isCommandUnavailable, summarizeOutput, redactCodexArgv } from "./agent-runner.js";
import { composePrompt } from "./config.js";
export async function runReviewer(input, runner = defaultCommandRunner) {
    if (input.adapter === "fixture") {
        return runFixtureReviewer(input);
    }
    if (input.adapter === "codex") {
        return runCodexReviewer(input, runner);
    }
    return {
        ok: false,
        code: "UNSUPPORTED_ADAPTER",
        message: `Unsupported reviewer adapter: ${input.adapter}`
    };
}
export async function runFixtureReviewer(input) {
    if (input.adapter !== "fixture") {
        return {
            ok: false,
            code: "UNSUPPORTED_ADAPTER",
            message: `Unsupported reviewer adapter: ${input.adapter}`
        };
    }
    const requestedVerdict = readReviewerFixtureVerdict(input.verdict);
    if (!requestedVerdict.ok) {
        return requestedVerdict;
    }
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const report = {
        adapter: "fixture",
        verdict: requestedVerdict.verdict,
        taskId: input.taskId,
        startedAt,
        finishedAt,
        feedback: requestedVerdict.verdict === "READY"
            ? "Fixture reviewer accepted the contract as structurally sound."
            : "Fixture reviewer found structural issues requiring revision.",
        summary: `Fixture reviewer returned ${requestedVerdict.verdict}.`
    };
    const reportPath = await writeReviewerReport(input.artifactsDir, input.taskId, report, input.reportPath);
    return {
        ok: true,
        report,
        reportPath
    };
}
async function runCodexReviewer(input, runner) {
    const command = codexCommand();
    const prompt = buildReviewerPrompt(input);
    // Codex reviewer runs in the repo root (not a worktree), since REVIEW
    // happens before workspace creation and reviews the contract only.
    const cwd = process.cwd();
    const argv = buildCodexArgv(cwd, prompt);
    const startedAt = new Date().toISOString();
    let result;
    try {
        result = await runAgent(command, argv, cwd, runner);
    }
    catch (error) {
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
    const verdictResult = parseReviewerOutput(result.stdout, result.exitCode);
    const finishedAt = new Date().toISOString();
    const report = {
        adapter: "codex",
        verdict: verdictResult.verdict,
        taskId: input.taskId,
        startedAt,
        finishedAt,
        feedback: verdictResult.feedback,
        command,
        argv: redactCodexArgv(argv),
        exitCode: result.exitCode,
        stdoutSummary: summarizeOutput(result.stdout),
        stderrSummary: summarizeOutput(result.stderr),
        summary: `Codex reviewer returned ${verdictResult.verdict} (exit ${result.exitCode}).`
    };
    const reportPath = await writeReviewerReport(input.artifactsDir, input.taskId, report, input.reportPath);
    if (result.exitCode !== 0) {
        // Non-zero exit doesn't automatically mean FAIL — we still parse for structured verdict
    }
    return {
        ok: true,
        report,
        reportPath
    };
}
function buildReviewerPrompt(input) {
    const base = [
        "You are the Reviewer role inside Anchor.",
        `Task ID: ${input.taskId}`,
        "",
        "Approved contract (to review):",
        input.contract,
        "",
        "Your job:",
        "1. Review the contract for structural soundness and verifiability.",
        "2. Check: are all acceptance criteria mechanically verifiable?",
        "3. Check: scope correct? allowlist/denylist complete?",
        "4. Check: constraints consistent? contradictions?",
        "5. Write your verdict to stdout as a single JSON line:",
        '   {"verdict":"READY","feedback":"<detailed explanation>"}',
        '   Use "NEEDS_REVISION" if the contract has structural flaws.',
        "6. Exit with code 0 for READY, code 1 for NEEDS_REVISION.",
        "",
        "Constraints:",
        "- Only review. Do not modify the contract or any files.",
        "- Do not read, write, or persist secrets or authentication tokens.",
        "- Do not perform network operations or install dependencies."
    ].join("\n");
    return composePrompt(input.config, "reviewer_prompt", base);
}
function parseReviewerOutput(stdout, exitCode) {
    // Try to find a JSON line with verdict in output
    const lines = stdout.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{")) {
            try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed.verdict === "string" &&
                    (parsed.verdict === "READY" || parsed.verdict === "NEEDS_REVISION") &&
                    typeof parsed.feedback === "string") {
                    return {
                        verdict: parsed.verdict,
                        feedback: parsed.feedback
                    };
                }
            }
            catch {
                // not valid JSON, try next line
            }
        }
    }
    // Fallback: use exit code
    const verdict = exitCode === 0 ? "READY" : "NEEDS_REVISION";
    return {
        verdict,
        feedback: `No structured verdict found in stdout. Falling back to exit code (${exitCode}).`
    };
}
export async function writeReviewerReport(artifactsDir, taskId, report, targetPath) {
    const reportPath = targetPath ?? reviewerReportPath(artifactsDir, taskId);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return reportPath;
}
export function reviewerReportPath(artifactsDir, taskId) {
    return path.join(artifactsDir, taskId, "reviewer-report.json");
}
function readReviewerFixtureVerdict(verdict) {
    const normalized = verdict?.trim().toUpperCase();
    if (!normalized || normalized === "READY") {
        return { ok: true, verdict: "READY" };
    }
    if (normalized === "NEEDS_REVISION") {
        return { ok: true, verdict: "NEEDS_REVISION" };
    }
    return {
        ok: false,
        code: "INVALID_VERDICT",
        message: "Fixture reviewer verdict must be READY or NEEDS_REVISION.",
        detail: verdict ?? ""
    };
}
