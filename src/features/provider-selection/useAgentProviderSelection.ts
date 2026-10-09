import { useEffect, useState } from 'react';
import { clearAppState, writeAppState } from '../../config/appStateStorage';

export interface AgentProviderOption {
  id: string;
  label: string;
  model: string;
  enabled: boolean;
  hasApiKey?: boolean;
  status?: string;
}

const storageKey = (agentId: string) => `ai-help-agent-provider-selection:${agentId}`;

export function useAgentProviderSelection(
  agentId: string,
  providers: AgentProviderOption[],
  onStorageError?: (message: string) => void,
) {
  const [savedProviderId, setSavedProviderId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey(agentId));
    } catch {
      return null;
    }
  });
  const providerId = providers.some((provider) => provider.enabled && provider.hasApiKey && provider.id === savedProviderId)
    ? savedProviderId
    : null;

  useEffect(() => {
    try {
      if (providerId) writeAppState(storageKey(agentId), providerId);
      else if (providers.length || !savedProviderId) clearAppState(storageKey(agentId));
    } catch {
      onStorageError?.(`The ${agentId} provider preference could not be saved in browser storage.`);
    }
  }, [agentId, onStorageError, providerId, providers.length, savedProviderId]);

  return {
    providerId,
    setProviderId: setSavedProviderId,
  };
}
