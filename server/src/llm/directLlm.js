import { providerOrder, streamProvider, normalizeProviderError, isFallbackError } from './provider.js';

/**
 * Stream through the configured provider. Fallback is intentionally limited
 * to quota/rate-limit failures; authentication and network failures are
 * actionable and must not silently switch credentials.
 */
export async function streamDirect({ messages, onToken }) {
  let lastError;
  for (const provider of providerOrder()) {
    try {
      return await streamProvider({ provider, messages, onToken });
    } catch (error) {
      lastError = normalizeProviderError(error, provider);
      if (!isFallbackError(lastError)) throw lastError;
      console.warn(`Provider ${provider} quota exhausted; trying fallback.`);
    }
  }
  throw lastError || new Error('No configured provider available.');
}
