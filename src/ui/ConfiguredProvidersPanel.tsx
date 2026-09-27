import {
  getCapabilityState,
  getProviderModelValidationError,
} from '../config/providerRegistry.helpers';

interface ConfiguredProvider {
  id: string;
  label: string;
  adapterType: string;
  model: string;
  baseURL?: string;
  enabled: boolean;
  priority: number;
  status?: string;
  assistantCapable?: boolean;
  developerToolCalling?: boolean;
  developerToolCallingVerified?: boolean;
  developerStatus?: string;
  hasApiKey?: boolean;
  capabilities?: { stt?: boolean };
  capabilityStates?: Record<string, 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'>;
  failureCategory?: string;
  failureDetails?: {
    category?: string;
    reason?: string;
    statusCode?: number | null;
    rawMessage?: string;
    requestCapture?: { method?: string; url?: string; body?: string };
  };
  configurationValid?: boolean;
  configurationError?: { code?: string; message?: string };
}

interface ConfiguredProvidersPanelProps {
  providers: ConfiguredProvider[];
  activeProviderId: string | null;
  speechProviderId: string;
  onSpeechProviderChange: (providerId: string) => void;
  selfTestingProviderId: string | null;
  providerRefreshing: boolean;
  onRefresh: () => void;
  onMove: (provider: ConfiguredProvider, direction: -1 | 1) => void;
  onToggle: (provider: ConfiguredProvider) => void;
  onRemove: (provider: ConfiguredProvider) => void;
  onEdit: (provider: ConfiguredProvider) => void;
  onSetActive: (provider: ConfiguredProvider) => void;
  onSelfTest: (provider: ConfiguredProvider) => void;
}

export function ConfiguredProvidersPanel({
  providers,
  activeProviderId,
  speechProviderId,
  onSpeechProviderChange,
  selfTestingProviderId,
  providerRefreshing,
  onRefresh,
  onMove,
  onToggle,
  onRemove,
  onEdit,
  onSetActive,
  onSelfTest,
}: ConfiguredProvidersPanelProps) {
  return (
    <div className="mb-5 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1"><p className="text-xs font-medium text-slate-200">Configured providers</p><p className="text-[11px] leading-relaxed text-slate-500">Lower priority runs first; quota errors fall through enabled providers.</p></div>
        <button type="button" onClick={onRefresh} disabled={providerRefreshing} className="text-[11px] text-emerald-300 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50">{providerRefreshing ? 'Refreshing...' : 'Refresh'}</button>
      </div>
      {providers.length === 0 ? <p className="mb-3 text-[11px] text-slate-500">No runtime providers configured yet.</p> : <div className="mb-3 space-y-2">{providers.map((provider, index) => {
        const status = String(provider.status || 'unknown').toLowerCase();
        const statusClass = ['ready', 'configured', 'enabled'].includes(status)
          ? 'text-emerald-300'
          : ['unknown', 'checking'].includes(status)
            ? 'text-amber-300'
            : 'text-rose-300';
        const failureCategory = provider.failureDetails?.category || provider.failureCategory;
        const modelValidationError = getProviderModelValidationError(provider.adapterType, provider.model);
        const configurationError = provider.configurationError?.message
          || (provider.configurationValid === false ? 'Provider configuration is invalid. Edit it to review the endpoint and model.' : '');
        const modelError = modelValidationError || configurationError;
        const capabilityNames = [
          ['toolCalling', 'TOOL CALLS'],
          ['streaming', 'STREAMING'],
          ['vision', 'VISION'],
          ['structuredOutput', 'STRUCTURED OUTPUT'],
          ['stt', 'SPEECH'],
        ] as const;
        return <div key={provider.id} className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="w-5 shrink-0 text-[11px] text-slate-500">{provider.priority}</span>
            <span className="min-w-[10rem] flex-1 truncate text-xs text-slate-200">{provider.label} <span className="text-slate-500">· {provider.adapterType} · {provider.model}</span></span>
            <span className={`text-[10px] ${provider.enabled ? 'text-emerald-300' : 'text-slate-500'}`}>{provider.enabled ? 'ON' : 'OFF'}</span>
            <span className={`text-[10px] ${failureCategory ? 'text-rose-300' : statusClass}`}>{failureCategory || provider.status || 'unknown'}</span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {activeProviderId === provider.id
                ? <span className="text-[11px] text-emerald-300">Active</span>
                : <button type="button" onClick={() => onSetActive(provider)} disabled={!provider.enabled || Boolean(modelError)} className="text-[11px] text-emerald-300 disabled:opacity-40">Make active</button>}
              <button type="button" onClick={() => onEdit(provider)} className="text-[11px] text-sky-300">Edit</button>
              <button type="button" onClick={() => onSelfTest(provider)} disabled={selfTestingProviderId === provider.id} className="text-[11px] text-violet-300 disabled:opacity-40">{selfTestingProviderId === provider.id ? 'Testing...' : 'Self-test'}</button>
              <button onClick={() => onMove(provider, -1)} disabled={index === 0} className="text-[11px] text-slate-400 disabled:opacity-30" aria-label="Move provider up">↑</button>
              <button onClick={() => onMove(provider, 1)} disabled={index === providers.length - 1} className="text-[11px] text-slate-400 disabled:opacity-30" aria-label="Move provider down">↓</button>
              <button onClick={() => onToggle(provider)} className="text-[11px] text-amber-300">{provider.enabled ? 'Disable' : 'Enable'}</button>
              {modelValidationError && <button onClick={() => onEdit(provider)} className="text-[11px] text-emerald-300">Choose model</button>}
              <button onClick={() => onRemove(provider)} className="text-[11px] text-rose-300">Remove</button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
            <span className={`rounded border px-1.5 py-0.5 ${provider.assistantCapable ? 'border-emerald-500/40 text-emerald-300' : 'border-slate-700 text-slate-500'}`}>ASSISTANT CAPABLE</span>
            {capabilityNames.map(([capability, label]) => {
              const state = modelError
                ? 'UNKNOWN'
                : provider.capabilityStates?.[capability] || getCapabilityState(provider.adapterType, provider.model, capability);
              const stateClass = state === 'SUPPORTED'
                ? 'border-emerald-500/40 text-emerald-300'
                : state === 'UNSUPPORTED'
                  ? 'border-rose-500/40 text-rose-300'
                  : 'border-slate-700 text-slate-500';
              return <span key={capability} className={`rounded border px-1.5 py-0.5 ${stateClass}`}>{label}: {state}</span>;
            })}
          </div>
          {modelError && <p role="alert" className="mt-2 text-[11px] text-rose-300">{modelError}</p>}
          {provider.failureDetails?.reason && (
            <p className="mt-2 text-[11px] leading-relaxed text-rose-200">
              {provider.failureDetails.reason}
              {provider.failureDetails.statusCode ? ` (HTTP ${provider.failureDetails.statusCode})` : ''}
            </p>
          )}
          {provider.failureDetails?.rawMessage && (
            <details className="mt-2 text-[10px] text-slate-400">
              <summary className="cursor-pointer">Details</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-slate-950 p-2">{provider.failureDetails.rawMessage}</pre>
            </details>
          )}
          {provider.failureDetails?.requestCapture?.body && (
            <details className="mt-2 text-[10px] text-slate-400">
              <summary className="cursor-pointer">Captured self-test request (API key excluded)</summary>
              <p className="mt-1 break-all">{provider.failureDetails.requestCapture.method} {provider.failureDetails.requestCapture.url}</p>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-slate-950 p-2">{provider.failureDetails.requestCapture.body}</pre>
            </details>
          )}
        </div>;
      })}</div>}
      <div className="mb-4 rounded-md border border-slate-700 bg-slate-900 p-2.5">
        <label htmlFor="speech-provider-select" className="mb-1 block text-[11px] font-medium text-slate-300">Meeting speech provider</label>
        <select
          id="speech-provider-select"
          value={speechProviderId}
          onChange={(event) => onSpeechProviderChange(event.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-100"
        >
          <option value="">Automatic — prefer OpenAI/Groq, then Gemini</option>
          {providers.filter((provider) => provider.capabilities?.stt).map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!provider.enabled || !provider.hasApiKey}>
              {provider.label} · {provider.adapterType}{!provider.enabled ? ' (disabled)' : !provider.hasApiKey ? ' (API key unavailable)' : ''}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          Automatic mode prefers enabled, key-configured Groq/OpenAI speech providers by priority, then uses Gemini native audio transcription. Select a provider explicitly to override automatic choice.
        </p>
      </div>
    </div>
  );
}
