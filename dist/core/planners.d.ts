import { type CommandRunner } from "./agent-runner.js";
import { type AnchorConfig } from "./config.js";
export type RunPlannerInput = {
    taskId: string;
    taskDescription: string;
    artifactsDir: string;
    adapter: string;
    repoPath: string;
    config?: AnchorConfig;
    mode?: "quick" | "standard" | "thorough";
    previousReviewerFeedback?: string | null;
    previousReviewerReportPath?: string | null;
    operatorSteer?: string | null;
};
export type PlannerOk = {
    ok: true;
    mode: "quick" | "standard" | "thorough";
    reasoning: string;
    affectedScope: string[];
    contractYaml: string;
};
export type PlannerError = {
    ok: false;
    code: string;
    message: string;
};
export declare function runPlanner(input: RunPlannerInput, runner?: CommandRunner): Promise<PlannerOk | PlannerError>;
export declare function runFixturePlanner(input: RunPlannerInput): Promise<PlannerOk | PlannerError>;
