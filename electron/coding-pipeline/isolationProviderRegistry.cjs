/**
 * AI Help Agent - Isolation Provider Registry (V9)
 *
 * Maintains provider capability descriptions, discovery metadata, and health status
 * using a generic schema. Enforces that discovery does NOT equal trust.
 */

'use strict';

const crypto = require('node:crypto');

const PROVIDER_STATUSES = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  CAPABILITY_VERIFIED: 'CAPABILITY_VERIFIED',
  READY: 'READY',
  BLOCKED: 'BLOCKED',
  UNKNOWN: 'UNKNOWN',
  UNSUPPORTED: 'UNSUPPORTED',
});

const ISOLATION_LEVELS = Object.freeze({
  NONE: 'NONE',
  BASIC_PROCESS: 'BASIC_PROCESS',
  CONTAINER: 'CONTAINER',
  HYPERVISOR: 'HYPERVISOR',
  HARDWARE_ENCLAVE: 'HARDWARE_ENCLAVE',
});

class IsolationProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  /**
   * Registers a provider descriptor.
   */
  registerProvider(descriptor) {
    if (!descriptor || !descriptor.providerId) {
      throw new Error('registerProvider requires descriptor with non-empty providerId.');
    }
    const sanitized = this._normalizeDescriptor(descriptor);
    this.providers.set(sanitized.providerId, sanitized);
    return sanitized;
  }

  getProvider(providerId) {
    if (!providerId) return null;
    const direct = this.providers.get(providerId);
    if (direct) return direct;
    if (providerId === 'wsl') {
      return this.providers.get('wsl-isolation-provider') || null;
    }
    if (providerId === 'windows_sandbox' || providerId === 'windows-sandbox') {
      return this.providers.get('windows-sandbox-provider') || null;
    }
    return null;
  }

  getAllProviders() {
    return Array.from(this.providers.values());
  }

  getProvidersForPlatform(platform = process.platform) {
    return this.getAllProviders().filter((p) => p.supportedPlatforms.includes(platform));
  }

  _normalizeDescriptor(raw) {
    return Object.freeze({
      providerId: String(raw.providerId),
      version: String(raw.version || '0.0.0'),
      supportedPlatforms: Array.isArray(raw.supportedPlatforms) ? [...raw.supportedPlatforms] : [process.platform],
      isolationLevel: raw.isolationLevel || ISOLATION_LEVELS.NONE,
      availability: {
        isInstalled: Boolean(raw.availability?.isInstalled),
        isRunning: Boolean(raw.availability?.isRunning),
        health: String(raw.availability?.health || 'UNKNOWN'),
      },
      filesystemCapabilities: Object.freeze({
        ephemeralCopyOnWrite: Boolean(raw.filesystemCapabilities?.ephemeralCopyOnWrite),
        readOnlyRoot: Boolean(raw.filesystemCapabilities?.readOnlyRoot),
        restrictedBindMounts: Boolean(raw.filesystemCapabilities?.restrictedBindMounts),
        secureErasureOnExit: Boolean(raw.filesystemCapabilities?.secureErasureOnExit),
      }),
      processCapabilities: Object.freeze({
        independentProcessTree: Boolean(raw.processCapabilities?.independentProcessTree),
        credentialIsolation: Boolean(raw.processCapabilities?.credentialIsolation),
        userNamespaceRemapping: Boolean(raw.processCapabilities?.userNamespaceRemapping),
        hostObservedTermination: Boolean(raw.processCapabilities?.hostObservedTermination),
      }),
      networkCapabilities: Object.freeze({
        defaultDenyAll: Boolean(raw.networkCapabilities?.defaultDenyAll),
        egressFiltering: Boolean(raw.networkCapabilities?.egressFiltering),
        isolatedNetworkNamespace: Boolean(raw.networkCapabilities?.isolatedNetworkNamespace),
      }),
      resourceLimits: Object.freeze({
        cpuThrottlingSupported: Boolean(raw.resourceLimits?.cpuThrottlingSupported),
        memoryCapSupported: Boolean(raw.resourceLimits?.memoryCapSupported),
        outputBufferingCapped: Boolean(raw.resourceLimits?.outputBufferingCapped),
        timeoutEnforcementSupported: Boolean(raw.resourceLimits?.timeoutEnforcementSupported),
      }),
      evidenceSource: raw.evidenceSource ? String(raw.evidenceSource) : null,
      verificationTimestamp: raw.verificationTimestamp ? String(raw.verificationTimestamp) : null,
      capabilityVerificationStatus: raw.capabilityVerificationStatus || PROVIDER_STATUSES.UNKNOWN,
      unverifiedRequirements: Array.isArray(raw.unverifiedRequirements) ? [...raw.unverifiedRequirements] : [],
      isReady: false, // Default fail-closed: discovery never sets isReady = true automatically
      blockingReasons: Array.isArray(raw.blockingReasons) ? [...raw.blockingReasons] : ['Provider capability has not been independently verified.'],
    });
  }
}

const defaultRegistry = new IsolationProviderRegistry();

function createIsolationProviderRegistry() {
  return new IsolationProviderRegistry();
}

module.exports = {
  PROVIDER_STATUSES,
  ISOLATION_LEVELS,
  IsolationProviderRegistry,
  defaultRegistry,
  createIsolationProviderRegistry,
};
