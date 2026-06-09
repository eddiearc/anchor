#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import { anchorVersion, createFileRunStore, getAnchorHelp, type Event, type StoredEvent } from "../index.js";

const defaultStorePath = ".anchor/runs.jsonl";

type CliResult = {
  exitCode: number;
  output: string;
};

type CliOptions = {
  storePath?: string;
};

export async function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  if (args.includes("--version") || args.includes("-v")) {
    return text(anchorVersion);
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return text(getAnchorHelp());
  }

  const [command, ...rest] = args;
  const storePath = options.storePath ?? process.env.ANCHOR_STORE_PATH ?? defaultStorePath;

  if (command === "demo") {
    return json(await runDemo(rest, storePath));
  }

  if (command === "status") {
    return json(await runStatus(rest[0], storePath));
  }

  if (command === "events") {
    return json(await runEvents(rest[0], storePath));
  }

  return {
    exitCode: 1,
    output: [`Unknown command: ${command}`, "", getAnchorHelp()].join("\n")
  };
}

async function runDemo(args: string[], storePath: string) {
  const fixture = readFixture(args);
  const store = createFileRunStore(storePath);
  const runId = `demo_${fixture}_${randomUUID()}`;
  const task = fixture === "retry" ? "Anchor deterministic retry demo" : "Anchor deterministic happy demo";
  const createResult = await store.createRun(task, { id: runId });
  if (!createResult.ok) {
    return { ok: false, error: createResult, storePath };
  }

  for (const step of fixtureEvents(fixture)) {
    const result = await store.appendEvent(runId, step.event, step.emittedBy);
    if (!result.ok) {
      return { ok: false, runId, fixture, storePath, error: result };
    }
  }

  const snapshot = await store.getCurrentState(runId);
  const events = await store.listEvents(runId);
  return {
    ok: true,
    command: "demo",
    fixture,
    runId,
    finalState: snapshot?.state ?? null,
    storePath,
    events: summarizeEvents(events)
  };
}

async function runStatus(runId: string | undefined, storePath: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath };
  }

  return {
    ok: true,
    command: "status",
    runId,
    state: snapshot.state,
    context: snapshot.context,
    storePath
  };
}

async function runEvents(runId: string | undefined, storePath: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath };
  }

  return {
    ok: true,
    command: "events",
    runId,
    state: snapshot.state,
    storePath,
    events: summarizeEvents(await store.listEvents(runId))
  };
}

function readFixture(args: string[]) {
  const index = args.indexOf("--fixture");
  if (index === -1) {
    return "happy";
  }
  const fixture = args[index + 1];
  if (fixture === "happy" || fixture === "retry") {
    return fixture;
  }
  throw new Error(`unsupported_fixture:${fixture ?? ""}`);
}

function fixtureEvents(fixture: "happy" | "retry"): Array<{ emittedBy: string; event: Event }> {
  const contract: Event = {
    type: "CONTRACT_PRODUCED",
    mode: "quick",
    reasoning: `${fixture} fixture uses quick mode`,
    affected_scope: ["src/"]
  };
  const firstBuild: Event = {
    type: "CODE_PRODUCED",
    report_path: `reports/${fixture}-generator-1.md`,
    files_changed: ["src/index.ts"],
    attempt: 1
  };

  if (fixture === "happy") {
    return [
      { emittedBy: "planner", event: contract },
      { emittedBy: "generator", event: firstBuild },
      { emittedBy: "evaluator", event: { type: "EVAL_COMPLETE", verdict: "PASS" } }
    ];
  }

  return [
    { emittedBy: "planner", event: contract },
    { emittedBy: "generator", event: firstBuild },
    { emittedBy: "evaluator", event: { type: "EVAL_COMPLETE", verdict: "FAIL" } },
    {
      emittedBy: "generator",
      event: {
        type: "CODE_PRODUCED",
        report_path: "reports/retry-generator-2.md",
        files_changed: ["src/index.ts"],
        attempt: 2
      }
    },
    { emittedBy: "evaluator", event: { type: "EVAL_COMPLETE", verdict: "PASS" } }
  ];
}

function summarizeEvents(events: StoredEvent[]) {
  return events.map((event) => ({
    seq: event.seq,
    event_type: event.event_type,
    emitted_by: event.emitted_by,
    state_before: event.state_before,
    state_after: event.state_after
  }));
}

function text(output: string): CliResult {
  return { exitCode: 0, output };
}

function json(value: unknown): CliResult {
  return {
    exitCode: 0,
    output: JSON.stringify(value, null, 2)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((result) => {
      console.log(result.output);
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
