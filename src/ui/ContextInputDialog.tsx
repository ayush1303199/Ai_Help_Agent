import { useEffect, useRef, useState } from 'react';

interface ContextInputDialogProps {
  open: boolean;
  title: string;
  description: string;
  label: string;
  initialValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function ContextInputDialog({
  open,
  title,
  description,
  label,
  initialValue,
  onConfirm,
  onCancel,
}: ContextInputDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setValidationError('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [initialValue, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, open]);

  if (!open) return null;

  const confirm = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setValidationError('Enter a name or choose Cancel.');
      inputRef.current?.focus();
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-input-dialog-title"
        aria-describedby="context-input-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="context-input-dialog-title" className="text-lg font-semibold text-slate-100">{title}</h2>
        <p id="context-input-dialog-description" className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
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
              confirm();
            }
          }}
          className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30"
          aria-invalid={Boolean(validationError)}
          aria-describedby={validationError ? 'context-input-dialog-error' : 'context-input-dialog-description'}
        />
        {validationError && <p id="context-input-dialog-error" className="mt-2 text-xs text-rose-300" role="alert">{validationError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100">Cancel</button>
          <button type="button" onClick={confirm} className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400">Confirm</button>
        </div>
      </div>
    </div>
  );
}
