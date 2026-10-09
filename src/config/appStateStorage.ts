const EXACT_KEYS = new Set([
  'trained-profiles-v1',
  'active-profile-id-v1',
  'ui-font-scale',
  'interview-context-v1',
  'meeting-history-retention-days',
  'chat-history',
  'coding-session-state',
  'coding-preferences-v1',
  'coding-active-session-v1',
  'ai-help-agent-provider-settings-v1',
  'ai_help_agent_coding_project_root',
  'coding-active-session-v1',
  'meeting-transcript-review-queue',
  'meeting-transcription-language',
  'meeting-review-before-send',
  'meeting-chat-state',
  'meeting-history-conversation-id',
  'meeting-transcripts',
]);

function isAllowedAppStateKey(key: string): boolean {
  return EXACT_KEYS.has(key)
    || /^coding-agent-(?:sessions|preferences)-v\d+$/.test(key)
    || /^ai-help-agent-provider-selection:(?:assistant|general)$/.test(key)
    || /^screen-reading-[a-z0-9-]+$/.test(key);
}

export function writeAppState(key: string, value: string, storage: Storage = localStorage): void {
  if (!isAllowedAppStateKey(key)) {
    throw new Error(`Application state key is not allow-listed: ${key}`);
  }
  storage.setItem(key, value);
}

export function clearAppState(key: string, storage: Storage = localStorage): void {
  if (!isAllowedAppStateKey(key)) {
    throw new Error(`Application state key is not allow-listed: ${key}`);
  }
  storage.removeItem(key);
}
