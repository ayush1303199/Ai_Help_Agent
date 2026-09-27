"""Provider adapter owned exclusively by the Coding Agent pipeline."""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from openai import OpenAI
from provider_model_contract import ProviderModelConfigurationError, provider_model_error
from backend_config import CODING_COMPLETION_TOKENS, MODEL_REQUEST_TIMEOUT_SECONDS


OPENAI_COMPATIBLE = {
    "groq", "openai", "deepseek", "openrouter", "together", "llama",
    "mistral", "xai", "perplexity", "fireworks", "cerebras", "custom",
    "custom-openai",
}
CODING_MAX_COMPLETION_TOKENS = CODING_COMPLETION_TOKENS


def _api_key(registry: Any, provider: Any, config_path: Path) -> str:
    runtime_key = registry.get_api_key(provider.id)
    if runtime_key:
        return runtime_key
    environment_key = os.getenv(f"{provider.type.upper()}_API_KEY", "").strip()
    if environment_key:
        return environment_key
    try:
        config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    except (OSError, json.JSONDecodeError):
        config = {}
    for entry in config.get("providers", []):
        if (
            str(entry.get("type") or entry.get("adapterType") or "").lower() == provider.type.lower()
            and str(entry.get("apiKey") or "").strip()
        ):
            return str(entry["apiKey"]).strip()
    return ""


def _candidates(registry: Any, provider_id: Optional[str] = None) -> List[Any]:
    result = []
    if provider_id:
        requested = registry.get_provider(provider_id)
        if not requested:
            raise RuntimeError("The selected Coding Agent provider is no longer configured.")
        if not requested.enabled:
            raise RuntimeError("The selected Coding Agent provider is disabled.")
        configuration_error = provider_model_error(requested.type, requested.model, requested.base_url)
        if configuration_error:
            raise ProviderModelConfigurationError(configuration_error)
        return [requested]
    active = registry.get_active_provider()
    if active:
        configuration_error = provider_model_error(active.type, active.model, active.base_url)
        if configuration_error:
            raise ProviderModelConfigurationError(configuration_error)
        result.append(active)
    result.extend(
        provider for provider in registry.get_eligible_providers()
        if provider.id not in {item.id for item in result}
    )
    return result


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "".join(
            item if isinstance(item, str) else str(item.get("text") or item.get("content") or "")
            for item in content if isinstance(item, (str, dict))
        ).strip()
    return ""


def _normalize(message: Dict[str, Any]) -> Dict[str, Any]:
    if _text(message.get("content")) or message.get("tool_calls"):
        return message
    for field in ("output_text", "text"):
        value = _text(message.get(field))
        if value:
            return {**message, "content": value}
    return message


def _openai_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            key: value for key, value in item.items()
            if key in {"role", "content", "name", "tool_call_id", "tool_calls"}
        }
        for item in messages
    ]


def _anthropic_request(
    provider: Any, api_key: str, messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
) -> Dict[str, Any]:
    system_parts = []
    converted = []
    for item in messages:
        role = str(item.get("role") or "")
        content = _text(item.get("content"))
        if role == "system":
            if content:
                system_parts.append(content)
        elif role == "tool":
            converted.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": str(item.get("tool_call_id") or ""),
                    "content": content,
                }],
            })
        elif role == "assistant" and item.get("tool_calls"):
            blocks = [{"type": "text", "text": content}] if content else []
            for call in item["tool_calls"]:
                function = call.get("function") or {}
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                blocks.append({
                    "type": "tool_use",
                    "id": str(call.get("id") or ""),
                    "name": str(function.get("name") or ""),
                    "input": arguments,
                })
            converted.append({"role": "assistant", "content": blocks})
        else:
            converted.append({"role": "assistant" if role == "assistant" else "user", "content": content})
    body: Dict[str, Any] = {"model": provider.model, "max_tokens": CODING_MAX_COMPLETION_TOKENS, "messages": converted}
    if system_parts:
        body["system"] = "\n\n".join(system_parts)
    if tools:
        body["tools"] = [{
            "name": (tool.get("function") or {}).get("name"),
            "description": (tool.get("function") or {}).get("description") or "",
            "input_schema": (tool.get("function") or {}).get("parameters") or {"type": "object", "properties": {}},
        } for tool in tools]
    response = httpx.post(
        f"{provider.base_url.rstrip('/')}/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json=body,
        timeout=MODEL_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    text_parts = []
    tool_calls = []
    for block in payload.get("content") or []:
        if block.get("type") == "text":
            text_parts.append(str(block.get("text") or ""))
        elif block.get("type") == "tool_use":
            tool_calls.append({
                "id": str(block.get("id") or ""),
                "type": "function",
                "function": {"name": str(block.get("name") or ""), "arguments": json.dumps(block.get("input") or {})},
            })
    return {"role": "assistant", "content": "".join(text_parts) or None, **({"tool_calls": tool_calls} if tool_calls else {})}


def _gemini_request(
    provider: Any, api_key: str, messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]],
) -> Dict[str, Any]:
    system = []
    contents = []
    tool_names = {}

    def append(role: str, part: Dict[str, Any]) -> None:
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].append(part)
        else:
            contents.append({"role": role, "parts": [part]})

    for item in messages:
        role = str(item.get("role") or "")
        if role == "system":
            system.append(_text(item.get("content")))
        elif role in {"user", "developer"}:
            append("user", {"text": _text(item.get("content"))})
        elif role == "assistant":
            if _text(item.get("content")):
                append("model", {"text": _text(item.get("content"))})
            for call in item.get("tool_calls") or []:
                function = call.get("function") or {}
                call_id = str(call.get("id") or f"coding-gemini-{len(tool_names) + 1}")
                name = str(function.get("name") or "")
                tool_names[call_id] = name
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                function_part = {"functionCall": {"name": name, "args": arguments}}
                thought_signature = call.get("thought_signature") or call.get("thoughtSignature")
                if isinstance(thought_signature, str) and thought_signature:
                    function_part["thoughtSignature"] = thought_signature
                append("model", function_part)
        elif role == "tool":
            call_id = str(item.get("tool_call_id") or "")
            name = str(item.get("name") or tool_names.get(call_id) or "")
            try:
                result = json.loads(item.get("content") or "{}")
            except (TypeError, json.JSONDecodeError):
                result = {"text": _text(item.get("content"))}
            if not isinstance(result, dict):
                result = {"value": result}
            append("user", {"functionResponse": {"name": name, "response": result}})
    body: Dict[str, Any] = {"contents": contents}
    system_text = "\n\n".join(part for part in system if part)
    if system_text:
        body["systemInstruction"] = {"parts": [{"text": system_text}]}
    if tools:
        def sanitize_schema(schema: Any) -> Any:
            if isinstance(schema, list):
                return [sanitize_schema(item) for item in schema]
            if not isinstance(schema, dict):
                return schema
            return {
                key: sanitize_schema(value)
                for key, value in schema.items()
                if key not in {"additionalProperties", "$schema"}
            }

        body["tools"] = [{
            "functionDeclarations": [{
                "name": (tool.get("function") or {}).get("name"),
                "description": (tool.get("function") or {}).get("description") or "",
                "parameters": sanitize_schema(
                    (tool.get("function") or {}).get("parameters") or {"type": "object", "properties": {}}
                ),
            } for tool in tools]
        }]
    response = httpx.post(
        f"{provider.base_url.rstrip('/')}/models/{provider.model}:generateContent",
        headers={"x-goog-api-key": api_key, "content-type": "application/json"},
        json=body,
        timeout=MODEL_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    text_parts = []
    tool_calls = []
    parts = (payload.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    for index, part in enumerate(parts):
        if part.get("text"):
            text_parts.append(str(part["text"]))
        function = part.get("functionCall") or {}
        if function.get("name"):
            tool_call = {
                "id": str(function.get("id") or f"coding-gemini-{index + 1}"),
                "type": "function",
                "function": {"name": str(function["name"]), "arguments": json.dumps(function.get("args") or {})},
            }
            thought_signature = part.get("thoughtSignature")
            if isinstance(thought_signature, str) and thought_signature:
                tool_call["thought_signature"] = thought_signature
            tool_calls.append(tool_call)
    return {"role": "assistant", "content": "".join(text_parts) or None, **({"tool_calls": tool_calls} if tool_calls else {})}


def complete_coding_model(
    registry: Any,
    config_path: Path,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    provider_id: Optional[str] = None,
) -> tuple[Dict[str, Any], Any]:
    """Run Coding-only provider selection and response adaptation."""
    candidates = _candidates(registry, provider_id)
    if not candidates:
        raise RuntimeError("No provider is configured for the Coding Agent.")
    errors = []
    for provider in candidates:
        api_key = _api_key(registry, provider, config_path)
        if not api_key or not provider.model:
            continue
        try:
            provider_type = str(provider.type or "").lower()
            if provider_type == "cohere" and tools:
                raise RuntimeError("The configured Cohere model cannot run Coding Agent read tools.")
            if provider_type == "anthropic":
                message = _anthropic_request(provider, api_key, messages, tools)
            elif provider_type == "gemini" and not provider.base_url.rstrip("/").endswith("/openai"):
                message = _gemini_request(provider, api_key, messages, tools)
            elif provider_type in OPENAI_COMPATIBLE or provider_type == "gemini":
                response = OpenAI(api_key=api_key, base_url=provider.base_url or None).chat.completions.create(
                    model=provider.model,
                    messages=_openai_messages(messages),
                    tools=tools or None,
                    temperature=0.2,
                    max_tokens=CODING_MAX_COMPLETION_TOKENS,
                )
                raw = response.choices[0].message.model_dump(exclude_none=True) if response.choices else {}
                message = _normalize(raw)
            else:
                raise RuntimeError(f"No Coding Agent adapter is available for provider '{provider_type}'.")
            if _text(message.get("content")) or message.get("tool_calls"):
                return message, provider
            raise RuntimeError("The Coding Agent provider returned neither text nor a tool call.")
        except Exception as error:
            errors.append(f"{provider.type}: {str(error)[:240]}")
    raise RuntimeError("Coding Agent provider request failed. " + " | ".join(errors))
