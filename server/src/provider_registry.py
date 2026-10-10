"""
Provider Configuration Registry

Centralized provider lifecycle management with persistence, deduplication,
and stable provider identity across restarts.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Literal
from datetime import datetime
from enum import Enum
import hashlib
import uuid
import re
import os
from provider_secret_vault import ProviderSecretVault
from provider_service import classify_provider_error, redact_provider_error
from provider_model_contract import (
    PROVIDER_REGISTRY,
    ProviderModelConfigurationError,
    provider_model_error,
    provider_model_is_valid,
)


class ProviderStatus(str, Enum):
    """Provider operational status."""
    UNCONFIGURED = "UNCONFIGURED"           # No API key or model
    CONFIGURED = "CONFIGURED"               # API key + model present
    ENABLED = "ENABLED"                     # Configured + enabled=true
    READY = "READY"                         # Healthy after last self-test
    CHECKING = "CHECKING"                   # Self-test in progress
    RATE_LIMITED = "RATE_LIMITED"           # Quota exhausted
    REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE" # Request exceeded provider limits
    AUTH_FAILED = "AUTH_FAILED"             # Invalid API key
    NETWORK_ERROR = "NETWORK_ERROR"         # Connection issue
    CAPACITY_ERROR = "CAPACITY_ERROR"       # Provider capacity exceeded
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE" # Requested model not available
    SELF_TEST_FAILED = "SELF_TEST_FAILED"   # Self-test failure
    CONFIGURATION_INVALID = "CONFIGURATION_INVALID" # Provider/model pair needs repair


class RegistryState(str, Enum):
    """Registry initialization state."""
    LOADING = "LOADING"
    READY = "READY"
    ERROR = "ERROR"


class ProviderInstance:
    """Represents a single provider configuration with metadata."""
    
    def __init__(
        self,
        provider_id: str,
        provider_type: str,
        model: str,
        base_url: str,
        enabled: bool = True,
        priority: int = 1,
        has_api_key: bool = False,
        status: ProviderStatus = ProviderStatus.UNCONFIGURED,
        label: str = "",
        last_checked_at: Optional[str] = None,
        failure_category: Optional[str] = None,
        failure_diagnostic: Optional[Dict[str, Any]] = None,
    ):
        self.id = provider_id
        self.type = provider_type
        self.model = model
        self.base_url = base_url
        self.enabled = enabled
        self.priority = priority
        self.has_api_key = has_api_key
        self.status = status if isinstance(status, ProviderStatus) else ProviderStatus(status)
        self.label = label or provider_type.capitalize()
        self.last_checked_at = last_checked_at
        self.failure_category = failure_category
        self.failure_diagnostic = dict(failure_diagnostic) if failure_diagnostic else None
        self.configuration_error: Optional[Dict[str, str]] = None

    def to_dict(self, include_api_key: bool = False) -> Dict[str, Any]:
        """Serialize to dict. Never includes actual API key."""
        result = {
            "id": self.id,
            "type": self.type,
            "adapterType": self.type,
            "label": self.label,
            "model": self.model,
            "baseURL": self.base_url,
            "enabled": self.enabled,
            "priority": self.priority,
            "hasApiKey": self.has_api_key,
            "status": self.status.value,
            "lastCheckedAt": self.last_checked_at,
        }
        if self.failure_category:
            result["failureCategory"] = self.failure_category
        if self.failure_diagnostic:
            result["failureCategory"] = self.failure_diagnostic["category"]
            result["failureDetails"] = dict(self.failure_diagnostic)
        elif self.status == ProviderStatus.UNCONFIGURED and not self.has_api_key:
            result["failureCategory"] = "INVALID_OR_MISSING_KEY"
            result["failureDetails"] = {
                "category": "INVALID_OR_MISSING_KEY",
                "statusCode": None,
                "reason": "No API key is available to this backend process. Re-enter and save the provider key.",
                "rawMessage": "",
            }
        result["configurationValid"] = self.configuration_error is None
        if self.configuration_error:
            result["configurationError"] = dict(self.configuration_error)
        return result

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "ProviderInstance":
        """Deserialize from dict."""
        return ProviderInstance(
            provider_id=data["id"],
            provider_type=data["type"],
            model=data["model"],
            base_url=data.get("baseURL", ""),
            enabled=data.get("enabled", True),
            priority=data.get("priority", 1),
            has_api_key=data.get("hasApiKey", False),
            status=ProviderStatus(data.get("status", "UNCONFIGURED")),
            label=data.get("label", data["type"].capitalize()),
            last_checked_at=data.get("lastCheckedAt"),
            failure_category=data.get("failureCategory"),
            failure_diagnostic=data.get("failureDetails"),
        )


class ProviderRegistry:
    """
    Centralized provider configuration registry.
    
    Responsibilities:
    - Load provider configuration from persistent storage
    - Save provider configuration changes
    - Normalize and deduplicate provider instances
    - Generate stable provider IDs
    - Track provider status across runtime
    - Provide authoritative provider state to all consumers
    """
    
    def __init__(self, config_path: Optional[str] = None):
        self.config_path = Path(config_path or Path.home() / ".ai-help-agent" / "provider-config.json")
        self.providers: Dict[str, ProviderInstance] = {}
        # Secrets are available to the running process only. They are never
        # serialized by ProviderInstance.to_dict() or save_to_file().
        self._runtime_api_keys: Dict[str, str] = {}
        self._persistent_api_keys: Dict[str, str] = {}
        self._secret_vault = ProviderSecretVault(
            self.config_path.with_name("provider-secrets.enc.json")
        )
        self.active_provider_id: Optional[str] = None
        self.stt_provider_id: Optional[str] = None
        self.fallback_enabled: bool = True
        self.state = RegistryState.LOADING
        self.error: Optional[str] = None
        
    def initialize(self, env_vars: Dict[str, str], provider_presets: Dict[str, Dict[str, str]]) -> None:
        """
        Initialize registry from persistent storage and environment variables.
        
        Priority:
        1. Load from persistent file if exists
        2. Merge with environment variables (env vars take precedence)
        3. Deduplicate and normalize
        """
        try:
            # Step 1: Load from persistent storage
            self._load_from_file()
            self._load_secrets_from_file()
            
            # Step 2: Merge environment variables (env vars override file)
            self._merge_env_providers(env_vars, provider_presets)
            
            # Step 3: Deduplicate
            self._deduplicate()
            
            # Step 4: Ensure at least one provider enabled
            if not any(p.enabled for p in self.providers.values()):
                if self.providers:
                    first_enabled = next(iter(self.providers.values()))
                    first_enabled.enabled = True
                    if not self.active_provider_id:
                        self.active_provider_id = first_enabled.id

            active = self.providers.get(self.active_provider_id or "")
            if (
                not active
                or not active.enabled
                or not provider_model_is_valid(active.type, active.model, active.base_url)
            ):
                self.active_provider_id = self._next_active_provider_id()
            
            self.state = RegistryState.READY
        except Exception as e:
            self.state = RegistryState.ERROR
            self.error = str(e)
            print(f"Provider registry initialization error: {e}")

    def _load_from_file(self) -> None:
        """Load provider configuration from persistent file."""
        if not self.config_path.exists():
            return

        try:
            with open(self.config_path, 'r') as f:
                data = json.load(f)

            providers_data = data.get("providers", [])
            migrated_gemini_models = False

            for provider_data in providers_data:
                if "adapterType" in provider_data and "type" not in provider_data:
                    provider_data["type"] = provider_data["adapterType"]

                if "type" not in provider_data and "provider" in provider_data:
                    provider_data["type"] = provider_data["provider"]

                if "apiKey" in provider_data:
                    api_key = str(provider_data.get("apiKey") or "").strip()
                    if api_key:
                        provider_data["hasApiKey"] = True
                    del provider_data["apiKey"]

                old_status = provider_data.get("status", "UNCONFIGURED")
                if old_status == "error":
                    provider_data["status"] = ProviderStatus.SELF_TEST_FAILED.value
                elif old_status == "unknown":
                    provider_data["status"] = ProviderStatus.CONFIGURED.value
                elif old_status not in [s.value for s in ProviderStatus]:
                    provider_data["status"] = ProviderStatus.CONFIGURED.value

                provider_data["hasApiKey"] = bool(provider_data.get("hasApiKey", False))
                provider_type = str(provider_data.get("type") or "").lower()
                configured_model = str(provider_data.get("model") or "")
                if (
                    provider_type == "gemini"
                    and configured_model
                    and not provider_model_is_valid(provider_type, configured_model)
                ):
                    provider_data["model"] = str(PROVIDER_REGISTRY["gemini"]["defaultModel"])
                    if provider_data.get("status") == ProviderStatus.CONFIGURATION_INVALID.value:
                        provider_data["status"] = (
                            ProviderStatus.CONFIGURED.value
                            if provider_data["hasApiKey"]
                            else ProviderStatus.UNCONFIGURED.value
                        )
                    for field in ("configurationError", "failureCategory", "failureDetails"):
                        provider_data.pop(field, None)
                    migrated_gemini_models = True

                provider = ProviderInstance.from_dict(provider_data)
                configuration_error = provider_model_error(
                    provider.type,
                    provider.model,
                    provider.base_url,
                )
                if configuration_error:
                    provider.configuration_error = configuration_error
                    provider.status = ProviderStatus.CONFIGURATION_INVALID
                    provider.failure_category = configuration_error["code"]
                    print(json.dumps({
                        "event": "provider_configuration_invalid",
                        "providerId": provider.type,
                        "modelId": provider.model,
                        "errorCode": configuration_error["code"],
                        "instanceId": provider.id,
                    }))
                if provider.id not in self.providers:
                    self.providers[provider.id] = provider

            self.active_provider_id = data.get("activeProvider")
            if self.active_provider_id and self.active_provider_id not in self.providers:
                active = self.providers.get(self.active_provider_id or "")
                if not active or not active.enabled or not provider_model_is_valid(active.type, active.model, active.base_url):
                    self.active_provider_id = self._next_active_provider_id()
            self.fallback_enabled = data.get("fallbackEnabled", True)
            self.stt_provider_id = data.get("sttProvider")
            if migrated_gemini_models:
                self.save_to_file()
        except Exception as e:
            print(f"Error loading provider config from {self.config_path}: {e}")

    def _load_secrets_from_file(self) -> None:
        saved_secrets = self._secret_vault.load()
        for provider_id, api_key in saved_secrets.items():
            provider = self.providers.get(provider_id)
            if not provider:
                continue
            self._persistent_api_keys[provider_id] = api_key
            self._runtime_api_keys[provider_id] = api_key
            provider.has_api_key = True
            if provider.status == ProviderStatus.UNCONFIGURED:
                provider.status = ProviderStatus.CONFIGURED

    def assert_secret_store_available(self) -> None:
        self._secret_vault.assert_available()

    def supports_persistent_secret_store(self) -> bool:
        return self._secret_vault.is_supported()

    def save_secrets_to_file(self) -> None:
        self._secret_vault.save(self._persistent_api_keys)

    def _merge_env_providers(self, env_vars: Dict[str, str], provider_presets: Dict[str, Dict[str, str]]) -> None:
        """Merge environment variable providers into registry."""
        for preset_name, preset_info in provider_presets.items():
            api_key_env = f"{preset_name.upper()}_API_KEY"
            if api_key_env not in env_vars:
                continue

            api_key = env_vars[api_key_env]

            # Check if this provider already exists
            existing = self._find_provider_by_type(preset_name)

            if existing:
                # Update existing provider from env vars
                existing.has_api_key = bool(api_key)
                if api_key:
                    self._runtime_api_keys[existing.id] = api_key
                existing.model = preset_info.get("model", existing.model)
                existing.base_url = preset_info.get("baseURL", existing.base_url)
                existing.label = preset_info.get("label", existing.label)
                existing.enabled = True
                if api_key:
                    existing.status = ProviderStatus.CONFIGURED
            else:
                # Create new provider from env vars
                stable_id = self._generate_stable_id(preset_name, preset_info.get("baseURL", ""))
                provider = ProviderInstance(
                    provider_id=stable_id,
                    provider_type=preset_name,
                    model=preset_info.get("model", ""),
                    base_url=preset_info.get("baseURL", ""),
                    has_api_key=bool(api_key),
                    enabled=True,
                    priority=len(self.providers) + 1,
                    label=preset_info.get("label", preset_name.capitalize()),
                    status=ProviderStatus.CONFIGURED if api_key else ProviderStatus.UNCONFIGURED,
                )
                self.providers[provider.id] = provider
                if api_key:
                    self._runtime_api_keys[provider.id] = api_key

                # Set as active if this is first provider
                if not self.active_provider_id:
                    self.active_provider_id = provider.id

    def _find_provider_by_type(self, provider_type: str) -> Optional[ProviderInstance]:
        """Find provider instance by type name."""
        for provider in self.providers.values():
            if provider.type.lower() == provider_type.lower():
                return provider
        return None

    def _generate_stable_id(self, provider_type: str, base_url: str) -> str:
        """
        Generate deterministic stable ID for a provider.
        
        Format: {type}:{hash(baseurl)}
        This ensures the same provider always has the same ID across restarts,
        but different base URLs get different IDs.
        """
        url_hash = hashlib.md5(base_url.encode()).hexdigest()[:8]
        return f"{provider_type.lower()}-{url_hash}"

    def _deduplicate(self) -> None:
        """Normalize ordering without collapsing distinct provider instances."""
        self.normalize_priorities()
        if self.active_provider_id and self.active_provider_id not in self.providers:
            self.active_provider_id = self._next_active_provider_id()

    def normalize_priorities(self) -> None:
        """Keep provider order deterministic and priorities contiguous."""
        ordered = sorted(self.providers.values(), key=lambda p: (p.priority, p.id))
        for index, provider in enumerate(ordered, start=1):
            provider.priority = index

    def save_to_file(self) -> None:
        """Persist provider configuration to file."""
        temporary_path = self.config_path.with_suffix(f"{self.config_path.suffix}.{uuid.uuid4().hex}.tmp")
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            
            data = {
                "version": 1,
                "providers": [
                    provider.to_dict() for provider in sorted(
                        self.providers.values(),
                        key=lambda p: p.priority
                    )
                ],
                "activeProvider": self.active_provider_id,
                "sttProvider": self.stt_provider_id,
                "fallbackEnabled": self.fallback_enabled,
                "lastModifiedAt": datetime.now().isoformat(),
            }
            
            with open(temporary_path, 'w', encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary_path, self.config_path)
        except Exception as e:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise RuntimeError(f"Error saving provider config to {self.config_path}.") from e

    def add_provider(
        self,
        provider_type: str,
        model: str,
        base_url: str,
        api_key: str,
        label: Optional[str] = None,
        priority: Optional[int] = None,
        provider_id: Optional[str] = None,
        create_new: bool = False,
        enabled: Optional[bool] = None,
    ) -> ProviderInstance:
        """Add a provider instance, or update the instance identified by provider_id."""
        configuration_error = provider_model_error(provider_type, model, base_url)
        if configuration_error:
            raise ProviderModelConfigurationError(configuration_error)
        if priority is not None and priority < 1:
            raise ValueError("Provider priority must be positive.")

        existing = self.providers.get(provider_id or "")
        if provider_id and not existing and not create_new:
            raise ValueError("Provider instance not found.")
        if not provider_id and not create_new:
            existing = self._find_provider_by_type(provider_type)

        if existing:
            if existing.type.lower() != provider_type.lower():
                raise ValueError("A provider instance cannot change its adapter type.")
            existing.model = model
            existing.base_url = base_url
            existing.has_api_key = bool(api_key) or bool(self._runtime_api_keys.get(existing.id))
            if api_key:
                self._runtime_api_keys[existing.id] = api_key
                self._persistent_api_keys[existing.id] = api_key
            existing.label = label or existing.label
            if enabled is not None:
                existing.enabled = enabled
            existing.status = ProviderStatus.CONFIGURED if existing.has_api_key else ProviderStatus.UNCONFIGURED
            existing.configuration_error = None
            existing.failure_category = None
            existing.failure_diagnostic = None
            if existing.enabled and self.active_provider_id is None:
                self.active_provider_id = existing.id
            return existing

        # New UI-created instances need unique IDs even when adapter, endpoint,
        # model, and label match another configured instance.
        stable_id = provider_id or f"{provider_type.lower()}-{uuid.uuid4().hex}"
        if stable_id in self.providers:
            raise ValueError("Provider instance ID is already in use.")
        new_priority = priority or (max((p.priority for p in self.providers.values()), default=0) + 1)

        provider = ProviderInstance(
            provider_id=stable_id,
            provider_type=provider_type,
            model=model,
            base_url=base_url,
            has_api_key=bool(api_key),
            enabled=True if enabled is None else enabled,
            priority=new_priority,
            label=label or provider_type.capitalize(),
            status=ProviderStatus.CONFIGURED if api_key else ProviderStatus.UNCONFIGURED,
        )
        self.providers[provider.id] = provider
        if api_key:
            self._runtime_api_keys[provider.id] = api_key
            self._persistent_api_keys[provider.id] = api_key
        if not self.active_provider_id and provider.enabled:
            self.active_provider_id = provider.id
        self.normalize_priorities()
        return provider

    def update_provider_status(
        self,
        provider_id: str,
        status: ProviderStatus,
        failure_category: Optional[str] = None,
        failure_diagnostic: Optional[Dict[str, Any]] = None,
    ) -> Optional[ProviderInstance]:
        """Update provider status (e.g., after self-test or error)."""
        if provider_id not in self.providers:
            return None
        
        provider = self.providers[provider_id]
        provider.status = status
        if failure_diagnostic and status not in {
            ProviderStatus.READY,
            ProviderStatus.CONFIGURED,
            ProviderStatus.ENABLED,
            ProviderStatus.CHECKING,
            ProviderStatus.UNCONFIGURED,
        }:
            diagnostic = dict(failure_diagnostic)
            diagnostic["rawMessage"] = redact_provider_error(
                diagnostic.get("rawMessage", ""),
                tuple(filter(None, (
                    self._runtime_api_keys.get(provider_id, ""),
                    os.getenv(f"{provider.type.upper()}_API_KEY", "").strip(),
                ))),
            )
            provider.failure_diagnostic = diagnostic
            provider.failure_category = str(diagnostic.get("category") or failure_category or "UNKNOWN")
        elif failure_category and status not in {
            ProviderStatus.READY,
            ProviderStatus.CONFIGURED,
            ProviderStatus.ENABLED,
            ProviderStatus.CHECKING,
            ProviderStatus.UNCONFIGURED,
        }:
            status_match = re.search(r"\bHTTP\s+(\d{3})\b", failure_category, re.IGNORECASE)
            status_code = int(status_match.group(1)) if status_match else None
            secret_values = tuple(filter(None, (
                self._runtime_api_keys.get(provider_id, ""),
                os.getenv(f"{provider.type.upper()}_API_KEY", "").strip(),
            )))
            diagnostic = classify_provider_error(status_code, failure_category, secret_values)
            provider.failure_diagnostic = diagnostic
            provider.failure_category = diagnostic["category"]
        else:
            provider.failure_category = failure_category
            if status in {
                ProviderStatus.READY,
                ProviderStatus.CONFIGURED,
                ProviderStatus.ENABLED,
                ProviderStatus.UNCONFIGURED,
            }:
                provider.failure_diagnostic = None
        provider.last_checked_at = datetime.now().isoformat()
        
        return provider

    def set_provider_enabled(self, provider_id: str, enabled: bool) -> Optional[ProviderInstance]:
        """Enable or disable a provider."""
        if provider_id not in self.providers:
            return None
        
        provider = self.providers[provider_id]
        provider.enabled = enabled
        if not enabled and self.active_provider_id == provider_id:
            self.active_provider_id = self._next_active_provider_id()
        elif (
            enabled
            and self.active_provider_id not in self.providers
            and provider_model_is_valid(provider.type, provider.model, provider.base_url)
        ):
            self.active_provider_id = provider_id
        
        return provider

    def delete_provider(self, provider_id: str) -> bool:
        """Remove a provider."""
        if provider_id not in self.providers:
            return False
        
        del self.providers[provider_id]
        self._runtime_api_keys.pop(provider_id, None)
        self._persistent_api_keys.pop(provider_id, None)
        self.normalize_priorities()
        if self.stt_provider_id == provider_id:
            self.stt_provider_id = None
        
        if self.active_provider_id == provider_id or self.active_provider_id not in self.providers:
            self.active_provider_id = self._next_active_provider_id()
        
        return True

    def get_api_key(self, provider_id: str) -> str:
        """Return a provider secret held only in the current process."""
        return self._runtime_api_keys.get(provider_id, "")

    def set_api_key(self, provider_id: str, api_key: str) -> bool:
        """Update an instance's in-memory credential without persisting it."""
        provider = self.providers.get(provider_id)
        if not provider:
            return False
        key = api_key.strip()
        if not key:
            return False
        self._runtime_api_keys[provider_id] = key
        self._persistent_api_keys[provider_id] = key
        provider.has_api_key = True
        if provider.configuration_error:
            provider.status = ProviderStatus.CONFIGURATION_INVALID
            provider.failure_category = provider.configuration_error["code"]
        else:
            provider.status = ProviderStatus.CONFIGURED
            provider.failure_category = None
        provider.failure_diagnostic = None
        return True

    def get_provider(self, provider_id: str) -> Optional[ProviderInstance]:
        """Get a provider by ID."""
        return self.providers.get(provider_id)

    def get_all_providers(self) -> List[ProviderInstance]:
        """Get all providers sorted by priority."""
        return sorted(self.providers.values(), key=lambda p: p.priority)

    def get_active_provider(self) -> Optional[ProviderInstance]:
        """Return the selected provider, switching away from disabled or invalid entries."""
        selected = self.providers.get(self.active_provider_id or "")
        if selected and selected.enabled and provider_model_is_valid(selected.type, selected.model, selected.base_url):
            return selected

        self.active_provider_id = self._next_active_provider_id()
        return self.providers.get(self.active_provider_id or "")

    def _next_active_provider_id(self) -> Optional[str]:
        """Choose the highest-priority eligible provider, independent of insertion order."""
        eligible = self.get_eligible_providers()
        if eligible:
            return eligible[0].id

        configured = [
            provider for provider in self.get_all_providers()
            if provider.enabled and provider_model_is_valid(provider.type, provider.model, provider.base_url)
        ]
        return configured[0].id if configured else None

    def get_eligible_providers(self) -> List[ProviderInstance]:
        """
        Get providers eligible for use.
        
        Eligible = configured + enabled
        """
        return [
            p for p in self.get_all_providers()
            if p.has_api_key and p.enabled and provider_model_is_valid(p.type, p.model, p.base_url)
        ]

    def set_active_provider(self, provider_id: str) -> bool:
        """Select only enabled, valid provider instances."""
        provider = self.providers.get(provider_id)
        if (
            not provider
            or not provider.enabled
            or not provider_model_is_valid(provider.type, provider.model, provider.base_url)
        ):
            return False
        
        self.active_provider_id = provider_id
        return True

    def reorder_providers(self, provider_ids: List[str]) -> bool:
        """Reorder providers by priority."""
        if (
            len(provider_ids) != len(self.providers)
            or len(set(provider_ids)) != len(provider_ids)
            or set(provider_ids) != set(self.providers)
        ):
            return False
        
        for index, provider_id in enumerate(provider_ids):
            self.providers[provider_id].priority = index + 1

        self.active_provider_id = self._next_active_provider_id()
        
        return True

    def to_dict(self, include_secrets: bool = False) -> Dict[str, Any]:
        """Serialize registry state for API response."""
        return {
            "providers": [p.to_dict(include_api_key=include_secrets) for p in self.get_all_providers()],
            "activeProvider": self.active_provider_id,
            "fallbackEnabled": self.fallback_enabled,
            "registryState": self.state.value,
            "error": self.error,
        }
