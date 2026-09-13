import dotenv from 'dotenv';

dotenv.config();

const env = (name, fallback) => process.env[name] || fallback;

/**
 * Provider settings are deliberately plain objects.  This makes them safe to
 * replace at runtime (the desktop client sends credentials without writing
 * them to disk) and keeps the provider layer independent of the UI.
 */
export const config = {
  provider: env('LLM_PROVIDER', 'groq'),
  fallbackEnabled: process.env.AI_AUTO_FALLBACK !== 'false',
  runtimeProviders: {},
  configuredProviders: [],
  agentPermissions: {
    openTeams: false, openBrowser: false, openCamera: false, openChrome: false,
    openVSCode: false, openDesktop: false, openSourceTree: false,
    openSqlServer: false, openNotepad: false, openSublime: false,
  },
  groq: { apiKey: process.env.GROQ_API_KEY, model: env('GROQ_MODEL', 'llama-3.3-70b-versatile'), baseURL: 'https://api.groq.com/openai/v1' },
  openai: { apiKey: process.env.OPENAI_API_KEY, model: env('OPENAI_MODEL', 'gpt-4o-mini'), baseURL: 'https://api.openai.com/v1' },
  deepseek: { apiKey: process.env.DEEPSEEK_API_KEY, model: env('DEEPSEEK_MODEL', 'deepseek-chat'), baseURL: 'https://api.deepseek.com/v1' },
  openrouter: { apiKey: process.env.OPENROUTER_API_KEY, model: env('OPENROUTER_MODEL', 'meta-llama/llama-3.1-8b-instruct'), baseURL: 'https://openrouter.ai/api/v1' },
  together: { apiKey: process.env.TOGETHER_API_KEY, model: env('TOGETHER_MODEL', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'), baseURL: 'https://api.together.xyz/v1' },
  llama: { apiKey: process.env.TOGETHER_API_KEY, model: env('LLAMA_MODEL', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'), baseURL: 'https://api.together.xyz/v1' },
  mistral: { apiKey: process.env.MISTRAL_API_KEY, model: env('MISTRAL_MODEL', 'mistral-small-latest'), baseURL: 'https://api.mistral.ai/v1' },
  xai: { apiKey: process.env.XAI_API_KEY, model: env('XAI_MODEL', 'grok-2-latest'), baseURL: 'https://api.x.ai/v1' },
  perplexity: { apiKey: process.env.PERPLEXITY_API_KEY, model: env('PERPLEXITY_MODEL', 'sonar'), baseURL: 'https://api.perplexity.ai' },
  fireworks: { apiKey: process.env.FIREWORKS_API_KEY, model: env('FIREWORKS_MODEL', 'accounts/fireworks/models/llama-v3p1-8b-instruct'), baseURL: 'https://api.fireworks.ai/inference/v1' },
  cerebras: { apiKey: process.env.CEREBRAS_API_KEY, model: env('CEREBRAS_MODEL', 'llama-3.3-70b'), baseURL: 'https://api.cerebras.ai/v1' },
  custom: { apiKey: process.env.CUSTOM_OPENAI_API_KEY, model: env('CUSTOM_OPENAI_MODEL', 'gpt-4o-mini'), baseURL: env('CUSTOM_OPENAI_BASE_URL', 'https://api.openai.com/v1') },
  'custom-openai': { apiKey: process.env.CUSTOM_OPENAI_API_KEY, model: env('CUSTOM_OPENAI_MODEL', 'gpt-4o-mini'), baseURL: env('CUSTOM_OPENAI_BASE_URL', 'https://api.openai.com/v1') },
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY, model: env('ANTHROPIC_MODEL', 'claude-3-5-haiku-latest'), baseURL: 'https://api.anthropic.com/v1' },
  gemini: { apiKey: process.env.GEMINI_API_KEY, model: env('GEMINI_MODEL', 'gemini-2.0-flash'), baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  cohere: { apiKey: process.env.COHERE_API_KEY, model: env('COHERE_MODEL', 'command-r-plus'), baseURL: 'https://api.cohere.com/v2' },
  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
    wsPort: parseInt(process.env.WS_PORT, 10) || 3002,
    maxPdfMb: parseInt(process.env.MAX_PDF_MB, 10) || 10,
    maxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 384,
  },
};

const providerNames = Object.keys(config).filter((key) => key !== 'server' && key !== 'runtimeProviders' && key !== 'agentPermissions' && key !== 'provider' && key !== 'fallbackEnabled');
for (const provider of providerNames) {
  if (config[provider]?.apiKey && !config[provider].apiKey.includes('your_')) {
    config.runtimeProviders[provider] = config[provider];
    config.configuredProviders.push({
      id: `env-${provider}`,
      label: provider,
      adapterType: provider,
      apiKey: config[provider].apiKey,
      model: config[provider].model,
      baseURL: config[provider].baseURL,
      enabled: provider === config.provider,
      priority: config.configuredProviders.length + 1,
      status: 'unknown',
    });
  }
}

export function setRuntimeProvider({ provider, apiKey, model, baseURL }) {
  if (!provider || !apiKey || !model) throw new Error('Provider, API key, and model are required.');
  const existing = config[provider] || config.custom;
  config[provider] = { ...existing, apiKey, model, baseURL: baseURL || existing?.baseURL || config.custom.baseURL };
  config.provider = provider;
  config.runtimeProviders[provider] = config[provider];
  const configured = config.configuredProviders.find((item) => item.adapterType === provider);
  if (configured) {
    Object.assign(configured, { apiKey, model, baseURL: config[provider].baseURL, enabled: true, status: 'unknown' });
  } else {
    config.configuredProviders.push({
      id: `runtime-${provider}-${Date.now()}`,
      label: provider,
      adapterType: provider,
      apiKey,
      model,
      baseURL: config[provider].baseURL,
      enabled: true,
      priority: config.configuredProviders.length + 1,
      status: 'unknown',
    });
  }
}

export function setFallbackEnabled(enabled) { config.fallbackEnabled = Boolean(enabled); }

export function getConfiguredProviders() {
  return config.configuredProviders
    .map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: Boolean(apiKey) }))
    .sort((a, b) => a.priority - b.priority);
}

export function upsertConfiguredProvider(input) {
  const adapterType = String(input.adapterType || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  const model = String(input.model || '').trim();
  if (!adapterType || !apiKey || !model) throw new Error('Adapter type, API key, and model are required.');
  if (!config[adapterType]) throw new Error(`Unsupported provider adapter "${adapterType}".`);
  const id = String(input.id || `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const provider = {
    id,
    label: String(input.label || adapterType).trim(),
    adapterType,
    apiKey,
    model,
    baseURL: String(input.baseURL || config[adapterType].baseURL || '').trim(),
    enabled: input.enabled !== false,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : config.configuredProviders.length + 1,
    status: input.status || 'unknown',
  };
  const index = config.configuredProviders.findIndex((item) => item.id === id);
  if (index >= 0) config.configuredProviders[index] = provider;
  else config.configuredProviders.push(provider);
  config[adapterType] = { apiKey, model, baseURL: provider.baseURL };
  config.runtimeProviders[adapterType] = config[adapterType];
  normalizeProviderPriorities();
  return provider;
}

export function removeConfiguredProvider(id) {
  config.configuredProviders = config.configuredProviders.filter((provider) => provider.id !== id);
  normalizeProviderPriorities();
}

export function updateConfiguredProvider(id, changes) {
  const current = config.configuredProviders.find((provider) => provider.id === id);
  if (!current) throw new Error('Configured provider not found.');
  return upsertConfiguredProvider({ ...current, ...changes, id, apiKey: changes.apiKey || current.apiKey });
}

export function reorderConfiguredProviders(ids) {
  const order = new Map(ids.map((id, index) => [id, index + 1]));
  for (const provider of config.configuredProviders) {
    if (order.has(provider.id)) provider.priority = order.get(provider.id);
  }
  normalizeProviderPriorities();
}

export function normalizeProviderPriorities() {
  config.configuredProviders
    .sort((a, b) => a.priority - b.priority)
    .forEach((provider, index) => { provider.priority = index + 1; });
}

export function setConfiguredProviderStatus(id, status, lastError = '') {
  const provider = config.configuredProviders.find((item) => item.id === id);
  if (provider) {
    provider.status = status;
    provider.lastError = lastError;
    provider.lastCheckedAt = Date.now();
  }
}

export function setAgentPermissions(permissions) {
  config.agentPermissions = Object.fromEntries(Object.keys(config.agentPermissions).map((key) => [key, Boolean(permissions?.[key])]));
}

export function validateConfig() {
  const active = config[config.provider];
  if (!active?.apiKey || active.apiKey.includes('your_')) {
    throw new Error(`Missing API key for provider "${config.provider}". Set it in server/.env before starting the server.`);
  }
}
