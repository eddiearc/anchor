import test from "node:test";
import assert from "node:assert/strict";

import { getAnchorHelp } from "../dist/index.js";
import { runCli } from "../dist/cli/index.js";

test("Anchor R0 CLI placeholder prints help text", () => {
  assert.match(runCli(["--help"]), /Usage:/);
  assert.match(getAnchorHelp(), /TypeScript project skeleton/);
});

test("Anchor R0 CLI placeholder prints version", () => {
  assert.equal(runCli(["--version"]), "0.0.0");
});
