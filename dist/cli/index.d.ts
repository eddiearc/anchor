#!/usr/bin/env node
type CliResult = {
    exitCode: number;
    output: string;
};
type CliOptions = {
    storePath?: string;
    tasksDir?: string;
    worktreesDir?: string;
};
export declare function runCli(args: string[], options?: CliOptions): Promise<CliResult>;
export {};
