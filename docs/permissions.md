# Agent Permission Model

Anchor runs four roles — Planner, Reviewer, Generator, Evaluator — each backed by a coding agent (Claude Code, Codex, Pi, etc.). Every role has bounded authority: what it can touch, what it can run, and what state transitions it can trigger.

Permissions are enforced at two layers:

1. **Capability layer**: What tools and filesystem access each role has. Enforced by the adapter before invoking the underlying agent.
2. **Transition layer**: Which events each role is authorized to emit into the state machine. Enforced by the orchestrator before accepting any structured output.

---

## Layer 1: Capability Permissions

These are injected into the agent's system prompt and enforced at the adapter level before each invocation. The underlying agent (e.g., Claude Code) is told "you may use these tools, you may not use those."

| Capability | Planner | Reviewer | Generator | Evaluator |
|---|---|---|---|---|
| **Read files** | ✅ | ✅ | ✅ | ✅ |
| **Write source files** | ❌ | ❌ | ✅ (contract allowlist only) | ❌ |
| **Write test files** | ❌ | ❌ | ✅ | ✅ (sandboxed: `.anchor/eval/tests/`) |
| **Delete files** | ❌ | ❌ | ❌ | ❌ |
| **Shell: run commands** | ❌ | ❌ | ✅ | ✅ |
| **Shell: install packages** | ❌ | ❌ | ❌ | ❌ |
| **Shell: git operations** | ❌ | ❌ | ✅ (branch, commit) | ❌ |
| **Network: outbound HTTP** | ❌ | ❌ | ❌ | ❌ |
| **Network: package registry** | ❌ | ❌ | ❌ | ❌ |
| **Read other roles' output** | ❌ | ❌ | ❌ | ❌ |
| **Read previous run logs** | ❌ | ❌ | ❌ | ❌ |
| **Access human** | ✅ (clarification) | ❌ | ❌ | ❌ |

### Why network is off

All roles run offline. Reasoning:
- Prevents non-deterministic behavior from API calls
- Prevents data exfiltration
- Generator can't "cheat" by fetching a library that does the work
- Package installs must happen before the run, not during

If a task genuinely needs network access (e.g., testing a real API), that's an explicit human opt-in: `anchor run --allow-network`.

### Allowlist enforcement

The Generator's writes are constrained to the contract's `files.allowlist`. Post-generation, Anchor verifies:

```bash
git diff --name-only HEAD | while read file; do
  if ! matches_allowlist "$file" "$contract_allowlist"; then
    fail "Generator wrote to unauthorized file: $file"
  fi
done
```

Files outside the allowlist are **reverted** and the `CODE_PRODUCED` event payload includes a violation flag.

### Evaluator sandbox

Evaluator's tests live in `.anchor/eval/tests/` — a directory that:
- Is created fresh before each `EVALUATING` state
- Is destroyed after evaluation completes
- Is gitignored
- Evaluator cannot `cd` out of this directory when writing files

---

## Layer 2: Transition Permissions

Each role is authorized to emit only specific event types. The orchestrator **rejects** any event from an unauthorized source — even if the payload is structurally valid.

### Permission Matrix

| Event | Planner | Reviewer | Generator | Evaluator | Human | System |
|---|---|---|---|---|---|---|
| `TASK_RECEIVED` | — | — | — | — | — | ✅ |
| `TRIAGE_COMPLETE` | ✅ | — | — | — | — | — |
| `CONTRACT_PRODUCED` | ✅ | — | — | — | — | — |
| `CONTRACT_REVISED` | ✅ | — | — | — | — | — |
| `REVIEW_COMPLETE` | — | ✅ | — | — | — | — |
| `CODE_PRODUCED` | — | — | ✅ | — | — | — |
| `EVAL_COMPLETE` | — | — | — | ✅ | — | — |
| `CONTRACT_APPROVED` | — | — | — | — | ✅ | — |
| `HUMAN_FORCE_PASS` | — | — | — | — | ✅ | — |
| `HUMAN_AMEND_PLAN` | — | — | — | — | ✅ | — |
| `HUMAN_ABORT` | — | — | — | — | ✅ | — |
| `MERGED` | — | — | — | — | — | ✅ |

### Why this matters

Without transition permissions, a hallucinating agent could:

- **Generator emits `CONTRACT_PRODUCED`**: Rewrites the plan mid-execution, bypassing Planner and Reviewer.
- **Evaluator emits `TRIAGE_COMPLETE`**: Bypasses Planner entirely, routing directly to Generator without a contract.
- **Planner emits `EVAL_COMPLETE (PASS)`**: Skips all code generation and evaluation, declaring success on nothing.

Transition permissions provide **defense in depth** — even if the state machine's `transition()` function guards against invalid state transitions, the orchestrator enforces source authorization as an independent check.

### Enforcement

```typescript
function validateEventSource(event: Event, source: AgentRole): boolean {
  return TRANSITION_PERMISSIONS[event.type]?.includes(source) ?? false
}

// In the orchestrator:
function handleAgentOutput(output: StructuredOutput, source: AgentRole): void {
  if (!validateEventSource(output.event, source)) {
    throw new PermissionError(
      `${source} is not authorized to emit ${output.event.type}`
    )
  }
  // Proceed to transition
}
```

---

## Layer 3: State-Event Guards

Beyond source authorization, each transition validates that the event is legal for the current state. This is the `transition()` function itself (see [state-machine.md](state-machine.md)), but key guards include:

| Guard | Check |
|---|---|
| State match | `transition(currentState, event) !== undefined` |
| Contract integrity | Contract file SHA matches approved version (between `AWAIT_PLAN_OK` and `MERGING`) |
| Retry budget | `retries_left > 0` for `RETRYING → GENERATING` |
| Workspace isolation | No cross-role file writes detected |

---

## Implementation Notes

### How permissions reach the agent

Each adapter constructs the system prompt with explicit permission boundaries:

```
You are the PLANNER role. Your permissions:
- You MAY read any file in the workspace.
- You MAY NOT write any file.
- You MAY NOT execute shell commands.
- You MAY NOT make network requests.
- You MAY ask the human clarifying questions about the task.

Your task: produce a structured contract in YAML format...
```

### Runtime permission checks

The orchestrator wraps each agent invocation:

```typescript
async function runRole(role: AgentRole, state: State, context: RunContext) {
  // 1. Validate this role is allowed in this state
  if (!ROLE_STATE_MAP[state].includes(role)) {
    throw new Error(`Role ${role} cannot run in state ${state}`)
  }

  // 2. Build permission-bounded prompt
  const prompt = buildPrompt(role, context)

  // 3. Invoke through adapter
  const output = await adapter.invoke(role, prompt, {
    tools: ALLOWED_TOOLS[role],        // capability filtering
    workspace: scopedWorkspace(role),  // filesystem scoping
  })

  // 4. Validate output structure
  const event = parseAndValidate(output, role)

  // 5. Validate source permission
  validateEventSource(event, role)

  // 6. Emit event → state machine transitions
  emit(event)
}
```

### Role-to-State Mapping

Each role can only be invoked from specific states:

| Role | Allowed States |
|---|---|
| Planner | `TRIAGING`, `PLANNING`, `PLAN_REVISING` |
| Reviewer | `REVIEWING` |
| Generator | `GENERATING` |
| Evaluator | `EVALUATING` |
| Human | `AWAIT_PLAN_OK`, `AWAIT_HUMAN` |
| System | `INIT`, `RETRYING`, `MERGING` |
