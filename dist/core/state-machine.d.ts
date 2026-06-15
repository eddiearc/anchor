export declare const ACTIVE_STATES: readonly ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK"];
export declare const TERMINAL_STATES: readonly ["DONE", "ABORT"];
export declare const STATES: readonly ["PLAN", "REVIEW", "HUMAN", "BUILD", "CHECK", "DONE", "ABORT"];
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
export type Event = TaskReceivedEvent | ContractProducedEvent | ReviewCompleteEvent | ContractApprovedEvent | WorkspaceCreatedEvent | WorkspaceCleanedEvent | HumanForcePassEvent | HumanAmendPlanEvent | HumanAbortEvent | CodeProducedEvent | EvalCompleteEvent | RunCompleteEvent | ContractRevisedEvent | MergedEvent;
export type RunContext = {
    retriesLeft: number;
    reviewRetriesLeft: number;
};
export type TransitionOk = {
    ok: true;
    state: State;
    context: RunContext;
};
export type TransitionErrorCode = "INVALID_INITIAL_EVENT" | "INVALID_TERMINAL_TRANSITION" | "INVALID_STATE_EVENT" | "INVALID_MODE" | "INVALID_REVIEW_VERDICT" | "INVALID_EVAL_VERDICT";
export type TransitionError = {
    ok: false;
    code: TransitionErrorCode;
    message: string;
    state: State | InitialState;
    eventType: string;
    context: RunContext;
};
export type TransitionResult = TransitionOk | TransitionError;
export declare function transition(state: State | InitialState, event: Event, context: RunContext): TransitionResult;
