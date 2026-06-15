export type AnchorAgent = "codex" | string;
export type AnchorConfig = {
    agent?: AnchorAgent;
    provider?: string;
    planner_provider?: string;
    reviewer_provider?: string;
    generator_provider?: string;
    evaluator_provider?: string;
    prompt?: string;
    planner_prompt?: string;
    reviewer_prompt?: string;
    generator_prompt?: string;
    evaluator_prompt?: string;
    agent_retry_max?: number;
    agent_retry_backoff_ms?: number;
    agent_allow_network?: boolean;
};
export declare function loadAnchorConfig(): Promise<AnchorConfig>;
export declare function composePrompt(config: AnchorConfig | undefined, roleKey: keyof AnchorConfig, base: string): string;
