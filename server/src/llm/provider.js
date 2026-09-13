import OpenAI from 'openai';
import { config } from '../config.js';

const openAICompatible = new Set([
  'groq', 'openai', 'deepseek', 'openrouter', 'together', 'llama', 'mistral',
  'xai', 'perplexity', 'fireworks', 'cerebras', 'custom', 'custom-openai',
]);

export const PROVIDER_REGISTRY = Object.freeze({
  groq: { adapter: 'openai-compatible' }, openai: { adapter: 'openai-compatible' },
  deepseek: { adapter: 'openai-compatible' }, openrouter: { adapter: 'openai-compatible' },
  together: { adapter: 'openai-compatible' }, llama: { adapter: 'openai-compatible' },
  mistral: { adapter: 'openai-compatible' }, xai: { adapter: 'openai-compatible' },
  perplexity: { adapter: 'openai-compatible' }, fireworks: { adapter: 'openai-compatible' },
  cerebras: { adapter: 'openai-compatible' }, custom: { adapter: 'openai-compatible' },
  'custom-openai': { adapter: 'openai-compatible' }, anthropic: { adapter: 'anthropic' },
  gemini: { adapter: 'gemini' }, cohere: { adapter: 'cohere' },
});

let cachedClient;
let cachedClientKey;
const configuredClients = new Map();

export class ProviderError extends Error {
  constructor(message, kind, provider, status) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = status;
    this.retryable = kind === 'quota';
  }
}

export function normalizeProviderError(error, provider) {
  if (error instanceof ProviderError) return error;
  const status = error?.status || error?.statusCode || error?.response?.status;
  const text = String(error?.message || error || 'Unknown provider error');
  const lower = text.toLowerCase();
  let kind = 'unexpected';
  if (status === 401 || status === 403 || /invalid.*(key|token)|authentication|unauthorized|api key/.test(lower)) kind = 'invalid_key';
  else if (status === 429 || /rate.?limit|quota|too many requests|capacity|resource exhausted/.test(lower)) kind = 'quota';
  else if (!status && /network|fetch failed|timeout|econn|socket|enotfound|aborted/.test(lower)) kind = 'network';
  const message = kind === 'invalid_key'
    ? `Invalid API key for ${provider}. Check the key configured for this provider.`
    : kind === 'quota'
      ? `${provider} quota or rate limit exceeded.`
      : kind === 'network'
        ? `Unable to reach ${provider}. Check network connectivity and the provider URL.`
        : `Unexpected response from ${provider}: ${text}`;
  return new ProviderError(message, kind, provider, status);
}

export function getClient(provider = config.provider) {
  const active = config[provider];
  if (!active?.apiKey || active.apiKey.includes('your_')) throw new ProviderError(`No API key configured for provider "${provider}".`, 'invalid_key', provider);
  const key = `${provider}|${active.apiKey}|${active.baseURL}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = new OpenAI({ apiKey: active.apiKey, baseURL: active.baseURL });
  cachedClientKey = key;
  return cachedClient;
}

function getConfiguredClient(provider) {
  const key = `${provider.id}|${provider.apiKey}|${provider.baseURL}`;
  const existing = configuredClients.get(key);
  if (existing) return existing;
  const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  configuredClients.set(key, client);
  return client;
}

export function getModel(provider = config.provider) { return config[provider]?.model; }
export function getProviderInfo() { return { provider: config.provider, model: getModel() }; }
export function isFallbackError(error) { return normalizeProviderError(error).kind === 'quota'; }

export function providerOrder() {
  if (config.configuredProviders.length > 0) {
    const providers = config.configuredProviders
      .filter((provider) => provider.enabled && provider.apiKey && provider.model)
      .sort((a, b) => a.priority - b.priority);
    return config.fallbackEnabled ? providers : providers.slice(0, 1);
  }
  const all = [config.provider, ...(config.fallbackEnabled ? Object.keys(config.runtimeProviders) : [])];
  return [...new Set(all)].map((provider, index) => ({
    id: `legacy-${provider}`, label: provider, adapterType: provider, priority: index + 1,
  }));
}

function parseSse(buffer, callback) {
  const lines = buffer.split('\n');
  lines.pop();
  lines.forEach((line) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    try { callback(JSON.parse(value)); } catch { /* keep-alive frame */ }
  });
}

async function streamAnthropic(active, messages, onToken) {
  const system = messages.find((message) => message.role === 'system')?.content;
  const response = await fetch(`${active.baseURL}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': active.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: active.model, max_tokens: config.server.maxTokens, stream: true, system, messages: messages.filter((message) => message.role !== 'system') }),
  });
  if (!response.ok || !response.body) throw Object.assign(new Error(await response.text()), { status: response.status });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let text = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    parseSse(buffer, (event) => { const token = event.delta?.text || ''; if (token) { text += token; onToken(token); } });
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  }
  buffer += decoder.decode();
  if (buffer) parseSse(`${buffer}\n`, (event) => { const token = event.delta?.text || ''; if (token) { text += token; onToken(token); } });
  return text;
}

async function streamGemini(active, messages, onToken) {
  const baseURL = active.baseURL.replace(/\/openai\/?$/, '');
  const url = `${baseURL}/models/${active.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(active.apiKey)}`;
  const contents = messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
  const system = messages.find((message) => message.role === 'system');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemInstruction: system && { parts: [{ text: system.content }] }, contents, generationConfig: { maxOutputTokens: config.server.maxTokens, temperature: 0.3 } }) });
  if (!response.ok || !response.body) throw Object.assign(new Error(await response.text()), { status: response.status });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let text = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    parseSse(buffer, (event) => { const token = event.candidates?.[0]?.content?.parts?.[0]?.text || ''; if (token) { text += token; onToken(token); } });
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  }
  buffer += decoder.decode();
  if (buffer) parseSse(`${buffer}\n`, (event) => { const token = event.candidates?.[0]?.content?.parts?.[0]?.text || ''; if (token) { text += token; onToken(token); } });
  return text;
}

async function streamCohere(active, messages, onToken) {
  const baseURL = active.baseURL.replace(/\/compatibility\/v1\/?$/, '/v2');
  const response = await fetch(`${baseURL}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${active.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: active.model, stream: true, max_tokens: config.server.maxTokens, messages }),
  });
  if (!response.ok || !response.body) throw Object.assign(new Error(await response.text()), { status: response.status });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let text = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    parseSse(buffer, (event) => { const token = event.delta?.message?.content?.text || event.delta?.text || ''; if (token) { text += token; onToken(token); } });
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  }
  buffer += decoder.decode();
  if (buffer) parseSse(`${buffer}\n`, (event) => { const token = event.delta?.message?.content?.text || event.delta?.text || ''; if (token) { text += token; onToken(token); } });
  return text;
}

export async function streamProvider({ provider, messages, onToken }) {
  const providerId = typeof provider === 'string' ? provider : provider.adapterType;
  const active = typeof provider === 'string' ? config[provider] : provider;
  if (!active?.apiKey || !active?.model) throw new ProviderError(`Provider ${providerId} is not configured.`, 'invalid_key', providerId);
  try {
    if (providerId === 'anthropic') return await streamAnthropic(active, messages, onToken);
    if (providerId === 'gemini') return await streamGemini(active, messages, onToken);
    if (providerId === 'cohere') return await streamCohere(active, messages, onToken);
    if (openAICompatible.has(providerId)) {
      const client = typeof provider === 'string' ? getClient(provider) : getConfiguredClient(provider);
      const stream = await client.chat.completions.create({ model: active.model, messages, stream: true, max_tokens: config.server.maxTokens, temperature: 0.3 });
      let text = '';
      for await (const chunk of stream) {
        const token = chunk.choices?.[0]?.delta?.content || '';
        if (token) { text += token; onToken(token); }
      }
      return text;
    }
    throw new ProviderError(`Unsupported provider "${providerId}".`, 'unexpected', providerId);
  } catch (error) {
    throw normalizeProviderError(error, providerId);
  }
}
