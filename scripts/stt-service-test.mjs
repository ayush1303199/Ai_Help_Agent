import assert from 'node:assert/strict';

const { transcribeAudioSegment } = await import('../src/audio/sttService.ts');
const originalFetch = globalThis.fetch;

try {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ text: 'What is Spring Boot?' }), { status: 200 });
  };

  const result = await transcribeAudioSegment({
    audio: new Blob(['audio'], { type: 'audio/webm' }),
    endpoint: 'http://localhost:3001/api/transcribe-audio',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    payloadName: 'meeting.webm',
  });
  assert.deepEqual(result, { text: 'What is Spring Boot?', status: 200 });
  assert.equal(request.url, 'http://localhost:3001/api/transcribe-audio');
  assert.equal(request.options.headers['X-STT-Session-ID'], 'session-1');
  assert.equal(request.options.headers['X-STT-Segment-ID'], 'segment-1');

  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'Provider rejected audio', classification: 'STT_BAD_REQUEST' }),
    { status: 400 },
  );
  await assert.rejects(
    () => transcribeAudioSegment({
      audio: new Blob(['audio']),
      endpoint: 'http://localhost:3001/api/transcribe-audio',
      sessionId: 'session-1',
      segmentId: 'segment-2',
      payloadName: 'meeting.webm',
    }),
    (error) => error.message === 'Provider rejected audio'
      && error.classification === 'STT_BAD_REQUEST'
      && error.status === 400,
  );

  await assert.rejects(
    () => transcribeAudioSegment({
      audio: new Blob([]),
      endpoint: 'http://localhost:3001/api/transcribe-audio',
      sessionId: 'session-1',
      segmentId: 'segment-3',
      payloadName: 'meeting.webm',
    }),
    (error) => error.classification === 'AUDIO_CAPTURE_NO_SIGNAL',
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  sttService: true,
  requestHeaders: true,
  responseErrors: true,
  emptyAudioGuard: true,
}));
