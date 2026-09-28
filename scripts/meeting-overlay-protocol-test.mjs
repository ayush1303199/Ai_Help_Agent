import assert from 'node:assert/strict';
import {
  isCaptureCommandConfirmed,
  isMissingMeetingOverlayHandler,
  meetingOverlayStage,
  shouldAcceptOverlayAgentState,
} from '../src/features/meeting/meetingOverlayProtocol.ts';

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
