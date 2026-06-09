export const anchorVersion = "0.0.0";

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
    "R2 status:",
    "  TypeScript skeleton, deterministic transition core, and JSONL event store are installed.",
    "  Providers, permission guards, workspace isolation, and CLI demo are not implemented."
  ].join("\n");
}
