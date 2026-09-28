export type MeetingHistoryRetentionDays = 7 | 30 | 60 | 90 | 'off';
export const DEFAULT_MEETING_HISTORY_RETENTION_DAYS: MeetingHistoryRetentionDays = 30;
export const MEETING_HISTORY_RETENTION_STORAGE_KEY = 'meeting-history-retention-days';

export function readMeetingHistoryRetention(): MeetingHistoryRetentionDays {
  try {
    const value = localStorage.getItem(MEETING_HISTORY_RETENTION_STORAGE_KEY);
    if (value === '7' || value === '30' || value === '60' || value === '90') {
      return Number(value) as 7 | 30 | 60 | 90;
    }
    return value === 'off' ? 'off' : DEFAULT_MEETING_HISTORY_RETENTION_DAYS;
  } catch {
    return DEFAULT_MEETING_HISTORY_RETENTION_DAYS;
  }
}

export function writeMeetingHistoryRetention(days: MeetingHistoryRetentionDays) {
  try {
    localStorage.setItem(MEETING_HISTORY_RETENTION_STORAGE_KEY, String(days));
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
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    if (!entry.createdAt) return true;
    const createdAt = Date.parse(entry.createdAt);
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  });
}
