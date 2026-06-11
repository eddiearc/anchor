# Pi Generator Provider

The Pi provider implements the Generator role behind the shared provider interface. Anchor core still operates on task state, reports, and events; it does not branch on Pi as a special workflow.

## CLI Entry

Both forms resolve through the generator provider registry:

- `anchor generate <taskId> --provider pi`
- `anchor generate <taskId> --adapter pi`

`--provider` is the preferred provider-facing spelling. `--adapter` remains for compatibility.

## Runner Contract

The Pi provider calls the same replaceable command runner used by Codex. The runner receives:

- `cwd`: the isolated workspace path
- `args`: non-interactive Pi command arguments, including the prompt as the final argument
- `prompt`: the full prompt sent to Pi
- `contract`: the approved contract content
- `timeoutMs`: runner timeout
- `envAllowlist`: environment keys allowed into the child process
- `env`: the sanitized child environment

The default command is `pi --print --no-session --no-context-files`. Anchor runs it with the workspace as `cwd`; when Anchor network access is not allowed, the default argv also includes `--offline`. Tests replace the command with deterministic fake runners through `ANCHOR_PI_COMMAND` and `ANCHOR_PI_ARGV_JSON`. Required tests do not depend on a real Pi login, network, or external service.

## Prompt Boundary

The prompt is derived from Anchor artifacts, not chat context. It contains:

- task id
- workspace path
- approved contract path
- approved contract content
- allowlist and denylist summary from the contract
- report expectations

Pi is instructed to implement the approved contract only and leave evaluation to Anchor.

## Report And Event Normalization

On success the provider writes a normal `GeneratorReport` with:

- `adapter: "pi"`
- `provider: "pi"`
- `taskId`
- `attempt`
- redacted argv with the prompt replaced by `[prompt redacted]`
- exit code
- stdout/stderr summaries
- changed files from workspace git status
- workspace policy result
- commit SHA

The CLI then appends `CODE_PRODUCED` with `provider: "pi"` and leaves state transitions to the existing state machine.

Failure cases return stable JSON errors and do not append `CODE_PRODUCED`:

- `PI_CLI_UNAVAILABLE`
- `PI_COMMAND_FAILED`
- `PI_NO_CHANGES`
- `POLICY_VIOLATION`

## Secret Handling

The report stores only command name, redacted argv, exit code, and summarized stdout/stderr. It does not store environment variables, tokens, or the full prompt. The child environment is built from an explicit allowlist, and tests assert Anchor-specific process environment overrides and sample secret values are not leaked into the fake Pi child or report.

## Optional Real Smoke

Real Pi CLI smoke is optional for this gate. If a local non-interactive Pi CLI is unavailable, unauthenticated, or unsupported, the deterministic fake-runner tests remain the required proof for Anchor integration.
