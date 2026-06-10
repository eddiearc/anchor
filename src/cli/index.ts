#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import {
  anchorVersion,
  createFileRunStore,
  createGitWorkspace,
  createTask,
  cleanupGitWorkspace,
  getAnchorHelp,
  listTasks,
  loadAnchorConfig,
  readContractArtifact,
  readTask,
  readWorkspaceStatus,
  runGenerator,
  runEvaluator,
  runPlanner,
  runReviewer,
  generatorAttemptReportPath,
  evaluatorAttemptReportPath,
  updateTask,
  writeRawContract,
  taskStatusFromState,
  type AnchorConfig,
  type Event,
  type State,
  type StoredEvent,
  type Task
} from "../index.js";

const defaultStorePath = ".anchor/events.jsonl";
const defaultTasksDir = ".anchor/tasks";
const defaultWorktreesDir = ".anchor/worktrees";

type CliResult = {
  exitCode: number;
  output: string;
};

type CliOptions = {
  storePath?: string;
  tasksDir?: string;
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
  const tasksDir = options.tasksDir ?? process.env.ANCHOR_TASKS_DIR ?? defaultTasksDir;
  const worktreesDir = options.worktreesDir ?? process.env.ANCHOR_WORKTREES_DIR ?? defaultWorktreesDir;
  const config: AnchorConfig = await loadAnchorConfig();

  if (command === "task") {
    return json(await runTask(rest, tasksDir, storePath));
  }

  if (command === "plan") {
    return json(await runPlan(rest, storePath, tasksDir, config));
  }

  if (command === "contract") {
    return json(await runContract(rest[0], storePath, tasksDir));
  }

  if (command === "approve") {
    return json(await runApprove(rest[0], storePath, tasksDir));
  }

  if (command === "workspace") {
    return json(await runWorkspace(rest, storePath, tasksDir, worktreesDir));
  }

  if (command === "generate") {
    return json(await runGenerate(rest, storePath, tasksDir, worktreesDir, config));
  }

  if (command === "evaluate") {
    return json(await runEvaluate(rest, storePath, tasksDir, worktreesDir, config));
  }

  if (command === "run-retry") {
    return json(await runRetry(rest, storePath, tasksDir, worktreesDir, config));
  }

  if (command === "review") {
    return json(await runReview(rest, storePath, tasksDir, config));
  }

  if (command === "abort") {
    return json(await runAbort(rest, storePath, tasksDir));
  }

  if (command === "force-pass") {
    return json(await runForcePass(rest, storePath, tasksDir));
  }

  if (command === "amend-plan") {
    return json(await runAmendPlan(rest, storePath, tasksDir));
  }

  if (command === "demo") {
    return json(await runDemo(rest, storePath));
  }

  if (command === "status") {
    return json(await runStatus(rest[0], storePath, tasksDir));
  }

  if (command === "events") {
    return json(await runEvents(rest[0], storePath));
  }

  return {
    exitCode: 1,
    output: [`Unknown command: ${command}`, "", getAnchorHelp()].join("\n")
  };
}

// ── plan ──

async function runPlan(args: string[], storePath: string, tasksDir: string, config: AnchorConfig) {
  const adapter = readOption(args, "--adapter") ?? "fixture";
  const taskIdFlag = readOption(args, "--task");
  let taskStr: string;
  let taskId: string;

  if (taskIdFlag) {
    const taskResult = await readTask(taskIdFlag, tasksDir);
    if (!taskResult.ok) {
      return { ok: false, error: "task_not_found", details: taskResult, taskId: taskIdFlag, storePath, tasksDir };
    }
    taskId = taskResult.task.id;
    taskStr = taskResult.task.title;
    if (taskResult.task.description) {
      taskStr = `${taskStr}\n\n${taskResult.task.description}`;
    }
  } else {
    taskStr = args.join(" ").trim();
    if (!taskStr) {
      return { ok: false, error: "task_required", storePath, tasksDir };
    }
    const createResult = await createTask({ title: taskStr }, tasksDir);
    if (!createResult.ok) {
      return { ok: false, error: createResult, storePath, tasksDir };
    }
    taskId = createResult.task.id;
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (snapshot) {
    return { ok: false, error: "task_already_started", taskId, state: snapshot.state, storePath, tasksDir };
  }

  // Append TASK_RECEIVED to start the state machine
  const received = await store.appendEvent(
    taskId,
    { type: "TASK_RECEIVED", task: taskStr },
    "system"
  );
  if (!received.ok) {
    return { ok: false, taskId, error: received, storePath, tasksDir };
  }

  // Update task status to in_progress
  await updateTask(taskId, { status: "in_progress" }, tasksDir);

  // Run planner to produce contract
  const mode = parseMode(readOption(args, "--mode"));
  const planResult = await runPlanner({
    taskId,
    taskDescription: taskStr,
    artifactsDir: tasksDir,
    adapter,
    repoPath: process.cwd(),
    config,
    mode
  });
  if (!planResult.ok) {
    return { ok: false, error: planResult, taskId, storePath, tasksDir };
  }

  // Write contract and append CONTRACT_PRODUCED
  const contract = await writeRawContract(tasksDir, taskId, planResult.contractYaml);
  const produced = await store.appendEvent(
    taskId,
    {
      type: "CONTRACT_PRODUCED",
      mode: planResult.mode,
      reasoning: planResult.reasoning,
      affected_scope: planResult.affectedScope,
      contract_id: contract.contractId
    },
    "planner"
  );
  if (!produced.ok) {
    return { ok: false, taskId, error: produced, storePath, tasksDir, contractPath: contract.path, contractSha: contract.sha };
  }

  const finalSnapshot = await store.getCurrentState(taskId);
  // Sync task status from state
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "plan",
    taskId,
    state: finalSnapshot?.state ?? null,
    storePath,
    tasksDir,
    contractPath: contract.path,
    contractId: contract.contractId,
    contractSha: contract.sha
  };
}

// ── contract ──

async function runContract(taskId: string | undefined, storePath: string, tasksDir: string) {
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir };
  }

  const contract = await readContractArtifact(tasksDir, taskId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", taskId, storePath, tasksDir };
  }

  const events = await store.listEvents(taskId);
  return {
    ok: true,
    command: "contract",
    taskId,
    state: snapshot.state,
    storePath,
    tasksDir,
    ...contractMetadata(contract, events),
    contract: contract.content
  };
}

// ── approve ──

async function runApprove(taskId: string | undefined, storePath: string, tasksDir: string) {
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir };
  }

  const contract = await readContractArtifact(tasksDir, taskId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", taskId, state: snapshot.state, storePath, tasksDir };
  }

  const result = await store.appendEvent(
    taskId,
    {
      type: "CONTRACT_APPROVED",
      contract_id: contract.contractId,
      contract_sha: contract.sha
    },
    "human"
  );
  if (!result.ok) {
    return { ok: false, error: result, taskId, state: snapshot.state, storePath, tasksDir, contractPath: contract.path, contractSha: contract.sha };
  }

  const approvedSnapshot = await store.getCurrentState(taskId);
  if (approvedSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(approvedSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "approve",
    taskId,
    state: approvedSnapshot?.state ?? result.event.state_after,
    storePath,
    tasksDir,
    contractPath: contract.path,
    contractId: contract.contractId,
    contractSha: contract.sha,
    event: summarizeEvent(result.event)
  };
}

// ── workspace ──

async function runWorkspace(args: string[], storePath: string, tasksDir: string, worktreesDir: string) {
  const [subcommand, taskId] = args;
  if (!subcommand || !["create", "status", "cleanup"].includes(subcommand)) {
    return { ok: false, error: "workspace_subcommand_required", usage: "anchor workspace <create|status|cleanup> <taskId>", storePath, tasksDir, worktreesDir };
  }
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir, worktreesDir };
  }

  if (subcommand === "create") return runWorkspaceCreate(taskId, storePath, tasksDir, worktreesDir);
  if (subcommand === "status") return runWorkspaceStatus(taskId, storePath, tasksDir, worktreesDir);
  return runWorkspaceCleanup(taskId, storePath, tasksDir, worktreesDir);
}

async function runWorkspaceCreate(taskId: string, storePath: string, tasksDir: string, worktreesDir: string) {
  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir, worktreesDir };
  }
  if (snapshot.state !== "BUILD") {
    return { ok: false, error: "workspace_requires_build_state", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const events = await store.listEvents(taskId);
  const contractSha = latestApprovedContractSha(events);
  if (!contractSha) {
    return { ok: false, error: "approved_contract_sha_required", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const workspace = await createGitWorkspace({
    artifactsDir: tasksDir,
    worktreesDir,
    taskId,
    contractSha
  });
  if (!workspace.ok) {
    return { ok: false, error: workspace, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  let event = null;
  if (workspace.created) {
    const result = await store.appendEvent(
      taskId,
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
      return { ok: false, error: result, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir, workspace };
    }
    event = summarizeEvent(result.event);
  }

  return {
    ok: true,
    command: "workspace create",
    taskId,
    state: (await store.getCurrentState(taskId))?.state ?? snapshot.state,
    storePath,
    tasksDir,
    worktreesDir,
    created: workspace.created,
    workspace: workspace.metadata,
    status: workspace.status,
    event
  };
}

async function runWorkspaceStatus(taskId: string, storePath: string, tasksDir: string, worktreesDir: string) {
  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir, worktreesDir };
  }

  const workspace = await readWorkspaceStatus(tasksDir, taskId);
  if (!workspace) {
    return { ok: false, error: "workspace_not_found", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  return {
    ok: true,
    command: "workspace status",
    taskId,
    state: snapshot.state,
    storePath,
    tasksDir,
    worktreesDir,
    workspace: workspace.metadata,
    status: workspace.status
  };
}

async function runWorkspaceCleanup(taskId: string, storePath: string, tasksDir: string, worktreesDir: string) {
  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir, worktreesDir };
  }
  if (snapshot.state === "DONE" || snapshot.state === "ABORT") {
    return { ok: false, error: "workspace_cleanup_rejected_in_terminal_state", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const workspace = await cleanupGitWorkspace({ artifactsDir: tasksDir, taskId });
  if (!workspace.ok) {
    return { ok: false, error: workspace, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  let event = null;
  if (workspace.cleaned) {
    const result = await store.appendEvent(
      taskId,
      { type: "WORKSPACE_CLEANED", worktree_path: workspace.metadata.worktreePath },
      "system"
    );
    if (!result.ok) {
      return { ok: false, error: result, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir, workspace };
    }
    event = summarizeEvent(result.event);
  }

  return {
    ok: true,
    command: "workspace cleanup",
    taskId,
    state: (await store.getCurrentState(taskId))?.state ?? snapshot.state,
    storePath,
    tasksDir,
    worktreesDir,
    cleaned: workspace.cleaned,
    workspace: workspace.metadata,
    status: workspace.status,
    event
  };
}

// ── generate ──

async function runGenerate(args: string[], storePath: string, tasksDir: string, worktreesDir: string, _config: AnchorConfig) {
  const taskId = args[0];
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir, worktreesDir };
  }

  const adapter = readOption(args, "--adapter") ?? "fixture";
  const fixture = readOption(args, "--fixture");
  const allowNetwork = isOptionPresent(args, "--allow-network");
  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir, worktreesDir };
  }
  if (snapshot.state !== "BUILD") {
    return { ok: false, error: "generate_requires_build_state", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const workspace = await readWorkspaceStatus(tasksDir, taskId);
  if (!workspace || workspace.metadata.cleanedAt || !workspace.status.pathExists || !workspace.status.isGitWorktree) {
    return { ok: false, error: "workspace_required", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir, workspace };
  }

  const contract = await readContractArtifact(tasksDir, taskId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const events = await store.listEvents(taskId);
  const attempt = events.filter((event) => event.event_type === "CODE_PRODUCED").length + 1;
  const result = await runGenerator({
    taskId,
    artifactsDir: tasksDir,
    workspace: workspace.metadata,
    contract: contract.content,
    adapter,
    fixture,
    attempt,
    config: _config,
    allowNetwork: allowNetwork || _config?.agent_allow_network === true
  });

  if (!result.ok) {
    return { ok: false, command: "generate", error: result, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const eventResult = await store.appendEvent(
    taskId,
    { type: "CODE_PRODUCED", report_path: result.reportPath, files_changed: result.filesChanged, attempt },
    "generator"
  );
  if (!eventResult.ok) {
    return { ok: false, command: "generate", error: eventResult, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir, reportPath: result.reportPath };
  }

  // Emit RUN_COMPLETE as informational audit event
  await store.appendEvent(
    taskId,
    { type: "RUN_COMPLETE", report_path: result.reportPath, attempt },
    "generator"
  );

  const finalSnapshot = await store.getCurrentState(taskId);
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "generate",
    taskId,
    state: finalSnapshot?.state ?? eventResult.event.state_after,
    storePath,
    tasksDir,
    worktreesDir,
    reportPath: result.reportPath,
    filesChanged: result.filesChanged,
    event: summarizeEvent(eventResult.event)
  };
}

// ── evaluate ──

async function runEvaluate(args: string[], storePath: string, tasksDir: string, worktreesDir: string, _config: AnchorConfig) {
  const taskId = args[0];
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir, worktreesDir };
  }

  const adapter = readOption(args, "--adapter") ?? "fixture";
  const verdict = readOption(args, "--verdict");
  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir, worktreesDir };
  }
  if (snapshot.state !== "CHECK") {
    return { ok: false, error: "evaluate_requires_check_state", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const workspace = await readWorkspaceStatus(tasksDir, taskId);
  if (!workspace || workspace.metadata.cleanedAt || !workspace.status.pathExists || !workspace.status.isGitWorktree) {
    return { ok: false, error: "workspace_required", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir, workspace };
  }

  const contract = await readContractArtifact(tasksDir, taskId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const result = await runEvaluator({
    taskId,
    artifactsDir: tasksDir,
    workspace: workspace.metadata,
    contract: contract.content,
    adapter,
    verdict
  });
  if (!result.ok) {
    return { ok: false, command: "evaluate", error: result, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const eventResult = await store.appendEvent(
    taskId,
    {
      type: "EVAL_COMPLETE",
      verdict: result.report.verdict,
      report_path: result.reportPath,
      tests_run: result.report.testsRun,
      tests_failed: result.report.testsFailed,
      feedback: result.report.feedback
    },
    "evaluator"
  );
  if (!eventResult.ok) {
    return { ok: false, command: "evaluate", error: eventResult, taskId, state: snapshot.state, storePath, tasksDir, worktreesDir, reportPath: result.reportPath };
  }

  const finalSnapshot = await store.getCurrentState(taskId);
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "evaluate",
    taskId,
    state: finalSnapshot?.state ?? eventResult.event.state_after,
    storePath,
    tasksDir,
    worktreesDir,
    reportPath: result.reportPath,
    verdict: result.report.verdict,
    testsRun: result.report.testsRun,
    testsFailed: result.report.testsFailed,
    event: summarizeEvent(eventResult.event)
  };
}

// ── retry ──

async function runRetry(args: string[], storePath: string, tasksDir: string, worktreesDir: string, _config: AnchorConfig) {
  const taskId = args[0];
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir, worktreesDir };
  }

  const adapter = readOption(args, "--adapter") ?? "fixture";
  const failTimesResult = readFailTimes(args);
  if (!failTimesResult.ok) {
    return { ok: false, command: "run-retry", error: failTimesResult, taskId, storePath, tasksDir, worktreesDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir, worktreesDir };
  }
  if (snapshot.state !== "BUILD" && snapshot.state !== "CHECK") {
    return { ok: false, error: "retry_requires_build_or_check_state", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const workspace = await readWorkspaceStatus(tasksDir, taskId);
  if (!workspace || workspace.metadata.cleanedAt || !workspace.status.pathExists || !workspace.status.isGitWorktree) {
    return { ok: false, error: "workspace_required", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir, workspace };
  }

  const contract = await readContractArtifact(tasksDir, taskId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", taskId, state: snapshot.state, storePath, tasksDir, worktreesDir };
  }

  const steps: Array<Record<string, unknown>> = [];
  let state: State = snapshot.state;
  while (state === "BUILD" || state === "CHECK") {
    if (state === "BUILD") {
      const events = await store.listEvents(taskId);
      const attempt = events.filter((event) => event.event_type === "CODE_PRODUCED").length + 1;
      const result = await runGenerator({
        taskId,
        artifactsDir: tasksDir,
        workspace: workspace.metadata,
        contract: contract.content,
        adapter,
        attempt,
        reportPath: generatorAttemptReportPath(tasksDir, taskId, attempt)
      });
      if (!result.ok) {
        return { ok: false, command: "run-retry", error: result, taskId, state, storePath, tasksDir, worktreesDir, steps };
      }

      const eventResult = await store.appendEvent(
        taskId,
        { type: "CODE_PRODUCED", report_path: result.reportPath, files_changed: result.filesChanged, attempt },
        "generator"
      );
      if (!eventResult.ok) {
        return { ok: false, command: "run-retry", error: eventResult, taskId, state, storePath, tasksDir, worktreesDir, reportPath: result.reportPath, steps };
      }

      steps.push({ role: "generator", attempt, reportPath: result.reportPath, filesChanged: result.filesChanged, event: summarizeEvent(eventResult.event) });
      state = eventResult.event.state_after;
      continue;
    }

    const events = await store.listEvents(taskId);
    const attempt = events.filter((event) => event.event_type === "EVAL_COMPLETE").length + 1;
    const latestCode = latestCodeProduced(events);
    // For fixture adapter, force verdict based on remaining retries.
    // For Codex, the evaluator determines its own verdict from the code.
    const forcedVerdict = adapter === "fixture"
      ? (attempt <= failTimesResult.failTimes ? "fail" : "pass")
      : undefined;
    const result = await runEvaluator({
      taskId,
      artifactsDir: tasksDir,
      workspace: workspace.metadata,
      contract: contract.content,
      adapter,
      verdict: forcedVerdict,
      attempt,
      generatorReportPath: latestCode?.payload.report_path,
      reportPath: evaluatorAttemptReportPath(tasksDir, taskId, attempt)
    });
    if (!result.ok) {
      return { ok: false, command: "run-retry", error: result, taskId, state, storePath, tasksDir, worktreesDir, steps };
    }

    const eventResult = await store.appendEvent(
      taskId,
      {
        type: "EVAL_COMPLETE",
        verdict: result.report.verdict,
        attempt,
        report_path: result.reportPath,
        tests_run: result.report.testsRun,
        tests_failed: result.report.testsFailed,
        feedback: result.report.feedback
      },
      "evaluator"
    );
    if (!eventResult.ok) {
      return { ok: false, command: "run-retry", error: eventResult, taskId, state, storePath, tasksDir, worktreesDir, reportPath: result.reportPath, steps };
    }

    steps.push({ role: "evaluator", attempt, reportPath: result.reportPath, verdict: result.report.verdict, testsRun: result.report.testsRun, testsFailed: result.report.testsFailed, event: summarizeEvent(eventResult.event) });
    state = eventResult.event.state_after;
  }

  const finalSnapshot = await store.getCurrentState(taskId);
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "run-retry",
    taskId,
    state: finalSnapshot?.state ?? state,
    context: finalSnapshot?.context ?? snapshot.context,
    failTimes: failTimesResult.failTimes,
    storePath,
    tasksDir,
    worktreesDir,
    steps
  };
}

// ── review ──

async function runReview(args: string[], storePath: string, tasksDir: string, _config: AnchorConfig) {
  const taskId = args[0];
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir };
  }

  const adapter = readOption(args, "--adapter") ?? "fixture";
  const verdict = readOption(args, "--verdict");
  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir };
  }
  if (snapshot.state !== "REVIEW") {
    return { ok: false, error: "review_requires_review_state", taskId, state: snapshot.state, storePath, tasksDir };
  }

  const contract = await readContractArtifact(tasksDir, taskId);
  if (!contract) {
    return { ok: false, error: "contract_not_found", taskId, state: snapshot.state, storePath, tasksDir };
  }

  const result = await runReviewer({
    taskId,
    artifactsDir: tasksDir,
    contract: contract.content,
    adapter,
    verdict
  });
  if (!result.ok) {
    return { ok: false, command: "review", error: result, taskId, state: snapshot.state, storePath, tasksDir };
  }

  const eventResult = await store.appendEvent(
    taskId,
    { type: "REVIEW_COMPLETE", verdict: result.report.verdict },
    "reviewer"
  );
  if (!eventResult.ok) {
    return { ok: false, command: "review", error: eventResult, taskId, state: snapshot.state, storePath, tasksDir, reportPath: result.reportPath };
  }

  const finalSnapshot = await store.getCurrentState(taskId);
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "review",
    taskId,
    state: finalSnapshot?.state ?? eventResult.event.state_after,
    storePath,
    tasksDir,
    verdict: result.report.verdict,
    reportPath: result.reportPath,
    event: summarizeEvent(eventResult.event)
  };
}

// ── abort ──

async function runAbort(args: string[], storePath: string, tasksDir: string) {
  const taskId = args[0];
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir };
  }

  // Abort works from any active state
  const activeStates = ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"];
  if (!activeStates.includes(snapshot.state ?? "")) {
    return { ok: false, error: "abort_requires_active_state", taskId, state: snapshot.state, storePath, tasksDir };
  }

  const reason = readOption(args, "--reason") ?? "Human abort";
  const eventResult = await store.appendEvent(
    taskId,
    { type: "HUMAN_ABORT", reason },
    "human"
  );
  if (!eventResult.ok) {
    return { ok: false, command: "abort", error: eventResult, taskId, state: snapshot.state, storePath, tasksDir };
  }

  const finalSnapshot = await store.getCurrentState(taskId);
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "abort",
    taskId,
    state: finalSnapshot?.state ?? eventResult.event.state_after,
    storePath,
    tasksDir,
    event: summarizeEvent(eventResult.event)
  };
}

// ── force-pass ──

async function runForcePass(args: string[], storePath: string, tasksDir: string) {
  const taskId = args[0];
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir };
  }
  if (snapshot.state !== "HUMAN") {
    return { ok: false, error: "force_pass_requires_human_state", taskId, state: snapshot.state, storePath, tasksDir };
  }

  const reason = readOption(args, "--reason") ?? "Human force-pass";
  const eventResult = await store.appendEvent(
    taskId,
    { type: "HUMAN_FORCE_PASS", reason },
    "human"
  );
  if (!eventResult.ok) {
    return { ok: false, command: "force-pass", error: eventResult, taskId, state: snapshot.state, storePath, tasksDir };
  }

  const finalSnapshot = await store.getCurrentState(taskId);
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "force-pass",
    taskId,
    state: finalSnapshot?.state ?? eventResult.event.state_after,
    storePath,
    tasksDir,
    event: summarizeEvent(eventResult.event)
  };
}

// ── amend-plan ──

async function runAmendPlan(args: string[], storePath: string, tasksDir: string) {
  const taskId = args[0];
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir };
  }
  if (snapshot.state !== "HUMAN") {
    return { ok: false, error: "amend_plan_requires_human_state", taskId, state: snapshot.state, storePath, tasksDir };
  }

  const reason = readOption(args, "--reason") ?? "Human amended plan";
  const eventResult = await store.appendEvent(
    taskId,
    { type: "HUMAN_AMEND_PLAN", reason },
    "human"
  );
  if (!eventResult.ok) {
    return { ok: false, command: "amend-plan", error: eventResult, taskId, state: snapshot.state, storePath, tasksDir };
  }

  // Emit CONTRACT_REVISED as informational audit event
  await store.appendEvent(
    taskId,
    { type: "CONTRACT_REVISED", reason },
    "human"
  );

  const finalSnapshot = await store.getCurrentState(taskId);
  if (finalSnapshot) {
    await updateTask(taskId, { status: taskStatusFromState(finalSnapshot.state) }, tasksDir);
  }

  return {
    ok: true,
    command: "amend-plan",
    taskId,
    state: finalSnapshot?.state ?? eventResult.event.state_after,
    storePath,
    tasksDir,
    event: summarizeEvent(eventResult.event)
  };
}

// ── demo ──

async function runDemo(args: string[], storePath: string) {
  const fixture = readFixture(args);
  const store = createFileRunStore(storePath);
  const taskId = `demo_${fixture}_${randomUUID()}`;
  const task = fixture === "retry" ? "Anchor deterministic retry demo" : "Anchor deterministic happy demo";

  for (const step of fixtureEvents(fixture, task)) {
    const result = await store.appendEvent(taskId, step.event, step.emittedBy);
    if (!result.ok) {
      return { ok: false, taskId, fixture, storePath, error: result };
    }
  }

  const snapshot = await store.getCurrentState(taskId);
  const events = await store.listEvents(taskId);
  return {
    ok: true,
    command: "demo",
    fixture,
    taskId,
    finalState: snapshot?.state ?? null,
    storePath,
    events: summarizeEvents(events)
  };
}

// ── status ──

async function runStatus(taskId: string | undefined, storePath: string, tasksDir: string) {
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath, tasksDir };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath, tasksDir };
  }

  const events = await store.listEvents(taskId);
  const contract = await readContractArtifact(tasksDir, taskId);

  return {
    ok: true,
    command: "status",
    taskId,
    state: snapshot.state,
    context: snapshot.context,
    storePath,
    tasksDir,
    contract: contract ? contractMetadata(contract, events) : missingContractMetadata(events)
  };
}

// ── events ──

async function runEvents(taskId: string | undefined, storePath: string) {
  if (!taskId) {
    return { ok: false, error: "task_id_required", storePath };
  }

  const store = createFileRunStore(storePath);
  const snapshot = await store.getCurrentState(taskId);
  if (!snapshot) {
    return { ok: false, error: "task_not_started", taskId, storePath };
  }

  return {
    ok: true,
    command: "events",
    taskId,
    state: snapshot.state,
    storePath,
    events: summarizeEvents(await store.listEvents(taskId))
  };
}

// ── task ──

async function runTask(args: string[], tasksDir: string, storePath: string) {
  const [subcommand, ...rest] = args;

  if (subcommand === "create") {
    const title = rest.join(" ").trim();
    if (!title) {
      return { ok: false, error: "task_title_required", tasksDir };
    }
    const description = readOption(rest, "--description");
    const status = readOption(rest, "--status");
    const validStatuses = ["backlog", "in_progress", "done", "aborted"];
    if (status && !validStatuses.includes(status)) {
      return { ok: false, error: "invalid_task_status", status, validStatuses, tasksDir };
    }
    const result = await createTask(
      { title, description: description ?? undefined, status: (status as Task["status"]) ?? undefined },
      tasksDir
    );
    if (!result.ok) {
      return { ok: false, command: "task create", error: result, tasksDir };
    }
    return { ok: true, command: "task create", taskId: result.task.id, task: result.task, path: result.path, tasksDir };
  }

  if (subcommand === "list") {
    const statusFilter = readOption(rest, "--status");
    const validStatuses = ["backlog", "in_progress", "done", "aborted"];
    if (statusFilter && !validStatuses.includes(statusFilter)) {
      return { ok: false, error: "invalid_task_status", status: statusFilter, validStatuses, tasksDir };
    }
    const result = await listTasks(tasksDir, statusFilter as Task["status"] | undefined);
    return { ok: true, command: "task list", total: result.total, tasks: result.tasks, tasksDir };
  }

  if (subcommand === "show") {
    const taskId = rest.join(" ").trim();
    if (!taskId) {
      return { ok: false, error: "task_id_required", tasksDir };
    }
    const result = await readTask(taskId, tasksDir);
    if (!result.ok) {
      return { ok: false, command: "task show", error: result, taskId, tasksDir };
    }
    const store = createFileRunStore(storePath);
    const snapshot = await store.getCurrentState(taskId);
    return {
      ok: true,
      command: "task show",
      task: result.task,
      path: result.path,
      stateMachine: snapshot ? { state: snapshot.state, context: snapshot.context } : null,
      tasksDir
    };
  }

  return { ok: false, error: "unknown_task_subcommand", usage: "anchor task <create|list|show> [...]", tasksDir };
}

// ── helpers ──

function readFixture(args: string[]) {
  const index = args.indexOf("--fixture");
  if (index === -1) return "happy";
  const fixture = args[index + 1];
  if (fixture === "happy" || fixture === "retry") return fixture;
  throw new Error(`unsupported_fixture:${fixture ?? ""}`);
}

function readOption(args: string[], option: string) {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function isOptionPresent(args: string[], option: string) {
  return args.includes(option);
}

function parseMode(mode: string | undefined): "quick" | "standard" | "thorough" | undefined {
  if (!mode) return undefined;
  const lower = mode.toLowerCase();
  if (lower === "quick" || lower === "standard" || lower === "thorough") {
    return lower as "quick" | "standard" | "thorough";
  }
  return undefined;
}

function readFailTimes(args: string[]): { ok: true; failTimes: number } | { ok: false; code: "INVALID_FAIL_TIMES"; message: string; detail: string } {
  const value = readOption(args, "--fail-times") ?? "0";
  if (!/^\d+$/.test(value)) {
    return { ok: false, code: "INVALID_FAIL_TIMES", message: "--fail-times must be a non-negative integer.", detail: value };
  }
  return { ok: true, failTimes: Number(value) };
}

function latestCodeProduced(events: StoredEvent[]) {
  const codeEvents = events.filter(
    (event): event is StoredEvent & { payload: Extract<Event, { type: "CODE_PRODUCED" }> } => event.event_type === "CODE_PRODUCED"
  );
  return codeEvents[codeEvents.length - 1] ?? null;
}

function fixtureEvents(fixture: "happy" | "retry", task: string): Array<{ emittedBy: string; event: Event }> {
  const received: Event = { type: "TASK_RECEIVED", task };
  const contract: Event = { type: "CONTRACT_PRODUCED", mode: "quick", reasoning: `${fixture} fixture uses quick mode`, affected_scope: ["src/"] };
  const firstBuild: Event = { type: "CODE_PRODUCED", report_path: `reports/${fixture}-generator-1.md`, files_changed: ["src/index.ts"], attempt: 1 };

  if (fixture === "happy") {
    return [
      { emittedBy: "system", event: received },
      { emittedBy: "planner", event: contract },
      { emittedBy: "generator", event: firstBuild },
      { emittedBy: "evaluator", event: { type: "EVAL_COMPLETE", verdict: "PASS" } }
    ];
  }

  return [
    { emittedBy: "system", event: received },
    { emittedBy: "planner", event: contract },
    { emittedBy: "generator", event: firstBuild },
    { emittedBy: "evaluator", event: { type: "EVAL_COMPLETE", verdict: "FAIL" } },
    { emittedBy: "generator", event: { type: "CODE_PRODUCED", report_path: "reports/retry-generator-2.md", files_changed: ["src/index.ts"], attempt: 2 } },
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
  if (!approvedContractSha) return null;
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
  return { exitCode: 0, output: JSON.stringify(value, null, 2) };
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
