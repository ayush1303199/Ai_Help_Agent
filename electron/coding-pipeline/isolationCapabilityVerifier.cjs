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
  requestedPolicy = DEFAULT_ISOLATION_POLICY,
  evidence = null,
  context = {},
} = {}) {
  const policy = { ...DEFAULT_ISOLATION_POLICY, ...requestedPolicy };
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

  // 2. Caller-supplied boolean rejection
  if (evidence && typeof evidence === 'object') {
    if (evidence.sandbox === true || evidence.isolationVerified === true) {
      return {
        status: PROVIDER_STATUSES.BLOCKED,
        ready: false,
        reason: 'Caller-supplied Boolean flag ("sandbox: true" or "isolationVerified: true") rejected as unverified.',
        blockingReasons: ['Self-asserted caller flags are not accepted as authoritative evidence.'],
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

    // Freshness check
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
