import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from provider_model_contract import provider_capability_states


PROVIDER_ERROR_MAX_CHARS = 10_000


def _load_provider_error_patterns() -> tuple[Dict[str, Any], ...]:
    bundle_root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    patterns_path = bundle_root / "providerErrorPatterns.json"
    if not patterns_path.exists():
        patterns_path = Path(__file__).resolve().parents[2] / "src" / "config" / "providerErrorPatterns.json"
    try:
        patterns = json.loads(patterns_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("The shared provider error-classification table could not be loaded.") from error
    if not isinstance(patterns, list) or any(
        not isinstance(pattern, dict)
        or not isinstance(pattern.get("category"), str)
        or not isinstance(pattern.get("status_codes"), list)
        or not isinstance(pattern.get("keywords"), list)
        or not isinstance(pattern.get("reason"), str)
        for pattern in patterns
    ):
        raise RuntimeError("The shared provider error-classification table is invalid.")
    return tuple(patterns)


PROVIDER_ERROR_PATTERNS = _load_provider_error_patterns()


def redact_provider_error(
    value: Any,
    sensitive_values: tuple[str, ...] = (),
    max_chars: int = PROVIDER_ERROR_MAX_CHARS,
) -> str:
    """Redact common credential formats before diagnostics are stored or shown."""
    text = str(value or "")
    patterns = (
        (r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]"),
        (r"(?i)(x-goog-api-key|x-api-key|api[-_ ]?key|access[-_ ]?token|password|secret)\s*[:=]\s*[\"']?[^\"'\s,;}]+", r"\1=[REDACTED]"),
        (r"\bAIza[0-9A-Za-z_-]{20,}\b", "[REDACTED]"),
        (r"\bsk-[A-Za-z0-9_-]{16,}\b", "[REDACTED]"),
    )
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text)
    for secret in sensitive_values:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    if len(text) > max_chars:
        return f"{text[:max_chars]}\n[Diagnostic truncated after {max_chars} characters.]"
    return text


def classify_provider_error(
    status_code: Optional[int],
    raw_error: Any,
    sensitive_values: tuple[str, ...] = (),
) -> Dict[str, Any]:
    """Classify provider failures with an extensible, provider-neutral rule table."""
    safe_message = redact_provider_error(raw_error, sensitive_values)
    normalized = safe_message.lower()
    for pattern in PROVIDER_ERROR_PATTERNS:
        status_matches = status_code in pattern["status_codes"]
        keyword_matches = any(keyword in normalized for keyword in pattern["keywords"])
        if status_matches and keyword_matches:
            return {
                "category": pattern["category"],
                "reason": pattern["reason"],
                "statusCode": status_code,
                "rawMessage": safe_message,
            }
    if status_code is not None and status_code >= 500:
        return {
            "category": "PROVIDER_SERVICE_UNAVAILABLE",
            "reason": "The provider returned a server error. Check provider health and retry later.",
            "statusCode": status_code,
            "rawMessage": safe_message,
        }
    if "timeout" in normalized or "timed out" in normalized:
        return {
            "category": "PROVIDER_SERVICE_UNAVAILABLE",
            "reason": "The provider request timed out. Check network/provider health and retry later.",
            "statusCode": status_code,
            "rawMessage": safe_message,
        }
    return {
        "category": "UNKNOWN",
        "reason": safe_message or "The provider returned an error with no additional message.",
        "statusCode": status_code,
        "rawMessage": safe_message,
    }


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
    if not provider:
        return {"chat": False, "toolCalling": False, "streaming": False, "stt": False}
    capabilities = provider_capability_states(
        str(getattr(provider, "type", "") or "").lower(),
        str(getattr(provider, "model", "") or ""),
    )
    return {
        "chat": bool(provider) and capabilities["chat"] != "UNSUPPORTED",
        "toolCalling": capabilities["toolCalling"] == "SUPPORTED",
        "streaming": capabilities["streaming"] == "SUPPORTED",
        "stt": capabilities["stt"] == "SUPPORTED",
    }


def get_active_provider_with_api_key(registry: Any, config_path: Path) -> tuple[Optional[Any], str]:
    provider = registry.get_active_provider()
    if not provider:
        return None, ""
    return provider, get_api_key(registry, config_path, provider.id)


def get_stt_provider(
    registry: Any,
    resolve_api_key: Callable[[str], str],
) -> Optional[Any]:
    configured = registry.get_provider(registry.stt_provider_id) if registry.stt_provider_id else None
    if registry.stt_provider_id:
        if (
            configured
            and configured.enabled
            and provider_operation_capabilities(configured)["stt"]
            and resolve_api_key(configured.id)
        ):
            return configured
        return None
    gemini_fallback = None
    for provider in registry.get_all_providers():
        if (
            provider.enabled
            and provider_operation_capabilities(provider)["stt"]
            and resolve_api_key(provider.id)
        ):
            if provider.type.lower() != "gemini":
                return provider
            gemini_fallback = provider
    return gemini_fallback


def get_stt_provider_candidate(registry: Any) -> Optional[Any]:
    """Return the preferred enabled speech-capable provider, regardless of key state."""
    configured = registry.get_provider(registry.stt_provider_id) if registry.stt_provider_id else None
    if registry.stt_provider_id:
        return configured if (
            configured
            and configured.enabled
            and provider_operation_capabilities(configured)["stt"]
        ) else None

    gemini_fallback = None
    for provider in registry.get_all_providers():
        if provider.enabled and provider_operation_capabilities(provider)["stt"]:
            if provider.type.lower() != "gemini":
                return provider
            gemini_fallback = provider
    return gemini_fallback
