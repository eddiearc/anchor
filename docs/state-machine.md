# Anchor State Machine Specification

The state machine is Anchor's skeleton. It is **deterministic, event-sourced, and fully auditable**. LLMs are stateless pure functions called at each state — they produce structured outputs, and the state machine decides what happens next.

One rule governs the state design: **each state = an agent (or human) is actively doing work.** No interstitial states, no bookkeeping states.

---

## States

6 active states + 2 terminals = 8 total.

| State | Actor | Description |
|---|---|---|
| `PLAN` | Planner | Produces triage + contract in one call. Determines mode, writes contract. |
| `REVIEW` | Reviewer | Reviews contract for structural flaws before any code is written (thorough mode only). |
| `HUMAN` | Human | Dual-purpose: contract approval (standard/thorough) or escalation (after repeated failures). |
| `BUILD` | Generator | Writes code against the approved contract. |
| `CHECK` | Evaluator | Writes tests, runs tests, compares code against contract. |
| `DONE` | — | Terminal. Run succeeded. |
| `ABORT` | Human | Terminal. Run cancelled. |

---

## Events

Events are **immutable** and persisted to the event store before each transition.

### System Events

| Event | Payload |
|---|---|
| `TASK_RECEIVED` | `{ task: string }` |
| `RUN_COMPLETE` | `{ branch: string, commit_sha: string }` |

### Planner Events

| Event | Payload |
|---|---|
| `CONTRACT_PRODUCED` | `{ mode: 'quick' \| 'standard' \| 'thorough', reasoning: string, affected_scope: string[], contract?: Contract }` |

### Reviewer Events

| Event | Payload |
|---|---|
| `REVIEW_COMPLETE` | `{ verdict: 'READY' \| 'NEEDS_REVISION', gaps: Gap[] }` |

### Generator Events

| Event | Payload |
|---|---|
| `CODE_PRODUCED` | `{ report_path: string, files_changed: string[], attempt: number }` |

### Evaluator Events

| Event | Payload |
|---|---|
| `EVAL_COMPLETE` | `{ verdict: 'PASS' \| 'FAIL', feedback: FeedbackSpec, tests_added: number, tests_run: number, tests_failed: number }` |

### Human Events

| Event | Payload |
|---|---|
| `CONTRACT_APPROVED` | `{ contract_id: string }` |
| `HUMAN_FORCE_PASS` | `{ reason: string }` |
| `HUMAN_AMEND_PLAN` | `{ reason: string }` |
| `HUMAN_ABORT` | `{ reason?: string }` |

---

## Transition Function

`transition(state, event, context) → nextState`

```
(null)  — initial, no state yet
  TASK_RECEIVED               → PLAN

PLAN
  CONTRACT_PRODUCED           → BUILD    (if mode === 'quick')
  CONTRACT_PRODUCED           → HUMAN    (if mode === 'standard')
  CONTRACT_PRODUCED           → REVIEW   (if mode === 'thorough')

REVIEW
  REVIEW_COMPLETE (READY)     → HUMAN
  REVIEW_COMPLETE (NEEDS_REVISION)
    → PLAN                    (if review_retries_left > 0, decrement)
    → HUMAN                   (if review_retries_left == 0, force with warning)

HUMAN
  CONTRACT_APPROVED           → BUILD
  HUMAN_FORCE_PASS            → DONE
  HUMAN_AMEND_PLAN            → PLAN
  HUMAN_ABORT                 → ABORT

BUILD
  CODE_PRODUCED               → CHECK

CHECK
  EVAL_COMPLETE (PASS)        → DONE
  EVAL_COMPLETE (FAIL)
    → BUILD                   (if retries_left > 0, decrement)
    → HUMAN                   (if retries_left == 0)

// Abort from any non-terminal state
PLAN | REVIEW | HUMAN | BUILD | CHECK
  HUMAN_ABORT                 → ABORT
```

---

## Run Context

```typescript
interface RunContext {
  run_id: string
  task: string
  mode: 'quick' | 'standard' | 'thorough'
  contract_id?: string
  contract_sha?: string
  retries_left: number           // default: 3
  review_retries_left: number    // default: 2
  created_at: string
  updated_at: string
}
```

---

## Invariants

Guards checked before every transition. If violated → `HUMAN`.

| # | Invariant | When |
|---|---|---|
| I1 | Event source authorized (see permissions.md) | Every transition |
| I2 | Contract exists on disk | `BUILD`, `CHECK` |
| I3 | Contract SHA matches approved version | `CHECK` |
| I4 | Workspace clean (no uncommitted changes) | `BUILD` |
| I5 | Generator writes within contract allowlist | After `CODE_PRODUCED` |
| I6 | Evaluator writes only in `.anchor/eval/tests/` | After `EVAL_COMPLETE` |
| I7 | Retry budget honored | `CHECK(FAIL) → BUILD` only if `retries_left > 0` |
| I8 | Review budget honored | `REVIEW(NEEDS_REVISION) → PLAN` only if `review_retries_left > 0` |

---

## Error Handling

LLM call failures (timeout, rate limit, malformed output):

| State | Failure handling |
|---|---|
| `PLAN` | Retry once. Still fails → escalate to `HUMAN`. |
| `REVIEW` | Retry once. Still fails → auto-READY with warning, proceed to `HUMAN`. |
| `BUILD` | Retry once. Still fails → decrement `retries_left`, behave as `EVAL_COMPLETE(FAIL)`. |
| `CHECK` | Retry once. Still fails → escalate to `HUMAN`. |

---

## Event Store (SQLite)

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSON NOT NULL,
  emitted_by    TEXT NOT NULL,
  state_before  TEXT,           -- null for initial TASK_RECEIVED
  state_after   TEXT NOT NULL,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, seq)
);

CREATE INDEX idx_events_run ON events(run_id, seq);
```

### Current state

```typescript
function currentState(runId: string, context: RunContext): State | null {
  const events = db.all(
    'SELECT event_type, payload FROM events WHERE run_id = ? ORDER BY seq',
    [runId]
  )
  if (events.length === 0) return null
  return events.reduce(
    (state, e) => transition(state, { type: e.event_type, ...JSON.parse(e.payload) }, context),
    null as State | null
  )
}
```

### Time travel

Event store is append-only, transition function is pure. You can:

- **Rewind** to any event and replay
- **Branch** from any event with different model or mode
- **Audit** every decision — each event records emitter, state_before, state_after
