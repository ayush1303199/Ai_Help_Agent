// Add a provider by adding one top-level entry to providerRegistry.json.
// Add models by adding one entry to that provider's models array.
// Each model needs id, displayName, and supportsToolCalling.
// Keep defaultModel equal to a listed model ID, or empty for custom providers.
// New provider adapters also need backend adapter support.
import providerRegistryData from './providerRegistry.json' with { type: 'json' };

export interface ModelConfig {
  id: string;
  displayName: string;
  supportsToolCalling?: boolean;
  capabilities?: Partial<Record<CapabilityName, CapabilityState>>;
}

export type CapabilityName = 'chat' | 'toolCalling' | 'streaming' | 'vision' | 'structuredOutput' | 'stt';
export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';

export interface ProviderConfig {
  displayName: string;
  baseURL: string;
  adapter: string;
  defaultModel: string;
  models: ModelConfig[];
  showInUI?: boolean;
  capabilities?: Partial<Record<CapabilityName, CapabilityState>>;
  authentication: { type: 'apiKey' | 'oauth' | 'custom' };
  endpoint: { required: boolean; configurable: boolean };
  customModelAllowed?: boolean;
}

export const providerRegistry = providerRegistryData as Record<string, ProviderConfig>;

export function validateProviderRegistry(
  registry: Record<string, ProviderConfig>,
): string[] {
  const errors: string[] = [];
  for (const [providerId, provider] of Object.entries(registry)) {
    if (!providerId.trim()) errors.push('Provider IDs cannot be empty.');
    if (
      !provider
      || typeof provider.displayName !== 'string'
      || typeof provider.baseURL !== 'string'
      || typeof provider.adapter !== 'string'
      || !Array.isArray(provider.models)
    ) {
      errors.push(`${providerId}: provider metadata is incomplete.`);
      continue;
    }
    const validModels = provider.models.filter((model): model is ModelConfig => Boolean(
      model && typeof model.id === 'string' && typeof model.displayName === 'string',
    ));
    if (validModels.length !== provider.models.length) errors.push(`${providerId}: each model needs an ID and display name.`);
    const modelIds = validModels.map((model) => model.id);
    if (modelIds.some((id) => !id.trim())) errors.push(`${providerId}: model IDs cannot be empty.`);
    if (new Set(modelIds).size !== modelIds.length) errors.push(`${providerId}: model IDs must be unique.`);
    if (validModels.some((model) => !model.displayName)) errors.push(`${providerId}: model display names cannot be empty.`);
    if (provider.defaultModel && !provider.models.some((model) => model.id === provider.defaultModel)) {
      errors.push(`${providerId}: defaultModel must match a model in models.`);
    }
    for (const [name, state] of Object.entries(provider.capabilities ?? {})) {
      if (!['chat', 'toolCalling', 'streaming', 'vision', 'structuredOutput', 'stt'].includes(name)
        || !['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN'].includes(String(state))) {
        errors.push(`${providerId}: capability '${name}' has an invalid state.`);
      }
    }
    for (const model of validModels) {
      for (const [name, state] of Object.entries(model.capabilities ?? {})) {
        if (!['chat', 'toolCalling', 'streaming', 'vision', 'structuredOutput', 'stt'].includes(name)
          || !['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN'].includes(String(state))) {
          errors.push(`${providerId}/${model.id}: capability '${name}' has an invalid state.`);
        }
      }
    }
    if (provider.authentication && !['apiKey', 'oauth', 'custom'].includes(provider.authentication.type)) {
      errors.push(`${providerId}: authentication type is invalid.`);
    }
    if (provider.endpoint && (
      typeof provider.endpoint.required !== 'boolean'
      || typeof provider.endpoint.configurable !== 'boolean'
    )) {
      errors.push(`${providerId}: endpoint metadata is invalid.`);
    }
    if (provider.customModelAllowed !== undefined && typeof provider.customModelAllowed !== 'boolean') {
      errors.push(`${providerId}: customModelAllowed must be a boolean.`);
    }
  }
  return errors;
}

const registryErrors = validateProviderRegistry(providerRegistry);
if (registryErrors.length > 0) {
  throw new Error(`Invalid provider registry: ${registryErrors.join(' ')}`);
}

export type ProviderId = keyof typeof providerRegistry;
