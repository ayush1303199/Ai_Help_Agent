interface ConfiguredProvider {
  id: string;
  label: string;
  adapterType: string;
  model: string;
  enabled: boolean;
  priority: number;
  status?: string;
  assistantCapable?: boolean;
  developerToolCalling?: boolean;
  developerToolCallingVerified?: boolean;
  developerStatus?: string;
}

interface ConfiguredProvidersPanelProps {
  providers: ConfiguredProvider[];
  providerLabel: string;
  providerEnabled: boolean;
  providerSaving: boolean;
  onRefresh: () => void;
  onMove: (provider: ConfiguredProvider, direction: -1 | 1) => void;
  onToggle: (provider: ConfiguredProvider) => void;
  onRemove: (provider: ConfiguredProvider) => void;
  onProviderLabelChange: (value: string) => void;
  onProviderEnabledChange: (value: boolean) => void;
  onAdd: () => void;
}

export function ConfiguredProvidersPanel({
  providers,
  providerLabel,
  providerEnabled,
  providerSaving,
  onRefresh,
  onMove,
  onToggle,
  onRemove,
  onProviderLabelChange,
  onProviderEnabledChange,
  onAdd,
}: ConfiguredProvidersPanelProps) {
  return (
    <div className="mb-5 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div><p className="text-xs font-medium text-slate-200">Configured providers</p><p className="text-[11px] text-slate-500">Lower priority runs first; quota errors fall through enabled providers.</p></div>
        <button onClick={onRefresh} className="text-[11px] text-emerald-300 hover:text-emerald-200">Refresh</button>
      </div>
      {providers.length === 0 ? <p className="mb-3 text-[11px] text-slate-500">No runtime providers configured yet.</p> : <div className="mb-3 space-y-2">{providers.map((provider, index) => <div key={provider.id} className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2"><div className="flex items-center gap-2"><span className="w-5 text-[11px] text-slate-500">{provider.priority}</span><span className="min-w-0 flex-1 truncate text-xs text-slate-200">{provider.label} <span className="text-slate-500">· {provider.adapterType} · {provider.model}</span></span><span className={`text-[10px] ${provider.enabled ? 'text-emerald-300' : 'text-slate-500'}`}>{provider.enabled ? 'ON' : 'OFF'}</span><span className="text-[10px] text-slate-500">{provider.status || 'unknown'}</span><button onClick={() => onMove(provider, -1)} disabled={index === 0} className="text-[11px] text-slate-400 disabled:opacity-30" aria-label="Move provider up">↑</button><button onClick={() => onMove(provider, 1)} disabled={index === providers.length - 1} className="text-[11px] text-slate-400 disabled:opacity-30" aria-label="Move provider down">↓</button><button onClick={() => onToggle(provider)} className="text-[11px] text-amber-300">{provider.enabled ? 'Disable' : 'Enable'}</button><button onClick={() => onRemove(provider)} className="text-[11px] text-rose-300">Remove</button></div><div className="mt-2 flex flex-wrap gap-1.5 text-[10px]"><span className={`rounded border px-1.5 py-0.5 ${provider.assistantCapable ? 'border-emerald-500/40 text-emerald-300' : 'border-slate-700 text-slate-500'}`}>ASSISTANT CAPABLE</span><span className={`rounded border px-1.5 py-0.5 ${provider.developerToolCallingVerified ? 'border-sky-500/40 text-sky-300' : provider.developerToolCalling ? 'border-amber-500/40 text-amber-300' : 'border-slate-700 text-slate-500'}`}>{provider.developerToolCallingVerified ? 'DEVELOPER TOOL-CALL CAPABLE' : provider.developerToolCalling ? `DEVELOPER VERIFICATION ${provider.developerStatus || 'REQUIRED'}` : 'DEVELOPER TOOL CALLS UNSUPPORTED'}</span></div></div>)}</div>}
      <label className="mb-2 block text-[11px] font-medium text-slate-300">Add provider instance</label>
      <input value={providerLabel} onChange={(event) => onProviderLabelChange(event.target.value)} placeholder="Label (for example: Backup Groq)" className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 outline-none focus:border-emerald-400" />
      <label className="mb-2 flex cursor-pointer items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" checked={providerEnabled} onChange={(event) => onProviderEnabledChange(event.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" /> Enabled for requests</label>
      <button onClick={onAdd} disabled={providerSaving} className="w-full rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">Add configured provider</button>
    </div>
  );
}
