export interface VersionedMeetingOverlayState {
  agent?: 'assistant' | 'meeting';
  meetingActive?: boolean;
  version?: number;
  updatedAt?: number;
}

export interface MeetingOverlayCommandResult {
  commandId: string;
  ok: boolean;
  captureActive?: boolean;
  message?: string;
}

export type MeetingOverlayStage = 'ready' | 'listening' | 'transcribing' | 'answering' | 'complete' | 'error';

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
