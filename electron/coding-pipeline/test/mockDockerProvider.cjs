const { defaultRegistry, PROVIDER_STATUSES, ISOLATION_LEVELS } = require('../isolationProviderRegistry.cjs');

function registerMockDockerProvider() {
  // Avoid duplicate registration during repeated test runs
  if (defaultRegistry.getProvider('docker')) return;
  defaultRegistry.registerProvider({
    providerId: 'docker',
    version: 'mock-1.0',
    supportedPlatforms: ['win32', 'linux', 'darwin'],
    isolationLevel: ISOLATION_LEVELS.CONTAINER,
    availability: { isInstalled: true, isRunning: true, health: 'HEALTHY' },
    filesystemCapabilities: { /* minimal true flags */
      ephemeralCopyOnWrite: true,
      readOnlyRoot: true,
      restrictedBindMounts: true,
      secureErasureOnExit: true,
    },
    processCapabilities: {
      independentProcessTree: true,
      credentialIsolation: true,
      userNamespaceRemapping: true,
      hostObservedTermination: true,
    },
    networkCapabilities: {
      defaultDenyAll: true,
      egressFiltering: true,
      isolatedNetworkNamespace: true,
    },
    resourceLimits: {
      cpuThrottlingSupported: true,
      memoryCapSupported: true,
      outputBufferingCapped: true,
      timeoutEnforcementSupported: true,
    },
    evidenceSource: 'synthetic-test',
    verificationTimestamp: new Date().toISOString(),
    capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
    isReady: true,
    supportedOps: ['BUILD', 'TEST', 'START'],
  });
}

module.exports = { registerMockDockerProvider };