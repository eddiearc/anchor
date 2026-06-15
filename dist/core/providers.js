export function resolveProvider(providers, providerId, role) {
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
