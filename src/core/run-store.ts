import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateEventSource } from "./permissions.js";
import {
  type Event,
  type InitialState,
  type RunContext,
  type State,
  type TransitionError,
  transition
} from "./state-machine.js";

export type EventEmitter = "system" | "planner" | "reviewer" | "generator" | "evaluator" | "human" | string;

export type StoredEvent = {
  id: string;
  task_id: string;
  seq: number;
  event_type: Event["type"];
  payload: Event;
  emitted_by: EventEmitter;
  state_before: State | InitialState;
  state_after: State;
  context_after: RunContext;
  timestamp: string;
};

export type AppendEventOptions = {
  timestamp?: string;
};

export type AppendEventOk = {
  ok: true;
  event: StoredEvent;
};

export type AppendEventError = {
  ok: false;
  code: "UNAUTHORIZED_EVENT_SOURCE" | "INVALID_TRANSITION";
  message: string;
  transition?: TransitionError;
};

export type AppendEventResult = AppendEventOk | AppendEventError;

export type TaskSnapshot = {
  state: State | InitialState;
  context: RunContext;
};

export const defaultContext: RunContext = {
  retriesLeft: 3,
  reviewRetriesLeft: 2
};

export type RunStore = {
  appendEvent(
    taskId: string,
    event: Event,
    emittedBy: EventEmitter,
    options?: AppendEventOptions
  ): Promise<AppendEventResult>;
  listEvents(taskId: string): Promise<StoredEvent[]>;
  getCurrentState(taskId: string): Promise<TaskSnapshot | null>;
};

type JsonlRecord = {
  record_type: "event";
  event: StoredEvent;
};

export function createFileRunStore(filePath: string): RunStore {
  const absolutePath = path.resolve(filePath);

  async function readRecords(): Promise<JsonlRecord[]> {
    try {
      const content = await readFile(absolutePath, "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonlRecord);
    } catch (error) {
      if (isNoEntry(error)) {
        return [];
      }
      throw error;
    }
  }

  async function writeRecords(records: JsonlRecord[]) {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const content = records.map((record) => JSON.stringify(record)).join("\n");
    await writeFile(absolutePath, content.length > 0 ? `${content}\n` : "");
  }

  async function appendEventRecord(event: StoredEvent) {
    const records = await readRecords();
    records.push({ record_type: "event", event });
    await writeRecords(records);
  }

  return {
    async appendEvent(taskId, event, emittedBy, options = {}) {
      const sourcePermission = validateEventSource(emittedBy, event.type);
      if (!sourcePermission.ok) {
        return {
          ok: false,
          code: "UNAUTHORIZED_EVENT_SOURCE",
          message: sourcePermission.message
        };
      }

      const events = await this.listEvents(taskId);
      const current = replay(taskId, events);
      const result = transition(current.state, event, current.context);
      if (!result.ok) {
        return {
          ok: false,
          code: "INVALID_TRANSITION",
          message: result.message,
          transition: result
        };
      }

      const storedEvent: StoredEvent = {
        id: randomId("event"),
        task_id: taskId,
        seq: events.length + 1,
        event_type: event.type,
        payload: event,
        emitted_by: emittedBy,
        state_before: current.state,
        state_after: result.state,
        context_after: result.context,
        timestamp: options.timestamp ?? new Date().toISOString()
      };

      await appendEventRecord(storedEvent);
      return { ok: true, event: storedEvent };
    },

    async listEvents(taskId) {
      return (await readRecords())
        .filter((record): record is Extract<JsonlRecord, { record_type: "event" }> => record.record_type === "event")
        .map((record) => record.event)
        .filter((event) => event.task_id === taskId)
        .sort((a, b) => a.seq - b.seq);
    },

    async getCurrentState(taskId) {
      const events = await this.listEvents(taskId);
      if (events.length === 0) return null;
      return replay(taskId, events);
    }
  };
}

function replay(taskId: string, events: StoredEvent[]): TaskSnapshot {
  let state: State | InitialState = null;
  let context = defaultContext;

  for (const storedEvent of events) {
    const result = transition(state, storedEvent.payload, context);
    if (!result.ok) {
      throw new Error(
        `stored_event_replay_failed:${taskId}:${storedEvent.seq}:${result.code}`
      );
    }
    state = result.state;
    context = result.context;
  }

  return { state, context };
}

function randomId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function isNoEntry(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
