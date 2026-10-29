/**
 * AI Help Agent - WSL Isolation Provider Adapter (V44)
 *
 * Exposes capability discovery, contract boundaries, and evidence verification
 * for WSL-backed Linux execution without executing arbitrary project commands.
 *
 * Strict Security Invariants:
 * 1. Default WSL is NOT an isolated sandbox (unrestricted network, /mnt/c host filesystem mount, shared user).
 * 2. Discovery does NOT equal verified isolation (isReady strictly false).
 * 3. Execution remains BLOCKED until per-run ephemeral workspace, network egress deny,
 *    unprivileged worker identity, and host-observed cleanup are independently attested.
 * 4. Zero arbitrary project command execution or host fallback.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER_STATUSES, ISOLATION_LEVELS } = require('../isolationProviderRegistry.cjs');

const WSL_DISABLED_REASON = 'WSL execution isolation is currently disabled: automated per-instance network egress denial, /mnt/c host filesystem unmounting, unprivileged worker identity, and process cleanup are not independently verified on this platform.';

function makeVerificationResult({
  verified = false,
  status = PROVIDER_STATUSES.BLOCKED,
  schemaValid = false,
  digestMatched = false,
  osIsolationVerified = false,
  executionAuthorized = false,
  liveExecutionBlocked = true,
  reason = '',
  blockingReasons = [],
} = {}) {
  return {
    verified,
    evidenceVerified: verified,
    status,
    schemaValid,
    digestMatched,
    osIsolationVerified,
    executionAuthorized,
    liveExecutionBlocked,
    reason,
    blockingReasons: blockingReasons.length ? blockingReasons : (status === PROVIDER_STATUSES.BLOCKED ? [reason] : []),
  };
}

class WslIsolationProvider {
  constructor() {
    this.providerId = 'wsl-isolation-provider';
    this.version = '1.0.0';
    this.supportedPlatforms = ['win32'];
  }

  /**
   * Discovers provider capabilities without running arbitrary project commands.
   */
  async discoverCapabilities() {
    const isWindows = process.platform === 'win32';
    const exePath1 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wsl.exe');
    const exePath2 = 'C:\\Program Files\\WSL\\wsl.exe';
    const isInstalled = isWindows && (fs.existsSync(exePath1) || fs.existsSync(exePath2));

    return {
      providerId: this.providerId,
      version: this.version,
      supportedPlatforms: this.supportedPlatforms,
      isolationLevel: isWindows ? ISOLATION_LEVELS.CONTAINER : ISOLATION_LEVELS.NONE,
      availability: {
        isInstalled,
        isRunning: false, // Distributions observed stopped or restricted in agent context
        health: isInstalled ? 'UNVERIFIED' : 'UNAVAILABLE',
      },
      filesystemCapabilities: {
        ephemeralCopyOnWrite: false, // Raw WSL distros persist state in ext4.vhdx
        readOnlyRoot: false,        // Default distro root is read-write
        restrictedBindMounts: false, // Default WSL automounts /mnt/c with full host access
        secureErasureOnExit: false,  // Disk mutations persist across runs
      },
      processCapabilities: {
        independentProcessTree: true,
        credentialIsolation: false,   // Default WSL inherits Windows PATH and interop
        userNamespaceRemapping: false, // Runs as default distro user or root
        hostObservedTermination: false,
      },
      networkCapabilities: {
        defaultDenyAll: false,       // Default WSL has unrestricted outbound NAT networking
        egressFiltering: false,
        isolatedNetworkNamespace: false,
      },
      resourceLimits: {
        cpuThrottlingSupported: true,
        memoryCapSupported: true,
        outputBufferingCapped: true,
        timeoutEnforcementSupported: true,
      },
      evidenceSource: isWindows ? 'WSL_PLATFORM_PROBE' : 'NONE',
      verificationTimestamp: new Date().toISOString(),
      capabilityVerificationStatus: isWindows ? PROVIDER_STATUSES.BLOCKED : PROVIDER_STATUSES.UNSUPPORTED,
      unverifiedRequirements: isWindows
        ? [
            'Per-run ephemeral workspace isolation with read-only project mounts (WSL automount /mnt/c must be disabled or unmounted)',
            'Credential and host environment isolation (WSL interop must not expose host credentials or PATH)',
            'Default-deny network egress policy enforced inside guest namespace (iptables/unshare -n)',
            'Unprivileged worker identity binding (dedicated non-root user)',
            'Host-observed process termination daemon and exit code attestation',
            'Verified scratch directory cleanup and secure disk erasure',
          ]
        : ['Requires Windows 10/11 with WSL2 feature and registered Linux distribution'],
      isReady: false, // Strict fail-closed
      blockingReasons: [
        isWindows
          ? WSL_DISABLED_REASON
          : `Platform "${process.platform}" is incompatible with WSL isolation provider.`,
      ],
    };
  }

  /**
   * Verifies isolation evidence against mandatory execution policy.
   * Rejects caller-asserted booleans or ambient WSL availability.
   */
  verifyEvidence(evidence, requestedPolicy = {}) {
    if (process.platform !== 'win32') {
      return makeVerificationResult({
        verified: false,
        status: PROVIDER_STATUSES.UNSUPPORTED,
        reason: `WSL isolation provider is unsupported on platform "${process.platform}".`,
      });
    }

    if (!evidence || typeof evidence !== 'object') {
      return makeVerificationResult({
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Missing WSL isolation evidence.',
      });
    }

    // Reject caller-supplied boolean flags
    if (evidence.sandbox === true || evidence.isolationVerified === true || evidence.hostWslAccessible === true) {
      return makeVerificationResult({
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'Caller-supplied Boolean flag ("sandbox: true", "isolationVerified: true", or "hostWslAccessible: true") rejected as unverified.',
      });
    }

    if (evidence.providerId && evidence.providerId !== this.providerId) {
      return makeVerificationResult({
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: `Evidence bound to provider "${evidence.providerId}", expected "${this.providerId}".`,
      });
    }

    // Verify required contract bindings
    const requiredBindings = [
      'workerIdentity',
      'networkDenyAttested',
      'hostMountsStripped',
      'ephemeralWorkspaceCleaned',
      'approvedSnapshotDigest',
      'verificationPlanDigest',
    ];

    for (const binding of requiredBindings) {
      if (!evidence[binding] || (typeof evidence[binding] === 'string' && !evidence[binding].trim())) {
        return makeVerificationResult({
          verified: false,
          status: PROVIDER_STATUSES.BLOCKED,
          reason: `WSL isolation evidence missing mandatory security attestation: ${binding}.`,
        });
      }
    }

    // Verify evidence timestamp and freshness
    if (evidence.evidenceExpiry && new Date(evidence.evidenceExpiry).getTime() <= Date.now()) {
      return makeVerificationResult({
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'WSL isolation evidence has expired.',
      });
    }

    if (evidence.evidenceTimestamp && Number.isFinite(Date.parse(evidence.evidenceTimestamp))) {
      const ts = new Date(evidence.evidenceTimestamp).getTime();
      const maxFutureSkewMs = 60_000;
      if (ts > Date.now() + maxFutureSkewMs) {
        return makeVerificationResult({
          verified: false,
          status: PROVIDER_STATUSES.BLOCKED,
          reason: 'WSL isolation evidence timestamp is post-dated beyond allowable clock skew.',
        });
      }
    }

    // Reject simulated, fixture, or untrusted provenance
    const provenance = String(evidence.provenance || '').trim().toLowerCase();
    if (['mock', 'fixture', 'synthetic', 'simulated', 'offline', 'test-fixture', 'guest', 'guest-writable', 'worker', 'untrusted-caller-input'].includes(provenance)) {
      return makeVerificationResult({
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: `WSL isolation evidence source "${evidence.provenance}" is simulated or untrusted.`,
      });
    }

    if (evidence.trustClass === 'UNTRUSTED') {
      return makeVerificationResult({
        verified: false,
        status: PROVIDER_STATUSES.BLOCKED,
        reason: 'WSL isolation evidence trustClass is UNTRUSTED.',
      });
    }

    // Verify approval-bound digests, run ID, and worker identity against requested policy
    if (requestedPolicy && typeof requestedPolicy === 'object') {
      if (requestedPolicy.approvedSnapshotDigest && evidence.approvedSnapshotDigest !== requestedPolicy.approvedSnapshotDigest) {
        return makeVerificationResult({
          verified: false,
          status: PROVIDER_STATUSES.BLOCKED,
          schemaValid: true,
          digestMatched: false,
          reason: 'WSL isolation evidence approvedSnapshotDigest does not match requested policy digest.',
        });
      }
      if (requestedPolicy.approvedManifestDigest && evidence.approvedManifestDigest !== requestedPolicy.approvedManifestDigest) {
        return makeVerificationResult({
          verified: false,
          status: PROVIDER_STATUSES.BLOCKED,
          schemaValid: true,
          digestMatched: false,
          reason: 'WSL isolation evidence approvedManifestDigest does not match requested policy digest.',
        });
      }
      if (requestedPolicy.verificationPlanDigest && evidence.verificationPlanDigest !== requestedPolicy.verificationPlanDigest) {
        return makeVerificationResult({
          verified: false,
          status: PROVIDER_STATUSES.BLOCKED,
          schemaValid: true,
          digestMatched: false,
          reason: 'WSL isolation evidence verificationPlanDigest does not match requested policy digest.',
        });
      }
      if (requestedPolicy.runId && evidence.runId !== requestedPolicy.runId) {
        return makeVerificationResult({
          verified: false,
          status: PROVIDER_STATUSES.BLOCKED,
          schemaValid: true,
          digestMatched: false,
          reason: 'WSL isolation evidence runId does not match requested policy runId.',
        });
      }
      if (requestedPolicy.workerIdentity && evidence.workerIdentity !== requestedPolicy.workerIdentity) {
        return makeVerificationResult({
          verified: false,
          status: PROVIDER_STATUSES.BLOCKED,
          schemaValid: true,
          digestMatched: false,
          reason: 'WSL isolation evidence workerIdentity does not match requested policy workerIdentity.',
        });
      }
    }

    return makeVerificationResult({
      verified: true,
      status: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      schemaValid: true,
      digestMatched: true,
      osIsolationVerified: false,
      executionAuthorized: false,
      liveExecutionBlocked: true,
      reason: 'WSL isolation evidence schema and policy digests validated; live OS isolation enforcement remains unverified on host.',
      blockingReasons: [WSL_DISABLED_REASON],
    });
  }

  /**
   * Evaluates readiness for a requested policy.
   */
  async evaluateReadiness(requestedPolicy = {}) {
    return {
      isReady: false,
      status: process.platform === 'win32' ? PROVIDER_STATUSES.BLOCKED : PROVIDER_STATUSES.UNSUPPORTED,
      providerId: this.providerId,
      reason: process.platform === 'win32' ? WSL_DISABLED_REASON : `Platform "${process.platform}" is incompatible with WSL isolation provider.`,
      blockingReasons: [
        process.platform === 'win32'
          ? WSL_DISABLED_REASON
          : `Platform "${process.platform}" is incompatible with WSL isolation provider.`,
      ],
    };
  }

  /**
   * Rejects any attempt to execute project commands inside WSL without independently verified OS isolation.
   */
  async execute() {
    const error = new Error('WSL live execution is blocked: OS-level isolation is unverified.');
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    error.providerId = this.providerId;
    throw error;
  }
}

function createWslIsolationProvider() {
  return new WslIsolationProvider();
}

module.exports = {
  WSL_DISABLED_REASON,
  WslIsolationProvider,
  createWslIsolationProvider,
};
