export type CommandRunOptions = {
    cwd: string;
    env?: Record<string, string>;
    envAllowlist?: string[];
    timeoutMs?: number;
    prompt?: string;
    contract?: string;
};
export type CommandRunner = (command: string, args: string[], options: CommandRunOptions) => Promise<CommandResult>;
export type CommandResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};
export type RetryConfig = {
    maxRetries: number;
    backoffMs: number;
};
export declare const defaultRetryConfig: RetryConfig;
export declare function defaultCommandRunner(command: string, args: string[], options: CommandRunOptions): Promise<CommandResult>;
export declare function runAgent(command: string, args: string[], cwd: string, runner?: CommandRunner, retryConfig?: RetryConfig, runOptions?: Omit<CommandRunOptions, "cwd">): Promise<CommandResult>;
export declare function buildCodexArgv(worktreePath: string, prompt: string, allowNetwork?: boolean): string[];
export declare function codexCommand(): string;
export declare function buildPiArgv(worktreePath: string, prompt: string, allowNetwork?: boolean): string[];
export declare function piCommand(): string;
export declare function isCommandUnavailable(error: unknown): boolean;
export declare function isRetryableError(error: unknown): boolean;
export declare function readExitCode(error: unknown): number;
export declare function readProcessOutput(error: unknown, key: "stdout" | "stderr"): string;
export declare function summarizeOutput(output: string): string;
export declare function redactCodexArgv(argv: string[]): string[];
