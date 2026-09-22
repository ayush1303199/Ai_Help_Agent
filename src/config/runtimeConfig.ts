const DEFAULT_HTTP_URL = 'http://localhost:3001';
const DEFAULT_WS_URL = 'ws://localhost:3002';

function configuredUrl(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : fallback;
}

const importMetaEnv: Record<string, string | undefined> = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env
    : {}
);

export const runtimeConfig = {
  httpUrl: configuredUrl(importMetaEnv.VITE_API_URL, DEFAULT_HTTP_URL),
  wsUrl: configuredUrl(importMetaEnv.VITE_WS_URL, DEFAULT_WS_URL),
  limits: {
    maxChatHistoryMessages: Number(importMetaEnv.VITE_MAX_CHAT_HISTORY_MESSAGES) || 4,
    maxChatMessageChars: Number(importMetaEnv.VITE_MAX_CHAT_MESSAGE_CHARS) || 900,
    maxContextChars: Number(importMetaEnv.VITE_MAX_CONTEXT_CHARS) || 6000,
    maxPdfSizeBytes: Number(importMetaEnv.VITE_MAX_PDF_SIZE_BYTES) || 20 * 1024 * 1024,
    pdfContextBudgetRatio: Number(importMetaEnv.VITE_PDF_CONTEXT_BUDGET_RATIO) || 0.65,
    pdfUploadTimeoutMs: Number(importMetaEnv.VITE_PDF_UPLOAD_TIMEOUT_MS) || 20000,
  },
  audio: {
    systemSilenceMs: Number(importMetaEnv.VITE_SYSTEM_AUDIO_SILENCE_MS) || 2000,
    systemLevelThreshold: Number(importMetaEnv.VITE_SYSTEM_AUDIO_LEVEL_THRESHOLD) || 2,
    continuationTimeoutMs: Number(importMetaEnv.VITE_AUDIO_CONTINUATION_TIMEOUT_MS) || 3000,
    continuationMaxChars: Number(importMetaEnv.VITE_AUDIO_CONTINUATION_MAX_CHARS) || 240,
  },
} as const;
