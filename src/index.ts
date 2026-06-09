export const anchorVersion = "0.0.0";

export * from "./core/permissions.js";
export * from "./core/run-store.js";
export * from "./core/state-machine.js";

export function getAnchorHelp() {
  return [
    "Anchor",
    "",
    "A contract-driven, multi-role isolated coding harness.",
    "",
    "Usage:",
    "  anchor --help",
    "  anchor --version",
    "  anchor demo [--fixture happy|retry]",
    "  anchor status <runId>",
    "  anchor events <runId>",
    "",
    "R4 status:",
    "  Deterministic CLI demo, transition core, JSONL event store, and permission guards are installed.",
    "  Providers, real filesystem sandboxing, git diff enforcement, and Web UI are not implemented.",
    "",
    "Store:",
    "  Set ANCHOR_STORE_PATH to override the default .anchor/runs.jsonl store."
  ].join("\n");
}
