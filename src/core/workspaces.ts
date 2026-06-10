import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceMetadata = {
  runId: string;
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
  runsDir: string;
  worktreesDir: string;
  runId: string;
  contractSha: string;
  timestamp?: string;
}): Promise<WorkspaceCreateResult> {
  const existing = await readWorkspaceMetadata(input.runsDir, input.runId);
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

  const safeRunId = sanitizeRunId(input.runId);
  const worktreePath = path.resolve(input.worktreesDir, safeRunId);
  if (await pathExists(worktreePath)) {
    return {
      ok: false,
      code: "WORKTREE_PATH_EXISTS",
      message: `Refusing to use existing path without Anchor metadata: ${worktreePath}`
    };
  }

  const metadata: WorkspaceMetadata = {
    runId: input.runId,
    baseCommit: baseCommit.stdout,
    branch: `anchor/${safeRunId}`,
    worktreePath,
    createdAt: input.timestamp ?? new Date().toISOString(),
    contractSha: input.contractSha
  };

  await mkdir(path.dirname(worktreePath), { recursive: true });
  const add = await git(["worktree", "add", "-b", metadata.branch, metadata.worktreePath, metadata.baseCommit]);
  if (!add.ok) {
    return add;
  }

  await writeWorkspaceMetadata(input.runsDir, input.runId, metadata);
  return {
    ok: true,
    created: true,
    metadata,
    status: await getWorkspaceGitStatus(metadata.worktreePath)
  };
}

export async function cleanupGitWorkspace(input: {
  runsDir: string;
  runId: string;
  timestamp?: string;
}): Promise<WorkspaceCleanupResult> {
  const metadata = await readWorkspaceMetadata(input.runsDir, input.runId);
  if (!metadata) {
    return {
      ok: false,
      code: "WORKSPACE_NOT_FOUND",
      message: `Workspace metadata not found for run: ${input.runId}`
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
  await writeWorkspaceMetadata(input.runsDir, input.runId, cleaned);
  return {
    ok: true,
    cleaned: true,
    metadata: cleaned,
    status: await getWorkspaceGitStatus(cleaned.worktreePath)
  };
}

export async function readWorkspaceStatus(runsDir: string, runId: string) {
  const metadata = await readWorkspaceMetadata(runsDir, runId);
  if (!metadata) {
    return null;
  }

  return {
    metadata,
    status: await getWorkspaceGitStatus(metadata.worktreePath)
  };
}

export async function readWorkspaceMetadata(runsDir: string, runId: string): Promise<WorkspaceMetadata | null> {
  try {
    const raw = await readFile(workspaceMetadataPath(runsDir, runId), "utf8");
    return JSON.parse(raw) as WorkspaceMetadata;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error(`Invalid workspace metadata for run: ${runId}`), {
        code: "WORKSPACE_METADATA_INVALID"
      });
    }
    throw error;
  }
}

export async function writeWorkspaceMetadata(runsDir: string, runId: string, metadata: WorkspaceMetadata) {
  const filePath = workspaceMetadataPath(runsDir, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function workspaceMetadataPath(runsDir: string, runId: string): string {
  return path.join(runsDir, runId, "workspace.json");
}

export function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "-");
}

async function getWorkspaceGitStatus(worktreePath: string): Promise<WorkspaceGitStatus> {
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
