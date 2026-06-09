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
    "",
    "R3 status:",
    "  TypeScript skeleton, transition core, JSONL event store, and permission guards are installed.",
    "  Providers, real filesystem sandboxing, and CLI demo are not implemented."
  ].join("\n");
}
