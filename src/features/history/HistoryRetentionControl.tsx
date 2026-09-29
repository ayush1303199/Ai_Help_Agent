import { useState } from 'react';
import type { MeetingHistoryRetentionDays } from '../../history/historyService';

export function HistoryRetentionControl({
  value,
  onChange,
  label = 'Auto-delete saved history',
  ariaLabel = 'History retention',
  detail = 'Applies to all locally saved conversations, Meeting transcripts, and answers.',
}: {
  value: MeetingHistoryRetentionDays;
  onChange: (retention: MeetingHistoryRetentionDays) => void;
  label?: string;
  ariaLabel?: string;
  detail?: string;
}) {
  const [retentionError, setRetentionError] = useState('');
  const storedCustomDate = typeof value === 'string' && value.startsWith('date:')
    ? value.slice(5)
    : '';
  const [choosingCustomDate, setChoosingCustomDate] = useState(Boolean(storedCustomDate));
  const [customDate, setCustomDate] = useState(storedCustomDate);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const minimumDate = [
    tomorrow.getFullYear().toString().padStart(4, '0'),
    (tomorrow.getMonth() + 1).toString().padStart(2, '0'),
    tomorrow.getDate().toString().padStart(2, '0'),
  ].join('-');
  const selectedValue = choosingCustomDate ? 'custom' : value;

  return (
    <div className="space-y-2 text-xs text-slate-300">
      <label className="block">
        {label}
        <select
          aria-label={ariaLabel}
          value={selectedValue}
          onChange={(event) => {
            const selection = event.target.value;
            if (selection === 'custom') {
              setChoosingCustomDate(true);
              setCustomDate(storedCustomDate);
              setRetentionError('');
              return;
            }
            if (selection === '7' || selection === '30' || selection === '60' || selection === '90' || selection === 'off') {
              try {
                onChange(selection === 'off' ? 'off' : Number(selection) as 7 | 30 | 60 | 90);
                setChoosingCustomDate(false);
                setRetentionError('');
              } catch (error) {
                setRetentionError(error instanceof Error ? error.message : 'Could not save retention preference.');
              }
            }
          }}
          className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200"
        >
          <option value="7">Delete after 7 days</option>
          <option value="30">Delete after 30 days (recommended)</option>
          <option value="60">Delete after 60 days</option>
          <option value="90">Delete after 90 days</option>
          <option value="custom">Delete all saved history on a date...</option>
          <option value="off">Off (manual deletion only)</option>
        </select>
      </label>
      {choosingCustomDate && (
        <label className="block">
          Delete all saved history on
          <input
            aria-label="Delete all saved history on date"
            type="date"
            min={minimumDate}
            value={customDate}
            onChange={(event) => {
              const nextDate = event.target.value;
              setCustomDate(nextDate);
              if (!nextDate) return;
              if (nextDate < minimumDate) {
                setRetentionError('Choose a future date to schedule deletion of all saved history.');
                return;
              }
              try {
                onChange(`date:${nextDate}`);
                setRetentionError('');
              } catch (error) {
                setRetentionError(error instanceof Error ? error.message : 'Could not save the scheduled deletion date.');
              }
            }}
            className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200"
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            {storedCustomDate
              ? `All saved history will be deleted on ${storedCustomDate}.`
              : 'Choose a future date to schedule deletion of all saved history.'}
          </span>
        </label>
      )}
      {!choosingCustomDate && storedCustomDate && (
        <p className="text-[11px] text-amber-200">All saved history is scheduled for deletion on {storedCustomDate}.</p>
      )}
      <p className="text-[11px] text-slate-400">{detail}</p>
      {retentionError && <span role="alert" className="mt-2 block text-xs text-rose-300">{retentionError}</span>}
    </div>
  );
}
