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
};

export type ReviewCompleteEvent = {
  type: "REVIEW_COMPLETE";
  verdict: ReviewVerdict;
};

export type ContractApprovedEvent = {
  type: "CONTRACT_APPROVED";
  contract_id: string;
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
};

export type EvalCompleteEvent = {
  type: "EVAL_COMPLETE";
  verdict: EvalVerdict;
};

export type Event =
  | TaskReceivedEvent
  | ContractProducedEvent
  | ReviewCompleteEvent
  | ContractApprovedEvent
  | HumanForcePassEvent
  | HumanAmendPlanEvent
  | HumanAbortEvent
  | CodeProducedEvent
  | EvalCompleteEvent;

export type RunContext = {
  retriesLeft: number;
  reviewRetriesLeft: number;
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
  if (event.type === "HUMAN_ABORT" && isActiveState(state)) {
    return ok("ABORT", context);
  }

  if (state === null) {
    if (event.type === "TASK_RECEIVED") {
      return ok("PLAN", context);
    }
    return error("INVALID_INITIAL_EVENT", "Initial state only accepts TASK_RECEIVED.", state, event, context);
  }

  if (isTerminalState(state)) {
    return error("INVALID_TERMINAL_TRANSITION", `Terminal state ${state} does not accept events.`, state, event, context);
  }

  switch (state) {
    case "PLAN":
      return transitionFromPlan(event, context, state);
    case "REVIEW":
      return transitionFromReview(event, context, state);
    case "HUMAN":
      return transitionFromHuman(event, context, state);
    case "BUILD":
      if (event.type === "CODE_PRODUCED") {
        return ok("CHECK", context);
      }
      break;
    case "CHECK":
      return transitionFromCheck(event, context, state);
  }

  return error("INVALID_STATE_EVENT", `${state} does not accept ${event.type}.`, state, event, context);
}

function transitionFromPlan(event: Event, context: RunContext, state: State): TransitionResult {
  if (event.type !== "CONTRACT_PRODUCED") {
    return error("INVALID_STATE_EVENT", "PLAN only accepts CONTRACT_PRODUCED.", state, event, context);
  }

  if (!isMode(event.mode)) {
    return error("INVALID_MODE", `Invalid mode: ${String(event.mode)}.`, state, event, context);
  }

  if (event.mode === "quick") {
    return ok("BUILD", context);
  }
  if (event.mode === "standard") {
    return ok("HUMAN", context);
  }
  return ok("REVIEW", context);
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
    return ok("DONE", context);
  }

  if (context.retriesLeft > 0) {
    return ok("BUILD", {
      ...context,
      retriesLeft: context.retriesLeft - 1
    });
  }

  return ok("HUMAN", context);
}

function ok(state: State, context: RunContext): TransitionOk {
  return { ok: true, state, context };
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

function isMode(mode: string): mode is Mode {
  return mode === "quick" || mode === "standard" || mode === "thorough";
}

function isReviewVerdict(verdict: string): verdict is ReviewVerdict {
  return verdict === "READY" || verdict === "NEEDS_REVISION";
}

function isEvalVerdict(verdict: string): verdict is EvalVerdict {
  return verdict === "PASS" || verdict === "FAIL";
}
