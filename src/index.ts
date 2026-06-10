export const anchorVersion = "0.0.0";

export * from "./core/contracts.js";
export * from "./core/permissions.js";
export * from "./core/run-store.js";
export * from "./core/state-machine.js";
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
    "  anchor plan <task>",
    "  anchor contract <runId>",
    "  anchor approve <runId>",
    "  anchor workspace create <runId>",
    "  anchor workspace status <runId>",
    "  anchor workspace cleanup <runId>",
    "  anchor demo [--fixture happy|retry]",
    "  anchor status <runId>",
    "  anchor events <runId>",
    "",
    "R5 status:",
    "  Deterministic contract artifacts, human approval SHA events, CLI demo, JSONL event store, and permission guards are installed.",
    "  Providers, real filesystem sandboxing, git diff enforcement, and Web UI are not implemented.",
    "",
    "Store:",
    "  Set ANCHOR_STORE_PATH to override the default .anchor/runs.jsonl store.",
    "  Set ANCHOR_RUNS_DIR to override the default .anchor/runs artifact directory.",
    "  Set ANCHOR_WORKTREES_DIR to override the default .anchor/worktrees workspace directory."
  ].join("\n");
}
