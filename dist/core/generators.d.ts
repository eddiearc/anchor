import { type PermissionResult } from "./permissions.js";
import { type WorkspaceMetadata } from "./workspaces.js";
import { type CommandRunner } from "./agent-runner.js";
import { type AnchorConfig } from "./config.js";
export type GeneratorAdapter = "fixture" | "codex" | "pi";
export type FixtureVariant = "allowed" | "outside";
export type GeneratorReport = {
    adapter: GeneratorAdapter;
    provider: GeneratorAdapter;
    fixture?: FixtureVariant;
    taskId: string;
    currentStepId?: string | null;
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
    code: "UNSUPPORTED_ADAPTER" | "UNKNOWN_PROVIDER" | "UNSUPPORTED_PROVIDER_ROLE" | "WORKSPACE_UNAVAILABLE" | "POLICY_VIOLATION" | "GIT_COMMAND_FAILED" | "CODEX_CLI_UNAVAILABLE" | "CODEX_COMMAND_FAILED" | "CODEX_NO_CHANGES" | "PI_CLI_UNAVAILABLE" | "PI_COMMAND_FAILED" | "PI_NO_CHANGES";
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
    currentStepId?: string | null;
};
export declare function runGenerator(input: RunGeneratorInput, runner?: CommandRunner): Promise<GeneratorOk | GeneratorError>;
export declare function validateGeneratorProvider(providerId: string, runner?: CommandRunner): {
    ok: true;
} | GeneratorError;
export declare function runFixtureGenerator(input: RunGeneratorInput): Promise<GeneratorOk | GeneratorError>;
export declare function writeGeneratorReport(artifactsDir: string, taskId: string, report: GeneratorReport, targetPath?: string): Promise<string>;
export declare function generatorReportPath(artifactsDir: string, taskId: string): string;
export declare function generatorAttemptReportPath(artifactsDir: string, taskId: string, attempt: number): string;
export declare function readContractPolicy(contract: string): {
    allowlist: string[];
    denylist: string[];
};
