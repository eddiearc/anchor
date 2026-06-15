export type ProviderRole = "generator" | "evaluator";
export type ProviderErrorCode = "UNKNOWN_PROVIDER" | "UNSUPPORTED_PROVIDER_ROLE";
export type ProviderError = {
    ok: false;
    code: ProviderErrorCode;
    message: string;
    provider: string;
    role: ProviderRole;
    availableProviders: string[];
};
export type ProviderDefinition<TInput, TResult> = {
    id: string;
    roles: ProviderRole[];
    run(input: TInput): Promise<TResult>;
};
export declare function resolveProvider<TInput, TResult>(providers: Array<ProviderDefinition<TInput, TResult>>, providerId: string, role: ProviderRole): ProviderDefinition<TInput, TResult> | ProviderError;
