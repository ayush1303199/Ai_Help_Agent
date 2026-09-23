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

interface FontSizeControlsProps {
  value: number;
  onChange: (value: number) => void;
}

export function FontSizeControls({ value, onChange }: FontSizeControlsProps) {
  return (
    <div className="font-size-controls" aria-label="Font size">
      <button
        type="button"
        className="ui-button ui-font-size-button border border-slate-700 text-slate-300 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => onChange(Math.max(0.9, Number((value - 0.1).toFixed(1))))}
        disabled={value <= 0.9}
        aria-label="Decrease font size"
        title="Decrease font size"
      >
        A−
      </button>
      <button
        type="button"
        className="font-size-value"
        onClick={() => onChange(1)}
        aria-label="Reset font size to 100 percent"
        title="Reset font size to 100%"
      >
        {Math.round(value * 100)}%
      </button>
      <button
        type="button"
        className="ui-button ui-font-size-button border border-slate-700 text-slate-300 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => onChange(Math.min(1.2, Number((value + 0.1).toFixed(1))))}
        disabled={value >= 1.2}
        aria-label="Increase font size"
        title="Increase font size"
      >
        A+
      </button>
    </div>
  );
}

export function OverlayButton({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`ui-button ${visible ? '' : 'hidden'} border border-slate-700 text-slate-300 hover:border-emerald-400`} title="Open transparent answer overlay">
      Overlay
    </button>
  );
}

export function ScreenReadingToggle({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={enabled} title="Enable or disable screen reading (Ctrl + Shift + R)" className={`ui-button border ${enabled ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 text-slate-400'} hover:border-cyan-400`}>
      Screen {enabled ? 'ON' : 'OFF'}
    </button>
  );
}

interface ContextButtonProps {
  open: boolean;
  onClick: () => void;
}

export function ContextButton({ open, onClick }: ContextButtonProps) {
  return (
    <button type="button" data-context-toggle onClick={onClick} aria-expanded={open} aria-haspopup="dialog" className={`ui-button border text-slate-300 hover:border-emerald-400 ${open ? 'border-emerald-400 bg-emerald-500/10' : 'border-slate-700'}`}>
      Context
    </button>
  );
}

function IconButton({ label, onClick, children }: IconButtonProps & { children: ReactNode }) {
  return <button type="button" onClick={onClick} aria-label={label} className="ui-button ui-icon-button border border-slate-700 text-slate-300 hover:border-emerald-400" title={label}>{children}</button>;
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
