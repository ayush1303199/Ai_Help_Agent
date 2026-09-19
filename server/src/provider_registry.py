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
        self.active_provider_id: Optional[str] = None
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

                provider = ProviderInstance.from_dict(provider_data)
                if provider.id not in self.providers:
                    self.providers[provider.id] = provider

            self.active_provider_id = data.get("activeProvider")
            if self.active_provider_id and self.active_provider_id not in self.providers:
                self.active_provider_id = next(iter(self.providers.keys())) if self.providers else None
            self.fallback_enabled = data.get("fallbackEnabled", True)
        except Exception as e:
            print(f"Error loading provider config from {self.config_path}: {e}")

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
        """
        Remove duplicate providers.
        
        Duplicates detected by:
        - Same type + base URL + model
        
        Keep the one with the highest priority, or the first one if priorities match.
        """
        seen: Dict[str, str] = {}  # (type, base_url, model) -> provider_id
        duplicates: List[str] = []
        
        for provider_id, provider in sorted(
            self.providers.items(),
            key=lambda x: -x[1].priority  # Sort by priority desc (higher priority first)
        ):
            key = (provider.type.lower(), provider.base_url.lower(), provider.model.lower())
            key_str = f"{key[0]}:{key[1]}:{key[2]}"
            
            if key_str in seen:
                # This is a duplicate
                duplicates.append(provider_id)
            else:
                seen[key_str] = provider_id
        
        # Remove duplicates
        for dup_id in duplicates:
            print(f"Removing duplicate provider: {dup_id}")
            del self.providers[dup_id]
        
        # Update active provider if it was removed
        if self.active_provider_id and self.active_provider_id not in self.providers:
            self.active_provider_id = next(iter(self.providers.keys())) if self.providers else None

    def save_to_file(self) -> None:
        """Persist provider configuration to file."""
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
                "fallbackEnabled": self.fallback_enabled,
                "lastModifiedAt": datetime.now().isoformat(),
            }
            
            with open(self.config_path, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            print(f"Error saving provider config to {self.config_path}: {e}")

    def add_provider(
        self,
        provider_type: str,
        model: str,
        base_url: str,
        api_key: str,
        label: Optional[str] = None,
        priority: Optional[int] = None,
    ) -> ProviderInstance:
        """Add or update a provider."""
        # Check for existing provider with same type
        existing = self._find_provider_by_type(provider_type)

        if existing:
            # Update existing
            existing.model = model
            existing.base_url = base_url
            existing.has_api_key = bool(api_key)
            if api_key:
                self._runtime_api_keys[existing.id] = api_key
            existing.label = label or existing.label
            existing.enabled = True
            existing.status = ProviderStatus.CONFIGURED if api_key else ProviderStatus.UNCONFIGURED
            if self.active_provider_id is None:
                self.active_provider_id = existing.id
            return existing
        else:
            # Create new
            stable_id = self._generate_stable_id(provider_type, base_url)
            new_priority = priority or (max((p.priority for p in self.providers.values()), default=0) + 1)

            provider = ProviderInstance(
                provider_id=stable_id,
                provider_type=provider_type,
                model=model,
                base_url=base_url,
                has_api_key=bool(api_key),
                enabled=True,
                priority=new_priority,
                label=label or provider_type.capitalize(),
                status=ProviderStatus.CONFIGURED if api_key else ProviderStatus.UNCONFIGURED,
            )

            self.providers[provider.id] = provider
            if api_key:
                self._runtime_api_keys[provider.id] = api_key

            # Set as active if first provider
            if not self.active_provider_id:
                self.active_provider_id = provider.id

            return provider

    def update_provider_status(
        self,
        provider_id: str,
        status: ProviderStatus,
        failure_category: Optional[str] = None,
    ) -> Optional[ProviderInstance]:
        """Update provider status (e.g., after self-test or error)."""
        if provider_id not in self.providers:
            return None
        
        provider = self.providers[provider_id]
        provider.status = status
        provider.failure_category = failure_category
        provider.last_checked_at = datetime.now().isoformat()
        
        return provider

    def set_provider_enabled(self, provider_id: str, enabled: bool) -> Optional[ProviderInstance]:
        """Enable or disable a provider."""
        if provider_id not in self.providers:
            return None
        
        provider = self.providers[provider_id]
        provider.enabled = enabled
        
        return provider

    def delete_provider(self, provider_id: str) -> bool:
        """Remove a provider."""
        if provider_id not in self.providers:
            return False
        
        del self.providers[provider_id]
        self._runtime_api_keys.pop(provider_id, None)
        
        # Update active provider if deleted
        if self.active_provider_id == provider_id:
            self.active_provider_id = next(iter(self.providers.keys())) if self.providers else None
        
        return True

    def get_api_key(self, provider_id: str) -> str:
        """Return a provider secret held only in the current process."""
        return self._runtime_api_keys.get(provider_id, "")

    def get_provider(self, provider_id: str) -> Optional[ProviderInstance]:
        """Get a provider by ID."""
        return self.providers.get(provider_id)

    def get_all_providers(self) -> List[ProviderInstance]:
        """Get all providers sorted by priority."""
        return sorted(self.providers.values(), key=lambda p: p.priority)

    def get_active_provider(self) -> Optional[ProviderInstance]:
        """Get the currently active provider."""
        if self.active_provider_id and self.active_provider_id in self.providers:
            return self.providers[self.active_provider_id]
        
        # Fallback: get first enabled provider
        for provider in sorted(self.providers.values(), key=lambda p: p.priority):
            if provider.enabled:
                self.active_provider_id = provider.id
                return provider
        
        # Last resort: get first provider
        if self.providers:
            first = next(iter(self.providers.values()))
            self.active_provider_id = first.id
            return first
        
        return None

    def get_eligible_providers(self) -> List[ProviderInstance]:
        """
        Get providers eligible for use.
        
        Eligible = configured + enabled
        """
        return [
            p for p in self.get_all_providers()
            if p.has_api_key and p.enabled
        ]

    def set_active_provider(self, provider_id: str) -> bool:
        """Set the active provider."""
        if provider_id not in self.providers:
            return False
        
        self.active_provider_id = provider_id
        return True

    def reorder_providers(self, provider_ids: List[str]) -> bool:
        """Reorder providers by priority."""
        # Verify all IDs exist
        if not all(pid in self.providers for pid in provider_ids):
            return False
        
        for index, provider_id in enumerate(provider_ids):
            self.providers[provider_id].priority = index + 1
        
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
