import type { SttFailureClassification } from '../../audio/sttTypes';

export function logSttTrace(sttSession: string, event: string, fields: Record<string, unknown> = {}) {
  console.info(`[STT_TRACE] ${JSON.stringify({ sttSession, event, ...fields })}`);
}

export function classifySttClientError(error: unknown): SttFailureClassification {
  const name = error instanceof DOMException ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/i.test(message)) {
    return 'AUDIO_PERMISSION';
  }
  if (/unsupported|codec|mime|format|audio type/i.test(message)) return 'STT_UNSUPPORTED_AUDIO';
  if (/timeout|timed out/i.test(message)) return 'STT_TIMEOUT';
  if (/network|fetch|failed to fetch|load failed/i.test(message)) return 'STT_NETWORK_ERROR';
  return 'STT_UNKNOWN';
}

export function shouldHandleMeetingTrackEnd(
  captureActive: boolean,
  activeSessionId: string,
  trackSessionId: string,
) {
  return captureActive && activeSessionId !== '' && activeSessionId === trackSessionId;
}

export function attachMeetingTrackEndHandlers(
  tracks: MediaStreamTrack[],
  shouldHandleEnd: () => boolean,
  onTrackEnded: () => void,
) {
  const handleEnded = () => {
    if (shouldHandleEnd()) onTrackEnded();
  };
  tracks.forEach((track) => track.addEventListener('ended', handleEnded));
  return () => tracks.forEach((track) => track.removeEventListener('ended', handleEnded));
}

export function meetingCaptureStartDecision(
  captureActive: boolean,
  startInProgress: boolean,
  activeSessionId: string,
) {
  if (captureActive) return 'already-active';
  if (startInProgress || activeSessionId !== '') return 'blocked';
  return 'start';
}

export function shouldApplyMeetingSttResult(
  activeSessionId: string,
  responseSessionId: string,
  requestAborted: boolean,
) {
  return !requestAborted && activeSessionId !== '' && activeSessionId === responseSessionId;
}
