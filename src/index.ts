export const anchorVersion = "0.0.0";

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
    "R1 status:",
    "  TypeScript project skeleton and deterministic transition core are installed.",
    "  Persistence, providers, permission guards, workspace isolation, and CLI demo are not implemented."
  ].join("\n");
}
