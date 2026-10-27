const { defaultRegistry, PROVIDER_STATUSES, ISOLATION_LEVELS } = require('../isolationProviderRegistry.cjs');

let originalProvider = null;
let hasOriginal = false;

function registerMockDockerProvider(overrides = {}) {
  if (!hasOriginal) {
    originalProvider = defaultRegistry.providers.get('docker') || null;
    hasOriginal = true;
  }

  const mockProvider = Object.freeze({
    providerId: 'docker',
    version: 'mock-1.0',
    supportedPlatforms: ['win32', 'linux', 'darwin'],
    isolationLevel: ISOLATION_LEVELS.CONTAINER,
    availability: { isInstalled: true, isRunning: true, health: 'HEALTHY' },
    filesystemCapabilities: Object.freeze({
      ephemeralCopyOnWrite: true,
      readOnlyRoot: true,
      restrictedBindMounts: true,
      secureErasureOnExit: true,
    }),
    processCapabilities: Object.freeze({
      independentProcessTree: true,
      credentialIsolation: true,
      userNamespaceRemapping: true,
      hostObservedTermination: true,
    }),
    networkCapabilities: Object.freeze({
      defaultDenyAll: true,
      egressFiltering: true,
      isolatedNetworkNamespace: true,
    }),
    resourceLimits: Object.freeze({
      cpuThrottlingSupported: true,
      memoryCapSupported: true,
      outputBufferingCapped: true,
      timeoutEnforcementSupported: true,
    }),
    evidenceSource: 'synthetic-test',
    verificationTimestamp: new Date().toISOString(),
    capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
    isReady: true,
    blockingReasons: [],
    supportedOps: ['BUILD', 'TEST', 'START'],
    ...overrides,
  });

  defaultRegistry.providers.set('docker', mockProvider);
  return mockProvider;
}

function unregisterMockDockerProvider() {
  if (hasOriginal) {
    if (originalProvider) {
      defaultRegistry.providers.set('docker', originalProvider);
    } else {
      defaultRegistry.providers.delete('docker');
    }
    originalProvider = null;
    hasOriginal = false;
  }
}

module.exports = { registerMockDockerProvider, unregisterMockDockerProvider };
