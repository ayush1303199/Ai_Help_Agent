from typing import Dict

from provider_model_contract import PROVIDER_REGISTRY


PROVIDER_PRESETS: Dict[str, Dict[str, str]] = {
    "groq": {"label": "Groq", "model": "openai/gpt-oss-20b", "baseURL": "https://api.groq.com/openai/v1"},
    "openai": {"label": "OpenAI", "model": "gpt-4o-mini", "baseURL": "https://api.openai.com/v1"},
    "gemini": {
        "label": "Gemini",
        "model": str(PROVIDER_REGISTRY["gemini"]["defaultModel"]),
        "baseURL": str(PROVIDER_REGISTRY["gemini"]["baseURL"]),
    },
    "anthropic": {"label": "Anthropic", "model": "claude-3-5-haiku-latest", "baseURL": "https://api.anthropic.com/v1"},
    "cohere": {"label": "Cohere", "model": "command-r7b-12-2024", "baseURL": "https://api.cohere.com/compatibility/v1"},
    "deepseek": {"label": "DeepSeek", "model": "deepseek-chat", "baseURL": "https://api.deepseek.com/v1"},
    "openrouter": {"label": "OpenRouter", "model": "openai/gpt-4o-mini", "baseURL": "https://openrouter.ai/api/v1"},
    "mistral": {"label": "Mistral", "model": "mistral-small-latest", "baseURL": "https://api.mistral.ai/v1"},
    "xai": {"label": "xAI", "model": "grok-3-mini", "baseURL": "https://api.x.ai/v1"},
    "perplexity": {"label": "Perplexity", "model": "sonar", "baseURL": "https://api.perplexity.ai"},
}
