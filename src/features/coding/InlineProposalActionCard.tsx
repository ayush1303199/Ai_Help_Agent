import { useState } from 'react';
import type { DeveloperDiffFile } from './codingDiff';

interface InlineProposalActionCardProps {
  files: DeveloperDiffFile[];
  state?: string;
  busy: boolean;
  deleteConfirmationRequired: boolean;
  deleteConfirmed: boolean;
  brokerApproval?: boolean;
  onDeleteConfirmationChange: (confirmed: boolean) => void;
  onApprove: () => void;
  onApply: () => void;
  onReject: () => void;
  onUndo: () => void;
  trace?: { stage?: string; verificationStatus?: string } | null;
}

export function InlineProposalActionCard({
  files,
  state,
  busy,
  deleteConfirmationRequired,
  deleteConfirmed,
  brokerApproval = false,
  onDeleteConfirmationChange,
  onApprove,
  onApply,
  onReject,
  onUndo,
  trace,
}: InlineProposalActionCardProps) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const counts = files.reduce<Record<string, number>>((result, file) => {
    result[file.operation] = (result[file.operation] || 0) + 1;
    return result;
  }, {});

  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300">
            {files.length} file operation{files.length === 1 ? '' : 's'}
          </span>
          {Object.entries(counts).map(([operation, count]) => (
            <span key={operation} className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 text-slate-400">
              {operation.replace('_', ' ')} · {count}
            </span>
          ))}
        </div>
        <span role="status" className="text-slate-400">
          {trace?.stage?.replace(/_/g, ' ') || state || 'Proposal ready'}
          {trace?.verificationStatus ? ` · ${trace.verificationStatus}` : ''}
        </span>
      </div>
      {deleteConfirmationRequired && state === 'awaiting_approval' && (
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-[11px] text-rose-100">
          <input
            type="checkbox"
            checked={deleteConfirmed}
            onChange={(event) => onDeleteConfirmationChange(event.target.checked)}
            disabled={busy}
            className="mt-0.5 accent-rose-400"
          />
          <span>Confirm the listed deletion targets in this proposal before applying.</span>
        </label>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {files.map((file) => {
          const key = `${file.operation}:${file.sourcePath || ''}:${file.path}`;
          return (
            <button
              key={key}
              type="button"
              aria-expanded={expandedFile === key}
              onClick={() => setExpandedFile((current) => current === key ? null : key)}
              className="max-w-full truncate rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-left text-[10px] text-slate-300 hover:border-sky-500/50"
              title={`${file.operation}: ${file.path}`}
            >
              {file.operation.toUpperCase().replace('_', ' ')} · {file.path}
            </button>
          );
        })}
      </div>
      {files.map((file) => {
        const key = `${file.operation}:${file.sourcePath || ''}:${file.path}`;
        if (expandedFile !== key) return null;
        return (
          <div key={key} className="mt-2 overflow-hidden rounded-md border border-slate-700 bg-slate-950">
            <p className="border-b border-slate-700 px-2 py-1.5 text-xs font-medium text-slate-200">
              {file.sourcePath ? `${file.sourcePath} → ${file.path}` : file.path}
            </p>
            {file.operation === 'delete_directory'
              ? <p className="px-2 py-2 text-xs text-rose-200">The directory and its contents will be removed after confirmation above.</p>
              : <pre className="max-h-80 overflow-auto p-2 text-[11px] leading-relaxed">{file.lines.map((line, index) => (
                <span key={`${file.path}-${index}`} className={`block ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-emerald-500/10 text-emerald-200' : line.startsWith('-') && !line.startsWith('---') ? 'bg-rose-500/10 text-rose-200' : 'text-slate-400'}`}>{line || ' '}</span>
              ))}</pre>}
          </div>
        );
      })}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {state === 'awaiting_approval' && (
          <>
            <button onClick={onApprove} disabled={busy || (deleteConfirmationRequired && !deleteConfirmed)} className="rounded-md bg-amber-400 px-2.5 py-1.5 text-[11px] font-medium text-slate-950 disabled:opacity-40">
              {brokerApproval ? 'Accept & Verify' : 'Accept & Verify'}
            </button>
            <button onClick={onReject} disabled={busy} className="rounded-md border border-slate-600 px-2.5 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Reject</button>
          </>
        )}
        {state === 'approved' && <button onClick={onApply} disabled={busy} className="rounded-md bg-emerald-400 px-2.5 py-1.5 text-[11px] font-medium text-slate-950 disabled:opacity-40">Apply and verify</button>}
        {state === 'completed' && <button onClick={onUndo} disabled={busy} className="rounded-md border border-rose-400/60 px-2.5 py-1.5 text-[11px] text-rose-200 disabled:opacity-40">Undo</button>}
      </div>
    </section>
  );
}
