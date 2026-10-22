import { useState } from 'react';
import type { CodingActivity } from './codingTransport';
import { useWorkspaceTerminal } from './useWorkspaceTerminal';

interface WorkspaceTerminalPanelProps {
  activity: CodingActivity[];
  projectRoot: string | null;
  projectStatus?: string;
  brokerStatus: string;
  onSynchronizeBroker: () => void | Promise<void>;
}

export function WorkspaceTerminalPanel(props: WorkspaceTerminalPanelProps) {
  const terminal = useWorkspaceTerminal(props);
  const [copyError, setCopyError] = useState('');
  return (
    <section aria-label="Integrated workspace terminal" className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-slate-200">Integrated workflow console</h3>
          <p className="text-[10px] text-slate-500">Structured workflow evidence and safe, read-only workspace commands; no arbitrary shell execution.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void terminal.copy()
              .then(() => setCopyError(''))
              .catch(() => setCopyError('Clipboard access was denied.'));
          }}
          className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300"
        >
          Copy
        </button>
      </div>
      {copyError && <p role="alert" className="mb-2 text-[10px] text-rose-300">{copyError}</p>}
      <form
        className="mb-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void terminal.runCommand();
        }}
      >
        <input
          aria-label="Safe workspace terminal command"
          value={terminal.command}
          onChange={(event) => terminal.setCommand(event.target.value)}
          placeholder="tree · cat <file> · status · verify-routes · resync-broker · clear"
          className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-[10px] text-slate-200 outline-none focus:border-sky-400"
        />
        <button type="submit" disabled={terminal.busy} className="rounded border border-sky-500/50 px-3 py-1.5 text-[10px] text-sky-200 disabled:opacity-50">Run</button>
      </form>
      <div aria-live="polite" className="max-h-56 space-y-1 overflow-auto rounded border border-slate-800 bg-black/30 p-2 font-mono">
        {terminal.entries.length === 0
          ? <p className="text-[10px] text-slate-500">Workflow and verification events will appear here.</p>
          : terminal.entries.map((entry) => (
            <div key={entry.id} className="break-words text-[10px]">
              <time className="text-slate-600">{new Date(entry.timestamp).toLocaleTimeString()}</time>
              <span className="ml-2 text-sky-300">{entry.label}</span>
              <span className="ml-2 whitespace-pre-wrap text-slate-300">{entry.detail}</span>
            </div>
          ))}
      </div>
    </section>
  );
}
