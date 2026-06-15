#!/usr/bin/env node
import { type AnchorConfig } from "../index.js";
type CliResult = {
    exitCode: number;
    output: string;
};
type CliOptions = {
    storePath?: string;
    tasksDir?: string;
    worktreesDir?: string;
    repoPath?: string;
    config?: AnchorConfig;
};
export declare function runCli(args: string[], options?: CliOptions): Promise<CliResult>;
export {};
