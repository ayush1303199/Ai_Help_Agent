"""Provider/model ownership checks backed by the shared public registry."""

import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse


def _registry_path() -> Path:
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        bundled_registry = bundle_root / "providerRegistry.json"
        if bundled_registry.exists():
            return bundled_registry
    return Path(__file__).resolve().parents[2] / "src" / "config" / "providerRegistry.json"


def load_provider_registry() -> Dict[str, Dict[str, Any]]:
    registry_path = _registry_path()
    try:
        data = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("The shared provider registry could not be loaded.") from error
    if not isinstance(data, dict):
        raise RuntimeError("The shared provider registry must contain an object.")
    valid_capabilities = {"chat", "toolCalling", "streaming", "vision", "structuredOutput", "stt"}
    valid_states = {"SUPPORTED", "UNSUPPORTED", "UNKNOWN"}
    for provider_id, provider in data.items():
        if not isinstance(provider, dict) or not isinstance(provider.get("models"), list):
            raise RuntimeError(f"Provider registry entry '{provider_id}' has an invalid model list.")
        model_ids = []
        for model in provider["models"]:
            if not isinstance(model, dict) or not isinstance(model.get("id"), str) or not model["id"].strip():
                raise RuntimeError(f"Provider registry entry '{provider_id}' contains an invalid model ID.")
            model_ids.append(model["id"])
            model_capabilities = model.get("capabilities", {})
            if not isinstance(model_capabilities, dict) or any(
                name not in valid_capabilities or state not in valid_states
                for name, state in model_capabilities.items()
            ):
                raise RuntimeError(f"Provider registry entry '{provider_id}' has invalid model capabilities.")
        if len(set(model_ids)) != len(model_ids):
            raise RuntimeError(f"Provider registry entry '{provider_id}' has duplicate model IDs.")
        capabilities = provider.get("capabilities", {})
        if not isinstance(capabilities, dict) or any(
            name not in valid_capabilities or state not in valid_states
            for name, state in capabilities.items()
        ):
            raise RuntimeError(f"Provider registry entry '{provider_id}' has invalid capabilities.")
        endpoint = provider.get("endpoint", {})
        if not isinstance(endpoint, dict) or any(
            key in endpoint and not isinstance(endpoint[key], bool)
            for key in ("required", "configurable")
        ):
            raise RuntimeError(f"Provider registry entry '{provider_id}' has invalid endpoint metadata.")
        authentication = provider.get("authentication")
        if not isinstance(authentication, dict) or authentication.get("type") not in {"apiKey", "oauth", "custom"}:
            raise RuntimeError(f"Provider registry entry '{provider_id}' has invalid authentication metadata.")
        if "customModelAllowed" in provider and not isinstance(provider["customModelAllowed"], bool):
            raise RuntimeError(f"Provider registry entry '{provider_id}' has invalid custom-model metadata.")
        default_model = provider.get("defaultModel") or ""
        if default_model and default_model not in model_ids:
            raise RuntimeError(f"Provider registry entry '{provider_id}' has an invalid default model.")
    return data


PROVIDER_REGISTRY = load_provider_registry()


class ProviderModelConfigurationError(ValueError):
    def __init__(self, details: Dict[str, str]):
        super().__init__(details["message"])
        self.details = details


def validate_custom_endpoint(endpoint: str) -> bool:
    parsed = urlparse(endpoint.strip())
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
    )


def provider_model_error(
    provider_id: str,
    model_id: str,
    endpoint: str = "",
) -> Optional[Dict[str, str]]:
    provider = PROVIDER_REGISTRY.get(provider_id)
    if provider is None:
        return {
            "code": "UNKNOWN_PROVIDER",
            "providerId": provider_id,
            "modelId": model_id,
            "message": "The selected provider is not registered.",
        }
    if not model_id.strip():
        return {
            "code": "MODEL_REQUIRED",
            "providerId": provider_id,
            "modelId": model_id,
            "message": "A model ID is required.",
        }
    if provider.get("customModelAllowed") and provider.get("adapter") != "openai-compatible":
        return {
            "code": "INVALID_PROVIDER_REGISTRY",
            "providerId": provider_id,
            "modelId": model_id,
            "message": "The custom-model provider must use an OpenAI-compatible adapter.",
        }
    if provider.get("customModelAllowed"):
        if provider.get("endpoint", {}).get("required", True) and not validate_custom_endpoint(endpoint):
            return {
                "code": "INVALID_CUSTOM_ENDPOINT",
                "providerId": provider_id,
                "modelId": model_id,
                "message": "Enter a valid HTTP(S) endpoint for this provider.",
            }
        return None

    supported_models = {
        model.get("id")
        for model in provider.get("models", [])
        if isinstance(model, dict) and isinstance(model.get("id"), str)
    }
    if model_id not in supported_models:
        return {
            "code": "MODEL_NOT_SUPPORTED_BY_PROVIDER",
            "providerId": provider_id,
            "modelId": model_id,
            "message": "The selected model is not supported by the selected provider.",
        }
    if provider.get("endpoint", {}).get("required", True) and not validate_custom_endpoint(endpoint):
        return {
            "code": "INVALID_PROVIDER_ENDPOINT",
            "providerId": provider_id,
            "modelId": model_id,
            "message": "Enter a valid HTTP(S) endpoint for this provider.",
        }
    return None


def provider_capability_states(provider_id: str, model_id: str = "") -> Dict[str, str]:
    """Resolve model capability overrides over provider defaults from the registry."""
    provider = PROVIDER_REGISTRY.get(provider_id)
    if not provider:
        return {
            name: "UNKNOWN"
            for name in ("chat", "toolCalling", "streaming", "vision", "structuredOutput", "stt")
        }
    states = {
        name: str(state)
        for name, state in provider.get("capabilities", {}).items()
    }
    model = next(
        (candidate for candidate in provider.get("models", []) if candidate.get("id") == model_id),
        None,
    )
    if model:
        states.update(model.get("capabilities", {}))
        if "toolCalling" not in model.get("capabilities", {}) and isinstance(model.get("supportsToolCalling"), bool):
            states["toolCalling"] = "SUPPORTED" if model["supportsToolCalling"] else "UNSUPPORTED"
    return {
        name: states.get(name, "UNKNOWN")
        for name in ("chat", "toolCalling", "streaming", "vision", "structuredOutput", "stt")
    }


def provider_model_is_valid(provider_id: str, model_id: str, endpoint: str = "") -> bool:
    return provider_model_error(provider_id, model_id, endpoint) is None


def require_valid_provider_model(provider_id: str, model_id: str, endpoint: str = "") -> None:
    error = provider_model_error(provider_id, model_id, endpoint)
    if error:
        raise ProviderModelConfigurationError(error)
