import { useEffect, useRef, useState } from 'react';

interface ContextInputDialogProps {
  open: boolean;
  title: string;
  description: string;
  label: string;
  initialValue: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

export function ContextInputDialog({
  open,
  title,
  description,
  label,
  initialValue,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
}: ContextInputDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const [validationError, setValidationError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setValue(initialValue);
    setValidationError('');
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [initialValue, open]);

  useEffect(() => {
    if (open) return;
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!submitting) onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') || [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, open, submitting]);

  if (!open) return null;

  const confirm = async () => {
    if (submitting) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setValidationError('Enter a name or choose Cancel.');
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-input-dialog-title"
        aria-describedby="context-input-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="context-input-dialog-title" className="text-lg font-semibold text-slate-100">{title}</h2>
            <p id="context-input-dialog-description" className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ×
          </button>
        </div>
        <label htmlFor="context-input-dialog-value" className="mt-4 block text-xs font-medium text-slate-300">{label}</label>
        <input
          ref={inputRef}
          id="context-input-dialog-value"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (validationError) setValidationError('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void confirm();
            }
          }}
          className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30"
          aria-invalid={Boolean(validationError)}
          aria-describedby={validationError ? 'context-input-dialog-error' : 'context-input-dialog-description'}
        />
        {validationError && <p id="context-input-dialog-error" className="mt-2 text-xs text-rose-300" role="alert">{validationError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={submitting} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => void confirm()} disabled={submitting} className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? `${confirmLabel}...` : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
