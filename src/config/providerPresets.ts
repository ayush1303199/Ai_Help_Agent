export const providerPresets = {
  groq: { label: 'Groq', model: 'openai/gpt-oss-20b', baseURL: 'https://api.groq.com/openai/v1' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
  anthropic: { label: 'Claude (Anthropic)', model: 'claude-3-5-haiku-latest', baseURL: 'https://api.anthropic.com/v1' },
  deepseek: { label: 'DeepSeek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' },
  openrouter: { label: 'OpenRouter', model: 'openai/gpt-4o-mini', baseURL: 'https://openrouter.ai/api/v1' },
  llama: { label: 'Llama / Together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', baseURL: 'https://api.together.xyz/v1' },
  mistral: { label: 'Mistral', model: 'mistral-small-latest', baseURL: 'https://api.mistral.ai/v1' },
  gemini: { label: 'Gemini', model: 'gemini-3.6-flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  xai: { label: 'xAI Grok', model: 'grok-3-mini', baseURL: 'https://api.x.ai/v1' },
  perplexity: { label: 'Perplexity', model: 'sonar', baseURL: 'https://api.perplexity.ai' },
  fireworks: { label: 'Fireworks', model: 'accounts/fireworks/models/llama-v3p1-8b-instruct', baseURL: 'https://api.fireworks.ai/inference/v1' },
  cerebras: { label: 'Cerebras', model: 'llama-3.3-70b', baseURL: 'https://api.cerebras.ai/v1' },
  cohere: { label: 'Cohere', model: 'command-r7b-12-2024', baseURL: 'https://api.cohere.com/compatibility/v1' },
  custom: { label: 'Custom OpenAI-compatible', model: '', baseURL: '' },
} as const;

export type ProviderId = keyof typeof providerPresets;
