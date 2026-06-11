# Codex Generator Provider

The Codex provider implements the Generator role behind the shared provider interface. Anchor core still operates on task state, reports, and events; it does not branch on Codex as a special workflow.

## CLI Entry

Both forms resolve through the generator provider registry:

- `anchor generate <taskId> --provider codex`
- `anchor generate <taskId> --adapter codex`

`--provider` is the preferred provider-facing spelling. `--adapter` remains for compatibility.

## Runner Contract

The Codex provider calls a replaceable command runner. The runner receives:

- `cwd`: the isolated workspace path
- `args`: non-interactive Codex command arguments, including the prompt as the final argument
- `prompt`: the full prompt sent to Codex
- `contract`: the approved contract content
- `timeoutMs`: runner timeout
- `envAllowlist`: environment keys allowed into the child process
- `env`: the sanitized child environment

The default runner executes the configured Codex command with these options. Tests replace the command with deterministic fake runners through `ANCHOR_CODEX_COMMAND` and `ANCHOR_CODEX_ARGV_JSON`; they do not require a real Codex login, network, or external service.

## Prompt Boundary

The prompt is derived from Anchor artifacts, not chat context. It contains:

- task id
- workspace path
- approved contract path
- approved contract content
- allowlist and denylist summary from the contract
- report expectations

Codex is instructed to implement the approved contract only and leave evaluation to Anchor.

## Report And Event Normalization

On success the provider writes a normal `GeneratorReport` with:

- `adapter: "codex"`
- `provider: "codex"`
- `taskId`
- `attempt`
- redacted argv with the prompt replaced by `[prompt redacted]`
- exit code
- stdout/stderr summaries
- changed files from workspace git status
- workspace policy result
- commit SHA

The CLI then appends `CODE_PRODUCED` with `provider: "codex"` and leaves state transitions to the existing state machine.

Failure cases return stable JSON errors and do not append `CODE_PRODUCED`:

- `CODEX_CLI_UNAVAILABLE`
- `CODEX_COMMAND_FAILED`
- `CODEX_NO_CHANGES`
- `POLICY_VIOLATION`

## Secret Handling

The report stores only command name, redacted argv, exit code, and summarized stdout/stderr. It does not store environment variables, tokens, or the full prompt. The child environment is built from an explicit allowlist, and tests assert Anchor-specific process environment overrides are not leaked into the fake Codex child.

## Optional Real Smoke

Real Codex CLI smoke is optional for this gate. If a local non-interactive Codex CLI is unavailable, unauthenticated, or unsupported, the deterministic fake-runner tests remain the required proof for Anchor integration.
