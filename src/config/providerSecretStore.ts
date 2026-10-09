const INSTANCE_SECRET_PREFIX = 'provider-instance:';
const LEGACY_SECRET_KEY = 'ai-help-agent-provider-secrets-v1';

export async function readProviderSecrets(): Promise<Record<string, string>> {
  const read = window.electronAPI?.readProviderSecrets;
  if (!read) throw new Error('Provider credentials can only be stored by the trusted desktop application.');
  const secured = await read();
  let legacyRaw: string | null;
  try {
    legacyRaw = localStorage.getItem(LEGACY_SECRET_KEY);
  } catch (error) {
    throw new Error('Legacy provider credentials could not be inspected for secure migration.', { cause: error });
  }
  if (!legacyRaw) return secured;

  let legacy: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(legacyRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some((value) => typeof value !== 'string')) {
      throw new Error('Unsupported secret data.');
    }
    legacy = parsed as Record<string, string>;
  } catch (error) {
    throw new Error('Legacy provider credentials could not be migrated safely.', { cause: error });
  }

  const migrated = { ...legacy, ...secured };
  await persistProviderSecrets(migrated);
  if (!window.confirm('Encrypted provider credentials are saved. Remove the exact plaintext local-storage entry ai-help-agent-provider-secrets-v1 now?')) {
    throw new Error('Plaintext provider credentials remain in local storage; migration is paused until their removal is confirmed.');
  }
  try {
    localStorage.removeItem(LEGACY_SECRET_KEY);
  } catch (error) {
    throw new Error('Encrypted credentials were saved, but the confirmed plaintext cleanup failed.', { cause: error });
  }
  return migrated;
}

export async function ensureProviderSecretStorage(): Promise<void> {
  const assertAvailable = window.electronAPI?.assertProviderSecretStorageAvailable;
  if (!assertAvailable || !(await assertAvailable())) {
    throw new Error('OS-backed secure provider credential storage is unavailable.');
  }
}

export async function persistProviderSecrets(secrets: Record<string, string>): Promise<void> {
  const write = window.electronAPI?.writeProviderSecrets;
  if (!write) throw new Error('Secure provider credential storage is unavailable in this environment.');
  await write(secrets);
}

export async function deleteProviderSecretStore(providerId: string, providerLabel: string): Promise<boolean> {
  const confirmDeletion = window.electronAPI?.confirmProviderDeletion;
  if (!confirmDeletion) throw new Error('Provider deletion requires the trusted desktop confirmation flow.');
  return confirmDeletion(providerId, providerLabel);
}

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
  if (![...Object.keys(updated)].some((key) => key.startsWith(INSTANCE_SECRET_PREFIX))) {
    delete updated[adapterType];
  }
  return updated;
}
