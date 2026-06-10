import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RetryConfig = {
  maxRetries: number;
  backoffMs: number;
};

export const defaultRetryConfig: RetryConfig = {
  maxRetries: 3,
  backoffMs: 1000
};

export async function defaultCommandRunner(command: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return { exitCode: 0, stdout, stderr };
}

export async function runAgent(
  command: string,
  args: string[],
  cwd: string,
  runner: CommandRunner = defaultCommandRunner,
  retryConfig: RetryConfig = defaultRetryConfig
): Promise<CommandResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      return await runner(command, args, { cwd });
    } catch (error) {
      lastError = error;

      if (isCommandUnavailable(error)) {
        throw error;
      }

      // Non-retryable errors: return structured failure (don't throw)
      if (!isRetryableError(error)) {
        return {
          exitCode: readExitCode(error),
          stdout: readProcessOutput(error, "stdout"),
          stderr: readProcessOutput(error, "stderr") || (error instanceof Error ? error.message : String(error))
        };
      }

      // Last attempt — don't retry, return structured failure
      if (attempt === retryConfig.maxRetries) {
        return {
          exitCode: readExitCode(error),
          stdout: readProcessOutput(error, "stdout"),
          stderr: readProcessOutput(error, "stderr") || (error instanceof Error ? error.message : String(error))
        };
      }

      // Exponential backoff
      const delay = retryConfig.backoffMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    exitCode: readExitCode(lastError),
    stdout: readProcessOutput(lastError, "stdout"),
    stderr: readProcessOutput(lastError, "stderr") || (lastError instanceof Error ? (lastError as Error).message : String(lastError))
  };
}

export function buildCodexArgv(worktreePath: string, prompt: string, allowNetwork = false): string[] {
  const customArgv = process.env.ANCHOR_CODEX_ARGV_JSON;
  if (customArgv) {
    const parsed = JSON.parse(customArgv);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("ANCHOR_CODEX_ARGV_JSON must be a JSON string array.");
    }
    return [...parsed, prompt];
  }
  const base = [
    "exec",
    "--cd", worktreePath,
  ];

  if (allowNetwork) {
    base.push("--sandbox", "workspace-write");
    base.push("--allow-network");
  } else {
    base.push("--sandbox", "workspace-write");
    base.push("--skip-approval-if", "network");
  }

  base.push("--ask-for-approval", "never");
  base.push(prompt);
  return base;
}

export function codexCommand(): string {
  return process.env.ANCHOR_CODEX_COMMAND ?? "codex";
}

export function isCommandUnavailable(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  return (error as Record<string, unknown>).code === "ENOENT";
}

export function isRetryableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as Record<string, unknown>;

  // Network errors
  if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" ||
      err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return true;

  // OOM / resource exhaustion
  if (err.code === "ENOMEM" || (typeof err.signal === "string" && err.signal === "SIGKILL")) return true;

  // HTTP-level errors: rate limit (429) and server errors (5xx)
  const message = (err.message as string) ?? "";
  if (/429|rate.?limit/i.test(message)) return true;
  if (/5\d{2}/.test(message)) return true;

  // Non-retryable: auth (401/403), usage limit, contract violations
  // Exit codes 1-2 from codex typically mean usage/auth/config failures
  return false;
}

export function readExitCode(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "number") return code;
  }
  return 1;
}

export function readProcessOutput(error: unknown, key: "stdout" | "stderr") {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

export function summarizeOutput(output: string) {
  const normalized = output.trim().replace(/\s+/g, " ");
  return normalized.length > 1000 ? `${normalized.slice(0, 1000)}...` : normalized;
}

export function redactCodexArgv(argv: string[]) {
  return argv.map((arg, index) => (index === argv.length - 1 ? "[prompt redacted]" : arg));
}
