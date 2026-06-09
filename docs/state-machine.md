# Anchor State Machine Specification

The state machine is Anchor's skeleton. It is **deterministic, event-sourced, and fully auditable**. LLMs are stateless pure functions called at each state — they produce structured outputs, and the state machine decides what happens next based on those outputs, not on LLM quality judgments.

---

## States

| State | Description | Who runs |
|---|---|---|
| `INIT` | Task received, nothing started | — |
| `TRIAGING` | Planner lightweight scan to determine mode | Planner (triage) |
| `PLANNING` | Planner producing full contract | Planner (full) |
| `AWAIT_PLAN_OK` | Waiting for human to approve contract | Human |
| `REVIEWING` | Reviewer checking contract for structural flaws | Reviewer |
| `PLAN_REVISING` | Planner revising contract based on Reviewer feedback | Planner (full) |
| `GENERATING` | Generator writing code | Generator |
| `EVALUATING` | Evaluator testing and reviewing code | Evaluator |
| `RETRYING` | Between failed evaluation and next generator attempt | — |
| `AWAIT_HUMAN` | Repeated failures, waiting for human decision | Human |
| `MERGING` | All gates passed, merging code | System |
| `ABORTED` | Human terminated the run | Human |

---

## Events

Events are **immutable** and persisted to the event store before each transition.

### System Events

| Event | Payload | Emitted by |
|---|---|---|
| `TASK_RECEIVED` | `{ task: string }` | Anchor CLI |
| `MERGED` | `{ branch: string, commit_sha: string }` | Orchestrator |
| `ABORTED` | `{ reason: string }` | Human |

### Planner Events

| Event | Payload | Emitted by |
|---|---|---|
| `TRIAGE_COMPLETE` | `{ mode: 'quick' \| 'standard' \| 'thorough', reasoning: string, affected_scope: string[] }` | Planner (triage) |
| `CONTRACT_PRODUCED` | `{ contract_id: string, contract_path: string }` | Planner (full) |
| `CONTRACT_REVISED` | `{ contract_id: string, version: string, changes: string }` | Planner (full) |

### Reviewer Events

| Event | Payload | Emitted by |
|---|---|---|
| `REVIEW_COMPLETE` | `{ verdict: 'READY' \| 'NEEDS_REVISION', gaps: Gap[], review_id: string }` | Reviewer |

### Generator Events

| Event | Payload | Emitted by |
|---|---|---|
| `CODE_PRODUCED` | `{ report_path: string, files_changed: string[], attempt: number }` | Generator |

### Evaluator Events

| Event | Payload | Emitted by |
|---|---|---|
| `EVAL_COMPLETE` | `{ verdict: 'PASS' \| 'FAIL', feedback: FeedbackSpec, tests_added: number, tests_run: number, tests_failed: number }` | Evaluator |

### Human Events

| Event | Payload | Emitted by |
|---|---|---|
| `CONTRACT_APPROVED` | `{ contract_id: string }` | Human |
| `HUMAN_FORCE_PASS` | `{ reason: string }` | Human |
| `HUMAN_AMEND_PLAN` | `{ reason: string }` | Human |

---

## Transition Function

`transition(state, event) → nextState`

```
INIT
  TASK_RECEIVED               → TRIAGING

TRIAGING
  TRIAGE_COMPLETE             → GENERATING     (if mode === 'quick')
  TRIAGE_COMPLETE             → PLANNING       (if mode !== 'quick')

PLANNING
  CONTRACT_PRODUCED           → GENERATING     (if mode === 'quick')
  CONTRACT_PRODUCED           → AWAIT_PLAN_OK  (if mode === 'standard')
  CONTRACT_PRODUCED           → REVIEWING      (if mode === 'thorough')

AWAIT_PLAN_OK
  CONTRACT_APPROVED           → GENERATING

REVIEWING
  REVIEW_COMPLETE (READY)     → AWAIT_PLAN_OK
  REVIEW_COMPLETE (NEEDS_REVISION) → PLAN_REVISING

PLAN_REVISING
  CONTRACT_REVISED            → REVIEWING

GENERATING
  CODE_PRODUCED               → EVALUATING

EVALUATING
  EVAL_COMPLETE (PASS)        → MERGING
  EVAL_COMPLETE (FAIL)        → RETRYING       (if retries_left > 0)
  EVAL_COMPLETE (FAIL)        → AWAIT_HUMAN    (if retries_left == 0)

RETRYING
  (automatic)                 → GENERATING     (increments retry_count)

AWAIT_HUMAN
  HUMAN_FORCE_PASS            → MERGING
  HUMAN_AMEND_PLAN            → PLAN_REVISING
  HUMAN_ABORT                 → ABORTED

MERGING
  MERGED                      → (terminal)

// Human can abort from any non-terminal state
ANY_STATE
  HUMAN_ABORT                 → ABORTED
```

---

## Run Context

Each run holds mutable context alongside the immutable event stream:

```typescript
interface RunContext {
  run_id: string
  task: string
  mode: 'quick' | 'standard' | 'thorough'
  contract_id?: string
  retries_left: number          // default: 3
  review_retries_left: number   // default: 2 (for thorough mode review loop)
  max_retries: number           // default: 3
  max_review_retries: number    // default: 2
  created_at: string
  updated_at: string
}
```

---

## Invariants

Guards that must hold before every transition. If violated, the transition is rejected and the run moves to `AWAIT_HUMAN`.

| # | Invariant | Guard |
|---|---|---|
| I1 | Event source permission | The agent emitting the event must be authorized for that event type (see [permissions.md](permissions.md)) |
| I2 | Contract exists | `GENERATING` and `EVALUATING` require a valid, approved contract on disk |
| I3 | Contract unchanged | Between `AWAIT_PLAN_OK` and `MERGING`, the contract file must not be modified by any agent other than Planner during `PLAN_REVISING` |
| I4 | Workspace clean | `GENERATING` must start from a clean git state (no uncommitted changes from prior runs) |
| I5 | Retry budget | `RETRYING → GENERATING` only if `retries_left > 0` |
| I6 | Review budget | `REVIEWING → PLAN_REVISING` only if `review_retries_left > 0` |
| I7 | Evaluator isolation | Evaluator's test files exist in `.anchor/eval/tests/` only; Evaluator must not write to `src/`, `test/`, or any allowlisted path |
| I8 | Allowlist enforcement | Generator must not write to files outside contract allowlist (checked via git diff after `CODE_PRODUCED`) |

---

## Event Store (SQLite)

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSON NOT NULL,
  emitted_by  TEXT NOT NULL,  -- 'planner' | 'reviewer' | 'generator' | 'evaluator' | 'human' | 'system'
  state_before TEXT NOT NULL,
  state_after  TEXT NOT NULL,
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, seq)
);

CREATE INDEX idx_events_run ON events(run_id, seq);
```

### Replaying state

```typescript
function currentState(runId: string): State {
  const events = db.all(
    'SELECT event_type, payload FROM events WHERE run_id = ? ORDER BY seq',
    [runId]
  )
  return events.reduce(
    (state, e) => transition(state, { type: e.event_type, ...JSON.parse(e.payload) }),
    'INIT' as State
  )
}
```

---

## Error States

If an LLM call fails (timeout, rate limit, invalid output):

| Failure in state | Behavior |
|---|---|
| `TRIAGING` | Retry once. If still fails, default to `standard` mode. |
| `PLANNING` | Retry once. If still fails, escalate to `AWAIT_HUMAN`. |
| `REVIEWING` | Retry once. If still fails, skip review (auto-READY with warning). |
| `GENERATING` | Retry once. If still fails, decrement `retries_left` and go to `RETRYING`. |
| `EVALUATING` | Retry once. If still fails, escalate to `AWAIT_HUMAN`. |

---

## Visual Diagram

See README.md for the full state machine diagram.
