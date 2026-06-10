export const anchorVersion = "0.0.0";

export * from "./core/agent-runner.js";
export * from "./core/config.js";
export * from "./core/contracts.js";
export * from "./core/evaluators.js";
export * from "./core/generators.js";
export * from "./core/permissions.js";
export * from "./core/planners.js";
export * from "./core/run-store.js";
export * from "./core/state-machine.js";
export * from "./core/tasks.js";
export * from "./core/workspaces.js";

export function getAnchorHelp() {
  return [
    "Anchor",
    "",
    "A contract-driven, multi-role isolated coding harness.",
    "",
    "Usage:",
    "  anchor --help",
    "  anchor --version",
    "  anchor task create <title> [--description ...] [--status backlog|in_progress|done|aborted]",
    "  anchor task list [--status backlog|in_progress|done|aborted]",
    "  anchor task show <taskId>",
    "  anchor plan <task>",
    "  anchor plan --task <taskId>",
    "  anchor contract <taskId>",
    "  anchor approve <taskId>",
    "  anchor workspace create <taskId>",
    "  anchor workspace status <taskId>",
    "  anchor workspace cleanup <taskId>",
    "  anchor generate <taskId> --adapter fixture|codex",
    "  anchor evaluate <taskId> --adapter fixture|codex [--verdict pass|fail]",
    "  anchor run-retry <taskId> [--adapter fixture|codex] --fail-times <n>",
    "  anchor demo [--fixture happy|retry]",
    "  anchor status <taskId>",
    "  anchor events <taskId>",
    "",
    "R12 status:",
    "  Deterministic contract artifacts, git worktrees, fixture generation/evaluation/retry orchestration, Codex generator adapter, Codex evaluator adapter, local task files (.anchor/tasks/*.yaml), CLI demo, JSONL event store, and permission guards are installed.",
    "  Fixture evaluation accepts only pass|fail verdict input, case-insensitively.",
    "  Codex evaluation runs Codex CLI in the worktree and reads .anchor/eval/verdict.json for structured PASS/FAIL.",
    "  Task commands: anchor task create/list/show. Use anchor plan --task <taskId> to start a state machine on a task.",
    "  Agent runner (Codex CLI invocation) is shared across Generator and Evaluator via src/core/agent-runner.ts.",
    "  Run entity has been eliminated. Tasks are the unit of work — they hold their own state machine, contracts, workspaces, and reports.",
    "  Task source adapters (GitHub/Linear), real filesystem sandboxing, git diff enforcement, and Web UI are not implemented.",
    "",
    "Store:",
    "  Set ANCHOR_STORE_PATH to override the default .anchor/events.jsonl store.",
    "  Set ANCHOR_TASKS_DIR to override the default .anchor/tasks directory.",
    "  Set ANCHOR_WORKTREES_DIR to override the default .anchor/worktrees workspace directory."
  ].join("\n");
}
