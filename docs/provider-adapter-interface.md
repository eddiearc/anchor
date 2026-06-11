# Provider Adapter Interface

Anchor core is role/event/report oriented. It should not branch on Codex, Pi, or fixture as product concepts. A provider is a role backend that implements the same interface for a supported role.

## Provider Identity

Each provider has:

- `id`: stable provider id, such as `fixture`, `codex`, or `pi`
- `roles`: supported Anchor roles, currently `generator` and/or `evaluator`
- `run(input)`: role-specific execution function returning a normalized result

The CLI accepts `--adapter` for backward compatibility and `--provider` as the machine-facing alias. Both resolve through the provider registry.

## Generator Provider Input

Generator providers receive:

- `taskId`
- `artifactsDir`
- `workspace` metadata
- approved contract path/content
- provider id from `adapter`
- fixture/provider options
- `attempt`
- optional report path
- optional config/context such as retry and network policy

Generator providers return a normalized `GeneratorReport` with:

- `adapter`
- `provider`
- `taskId`
- `attempt`
- timestamps
- changed files
- policy result
- commit SHA
- summary
- provider-specific command metadata when relevant

The CLI converts a successful generator result into `CODE_PRODUCED` and `RUN_COMPLETE` events. Event payloads include `provider`, but state-machine transitions do not depend on provider type.

## Evaluator Provider Input

Evaluator providers receive:

- `taskId`
- `artifactsDir`
- `workspace` metadata
- approved contract path/content
- provider id from `adapter`
- optional verdict/config for fixture provider
- optional generator report path
- optional attempt and report paths

Evaluator providers return a normalized `EvaluatorReport` with:

- `adapter`
- `provider`
- verdict
- `taskId`
- timestamps
- tests run/failed
- feedback
- inspected files
- generator report path
- summary
- provider-specific command metadata when relevant

The CLI converts a successful evaluator result into `EVAL_COMPLETE`. Event payloads include `provider`, but state-machine transitions use only the normalized verdict.

## Error Contract

Provider resolution failures are structured:

- `UNKNOWN_PROVIDER`
- `UNSUPPORTED_PROVIDER_ROLE`

Provider execution failures should return stable `code`, `message`, and optional `detail`; they should not leak unparseable exceptions to CLI callers.

## Where Provider-specific Code Belongs

Allowed:

- provider implementation functions
- provider registry entries
- provider-specific command construction/parsing inside provider modules

Not allowed:

- state-machine provider branches
- CLI workflow branches that special-case Codex/Pi/fixture beyond resolving provider ids
- event transition logic depending on provider id

## Codex Generator Provider

The Codex generator backend is a provider implementation, not a core workflow branch. `anchor generate <taskId> --provider codex` and the backward-compatible `--adapter codex` both resolve `codex` through the generator provider registry before invoking the Codex runner path.

Codex receives only Anchor-owned inputs:

- approved contract path/content
- task id
- workspace path
- workspace policy summary derived from the contract
- report expectations

Codex output is normalized to `GeneratorReport` and `CODE_PRODUCED` in the same shape as other generator providers. Failed Codex exits, no-change runs, or policy violations return stable JSON errors and do not append `CODE_PRODUCED`.

See [docs/codex-provider.md](docs/codex-provider.md) for the Codex-specific runner contract.

## Codex Evaluator Provider

The Codex evaluator backend is a provider implementation, not a core workflow branch. `anchor evaluate <taskId> --provider codex` and the backward-compatible `--adapter codex` both resolve `codex` through the evaluator provider registry before invoking the Codex runner path.

Codex receives only Anchor-owned evaluation inputs:

- approved contract path/content
- task id
- workspace path
- generator report path/content
- changed files summary
- required verdict file schema

Codex output is normalized to `EvaluatorReport` and `EVAL_COMPLETE` in the same shape as other evaluator providers. A valid `PASS` verdict advances through the existing DONE transition; a valid `FAIL` verdict follows the existing retry path. Invalid or unparseable verdict output and command failures return stable JSON errors and do not append `EVAL_COMPLETE`.

## Pi Generator Provider

The Pi generator backend is also a provider implementation, not a core workflow branch. `anchor generate <taskId> --provider pi` and the backward-compatible `--adapter pi` both resolve `pi` through the generator provider registry before invoking the Pi runner path.

Pi receives the same Anchor-owned inputs as Codex:

- approved contract path/content
- task id
- workspace path
- workspace policy summary derived from the contract
- report expectations

Pi output is normalized to `GeneratorReport` and `CODE_PRODUCED` in the same shape as other generator providers. Failed Pi exits, no-change runs, or policy violations return stable JSON errors and do not append `CODE_PRODUCED`.

See [docs/pi-provider.md](docs/pi-provider.md) for the Pi-specific runner contract.
