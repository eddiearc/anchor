import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
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
  runner: CommandRunner = defaultCommandRunner
): Promise<CommandResult> {
  try {
    return await runner(command, args, { cwd });
  } catch (error) {
    if (isCommandUnavailable(error)) {
      throw error;
    }
    return {
      exitCode: readExitCode(error),
      stdout: readProcessOutput(error, "stdout"),
      stderr: readProcessOutput(error, "stderr") || (error instanceof Error ? error.message : String(error))
    };
  }
}

export function buildCodexArgv(worktreePath: string, prompt: string): string[] {
  const customArgv = process.env.ANCHOR_CODEX_ARGV_JSON;
  if (customArgv) {
    const parsed = JSON.parse(customArgv);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("ANCHOR_CODEX_ARGV_JSON must be a JSON string array.");
    }
    return [...parsed, prompt];
  }
  return [
    "exec",
    "--cd", worktreePath,
    "--sandbox", "workspace-write",
    "--ask-for-approval", "never",
    prompt
  ];
}

export function codexCommand(): string {
  return process.env.ANCHOR_CODEX_COMMAND ?? "codex";
}

export function isCommandUnavailable(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  return (error as Record<string, unknown>).code === "ENOENT";
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
