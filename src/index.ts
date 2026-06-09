export const anchorVersion = "0.0.0";

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
    "R0 status:",
    "  TypeScript project skeleton and CLI placeholder are installed.",
    "  Runtime state machine, providers, and workspace isolation are not implemented in R0."
  ].join("\n");
}
