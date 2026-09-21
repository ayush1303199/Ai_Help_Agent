import { useEffect, useRef, useState } from 'react';

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
  dismissOnEscape?: boolean;
  dismissOnBackdrop?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  dismissOnEscape = false,
  dismissOnBackdrop = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isBusy = busy || submitting;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      const confirmButton = dialogRef.current?.querySelector<HTMLButtonElement>('button[data-confirm]');
      confirmButton?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

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
        if (dismissOnEscape && !isBusy) onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])') || [],
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
  }, [dismissOnEscape, isBusy, onCancel, open]);

  if (!open) return null;

  const confirm = async () => {
    if (isBusy) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissOnBackdrop && !isBusy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby="confirmation-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="confirmation-dialog-title" className="text-lg font-semibold text-slate-100">{title}</h2>
            <p id="confirmation-dialog-description" className="mt-2 text-sm leading-relaxed text-slate-400">{description}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            aria-label="Close confirmation"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ×
          </button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-confirm
            onClick={() => void confirm()}
            disabled={isBusy}
            className={`rounded-lg px-3 py-2 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-50 ${variant === 'danger' ? 'bg-rose-500 hover:bg-rose-400' : 'bg-emerald-500 hover:bg-emerald-400'}`}
          >
            {isBusy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
