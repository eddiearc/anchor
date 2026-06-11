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
- approved contract content
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
- approved contract content
- provider id from `adapter`
- optional verdict/config for fixture provider
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

## Future Codex and Pi Providers

Codex and Pi should implement this same provider interface. They should normalize outputs to `GeneratorReport` / `EvaluatorReport` and event payloads, then let Anchor core continue to operate on roles, reports, events, and states.
