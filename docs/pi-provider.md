# Pi Provider

The Pi provider implements Anchor roles behind the shared provider interface. Anchor core still operates on task state, reports, and events; it does not branch on Pi as a special workflow.

## CLI Entry

Generator forms resolve through the generator provider registry:

- `anchor generate <taskId> --provider pi`
- `anchor generate <taskId> --adapter pi`

Evaluator forms resolve through the evaluator provider registry:

- `anchor evaluate <taskId> --provider pi`
- `anchor evaluate <taskId> --adapter pi`

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

Generator prompts are derived from Anchor artifacts, not chat context. They contain:

- task id
- workspace path
- approved contract path
- approved contract content
- allowlist and denylist summary from the contract
- report expectations

Pi is instructed to implement the approved contract only and leave evaluation to Anchor.

Evaluator prompts are also derived from Anchor artifacts. They contain:

- task id
- workspace path
- approved contract path/content
- generator report path/content
- changed files summary from workspace git status
- the required verdict file format
- evaluator constraints

Pi is instructed to write tests only under `.anchor/eval/`, avoid modifying generated source files, and write its normalized verdict to `.anchor/eval/verdict.json`.

## Generator Normalization

On generator success the provider writes a normal `GeneratorReport` with:

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

## Evaluator Normalization

The evaluator expects Pi to write:

```json
{"verdict":"PASS","feedback":"<detailed explanation>","testsRun":1,"testsFailed":0}
```

`verdict` must be `PASS` or `FAIL`; `feedback` must be a string. `testsRun` and `testsFailed` default to `0` if absent.

On evaluator success the provider writes a normal `EvaluatorReport` with:

- `adapter: "pi"`
- `provider: "pi"`
- `taskId`
- normalized `verdict`
- tests run/failed
- feedback
- inspected files from workspace git status
- generator report path
- redacted argv with the prompt replaced by `[prompt redacted]`
- exit code and summarized stdout/stderr

The CLI then appends `EVAL_COMPLETE` with `provider: "pi"` and leaves state transitions to the existing state machine: `PASS` advances to `DONE`, while `FAIL` follows the existing retry path.

Evaluator failures return stable JSON errors and do not append `EVAL_COMPLETE`:

- `PI_CLI_UNAVAILABLE`
- `PI_COMMAND_FAILED`: Pi command exited nonzero without a valid verdict file
- `PI_NO_VERDICT`: Pi did not write a valid parseable verdict file
- `GENERATOR_REPORT_NOT_FOUND`
- `WORKSPACE_UNAVAILABLE`

## Secret Handling

Reports store only command name, redacted argv, exit code, and summarized stdout/stderr. They do not store environment variables, tokens, or the full prompt. The child environment is built from an explicit allowlist, and tests assert Anchor-specific process environment overrides and sample secret values are not leaked into the fake Pi child or report.

## Optional Real Smoke

Real Pi CLI smoke is optional for this gate. If a local non-interactive Pi CLI is unavailable, unauthenticated, or unsupported, the deterministic fake-runner tests remain the required proof for Anchor integration.
