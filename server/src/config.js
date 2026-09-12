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
  if (config[provider]?.apiKey && !config[provider].apiKey.includes('your_')) config.runtimeProviders[provider] = config[provider];
}

export function setRuntimeProvider({ provider, apiKey, model, baseURL }) {
  if (!provider || !apiKey || !model) throw new Error('Provider, API key, and model are required.');
  const existing = config[provider] || config.custom;
  config[provider] = { ...existing, apiKey, model, baseURL: baseURL || existing?.baseURL || config.custom.baseURL };
  config.provider = provider;
  config.runtimeProviders[provider] = config[provider];
}

export function setFallbackEnabled(enabled) { config.fallbackEnabled = Boolean(enabled); }

export function setAgentPermissions(permissions) {
  config.agentPermissions = Object.fromEntries(Object.keys(config.agentPermissions).map((key) => [key, Boolean(permissions?.[key])]));
}

export function validateConfig() {
  const active = config[config.provider];
  if (!active?.apiKey || active.apiKey.includes('your_')) {
    throw new Error(`Missing API key for provider "${config.provider}". Set it in server/.env before starting the server.`);
  }
}
