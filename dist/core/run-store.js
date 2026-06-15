import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateEventSource } from "./permissions.js";
import { transition } from "./state-machine.js";
export const defaultContext = {
    retriesLeft: 3,
    reviewRetriesLeft: 2,
    stepRetriesLeft: 3,
    stepIds: [],
    currentStepId: null,
    completedStepIds: []
};
export function createFileRunStore(filePath) {
    const absolutePath = path.resolve(filePath);
    async function readRecords() {
        try {
            const content = await readFile(absolutePath, "utf8");
            return content
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line));
        }
        catch (error) {
            if (isNoEntry(error)) {
                return [];
            }
            throw error;
        }
    }
    async function writeRecords(records) {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        const content = records.map((record) => JSON.stringify(record)).join("\n");
        await writeFile(absolutePath, content.length > 0 ? `${content}\n` : "");
    }
    async function appendEventRecord(event) {
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
            const storedEvent = {
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
                .filter((record) => record.record_type === "event")
                .map((record) => record.event)
                .filter((event) => event.task_id === taskId)
                .sort((a, b) => a.seq - b.seq);
        },
        async getCurrentState(taskId) {
            const events = await this.listEvents(taskId);
            if (events.length === 0)
                return null;
            return replay(taskId, events);
        }
    };
}
function replay(taskId, events) {
    let state = null;
    let context = defaultContext;
    for (const storedEvent of events) {
        const result = transition(state, storedEvent.payload, context);
        if (!result.ok) {
            throw new Error(`stored_event_replay_failed:${taskId}:${storedEvent.seq}:${result.code}`);
        }
        state = result.state;
        context = result.context;
    }
    return { state, context };
}
function randomId(prefix) {
    return `${prefix}_${randomUUID()}`;
}
function isNoEntry(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
