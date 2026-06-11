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

export function resolveProvider<TInput, TResult>(
  providers: Array<ProviderDefinition<TInput, TResult>>,
  providerId: string,
  role: ProviderRole
): ProviderDefinition<TInput, TResult> | ProviderError {
  const provider = providers.find((candidate) => candidate.id === providerId);
  const availableProviders = providers.map((candidate) => candidate.id);
  if (!provider) {
    return {
      ok: false,
      code: "UNKNOWN_PROVIDER",
      message: `Unknown ${role} provider: ${providerId}`,
      provider: providerId,
      role,
      availableProviders
    };
  }
  if (!provider.roles.includes(role)) {
    return {
      ok: false,
      code: "UNSUPPORTED_PROVIDER_ROLE",
      message: `Provider ${providerId} does not support role: ${role}`,
      provider: providerId,
      role,
      availableProviders
    };
  }
  return provider;
}
