import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export const defaultRetryConfig = {
    maxRetries: 3,
    backoffMs: 1000
};
export async function defaultCommandRunner(command, args, options) {
    const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...options.env } : process.env,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs
    });
    return { exitCode: 0, stdout, stderr };
}
export async function runAgent(command, args, cwd, runner = defaultCommandRunner, retryConfig = defaultRetryConfig, runOptions = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        try {
            return await runner(command, args, { cwd, ...runOptions });
        }
        catch (error) {
            lastError = error;
            if (isCommandUnavailable(error)) {
                throw error;
            }
            // Non-retryable errors: return structured failure (don't throw)
            if (!isRetryableError(error)) {
                return {
                    exitCode: readExitCode(error),
                    stdout: readProcessOutput(error, "stdout"),
                    stderr: readProcessOutput(error, "stderr") || fallbackProcessError(error)
                };
            }
            // Last attempt — don't retry, return structured failure
            if (attempt === retryConfig.maxRetries) {
                return {
                    exitCode: readExitCode(error),
                    stdout: readProcessOutput(error, "stdout"),
                    stderr: readProcessOutput(error, "stderr") || fallbackProcessError(error)
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
        stderr: readProcessOutput(lastError, "stderr") || fallbackProcessError(lastError)
    };
}
export function buildCodexArgv(worktreePath, prompt, allowNetwork = false) {
    const customArgv = readCustomArgv("ANCHOR_CODEX_ARGV_JSON", prompt);
    if (customArgv)
        return customArgv;
    const base = [
        "exec",
        "--cd", worktreePath,
        "--sandbox", "workspace-write",
        "--ephemeral"
    ];
    if (allowNetwork) {
        base.push("-c", "sandbox_workspace_write.network_access=true");
    }
    else {
        base.push("-c", "sandbox_workspace_write.network_access=false");
    }
    base.push(prompt);
    return base;
}
export function codexCommand() {
    return process.env.ANCHOR_CODEX_COMMAND ?? "codex";
}
export function buildPiArgv(worktreePath, prompt, allowNetwork = false) {
    const customArgv = readCustomArgv("ANCHOR_PI_ARGV_JSON", prompt);
    if (customArgv)
        return customArgv;
    const base = [
        "--print",
        "--no-session",
        "--no-context-files",
        "--tools",
        "read,bash,edit,write,grep,find,ls"
    ];
    if (!allowNetwork) {
        base.push("--offline");
    }
    base.push(prompt);
    return base;
}
export function piCommand() {
    return process.env.ANCHOR_PI_COMMAND ?? "pi";
}
function readCustomArgv(envKey, prompt) {
    const customArgv = process.env[envKey];
    if (!customArgv)
        return null;
    const parsed = JSON.parse(customArgv);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error(`${envKey} must be a JSON string array.`);
    }
    return [...parsed, prompt];
}
export function isCommandUnavailable(error) {
    if (typeof error !== "object" || error === null)
        return false;
    return error.code === "ENOENT";
}
export function isRetryableError(error) {
    if (typeof error !== "object" || error === null)
        return false;
    const err = error;
    // Network errors
    if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" ||
        err.code === "ENOTFOUND" || err.code === "EAI_AGAIN")
        return true;
    // OOM / resource exhaustion
    if (err.code === "ENOMEM" || (typeof err.signal === "string" && err.signal === "SIGKILL"))
        return true;
    // HTTP-level errors: rate limit (429) and server errors (5xx)
    const message = err.message ?? "";
    if (/429|rate.?limit/i.test(message))
        return true;
    if (/5\d{2}/.test(message))
        return true;
    // Non-retryable: auth (401/403), usage limit, contract violations
    // Exit codes 1-2 from codex typically mean usage/auth/config failures
    return false;
}
export function readExitCode(error) {
    if (typeof error === "object" && error !== null) {
        const code = error.code;
        if (typeof code === "number")
            return code;
    }
    return 1;
}
export function readProcessOutput(error, key) {
    if (typeof error === "object" && error !== null) {
        const record = error;
        if (typeof record[key] === "string")
            return record[key];
    }
    return "";
}
function fallbackProcessError(error) {
    return `Command runner failed with exit code ${readExitCode(error)}.`;
}
export function summarizeOutput(output) {
    const normalized = output.trim().replace(/\s+/g, " ");
    return normalized.length > 1000 ? `${normalized.slice(0, 1000)}...` : normalized;
}
export function redactCodexArgv(argv) {
    return argv.map((arg, index) => (index === argv.length - 1 ? "[prompt redacted]" : arg));
}
