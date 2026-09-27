import runtimeSettings from './runtimeSettings.json';

const defaults = runtimeSettings;

function configuredUrl(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : fallback;
}

function configuredNumber(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const importMetaEnv: Record<string, string | undefined> = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env
    : {}
);

export const runtimeConfig = {
  httpUrl: configuredUrl(importMetaEnv.VITE_API_URL, defaults.services.http.baseUrl),
  wsUrl: configuredUrl(importMetaEnv.VITE_WS_URL, defaults.services.websocket.baseUrl),
  codingWsUrl: configuredUrl(importMetaEnv.VITE_CODING_WS_URL, defaults.services.codingWebsocket.baseUrl),
  services: defaults.services,
  limits: {
    maxChatHistoryMessages: configuredNumber(importMetaEnv.VITE_MAX_CHAT_HISTORY_MESSAGES, defaults.client.limits.maxChatHistoryMessages),
    maxChatMessageChars: configuredNumber(importMetaEnv.VITE_MAX_CHAT_MESSAGE_CHARS, defaults.client.limits.maxChatMessageChars),
    maxContextChars: configuredNumber(importMetaEnv.VITE_MAX_CONTEXT_CHARS, defaults.client.limits.maxContextChars),
    maxPdfSizeBytes: configuredNumber(importMetaEnv.VITE_MAX_PDF_SIZE_BYTES, defaults.client.limits.maxPdfSizeBytes),
    pdfContextBudgetRatio: configuredNumber(importMetaEnv.VITE_PDF_CONTEXT_BUDGET_RATIO, defaults.client.limits.pdfContextBudgetRatio),
    pdfUploadTimeoutMs: configuredNumber(importMetaEnv.VITE_PDF_UPLOAD_TIMEOUT_MS, defaults.client.limits.pdfUploadTimeoutMs),
    transportConnectTimeoutMs: configuredNumber(importMetaEnv.VITE_TRANSPORT_CONNECT_TIMEOUT_MS, defaults.client.transport.connectTimeoutMs),
    transportRequestTimeoutMs: configuredNumber(importMetaEnv.VITE_TRANSPORT_REQUEST_TIMEOUT_MS, defaults.client.transport.requestTimeoutMs),
  },
  audio: {
    systemSilenceMs: configuredNumber(importMetaEnv.VITE_SYSTEM_AUDIO_SILENCE_MS, defaults.client.audio.systemSilenceMs),
    systemLevelThreshold: configuredNumber(importMetaEnv.VITE_SYSTEM_AUDIO_LEVEL_THRESHOLD, defaults.client.audio.systemLevelThreshold),
    voiceHighPassHz: defaults.client.audio.voiceHighPassHz,
    voiceLowPassHz: defaults.client.audio.voiceLowPassHz,
    voiceCompressorThresholdDb: defaults.client.audio.voiceCompressorThresholdDb,
    voiceCompressorRatio: defaults.client.audio.voiceCompressorRatio,
    continuationTimeoutMs: configuredNumber(importMetaEnv.VITE_AUDIO_CONTINUATION_TIMEOUT_MS, defaults.client.audio.continuationTimeoutMs),
    continuationMaxChars: configuredNumber(importMetaEnv.VITE_AUDIO_CONTINUATION_MAX_CHARS, defaults.client.audio.continuationMaxChars),
    shortFragmentMaxWords: configuredNumber(importMetaEnv.VITE_AUDIO_SHORT_FRAGMENT_MAX_WORDS, defaults.client.audio.shortFragmentMaxWords),
    shortFragmentMaxDurationMs: configuredNumber(importMetaEnv.VITE_AUDIO_SHORT_FRAGMENT_MAX_DURATION_MS, defaults.client.audio.shortFragmentMaxDurationMs),
  },
  history: defaults.client.history,
  codingSession: defaults.client.codingSession,
  providerHydration: defaults.client.providerHydration,
  overlay: defaults.electron.overlay,
} as const;
