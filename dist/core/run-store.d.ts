import { type Event, type InitialState, type RunContext, type State, type TransitionError } from "./state-machine.js";
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
export declare const defaultContext: RunContext;
export type RunStore = {
    appendEvent(taskId: string, event: Event, emittedBy: EventEmitter, options?: AppendEventOptions): Promise<AppendEventResult>;
    listEvents(taskId: string): Promise<StoredEvent[]>;
    getCurrentState(taskId: string): Promise<TaskSnapshot | null>;
};
export declare function createFileRunStore(filePath: string): RunStore;
