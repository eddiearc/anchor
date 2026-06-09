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

## The Four Roles

Every task flows through up to four roles. They run in **separate processes, separate contexts, separate models** if you want. The only thing they share is the contract.

### Planner

Plans the work. Has two faces:

- **Lightweight triage**: A cheap initial scan that reads the file tree + package manifest and outputs `{ mode, reasoning, affected_scope }`. Used to route the task to the right execution mode.
- **Full planning**: Produces a structured `Contract` — task decomposition, ordered steps, testable acceptance criteria, allowlist/denylist, constraints, completion gate.

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

Anchor is built around a **deterministic finite state machine**. The state machine is the skeleton; LLMs are stateless pure functions called at each state. The machine decides what happens next based on **structured, verifiable outputs** — not on LLM quality judgments.

```
                          ┌──────────┐
                          │   INIT   │
                          └────┬─────┘
                               │ TASK_RECEIVED
                               ▼
                          ┌──────────┐
                          │ TRIAGING │   Planner 轻量扫描
                          └────┬─────┘
                               │ TRIAGE_COMPLETE
                               ▼
                          (auto-proceed)
                     ┌────────┼────────┐
               quick │        │        │ standard / thorough
                     │        │        │
                     ▼        │        ▼
              ┌──────────┐    │   ┌──────────────┐
              │GENERATING│    │   │  PLANNING    │   Planner 出完整合同
              └────┬─────┘    │   └──────┬───────┘
                     └──┬───────┬───┘
                        │       │
                 quick  │       │ standard
                        │       │
                   (auto)│       ▼
                        │ ┌────────────────┐
                        │ │ AWAIT_PLAN_OK │  人审合同 (standard)
                        │ └───────┬────────┘
                        │         │ CONTRACT_APPROVED
                        │         ▼
                        │    ┌──────────┐
                        │    │GENERATING│
                        │    └────┬─────┘
                        │         │
              thorough │         │
                       ▼         │
                  ┌──────────┐   │
                  │REVIEWING │   Reviewer 审合同
                  └────┬─────┘
                       │ REVIEW_COMPLETE
                  ┌────┼────┐
             READY│    │NEEDS_REVISION
                  │    ▼
                  │ ┌───────────────┐
                  │ │ PLAN_REVISING │  Planner 改合同
                  │ └───────┬───────┘
                  │         │ CONTRACT_REVISED
                  │         ▼
                  │    ┌──────────┐
                  │    │REVIEWING │  再审（最多 M 轮）
                  │    └────┬─────┘
                  │         │ READY
                  ▼         ▼
             ┌────────────────────┐
             │  AWAIT_PLAN_OK     │  人拍板最终合同 (thorough)
             └────────┬───────────┘
                      │ CONTRACT_APPROVED
                      ▼
                 ┌──────────────────────┐
                 │    GENERATING        │
                 └──────────┬───────────┘
                            │ CODE_PRODUCED
                            ▼
                 ┌──────────────────────┐
                 │    EVALUATING        │  写测试 + 跑测试 + 审代码
                 └──────────┬───────────┘
                            │ EVAL_COMPLETE
                   ┌────────┼────────┐
                   ▼        ▼        ▼
                 PASS     FAIL     FAIL
                   │        │    (retries_left > 0)
                   │        │        │
                   ▼        ▼        ▼
              ┌────────┐ ┌──────────────┐
              │MERGING │ │  RETRYING    │  retry_count++
              └────────┘ └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │  GENERATING  │  (同一合同, 新的尝试)
                         └──────────────┘
                                │
                   (loop back to EVALUATING)

              FAIL + retries_left == 0
                   │
                   ▼
         ┌──────────────────┐
         │  AWAIT_HUMAN     │  人介入
         └────┬─────┬───────┘
              │     │
      amend   │     │ force_pass
      plan    │     │
              ▼     ▼
    ┌───────────┐  ┌─────────┐
    │PLAN_REVISE│  │ MERGING │
    └───────────┘  └─────────┘
              │
        (re-enter planning flow)


    任何时刻 human 按 abort
         │
         ▼
    ┌──────────┐
    │ ABORTED  │
    └──────────┘
```

### State transitions are driven by verifiable structure

The state machine does not judge "good" or "bad." It only checks: **is the output structurally valid? What does the verdict field say?**

| Transition | Triggered by |
|---|---|
| TRIAGING → (auto-proceeds) | Planner outputs valid `{ mode, reasoning, affected_scope }` → auto-proceeds based on mode |
| REVIEWING → PLAN_REVISING | Reviewer outputs `{ verdict: NEEDS_REVISION, gaps: [...] }` |
| EVALUATING → RETRYING | Evaluator outputs `{ verdict: FAIL }` and `retries_left > 0` |
| EVALUATING → AWAIT_HUMAN | `{ verdict: FAIL }` and `retries_left == 0` |
| RETRYING → GENERATING | (automatic, increment retry_count) |

### Event sourcing

Every state transition is an **immutable event** persisted to SQLite. The current state is `events.reduce(transition, 'INIT')`.

- **Full audit trail**: know exactly why any decision was made
- **Crash recovery**: replay events to restore state
- **Time travel**: rewind to any event and branch (e.g., re-run Generator with a different model from the same contract)
- **No hidden state**: the event log IS the truth

---

## Mode Routing

Not every task needs all four roles. Anchor has three execution modes:

### quick — simple, local changes

```
Human sends task → Planner triage (auto) → Generator → Evaluator → merge

Skipped: full planning, Reviewer, human plan review
Still runs: Generator, Evaluator (every change gets tested independently)
```

Example: fix a CSS class, rename a variable, update a dependency version.

### standard — moderate features (default)

```
Human sends task → Planner triage (auto) → Planner full contract
  → Human reviews contract → Generator → Evaluator → (retry loop) → merge

Skipped: Reviewer (contract review)
```

Example: add a new API endpoint, refactor a module, add basic auth.

### thorough — complex, cross-domain changes

```
Human sends task → Planner triage (auto) → Planner full contract
  → Reviewer reviews contract → Planner revises → Reviewer re-reviews (up to M rounds)
  → Human approves final contract → Generator → Evaluator → (retry loop) → merge
```

Example: migrate payment provider, restructure database, add multi-tenant isolation.

### Triage is cheap and auto-proceeds

The triage step runs a **lightweight Planner scan** — reads the file tree and package manifest, outputs mode advice, costs one LLM call:

```json
{
  "mode": "thorough",
  "reasoning": "Cross-domain migration: billing, payment, subscription, and invoice modules all touched. External API dependency. Payment state machine involved.",
  "affected_scope": ["src/billing/", "src/payment/", "src/subscription/", "src/invoice/"]
}
```

**Auto-proceeds** — the result is displayed, then Anchor moves to the next state immediately. No human confirmation required. If the triage gets the mode wrong, the worst case is safe: quick mode on a complex task will fail in Generator/Evaluator and escalate. The human can always `Ctrl+C` to abort and re-run with `--mode`.

To force a specific mode (bypass triage entirely): `anchor run --mode quick|standard|thorough`.

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

# Run with auto-triage (default, no human confirmation)
anchor run "Add OAuth 2.0 device code flow"

# Bypass triage entirely, force a mode
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

# Dry run: Planner only
anchor plan "Add rate limiting" --mode thorough

# Resume after human intervention
anchor resume feat-oauth-42 --from generating

# Show run history and status
anchor status
anchor log feat-oauth-42

# Compare contracts across runs
anchor diff feat-oauth-42-run1 feat-oauth-42-run2

# Show event log for a run
anchor events feat-oauth-42
```

---

## Workflow Examples

### quick mode

```bash
$ anchor run "Fix login button alignment" --mode quick

Triage → quick (CSS-only, single component) — proceeding

Generating... done
Evaluating... PASS (2/2 tests pass, no regressions)

→ merged to feature/anchor-login-fix
```

### standard mode

```bash
$ anchor run "Add rate limiting to API gateway"
# default: auto-triage

Triage → standard (single module, moderate scope) — proceeding

Planning... contract produced → contracts/rate-limit-001.yaml
Review contract? [y/N/edit] y

Generating... done
Evaluating... FAIL
  Step 2: rate limit per-endpoint instead of per-IP
  Step 4: missing test for burst allowance
Retrying (1/3)...

Generating... done
Evaluating... PASS

→ merged to feature/anchor-rate-limiting
```

### thorough mode

```bash
$ anchor run "Migrate billing to new payment provider" --mode thorough

Triage → thorough — proceeding

Planning... contract produced → contracts/billing-migration-001.yaml
Reviewing... NEEDS_REVISION (3 gaps found)
  [critical] Payment state machine not in allowlist
  [high]     No rollback strategy defined
  [medium]   Constraint missing: don't break existing subscriptions

Plan revising... contract updated → v1.1
Reviewing... READY

Review final contract? [y/N/edit] y

Generating... done
Evaluating... FAIL
  Step 1: New provider adapter doesn't implement Refund interface
  Step 3: Migration script assumes synchronous — breaks for large accounts
Retrying (1/3)...

Generating... done
Evaluating... PASS

→ merged to feature/anchor-billing-migration
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

- [State Machine Specification](docs/state-machine.md) — Formal state machine: all states, events, transitions, invariants, error handling
- [Agent Permission Model](docs/permissions.md) — Two-layer permission design: capability permissions + transition permissions + enforcement

---

## Prior Art & References

- [Anthropic — Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) — PGE architecture inspiration
- [Martin Fowler — Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html) — Feedforward/feedback patterns
- [suhanlee/harness](https://github.com/suhanlee/harness) — Claude Code plugin implementing 3-agent PGE pipeline
- [mvschwarz/openrig](https://github.com/mvschwarz/openrig) — Multi-harness session management with YAML topologies
- [first-fluke/oh-my-agent](https://github.com/first-fluke/oh-my-agent) — Cross-harness skill/rule projection
- [SethGammon/Citadel](https://github.com/SethGammon/Citadel) — Harness runtime with routing, memory, Fleet

---

## Status

**Pre-implementation design phase.** This README is a design document. Nothing is built yet. Let's discuss, refine, then build.

---

## License

MIT
