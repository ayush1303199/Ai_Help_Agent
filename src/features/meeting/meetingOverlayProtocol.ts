export interface VersionedMeetingOverlayState {
  agent?: 'assistant' | 'meeting';
  meetingActive?: boolean;
  version?: number;
  updatedAt?: number;
}

export type OverlayTabPreference = 'answer' | 'analysis' | 'summary' | 'action-items' | 'search' | 'history';

export function resolveOverlayTabPreference(
  currentTab: OverlayTabPreference,
  incomingTab: unknown,
  userSelectedTab: boolean,
): OverlayTabPreference {
  if (userSelectedTab) return currentTab;
  return incomingTab === 'answer'
    || incomingTab === 'analysis'
    || incomingTab === 'summary'
    || incomingTab === 'action-items'
    || incomingTab === 'search'
    || incomingTab === 'history'
    ? incomingTab
    : currentTab;
}

export function shouldFocusMeetingAnswer(
  current: VersionedMeetingOverlayState & { answer?: unknown; status?: unknown },
  incoming: VersionedMeetingOverlayState & { answer?: unknown; status?: unknown },
) {
  const isNewMeetingAnswer = incoming.agent === 'meeting'
    && (incoming.status === 'answer' || incoming.status === 'listening')
    && typeof incoming.answer === 'string'
    && Boolean(incoming.answer.trim())
    && (current.agent !== 'meeting' || current.answer !== incoming.answer);
  return isNewMeetingAnswer;
}

export interface MeetingOverlayCommandResult {
  commandId: string;
  ok: boolean;
  captureActive?: boolean;
  message?: string;
}

export type MeetingOverlayStage = 'ready' | 'listening' | 'transcribing' | 'answering' | 'complete' | 'error';

export function meetingOverlayQuestion(status: string, lastQuestion: string, liveTranscript: string) {
  const transcript = liveTranscript.trim();
  if ((status === 'listening' || status === 'transcribing') && transcript) return transcript;
  return lastQuestion.trim() || transcript;
}

export function meetingOverlayAnswer(status: string, lastAnswer: string) {
  return status === 'question' || status === 'thinking' ? '' : lastAnswer;
}

export function isMissingMeetingOverlayHandler(error: unknown) {
  return error instanceof Error
    && error.message.includes("No handler registered for 'meeting-overlay:");
}

export function shouldAcceptOverlayAgentState(
  current: VersionedMeetingOverlayState,
  incoming: VersionedMeetingOverlayState,
) {
  if (incoming.agent === 'meeting'
    && incoming.meetingActive === false
    && current.agent === 'assistant') return false;
  if (incoming.agent === 'assistant'
    && current.agent === 'meeting'
    && current.meetingActive === true) return false;
  if (incoming.agent === 'meeting' && current.agent === 'meeting'
    && typeof incoming.version === 'number'
    && typeof current.version === 'number'
    && (incoming.version < current.version
      || (incoming.version === current.version
        && typeof incoming.updatedAt === 'number'
        && typeof current.updatedAt === 'number'
        && incoming.updatedAt < current.updatedAt))) return false;
  return true;
}

export function meetingOverlayStage(status?: string): MeetingOverlayStage {
  switch (status) {
    case 'listening':
      return 'listening';
    case 'transcribing':
      return 'transcribing';
    case 'question':
    case 'thinking':
      return 'answering';
    case 'answer':
      return 'complete';
    case 'error':
      return 'error';
    default:
      return 'ready';
  }
}

export function isCaptureCommandConfirmed(
  pending: { commandId: string; targetActive: boolean } | null,
  result: MeetingOverlayCommandResult,
) {
  return Boolean(pending
    && pending.commandId === result.commandId
    && result.ok
    && result.captureActive === pending.targetActive);
}
