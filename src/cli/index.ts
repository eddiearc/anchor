#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import {
  anchorVersion,
  createFileRunStore,
  createGitWorkspace,
  createTemplateContract,
  cleanupGitWorkspace,
  getAnchorHelp,
  readContractArtifact,
  readWorkspaceStatus,
  runFixtureGenerator,
  writeContractArtifact,
  type Event,
  type StoredEvent
} from "../index.js";

const defaultStorePath = ".anchor/runs.jsonl";
const defaultRunsDir = ".anchor/runs";
const defaultWorktreesDir = ".anchor/worktrees";

type CliResult = {
  exitCode: number;
  output: string;
};

type CliOptions = {
  storePath?: string;
  runsDir?: string;
  worktreesDir?: string;
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
  const runsDir = options.runsDir ?? process.env.ANCHOR_RUNS_DIR ?? defaultRunsDir;
  const worktreesDir = options.worktreesDir ?? process.env.ANCHOR_WORKTREES_DIR ?? defaultWorktreesDir;

  if (command === "plan") {
    return json(await runPlan(rest, storePath, runsDir));
  }

  if (command === "contract") {
    return json(await runContract(rest[0], storePath, runsDir));
  }

  if (command === "approve") {
    return json(await runApprove(rest[0], storePath, runsDir));
  }

  if (command === "workspace") {
    return json(await runWorkspace(rest, storePath, runsDir, worktreesDir));
  }

  if (command === "generate") {
    return json(await runGenerate(rest, storePath, runsDir, worktreesDir));
  }

  if (command === "demo") {
    return json(await runDemo(rest, storePath));
  }

  if (command === "status") {
    return json(await runStatus(rest[0], storePath, runsDir));
  }

  if (command === "events") {
    return json(await runEvents(rest[0], storePath));
  }

  return {
    exitCode: 1,
    output: [`Unknown command: ${command}`, "", getAnchorHelp()].join("\n")
  };
}

async function runGenerate(args: string[], storePath: string, runsDir: string, worktreesDir: string) {
  const runId = args[0];
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath, runsDir, worktreesDir };
  }

  const adapter = readOption(args, "--adapter") ?? "fixture";
  const fixture = readOption(args, "--fixture");
  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath, runsDir, worktreesDir };
  }
  if (snapshot.state !== "BUILD") {
    return {
      ok: false,
      error: "generate_requires_build_state",
      runId,
      state: snapshot.state,
      storePath,
      runsDir,
      worktreesDir
    };
  }

  const workspace = await readWorkspaceStatus(runsDir, runId);
  if (!workspace || workspace.metadata.cleanedAt || !workspace.status.pathExists || !workspace.status.isGitWorktree) {
    return {
      ok: false,
      error: "workspace_required",
      runId,
      state: snapshot.state,
      storePath,
      runsDir,
      worktreesDir,
      workspace
    };
  }

  const contract = await readContractArtifact(runsDir, runId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", runId, state: snapshot.state, storePath, runsDir, worktreesDir };
  }

  const events = await store.listEvents(runId);
  const attempt = events.filter((event) => event.event_type === "CODE_PRODUCED").length + 1;
  const result = await runFixtureGenerator({
    runId,
    runsDir,
    workspace: workspace.metadata,
    contract: contract.content,
    adapter,
    fixture,
    attempt
  });

  if (!result.ok) {
    return {
      ok: false,
      command: "generate",
      error: result,
      runId,
      state: snapshot.state,
      storePath,
      runsDir,
      worktreesDir
    };
  }

  const eventResult = await store.appendEvent(
    runId,
    {
      type: "CODE_PRODUCED",
      report_path: result.reportPath,
      files_changed: result.filesChanged,
      attempt
    },
    "generator"
  );
  if (!eventResult.ok) {
    return {
      ok: false,
      command: "generate",
      error: eventResult,
      runId,
      state: snapshot.state,
      storePath,
      runsDir,
      worktreesDir,
      reportPath: result.reportPath
    };
  }

  return {
    ok: true,
    command: "generate",
    runId,
    state: (await store.getCurrentState(runId))?.state ?? eventResult.event.state_after,
    storePath,
    runsDir,
    worktreesDir,
    reportPath: result.reportPath,
    filesChanged: result.filesChanged,
    event: summarizeEvent(eventResult.event)
  };
}

async function runWorkspace(args: string[], storePath: string, runsDir: string, worktreesDir: string) {
  const [subcommand, runId] = args;
  if (!subcommand || !["create", "status", "cleanup"].includes(subcommand)) {
    return {
      ok: false,
      error: "workspace_subcommand_required",
      usage: "anchor workspace <create|status|cleanup> <runId>",
      storePath,
      runsDir,
      worktreesDir
    };
  }

  if (subcommand === "create") {
    return runWorkspaceCreate(runId, storePath, runsDir, worktreesDir);
  }

  if (subcommand === "status") {
    return runWorkspaceStatus(runId, storePath, runsDir, worktreesDir);
  }

  return runWorkspaceCleanup(runId, storePath, runsDir, worktreesDir);
}

async function runWorkspaceCreate(runId: string | undefined, storePath: string, runsDir: string, worktreesDir: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath, runsDir, worktreesDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath, runsDir, worktreesDir };
  }
  if (snapshot.state !== "BUILD") {
    return {
      ok: false,
      error: "workspace_requires_approved_build_state",
      runId,
      state: snapshot.state,
      storePath,
      runsDir,
      worktreesDir
    };
  }

  const events = await store.listEvents(runId);
  const contractSha = latestApprovedContractSha(events);
  if (!contractSha) {
    return { ok: false, error: "approved_contract_sha_required", runId, state: snapshot.state, storePath, runsDir, worktreesDir };
  }

  const workspace = await createGitWorkspace({
    runsDir,
    worktreesDir,
    runId,
    contractSha
  });
  if (!workspace.ok) {
    return { ok: false, error: workspace, runId, state: snapshot.state, storePath, runsDir, worktreesDir };
  }

  let event = null;
  if (workspace.created) {
    const result = await store.appendEvent(
      runId,
      {
        type: "WORKSPACE_CREATED",
        base_commit: workspace.metadata.baseCommit,
        branch: workspace.metadata.branch,
        worktree_path: workspace.metadata.worktreePath,
        contract_sha: workspace.metadata.contractSha
      },
      "system"
    );
    if (!result.ok) {
      return { ok: false, error: result, runId, state: snapshot.state, storePath, runsDir, worktreesDir, workspace };
    }
    event = summarizeEvent(result.event);
  }

  return {
    ok: true,
    command: "workspace create",
    runId,
    state: (await store.getCurrentState(runId))?.state ?? snapshot.state,
    storePath,
    runsDir,
    worktreesDir,
    created: workspace.created,
    workspace: workspace.metadata,
    status: workspace.status,
    event
  };
}

async function runWorkspaceStatus(runId: string | undefined, storePath: string, runsDir: string, worktreesDir: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath, runsDir, worktreesDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath, runsDir, worktreesDir };
  }

  const workspace = await readWorkspaceStatus(runsDir, runId);
  if (!workspace) {
    return {
      ok: false,
      error: "workspace_not_found",
      runId,
      state: snapshot.state,
      storePath,
      runsDir,
      worktreesDir
    };
  }

  return {
    ok: true,
    command: "workspace status",
    runId,
    state: snapshot.state,
    storePath,
    runsDir,
    worktreesDir,
    workspace: workspace.metadata,
    status: workspace.status
  };
}

async function runWorkspaceCleanup(runId: string | undefined, storePath: string, runsDir: string, worktreesDir: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath, runsDir, worktreesDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath, runsDir, worktreesDir };
  }

  const workspace = await cleanupGitWorkspace({ runsDir, runId });
  if (!workspace.ok) {
    return { ok: false, error: workspace, runId, state: snapshot.state, storePath, runsDir, worktreesDir };
  }

  let event = null;
  if (workspace.cleaned) {
    const result = await store.appendEvent(
      runId,
      {
        type: "WORKSPACE_CLEANED",
        worktree_path: workspace.metadata.worktreePath
      },
      "system"
    );
    if (!result.ok) {
      return { ok: false, error: result, runId, state: snapshot.state, storePath, runsDir, worktreesDir, workspace };
    }
    event = summarizeEvent(result.event);
  }

  return {
    ok: true,
    command: "workspace cleanup",
    runId,
    state: (await store.getCurrentState(runId))?.state ?? snapshot.state,
    storePath,
    runsDir,
    worktreesDir,
    cleaned: workspace.cleaned,
    workspace: workspace.metadata,
    status: workspace.status,
    event
  };
}

async function runPlan(args: string[], storePath: string, runsDir: string) {
  const task = args.join(" ").trim();
  if (!task) {
    return { ok: false, error: "task_required", storePath, runsDir };
  }

  const store = createFileRunStore(storePath);
  const runId = `run_${randomUUID()}`;
  const createResult = await store.createRun(task, { id: runId });
  if (!createResult.ok) {
    return { ok: false, error: createResult, storePath, runsDir };
  }

  const contract = await writeContractArtifact(runsDir, runId, createTemplateContract(task, runId));
  const produced = await store.appendEvent(
    runId,
    {
      type: "CONTRACT_PRODUCED",
      mode: "standard",
      reasoning: "Deterministic R5 template contract generated by CLI.",
      affected_scope: contractAffectedScope(),
      contract_id: contract.contractId
    },
    "planner"
  );
  if (!produced.ok) {
    return { ok: false, runId, error: produced, storePath, runsDir, contractPath: contract.path, contractSha: contract.sha };
  }

  const snapshot = await store.getCurrentState(runId);
  return {
    ok: true,
    command: "plan",
    runId,
    state: snapshot?.state ?? null,
    storePath,
    runsDir,
    contractPath: contract.path,
    contractId: contract.contractId,
    contractSha: contract.sha
  };
}

async function runContract(runId: string | undefined, storePath: string, runsDir: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath, runsDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath, runsDir };
  }

  const contract = await readContractArtifact(runsDir, runId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", runId, storePath, runsDir };
  }

  const events = await store.listEvents(runId);
  return {
    ok: true,
    command: "contract",
    runId,
    state: snapshot.state,
    storePath,
    runsDir,
    ...contractMetadata(contract, events),
    contract: contract.content
  };
}

async function runApprove(runId: string | undefined, storePath: string, runsDir: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath, runsDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath, runsDir };
  }

  const contract = await readContractArtifact(runsDir, runId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", runId, state: snapshot.state, storePath, runsDir };
  }

  const result = await store.appendEvent(
    runId,
    {
      type: "CONTRACT_APPROVED",
      contract_id: contract.contractId,
      contract_sha: contract.sha
    },
    "human"
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result,
      runId,
      state: snapshot.state,
      storePath,
      runsDir,
      contractPath: contract.path,
      contractSha: contract.sha
    };
  }

  const approvedSnapshot = await store.getCurrentState(runId);
  return {
    ok: true,
    command: "approve",
    runId,
    state: approvedSnapshot?.state ?? result.event.state_after,
    storePath,
    runsDir,
    contractPath: contract.path,
    contractId: contract.contractId,
    contractSha: contract.sha,
    event: summarizeEvent(result.event)
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

async function runStatus(runId: string | undefined, storePath: string, runsDir: string) {
  if (!runId) {
    return { ok: false, error: "run_id_required", storePath, runsDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(runId);
  if (!snapshot) {
    return { ok: false, error: "run_not_found", runId, storePath, runsDir };
  }

  const events = await store.listEvents(runId);
  const contract = await readContractArtifact(runsDir, runId);

  return {
    ok: true,
    command: "status",
    runId,
    state: snapshot.state,
    context: snapshot.context,
    storePath,
    runsDir,
    contract: contract ? contractMetadata(contract, events) : missingContractMetadata(events)
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

function readOption(args: string[], option: string) {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
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
  return events.map(summarizeEvent);
}

function summarizeEvent(event: StoredEvent) {
  return {
    seq: event.seq,
    event_type: event.event_type,
    payload: event.payload,
    emitted_by: event.emitted_by,
    state_before: event.state_before,
    state_after: event.state_after
  };
}

function contractAffectedScope() {
  return ["src/**", "tests/**", "README.md", "package.json", "tsconfig*.json"];
}

type ContractMetadata = {
  contractPath: string;
  contractId: string;
  contractSha: string;
  approvedContractSha: string | null;
  dirty: boolean;
  warnings: string[];
};

function contractMetadata(contract: { path: string; contractId: string; sha: string }, events: StoredEvent[]): ContractMetadata {
  const approvedContractSha = latestApprovedContractSha(events);
  const dirty = approvedContractSha !== null && approvedContractSha !== contract.sha;
  return {
    contractPath: contract.path,
    contractId: contract.contractId,
    contractSha: contract.sha,
    approvedContractSha,
    dirty,
    warnings: dirty ? ["contract_sha_mismatch: artifact was modified after approval"] : []
  };
}

function missingContractMetadata(events: StoredEvent[]) {
  const approvedContractSha = latestApprovedContractSha(events);
  if (!approvedContractSha) {
    return null;
  }
  return {
    contractPath: null,
    contractId: null,
    contractSha: null,
    approvedContractSha,
    dirty: true,
    warnings: ["contract_missing: approved contract artifact is missing"]
  };
}

function latestApprovedContractSha(events: StoredEvent[]) {
  for (const event of [...events].reverse()) {
    if (event.event_type === "CONTRACT_APPROVED" && "contract_sha" in event.payload) {
      return event.payload.contract_sha ?? null;
    }
  }
  return null;
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
