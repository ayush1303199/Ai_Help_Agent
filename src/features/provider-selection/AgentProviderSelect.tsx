import type { AgentProviderOption } from './useAgentProviderSelection';

interface AgentProviderSelectProps {
  agentId: string;
  value: string | null;
  providers: AgentProviderOption[];
  onChange: (providerId: string | null) => void;
}

export function AgentProviderSelect({
  agentId,
  value,
  providers,
  onChange,
}: AgentProviderSelectProps) {
  const eligibleProviders = providers.filter((provider) => provider.enabled && provider.hasApiKey);

  return (
    <label className="mb-4 block text-xs text-slate-400">
      Provider for this agent
      <select
        aria-label={`Provider for ${agentId}`}
        value={value || ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 outline-none focus:border-sky-400"
      >
        <option value="">Automatic (enabled provider fallback)</option>
        {eligibleProviders.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label} · {provider.model}{provider.status ? ` · ${provider.status}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
