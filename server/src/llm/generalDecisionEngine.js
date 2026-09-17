import { config, setConfiguredProviderStatus } from '../config.js';
import { completeProvider, isFallbackError, normalizeProviderError, providerOrder, providerSupportsToolCalling } from './provider.js';
import { GENERAL_TOOLS } from './generalTools.js';

const RATE_LIMIT_RETRY_DELAY_MS = 30_000;

function providerStatus(error) {
  if (error.category === 'RATE_LIMIT') return 'rate-limit';
  if (error.category === 'CAPACITY_503') return 'capacity-503';
  if (error.category === 'TIMEOUT') return 'timeout';
  if (error.category === 'NETWORK_ERROR') return 'network-error';
  return 'error';
}

export async function completeGeneral({ messages, allowTools = true, toolChoice = 'auto' }) {
  let lastError;
  let providers = providerOrder({ requireToolCalling: allowTools });
  if (providers.length === 0) {
    const rateLimited = config.configuredProviders.find((provider) => (
      provider.enabled
      && provider.apiKey
      && provider.model
      && provider.status === 'rate-limit'
      && (!allowTools || providerSupportsToolCalling(provider.adapterType, provider.model))
    ));
    if (rateLimited) {
      const lastCheckedAt = Number(rateLimited.lastCheckedAt || 0);
      if (Date.now() - lastCheckedAt < RATE_LIMIT_RETRY_DELAY_MS) {
        throw normalizeProviderError({ status: 429 }, rateLimited.label || rateLimited.adapterType);
      }
      providers = [rateLimited];
    }
  }
  for (const provider of providers) {
    try {
      const response = await completeProvider({
        provider,
        messages,
        tools: allowTools ? GENERAL_TOOLS : undefined,
        toolChoice,
      });
      if (provider.id) setConfiguredProviderStatus(provider.id, 'ok');
      return {
        message: response.choices?.[0]?.message || {},
        provider: provider.id || provider.adapterType || provider,
        model: provider.model || null,
      };
    } catch (error) {
      lastError = normalizeProviderError(error, provider.label || provider.adapterType || provider);
      if (provider.id) setConfiguredProviderStatus(provider.id, providerStatus(lastError), lastError.message);
      if (/tools are not supported/i.test(lastError.message)) continue;
      if (!isFallbackError(lastError)) throw lastError;
    }
  }
  throw lastError || new Error('No configured provider available for General Agent.');
}
