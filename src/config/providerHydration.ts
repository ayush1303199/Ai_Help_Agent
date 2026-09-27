export class ProviderHydrationRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderHydrationRequestError';
    this.retryable = retryable;
  }
}

interface RetryOptions {
  signal: AbortSignal;
  delaysMs?: number[];
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Provider hydration was cancelled.', 'AbortError');
}

function isRetryable(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof ProviderHydrationRequestError && error.retryable);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryProviderHydration<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  { signal, delaysMs = [250, 500, 1000] }: RetryOptions,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw abortError(signal);
    try {
      return await operation(signal);
    } catch (error) {
      if (!isRetryable(error) || attempt >= delaysMs.length) throw error;
      await waitForRetry(delaysMs[attempt], signal);
    }
  }
}
