import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

export type TaskResult =
  | { ok: true; task: Task; path: string }
  | { ok: false; code: string; message: string };

const defaultTasksDir = ".anchor/tasks";

export function tasksDirPath(tasksDir?: string): string {
  return tasksDir ?? defaultTasksDir;
}

export function taskFilePath(tasksDir: string, taskId: string): string {
  return path.join(tasksDir, `${sanitizeFilename(taskId)}.yaml`);
}

export function taskArtifactDir(tasksDir: string, taskId: string): string {
  return path.join(tasksDir, taskId);
}

export function validTaskStatuses(): string[] {
  return ["backlog", "in_progress", "done", "aborted"];
}

export function taskStatusFromState(state: string | null): Task["status"] {
  switch (state) {
    case null:
      return "backlog";
    case "DONE":
      return "done";
    case "ABORT":
      return "aborted";
    default:
      return "in_progress";
  }
}

export function nextTaskId(tasks: Task[]): string {
  const numbers = tasks
    .map((t) => {
      const match = /^TASK-(\d+)$/.exec(t.id);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `TASK-${String(max + 1).padStart(3, "0")}`;
}

export async function createTask(
  input: { title: string; description?: string; status?: Task["status"] },
  tasksDir?: string
): Promise<TaskResult> {
  const dir = tasksDirPath(tasksDir);
  const existing = await listTasks(dir);
  const id = nextTaskId(existing.tasks);
  const now = new Date().toISOString();

  const task: Task = {
    id,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "backlog",
    created_at: now,
    updated_at: now
  };

  const filePath = taskFilePath(dir, id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeTask(task));

  return { ok: true, task, path: filePath };
}

export async function readTask(taskId: string, tasksDir?: string): Promise<TaskResult> {
  const dir = tasksDirPath(tasksDir);
  const filePath = taskFilePath(dir, taskId);

  try {
    const content = await readFile(filePath, "utf8");
    const task = deserializeTask(content);
    if (!task) {
      return { ok: false, code: "TASK_PARSE_ERROR", message: `Failed to parse task file: ${filePath}` };
    }
    return { ok: true, task, path: filePath };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` };
    }
    throw error;
  }
}

export async function updateTask(
  taskId: string,
  updates: Partial<Pick<Task, "title" | "description" | "status">>,
  tasksDir?: string
): Promise<TaskResult> {
  const read = await readTask(taskId, tasksDir);
  if (!read.ok) {
    return read;
  }

  const now = new Date().toISOString();
  const task: Task = {
    ...read.task,
    ...updates,
    updated_at: now
  };

  await writeFile(read.path, serializeTask(task));
  return { ok: true, task, path: read.path };
}

export async function listTasks(
  tasksDir?: string,
  status?: Task["status"]
): Promise<TaskListResult> {
  const dir = tasksDirPath(tasksDir);

  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { tasks: [], total: 0 };
    }
    throw error;
  }

  const tasks: Task[] = [];
  for (const file of files) {
    if (!file.endsWith(".yaml") || file.startsWith("contract.")) continue;
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const task = deserializeTask(content);
      if (task && (!status || task.status === status)) {
        tasks.push(task);
      }
    } catch {
      // Skip unreadable files
    }
  }

  tasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { tasks, total: tasks.length };
}

export function serializeTask(task: Task): string {
  return [
    `id: ${quote(task.id)}`,
    `title: ${quote(task.title)}`,
    `description: ${quote(task.description)}`,
    `status: ${quote(task.status)}`,
    `created_at: ${quote(task.created_at)}`,
    `updated_at: ${quote(task.updated_at)}`,
    ""
  ].join("\n");
}

function deserializeTask(content: string): Task | null {
  try {
    const id = extractValue(content, "id");
    const title = extractValue(content, "title");
    if (!id || !title) return null;

    const validStatuses = ["backlog", "in_progress", "done", "aborted"];
    const statusRaw = extractValue(content, "status") ?? "backlog";

    return {
      id,
      title,
      description: extractValue(content, "description") ?? "",
      status: validStatuses.includes(statusRaw) ? (statusRaw as Task["status"]) : "backlog",
      created_at: extractValue(content, "created_at") ?? new Date().toISOString(),
      updated_at: extractValue(content, "updated_at") ?? new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function extractValue(content: string, key: string): string | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}:`)) {
      const raw = trimmed.slice(key.length + 1).trim();
      if (raw === "null") return "null";
      if (raw === "") return "";
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw;
      }
    }
  }
  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-");
}

function quote(value: string): string {
  return JSON.stringify(value);
}
