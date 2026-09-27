import {
  providerRegistry,
  type ModelConfig,
  type ProviderConfig,
} from './providerRegistry.ts';

export type { ProviderId } from './providerRegistry.ts';

export function getProviderIds(): string[] {
  return Object.keys(providerRegistry).filter((providerId) => (
    getProviderConfig(providerId)?.showInUI !== false
  ));
}

export function getProviderConfig(providerId: string): ProviderConfig | undefined {
  return providerRegistry[providerId as keyof typeof providerRegistry];
}

export function getModelsForProvider(providerId: string): ModelConfig[] {
  return getProviderConfig(providerId)?.models ?? [];
}

export function getDefaultModel(providerId: string): string {
  return getProviderConfig(providerId)?.defaultModel ?? '';
}

export function allowsCustomModel(providerId: string): boolean {
  return getProviderConfig(providerId)?.customModelAllowed === true;
}

export function isProviderEndpointConfigurable(providerId: string): boolean {
  return getProviderConfig(providerId)?.endpoint?.configurable !== false;
}

export function isProviderEndpointRequired(providerId: string): boolean {
  const provider = getProviderConfig(providerId);
  return provider?.endpoint?.required ?? Boolean(provider);
}

export function isValidCombination(providerId: string, modelId: string): boolean {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return false;
  if (allowsCustomModel(providerId)) return true;
  return getModelsForProvider(providerId).some((model) => model.id === normalizedModelId);
}

export type ToolCallingCapability = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';
export type CapabilityName = 'chat' | 'toolCalling' | 'streaming' | 'vision' | 'structuredOutput' | 'stt';

export function getCapabilityState(
  providerId: string,
  modelId: string,
  capability: CapabilityName,
): ToolCallingCapability {
  const provider = getProviderConfig(providerId);
  if (!provider) return 'UNKNOWN';
  const model = getModelsForProvider(providerId).find((candidate) => candidate.id === modelId.trim());
  if (!model && !allowsCustomModel(providerId)) return 'UNKNOWN';
  if (model?.capabilities?.[capability]) return model.capabilities[capability]!;
  if (capability === 'toolCalling' && model?.supportsToolCalling !== undefined) {
    return model.supportsToolCalling ? 'SUPPORTED' : 'UNSUPPORTED';
  }
  return provider.capabilities?.[capability] ?? 'UNKNOWN';
}

export function getToolCallingCapability(providerId: string, modelId: string): ToolCallingCapability {
  if (!modelId.trim()) return 'UNKNOWN';
  return getCapabilityState(providerId, modelId, 'toolCalling');
}

export function supportsToolCalling(providerId: string, modelId: string): boolean {
  return getToolCallingCapability(providerId, modelId) === 'SUPPORTED';
}

export function isValidCustomProviderEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && Boolean(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function getProviderModelValidationError(providerId: string, modelId: string): string | null {
  return getProviderModelValidation(providerId, modelId)?.message ?? null;
}

export function getProviderModelValidation(providerId: string, modelId: string): {
  code: string;
  providerId: string;
  modelId: string;
  message: string;
} | null {
  const normalizedModelId = modelId.trim();
  if (!getProviderConfig(providerId)) {
    return {
      code: 'UNKNOWN_PROVIDER',
      providerId,
      modelId: normalizedModelId,
      message: `Provider '${providerId}' is not registered.`,
    };
  }
  if (!normalizedModelId) {
    return {
      code: 'MODEL_REQUIRED',
      providerId,
      modelId: normalizedModelId,
      message: 'Model ID is required.',
    };
  }
  if (isValidCombination(providerId, normalizedModelId)) return null;

  const provider = getProviderConfig(providerId);
  const displayName = provider?.displayName ?? providerId;
  const modelOwner = Object.entries(providerRegistry).find(([candidateId, candidate]) => (
    candidateId !== providerId && candidate.models.some((model) => model.id === normalizedModelId)
  ));
  if (modelOwner) {
    return {
      code: 'MODEL_NOT_SUPPORTED_BY_PROVIDER',
      providerId,
      modelId: normalizedModelId,
      message: `${normalizedModelId} is registered for ${modelOwner[1].displayName}, not the ${displayName} provider.`,
    };
  }
  return {
    code: provider ? 'MODEL_NOT_SUPPORTED_BY_PROVIDER' : 'UNKNOWN_PROVIDER',
    providerId,
    modelId: normalizedModelId,
    message: `${normalizedModelId} is not listed for ${displayName}. Choose one of its supported models.`,
  };
}
