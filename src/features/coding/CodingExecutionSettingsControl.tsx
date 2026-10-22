import type { CodingExecutionSettings } from './codingExecutionSettings';

interface CodingExecutionSettingsControlProps {
  settings: CodingExecutionSettings;
  brokerStatus: 'unknown' | 'syncing' | 'ready' | 'unavailable' | 'unauthorized' | 'untrusted';
  disabled?: boolean;
  onChange: (settings: Partial<CodingExecutionSettings>) => void;
  onSynchronize: () => void;
}

export function CodingExecutionSettingsControl({
  settings,
  brokerStatus,
  disabled = false,
  onChange,
  onSynchronize,
}: CodingExecutionSettingsControlProps) {
  const statusLabel = {
    unknown: 'Not checked',
    syncing: 'Synchronizing…',
    ready: 'Ready',
    unavailable: 'Unavailable',
    unauthorized: 'Authorization required',
    untrusted: 'Workspace not authorized',
  }[brokerStatus];
  const statusClass = brokerStatus === 'ready'
    ? 'text-emerald-300'
    : brokerStatus === 'unavailable' || brokerStatus === 'unauthorized' || brokerStatus === 'untrusted'
      ? 'text-rose-300'
      : 'text-slate-400';

  return (
    <section aria-label="Coding Agent execution settings" className="mt-4 border-t border-slate-700 pt-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Execution &amp; workspace trust</p>
      <label className="mt-3 block text-xs text-slate-300">
        <span className="mb-1 block">Execution and approval mode</span>
        <select
          aria-label="Execution and approval mode"
          value={settings.executionMode}
          onChange={(event) => onChange({
            executionMode: event.target.value === 'autonomous_auto_apply'
              ? 'autonomous_auto_apply'
              : 'inline_review',
          })}
          disabled={disabled}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400 disabled:opacity-50"
        >
          <option value="inline_review">Inline Proposal Review</option>
          <option value="autonomous_auto_apply">Autonomous Auto-Apply &amp; Verify</option>
        </select>
      </label>
      <label className="mt-3 flex items-start gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={settings.autoAuthorizeAttachedProject}
          onChange={(event) => onChange({ autoAuthorizeAttachedProject: event.target.checked })}
          disabled={disabled}
          className="mt-0.5"
        />
        <span>
          Auto-authorize the explicitly attached workspace
          <span className="mt-0.5 block text-[10px] text-slate-500">
            Syncs the selected project with the local broker before workflow execution.
          </span>
        </span>
      </label>
      <div className="mt-3 flex items-center justify-between gap-2 text-[11px]">
        <span>Broker status: <span role="status" className={statusClass}>{statusLabel}</span></span>
        <button
          type="button"
          onClick={onSynchronize}
          disabled={disabled || brokerStatus === 'syncing'}
          className="rounded border border-slate-600 px-2 py-1 text-slate-300 hover:border-sky-400 disabled:opacity-50"
        >
          Re-sync workspace
        </button>
      </div>
    </section>
  );
}
