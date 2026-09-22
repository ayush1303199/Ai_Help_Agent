import { forwardRef, type ReactNode } from 'react';
import { History, Settings, X } from 'lucide-react';

interface IconButtonProps {
  label: string;
  onClick: () => void;
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return <IconButton label="Configuration" onClick={onClick}><Settings className="h-4 w-4" /></IconButton>;
}

export function HistoryButton({ onClick }: { onClick: () => void }) {
  return <IconButton label="History" onClick={onClick}><History className="h-4 w-4" /></IconButton>;
}

export function OverlayButton({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`${visible ? '' : 'hidden'} rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-400`} title="Open transparent answer overlay">
      Overlay
    </button>
  );
}

interface ContextButtonProps {
  open: boolean;
  onClick: () => void;
}

export function ContextButton({ open, onClick }: ContextButtonProps) {
  return (
    <button type="button" data-context-toggle onClick={onClick} aria-expanded={open} aria-haspopup="dialog" className={`rounded-lg border px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-400 ${open ? 'border-emerald-400 bg-emerald-500/10' : 'border-slate-700'}`}>
      Context
    </button>
  );
}

function IconButton({ label, onClick, children }: IconButtonProps & { children: ReactNode }) {
  return <button type="button" onClick={onClick} aria-label={label} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-emerald-400" title={label}>{children}</button>;
}

export const ContextPanel = forwardRef<HTMLDivElement, { children: ReactNode; onClose: () => void }>(function ContextPanel({ children, onClose }, ref) {
  return (
    <div ref={ref} className="absolute right-0 top-11 z-20 max-h-[calc(100vh-5rem)] w-[min(23rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl" role="dialog" aria-modal="false" aria-label="Session context">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div><p className="text-sm font-semibold">Session context</p><p className="text-xs text-slate-500">Resume and job description context</p></div>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200" aria-label="Close session context"><X className="h-4 w-4" /></button>
      </div>
      {children}
    </div>
  );
});
