import type { SttFailureClassification } from '../../audio/sttTypes';
import { classifySttClientError } from './meetingCaptureLifecycle.ts';

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 350;
const RETRY_MAX_DELAY_MS = 1400;

function isRetryableMeetingSttError(error: unknown) {
  const classified = error && typeof error === 'object'
    ? error as { classification?: SttFailureClassification; status?: number }
    : {};
  const classification = classified.classification || classifySttClientError(error);
  return classification === 'STT_NETWORK_ERROR'
    || classification === 'STT_TIMEOUT'
    || classification === 'STT_RATE_LIMIT'
    || (typeof classified.status === 'number' && classified.status >= 500 && classified.status <= 599);
}

function waitForRetry(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

export async function transcribeMeetingSegmentWithRetry<T>(
  request: T,
  transcribe: (request: T) => Promise<{ text: string; status: number }>,
  {
    signal,
    onRetry,
    wait = waitForRetry,
  }: {
    signal: AbortSignal;
    onRetry: (retryNumber: number, delayMs: number) => void;
    wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  },
) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    try {
      return await transcribe(request);
    } catch (error) {
      if (signal.aborted || attempt >= MAX_RETRIES || !isRetryableMeetingSttError(error)) {
        throw error;
      }
      const retryNumber = attempt + 1;
      const delayMs = Math.min(RETRY_BASE_DELAY_MS * (2 ** attempt), RETRY_MAX_DELAY_MS);
      onRetry(retryNumber, delayMs);
      await wait(delayMs, signal);
    }
  }
}
