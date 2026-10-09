export interface PersistedProviderMetadata {
  id?: string;
  label: string;
  adapterType: string;
  model: string;
  baseURL?: string;
  enabled: boolean;
  priority: number;
  status?: string;
}

export interface PersistedProviderSettings {
  selectedProviderType: string | null;
  providers: PersistedProviderMetadata[];
}

export const PERSISTED_PROVIDER_STORAGE_KEY = 'ai-help-agent-provider-settings-v1';

import { writeAppState } from './appStateStorage';

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPersistedProviderSettings(storage = browserStorage()): PersistedProviderSettings {
  try {
    const raw = storage?.getItem(PERSISTED_PROVIDER_STORAGE_KEY);
    if (!raw) return { selectedProviderType: null, providers: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { selectedProviderType: null, providers: [] };
    const rows = Array.isArray(parsed.providers) ? parsed.providers : [];
    const providers = rows.flatMap((row: Record<string, unknown>) => {
      if (
        !row
        || typeof row.label !== 'string'
        || typeof row.adapterType !== 'string'
        || typeof row.model !== 'string'
        || typeof row.enabled !== 'boolean'
        || typeof row.priority !== 'number'
      ) return [];
      return [{
        ...(typeof row.id === 'string' ? { id: row.id } : {}),
        label: row.label,
        adapterType: row.adapterType,
        model: row.model,
        ...(typeof row.baseURL === 'string' ? { baseURL: row.baseURL } : {}),
        enabled: row.enabled,
        priority: row.priority,
        ...(typeof row.status === 'string' ? { status: row.status } : {}),
      }];
    });
    const selectedProviderType = typeof parsed.selectedProviderType === 'string'
      ? parsed.selectedProviderType
      : typeof parsed.activeProvider === 'string'
        ? parsed.activeProvider
        : null;
    return { selectedProviderType, providers };
  } catch {
    return { selectedProviderType: null, providers: [] };
  }
}

export function writePersistedProviderSettings(
  selectedProviderType: string | null,
  providers: PersistedProviderMetadata[],
  storage = browserStorage(),
): boolean {
  if (!storage) return false;
  const safeProviders = providers.map((provider) => ({
    ...(provider.id ? { id: provider.id } : {}),
    label: provider.label,
    adapterType: provider.adapterType,
    model: provider.model,
    baseURL: provider.baseURL || '',
    enabled: provider.enabled,
    priority: provider.priority,
    status: provider.status || 'unknown',
  }));
  try {
    writeAppState(
      PERSISTED_PROVIDER_STORAGE_KEY,
      JSON.stringify({ selectedProviderType, providers: safeProviders }),
      storage,
    );
    return true;
  } catch {
    return false;
  }
}
