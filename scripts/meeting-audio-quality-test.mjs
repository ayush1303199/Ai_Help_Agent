import assert from 'node:assert/strict';
import {
  adaptiveAudioLevelThreshold,
  adaptiveSilenceTimeoutMs,
  buildTranscriptSummaryPrompt,
  limitMeetingTranscriptHistory,
  meetingAudioDiagnostic,
} from '../src/features/meeting/meetingTranscriptQuality.ts';
import { resolveMeetingMicrophoneInventory } from '../src/features/meeting/meetingAudioDeviceState.ts';
import { meetingSttUserError } from '../src/features/meeting/meetingSttError.ts';
import {
  DEFAULT_MEETING_HISTORY_RETENTION_DAYS,
  isMeetingHistoryRetentionDue,
  pruneMeetingRecords,
  readMeetingHistoryRetention,
  writeMeetingHistoryRetention,
} from '../src/history/meetingHistoryRetention.ts';

assert.equal(adaptiveSilenceTimeoutMs(1800, 0), 1800);
assert.equal(adaptiveSilenceTimeoutMs(1800, 7999), 1800);
assert.equal(adaptiveSilenceTimeoutMs(1800, 8000), 2000);
assert.equal(adaptiveSilenceTimeoutMs(1800, 24000), 2400);
assert.equal(adaptiveSilenceTimeoutMs(1800, 120000), 2600, 'long speech receives only a bounded extension');
assert.equal(adaptiveSilenceTimeoutMs(1800, -1000), 1800);
assert.equal(adaptiveAudioLevelThreshold(2, []), 2);
assert.equal(adaptiveAudioLevelThreshold(2, [0, 1, 2, 3]), 2);
assert.equal(adaptiveAudioLevelThreshold(2, [8, 8, 8]), 2, 'speech onset is not mistaken for a calibrated noise floor');
assert.equal(adaptiveAudioLevelThreshold(2, [4, 4, 5, 20]), 5.5, 'noise threshold follows the lower quartile with a speech-sensitive margin');
assert.equal(adaptiveAudioLevelThreshold(2, [100, 100, 100, 100]), 12, 'noisy environments cannot raise the threshold without bound');
const transcriptHistory = [
  { id: 'one', source: 'Mic', text: 'hello', createdAt: 'now' },
  { id: 'invalid', source: 'Mic', text: 'bad' },
  { id: 'two', source: 'System', text: 'world', createdAt: 'now' },
];
assert.deepEqual(limitMeetingTranscriptHistory(transcriptHistory, 1), [transcriptHistory[0]]);
assert.deepEqual(limitMeetingTranscriptHistory(null, 10), []);
assert.deepEqual(
  resolveMeetingMicrophoneInventory(1, []),
  { devices: [], unavailable: false, permissionRequired: true },
  'Enumerated audio inputs without exposed IDs are permission-gated, not missing hardware.',
);
assert.deepEqual(
  resolveMeetingMicrophoneInventory(0, []),
  { devices: [], unavailable: true, permissionRequired: false },
  'No enumerated audio input should be reported as unavailable.',
);
const selectableMicrophone = { deviceId: 'mic-1', label: 'USB Microphone' };
assert.deepEqual(
  resolveMeetingMicrophoneInventory(1, [selectableMicrophone]),
  { devices: [selectableMicrophone], unavailable: false, permissionRequired: false },
  'Selectable microphones should be exposed normally.',
);
const transcriptPrompt = buildTranscriptSummaryPrompt('Microphone', 'Discuss API tests and launch date.', 500);
assert.match(transcriptPrompt, /Discuss API tests and launch date\./, 'using a saved transcript must include its actual text');
assert.match(buildTranscriptSummaryPrompt('System Audio', 'abc'.repeat(100), 100), /Transcript truncated/);

const fixedNow = Date.parse('2026-09-28T00:00:00.000Z');
const meetingRecords = [
  { id: 'expired', createdAt: '2026-08-28T00:00:00.000Z' },
  { id: 'boundary', createdAt: '2026-08-29T00:00:00.000Z' },
  { id: 'sixty-day-boundary', createdAt: '2026-07-30T00:00:00.000Z' },
  { id: 'sixty-one-days-old', createdAt: '2026-07-29T00:00:00.000Z' },
  { id: 'fresh', createdAt: '2026-09-27T00:00:00.000Z' },
  { id: 'legacy' },
  { id: 'invalid-date', createdAt: 'not-a-date' },
];
assert.deepEqual(
  pruneMeetingRecords(meetingRecords, 30, fixedNow).map(({ id }) => id),
  ['boundary', 'fresh', 'legacy', 'invalid-date'],
  'The 30-day policy deletes older data, keeps the exact cutoff, and preserves records without reliable dates.',
);
assert.deepEqual(
  pruneMeetingRecords(meetingRecords, 60, fixedNow).map(({ id }) => id),
  ['expired', 'boundary', 'sixty-day-boundary', 'fresh', 'legacy', 'invalid-date'],
  'The 60-day policy deletes data older than its date cutoff while keeping the cutoff itself.',
);
assert.equal(pruneMeetingRecords(meetingRecords, 'off', fixedNow), meetingRecords, 'Off must retain all Meeting records.');
const beforeCustomPurge = new Date(2026, 8, 28, 23, 59).getTime();
const onCustomPurge = new Date(2026, 8, 29, 0, 0).getTime();
assert.deepEqual(
  pruneMeetingRecords(meetingRecords, 'date:2026-09-29', beforeCustomPurge),
  meetingRecords,
  'A custom purge date retains all Meeting data until that local calendar date.',
);
assert.deepEqual(
  pruneMeetingRecords(meetingRecords, 'date:2026-09-29', onCustomPurge),
  [],
  'A custom purge date deletes the complete Meeting history at local midnight on the chosen date.',
);
assert.equal(isMeetingHistoryRetentionDue('date:2026-09-29', beforeCustomPurge), false);
assert.equal(isMeetingHistoryRetentionDue('date:2026-09-29', onCustomPurge), true);
const chatSessions = [
  { id: 'old-meeting', title: 'Old', messages: [], updatedAt: '2026-08-01T00:00:00.000Z', mode: 'meeting' },
  { id: 'new-meeting', title: 'New', messages: [], updatedAt: '2026-09-27T00:00:00.000Z', mode: 'meeting' },
  { id: 'old-assistant', title: 'Assistant', messages: [], updatedAt: '2026-08-01T00:00:00.000Z', mode: 'assistant' },
  { id: 'old-developer', title: 'Developer', messages: [], updatedAt: '2026-08-01T00:00:00.000Z', mode: 'developer' },
];
const retainedMeetingIds = new Set(
  pruneMeetingRecords(
    chatSessions.filter(({ mode }) => mode === 'meeting').map(({ id, updatedAt }) => ({ id, createdAt: updatedAt })),
    30,
    fixedNow,
  ).map(({ id }) => id),
);
assert.deepEqual(
  chatSessions.filter(({ mode, id }) => mode !== 'meeting' || retainedMeetingIds.has(id)).map(({ id }) => id),
  ['new-meeting', 'old-assistant', 'old-developer'],
  'Retention applies only to Meeting-mode shared history.',
);
assert.equal(pruneMeetingRecords(meetingRecords, 'off', fixedNow).length, meetingRecords.length);

const savedLocalStorage = globalThis.localStorage;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
assert.equal(readMeetingHistoryRetention(), DEFAULT_MEETING_HISTORY_RETENTION_DAYS);
assert.equal(writeMeetingHistoryRetention(90), true);
assert.equal(readMeetingHistoryRetention(), 90, 'The selected retention duration should persist.');
assert.equal(writeMeetingHistoryRetention(60), true);
assert.equal(readMeetingHistoryRetention(), 60, 'The 60-day retention duration should persist.');
assert.equal(writeMeetingHistoryRetention('date:2026-09-29', beforeCustomPurge), true);
assert.equal(readMeetingHistoryRetention(), 'date:2026-09-29', 'The custom local deletion date should persist.');
assert.equal(writeMeetingHistoryRetention('date:2026-09-28', beforeCustomPurge), false, 'Past and same-day deletion dates must be rejected.');
globalThis.localStorage = { setItem: () => { throw new Error('storage full'); }, getItem: () => null };
assert.equal(writeMeetingHistoryRetention(7), false, 'Storage failures must be reported to the caller.');
globalThis.localStorage = savedLocalStorage;

assert.match(meetingSttUserError('STT_TIMEOUT', 'fallback'), /timed out/);
assert.match(meetingSttUserError('STT_AUTH_ERROR', 'fallback'), /provider key is missing or was rejected/);
assert.equal(meetingSttUserError('STT_UNKNOWN', 'specific fallback'), 'specific fallback');

assert.equal(meetingAudioDiagnostic({
  microphoneUnavailable: true,
  systemAudioMode: false,
  isRecording: false,
  signalDetected: false,
  elapsedMs: 0,
}), 'No microphone device is available. Connect a microphone or choose another audio source.');
assert.equal(meetingAudioDiagnostic({
  microphoneUnavailable: false,
  systemAudioMode: false,
  isRecording: true,
  signalDetected: false,
  elapsedMs: 3999,
}), '');
assert.match(meetingAudioDiagnostic({
  microphoneUnavailable: false,
  systemAudioMode: true,
  isRecording: true,
  signalDetected: false,
  elapsedMs: 4000,
}), /enable Share audio/);
assert.equal(meetingAudioDiagnostic({
  microphoneUnavailable: false,
  systemAudioMode: false,
  isRecording: true,
  signalDetected: true,
  elapsedMs: 5000,
}), 'Audio signal detected.');

console.log('Meeting audio quality tests passed.');
