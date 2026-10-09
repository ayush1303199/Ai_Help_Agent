import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  getDefaultModel,
  getCapabilityState,
  getModelsForProvider,
  getProviderConfig,
  getProviderIds,
  getProviderModelValidationError,
  isValidCombination,
  isValidCustomProviderEndpoint,
  supportsToolCalling,
} from '../src/config/providerRegistry.helpers.ts';
import { providerRegistry, validateProviderRegistry } from '../src/config/providerRegistry.ts';
import {
  getProviderSecret,
  removeProviderSecret,
  setProviderSecret,
} from '../src/config/providerSecretStore.ts';
import {
  readPersistedProviderSettings,
  writePersistedProviderSettings,
} from '../src/config/providerPersistence.ts';
import { ProviderHydrationRequestError, retryProviderHydration } from '../src/config/providerHydration.ts';

const groqModels = getModelsForProvider('groq');
assert.deepEqual(
  groqModels.map((model) => model.id),
  ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
);
assert.ok(groqModels.every((model) => !model.id.startsWith('gemini-')));
assert.equal(getCapabilityState('groq', 'qwen/qwen3.8-27b', 'vision'), 'SUPPORTED');
assert.equal(getCapabilityState('groq', 'openai/gpt-oss-20b', 'vision'), 'UNKNOWN');
assert.deepEqual(
  getModelsForProvider('gemini').map((model) => model.id),
  ['gemini-3.6-flash'],
);
assert.equal(getDefaultModel('gemini'), 'gemini-3.6-flash');
assert.equal(
  getDefaultModel('gemini'),
  getModelsForProvider('gemini')[0].id,
  'the Gemini default must come from the shared model registry rather than a separate fallback list',
);
assert.equal(getProviderConfig('groq').displayName, 'Groq');
assert.equal(isValidCombination('groq', 'openai/gpt-oss-20b'), true);
assert.equal(isValidCombination('groq', 'gemini-1.5-pro'), false);
assert.equal(getProviderModelValidationError('groq', 'gemini-1.5-pro'), 'gemini-1.5-pro is not listed for Groq. Choose one of its supported models.');
assert.equal(isValidCombination('gemini', 'gemini-3.6-flash'), true);
assert.equal(isValidCombination('gemini', 'gemini-1.5-pro'), false);
assert.equal(getCapabilityState('gemini', 'gemini-1.5-pro', 'toolCalling'), 'UNKNOWN');
assert.equal(
  getProviderModelValidationError('gemini', 'gemini-1.5-pro'),
  'gemini-1.5-pro is not listed for Gemini. Choose one of its supported models.',
);
assert.equal(isValidCombination('gemini', 'gemini-1.5-flash'), false);
assert.equal(getCapabilityState('gemini', 'gemini-1.5-flash', 'toolCalling'), 'UNKNOWN');
assert.equal(
  getProviderModelValidationError('gemini', 'gemini-1.5-flash'),
  'gemini-1.5-flash is not listed for Gemini. Choose one of its supported models.',
);
assert.equal(supportsToolCalling('gemini', 'gemini-3.6-flash'), true);
assert.equal(supportsToolCalling('groq', 'openai/gpt-oss-20b'), true);
assert.equal(isValidCombination('custom', 'my-deployment'), true);
assert.equal(isValidCustomProviderEndpoint('https://ai.example.com/v1'), true);
assert.equal(isValidCustomProviderEndpoint('file:///tmp/key'), false);
assert.equal(isValidCustomProviderEndpoint('https://user:secret@ai.example.com'), false);

const legacySecrets = { gemini: 'legacy-key-value' };
assert.equal(getProviderSecret(legacySecrets, 'gemini-instance-1', 'gemini') === 'legacy-key-value', true);
const migratedSecrets = setProviderSecret(legacySecrets, 'gemini-instance-1', 'gemini', 'legacy-key-value');
assert.equal(getProviderSecret(migratedSecrets, 'gemini-instance-1', 'gemini') === 'legacy-key-value', true);
assert.equal(Object.hasOwn(migratedSecrets, 'gemini'), false, 'legacy adapter-keyed secret is migrated to one stable instance');
const removedInstanceSecrets = removeProviderSecret(migratedSecrets, 'gemini-instance-1', 'gemini');
assert.equal(Object.hasOwn(removedInstanceSecrets, 'provider-instance:gemini-instance-1'), false);
assert.equal(Object.hasOwn(removedInstanceSecrets, 'gemini'), false);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}
const storageBeforeRestart = new MemoryStorage();
assert.equal(writePersistedProviderSettings('gemini', [{
  id: 'gemini-instance-1',
  label: 'Primary Gemini',
  adapterType: 'gemini',
  model: 'gemini-3.6-flash',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  enabled: true,
  priority: 1,
}], storageBeforeRestart), true);
const storageAfterRestart = new MemoryStorage();
storageAfterRestart.values = new Map(storageBeforeRestart.values);
const restoredSettings = readPersistedProviderSettings(storageAfterRestart);
assert.equal(restoredSettings.providers[0].id, 'gemini-instance-1');
assert.equal(getProviderSecret(migratedSecrets, restoredSettings.providers[0].id, 'gemini'), 'legacy-key-value');
assert.doesNotMatch(storageAfterRestart.getItem('ai-help-agent-provider-settings-v1'), /legacy-key-value/);
assert.equal(storageAfterRestart.getItem('ai-help-agent-provider-secrets-v1'), null, 'provider credentials are never persisted in renderer storage');

let retryAttempts = 0;
const recoveredAfterTransientErrors = await retryProviderHydration(async () => {
  retryAttempts += 1;
  if (retryAttempts < 3) throw new TypeError('temporary backend connection failure');
  return 'restored';
}, { signal: new AbortController().signal, delaysMs: [0, 0] });
assert.equal(recoveredAfterTransientErrors, 'restored');
assert.equal(retryAttempts, 3, 'transient startup errors are retried with a bounded delay schedule');

retryAttempts = 0;
await assert.rejects(
  retryProviderHydration(async () => {
    retryAttempts += 1;
    throw new ProviderHydrationRequestError('Invalid saved provider configuration.', false);
  }, { signal: new AbortController().signal, delaysMs: [0, 0] }),
  /Invalid saved provider configuration/,
);
assert.equal(retryAttempts, 1, 'permanent provider errors are not retried');

const originalIds = getProviderIds();
providerRegistry.dummy = {
  displayName: 'Dummy Provider',
  baseURL: 'https://dummy.example/v1',
  adapter: 'openai-compatible',
  defaultModel: 'dummy-chat',
  authentication: { type: 'apiKey' },
  endpoint: { required: true, configurable: true },
  capabilities: { streaming: 'SUPPORTED' },
  models: [{ id: 'dummy-chat', displayName: 'Dummy Chat', supportsToolCalling: true }],
};
assert.ok(getProviderIds().includes('dummy'), 'provider button data is driven by registry keys');
assert.deepEqual(getModelsForProvider('dummy').map((model) => model.id), ['dummy-chat']);
assert.equal(getDefaultModel('dummy'), 'dummy-chat');
assert.equal(getCapabilityState('dummy', 'dummy-chat', 'toolCalling'), 'SUPPORTED');
assert.equal(getCapabilityState('dummy', 'dummy-chat', 'streaming'), 'SUPPORTED');
assert.equal(validateProviderRegistry(providerRegistry).length, 0);
delete providerRegistry.dummy;
assert.deepEqual(getProviderIds(), originalIds, 'temporary provider registry entry is removed after the proof');

const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const providersPanel = await fs.readFile(new URL('../src/ui/ConfiguredProvidersPanel.tsx', import.meta.url), 'utf8');
const codingTransportSource = await fs.readFile(new URL('../src/features/coding/codingTransport.ts', import.meta.url), 'utf8');
assert.match(appSource, /getProviderIds\(\)\.map/);
assert.match(appSource, /useState<ProviderId \| null>\(null\)/, 'new provider form starts without a provider');
assert.match(appSource, /const \[providerModel, setProviderModel\] = useState\(''\)/, 'new provider form starts without a model');
assert.match(appSource, /providerId \? getModelsForProvider\(providerId\) : \[\]/, 'model choices are scoped to the selected provider');
assert.doesNotMatch(appSource, /setProviderModel\(getDefaultModel\(value\)\)/, 'selecting a provider does not auto-select its default model');
assert.doesNotMatch(appSource, /setProviderId\(selectedProviderType as ProviderId\)/, 'saved or active providers do not leak into a new form');
assert.match(appSource, /setProviderModel\(''\);\s*setProviderModelIsCustom\(false\)/, 'switching providers clears the previous model');
assert.match(appSource, /setProviderModel\(provider\.model\)/, 'editing restores the saved model');
assert.match(appSource, /setProviderId\(null\);\s*setProviderKey\(''\);\s*setProviderModel\(''\)/, 'cancel and successful save reset the new-provider draft');
assert.match(appSource, /<option value="" disabled>\{providerId \? 'Select a model' : 'Select a provider first'\}<\/option>/);
assert.match(appSource, /disabled=\{!providerId \|\| providerSaving\}/, 'model selection is disabled until a provider is chosen');
assert.match(appSource, /writePersistedProviderSettings\(selectedProviderType, configuredProviders\.map/);
const persistenceEffectStart = appSource.indexOf('const selectedProviderType = configuredProviders.find');
const persistenceEffectEnd = appSource.indexOf('}, [activeProviderId, configuredProviders]);', persistenceEffectStart);
assert.notEqual(persistenceEffectStart, -1);
assert.notEqual(persistenceEffectEnd, -1);
assert.doesNotMatch(appSource.slice(persistenceEffectStart, persistenceEffectEnd), /providerId/, 'provider draft changes do not trigger settings persistence');
const chooseProviderStart = appSource.indexOf('const chooseProvider =');
const chooseProviderEnd = appSource.indexOf('\n  const providerModelChoices', chooseProviderStart);
const chooseProviderFlow = appSource.slice(chooseProviderStart, chooseProviderEnd);
assert.doesNotMatch(chooseProviderFlow, /writePersistedProviderSettings/);
assert.match(chooseProviderFlow, /setProviderKey\(''\)/, 'switching providers never reuses the prior API key');
const cancelProviderStart = appSource.indexOf('const cancelProviderEdit =');
const cancelProviderEnd = appSource.indexOf('\n  const setConfiguredActiveProvider', cancelProviderStart);
assert.doesNotMatch(appSource.slice(cancelProviderStart, cancelProviderEnd), /writePersistedProviderSettings/);
const saveProviderStart = appSource.indexOf('const saveConfiguredProvider =');
const saveProviderEnd = appSource.indexOf('\n  const editConfiguredProvider', saveProviderStart);
const saveProviderFlow = appSource.slice(saveProviderStart, saveProviderEnd);
assert.match(saveProviderFlow, /adapterType: providerId/);
assert.match(saveProviderFlow, /model: providerModel/);
assert.match(saveProviderFlow, /apiKey: providerKey/, 'existing-provider edits send a newly entered key to the save endpoint');
assert.match(saveProviderFlow, /providerKey\.trim\(\)\s*&&\s*data\.provider\?\.hasApiKey !== true/, 'a submitted key is not reported saved unless the backend confirms it');
assert.match(saveProviderFlow, /if \(!providerId\)/, 'save requires an explicit provider choice');
assert.doesNotMatch(saveProviderFlow, /getDefaultModel/);
const editProviderStart = appSource.indexOf('const editConfiguredProvider =');
const editProviderEnd = appSource.indexOf('\n  const cancelProviderEdit', editProviderStart);
assert.match(appSource.slice(editProviderStart, editProviderEnd), /setProviderId\(provider\.adapterType as ProviderId\)/);
assert.match(appSource.slice(editProviderStart, editProviderEnd), /setProviderModel\(provider\.model\)/);
assert.match(appSource, /setProviderKey\(''\)/);
assert.match(appSource, /isValidCustomProviderEndpoint\(providerBaseURL\)/);
assert.match(providersPanel, /getCapabilityState\(provider\.adapterType, provider\.model, capability\)/);
assert.match(providersPanel, /modelError &&/);
assert.match(providersPanel, /modelValidationError && <button onClick=\{\(\) => onEdit\(provider\)\}[^>]*>Choose model<\/button>/);
assert.doesNotMatch(providersPanel, /Repair model/, 'repairing an invalid model requires an explicit user selection');
assert.match(providersPanel, /TOOL CALLS/);
assert.match(providersPanel, /Self-test/);
assert.match(providersPanel, /Make active/);
assert.match(providersPanel, /Automatic — prefer OpenAI\/Groq, then Gemini/);
assert.match(providersPanel, /Gemini native audio transcription/);
assert.match(appSource, /is currently used for Meeting transcription/);
assert.match(appSource, /Meeting transcription will be unavailable until an eligible Groq, OpenAI, or Gemini provider is added/);
assert.match(appSource, /getProviderSecret\(persistedSecrets, String\(provider\.id \|\| ''\), adapterType\)/);
assert.match(appSource, /retryProviderHydration/);
assert.match(appSource, /providerHydrationPromiseRef\.current\) return providerHydrationPromiseRef\.current/, 'startup and Settings refresh share one hydration request');
assert.match(appSource, /providerHydrationPromiseRef\.current = null;\s*providerHydrationAbortControllerRef\.current = null;\s*controller\?\.abort\(\)/, 'unmount cleanup clears the single-flight before cancelling it, allowing React development remounts to retry');
assert.match(appSource, /signal,\s*\}\);/, 'credential restore requests are cancellable with the bounded startup retry');
assert.match(appSource, /providerId: provider\.id/);
assert.match(appSource, /createNew: true/);
assert.match(appSource, /onSetActive=/);
assert.match(appSource, /onSelfTest=/);
assert.match(appSource, /editingProvider \? 'Save changes' : 'Add provider'/);
const providerLoadStart = appSource.indexOf('const loadConfiguredProviders = useCallback');
const emptyProviderRestoreStart = appSource.indexOf('if (providers.length === 0)', providerLoadStart);
const providerRestoreEnd = appSource.indexOf('\n  }, []);', emptyProviderRestoreStart);
assert.notEqual(providerLoadStart, -1);
assert.notEqual(emptyProviderRestoreStart, -1);
assert.notEqual(providerRestoreEnd, -1);
const providerLoadBeforeEmptyRestore = appSource.slice(providerLoadStart, emptyProviderRestoreStart);
const emptyProviderRestore = appSource.slice(emptyProviderRestoreStart, providerRestoreEnd);
assert.match(providerLoadBeforeEmptyRestore, /const savedProviderSettings = readPersistedProviderSettings\(\)/);
assert.doesNotMatch(providerLoadBeforeEmptyRestore, /setProviderId|setProviderModel/);
const secretRehydrationStart = appSource.indexOf('// Rehydrate secrets into the backend process');
const secretRehydrationEnd = appSource.indexOf('\n    setConfiguredProviders(providers);', secretRehydrationStart);
assert.notEqual(secretRehydrationStart, -1);
assert.notEqual(secretRehydrationEnd, -1);
const secretRehydrationFlow = appSource.slice(secretRehydrationStart, secretRehydrationEnd);
assert.match(secretRehydrationFlow, /method: 'PATCH'/, 'secret rehydration does not rewrite provider configuration');
assert.match(secretRehydrationFlow, /\/api\/settings\/providers\/\$\{encodeURIComponent\(provider\.id\)\}/);
assert.match(secretRehydrationFlow, /body: JSON\.stringify\(\{ apiKey \}\)/);
assert.match(secretRehydrationFlow, /restoredProvider\?\.hasApiKey === true/, 'hydration succeeds only when the backend confirms the key is available');
assert.match(secretRehydrationFlow, /providers = hydratedData\.providers/, 'the provider UI state must use the backend response after the key is rehydrated');
assert.doesNotMatch(providerLoadBeforeEmptyRestore, /writePersistedProviderSettings\(/);
assert.match(emptyProviderRestore, /savedProviderSettings\.providers/);
assert.match(
  emptyProviderRestore,
  /if \(!adapterType \|\| !getProviderConfig\(adapterType\)\) return \[\]/,
  'saved provider metadata is restored even when its local credential is unavailable',
);
assert.doesNotMatch(
  emptyProviderRestore,
  /if \(!adapterType \|\| !apiKey \|\| !getProviderConfig\(adapterType\)\) return \[\]/,
  'a missing credential does not discard the configured provider entry',
);
assert.match(
  emptyProviderRestore,
  /savedProviderId && provider\.apiKey/,
  'empty credentials are not written into the local secret store during metadata recovery',
);
assert.match(emptyProviderRestore, /if \(restoredProviders\.length > 0\)/);
const providerFlowStart = appSource.indexOf('const saveConfiguredProvider');
const providerFlowEnd = appSource.indexOf('const saveAgentPermissions', providerFlowStart);
assert.notEqual(providerFlowStart, -1);
assert.notEqual(providerFlowEnd, -1);
assert.doesNotMatch(appSource.slice(providerFlowStart, providerFlowEnd), /beginDeveloperConversation|developer:conversation-start/);
assert.match(codingTransportSource, /beginDeveloperConversation/);

console.log('Shared provider registry, provider-specific choices, validation, and dynamic dummy-provider tests passed.');
