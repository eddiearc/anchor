import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceMetadata = {
  taskId: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
  contractSha: string;
  cleanedAt?: string;
};

export type WorkspaceGitStatus = {
  pathExists: boolean;
  isGitWorktree: boolean;
  clean: boolean | null;
  changedFiles: string[];
};

export type WorkspaceCreateResult =
  | {
      ok: true;
      created: boolean;
      metadata: WorkspaceMetadata;
      status: WorkspaceGitStatus;
    }
  | WorkspaceError;

export type WorkspaceCleanupResult =
  | {
      ok: true;
      cleaned: boolean;
      metadata: WorkspaceMetadata;
      status: WorkspaceGitStatus;
    }
  | WorkspaceError;

export type WorkspaceError = {
  ok: false;
  code:
    | "NOT_GIT_REPO"
    | "GIT_COMMAND_FAILED"
    | "WORKSPACE_NOT_FOUND"
    | "WORKTREE_PATH_EXISTS"
    | "WORKSPACE_ALREADY_CLEANED"
    | "WORKSPACE_METADATA_INVALID";
  message: string;
  detail?: string;
};

export async function createGitWorkspace(input: {
  artifactsDir: string;
  worktreesDir: string;
  taskId: string;
  contractSha: string;
  timestamp?: string;
}): Promise<WorkspaceCreateResult> {
  const existing = await readWorkspaceMetadata(input.artifactsDir, input.taskId);
  if (existing) {
    return {
      ok: true,
      created: false,
      metadata: existing,
      status: await getWorkspaceGitStatus(existing.worktreePath)
    };
  }

  const gitRoot = await git(["rev-parse", "--show-toplevel"]);
  if (!gitRoot.ok) {
    return gitRoot.code === "GIT_COMMAND_FAILED"
      ? { ok: false, code: "NOT_GIT_REPO", message: "Current directory is not inside a git repository.", detail: gitRoot.detail }
      : gitRoot;
  }

  const baseCommit = await git(["rev-parse", "HEAD"]);
  if (!baseCommit.ok) {
    return baseCommit;
  }

  const safeTaskId = sanitizeTaskId(input.taskId);
  const worktreePath = path.resolve(input.worktreesDir, safeTaskId);
  if (await pathExists(worktreePath)) {
    return {
      ok: false,
      code: "WORKTREE_PATH_EXISTS",
      message: `Refusing to use existing path without Anchor metadata: ${worktreePath}`
    };
  }

  const metadata: WorkspaceMetadata = {
    taskId: input.taskId,
    baseCommit: baseCommit.stdout,
    branch: `anchor/${safeTaskId}-${randomUUID().slice(0, 8)}`,
    worktreePath,
    createdAt: input.timestamp ?? new Date().toISOString(),
    contractSha: input.contractSha
  };

  await mkdir(path.dirname(worktreePath), { recursive: true });
  const add = await git(["worktree", "add", "-b", metadata.branch, metadata.worktreePath, metadata.baseCommit]);
  if (!add.ok) {
    return add;
  }

  await writeWorkspaceMetadata(input.artifactsDir, input.taskId, metadata);
  return {
    ok: true,
    created: true,
    metadata,
    status: await getWorkspaceGitStatus(metadata.worktreePath)
  };
}

export async function cleanupGitWorkspace(input: {
  artifactsDir: string;
  taskId: string;
  timestamp?: string;
}): Promise<WorkspaceCleanupResult> {
  const metadata = await readWorkspaceMetadata(input.artifactsDir, input.taskId);
  if (!metadata) {
    return {
      ok: false,
      code: "WORKSPACE_NOT_FOUND",
      message: `Workspace metadata not found for task: ${input.taskId}`
    };
  }

  if (metadata.cleanedAt) {
    return {
      ok: true,
      cleaned: false,
      metadata,
      status: await getWorkspaceGitStatus(metadata.worktreePath)
    };
  }

  if (await pathExists(metadata.worktreePath)) {
    const remove = await git(["worktree", "remove", "--force", metadata.worktreePath]);
    if (!remove.ok) {
      await rm(metadata.worktreePath, { recursive: true, force: true });
    }
  }

  const cleaned = {
    ...metadata,
    cleanedAt: input.timestamp ?? new Date().toISOString()
  };
  await writeWorkspaceMetadata(input.artifactsDir, input.taskId, cleaned);
  return {
    ok: true,
    cleaned: true,
    metadata: cleaned,
    status: await getWorkspaceGitStatus(cleaned.worktreePath)
  };
}

export async function readWorkspaceStatus(artifactsDir: string, taskId: string) {
  const metadata = await readWorkspaceMetadata(artifactsDir, taskId);
  if (!metadata) {
    return null;
  }

  return {
    metadata,
    status: await getWorkspaceGitStatus(metadata.worktreePath)
  };
}

export async function readWorkspaceMetadata(artifactsDir: string, taskId: string): Promise<WorkspaceMetadata | null> {
  try {
    const raw = await readFile(workspaceMetadataPath(artifactsDir, taskId), "utf8");
    return JSON.parse(raw) as WorkspaceMetadata;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error(`Invalid workspace metadata for task: ${taskId}`), {
        code: "WORKSPACE_METADATA_INVALID"
      });
    }
    throw error;
  }
}

export async function writeWorkspaceMetadata(artifactsDir: string, taskId: string, metadata: WorkspaceMetadata) {
  const filePath = workspaceMetadataPath(artifactsDir, taskId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function workspaceMetadataPath(artifactsDir: string, taskId: string): string {
  return path.join(artifactsDir, taskId, "workspace.json");
}

export function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "-");
}

export async function getWorkspaceGitStatus(worktreePath: string): Promise<WorkspaceGitStatus> {
  const exists = await pathExists(worktreePath);
  if (!exists) {
    return {
      pathExists: false,
      isGitWorktree: false,
      clean: null,
      changedFiles: []
    };
  }

  const inside = await git(["-C", worktreePath, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return {
      pathExists: true,
      isGitWorktree: false,
      clean: null,
      changedFiles: []
    };
  }

  const status = await git(["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]);
  const changedFiles = status.ok ? parsePorcelainStatus(status.stdout) : [];
  return {
    pathExists: true,
    isGitWorktree: true,
    clean: status.ok ? changedFiles.length === 0 : null,
    changedFiles
  };
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function git(args: string[]): Promise<{ ok: true; stdout: string } | WorkspaceError> {
  try {
    const { stdout } = await execFileAsync("git", args, { encoding: "utf8" });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    const detail =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : String(error);
    return {
      ok: false,
      code: "GIT_COMMAND_FAILED",
      message: `git ${args.join(" ")} failed`,
      detail
    };
  }
}

function parsePorcelainStatus(stdout: string) {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .filter((filePath) => filePath.length > 0);
}
