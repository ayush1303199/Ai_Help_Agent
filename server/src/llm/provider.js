import { config } from '../config.js';
import OpenAI from 'openai';

/**
 * Returns a shared OpenAI-compatible client configured for the
 * active provider (Groq or OpenAI). Because Groq implements the
 * OpenAI API spec, the same SDK works for both — only the base URL
 * and API key change.
 *
 * To add a new provider, add its entry to config.js and handle it here.
 */
let cachedClient = null;
let cachedClientKey = null;

/** Reuse the provider client's keep-alive connection between requests. */
export function getClient(provider = config.provider) {
  const active = config[provider];

  if (!active.apiKey || active.apiKey.includes('your_')) {
    throw new Error(`No API key configured for provider "${provider}".`);
  }

  const clientKey = `${provider}|${active.apiKey}|${active.baseURL}`;
  if (cachedClient && cachedClientKey === clientKey) return cachedClient;

  cachedClient = new OpenAI({
    apiKey: active.apiKey,
    baseURL: active.baseURL,
  });
  cachedClientKey = clientKey;
  return cachedClient;
}

/** Returns the model name for the active provider. */
export function getModel() {
  return config[config.provider].model;
}

/** Returns provider info for the health endpoint. */
export function getProviderInfo() {
  return {
    provider: config.provider,
    model: getModel(),
  };
}
