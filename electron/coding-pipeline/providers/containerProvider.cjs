/**
 * AI Help Agent - Container Provider Adapter (V9)
 *
 * Exposes capability discovery, evidence verification, and readiness evaluation
 * for container-based isolation (Docker / Podman daemon) without executing arbitrary project commands.
 */

'use strict';

const { PROVIDER_STATUSES, ISOLATION_LEVELS } = require('../isolationProviderRegistry.cjs');

class ContainerProvider {
  constructor() {
    this.providerId = 'container-isolation-provider';
    this.version = '1.0.0';
    this.supportedPlatforms = ['win32', 'linux', 'darwin'];
  }

  async discoverCapabilities() {
    return {
      providerId: this.providerId,
      version: this.version,
      supportedPlatforms: this.supportedPlatforms,
      isolationLevel: ISOLATION_LEVELS.CONTAINER,
      availability: {
        isInstalled: false,
        isRunning: false,
        health: 'UNVERIFIED',
      },
      filesystemCapabilities: {
        ephemeralCopyOnWrite: false,
        readOnlyRoot: false,
        restrictedBindMounts: false,
        secureErasureOnExit: false,
      },
      processCapabilities: {
        independentProcessTree: false,
        credentialIsolation: false,
        userNamespaceRemapping: false,
        hostObservedTermination: false,
      },
      networkCapabilities: {
        defaultDenyAll: false,
        egressFiltering: false,
        isolatedNetworkNamespace: false,
      },
      resourceLimits: {
        cpuThrottlingSupported: false,
        memoryCapSupported: false,
        outputBufferingCapped: false,
        timeoutEnforcementSupported: false,
      },
      evidenceSource: 'CONTAINER_SOCKET_PROBE',
      verificationTimestamp: new Date().toISOString(),
      capabilityVerificationStatus: PROVIDER_STATUSES.BLOCKED,
      daemonTrust: 'NOT_ESTABLISHED',
      kernelResourceEnforcement: 'NOT_VERIFIED',
      readOnlyFilesystemEnforcement: 'NOT_VERIFIED',
      independentObserver: 'NOT_IMPLEMENTED',
      observerIdentityAuthentication: 'NOT_VERIFIED',
      ipcPeerAuthentication: 'NOT_VERIFIED',
      windowsNamedPipeSecurity: 'NOT_VERIFIED',
      ipcClientAuthentication: 'NOT_VERIFIED',
      osProcessIdentity: 'NOT_VERIFIED',
      unverifiedRequirements: [
        'Authenticated mutual TLS or local pipe to container daemon',
        'Cryptographic daemon attestation certificate',
        'Kernel cgroups v2 controller enforcement',
        'Host-observed network namespace or egress firewall verification',
      ],
      isReady: false,
      blockingReasons: ['Container daemon authentication and attestation have not been established.', 'Runtime security capabilities (filesystem, egress, cgroups) are unverified.'],
    };
  }

  verifyEvidence(evidence, requestedPolicy = {}) {
    if (!evidence || typeof evidence !== 'object') {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Missing container isolation evidence.',
      };
    }

    if (evidence.sandbox === true || evidence.isolationVerified === true || evidence.verified === true || evidence.independentlyVerified === true || evidence.kernelEnforced === true || evidence.daemonTrust === 'VERIFIED' || evidence.isTrustedDaemon === true || evidence.observerAuthenticated === true || evidence.trustedObserver === true || evidence.windowsPipeVerified === true || evidence.osProcessIdentityVerified === true) {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Caller-supplied Boolean flag ("sandbox: true") rejected as unverified.',
      };
    }

    const provenance = String(evidence.provenance || '').toLowerCase();
    if (evidence.isMock === true || evidence.trustClass === 'UNTRUSTED' || ['mock', 'synthetic', 'synthetic-test', 'simulated'].includes(provenance)) {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Synthetic or mock container evidence cannot establish production runtime verification.',
        blockingReasons: ['Synthetic evidence rejected for production isolation verification.'],
      };
    }

    if (evidence.providerId && evidence.providerId !== this.providerId) {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: `Evidence bound to provider "${evidence.providerId}", expected "${this.providerId}".`,
      };
    }

    // Check daemon certificate and cryptographic attestation
    if (!evidence.daemonCertSha256 || !evidence.containerAttestationDigest) {
      return {
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Container evidence lacks verified daemon certificate or attestation digest.',
        blockingReasons: ['Missing daemonCertSha256 or containerAttestationDigest.'],
      };
    }

    return {
      verified: true,
      status: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      reason: 'Container isolation evidence verified.',
    };
  }

  async evaluateReadiness(requestedPolicy = {}) {
    return {
      isReady: false,
      status: PROVIDER_STATUSES.BLOCKED,
      providerId: this.providerId,
      reason: 'Container isolation provider is not attested in current session.',
      blockingReasons: ['Container daemon authentication and attestation have not been established.'],
    };
  }
}

function createContainerProvider() {
  return new ContainerProvider();
}

module.exports = {
  ContainerProvider,
  createContainerProvider,
};
