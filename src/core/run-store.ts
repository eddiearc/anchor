import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  run_id: string;
  seq: number;
  event_type: Event["type"];
  payload: Event;
  emitted_by: EventEmitter;
  state_before: State | InitialState;
  state_after: State;
  context_after: RunContext;
  timestamp: string;
};

export type RunRecord = {
  id: string;
  task: string;
  context: RunContext;
  created_at: string;
};

export type CreateRunOptions = {
  id?: string;
  context?: Partial<RunContext>;
  timestamp?: string;
  emittedBy?: EventEmitter;
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
  code: "RUN_NOT_FOUND" | "INVALID_TRANSITION";
  message: string;
  transition?: TransitionError;
};

export type AppendEventResult = AppendEventOk | AppendEventError;

export type RunSnapshot = {
  run: RunRecord;
  state: State | InitialState;
  context: RunContext;
};

export type RunStore = {
  createRun(task: string, options?: CreateRunOptions): Promise<AppendEventResult>;
  appendEvent(
    runId: string,
    event: Event,
    emittedBy: EventEmitter,
    options?: AppendEventOptions
  ): Promise<AppendEventResult>;
  listEvents(runId: string): Promise<StoredEvent[]>;
  getCurrentState(runId: string): Promise<RunSnapshot | null>;
};

type JsonlRecord =
  | {
      record_type: "run_created";
      run: RunRecord;
    }
  | {
      record_type: "event";
      event: StoredEvent;
    };

const defaultContext: RunContext = {
  retriesLeft: 3,
  reviewRetriesLeft: 2
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

  async function listRuns(): Promise<RunRecord[]> {
    return (await readRecords())
      .filter((record): record is Extract<JsonlRecord, { record_type: "run_created" }> => record.record_type === "run_created")
      .map((record) => record.run);
  }

  async function getRun(runId: string): Promise<RunRecord | null> {
    const runs = await listRuns();
    return runs.find((run) => run.id === runId) ?? null;
  }

  async function appendStoredEvent(event: StoredEvent) {
    const records = await readRecords();
    records.push({ record_type: "event", event });
    await writeRecords(records);
  }

  return {
    async createRun(task, options = {}) {
      const runId = options.id ?? randomId("run");
      const createdAt = options.timestamp ?? new Date().toISOString();
      const run: RunRecord = {
        id: runId,
        task,
        context: {
          ...defaultContext,
          ...options.context
        },
        created_at: createdAt
      };

      const records = await readRecords();
      records.push({ record_type: "run_created", run });
      await writeRecords(records);

      return this.appendEvent(
        runId,
        {
          type: "TASK_RECEIVED",
          task
        },
        options.emittedBy ?? "system",
        { timestamp: createdAt }
      );
    },

    async appendEvent(runId, event, emittedBy, options = {}) {
      const run = await getRun(runId);
      if (!run) {
        return {
          ok: false,
          code: "RUN_NOT_FOUND",
          message: `Run not found: ${runId}`
        };
      }

      const events = await this.listEvents(runId);
      const current = replay(run, events);
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
        run_id: runId,
        seq: events.length + 1,
        event_type: event.type,
        payload: event,
        emitted_by: emittedBy,
        state_before: current.state,
        state_after: result.state,
        context_after: result.context,
        timestamp: options.timestamp ?? new Date().toISOString()
      };

      await appendStoredEvent(storedEvent);
      return { ok: true, event: storedEvent };
    },

    async listEvents(runId) {
      return (await readRecords())
        .filter((record): record is Extract<JsonlRecord, { record_type: "event" }> => record.record_type === "event")
        .map((record) => record.event)
        .filter((event) => event.run_id === runId)
        .sort((a, b) => a.seq - b.seq);
    },

    async getCurrentState(runId) {
      const run = await getRun(runId);
      if (!run) {
        return null;
      }
      return replay(run, await this.listEvents(runId));
    }
  };
}

function replay(run: RunRecord, events: StoredEvent[]): RunSnapshot {
  let state: State | InitialState = null;
  let context = run.context;

  for (const storedEvent of events) {
    const result = transition(state, storedEvent.payload, context);
    if (!result.ok) {
      throw new Error(`stored_event_replay_failed:${storedEvent.run_id}:${storedEvent.seq}:${result.code}`);
    }
    state = result.state;
    context = result.context;
  }

  return {
    run,
    state,
    context
  };
}

function randomId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function isNoEntry(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
