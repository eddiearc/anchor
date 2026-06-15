export const ACTIVE_STATES = ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"];
export const TERMINAL_STATES = ["DONE", "ABORT"];
export const STATES = [...ACTIVE_STATES, ...TERMINAL_STATES];
export function transition(state, event, context) {
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
    if (isWorkspaceAuditEvent(event) && isActiveState(state)) {
        return ok(state, context);
    }
    if (isInfoEvent(event) && isActiveState(state)) {
        return ok(state, context);
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
function transitionFromPlan(event, context, state) {
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
function transitionFromReview(event, context, state) {
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
function transitionFromHuman(event, context, state) {
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
function transitionFromCheck(event, context, state) {
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
function ok(state, context) {
    return { ok: true, state, context };
}
function error(code, message, state, event, context) {
    return {
        ok: false,
        code,
        message,
        state,
        eventType: event.type,
        context
    };
}
function isActiveState(state) {
    return state !== null && ACTIVE_STATES.includes(state);
}
function isTerminalState(state) {
    return TERMINAL_STATES.includes(state);
}
function isWorkspaceAuditEvent(event) {
    return event.type === "WORKSPACE_CREATED" || event.type === "WORKSPACE_CLEANED";
}
function isInfoEvent(event) {
    return event.type === "RUN_COMPLETE" || event.type === "CONTRACT_REVISED" || event.type === "MERGED";
}
function isMode(mode) {
    return mode === "quick" || mode === "standard" || mode === "thorough";
}
function isReviewVerdict(verdict) {
    return verdict === "READY" || verdict === "NEEDS_REVISION";
}
function isEvalVerdict(verdict) {
    return verdict === "PASS" || verdict === "FAIL";
}
