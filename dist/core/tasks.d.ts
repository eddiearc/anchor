export type Task = {
    id: string;
    title: string;
    description: string;
    status: "backlog" | "in_progress" | "done" | "aborted";
    created_at: string;
    updated_at: string;
};
export type TaskListResult = {
    tasks: Task[];
    total: number;
};
export type TaskResult = {
    ok: true;
    task: Task;
    path: string;
} | {
    ok: false;
    code: string;
    message: string;
};
export declare function tasksDirPath(tasksDir?: string): string;
export declare function taskFilePath(tasksDir: string, taskId: string): string;
export declare function taskArtifactDir(tasksDir: string, taskId: string): string;
export declare function validTaskStatuses(): string[];
export declare function taskStatusFromState(state: string | null): Task["status"];
export declare function nextTaskId(tasks: Task[]): string;
export declare function createTask(input: {
    title: string;
    description?: string;
    status?: Task["status"];
}, tasksDir?: string): Promise<TaskResult>;
export declare function readTask(taskId: string, tasksDir?: string): Promise<TaskResult>;
export declare function updateTask(taskId: string, updates: Partial<Pick<Task, "title" | "description" | "status">>, tasksDir?: string): Promise<TaskResult>;
export declare function listTasks(tasksDir?: string, status?: Task["status"]): Promise<TaskListResult>;
export declare function serializeTask(task: Task): string;
