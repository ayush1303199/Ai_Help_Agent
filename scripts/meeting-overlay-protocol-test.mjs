import assert from 'node:assert/strict';
import {
  isCaptureCommandConfirmed,
  isMissingMeetingOverlayHandler,
  meetingOverlayAnswer,
  meetingOverlayQuestion,
  meetingOverlayStage,
  resolveOverlayTabPreference,
  shouldFocusMeetingAnswer,
  shouldAcceptOverlayAgentState,
} from '../src/features/meeting/meetingOverlayProtocol.ts';

assert.equal(
  meetingOverlayQuestion('transcribing', 'Previous question?', 'Current spoken words'),
  'Current spoken words',
  'The overlay should show the current transcript instead of an older answered question while listening.',
);
assert.equal(
  meetingOverlayQuestion('thinking', 'Current question?', 'Current question?'),
  'Current question?',
  'The active question should remain visible while its answer is generated.',
);
assert.equal(meetingOverlayAnswer('thinking', 'Previous answer'), '', 'The previous answer must not appear as the answer to a new question.');
assert.equal(meetingOverlayAnswer('answer', 'Current answer'), 'Current answer');
assert.equal(meetingOverlayQuestion('ready', '  ', 'Recognized question'), 'Recognized question');
assert.equal(shouldFocusMeetingAnswer(
  { agent: 'meeting', status: 'thinking', answer: '' },
  { agent: 'meeting', status: 'answer', answer: 'Current answer' },
), true);
assert.equal(shouldFocusMeetingAnswer(
  { agent: 'meeting', status: 'thinking', answer: '' },
  { agent: 'meeting', status: 'listening', answer: 'Current answer' },
), true, 'A newly completed answer must focus the Answer tab even when capture immediately returns to listening.');
assert.equal(shouldFocusMeetingAnswer(
  { agent: 'meeting', status: 'answer', answer: 'Current answer' },
  { agent: 'meeting', status: 'listening', answer: 'Current answer' },
), false, 'Repeated Meeting state updates must not take the user away from Search.');
assert.equal(shouldFocusMeetingAnswer(
  { agent: 'meeting', status: 'thinking', answer: '' },
  { agent: 'meeting', status: 'thinking', answer: 'Previous answer' },
), false);
assert.equal(resolveOverlayTabPreference('history', 'answer', true), 'history',
  'A late native preference response must not replace the tab the user just selected.');
assert.equal(resolveOverlayTabPreference('history', 'answer', false), 'answer',
  'Persisted tab preferences should still initialize the overlay before user interaction.');
assert.equal(resolveOverlayTabPreference('history', 'unknown', false), 'history',
  'Invalid native tab values must not replace the current tab.');
assert.equal(shouldFocusMeetingAnswer(
  { agent: 'meeting', status: 'ready', answer: '' },
  { agent: 'meeting', status: 'answer', answer: '  ' },
), false);
assert.equal(shouldFocusMeetingAnswer(
  { agent: 'assistant', status: 'answer', answer: '' },
  { agent: 'assistant', status: 'answer', answer: 'Assistant answer' },
), false);

assert.equal(meetingOverlayStage('listening'), 'listening');
assert.equal(meetingOverlayStage('transcribing'), 'transcribing');
assert.equal(meetingOverlayStage('thinking'), 'answering');
assert.equal(meetingOverlayStage('answer'), 'complete');
assert.equal(meetingOverlayStage('error'), 'error');
assert.equal(meetingOverlayStage('ready'), 'ready');
assert.equal(isMissingMeetingOverlayHandler(new Error("Error invoking remote method: No handler registered for 'meeting-overlay:command'")), true);
assert.equal(isMissingMeetingOverlayHandler(new Error('Permission denied')), false);
assert.equal(isMissingMeetingOverlayHandler('missing'), false);

assert.equal(shouldAcceptOverlayAgentState(
  { agent: 'meeting', meetingActive: true, version: 8, updatedAt: 100 },
  { agent: 'meeting', meetingActive: true, version: 7, updatedAt: 200 },
), false, 'older Meeting state must not replace newer state');
assert.equal(shouldAcceptOverlayAgentState(
  { agent: 'assistant' },
  { agent: 'meeting', meetingActive: false },
), false, 'inactive Meeting state must not replace Assistant overlay content');
assert.equal(shouldAcceptOverlayAgentState(
  { agent: 'meeting', meetingActive: false },
  { agent: 'assistant' },
), true, 'mode switch back to Assistant must be accepted');
assert.equal(shouldAcceptOverlayAgentState(
  { agent: 'meeting', meetingActive: true, version: 5, updatedAt: 100 },
  { agent: 'meeting', meetingActive: true, version: 5, updatedAt: 99 },
), false, 'same-version older timestamp must be rejected');

const pendingStart = { commandId: 'start-1', targetActive: true };
assert.equal(isCaptureCommandConfirmed(pendingStart, {
  commandId: 'start-1',
  ok: true,
  captureActive: true,
}), true);
assert.equal(isCaptureCommandConfirmed(pendingStart, {
  commandId: 'start-1',
  ok: true,
  captureActive: false,
}), false, 'a successful command acknowledgment alone is not a confirmed state');
assert.equal(isCaptureCommandConfirmed(pendingStart, {
  commandId: 'other-command',
  ok: true,
  captureActive: true,
}), false, 'unrelated command acknowledgments must be ignored');
assert.equal(isCaptureCommandConfirmed(pendingStart, {
  commandId: 'start-1',
  ok: false,
  captureActive: true,
}), false);
const pendingStop = { commandId: 'stop-1', targetActive: false };
assert.equal(isCaptureCommandConfirmed(pendingStop, {
  commandId: 'stop-1',
  ok: true,
  captureActive: false,
}), true, 'stop only confirms after the controller reports capture inactive');
assert.equal(isCaptureCommandConfirmed(pendingStop, {
  commandId: 'stop-1',
  ok: true,
  captureActive: true,
}), false, 'a stop acknowledgment cannot confirm that capture actually stopped');

console.log('Meeting overlay protocol tests passed.');
