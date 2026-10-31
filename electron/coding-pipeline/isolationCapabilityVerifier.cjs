/**
 * AI Help Agent - Isolation Capability Verifier (V9)
 *
 * Deterministically evaluates requested execution policies against independently verified
 * provider capabilities and cryptographic attestation evidence.
 * Enforces strict fail-closed security and rejects caller-supplied status booleans.
 */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { PROVIDER_STATUSES } = require('./isolationProviderRegistry.cjs');

const UNTRUSTED_PROVENANCE_SOURCES = new Set([
  'mock',
  'fixture',
  'synthetic',
  'simulated',
  'offline',
  'test-fixture',
  'guest',
  'guest-writable',
  'worker',
  'caller_asserted',
  'self_reported',
  'untrusted-caller-input',
  'test_stub',
]);

const DEFAULT_ISOLATION_POLICY = Object.freeze({
  requireProcessIsolation: true,
  requireNetworkDeny: true,
  requireFilesystemCow: true,
  requireCredentialIsolation: true,
  requireResourceLimits: true,
});

/**
 * Deterministically verifies provider capabilities and evidence against an execution policy.
 *
 * @param {object} params
 * @param {object} params.providerDescriptor - Provider capabilities from registry or adapter
 * @param {object} [params.requestedPolicy] - Security policy requirements
 * @param {object} [params.evidence] - Attestation / isolation evidence
 * @param {object} [params.context] - Session and workflow binding context
 * @returns {object} Verification outcome
 */
function verifyIsolationCapabilities({
  providerDescriptor,
  requestedPolicy,
  policy: explicitPolicy,
  evidence = null,
  context = {},
} = {}) {
  if (explicitPolicy && requestedPolicy && typeof explicitPolicy === 'object' && typeof requestedPolicy === 'object') {
    const allKeys = new Set([...Object.keys(explicitPolicy), ...Object.keys(requestedPolicy)]);
    for (const key of allKeys) {
      if (key in explicitPolicy && key in requestedPolicy && explicitPolicy[key] !== requestedPolicy[key]) {
        return {
          status: PROVIDER_STATUSES.BLOCKED,
          ready: false,
          reason: `Conflicting policy specifications: key "${key}" differs between policy and requestedPolicy.`,
          blockingReasons: [`Policy conflict on "${key}".`],
        };
      }
    }
  }
  const policyInput = explicitPolicy || requestedPolicy || DEFAULT_ISOLATION_POLICY;
  const policy = { ...DEFAULT_ISOLATION_POLICY, ...policyInput };
  const missingCapabilities = [];
  const blockingReasons = [];

  // 1. Provider presence & platform validation
  if (!providerDescriptor || typeof providerDescriptor !== 'object') {
    return {
      status: PROVIDER_STATUSES.BLOCKED,
      ready: false,
      reason: 'No isolation provider specified or provider descriptor is null.',
      missingCapabilities: ['provider_descriptor'],
      blockingReasons: ['Isolation provider descriptor is null or unavailable.'],
    };
  }

  const currentPlatform = process.platform;
  if (!providerDescriptor.supportedPlatforms.includes(currentPlatform)) {
    return {
      status: PROVIDER_STATUSES.UNSUPPORTED,
      ready: false,
      reason: `Provider "${providerDescriptor.providerId}" does not support platform "${currentPlatform}".`,
      missingCapabilities: ['platform_compatibility'],
      blockingReasons: [`Platform "${currentPlatform}" is unsupported by provider "${providerDescriptor.providerId}".`],
    };
  }

  if (Array.isArray(providerDescriptor.blockingReasons) && providerDescriptor.blockingReasons.length > 0) {
    blockingReasons.push(...providerDescriptor.blockingReasons);
  }
  if (providerDescriptor.capabilityVerificationStatus === PROVIDER_STATUSES.BLOCKED) {
    blockingReasons.push(`Provider "${providerDescriptor.providerId}" capability verification status is BLOCKED.`);
  }
  if (providerDescriptor.isReady === false && !blockingReasons.length) {
    blockingReasons.push(`Provider "${providerDescriptor.providerId}" is not ready for execution (isReady: false).`);
  }

  // 2. Caller-supplied boolean rejection
  if (evidence && typeof evidence === 'object') {
    if (evidence.publicKey !== undefined) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Caller-supplied public key rejected as unverified trust anchor.',
        blockingReasons: ['Self-asserted public keys are not accepted as authoritative evidence.'],
        reasonCode: 'SELF_SIGNED_KEY_REJECTED',
      };
    }

    if (evidence.issuerService !== undefined) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Caller-supplied issuer service descriptor rejected as unverified trust assertion.',
        blockingReasons: ['Self-asserted issuer service descriptors are not accepted as authoritative evidence.'],
        reasonCode: 'CALLER_FORGED_ISSUER_SERVICE',
      };
    }

    if (evidence.issuerIdentity !== undefined) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Caller-supplied issuer identity rejected as unverified trust assertion.',
        blockingReasons: ['Self-asserted issuer identities are not accepted as authoritative evidence.'],
        reasonCode: 'CALLER_FORGED_ISSUER_IDENTITY',
      };
    }

    if (evidence.daemonTrust === 'VERIFIED' || evidence.isTrustedDaemon === true) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Caller-supplied daemon trust status rejected as unverified.',
        blockingReasons: ['Docker daemon trust cannot be asserted by caller.'],
        reasonCode: 'CALLER_FORGED_DAEMON_TRUST',
      };
    }

    if (evidence.dockerObservation && typeof evidence.dockerObservation === 'object') {
      const { evaluateDockerObservation } = require('./executionEvidenceContract.cjs');
      const evalObs = evaluateDockerObservation({
        observation: evidence.dockerObservation,
        expectedBindings: {
          projectId: context.projectId || context.projectIdentityDigest,
          executionId: context.executionId,
          sessionId: context.sessionId,
          containerId: context.containerId,
        },
        cgroupEvidence: evidence.cgroupEvidence,
        mountEvidence: evidence.mountEvidence,
        cleanupEvidence: evidence.cleanupEvidence,
        processEvidence: evidence.processEvidence,
        activeNonces: context.consumedNonces,
        trustStore: context.trustStore,
      });

      if (evalObs.gateStatus === 'BLOCKED' || !evalObs.isVerified) {
        return {
          status: PROVIDER_STATUSES.BLOCKED,
          ready: false,
          reason: evalObs.reason,
          blockingReasons: [evalObs.reason],
          reasonCode: evalObs.reasonCode,
        };
      }
    }

    if (context.issuerService) {
      const { evaluateIssuerServiceBoundary, ISSUER_SERVICE_STATES } = require('./executionEvidenceContract.cjs');
      const serviceCheck = evaluateIssuerServiceBoundary(context.issuerService);
      if (!serviceCheck.isTrustedBoundary || serviceCheck.state !== ISSUER_SERVICE_STATES.READY) {
        return {
          status: PROVIDER_STATUSES.BLOCKED,
          ready: false,
          reason: serviceCheck.reason || 'Issuer service trust boundary is not established.',
          blockingReasons: [serviceCheck.reason || 'Issuer service trust boundary is not established.'],
          reasonCode: serviceCheck.reasonCode,
        };
      }
    }

    const attestationCandidate = evidence.attestation || (evidence.signature && evidence.payload ? evidence : null);
    if (attestationCandidate) {
      const { verifyAttestationSignature } = require('./executionEvidenceContract.cjs');
      const attestationResult = verifyAttestationSignature({
        attestation: attestationCandidate,
        trustStore: context.trustStore,
        expectedContext: {
          runId: context.runId,
          sessionId: context.sessionId,
          projectIdentityDigest: context.projectIdentityDigest,
          providerId: providerDescriptor.providerId,
          grantId: context.grantId,
          policyDigest: context.policyDigest,
          verificationPlanDigest: context.planDigest || context.verificationPlanDigest,
          nonce: context.nonce,
          maxEvidenceAgeMs: context.maxEvidenceAgeMs,
          consumedNonces: context.consumedNonces,
        },
      });

      if (!attestationResult.valid || attestationResult.state !== 'AUTHENTICATED') {
        return {
          status: PROVIDER_STATUSES.BLOCKED,
          ready: false,
          reason: attestationResult.reason || 'Cryptographic attestation signature verification failed.',
          blockingReasons: [attestationResult.reason || 'Cryptographic attestation failed.'],
          reasonCode: attestationResult.reasonCode,
        };
      }
    } else if (context.requireAttestation) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Cryptographic attestation required but absent in evidence.',
        blockingReasons: ['Cryptographic attestation required.'],
        reasonCode: 'ATTESTATION_REQUIRED',
      };
    }
    if (evidence.sandbox === true || evidence.isolationVerified === true || evidence.verified === true || evidence.independentlyVerified === true) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Caller-supplied Boolean flag ("sandbox: true", "isolationVerified: true", "verified: true", or "independentlyVerified: true") rejected as unverified.',
        blockingReasons: ['Self-asserted caller flags are not accepted as authoritative evidence.'],
      };
    }

    if (evidence.isMock === true || evidence.trustClass === 'UNTRUSTED') {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Untrusted or mock evidence cannot authorize production execution.',
        blockingReasons: ['Mock or unauthenticated evidence rejected.'],
      };
    }

    // Provenance check
    const provenance = String(evidence.provenance || '').toLowerCase();
    if (UNTRUSTED_PROVENANCE_SOURCES.has(provenance)) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: `Evidence provenance "${evidence.provenance}" is untrusted or simulated.`,
        blockingReasons: [`Untrusted evidence provenance: ${evidence.provenance}`],
      };
    }

    // Provider binding check
    if (evidence.providerId && evidence.providerId !== providerDescriptor.providerId) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: `Evidence is bound to provider "${evidence.providerId}", but current provider is "${providerDescriptor.providerId}".`,
        blockingReasons: ['Provider identity mismatch in evidence.'],
      };
    }

    // Workflow / plan digest binding check
    if (context.workflowId && evidence.workflowId && evidence.workflowId !== context.workflowId) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: `Workflow binding mismatch: evidence is bound to "${evidence.workflowId}", context is "${context.workflowId}".`,
        blockingReasons: ['Workflow binding mismatch in evidence.'],
      };
    }

    if (context.planDigest && evidence.planDigest && evidence.planDigest !== context.planDigest) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: `Plan digest mismatch: evidence is bound to "${evidence.planDigest}", context is "${context.planDigest}".`,
        blockingReasons: ['Plan digest mismatch in evidence.'],
      };
    }

    // Context binding checks: projectRoot, sessionId, nonce
    if (context.projectRoot && evidence.projectRoot) {
      const path = require('node:path');
      if (path.resolve(evidence.projectRoot).toLowerCase() !== path.resolve(context.projectRoot).toLowerCase()) {
        return {
          status: PROVIDER_STATUSES.BLOCKED,
          ready: false,
          reason: `Project root mismatch: evidence is bound to "${evidence.projectRoot}", context is "${context.projectRoot}".`,
          blockingReasons: ['Project root mismatch in evidence.'],
        };
      }
    }

    if (context.sessionId && evidence.sessionId && evidence.sessionId !== context.sessionId) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: `Session binding mismatch: evidence is bound to "${evidence.sessionId}", context is "${context.sessionId}".`,
        blockingReasons: ['Session binding mismatch in evidence.'],
      };
    }

    if (context.nonce && evidence.nonce && evidence.nonce !== context.nonce) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Nonce mismatch in evidence.',
        blockingReasons: ['Nonce mismatch in evidence.'],
      };
    }

    // Freshness & future-dating checks
    if (evidence.evidenceTimestamp) {
      const ts = Date.parse(evidence.evidenceTimestamp);
      if (!Number.isNaN(ts)) {
        if (ts > Date.now() + 60000) {
          return {
            status: PROVIDER_STATUSES.BLOCKED,
            ready: false,
            reason: `Isolation evidence is future-dated (${evidence.evidenceTimestamp}).`,
            blockingReasons: ['Evidence timestamp is in the future.'],
          };
        }
        const maxAge = context.maxEvidenceAgeMs || 5 * 60 * 1000;
        if (Date.now() - ts > maxAge) {
          return {
            status: PROVIDER_STATUSES.BLOCKED,
            ready: false,
            reason: `Isolation evidence is stale (age exceeds ${maxAge}ms).`,
            blockingReasons: ['Evidence timestamp exceeds maximum age.'],
          };
        }
      }
    }

    if (evidence.evidenceExpiry) {
      const expiry = Date.parse(evidence.evidenceExpiry);
      if (!Number.isNaN(expiry) && Date.now() > expiry) {
        return {
          status: PROVIDER_STATUSES.BLOCKED,
          ready: false,
          reason: `Isolation evidence expired at ${evidence.evidenceExpiry}.`,
          blockingReasons: ['Evidence is stale/expired.'],
        };
      }
    }
  } else {
    // Missing evidence entirely
    missingCapabilities.push('authoritative_isolation_evidence');
    blockingReasons.push('No verifiable isolation evidence was provided.');
  }

  // 3. Capability policy comparison
  if (policy.requireProcessIsolation) {
    if (!providerDescriptor.processCapabilities?.independentProcessTree) {
      missingCapabilities.push('independent_process_tree');
    }
  }

  if (policy.requireCredentialIsolation) {
    if (!providerDescriptor.processCapabilities?.credentialIsolation) {
      missingCapabilities.push('credential_isolation');
    }
  }

  if (policy.requireNetworkDeny) {
    if (!providerDescriptor.networkCapabilities?.defaultDenyAll && !providerDescriptor.networkCapabilities?.isolatedNetworkNamespace) {
      missingCapabilities.push('network_isolation');
    }
  }

  if (policy.requireFilesystemCow) {
    if (!providerDescriptor.filesystemCapabilities?.ephemeralCopyOnWrite) {
      missingCapabilities.push('ephemeral_copy_on_write');
    }
  }

  if (policy.requireResourceLimits) {
    if (!providerDescriptor.resourceLimits?.timeoutEnforcementSupported) {
      missingCapabilities.push('timeout_enforcement');
    }
  }

  if (policy.requireReadOnlyRootfs) {
    if (!providerDescriptor.filesystemCapabilities?.readOnlyRoot) {
      missingCapabilities.push('read_only_rootfs');
    }
  }

  if (policy.requireEgressFiltering) {
    if (!providerDescriptor.networkCapabilities?.egressFiltering) {
      missingCapabilities.push('egress_filtering');
    }
  }

  if (policy.requireCgroupLimits) {
    if (!providerDescriptor.resourceLimits?.memoryCapSupported || !providerDescriptor.resourceLimits?.cpuThrottlingSupported) {
      missingCapabilities.push('cgroup_resource_limits');
    }
  }

  if (policy.requireFilesystemIsolation) {
    if (!providerDescriptor.filesystemCapabilities?.restrictedBindMounts) {
      missingCapabilities.push('restricted_bind_mounts');
    }
  }

  if (policy.requireCleanupAttestation) {
    if (!providerDescriptor.processCapabilities?.hostObservedTermination) {
      missingCapabilities.push('cleanup_attestation');
    }
  }

  if (policy.requireRuntimeSupervisor) {
    if (!providerDescriptor.processCapabilities?.runtimeSupervisorVerified) {
      missingCapabilities.push('runtime_supervisor');
    }
  }

  // Windows host policy: execution disabled pending reviewed sandbox
  if (currentPlatform === 'win32' && (providerDescriptor.providerId === 'windows-sandbox-provider' || providerDescriptor.providerId === 'wsl-isolation-provider' || providerDescriptor.providerId === 'wsl')) {
    blockingReasons.push(providerDescriptor.providerId.startsWith('wsl') ? 'WSL execution isolation is currently disabled: automated per-instance network egress denial, /mnt/c host filesystem unmounting, unprivileged worker identity, and process cleanup are not independently verified on this platform.' : 'Windows project-context process execution is disabled pending an independently reviewed isolation mechanism.');
  }

  if (missingCapabilities.length > 0 || blockingReasons.length > 0) {
    const primaryReason = blockingReasons[0] || `Isolation readiness blocked: missing ${missingCapabilities.join(', ')}.`;
    return {
      status: PROVIDER_STATUSES.BLOCKED,
      ready: false,
      providerId: providerDescriptor.providerId,
      missingCapabilities,
      blockingReasons,
      reason: primaryReason,
    };
  }

  return {
    status: PROVIDER_STATUSES.READY,
    ready: true,
    providerId: providerDescriptor.providerId,
    verifiedCapabilities: Object.keys(policy),
    verifiedAt: new Date().toISOString(),
  };
}

module.exports = {
  DEFAULT_ISOLATION_POLICY,
  verifyIsolationCapabilities,
};
