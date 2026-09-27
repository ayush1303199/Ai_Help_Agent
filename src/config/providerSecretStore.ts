const INSTANCE_SECRET_PREFIX = 'provider-instance:';

export function getProviderSecret(
  secrets: Record<string, string>,
  providerId: string,
  adapterType: string,
): string {
  return secrets[`${INSTANCE_SECRET_PREFIX}${providerId}`] || secrets[adapterType] || '';
}

export function setProviderSecret(
  secrets: Record<string, string>,
  providerId: string,
  adapterType: string,
  apiKey: string,
): Record<string, string> {
  const updated = {
    ...secrets,
    [`${INSTANCE_SECRET_PREFIX}${providerId}`]: apiKey,
  };
  delete updated[adapterType];
  return updated;
}

export function removeProviderSecret(
  secrets: Record<string, string>,
  providerId: string,
  adapterType: string,
): Record<string, string> {
  const updated = { ...secrets };
  delete updated[`${INSTANCE_SECRET_PREFIX}${providerId}`];
  delete updated[adapterType];
  return updated;
}
