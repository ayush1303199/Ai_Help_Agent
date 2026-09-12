import dotenv from 'dotenv';

dotenv.config();

/**
 * Centralised configuration loaded from environment variables.
 * Every secret lives in .env — nothing is hard-coded.
 */

export const config = {
  provider: process.env.LLM_PROVIDER || 'groq',
  fallbackEnabled: process.env.AI_AUTO_FALLBACK !== 'false',
  runtimeProviders: {},
  agentPermissions: {
    openTeams: false,
    openBrowser: false,
    openCamera: false,
    openChrome: false,
    openVSCode: false,
    openDesktop: false,
    openSourceTree: false,
    openSqlServer: false,
    openNotepad: false,
    openSublime: false,
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    baseURL: 'https://api.anthropic.com/v1',
  },

  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseURL: 'https://api.openai.com/v1',
  },

  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
    wsPort: parseInt(process.env.WS_PORT, 10) || 3002,
    maxPdfMb: parseInt(process.env.MAX_PDF_MB, 10) || 10,
    maxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 384,
  },
};

// Include any provider keys supplied through server/.env in the fallback pool.
for (const provider of ['groq', 'openai', 'anthropic', 'deepseek']) {
  if (config[provider]?.apiKey && !config[provider].apiKey.includes('your_')) {
    config.runtimeProviders[provider] = config[provider];
  }
}

export function setRuntimeProvider({ provider, apiKey, model, baseURL }) {
  if (!apiKey || !model) throw new Error('Provider API key and model are required.');
  config.provider = provider;
  config[provider] = {
    ...(config[provider] || {}),
    apiKey,
    model,
    baseURL: baseURL || config[provider]?.baseURL || 'https://api.openai.com/v1',
  };
  config.runtimeProviders[provider] = config[provider];
}

export function setFallbackEnabled(enabled) {
  config.fallbackEnabled = Boolean(enabled);
}

export function setAgentPermissions(permissions) {
  config.agentPermissions = {
    ...config.agentPermissions,
    openTeams: Boolean(permissions?.openTeams),
    openBrowser: Boolean(permissions?.openBrowser),
    openCamera: Boolean(permissions?.openCamera),
    openChrome: Boolean(permissions?.openChrome),
    openVSCode: Boolean(permissions?.openVSCode),
    openDesktop: Boolean(permissions?.openDesktop),
    openSourceTree: Boolean(permissions?.openSourceTree),
    openSqlServer: Boolean(permissions?.openSqlServer),
    openNotepad: Boolean(permissions?.openNotepad),
    openSublime: Boolean(permissions?.openSublime),
  };
}

/** Validate that the active provider has an API key set. */
export function validateConfig() {
  const active = config[config.provider];
  if (!active || !active.apiKey || active.apiKey.includes('your_')) {
    throw new Error(
      `Missing API key for provider "${config.provider}". ` +
      'Set it in server/.env before starting the server.'
    );
  }
}
