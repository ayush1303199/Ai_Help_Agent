import assert from 'node:assert/strict';
import {
  attachMeetingTrackEndHandlers,
  classifySttClientError,
  meetingCaptureStartDecision,
  shouldApplyMeetingSttResult,
  shouldHandleMeetingTrackEnd,
} from '../src/features/meeting/meetingCaptureLifecycle.ts';
import { createMeetingSttSegmentProcessor } from '../src/features/meeting/meetingSttSegmentProcessor.ts';
import { transcribeMeetingSegmentWithRetry } from '../src/features/meeting/meetingSttRetry.ts';

assert.equal(classifySttClientError(new DOMException('Permission denied', 'NotAllowedError')), 'AUDIO_PERMISSION');
assert.equal(classifySttClientError(new Error('codec is unsupported')), 'STT_UNSUPPORTED_AUDIO');
assert.equal(classifySttClientError(new Error('network request failed')), 'STT_NETWORK_ERROR');

assert.equal(shouldHandleMeetingTrackEnd(true, 'capture-1', 'capture-1'), true);
assert.equal(shouldHandleMeetingTrackEnd(false, 'capture-1', 'capture-1'), false);
assert.equal(shouldHandleMeetingTrackEnd(true, 'capture-2', 'capture-1'), false);
assert.equal(shouldHandleMeetingTrackEnd(true, '', 'capture-1'), false);

assert.equal(meetingCaptureStartDecision(true, false, 'capture-1'), 'already-active');
assert.equal(meetingCaptureStartDecision(false, true, ''), 'blocked');
assert.equal(meetingCaptureStartDecision(false, false, 'capture-1'), 'blocked');
assert.equal(meetingCaptureStartDecision(false, false, ''), 'start');

assert.equal(shouldApplyMeetingSttResult('capture-1', 'capture-1', false), true);
assert.equal(shouldApplyMeetingSttResult('capture-2', 'capture-1', false), false);
assert.equal(shouldApplyMeetingSttResult('capture-1', 'capture-1', true), false);
assert.equal(shouldApplyMeetingSttResult('', 'capture-1', false), false);

const tracks = [new EventTarget(), new EventTarget()];
let captureActive = true;
let activeSessionId = 'capture-1';
let stopCount = 0;
let disconnectError = '';
const detachTrackHandler = attachMeetingTrackEndHandlers(
  tracks,
  () => shouldHandleMeetingTrackEnd(captureActive, activeSessionId, 'capture-1'),
  () => {
    stopCount += 1;
    captureActive = false;
    disconnectError = 'Audio input disconnected while listening.';
  },
);
tracks[0].dispatchEvent(new Event('ended'));
assert.equal(stopCount, 1);
assert.match(disconnectError, /disconnected/);
tracks[1].dispatchEvent(new Event('ended'));
assert.equal(stopCount, 1, 'A disconnect across multiple source tracks must stop capture only once.');
detachTrackHandler();
captureActive = true;
tracks[0].dispatchEvent(new Event('ended'));
assert.equal(stopCount, 1, 'Detached audio tracks must not stop a later capture.');

function createProcessorHarness(transcribeAudio) {
  const activeSttAbortRef = { current: null };
  const captureSessionIdRef = { current: 'capture-1' };
  const pendingPartialQuestionRef = { current: '' };
  const pendingPartialRawTextRef = { current: '' };
  const pendingPartialTimeoutRef = { current: null };
  const state = {
    transcribing: false,
    transcripts: [],
    sentQuestions: [],
    errors: [],
    statuses: [],
  };
  const setState = (key) => (value) => {
    state[key] = typeof value === 'function' ? value(state[key]) : value;
  };
  const processor = createMeetingSttSegmentProcessor({
    transcriptionLanguage: 'auto',
    meetingAudioMode: 'microphone',
    meetingSource: 'Microphone',
    background: [],
    domain: null,
    captureSessionIdRef,
    pendingPartialQuestionRef,
    pendingPartialRawTextRef,
    pendingPartialTimeoutRef,
    activeSttAbortRef,
    setLastStageTimings: setState('timings'),
    setIsTranscribing: setState('transcribing'),
    setPipelineStatus: setState('pipelineStatus'),
    setLiveTranscript: setState('liveTranscript'),
    setDisplayedQuestion: setState('displayedQuestion'),
    setDisplayedAnswer: setState('displayedAnswer'),
    setAnswerPending: setState('answerPending'),
    addTranscript: (transcript) => state.transcripts.push(transcript),
    onStatus: (status) => state.statuses.push(status),
    onError: (error) => state.errors.push(error),
    sendQuestion: async (question) => state.sentQuestions.push(question),
    transcribeAudio,
  });
  return { processor, state, activeSttAbortRef, captureSessionIdRef };
}

const successfulProcessor = createProcessorHarness(async () => ({ text: 'What is JavaScript?', status: 200 }));
await successfulProcessor.processor(new Blob(['audio']), 1200, true, 'capture-1', 'audio/webm');
assert.equal(successfulProcessor.state.transcripts.length, 1, 'Successful transcription should be saved.');
assert.equal(successfulProcessor.state.sentQuestions[0], 'What is JavaScript?', 'A complete spoken question should reach the answer pipeline.');

let resolveTranscription;
const staleProcessor = createProcessorHarness(() => new Promise((resolve) => { resolveTranscription = resolve; }));
const staleWork = staleProcessor.processor(new Blob(['audio']), 1200, true, 'capture-1', 'audio/webm');
staleProcessor.captureSessionIdRef.current = 'capture-2';
resolveTranscription({ text: 'What is JavaScript?', status: 200 });
await staleWork;
assert.equal(staleProcessor.state.transcripts.length, 0, 'A stale STT response must not overwrite the current transcript.');
assert.equal(staleProcessor.state.sentQuestions.length, 0, 'A stale STT response must not trigger an answer request.');

const cancelledProcessor = createProcessorHarness((_request) => new Promise((_resolve, reject) => {
  const { signal } = _request;
  signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
}));
const cancelledWork = cancelledProcessor.processor(new Blob(['audio']), 1200, true, 'capture-1', 'audio/webm');
cancelledProcessor.activeSttAbortRef.current.abort();
await cancelledWork;
assert.equal(cancelledProcessor.state.transcripts.length, 0, 'A cancelled STT request must not save a transcript.');
assert.equal(cancelledProcessor.state.errors.length, 0, 'Cancellation must not be reported as an STT failure.');
assert.equal(cancelledProcessor.state.transcribing, false, 'The transcription indicator must clear after cancellation.');

const failedProcessor = createProcessorHarness(async () => {
  throw new Error('network request failed');
});
await failedProcessor.processor(new Blob(['audio']), 1200, true, 'capture-1', 'audio/webm');
assert.equal(failedProcessor.state.pipelineStatus, 'error', 'A transcription failure must set the visible error stage.');
assert.match(failedProcessor.state.errors[0], /could not be reached/, 'A transcription failure must show a useful network error.');
assert.equal(failedProcessor.state.transcribing, false, 'The transcription indicator must clear after an STT failure.');

const retryDelays = [];
let retryAttempts = 0;
const retriedResponse = await transcribeMeetingSegmentWithRetry(
  { segmentId: 'stable-segment' },
  async (request) => {
    assert.equal(request.segmentId, 'stable-segment', 'STT retries must reuse the same segment identity.');
    retryAttempts += 1;
    if (retryAttempts < 3) {
      throw Object.assign(new Error('Temporary provider failure'), {
        classification: retryAttempts === 1 ? 'STT_NETWORK_ERROR' : 'STT_RATE_LIMIT',
      });
    }
    return { text: 'What is JavaScript?', status: 200 };
  },
  {
    signal: new AbortController().signal,
    onRetry: (attempt, delayMs) => retryDelays.push([attempt, delayMs]),
    wait: async () => {},
  },
);
assert.equal(retriedResponse.text, 'What is JavaScript?');
assert.equal(retryAttempts, 3, 'Transient failures should get two bounded retries.');
assert.deepEqual(retryDelays, [[1, 350], [2, 700]], 'Retries should use bounded exponential backoff.');

let authorizationAttempts = 0;
await assert.rejects(transcribeMeetingSegmentWithRetry(
  {},
  async () => {
    authorizationAttempts += 1;
    throw Object.assign(new Error('Invalid API key'), { classification: 'STT_AUTH_ERROR', status: 401 });
  },
  { signal: new AbortController().signal, onRetry: () => {}, wait: async () => {} },
));
assert.equal(authorizationAttempts, 1, 'Authentication failures must not be retried.');

const retryAbortController = new AbortController();
let abortedRetryAttempts = 0;
await assert.rejects(transcribeMeetingSegmentWithRetry(
  {},
  async () => {
    abortedRetryAttempts += 1;
    throw Object.assign(new Error('Network unavailable'), { classification: 'STT_NETWORK_ERROR' });
  },
  {
    signal: retryAbortController.signal,
    onRetry: () => {},
    wait: async (_delay, signal) => {
      retryAbortController.abort();
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    },
  },
));
assert.equal(abortedRetryAttempts, 1, 'Cancelling during retry backoff must prevent another STT request.');

console.log('Meeting capture integration tests passed (permission, disconnect, duplicate start, cancel, stale response, and successful STT).');
