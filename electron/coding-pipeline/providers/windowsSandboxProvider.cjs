/**
 * AI Help Agent - Windows Sandbox Provider Adapter (V9)
 *
 * Exposes capability discovery, evidence verification, and readiness evaluation
 * for Windows Sandbox (WBS) / Hyper-V isolation without executing arbitrary project commands.
 */

'use strict';

const { PROVIDER_STATUSES, ISOLATION_LEVELS } = require('../isolationProviderRegistry.cjs');

const WINDOWS_DISABLED_REASON = 'Windows project-context process execution is disabled pending an independently reviewed isolation mechanism.';

class WindowsSandboxProvider {
  constructor() {
    this.providerId = 'windows-sandbox-provider';
    this.version = '1.0.0';
    this.supportedPlatforms = ['win32'];
  }

  /**
   * Discovers provider capabilities without running arbitrary project commands.
   */
  async discoverCapabilities() {
    const isWindows = process.platform === 'win32';

    return {
      providerId: this.providerId,
      version: this.version,
      supportedPlatforms: this.supportedPlatforms,
      isolationLevel: isWindows ? ISOLATION_LEVELS.HYPERVISOR : ISOLATION_LEVELS.NONE,
      availability: {
        isInstalled: isWindows,
        isRunning: false,
        health: isWindows ? 'UNVERIFIED' : 'UNAVAILABLE',
      },
      filesystemCapabilities: {
        ephemeralCopyOnWrite: true,
        readOnlyRoot: true,
        restrictedBindMounts: true,
        secureErasureOnExit: true,
      },
      processCapabilities: {
        independentProcessTree: true,
        credentialIsolation: true,
        userNamespaceRemapping: false,
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
      evidenceSource: isWindows ? 'OS_PLATFORM_PROBE' : 'NONE',
      verificationTimestamp: new Date().toISOString(),
      capabilityVerificationStatus: isWindows ? PROVIDER_STATUSES.BLOCKED : PROVIDER_STATUSES.UNSUPPORTED,
      unverifiedRequirements: isWindows
        ? ['Windows Sandbox host-observed termination daemon attestation']
        : ['Requires Windows 10/11 Pro/Enterprise with Windows Sandbox feature'],
      isReady: false, // Strict fail-closed
      blockingReasons: [isWindows ? WINDOWS_DISABLED_REASON : `Platform "${process.platform}" is incompatible with Windows Sandbox.`],
    };
  }

  /**
   * Verifies isolation evidence against requested execution policy.
   */
  verifyEvidence(evidence, requestedPolicy = {}) {
    if (process.platform !== 'win32') {
      return {
        verified: false,
        status: PROVIDER_STATUSES.UNSUPPORTED,
        reason: `Windows Sandbox provider is unsupported on platform "${process.platform}".`,
      };
    }

    if (!evidence || typeof evidence !== 'object') {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Missing isolation evidence.',
      };
    }

    // Reject caller-supplied boolean flags
    if (evidence.sandbox === true || evidence.isolationVerified === true) {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Caller-supplied Boolean flag ("sandbox: true" or "isolationVerified: true") rejected as unverified.',
      };
    }

    // Check providerId binding
    if (evidence.providerId && evidence.providerId !== this.providerId) {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: `Evidence bound to provider "${evidence.providerId}", expected "${this.providerId}".`,
      };
    }

    // Windows isolation currently remains disabled by policy
    return {
      verified: false,
      status: PROVIDER_STATUSES.BLOCKED,
      reason: WINDOWS_DISABLED_REASON,
      blockingReasons: [WINDOWS_DISABLED_REASON],
    };
  }

  /**
   * Evaluates readiness for a requested policy.
   */
  async evaluateReadiness(requestedPolicy = {}) {
    return {
      isReady: false,
      status: process.platform === 'win32' ? PROVIDER_STATUSES.BLOCKED : PROVIDER_STATUSES.UNSUPPORTED,
      providerId: this.providerId,
      reason: process.platform === 'win32' ? WINDOWS_DISABLED_REASON : 'Platform unsupported.',
      blockingReasons: [process.platform === 'win32' ? WINDOWS_DISABLED_REASON : 'Platform unsupported.'],
    };
  }
}

function createWindowsSandboxProvider() {
  return new WindowsSandboxProvider();
}

module.exports = {
  WINDOWS_DISABLED_REASON,
  WindowsSandboxProvider,
  createWindowsSandboxProvider,
};
