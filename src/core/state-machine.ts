export const ACTIVE_STATES = ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"] as const;
export const TERMINAL_STATES = ["DONE", "ABORT"] as const;
export const STATES = [...ACTIVE_STATES, ...TERMINAL_STATES] as const;

export type ActiveState = (typeof ACTIVE_STATES)[number];
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type State = ActiveState | TerminalState;
export type InitialState = null;
export type Mode = "quick" | "standard" | "thorough";
export type ReviewVerdict = "READY" | "NEEDS_REVISION";
export type EvalVerdict = "PASS" | "FAIL";

export type TaskReceivedEvent = {
  type: "TASK_RECEIVED";
  task: string;
};

export type ContractProducedEvent = {
  type: "CONTRACT_PRODUCED";
  mode: Mode;
  reasoning: string;
  affected_scope: string[];
  contract_id?: string;
  step_ids?: string[];
};

export type ReviewCompleteEvent = {
  type: "REVIEW_COMPLETE";
  verdict: ReviewVerdict;
  feedback?: string;
  report_path?: string;
};

export type ContractApprovedEvent = {
  type: "CONTRACT_APPROVED";
  contract_id: string;
  contract_sha?: string;
};

export type WorkspaceCreatedEvent = {
  type: "WORKSPACE_CREATED";
  base_commit: string;
  branch: string;
  worktree_path: string;
  contract_sha: string;
};

export type WorkspaceCleanedEvent = {
  type: "WORKSPACE_CLEANED";
  worktree_path: string;
};

export type HumanForcePassEvent = {
  type: "HUMAN_FORCE_PASS";
  reason: string;
};

export type HumanAmendPlanEvent = {
  type: "HUMAN_AMEND_PLAN";
  reason: string;
};

export type HumanAbortEvent = {
  type: "HUMAN_ABORT";
  reason?: string;
};

export type CodeProducedEvent = {
  type: "CODE_PRODUCED";
  report_path: string;
  files_changed: string[];
  attempt: number;
  provider?: string;
  step_id?: string | null;
};

export type EvalCompleteEvent = {
  type: "EVAL_COMPLETE";
  verdict: EvalVerdict;
  attempt?: number;
  report_path?: string;
  tests_run?: number;
  tests_failed?: number;
  feedback?: string;
  provider?: string;
  criteria_results?: Array<{
    id: string;
    passes: boolean;
    evidence: string[];
  }>;
};

export type RunCompleteEvent = {
  type: "RUN_COMPLETE";
  report_path: string;
  attempt: number;
};

export type ContractRevisedEvent = {
  type: "CONTRACT_REVISED";
  reason: string;
};

export type MergedEvent = {
  type: "MERGED";
  branch: string;
  commit_sha: string;
};

export type Event =
  | TaskReceivedEvent
  | ContractProducedEvent
  | ReviewCompleteEvent
  | ContractApprovedEvent
  | WorkspaceCreatedEvent
  | WorkspaceCleanedEvent
  | HumanForcePassEvent
  | HumanAmendPlanEvent
  | HumanAbortEvent
  | CodeProducedEvent
  | EvalCompleteEvent
  | RunCompleteEvent
  | ContractRevisedEvent
  | MergedEvent;

export type RunContext = {
  retriesLeft: number;
  reviewRetriesLeft: number;
  stepRetriesLeft: number;
  stepIds: string[];
  currentStepId: string | null;
  completedStepIds: string[];
};

export type TransitionOk = {
  ok: true;
  state: State;
  context: RunContext;
};

export type TransitionErrorCode =
  | "INVALID_INITIAL_EVENT"
  | "INVALID_TERMINAL_TRANSITION"
  | "INVALID_STATE_EVENT"
  | "INVALID_MODE"
  | "INVALID_REVIEW_VERDICT"
  | "INVALID_EVAL_VERDICT";

export type TransitionError = {
  ok: false;
  code: TransitionErrorCode;
  message: string;
  state: State | InitialState;
  eventType: string;
  context: RunContext;
};

export type TransitionResult = TransitionOk | TransitionError;

export function transition(state: State | InitialState, event: Event, context: RunContext): TransitionResult {
  const normalizedContext = normalizeContext(context);

  if (event.type === "HUMAN_ABORT" && isActiveState(state)) {
    return ok("ABORT", normalizedContext);
  }

  if (state === null) {
    if (event.type === "TASK_RECEIVED") {
      return ok("PLAN", normalizedContext);
    }
    return error("INVALID_INITIAL_EVENT", "Initial state only accepts TASK_RECEIVED.", state, event, normalizedContext);
  }

  if (isTerminalState(state)) {
    return error("INVALID_TERMINAL_TRANSITION", `Terminal state ${state} does not accept events.`, state, event, normalizedContext);
  }

  if (isWorkspaceAuditEvent(event) && isActiveState(state)) {
    return ok(state, normalizedContext);
  }

  if (isInfoEvent(event) && isActiveState(state)) {
    return ok(state, normalizedContext);
  }

  switch (state) {
    case "PLAN":
      return transitionFromPlan(event, normalizedContext, state);
    case "REVIEW":
      return transitionFromReview(event, normalizedContext, state);
    case "HUMAN":
      return transitionFromHuman(event, normalizedContext, state);
    case "BUILD":
      if (event.type === "CODE_PRODUCED") {
        return ok("CHECK", normalizedContext);
      }
      break;
    case "CHECK":
      return transitionFromCheck(event, normalizedContext, state);
  }

  return error("INVALID_STATE_EVENT", `${state} does not accept ${event.type}.`, state, event, normalizedContext);
}

function transitionFromPlan(event: Event, context: RunContext, state: State): TransitionResult {
  if (event.type !== "CONTRACT_PRODUCED") {
    return error("INVALID_STATE_EVENT", "PLAN only accepts CONTRACT_PRODUCED.", state, event, context);
  }

  if (!isMode(event.mode)) {
    return error("INVALID_MODE", `Invalid mode: ${String(event.mode)}.`, state, event, context);
  }

  const stepContext = initializeStepContext(context, event.step_ids);
  if (event.mode === "quick") {
    return ok("BUILD", stepContext);
  }
  if (event.mode === "standard") {
    return ok("HUMAN", stepContext);
  }
  return ok("REVIEW", stepContext);
}

function transitionFromReview(event: Event, context: RunContext, state: State): TransitionResult {
  if (event.type !== "REVIEW_COMPLETE") {
    return error("INVALID_STATE_EVENT", "REVIEW only accepts REVIEW_COMPLETE.", state, event, context);
  }

  if (!isReviewVerdict(event.verdict)) {
    return error("INVALID_REVIEW_VERDICT", `Invalid review verdict: ${String(event.verdict)}.`, state, event, context);
  }

  if (event.verdict === "READY") {
    return ok("HUMAN", context);
  }

  if (context.reviewRetriesLeft > 0) {
    return ok("PLAN", {
      ...context,
      reviewRetriesLeft: context.reviewRetriesLeft - 1
    });
  }

  return ok("HUMAN", context);
}

function transitionFromHuman(event: Event, context: RunContext, state: State): TransitionResult {
  if (event.type === "CONTRACT_APPROVED") {
    return ok("BUILD", context);
  }
  if (event.type === "HUMAN_FORCE_PASS") {
    return ok("DONE", context);
  }
  if (event.type === "HUMAN_AMEND_PLAN") {
    return ok("PLAN", context);
  }
  return error("INVALID_STATE_EVENT", `HUMAN does not accept ${event.type}.`, state, event, context);
}

function transitionFromCheck(event: Event, context: RunContext, state: State): TransitionResult {
  if (event.type !== "EVAL_COMPLETE") {
    return error("INVALID_STATE_EVENT", "CHECK only accepts EVAL_COMPLETE.", state, event, context);
  }

  if (!isEvalVerdict(event.verdict)) {
    return error("INVALID_EVAL_VERDICT", `Invalid eval verdict: ${String(event.verdict)}.`, state, event, context);
  }

  if (event.verdict === "PASS") {
    return passCurrentStep(context);
  }

  if (context.currentStepId !== null && context.stepIds.length > 0) {
    if (context.stepRetriesLeft > 0) {
      return ok("BUILD", {
        ...context,
        stepRetriesLeft: context.stepRetriesLeft - 1
      });
    }

    return ok("HUMAN", context);
  }

  if (context.retriesLeft > 0) {
    return ok("BUILD", {
      ...context,
      retriesLeft: context.retriesLeft - 1
    });
  }

  return ok("HUMAN", context);
}

function initializeStepContext(context: RunContext, stepIds: string[] | undefined): RunContext {
  const cleanedStepIds = Array.from(new Set((stepIds ?? []).map((id) => id.trim()).filter(Boolean)));
  return {
    ...context,
    stepIds: cleanedStepIds,
    currentStepId: cleanedStepIds[0] ?? null,
    completedStepIds: [],
    stepRetriesLeft: 3
  };
}

function passCurrentStep(context: RunContext): TransitionResult {
  if (context.currentStepId === null || context.stepIds.length === 0) {
    return ok("DONE", context);
  }

  const completedStepIds = context.completedStepIds.includes(context.currentStepId)
    ? context.completedStepIds
    : [...context.completedStepIds, context.currentStepId];
  const nextStepId = context.stepIds.find((stepId) => !completedStepIds.includes(stepId)) ?? null;

  if (nextStepId) {
    return ok("BUILD", {
      ...context,
      currentStepId: nextStepId,
      completedStepIds,
      stepRetriesLeft: 3
    });
  }

  return ok("DONE", {
    ...context,
    currentStepId: null,
    completedStepIds,
    stepRetriesLeft: 3
  });
}

function ok(state: State, context: RunContext): TransitionOk {
  return { ok: true, state, context };
}

function normalizeContext(context: RunContext): RunContext {
  return {
    retriesLeft: context.retriesLeft,
    reviewRetriesLeft: context.reviewRetriesLeft,
    stepRetriesLeft: typeof context.stepRetriesLeft === "number" ? context.stepRetriesLeft : 3,
    stepIds: Array.isArray(context.stepIds) ? context.stepIds : [],
    currentStepId: typeof context.currentStepId === "string" ? context.currentStepId : null,
    completedStepIds: Array.isArray(context.completedStepIds) ? context.completedStepIds : []
  };
}

function error(
  code: TransitionErrorCode,
  message: string,
  state: State | InitialState,
  event: Event,
  context: RunContext
): TransitionError {
  return {
    ok: false,
    code,
    message,
    state,
    eventType: event.type,
    context
  };
}

function isActiveState(state: State | InitialState): state is ActiveState {
  return state !== null && ACTIVE_STATES.includes(state as ActiveState);
}

function isTerminalState(state: State): state is TerminalState {
  return TERMINAL_STATES.includes(state as TerminalState);
}

function isWorkspaceAuditEvent(event: Event) {
  return event.type === "WORKSPACE_CREATED" || event.type === "WORKSPACE_CLEANED";
}

function isInfoEvent(event: Event) {
  return event.type === "RUN_COMPLETE" || event.type === "CONTRACT_REVISED" || event.type === "MERGED";
}

function isMode(mode: string): mode is Mode {
  return mode === "quick" || mode === "standard" || mode === "thorough";
}

function isReviewVerdict(verdict: string): verdict is ReviewVerdict {
  return verdict === "READY" || verdict === "NEEDS_REVISION";
}

function isEvalVerdict(verdict: string): verdict is EvalVerdict {
  return verdict === "PASS" || verdict === "FAIL";
}
