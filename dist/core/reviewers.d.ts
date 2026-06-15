import { type ReviewVerdict } from "./state-machine.js";
import { type CommandRunner } from "./agent-runner.js";
import { type AnchorConfig } from "./config.js";
export type ReviewerAdapter = "fixture" | "codex";
export type ReviewerReport = {
    adapter: ReviewerAdapter;
    verdict: ReviewVerdict;
    taskId: string;
    startedAt: string;
    finishedAt: string;
    feedback: string;
    summary: string;
    command?: string;
    argv?: string[];
    exitCode?: number | null;
    stdoutSummary?: string;
    stderrSummary?: string;
};
export type ReviewerOk = {
    ok: true;
    report: ReviewerReport;
    reportPath: string;
};
export type ReviewerError = {
    ok: false;
    code: "UNSUPPORTED_ADAPTER" | "INVALID_VERDICT" | "CONTRACT_NOT_FOUND" | "CODEX_CLI_UNAVAILABLE" | "CODEX_COMMAND_FAILED" | "CODEX_NO_VERDICT";
    message: string;
    detail?: string;
    report?: ReviewerReport;
    reportPath?: string;
};
export type RunReviewerInput = {
    taskId: string;
    artifactsDir: string;
    contract: string;
    adapter: string;
    verdict?: string;
    reportPath?: string;
    config?: AnchorConfig;
    operatorSteer?: string | null;
};
export declare function runReviewer(input: RunReviewerInput, runner?: CommandRunner): Promise<ReviewerOk | ReviewerError>;
export declare function runFixtureReviewer(input: RunReviewerInput): Promise<ReviewerOk | ReviewerError>;
export declare function writeReviewerReport(artifactsDir: string, taskId: string, report: ReviewerReport, targetPath?: string): Promise<string>;
export declare function reviewerReportPath(artifactsDir: string, taskId: string): string;
