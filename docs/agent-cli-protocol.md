# Anchor Agent CLI Protocol

Anchor CLI is agent-first. Human-readable text may exist for convenience, but agents should treat JSON fields and process exit codes as the protocol.

## Identity

- The canonical task identifier is `taskId`.
- Do not use or expect a `runId` field in new protocol integrations.
- Commands write task and event artifacts under `.anchor/` by default.

## Exit Codes

- Exit `0`: command succeeded and JSON output has `ok: true`.
- Exit non-zero: expected or unexpected failure and JSON output has `ok: false`.
- Agents should branch on `ok` and `error`, not on prose.

## Common JSON Fields

Successful command outputs include:

- `ok: true`
- `command`: command name
- `taskId`: when the command operates on a task
- `state`: current state when available
- `contractPath`, `contractSha`, or `artifacts`: artifact locations and hashes when available
- `nextActions`: structured next-step actions when available
- `nextCommands`: shell-friendly command strings derived from `nextActions`

Failure outputs include:

- `ok: false`
- `error`: stable error code string or structured error object
- relevant context such as `taskId`, `state`, `storePath`, `tasksDir`, or `worktreesDir`

## `nextActions`

`anchor run` and `anchor next <taskId>` return `nextActions`. Each action contains:

- `action`: stable machine action id, such as `view_contract`, `approve_contract`, `create_workspace`, `generate`, `evaluate`, or `done`
- `command`: argv array that can be executed directly, for example `["anchor", "contract", "TASK-001"]`
- `requires`: prerequisite signals
- `description`: optional human aid; agents must not rely on it as the only signal

## Sequence

```bash
anchor init
RUN_JSON="$(anchor run "test task")"
TASK_ID="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0, "utf8")).taskId)' <<<"$RUN_JSON")"
anchor next "$TASK_ID"
anchor contract "$TASK_ID"
anchor approve "$TASK_ID"
anchor next "$TASK_ID"
anchor workspace create "$TASK_ID"
anchor generate "$TASK_ID" --adapter fixture
anchor next "$TASK_ID"
anchor evaluate "$TASK_ID" --adapter fixture --verdict pass
anchor status "$TASK_ID"
anchor events "$TASK_ID"
```

## Retry Orchestration

`anchor run-retry <taskId>` runs the same provider interfaces as single-step `generate` and `evaluate`.

- `--generator-provider <id>` selects the generator provider.
- `--evaluator-provider <id>` selects the evaluator provider.
- `--provider <id>` or `--adapter <id>` selects the same provider for both roles.
- Defaults are `fixture` for both roles.

Successful output includes `generatorProvider`, `evaluatorProvider`, and `steps[]`. Each step includes `role`, `provider`, `attempt`, `reportPath`, and the appended event summary. Unknown providers return structured `UNKNOWN_PROVIDER` errors before attempts are created.

## State Guidance

- `HUMAN` with a contract: `view_contract`, `approve_contract`, `create_workspace`
- `BUILD`: `create_workspace`, `generate`
- `CHECK`: `evaluate`
- `DONE`: `done`

`anchor next <taskId>` is read-only. It does not append events or change state.

## Predictable Failures

Agents should expect non-zero exits with JSON for common failures:

- `anchor init` outside a git repo: `error: "not_git_repo"`
- `anchor next TASK-404`: `error: "task_not_found"`
- `anchor status TASK-404`: `error: "task_not_started"`
- `anchor generate <taskId>` before BUILD: `error: "generate_requires_build_state"`
- `anchor evaluate <taskId> --adapter fixture --verdict maybe` in CHECK: structured `error.code: "INVALID_VERDICT"`

## Scope

This protocol covers the local CLI orchestration path. It does not publish to npm, start a daemon, provide a Web UI, or run real Codex end-to-end.
