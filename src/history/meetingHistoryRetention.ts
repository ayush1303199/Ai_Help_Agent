import { writeAppState } from '../config/appStateStorage';

export type MeetingHistoryRetentionDays = 7 | 30 | 60 | 90 | 'off' | `date:${string}`;
export const DEFAULT_MEETING_HISTORY_RETENTION_DAYS: MeetingHistoryRetentionDays = 30;
export const MEETING_HISTORY_RETENTION_STORAGE_KEY = 'meeting-history-retention-days';

function isFutureLocalDate(value: string, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const selected = new Date(year, month - 1, day);
  if (selected.getFullYear() !== year || selected.getMonth() !== month - 1 || selected.getDate() !== day) return false;
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  return selected.getTime() > today.getTime();
}

function isValidLocalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const selected = new Date(year, month - 1, day);
  return selected.getFullYear() === year && selected.getMonth() === month - 1 && selected.getDate() === day;
}

export function isMeetingHistoryRetentionDue(retention: MeetingHistoryRetentionDays, now = Date.now()) {
  if (typeof retention !== 'string' || !retention.startsWith('date:')) return false;
  const selectedDate = retention.slice(5);
  if (!isValidLocalDate(selectedDate)) return false;
  const current = new Date(now);
  const today = [
    current.getFullYear().toString().padStart(4, '0'),
    (current.getMonth() + 1).toString().padStart(2, '0'),
    current.getDate().toString().padStart(2, '0'),
  ].join('-');
  return today >= selectedDate;
}

export function readMeetingHistoryRetention(): MeetingHistoryRetentionDays {
  try {
    const value = localStorage.getItem(MEETING_HISTORY_RETENTION_STORAGE_KEY);
    if (value === '7' || value === '30' || value === '60' || value === '90') {
      return Number(value) as 7 | 30 | 60 | 90;
    }
    if (value?.startsWith('date:') && isValidLocalDate(value.slice(5))) return value as `date:${string}`;
    return value === 'off' ? 'off' : DEFAULT_MEETING_HISTORY_RETENTION_DAYS;
  } catch {
    return DEFAULT_MEETING_HISTORY_RETENTION_DAYS;
  }
}

export function writeMeetingHistoryRetention(days: MeetingHistoryRetentionDays, now = Date.now()) {
  if (typeof days === 'string' && days.startsWith('date:') && !isFutureLocalDate(days.slice(5), now)) return false;
  try {
    writeAppState(MEETING_HISTORY_RETENTION_STORAGE_KEY, String(days));
    return true;
  } catch {
    return false;
  }
}

export function pruneMeetingRecords<T extends { createdAt?: string }>(
  entries: T[],
  retentionDays: MeetingHistoryRetentionDays,
  now = Date.now(),
) {
  if (retentionDays === 'off') return entries;
  if (typeof retentionDays === 'string' && retentionDays.startsWith('date:')) {
    return isMeetingHistoryRetentionDue(retentionDays, now) ? [] : entries;
  }
  if (typeof retentionDays !== 'number') return entries;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    if (!entry.createdAt) return true;
    const createdAt = Date.parse(entry.createdAt);
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  });
}
