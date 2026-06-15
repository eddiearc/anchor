import { type Event } from "./state-machine.js";
export declare const AGENT_ROLES: readonly ["planner", "reviewer", "generator", "evaluator", "human", "system"];
export type AgentRole = (typeof AGENT_ROLES)[number];
export type PermissionOk = {
    ok: true;
};
export type PermissionDenied = {
    ok: false;
    code: "UNKNOWN_ROLE" | "EVENT_SOURCE_DENIED" | "GENERATOR_WRITE_OUTSIDE_ALLOWLIST" | "GENERATOR_WRITE_IN_DENYLIST" | "EVALUATOR_WRITE_OUTSIDE_SANDBOX" | "ROLE_WRITE_DENIED";
    message: string;
};
export type PermissionResult = PermissionOk | PermissionDenied;
export type WorkspacePolicyInput = {
    role: AgentRole;
    changedFiles: string[];
    allowlist?: string[];
    denylist?: string[];
};
export declare function validateEventSource(role: string, eventType: Event["type"]): PermissionResult;
export declare function validateWorkspacePolicy(input: WorkspacePolicyInput): PermissionResult;
