# Anchor

> A contract-driven, multi-role isolated coding harness.
> Planner draws the blueprint. Reviewer checks the lines. Generator builds. Evaluator tests to destruction.
> They never share a context. They only speak through contracts.
> A state machine holds the bones. LLMs fill the muscles.

---

## Why Anchor

Current coding agents (Claude Code, Codex, pi) follow a **single-role, single-context** model: one model plans, codes, reviews, and iterates in the same conversation. This works for small tasks, but breaks down on real-world projects:

| Problem | What happens |
|---|---|
| **Context pollution** | The agent mixes planning, implementation, and self-critique in one thread. Long sessions degrade. |
| **No systematic gates** | The agent decides when it's "done." No independent judge. |
| **Hallucination cycles** | An agent that generated wrong code reviews its own output — and signs off. |
| **Vendor lock-in** | You write against one agent's toolset and can't switch without rewriting workflows. |
| **No iteration contract** | Feedback is ad-hoc natural language. The agent decides what to change — or ignore. |
| **Plans written blind** | The planner can't think of everything upfront. When the plan is wrong, the whole run is wasted. |

Anchor takes the architecture described in Anthropic's [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) and extends it: four isolated roles, three execution modes, and a deterministic state machine that keeps the process coherent even when the LLMs aren't.

---

## 5-minute Local CLI Quickstart

Anchor is not published to npm in this milestone, and the unscoped `anchor` npm package name is already occupied, so use `npm pack` from this repository for a local install smoke.

```bash
pnpm install
pnpm build
pnpm test

TARBALL="$(npm pack --json | node -e 'let data=\"\"; process.stdin.on(\"data\", c => data += c); process.stdin.on(\"end\", () => console.log(JSON.parse(data)[0].filename));')"
PREFIX="$(mktemp -d)"
npm install -g --prefix "$PREFIX" "$TARBALL"

"$PREFIX/bin/anchor" --help
"$PREFIX/bin/anchor" --version

FIXTURE_REPO="$(mktemp -d)"
git -C "$FIXTURE_REPO" init
cd "$FIXTURE_REPO"

"$PREFIX/bin/anchor" init
RUN_JSON="$("$PREFIX/bin/anchor" run "test task")"
TASK_ID="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0, "utf8")).taskId)' <<<"$RUN_JSON")"
"$PREFIX/bin/anchor" next "$TASK_ID"
"$PREFIX/bin/anchor" contract "$TASK_ID"
"$PREFIX/bin/anchor" status "$TASK_ID"
"$PREFIX/bin/anchor" events "$TASK_ID"
```

The installed CLI writes task and event data under the current repository's `.anchor/` directory by default. `anchor run` creates a task and contract, then stops for human approval; it does not generate code. Use `anchor next "$TASK_ID"` whenever you want the CLI to suggest the next command. This smoke does not publish to npm, does not run a real Codex end-to-end flow, and does not implement the Codex Evaluator adapter.

For agent integrations, use the JSON/exit-code protocol in [docs/agent-cli-protocol.md](docs/agent-cli-protocol.md). Provider backends are defined in [docs/provider-adapter-interface.md](docs/provider-adapter-interface.md), with Codex-specific runner details in [docs/codex-provider.md](docs/codex-provider.md). Anchor's canonical task identifier is `taskId`.

---

## The Four Roles

Every task flows through up to four roles. They run in **separate processes, separate contexts, separate models** if you want. The only thing they share is the contract.

### Planner

Enters in `PLAN` state. Does everything upfront in one call:

- **Triage + planning combined**. Reads the file tree, determines execution mode, and produces a structured `Contract` — task decomposition, ordered steps, testable acceptance criteria, allowlist/denylist, constraints, completion gate. For quick mode, the contract is a lightweight 3-5 bullet spec instead of a full document.

| Property | Value |
|---|---|
| Read files | ✅ |
| Write files | ❌ |
| Shell exec | ❌ |
| Network | ❌ |
| Access to human | ✅ (clarification only) |

### Reviewer

Reviews the contract **before any code is written**. Only invoked in thorough mode. Finds structural flaws — missing constraints, untestable criteria, contradictory requirements, missing dependencies — and sends the contract back to Planner for revision.

This is the cheapest quality gate: two LLM calls (review + revise) vs a full Generator run.

| Property | Value |
|---|---|
| Read files | ✅ |
| Write files | ❌ |
| Shell exec | ❌ (no code to test) |
| Network | ❌ |
| Access to human | ❌ |

### Generator

Writes the code. Reads the contract, produces code changes + a Generator Report explaining how each step was addressed. **Does not improvise** — if the contract is wrong, the Generator fails. This is a feature: bad contracts are detected early.

| Property | Value |
|---|---|
| Read files | ✅ |
| Write source files | ✅ (contract scope) |
| Shell exec | ✅ |
| Network | ❌ |

### Evaluator

The independent QA engineer. Runs Generator's tests. Writes new tests. Stress-tests edge cases. Compares everything against the contract, step by step, clause by clause.

| Property | Value |
|---|---|
| Read files | ✅ |
| Write source files | ❌ |
| Write test files | ✅ (sandboxed, discarded after evaluation) |
| Shell exec | ✅ |
| Network | ❌ |

Evaluator's tests live in `.anchor/eval/tests/` — isolated from Generator's workspace. They are run, results are recorded, then the directory is cleaned. Evaluator never modifies Generator's source.

---

## The State Machine

Anchor is built around a **deterministic finite state machine**. One rule: **each state = an agent (or human) is actively doing work.** No interstitial states.

```
                    TASK_RECEIVED
                         │
                         ▼
                    ┌────────┐
                    │  PLAN  │  Planner: triage + contract
                    └───┬────┘
                        │
              ┌─────────┼─────────┐
         quick│         │standard  │thorough
              │         │          │
              │         ▼          ▼
              │    ┌────────┐  ┌────────┐
              │    │ HUMAN  │  │ REVIEW │  Reviewer 审合同
              │    │ 批合同  │  └───┬────┘
              │    └───┬────┘      │
              │        │      ┌────┼────┐
              │        │  READY    │NEEDS_REVISION
              │        │      │    ▼
              │        │      │  PLAN    (改合同, review_retries--)
              │        │      │    │
              │        │      │    ▼
              │        │      │  REVIEW  (再审, 最多 M 轮)
              │        │      │    │ READY
              │        ▼      ▼    ▼
              │   ┌──────────────────┐
              │   │      HUMAN       │  人拍板合同 (thorough)
              │   └────────┬─────────┘
              │            │ CONTRACT_APPROVED
              ▼            ▼
         ┌──────────────────────┐
         │        BUILD         │  Generator 写代码
         └──────────┬───────────┘
                    │ CODE_PRODUCED
                    ▼
         ┌──────────────────────┐
         │        CHECK         │  Evaluator 测代码
         └──────────┬───────────┘
                    │ EVAL_COMPLETE
           ┌────────┼────────┐
           ▼        ▼        ▼
         PASS     FAIL     FAIL
           │        │    (retries_left > 0)
           │        │        │
           ▼        ▼        ▼
         DONE     BUILD    HUMAN   (retries_left == 0)
                           │
                      ┌────┼────┐
                 amend│         │force_pass
                 plan │         │
                      ▼         ▼
                    PLAN      DONE

    任何状态 → ABORT (人中断)
```

### How the state machine decides

It doesn't judge "good" or "bad." It only checks: **is the output structurally valid? What does the verdict say? What does context say?**

| Current | Event | Next state | Condition |
|---|---|---|---|
| — | `TASK_RECEIVED` | `PLAN` | — |
| `PLAN` | `CONTRACT_PRODUCED` | `BUILD` | `mode === 'quick'` |
| `PLAN` | `CONTRACT_PRODUCED` | `HUMAN` | `mode === 'standard'` |
| `PLAN` | `CONTRACT_PRODUCED` | `REVIEW` | `mode === 'thorough'` |
| `REVIEW` | `REVIEW_COMPLETE (READY)` | `HUMAN` | — |
| `REVIEW` | `REVIEW_COMPLETE (NEEDS_REVISION)` | `PLAN` | `review_retries_left > 0` |
| `REVIEW` | `REVIEW_COMPLETE (NEEDS_REVISION)` | `HUMAN` | `review_retries_left == 0` |
| `HUMAN` | `CONTRACT_APPROVED` | `BUILD` | — |
| `HUMAN` | `HUMAN_FORCE_PASS` | `DONE` | — |
| `HUMAN` | `HUMAN_AMEND_PLAN` | `PLAN` | — |
| `BUILD` | `CODE_PRODUCED` | `CHECK` | — |
| `CHECK` | `EVAL_COMPLETE (PASS)` | `DONE` | — |
| `CHECK` | `EVAL_COMPLETE (FAIL)` | `BUILD` | `retries_left > 0` |
| `CHECK` | `EVAL_COMPLETE (FAIL)` | `HUMAN` | `retries_left == 0` |
| any non-terminal | `HUMAN_ABORT` | `ABORT` | — |

The `HUMAN` state serves two purposes — contract approval and escalation — distinguished by context. Same state, same actor, different reason for being there.

### Event sourcing

Every state transition is an **immutable event** persisted to the run store. The current state is `events.reduce(transition, null)`.

- **Full audit trail**: know exactly why any decision was made
- **Crash recovery**: replay events to restore state
- **Time travel**: rewind to any event and branch (e.g., re-run Generator with a different model from the same contract)
- **No hidden state**: the event log IS the truth

See [docs/state-machine.md](docs/state-machine.md) for the full formal specification.

---

## Mode Routing

Not every task needs all four roles. Anchor has three execution modes:

### quick — simple, local changes

```
PLAN (light contract) → BUILD → CHECK → DONE
```

Planner produces a lightweight spec (3-5 bullets), no formal contract. No human review. Generator builds, Evaluator checks.

Example: fix a CSS class, rename a variable, update a dependency version.

### standard — moderate features (default)

```
PLAN (full contract) → HUMAN (批合同) → BUILD → CHECK ⇄ BUILD (retry) → DONE
```

Planner produces a full contract. Human reviews and approves. Generator builds, Evaluator checks, retries up to N times on failure.

Example: add a new API endpoint, refactor a module, add basic auth.

### thorough — complex, cross-domain changes

```
PLAN (full contract) → REVIEW ⇄ PLAN (revise, up to M rounds)
  → HUMAN (批合同) → BUILD → CHECK ⇄ BUILD (retry) → DONE
```

Planner produces a full contract. Reviewer checks it for structural flaws before any code is written. Planner revises based on feedback. Loop until READY or budget exhausted. Then human approves, Generator builds, Evaluator checks.

Example: migrate payment provider, restructure database, add multi-tenant isolation.

### Planner does everything upfront

The `PLAN` state handles both triage and contract production in one call. The output includes:

```json
{
  "mode": "thorough",
  "reasoning": "Cross-domain migration: billing, payment, subscription, and invoice modules all touched.",
  "affected_scope": ["src/billing/", "src/payment/", "src/subscription/", "src/invoice/"],
  "contract": { ... }  // null for quick mode
}
```

**Auto-proceeds** — the mode is displayed, then Anchor moves to the next state. No human confirmation on triage. If the mode is wrong, the worst case is safe: quick mode on a complex task will fail in CHECK and escalate. Bypass entirely with `anchor run --mode quick|standard|thorough`.

---

## Contract Schema

Contracts are the **only communication channel** between roles. No shared memory. No overlapping sessions. No "hey, remember what we talked about earlier."

```yaml
# contract.yaml — produced by Planner, consumed by all other roles
contract:
  id: "feat-oauth-42"
  version: "1.0"
  created: "2026-06-10T14:00:00Z"

  goal:
    summary: "Implement OAuth 2.0 device code flow for CLI authentication"
    context: |
      The app currently supports only API key auth. We need to add
      device code flow as described in RFC 8628.

  files:
    allowlist:
      - "src/auth/**"
      - "src/cli/login.ts"
      - "test/auth/**"
    denylist:
      - "src/auth/existing-providers.ts"  # don't touch legacy
      - "src/config/*.secret.*"           # never read secrets

  constraints:
    - "Must not break existing API key auth flow"
    - "Must reuse existing HttpService, do not introduce new HTTP client"
    - "All new code must be TypeScript strict mode compliant"
    - "Test coverage on new code must be >= 90%"

  steps:
    - id: "1"
      description: "Add device code request endpoint to POST /auth/device/code"
      acceptance:
        - "POST /auth/device/code returns 200 with device_code, user_code, verification_uri, expires_in, interval"
        - "Invalid client_id returns 400 with error_description"
        - "Rate-limited to 5 requests per minute per IP"

    - id: "2"
      description: "Implement token polling endpoint POST /auth/device/token"
      acceptance:
        - "Returns access_token on successful authorization"
        - "Returns authorization_pending when user hasn't approved"
        - "Returns slow_down when polling too fast"
        - "Returns expired_token after device_code expires"

    - id: "3"
      description: "Add CLI login command that initiates device flow"
      acceptance:
        - "anchor login opens browser to verification URL"
        - "Polls for token with exponential backoff (doubling, jitter, 2s-60s)"
        - "Stores token in OS keychain, not plaintext"
        - "Handles ctrl+c gracefully during polling"

  completion_gate:
    type: "all"
    conditions:
      - "All step acceptance criteria pass"
      - "TypeScript compilation succeeds with --strict"
      - "All existing tests still pass"
      - "New test coverage >= 90% on added lines"
      - "Manual review: no plaintext token storage"
```

### Contract Review (Reviewer → Planner)

The Reviewer produces a structured review before a single line of code is written:

```yaml
contract_review:
  contract_id: "feat-oauth-42"
  reviewer: "reviewer"
  verdict: NEEDS_REVISION   # or READY

  gaps:
    - severity: critical
      location: "step 3, criterion 1"
      issue: "Reuses HttpService but HttpService is not in allowlist"
      fix: "Add src/common/http-service.ts to allowlist, or specify which HTTP client to use"

    - severity: high
      location: "step 3, criterion 2"
      issue: "Acceptance criterion not testable — what counts as 'exponential backoff'?"
      fix: "Specify: doubling interval with jitter, starting at 2s, max 60s"

    - severity: medium
      location: "constraints"
      issue: "No constraint about existing auth middleware intercepting new routes"
      fix: "Add constraint: 'New endpoints must be registered before auth middleware, or middleware must be updated'"
```

### Feedback Spec (Evaluator → Generator)

When the Evaluator issues a FAIL, the Feedback Spec is structured so the Generator knows exactly what to fix:

```yaml
feedback:
  contract_id: "feat-oauth-42"
  evaluation_id: "eval-7a3f2"
  verdict: FAIL

  failures:
    - step_id: "1"
      criterion: "Rate-limited to 5 requests per minute per IP"
      observation: "Rate limiter is implemented but applies globally (all IPs), not per-IP. Requests from different IPs share the same counter."
      evidence: "src/auth/rate-limiter.ts:23 — `private counter = 0` is a singleton, not keyed by IP"
      action: "replace"
      suggestion: "Change counter to a Map<string, number> keyed by remote address"

    - step_id: "3"
      criterion: "Stores token in OS keychain, not plaintext"
      observation: "Token is written to ~/.anchor/token.json as plaintext"
      evidence: "src/cli/login.ts:87 — `fs.writeFileSync(tokenPath, JSON.stringify(token))`"
      action: "replace"
      suggestion: "Use keytar or @anchor/secure-store to write to OS keychain"

  warnings:
    - step_id: "2"
      observation: "No test for `expired_token` response"
      evidence: "test/auth/device-token.test.ts: no test case for expiry"
      action: "add"
```

### Evaluator's own tests

Evaluator writes additional tests beyond what Generator produced. These target edge cases the contract implies but Generator may have missed:

- Null inputs, empty payloads, oversized bodies
- Concurrent requests (validate per-IP rate limiter)
- Slow polling / fast polling boundaries
- Integration: does the new endpoint break any existing routes?

These tests live in `.anchor/eval/tests/`, run once, then are discarded. Evaluator never modifies Generator's source files.

---

## Role Isolation Architecture

Isolation is enforced at the harness level, not through model prompting:

| Property | Planner | Reviewer | Generator | Evaluator |
|---|---|---|---|---|
| **Read files** | ✅ all | ✅ all | ✅ all | ✅ all |
| **Write source files** | ❌ | ❌ | ✅ (contract scope) | ❌ |
| **Write test files** | ❌ | ❌ | ✅ | ✅ (sandboxed) |
| **Shell exec** | ❌ | ❌ | ✅ | ✅ |
| **Network** | ❌ | ❌ | ❌ | ❌ |
| **Context window** | Fresh | Fresh | Fresh | Fresh |
| **Access to other roles' logs** | ❌ | ❌ | ❌ | ❌ |
| **Access to contract** | Writes | Reads | Reads | Reads |
| **Access to human** | ✅ (clarify) | ❌ | ❌ | ❌ |

### Why isolation matters

A single agent acting as Planner + Generator has an incentive conflict: it plans what it can easily build, not what's correct. It evaluates its own output leniently. Multiple roles break these feedback loops:

- The **Planner** is judged only on contract quality. Reviewers and Evaluators catch weak contracts.
- The **Reviewer** catches contract flaws before any code is written — the cheapest gate.
- The **Generator** is judged only on satisfying the contract. It doesn't get to redefine "done."
- The **Evaluator** is judged only on catching real failures, by writing its own tests and checking every clause.

### Different models per role

Each role can run on a different model — even a different harness:

- **Planner**: Strong reasoning model (Claude Opus, o1)
- **Reviewer**: Fast, thorough model (Claude Sonnet, GPT-4o)
- **Generator**: Fast coding model (Claude Sonnet, GPT-4o)
- **Evaluator**: Thorough, test-writing model (Claude Opus, Claude Sonnet)

---

## Multi-Harness Support

Anchor is harness-agnostic. The state machine runs on top of any coding agent through adapters:

```
Anchor CLI
    │
    ├── Adapter: Claude Code  ──→  claude -p "..."
    ├── Adapter: Codex        ──→  codex "..."
    ├── Adapter: Pi           ──→  pi "..."
    └── Adapter: (custom)     ──→  ...
```

Each adapter translates the Anchor contract and role prompt into the native invocation format of the underlying agent. Mix harnesses within a single run:

```bash
anchor run "feat-oauth-42" \
  --planner  claude-code --model claude-opus-4 \
  --reviewer claude-code --model claude-sonnet-4 \
  --generator codex      --model gpt-4o \
  --evaluator pi         --model claude-sonnet-4
```

Anchor itself doesn't implement tools (read, write, bash, etc.) — it inherits them from the underlying harness.

| Adapter | Status |
|---|---|
| Claude Code | Design |
| Codex | Design |
| Pi | Design |
| OpenCode | Future |
| Custom | Design |

---



## CLI Design (Draft)

```bash
# Initialize anchor in a project
anchor init

# Run with auto-triage (default)
anchor run "Add OAuth 2.0 device code flow"

# Force a mode (skip Planner's mode decision)
anchor run "Fix login button alignment" --mode quick
anchor run "Migrate billing to Stripe" --mode thorough

# Run with explicit contract
anchor run --contract contracts/feat-oauth-42.yaml

# Run with specific harness assignments
anchor run "Refactor auth module" \
  --planner  claude-code --model claude-opus-4 \
  --reviewer claude-code --model claude-sonnet-4 \
  --generator codex      --model gpt-4o \
  --evaluator pi         --model claude-sonnet-4

# Dry run: Planner only (stops after contract, no REVIEW/BUILD/CHECK)
anchor plan "Add rate limiting" --mode thorough

# Resume after human intervention
anchor resume feat-oauth-42 --from build

# Show run history
anchor status
anchor log feat-oauth-42

# Show event log
anchor events feat-oauth-42
```

---

## Workflow Examples

### quick mode

```bash
$ anchor run "Fix login button alignment" --mode quick

PLAN → quick (CSS-only, single component)
BUILD → done
CHECK → PASS (2/2 tests, no regressions)
DONE
```

### standard mode

```bash
$ anchor run "Add rate limiting to API gateway"

PLAN → standard (single module, moderate scope)
  contract: contracts/rate-limit-001.yaml

HUMAN → Review contract? [y/N/edit] y

BUILD → done
CHECK → FAIL
  Step 2: rate limit per-endpoint instead of per-IP
  Step 4: missing test for burst allowance
BUILD → retry 1/3... done
CHECK → PASS
DONE
```

### thorough mode

```bash
$ anchor run "Migrate billing to new payment provider" --mode thorough

PLAN → thorough
  contract: contracts/billing-migration-001.yaml

REVIEW → NEEDS_REVISION (3 gaps)
  [critical] Payment state machine not in allowlist
  [high]     No rollback strategy
  [medium]   Constraint missing: don't break subscriptions
PLAN → contract revised → v1.1
REVIEW → READY

HUMAN → Review final contract? [y/N/edit] y

BUILD → done
CHECK → FAIL
  Step 1: adapter missing Refund interface
  Step 3: migration script not async-safe
BUILD → retry 1/3... done
CHECK → PASS
DONE
```

---

## Directory Structure (Draft)

```
anchor/
├── README.md
├── package.json
├── src/
│   ├── cli/                  # CLI command definitions
│   │   ├── index.ts
│   │   ├── init.ts
│   │   ├── plan.ts
│   │   ├── run.ts
│   │   ├── resume.ts
│   │   └── status.ts
│   ├── core/
│   │   ├── state-machine.ts  # FSM: states, events, transition function
│   │   ├── orchestrator.ts   # Wires state machine to agent runners
│   │   ├── event-store.ts    # SQLite-backed event sourcing
│   │   ├── contract.ts       # Contract schema, validation
│   │   ├── feedback.ts       # Feedback Spec schema
│   │   └── isolation.ts      # Role permission enforcement
│   ├── roles/
│   │   ├── planner.ts        # Planner agent wrapper (triage + full plan)
│   │   ├── reviewer.ts       # Reviewer agent wrapper
│   │   ├── generator.ts      # Generator agent wrapper
│   │   └── evaluator.ts      # Evaluator agent wrapper
│   ├── adapters/
│   │   ├── base.ts           # Adapter interface
│   │   ├── claude-code.ts    # Claude Code adapter
│   │   ├── codex.ts          # Codex adapter
│   │   └── pi.ts            # Pi adapter
│   ├── state/
│   │   ├── store.ts          # Run state persistence (SQLite)
│   │   └── migrations/
│   └── ui/
│       └── tui.ts            # Terminal UI for run monitoring
├── contracts/                # Contract templates and schemas
│   ├── schema.yaml
│   └── templates/
├── tests/
└── docs/
    ├── architecture.md
    ├── contract-spec.md
    ├── state-machine.md
    └── adapter-guide.md
```

---

## Design Principles

1. **Contracts are the only API.** Roles don't call each other. They read and write files on disk. Deliberately primitive — forces clean interfaces and makes every interaction auditable.

2. **State machine is the skeleton.** LLMs are stateless pure functions called at each state. The state machine decides what's next based on structured output, not LLM quality judgments. Uncertainty is locked inside LLM calls, not the control flow.

3. **Pre-code review is the cheapest gate.** Before a single line of code is written, the Reviewer checks the contract. Catching a structural flaw here costs two LLM calls. Catching it after Generator runs costs hundreds of tool calls.

4. **Evaluator is QA, not auditor.** It doesn't just read reports — it writes tests, runs everything, and stress-tests boundaries. It is the independent verification that Generator's code meets the contract.

5. **Models ≠ Roles.** Anchor doesn't care which LLM runs which role. A role is defined by its permissions and its prompt, not by the model. Swap models freely.

6. **Harness ≠ Agent.** Anchor is not a coding agent. It doesn't read files, write code, or execute commands. It delegates all of that to underlying harnesses through adapters.

7. **Fail fast, fail loud.** If the contract is underspecified, Reviewer catches it. If the code is wrong, Evaluator catches it. Silent failures are the enemy.

8. **Human in the loop, not in the way.** Human checkpoints only at contract approval and escalation after repeated failures. Triage auto-proceeds. The machine handles the iteration loop. Don't make the human review every code change — make them review every contract.

9. **Audit everything.** Every contract, every review, every evaluation, every event, every human decision — all persisted, all queryable.

---

## Open Design Questions

Topics to discuss before implementation:

1. **Contract discovery**: How does the Planner learn about the codebase? Full tree dump? File-level index? RAG over the repo? The contract's quality depends entirely on the Planner's understanding of the codebase.

2. **Parallelism**: Can multiple Generators run in parallel on independent contract steps? Would speed up large tasks but complicates merge conflict resolution.

3. **Contract versioning**: When the human amends a contract mid-cycle, should the Generator restart from scratch? Or reuse previous work?

4. **Evaluator accuracy**: How to prevent the Evaluator from hallucinating failures? A calibration phase where its judgments are compared against human reviews?

5. **Cost tracking**: Per-role, per-run cost attribution so teams can optimize model choices.

6. **Git integration**: Feature branch per task? Squash merge on PASS? Commit message conventions?

7. **Language**: TypeScript or Go? TypeScript has better ecosystem alignment with agent tools. Go gives better performance + single binary.

---

## Prior Art & References

## Docs

- [State Machine Specification](docs/state-machine.md) — Formal specification: states, events, transitions, invariants, event store, error handling
- [Agent Permission Model](docs/permissions.md) — Capability permissions + transition permissions + role-to-state mapping

---

## Prior Art & References

- [Anthropic — Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) — PGE architecture inspiration
- [Martin Fowler — Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html) — Feedforward/feedback patterns
- [suhanlee/harness](https://github.com/suhanlee/harness) — Claude Code plugin implementing 3-agent PGE pipeline
- [mvschwarz/openrig](https://github.com/mvschwarz/openrig) — Multi-harness session management with YAML topologies
- [first-fluke/oh-my-agent](https://github.com/first-fluke/oh-my-agent) — Cross-harness skill/rule projection
- [SethGammon/Citadel](https://github.com/SethGammon/Citadel) — Harness runtime with routing, memory, Fleet

---

## Development

Anchor is currently at R10: a TypeScript-first deterministic CLI MVP backed by contract artifacts, human approval SHA events, git worktree workspace management, deterministic fixture generation/evaluation/retry orchestration, a Codex CLI Generator adapter, the state machine core, event-sourced JSONL run store, and permission guard helpers.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm anchor --help
```

After building, the compiled CLI can also be run directly:

```bash
node dist/cli/index.js --help
```

### CLI Quickstart

The CLI writes events to `.anchor/runs.jsonl`, run artifacts to `.anchor/runs/<runId>/`, and git worktrees to `.anchor/worktrees/<runId>` by default. Set `ANCHOR_STORE_PATH`, `ANCHOR_RUNS_DIR`, and `ANCHOR_WORKTREES_DIR` to use temp or project-specific locations.

```bash
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor plan "Add login audit logging"
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor contract <runId>
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor approve <runId>
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor workspace create <runId>
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor generate <runId> --adapter fixture
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor generate <runId> --adapter codex
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor evaluate <runId> --adapter fixture --verdict pass
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor run-retry <runId> --fail-times 1
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor workspace status <runId>
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor workspace cleanup <runId>
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor status <runId>
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl ANCHOR_RUNS_DIR=/tmp/anchor-runs ANCHOR_WORKTREES_DIR=/tmp/anchor-worktrees pnpm anchor events <runId>
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl pnpm anchor demo
ANCHOR_STORE_PATH=/tmp/anchor-runs.jsonl pnpm anchor demo --fixture retry
```

CLI command output is stable JSON for `plan`, `contract`, `approve`, `workspace create`, `generate`, `evaluate`, `run-retry`, `workspace status`, `workspace cleanup`, `demo`, `status`, and `events`. `plan` creates a standard-mode contract and leaves the run in `HUMAN`. `approve` reads the contract artifact, computes its SHA-256, and appends `CONTRACT_APPROVED` by `human` with `contract_id` and `contract_sha`, moving the run to `BUILD`. `workspace create` requires that approved `BUILD` state, creates an isolated git worktree and branch, writes workspace metadata, and appends `WORKSPACE_CREATED` by `system`. `generate` requires `BUILD`, an active workspace, and an approved contract; the fixture adapter writes inside the worktree, validates changed files against the contract allowlist/denylist, writes a generator report, and appends `CODE_PRODUCED(generator)` only on policy success. `evaluate` requires `CHECK`, an active workspace, a contract, and a generator report; the fixture adapter inspects worktree changes, writes an evaluator report, and appends `EVAL_COMPLETE(evaluator)`. `run-retry` requires `BUILD` or `CHECK`, an active workspace, and a contract; it repeatedly runs fixture generation/evaluation until PASS reaches `DONE` or retry budget is exhausted to `HUMAN`. `workspace cleanup` removes only the metadata-recorded worktree path, writes a cleanup tombstone, and appends `WORKSPACE_CLEANED` by `system`. `status` and `contract` report a dirty warning when the current artifact SHA differs from the approved SHA.

`events` includes `seq`, `event_type`, `payload`, `emitted_by`, `state_before`, and `state_after`.

### Contract Artifacts

The R5 deterministic planner template writes YAML with:

- `id`
- `version`
- `goal.summary`
- `mode`
- `steps`
- `acceptance_criteria`
- `files.allowlist`
- `files.denylist`
- `commands`
- `non_goals`

There is no LLM or provider call in the deterministic contract flow. The contract artifact is generated from the task string and run id.

### Workspace Management

The R6 workspace layer records metadata at `.anchor/runs/<runId>/workspace.json`:

- `runId`
- `baseCommit`
- `branch`
- `worktreePath`
- `createdAt`
- `contractSha`
- `cleanedAt` after cleanup

`anchor workspace create <runId>` is idempotent for the same run. Repeated create returns the existing metadata instead of creating another branch or worktree. `anchor workspace status <runId>` reports whether the path exists, whether it is a git worktree, whether it is clean, and the changed files from `git status --porcelain`. `anchor workspace cleanup <runId>` removes the metadata-recorded worktree and leaves run history intact.

Workspace audit events are active-state no-ops: `WORKSPACE_CREATED(system)` and `WORKSPACE_CLEANED(system)` preserve the current active state, including `BUILD` and `CHECK`. Terminal states still reject further events, so cleanup in `DONE` or `ABORT` is rejected before filesystem or metadata mutation.

There is no provider call, evaluator adapter, retry loop, or real sandbox in R6. The worktree only prepares an isolated git workspace for Generator adapters.

### Generator Adapter

R7 adds a deterministic local fixture adapter:

```bash
anchor generate <runId> --adapter fixture
```

The fixture writes `anchor-output/<runId>.txt` inside the recorded worktree, then reads changed files from `git status --porcelain`. It validates those files with `validateWorkspacePolicy({ role: "generator", allowlist, denylist })`, where allowlist and denylist are read from the approved `contract.yaml`.

On success, Anchor writes `.anchor/runs/<runId>/generator-report.json` with:

- `adapter`
- `fixture`
- `runId`
- `startedAt`
- `finishedAt`
- `filesChanged`
- `policyResult`
- `commitSha`
- `summary`

Then it appends `CODE_PRODUCED(generator)` with the report path, files changed, and attempt number. The run moves from `BUILD` to `CHECK`.

For policy testing, `anchor generate <runId> --adapter fixture --fixture outside` writes outside the allowlist. That path writes a failure report but does not append `CODE_PRODUCED` and does not advance the run.

R10 adds a Codex CLI generator adapter:

```bash
anchor generate <runId> --adapter codex
```

The Codex adapter requires `BUILD`, an active git worktree, and an approved contract. Anchor invokes `codex exec` from the recorded worktree cwd and passes a prompt containing the approved contract, worktree path, allowlist, denylist, and explicit instructions not to read or persist secrets, perform network operations, approve, evaluate, merge, commit, or push.

After the command exits, Anchor collects changed files from the worktree, validates them with the same generator policy guard, writes `.anchor/runs/<runId>/generator-report.json`, and appends `CODE_PRODUCED(generator)` only when the command exits zero, changes at least one file, and passes policy.

The Codex generator report includes `adapter="codex"`, `command`, redacted `argv`, `exitCode`, `stdoutSummary`, `stderrSummary`, `filesChanged`, `policyResult`, `commitSha`, and `summary`. The full prompt is not written to the report.

Failure behavior is structured and does not advance state:

- Missing Codex command returns `CODEX_CLI_UNAVAILABLE` without appending `CODE_PRODUCED`.
- Non-zero Codex exit returns `CODEX_COMMAND_FAILED`, writes a failure report, and does not append `CODE_PRODUCED`.
- Zero-exit no-op returns `CODEX_NO_CHANGES`, writes a failure report, and does not append `CODE_PRODUCED`.
- Policy violation returns `POLICY_VIOLATION`, writes a failure report, and does not append `CODE_PRODUCED`.

Automated tests do not require a real Codex installation. Set `ANCHOR_CODEX_COMMAND` and `ANCHOR_CODEX_ARGV_JSON` to point at a fake command; Anchor appends the generated prompt as the final argv element. Production defaults to `codex exec --cd <worktree> --sandbox workspace-write --ask-for-approval never <prompt>`.

### Evaluator Adapter

R8 adds a deterministic local fixture evaluator:

```bash
anchor evaluate <runId> --adapter fixture --verdict pass|fail
```

The fixture evaluator reads the approved contract, the generator report, and worktree changed files. Verdict input is case-insensitive but must normalize to `pass` or `fail`; missing, empty, or unsupported values return `INVALID_VERDICT` without writing an evaluator report, appending `EVAL_COMPLETE`, or changing run state. It does not write source files or mutate the worktree; it writes only `.anchor/runs/<runId>/evaluator-report.json` with:

- `adapter`
- `verdict`
- `runId`
- `startedAt`
- `finishedAt`
- `testsRun`
- `testsFailed`
- `feedback`
- `filesInspected`
- `generatorReportPath`
- `summary`

Then it appends `EVAL_COMPLETE(evaluator)` with verdict, report path, tests run, tests failed, and feedback. `--verdict pass` moves `CHECK -> DONE`. `--verdict fail` moves `CHECK -> BUILD` while retries remain, or `CHECK -> HUMAN` when retry budget is exhausted. R8 does not automatically rerun Generator.

### Retry Orchestration

R9 adds deterministic fixture retry orchestration:

```bash
anchor run-retry <runId> --fail-times <n>
```

The run must already be approved and have an active workspace. `run-retry` accepts current state `BUILD` or `CHECK`; other states return `run_retry_requires_build_or_check_state`. `--fail-times` must be a non-negative integer and defaults to `0`.

Each `BUILD` step runs the fixture generator and writes `.anchor/runs/<runId>/attempts/<n>/generator-report.json`. Each `CHECK` step runs the fixture evaluator and writes `.anchor/runs/<runId>/attempts/<n>/evaluator-report.json`. Attempt report paths are unique and do not overwrite the single-step `generator-report.json` / `evaluator-report.json` files used by `generate` and `evaluate`.

Event payloads include attempt numbers:

- `CODE_PRODUCED(generator)` includes `attempt`, `report_path`, and `files_changed`
- `EVAL_COMPLETE(evaluator)` includes `attempt`, `verdict`, `report_path`, tests run, tests failed, and feedback

`--fail-times 0` evaluates PASS on the first attempt and reaches `DONE`. `--fail-times 1` fails once, returns to `BUILD`, generates a second attempt, then passes and reaches `DONE`. A fail count above the retry budget eventually reaches `HUMAN` with `retriesLeft` at `0`. R9/R10 retry still uses fixture generation/evaluation only; it does not call Codex, merge/commit output, or clean the worktree.

### State Machine Core

The R1 core exports a pure `transition(state, event, context)` function and TypeScript types from `src/core/state-machine.ts`.

```typescript
import { transition } from "anchor";

const result = transition(
  "PLAN",
  {
    type: "CONTRACT_PRODUCED",
    mode: "quick",
    reasoning: "Small local change",
    affected_scope: ["src/"]
  },
  {
    retriesLeft: 3,
    reviewRetriesLeft: 2
  }
);
```

### Event-Sourced Run Store

The R2 API exports a default JSONL file store from `src/core/run-store.ts`. Current state is replayed from persisted events; there is no separate current-state field.

```typescript
import { createFileRunStore } from "anchor";

const store = createFileRunStore(".anchor/events.jsonl");
await store.createRun("Fix login bug", { id: "run_1" });
await store.appendEvent(
  "run_1",
  {
    type: "CONTRACT_PRODUCED",
    mode: "quick",
    reasoning: "Small local change",
    affected_scope: ["src/"]
  },
  "planner"
);

const snapshot = await store.getCurrentState("run_1");
```

### Permission Guards

The R3 API exports pure permission helpers from `src/core/permissions.ts`.

```typescript
import { validateEventSource, validateWorkspacePolicy } from "anchor";

validateEventSource("planner", "CONTRACT_PRODUCED");
validateWorkspacePolicy({
  role: "generator",
  changedFiles: ["src/core/state-machine.ts"],
  allowlist: ["src/**"],
  denylist: ["secrets/**"]
});
```

The run store calls `validateEventSource` before transition evaluation and refuses unauthorized events without writing them. Workspace policy helpers are pure checks only; R8 does not implement a real filesystem sandbox or git diff enforcement.

R8 does not include provider adapters, retry loop, real filesystem sandboxing, git diff enforcement, or Web UI.

---

## Status

**R8 Evaluator adapter MVP.** Deterministic `plan`, `contract`, `approve`, `workspace create`, `generate --adapter fixture`, `evaluate --adapter fixture`, `workspace status`, and `workspace cleanup` commands are in place, with `.anchor/runs/<runId>/contract.yaml`, approved contract SHA events, `.anchor/runs/<runId>/workspace.json`, git worktree metadata, active-state workspace audit events, `.anchor/runs/<runId>/generator-report.json`, `.anchor/runs/<runId>/evaluator-report.json`, `CODE_PRODUCED(generator)` events, `EVAL_COMPLETE(evaluator)` events, status/contract dirty warnings, the deterministic CLI demo, TypeScript project skeleton, transition core, JSONL event-sourced run store, permission/source guards, workspace policy helpers, and test/build baseline. Providers, retry loop, real filesystem sandboxing, git diff enforcement, and Web UI are not implemented yet.

---

## License

MIT
