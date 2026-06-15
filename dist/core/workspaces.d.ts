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
export type WorkspaceCreateResult = {
    ok: true;
    created: boolean;
    metadata: WorkspaceMetadata;
    status: WorkspaceGitStatus;
} | WorkspaceError;
export type WorkspaceCleanupResult = {
    ok: true;
    cleaned: boolean;
    metadata: WorkspaceMetadata;
    status: WorkspaceGitStatus;
} | WorkspaceError;
export type WorkspaceError = {
    ok: false;
    code: "NOT_GIT_REPO" | "GIT_COMMAND_FAILED" | "WORKSPACE_NOT_FOUND" | "WORKTREE_PATH_EXISTS" | "WORKSPACE_ALREADY_CLEANED" | "WORKSPACE_METADATA_INVALID";
    message: string;
    detail?: string;
};
export declare function createGitWorkspace(input: {
    artifactsDir: string;
    worktreesDir: string;
    taskId: string;
    contractSha: string;
    timestamp?: string;
}): Promise<WorkspaceCreateResult>;
export declare function cleanupGitWorkspace(input: {
    artifactsDir: string;
    taskId: string;
    timestamp?: string;
}): Promise<WorkspaceCleanupResult>;
export declare function readWorkspaceStatus(artifactsDir: string, taskId: string): Promise<{
    metadata: WorkspaceMetadata;
    status: WorkspaceGitStatus;
} | null>;
export declare function readWorkspaceMetadata(artifactsDir: string, taskId: string): Promise<WorkspaceMetadata | null>;
export declare function writeWorkspaceMetadata(artifactsDir: string, taskId: string, metadata: WorkspaceMetadata): Promise<void>;
export declare function workspaceMetadataPath(artifactsDir: string, taskId: string): string;
export declare function sanitizeTaskId(taskId: string): string;
export declare function getWorkspaceGitStatus(worktreePath: string): Promise<WorkspaceGitStatus>;
