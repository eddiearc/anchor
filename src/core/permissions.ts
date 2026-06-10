import { type Event } from "./state-machine.js";

export const AGENT_ROLES = ["planner", "reviewer", "generator", "evaluator", "human", "system"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export type PermissionOk = {
  ok: true;
};

export type PermissionDenied = {
  ok: false;
  code:
    | "UNKNOWN_ROLE"
    | "EVENT_SOURCE_DENIED"
    | "GENERATOR_WRITE_OUTSIDE_ALLOWLIST"
    | "GENERATOR_WRITE_IN_DENYLIST"
    | "EVALUATOR_WRITE_OUTSIDE_SANDBOX"
    | "ROLE_WRITE_DENIED";
  message: string;
};

export type PermissionResult = PermissionOk | PermissionDenied;

export type WorkspacePolicyInput = {
  role: AgentRole;
  changedFiles: string[];
  allowlist?: string[];
  denylist?: string[];
};

const EVENT_SOURCE_PERMISSIONS: Record<AgentRole, Event["type"][]> = {
  system: ["TASK_RECEIVED", "WORKSPACE_CREATED", "WORKSPACE_CLEANED"],
  planner: ["CONTRACT_PRODUCED"],
  reviewer: ["REVIEW_COMPLETE"],
  human: ["CONTRACT_APPROVED", "HUMAN_FORCE_PASS", "HUMAN_AMEND_PLAN", "HUMAN_ABORT", "CONTRACT_REVISED"],
  generator: ["CODE_PRODUCED", "RUN_COMPLETE"],
  evaluator: ["EVAL_COMPLETE"]
};

export function validateEventSource(role: string, eventType: Event["type"]): PermissionResult {
  if (!isAgentRole(role)) {
    return {
      ok: false,
      code: "UNKNOWN_ROLE",
      message: `Unknown role: ${role}`
    };
  }

  if (!EVENT_SOURCE_PERMISSIONS[role].includes(eventType)) {
    return {
      ok: false,
      code: "EVENT_SOURCE_DENIED",
      message: `${role} is not authorized to emit ${eventType}`
    };
  }

  return { ok: true };
}

export function validateWorkspacePolicy(input: WorkspacePolicyInput): PermissionResult {
  if (input.changedFiles.length === 0) {
    return { ok: true };
  }

  if (input.role === "generator") {
    return validateGeneratorFiles(input.changedFiles, input.allowlist ?? [], input.denylist ?? []);
  }

  if (input.role === "evaluator") {
    const deniedPath = input.changedFiles.find((file) => !matchesPattern(file, ".anchor/eval/tests/**"));
    if (deniedPath) {
      return {
        ok: false,
        code: "EVALUATOR_WRITE_OUTSIDE_SANDBOX",
        message: `Evaluator write outside .anchor/eval/tests/**: ${deniedPath}`
      };
    }
    return { ok: true };
  }

  if (input.role === "planner" || input.role === "reviewer") {
    return {
      ok: false,
      code: "ROLE_WRITE_DENIED",
      message: `${input.role} is not allowed to write source or test files`
    };
  }

  return { ok: true };
}

function validateGeneratorFiles(changedFiles: string[], allowlist: string[], denylist: string[]): PermissionResult {
  const deniedByDenylist = changedFiles.find((file) => denylist.some((pattern) => matchesPattern(file, pattern)));
  if (deniedByDenylist) {
    return {
      ok: false,
      code: "GENERATOR_WRITE_IN_DENYLIST",
      message: `Generator changed denied file: ${deniedByDenylist}`
    };
  }

  const outsideAllowlist = changedFiles.find((file) => !allowlist.some((pattern) => matchesPattern(file, pattern)));
  if (outsideAllowlist) {
    return {
      ok: false,
      code: "GENERATOR_WRITE_OUTSIDE_ALLOWLIST",
      message: `Generator changed file outside allowlist: ${outsideAllowlist}`
    };
  }

  return { ok: true };
}

function matchesPattern(filePath: string, pattern: string) {
  const normalizedFile = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    const remainder = normalizedFile.slice(prefix.length + 1);
    return normalizedFile.startsWith(`${prefix}/`) && remainder.length > 0 && !remainder.includes("/");
  }

  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function isAgentRole(role: string): role is AgentRole {
  return AGENT_ROLES.includes(role as AgentRole);
}
