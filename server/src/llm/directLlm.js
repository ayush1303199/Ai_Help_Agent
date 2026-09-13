import { providerOrder, streamProvider, normalizeProviderError, isFallbackError } from './provider.js';
import { setConfiguredProviderStatus } from '../config.js';

/**
 * Stream through the configured provider. Fallback is intentionally limited
 * to quota/rate-limit failures; authentication and network failures are
 * actionable and must not silently switch credentials.
 */
export async function streamDirect({ messages, onToken }) {
  let lastError;
  for (const provider of providerOrder()) {
    try {
      const result = await streamProvider({ provider, messages, onToken });
      if (provider.id) setConfiguredProviderStatus(provider.id, 'ok');
      return result;
    } catch (error) {
      lastError = normalizeProviderError(error, provider.label || provider.adapterType || provider);
      if (provider.id) setConfiguredProviderStatus(provider.id, lastError.kind === 'quota' ? 'quota-exceeded' : lastError.kind === 'invalid_key' ? 'invalid-key' : 'error', lastError.message);
      if (!isFallbackError(lastError)) throw lastError;
      console.warn(`Provider ${provider.label || provider.adapterType} quota exhausted; trying fallback.`);
    }
  }
  throw lastError || new Error('No configured provider available.');
}
