import json
import os
from pathlib import Path
from typing import Any, Dict, Optional


def get_api_key(registry: Any, config_path: Path, provider_id: str) -> str:
    provider = registry.get_provider(provider_id)
    if not provider:
        return ""

    runtime_value = registry.get_api_key(provider_id)
    if runtime_value:
        return runtime_value

    env_value = os.getenv(f"{provider.type.upper()}_API_KEY", "").strip()
    if env_value:
        return env_value

    try:
        config_data = json.loads(config_path.read_text()) if config_path.exists() else {}
    except (OSError, json.JSONDecodeError):
        config_data = {}

    for entry in config_data.get("providers", []):
        if (
            str(entry.get("type") or entry.get("adapterType") or "").lower() == provider.type.lower()
            and str(entry.get("apiKey") or "").strip()
        ):
            return str(entry.get("apiKey") or "").strip()
    return ""


def provider_operation_capabilities(provider: Optional[Any]) -> Dict[str, bool]:
    provider_type = str(getattr(provider, "type", "") or "").lower()
    return {
        "chat": bool(provider),
        "toolCalling": bool(provider),
        "streaming": bool(provider),
        "stt": provider_type in {"openai", "groq"},
    }


def get_active_provider_with_api_key(registry: Any, config_path: Path) -> tuple[Optional[Any], str]:
    provider = registry.get_active_provider()
    if not provider:
        return None, ""
    return provider, get_api_key(registry, config_path, provider.id)


def get_stt_provider(registry: Any) -> Optional[Any]:
    configured = registry.get_provider(registry.stt_provider_id) if registry.stt_provider_id else None
    if configured and configured.enabled and provider_operation_capabilities(configured)["stt"]:
        return configured
    for provider in registry.get_all_providers():
        if provider.enabled and provider_operation_capabilities(provider)["stt"]:
            return provider
    return None
