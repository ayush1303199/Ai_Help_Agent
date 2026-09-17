import OpenAI from 'openai';
import { config } from '../config.js';

const openAICompatible = new Set([
  'groq', 'openai', 'deepseek', 'openrouter', 'together', 'llama', 'mistral',
  'xai', 'perplexity', 'fireworks', 'cerebras', 'custom', 'custom-openai',
]);

const geminiFunctionCallingModel = /^(?:gemini-1\.5-(?:flash(?:-8b)?|pro)|gemini-2\.0-(?:flash|flash-lite|pro)|gemini-2\.5-(?:flash|pro)|gemini-3\.[0-9]+-(?:flash|pro))(?:-|$)/i;

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
let geminiCallSequence = 0;

export class ProviderError extends Error {
  constructor(message, kind, provider, status) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = status;
    this.retryable = ['quota', 'rate_limit', 'capacity', 'network', 'timeout', 'service_unavailable'].includes(kind);
  }
}

export function normalizeProviderError(error, provider) {
  if (error instanceof ProviderError) return error;
  const status = error?.status || error?.statusCode || error?.response?.status;
  const text = String(error?.message || error || 'Unknown provider error');
  const lower = text.toLowerCase();
  let kind = 'unexpected';
  if (status === 401 || status === 403 || /invalid.*(key|token)|authentication|unauthorized|api key/.test(lower)) kind = 'invalid_key';
  else if (status === 429 || /rate.?limit|quota|too many requests|resource exhausted/.test(lower)) kind = 'rate_limit';
  else if (status === 503 || /high demand|capacity|service unavailable/.test(lower)) kind = 'capacity';
  else if (/timeout|timed out|aborted/.test(lower)) kind = 'timeout';
  else if (!status && /network|fetch failed|econn|socket|enotfound/.test(lower)) kind = 'network';
  else if (status >= 500) kind = 'service_unavailable';
  const category = kind === 'invalid_key' ? 'AUTH_ERROR'
    : kind === 'rate_limit' ? 'RATE_LIMIT'
      : kind === 'capacity' ? 'CAPACITY_503'
        : kind === 'network' ? 'NETWORK_ERROR'
          : kind === 'timeout' ? 'TIMEOUT'
            : kind === 'service_unavailable' ? 'SERVICE_UNAVAILABLE'
              : kind === 'unexpected' ? 'PROTOCOL_ERROR' : 'PROVIDER_ERROR';
  const message = kind === 'invalid_key'
    ? `Invalid API key for ${provider}. Check the key configured for this provider.`
    : kind === 'rate_limit'
      ? `${provider} quota or rate limit exceeded.`
      : kind === 'capacity'
        ? `${provider} is temporarily at capacity. Try again later or use another verified provider.`
      : kind === 'timeout'
        ? `${provider} request timed out.`
      : kind === 'network'
        ? `Unable to reach ${provider}. Check network connectivity and the provider URL.`
        : kind === 'service_unavailable'
          ? `${provider} service is temporarily unavailable.`
        : `Unexpected response from ${provider}: ${text}`;
  const normalized = new ProviderError(message, kind, provider, status);
  normalized.category = category;
  return normalized;
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

export function isGeminiFunctionCallingModel(model) {
  return geminiFunctionCallingModel.test(String(model || '').trim());
}

export function providerSupportsToolCalling(provider, model) {
  if (openAICompatible.has(provider)) return true;
  return provider === 'gemini' && isGeminiFunctionCallingModel(model);
}

function providerVerificationStatus(provider, model, configured) {
  if (!configured) return 'NOT_CONFIGURED';
  if (!providerSupportsToolCalling(provider, model)) return 'TOOL_CALL_UNSUPPORTED';

  const instances = config.configuredProviders
    .filter((candidate) => candidate.adapterType === provider && candidate.model === model);

  if (instances.some((instance) => instance.status === 'ok' || instance.status === 'READY')) {
    return 'READY';
  }

  const blocked = new Set([
    'invalid-key',
    'auth-error',
    'tool-call-unsupported',
    'model-unavailable',
    'unsupported',
  ]);

  const transientStillConfigurable = instances.find((candidate) => {
    const status = String(candidate.status || '').toLowerCase().replace(/_/g, '-');
    return candidate.apiKey && candidate.model && !blocked.has(status);
  });
  if (transientStillConfigurable) {
    return 'READY';
  }

  const explicitFailure = instances.find((candidate) => {
    const status = String(candidate.status || '').toLowerCase().replace(/_/g, '-');
    return status && status !== 'unknown' && status !== 'ready';
  });
  if (explicitFailure) {
    return String(explicitFailure.status).toUpperCase().replace(/-/g, '_');
  }

  return 'READY';
}

function providerCapability(provider, model, configured) {
  const developerToolCalling = providerSupportsToolCalling(provider, model);
  const developerStatus = providerVerificationStatus(provider, model, configured);
  return {
    assistantCapable: configured,
    developerToolCalling,
    developerToolCallingVerified: developerStatus === 'READY',
    developerStatus,
  };
}

export function getProviderInfo() {
  const active = config[config.provider];
  const configured = Boolean(active?.apiKey && active?.model && !active.apiKey.includes('your_'));
  const capability = providerCapability(config.provider, active?.model, configured);
  return {
    provider: config.provider,
    model: getModel(),
    configured,
    toolCalling: capability.developerToolCalling,
    toolCallingVerified: capability.developerToolCallingVerified,
    developerStatus: capability.developerStatus,
    assistantCapable: capability.assistantCapable,
  };
}

export function getConfiguredProviderStatus(providerName = config.provider) {
  const active = config[providerName];
  if (!active?.apiKey || !active?.model || active.apiKey.includes('your_')) return 'NOT_CONFIGURED';
  const configured = Boolean(active.apiKey && active.model && !active.apiKey.includes('your_'));
  return providerVerificationStatus(providerName, active.model, configured);
}
export function getProviderCapabilities() {
  return Object.entries(PROVIDER_REGISTRY).map(([provider, metadata]) => {
    const active = config[provider];
    const configured = Boolean(active?.apiKey && active?.model && !active.apiKey.includes('your_'));
    const capability = providerCapability(provider, active?.model, configured);
    return {
      provider,
      model: active?.model || null,
      configured,
      toolCalling: capability.developerToolCalling,
      toolCallingVerified: capability.developerToolCallingVerified,
      assistantCapable: capability.assistantCapable,
      developerToolCalling: capability.developerToolCalling,
      developerStatus: capability.developerStatus,
      status: capability.developerStatus,
    };
  });
}
export function getConfiguredProviderCapabilities() {
  return config.configuredProviders.map((provider) => ({
    id: provider.id,
    ...providerCapability(
      provider.adapterType,
      provider.model,
      Boolean(provider.apiKey && !provider.apiKey.includes('your_')),
    ),
  }));
}
export async function selfTestProvider(providerName = config.provider) {
  const provider = config[providerName];
  const metadata = PROVIDER_REGISTRY[providerName];
  const configured = Boolean(provider?.apiKey && provider?.model && !provider.apiKey.includes('your_'));
  const base = {
    provider: providerName,
    model: provider?.model || null,
    configured,
    toolCalling: providerSupportsToolCalling(providerName, provider?.model),
  };
  if (!metadata || !provider) return { ...base, status: 'MODEL_UNAVAILABLE' };
  if (!base.configured) return { ...base, status: 'NOT_CONFIGURED' };
  if (!base.toolCalling) return { ...base, status: 'TOOL_CALL_UNSUPPORTED', reason: 'The configured adapter or model does not advertise function calling.' };
  try {
    const response = await completeProvider({
      provider: providerName,
      messages: [{ role: 'user', content: 'Call provider_self_test exactly once. Do not answer with text.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'provider_self_test',
          description: 'Return a readiness marker.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      }],
      toolChoice: 'required',
    });
    const message = response.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.find((call) => call.function?.name === 'provider_self_test');
    if (!toolCall) return { ...base, status: 'TOOL_CALL_UNSUPPORTED', reason: 'The model did not return the required function call.' };
    const continuation = await completeProvider({
      provider: providerName,
      messages: [
        { role: 'user', content: 'Call provider_self_test exactly once. Do not answer with text.' },
        message,
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify({ ok: true }),
        },
      ],
      tools: [],
      toolChoice: 'none',
    });
    if (continuation.choices?.[0]?.message?.tool_calls?.length) {
      return { ...base, status: 'TOOL_CALL_UNSUPPORTED', reason: 'The model did not complete after the function response.' };
    }
    return { ...base, status: 'READY' };
  } catch (error) {
    const normalized = normalizeProviderError(error, providerName);
    const status = normalized.kind === 'invalid_key'
      ? 'INVALID_CREDENTIAL'
      : normalized.kind === 'rate_limit'
        ? 'RATE_LIMIT'
      : normalized.kind === 'capacity'
        ? 'CAPACITY_503'
      : normalized.kind === 'network'
        ? 'NETWORK_ERROR'
        : normalized.kind === 'timeout'
          ? 'TIMEOUT'
        : normalized.kind === 'service_unavailable'
          ? 'SERVICE_UNAVAILABLE'
        : normalized.status === 404
          ? 'MODEL_UNAVAILABLE'
          : normalized.status >= 500
            ? 'SERVICE_UNAVAILABLE'
          : 'PROVIDER_ERROR';
    return {
      ...base,
      status,
      reason: normalized.status ? `Provider returned HTTP ${normalized.status}.` : `Provider request failed (${normalized.category || normalized.kind}).`,
      category: normalized.category,
    };
  }
}
export function isFallbackError(error) {
  return normalizeProviderError(error).retryable;
}

export function providerOrder({ requireToolCalling = false, allowPreviouslyFailed = false } = {}) {
  if (config.configuredProviders.length > 0) {
    let providers = config.configuredProviders
      .filter((provider) => provider.enabled && provider.apiKey && provider.model)
      .sort((a, b) => a.priority - b.priority);
    if (requireToolCalling) {
      providers = providers.filter((provider) => providerSupportsToolCalling(provider.adapterType, provider.model));
      if (!allowPreviouslyFailed) {
        providers = providers.filter((provider) => provider.status === 'ok' || provider.status === 'READY');
      }
    }
    return config.fallbackEnabled ? providers : providers.slice(0, 1);
  }
  const all = [config.provider, ...(config.fallbackEnabled ? Object.keys(config.runtimeProviders) : [])];
  return [...new Set(all)]
    .map((provider, index) => ({
      id: `legacy-${provider}`,
      label: provider,
      adapterType: provider,
      ...config[provider],
      priority: index + 1,
      status: 'unknown',
    }))
    .filter((provider) => !requireToolCalling || (
      providerSupportsToolCalling(provider.adapterType, provider.model) &&
      (allowPreviouslyFailed || provider.status === 'ok' || provider.status === 'READY')
    ));
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
  if (/\/openai\/?$/.test(active.baseURL)) {
    const client = new OpenAI({ apiKey: active.apiKey, baseURL: active.baseURL });
    const stream = await client.chat.completions.create({
      model: active.model,
      messages,
      stream: true,
      max_tokens: config.server.maxTokens,
      temperature: 0.3,
    });
    let text = '';
    for await (const chunk of stream) {
      const token = chunk.choices?.[0]?.delta?.content || '';
      if (token) {
        text += token;
        onToken(token);
      }
    }
    return text;
  }
  const baseURL = active.baseURL.replace(/\/openai\/?$/, '');
  const url = `${baseURL}/models/${encodeURIComponent(active.model)}:streamGenerateContent?alt=sse`;
  const request = buildGeminiRequest({ messages });
  request.generationConfig = { maxOutputTokens: config.server.maxTokens, temperature: 0.3 };
  const response = await fetch(url, { method: 'POST', headers: { 'x-goog-api-key': active.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(request) });
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

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

function jsonObject(content) {
  if (typeof content !== 'string') return content && typeof content === 'object' && !Array.isArray(content) ? content : { value: content };
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { text: content };
  }
}

function appendGeminiPart(contents, role, part) {
  const last = contents[contents.length - 1];
  if (last?.role === role) {
    last.parts.push(part);
  } else {
    contents.push({ role, parts: [part] });
  }
}

export function convertToolsToGemini(tools = []) {
  return tools.map((tool) => {
    const definition = tool?.function || tool;
    const sanitizeSchema = (schema) => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
      const sanitized = {};
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'additionalProperties' || key === '$schema') continue;
        if (key === 'properties' && value && typeof value === 'object') {
          sanitized.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sanitizeSchema(child)]));
        } else if (key === 'items') {
          sanitized.items = sanitizeSchema(value);
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    };
    return {
      name: definition.name,
      description: definition.description,
      parameters: sanitizeSchema(definition.parameters || { type: 'object', properties: {} }),
    };
  });
}

export function buildGeminiContents(messages = []) {
  const contents = [];
  const systemParts = [];
  const toolNames = new Map();
  let leading = true;
  for (const message of messages) {
    const role = message?.role;
    if (role === 'system') {
      const text = contentToText(message.content);
      if (leading) {
        if (text) systemParts.push(text);
      } else if (text) {
        appendGeminiPart(contents, 'user', { text });
      }
      continue;
    }
    leading = false;
    if (role === 'user' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) appendGeminiPart(contents, 'user', { text });
      continue;
    }
    if (role === 'assistant') {
      const parts = [];
      const text = contentToText(message.content);
      if (text) parts.push({ text });
      for (const call of message.tool_calls || []) {
        const name = call?.function?.name;
        if (!name) continue;
        const callId = String(call.id || `gemini-call-${geminiCallSequence + toolNames.size + 1}`);
        toolNames.set(callId, name);
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        const functionCallPart = { functionCall: { name, args } };
        const thoughtSignature = call.geminiThoughtSignature
          || call.function?.thoughtSignature
          || call.function?.thought_signature
          || call.extra_content?.google?.thought_signature;
        if (thoughtSignature) functionCallPart.thoughtSignature = thoughtSignature;
        parts.push(functionCallPart);
      }
      parts.forEach((part) => appendGeminiPart(contents, 'model', part));
      continue;
    }
    if (role === 'tool') {
      const name = message.name || toolNames.get(String(message.tool_call_id));
      if (!name) throw new ProviderError('Gemini tool result is missing its function name.', 'unexpected', 'gemini');
      appendGeminiPart(contents, 'user', {
        functionResponse: { name, response: jsonObject(message.content) },
      });
    }
  }
  return { systemInstruction: systemParts.join('\n\n'), contents };
}

export function buildGeminiRequest({ messages = [], tools = [], toolChoice = 'auto' }) {
  const { systemInstruction, contents } = buildGeminiContents(messages);
  const request = { contents };
  if (systemInstruction) request.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = [{ functionDeclarations: convertToolsToGemini(tools) }];
    const mode = toolChoice === 'required' ? 'ANY' : toolChoice === 'none' ? 'NONE' : 'AUTO';
    request.toolConfig = { functionCallingConfig: { mode } };
  }
  return request;
}

export function parseGeminiResponse(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part?.text || '').join('');
  const toolCalls = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part?.functionCall?.name)
    .map(({ part, index }) => {
      const functionCall = part.functionCall;
      const id = String(functionCall.id || part.id || `gemini-call-${++geminiCallSequence}-${index + 1}`);
      const thoughtSignature = part.thoughtSignature
        || part.thought_signature
        || functionCall.thoughtSignature
        || functionCall.thought_signature;
      return {
        id,
        type: 'function',
        function: {
          name: functionCall.name,
          arguments: JSON.stringify(functionCall.args || {}),
        },
        ...(thoughtSignature ? { geminiThoughtSignature: thoughtSignature } : {}),
      };
    });
  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

async function completeGemini({ active, messages, tools, toolChoice }) {
  if (/\/openai\/?$/.test(active.baseURL)) {
    const client = new OpenAI({ apiKey: active.apiKey, baseURL: active.baseURL });
    const request = {
      model: active.model,
      messages,
      max_tokens: config.server.maxTokens,
      temperature: 0.3,
    };
    if (Array.isArray(tools) && tools.length > 0) {
      request.tools = tools;
      request.tool_choice = toolChoice;
    }
    return client.chat.completions.create(request);
  }
  const baseURL = active.baseURL.replace(/\/openai\/?$/, '');
  const url = `${baseURL}/models/${encodeURIComponent(active.model)}:generateContent`;
  const request = buildGeminiRequest({ messages, tools, toolChoice });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': active.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw Object.assign(new Error(await response.text()), { status: response.status });
  return {
    choices: [{
      index: 0,
      message: parseGeminiResponse(await response.json()),
      finish_reason: 'stop',
    }],
  };
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

/**
 * Request one structured response for the developer tool loop. This is kept
 * separate from streamProvider so the existing assistant streaming path is
 * unchanged. OpenAI-compatible providers are the only adapters that expose
 * the common tool-call shape.
 */
export async function completeProvider({ provider, messages, tools, toolChoice = 'auto' }) {
  const providerId = typeof provider === 'string' ? provider : provider.adapterType;
  const active = typeof provider === 'string' ? config[provider] : provider;
  if (!active?.apiKey || !active?.model) throw new ProviderError(`Provider ${providerId} is not configured.`, 'invalid_key', providerId);
  try {
    if (providerId === 'gemini') {
      if (!isGeminiFunctionCallingModel(active.model)) {
        throw new ProviderError(`Developer tools are not supported by Gemini model "${active.model}".`, 'unexpected', providerId);
      }
      return await completeGemini({ active, messages, tools, toolChoice });
    }
    if (!openAICompatible.has(providerId)) {
      throw new ProviderError(`Developer tools are not supported by ${providerId}.`, 'unexpected', providerId);
    }
    const client = typeof provider === 'string' ? getClient(provider) : getConfiguredClient(provider);
    const request = {
      model: active.model,
      messages,
      max_tokens: config.server.maxTokens,
      temperature: 0.3,
    };
    if (Array.isArray(tools) && tools.length > 0) {
      request.tools = tools;
      request.tool_choice = toolChoice;
    }
    return await client.chat.completions.create(request);
  } catch (error) {
    throw normalizeProviderError(error, providerId);
  }
}
