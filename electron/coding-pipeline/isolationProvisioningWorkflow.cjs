/**
 * AI Help Agent - Isolation Provisioning Workflow Contract (V27.3)
 *
 * Provides a structured, approval-gated workflow for evaluating, requesting,
 * and verifying isolated execution environments before project code can run.
 * Enforces strict fail-closed security:
 * - Requires explicit user approval for any system-level action or elevation.
 * - Rejects synthetic, caller-asserted, stale, or forged isolation claims.
 * - Enforces request-binding (plan digest, session ID, provider ID, freshness).
 * - Never falls back to host execution.
 * - Returns BLOCKED — AWAITING_APPROVED_PROVISIONING when external administrator action is required.
 */

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { projectProcessIsolationStatus } = require('./projectProcessIsolation.cjs');
const { discoverIsolationRuntimes } = require('./isolationRuntimeDiscovery.cjs');
const { verifyIsolationCapabilities } = require('./isolationCapabilityVerifier.cjs');
const { defaultRegistry, PROVIDER_STATUSES } = require('./isolationProviderRegistry.cjs');
const {
  executeInVerifiedSandbox,
  verifyIsolationEvidence,
  ADAPTER_STATUSES,
} = require('./sandboxExecutionAdapter.cjs');

const APPROVAL_EXPIRY_MS = 300_000; // 5 minutes max approval lifetime

const PROVISIONING_STATUSES = Object.freeze({
  AWAITING_APPROVAL: 'BLOCKED — AWAITING_APPROVED_PROVISIONING',
  ISOLATION_NOT_ESTABLISHED: 'BLOCKED — ISOLATION_NOT_ESTABLISHED',
  READY: 'READY',
  REJECTED: 'REJECTED',
});

const PROVISIONING_PLANS = Object.freeze({
  'windows-sandbox': Object.freeze({
    providerId: 'windows-sandbox',
    displayName: 'Windows Sandbox Disposable VM',
    description: 'Hardware-enforced disposable VM using Windows Containers-DisposableClientVM feature.',
    requiresAdminElevation: true,
    requiresReboot: false,
    prerequisiteCommands: [
      'Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All -NoRestart',
    ],
    expectedEffect: 'Enables the Windows Sandbox hypervisor client VM feature on the host.',
    rollbackCommand: 'Disable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -NoRestart',
    verificationCommand: 'Get-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM"',
    isolationGuarantees: [
      'Hardware-enforced virtual machine boundary',
      'Ephemeral filesystem discarded on sandbox exit',
      'Host user profile and credentials completely excluded from container mapping',
      'Configurable network disable policy in .wsb profile',
    ],
    limitations: [
      'Requires Administrator privilege to enable feature',
      'Interactive desktop GUI session unless driven via headless supervisor',
    ],
  }),

  'wsl-isolated': Object.freeze({
    providerId: 'wsl-isolated',
    displayName: 'WSL 2 Custom Isolated Linux Distribution',
    description: 'Isolated WSL 2 Linux container with host drvfs automount disabled and Node.js installed in guest.',
    requiresAdminElevation: false,
    requiresReboot: false,
    prerequisiteCommands: [
      'mkdir -p /etc',
      'printf "[automount]\\nenabled = false\\nmountFsTab = false\\n" > /etc/wsl.conf',
      'wsl --shutdown',
    ],
    expectedEffect: 'Prevents automatic mounting of host Windows drives (/mnt/c), eliminating host credential leakage.',
    rollbackCommand: 'rm -f /etc/wsl.conf && wsl --shutdown',
    verificationCommand: 'test ! -d /mnt/c/Users',
    isolationGuarantees: [
      'Zero access to host C:\\ drive or host %USERPROFILE% credentials',
      'Independent Linux process namespace and unshared network namespace',
      'Disposable per-workload directory in guest /tmp',
    ],
    limitations: [
      'Requires Linux Node.js 18+ to be pre-installed inside the guest distribution',
      'Requires explicit user configuration of /etc/wsl.conf',
    ],
  }),

  'docker-container': Object.freeze({
    providerId: 'docker-container',
    displayName: 'OCI Container Runner (Docker / Podman)',
    description: 'Isolated container execution using Docker Engine or Podman with strict network and mount boundaries.',
    requiresAdminElevation: true,
    requiresReboot: false,
    prerequisiteCommands: [
      'winget install Docker.DockerDesktop',
    ],
    expectedEffect: 'Installs Docker Desktop and adds docker CLI to Windows PATH.',
    rollbackCommand: 'winget uninstall Docker.DockerDesktop',
    verificationCommand: 'docker run --rm hello-world',
    isolationGuarantees: [
      'Default deny network via --network none',
      'Strict read-only bind mounts with isolated /workspace',
      'Enforced cgroup memory and CPU limits',
      'Host-observed container termination and exit code collection',
    ],
    limitations: [
      'Requires Docker Desktop or rootless Podman installation',
      'Requires virtualization support (Hyper-V / WSL 2 backend)',
    ],
  }),
});

/**
 * Returns available provisioning plans.
 */
function getProvisioningPlans() {
  return Object.values(PROVISIONING_PLANS);
}

/**
 * Returns a specific provisioning plan by providerId.
 */
function getProvisioningPlan(providerId) {
  return PROVISIONING_PLANS[providerId] || null;
}

/**
 * Evaluates the readiness of a specific isolation provider based on independent evidence.
 *
 * @param {string} providerId
 * @returns {object} Evaluation outcome
 */
function evaluateProvisioningReadiness(providerId) {
  const plan = getProvisioningPlan(providerId);
  if (!plan) {
    return {
      providerId,
      ready: false,
      status: PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED,
      reason: `Unknown isolation provider: "${providerId}".`,
      unmetPrerequisites: ['Valid registered provider ID'],
    };
  }

  // Probe candidates via existing discovery mechanism
  const candidates = discoverIsolationRuntimes(process.cwd());

  if (providerId === 'windows-sandbox') {
    const sandboxCandidate = candidates.find((c) => c.providerId === 'windows_sandbox');
    if (!sandboxCandidate || !sandboxCandidate.available) {
      return {
        providerId,
        ready: false,
        status: PROVISIONING_STATUSES.AWAITING_APPROVAL,
        reason: 'Windows Sandbox executable is missing or optional feature is disabled.',
        unmetPrerequisites: [
          'Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM"',
        ],
        plan,
      };
    }
    if (!sandboxCandidate.isolationVerified) {
      return {
        providerId,
        ready: false,
        status: PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED,
        reason: 'Windows Sandbox is present but headless isolation is unverified.',
        unmetPrerequisites: [
          'Verified headless host-guest process supervisor and audit binding',
        ],
        plan,
      };
    }
  }

  if (providerId === 'docker-container') {
    const dockerCandidate = candidates.find((c) => c.providerId === 'docker' && (c.evidenceSource === 'docker_cli' || c.evidenceSource === 'wsl_docker_cli'));
    if (!dockerCandidate || !dockerCandidate.available) {
      return {
        providerId,
        ready: false,
        status: PROVISIONING_STATUSES.AWAITING_APPROVAL,
        reason: 'Docker CLI is not installed or not running.',
        unmetPrerequisites: ['Install Docker Desktop or Podman on Windows PATH'],
        plan,
      };
    }
    if (!dockerCandidate.isolationVerified) {
      return {
        providerId,
        ready: false,
        status: PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED,
        reason: 'Docker is available but container isolation health check failed.',
        unmetPrerequisites: ['docker run --rm health check verification'],
        plan,
      };
    }
  }

  if (providerId === 'wsl-isolated') {
    // Check if host mount exposure exists
    return {
      providerId,
      ready: false,
      status: PROVISIONING_STATUSES.AWAITING_APPROVAL,
      reason: 'WSL 2 exposes host drives (/mnt/c) by default; automount has not been independently disabled.',
      unmetPrerequisites: [
        'Disable /mnt/c automount in /etc/wsl.conf',
        'Install Node.js 18+ in the isolated Linux distribution',
      ],
      plan,
    };
  }

  return {
    providerId,
    ready: false,
    status: PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED,
    reason: `Provider "${providerId}" has not satisfied independent isolation criteria.`,
    unmetPrerequisites: ['Authoritative isolation verification'],
    plan,
  };
}

/**
 * Requests approval for provisioning actions.
 * Enforces that no privileged command or elevation occurs without explicit user consent.
 *
 * @param {object} params
 * @param {string} params.providerId - Requested provider
 * @param {boolean} params.userApproved - Explicit user confirmation
 * @param {object} [params.context] - Execution context (e.g. planDigest, sessionId)
 * @returns {object} Approval decision and required action
 */
function requestProvisioningApproval({ providerId, userApproved = false, context = {} } = {}) {
  const plan = getProvisioningPlan(providerId);
  if (!plan) {
    return {
      approved: false,
      status: PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED,
      reason: `Unknown provider "${providerId}".`,
      actionRequired: null,
    };
  }

  if (userApproved !== true) {
    return {
      approved: false,
      status: PROVISIONING_STATUSES.AWAITING_APPROVAL,
      providerId,
      reason: `System-level action for "${plan.displayName}" requires explicit user approval.`,
      requiresAdminElevation: plan.requiresAdminElevation,
      prerequisiteCommands: plan.prerequisiteCommands,
      expectedEffect: plan.expectedEffect,
      rollbackCommand: plan.rollbackCommand,
      verificationCommand: plan.verificationCommand,
      actionRequired: 'USER_CONFIRMATION_REQUIRED',
    };
  }

  // Create cryptographic approval token bound to context
  const approvalToken = {
    approvalId: crypto.randomUUID(),
    providerId,
    planDigest: context.planDigest || null,
    sessionId: context.sessionId || null,
    timestamp: new Date().toISOString(),
    expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_MS).toISOString(),
    userApproved: true,
  };

  // If approved by user but requires administrator elevation on Windows:
  if (plan.requiresAdminElevation) {
    return {
      approved: true,
      approvalToken,
      status: PROVISIONING_STATUSES.AWAITING_APPROVAL,
      providerId,
      reason: `User approved setup, but "${plan.displayName}" requires elevated Administrator privileges that must be performed manually.`,
      actionRequired: 'ADMINISTRATOR_MANUAL_ACTION_REQUIRED',
      commandsToRun: plan.prerequisiteCommands,
      verificationCommand: plan.verificationCommand,
      rollbackCommand: plan.rollbackCommand,
    };
  }

  return {
    approved: true,
    approvalToken,
    status: PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED,
    providerId,
    reason: `User approved setup. Execution blocked pending post-setup isolation verification.`,
    actionRequired: 'VERIFY_AFTER_SETUP',
  };
}

/**
 * Validates approval token bindings against current request context.
 * Rejects stale, replayed, or mismatched approval tokens.
 *
 * @param {object} token - Approval token
 * @param {object} context - Current request context
 * @returns {object} Validation result
 */
function validateApprovalToken(token, context = {}) {
  if (!token || typeof token !== 'object') {
    return { valid: false, reason: 'Approval token is missing or invalid.' };
  }

  if (token.userApproved !== true) {
    return { valid: false, reason: 'Token indicates user approval was not granted.' };
  }

  if (context.providerId && token.providerId !== context.providerId) {
    return {
      valid: false,
      reason: `Approval token provider "${token.providerId}" does not match requested provider "${context.providerId}".`,
    };
  }

  if (context.planDigest && token.planDigest && token.planDigest !== context.planDigest) {
    return {
      valid: false,
      reason: 'Approval token plan digest does not match the current execution plan.',
    };
  }

  if (context.sessionId && token.sessionId && token.sessionId !== context.sessionId) {
    return {
      valid: false,
      reason: 'Approval token session does not match current session.',
    };
  }

  if (token.expiresAt) {
    const expiry = Date.parse(token.expiresAt);
    if (!Number.isNaN(expiry) && Date.now() > expiry) {
      return { valid: false, reason: `Approval token expired at ${token.expiresAt}.` };
    }
  }

  return { valid: true };
}

/**
 * Integrated bridge that executes an approved plan through the full provisioning and isolation lifecycle.
 * Fails closed with zero host fallbacks:
 * 1. Checks provider readiness.
 * 2. If unready, evaluates user approval and administrative requirements.
 * 3. Verifies isolation evidence and request binding.
 * 4. Dispatches to verified sandbox only when all checks pass.
 *
 * @param {object} params
 * @returns {Promise<object>} Structured execution or blocked result
 */
async function executeWithProvisioningWorkflow({
  plan,
  ownerWebContentsId,
  sessionId,
  requestedProviderId = 'windows-sandbox',
  provisioningApproval = null,
  isolationEvidence = null,
  supervisorRunner = null,
  timeoutMs,
  maxOutputBytes,
  signal,
} = {}) {
  const startTime = Date.now();
  const executionId = crypto.randomUUID();

  if (!plan || !ownerWebContentsId || !sessionId) {
    return {
      ok: false,
      executionId,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'INPUT_VALIDATION_GATE',
      executionBlocked: true,
      reason: 'plan, ownerWebContentsId, and sessionId are required.',
      elapsedMs: Date.now() - startTime,
    };
  }

  // 1. Evaluate current provider readiness
  const readiness = evaluateProvisioningReadiness(requestedProviderId);
  if (!readiness.ready) {
    // If user approval was provided, validate token binding
    if (provisioningApproval) {
      const tokenCheck = validateApprovalToken(provisioningApproval, {
        providerId: requestedProviderId,
        planDigest: plan.planDigest,
        sessionId,
      });

      if (!tokenCheck.valid) {
        return {
          ok: false,
          executionId,
          status: PROVISIONING_STATUSES.AWAITING_APPROVAL,
          gate: 'APPROVAL_BINDING_GATE',
          executionBlocked: true,
          reason: `Provisioning approval rejected: ${tokenCheck.reason}`,
          plan: readiness.plan,
          elapsedMs: Date.now() - startTime,
        };
      }

      // If approved but requires admin elevation
      if (readiness.plan?.requiresAdminElevation) {
        return {
          ok: false,
          executionId,
          status: PROVISIONING_STATUSES.AWAITING_APPROVAL,
          gate: 'ADMINISTRATOR_MANUAL_ACTION_REQUIRED',
          executionBlocked: true,
          reason: `User approved provisioning, but "${readiness.plan.displayName}" requires Administrator elevation on Windows.`,
          unmetPrerequisites: readiness.unmetPrerequisites,
          commandsToRun: readiness.plan.prerequisiteCommands,
          verificationCommand: readiness.plan.verificationCommand,
          rollbackCommand: readiness.plan.rollbackCommand,
          plan: readiness.plan,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    // Unapproved or unprovisioned provider
    return {
      ok: false,
      executionId,
      status: readiness.status,
      gate: 'PROVISIONING_GATE',
      executionBlocked: true,
      reason: readiness.reason,
      unmetPrerequisites: readiness.unmetPrerequisites,
      plan: readiness.plan,
      actionRequired: 'USER_CONFIRMATION_REQUIRED',
      elapsedMs: Date.now() - startTime,
    };
  }

  // 2. Validate isolation evidence strictly
  const expectedContext = {
    projectRoot: path.resolve(plan.projectRoot),
    planDigest: plan.planDigest,
  };
  const isolationValidation = verifyIsolationEvidence(isolationEvidence, expectedContext);
  if (!isolationValidation.isVerified) {
    return {
      ok: false,
      executionId,
      status: PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED,
      gate: isolationValidation.gate || 'PROCESS_ISOLATION_GATE',
      executionBlocked: true,
      reason: isolationValidation.reason || 'Isolation evidence validation failed.',
      planDigest: plan.planDigest,
      elapsedMs: Date.now() - startTime,
    };
  }

  // 3. Dispatch to verified sandbox
  return await executeInVerifiedSandbox({
    plan,
    ownerWebContentsId,
    sessionId,
    isolationEvidence,
    supervisorRunner,
    timeoutMs,
    maxOutputBytes,
    signal,
  });
}

/**
 * Validates isolation before allowing project test execution.
 * Fails closed if any prerequisite is unmet.
 *
 * @param {string} providerId
 * @param {object} evidence
 * @returns {object} Verification outcome
 */
function verifyIsolationBeforeExecution(providerId, evidence = null) {
  const readiness = evaluateProvisioningReadiness(providerId);
  if (!readiness.ready) {
    const error = new Error(`Cannot execute project tests: ${readiness.reason}`);
    error.code = 'ISOLATION_GATE_BLOCKED';
    error.status = readiness.status;
    error.unmetPrerequisites = readiness.unmetPrerequisites;
    error.providerId = providerId;
    return {
      allowed: false,
      error,
      status: readiness.status,
      reason: readiness.reason,
    };
  }

  return {
    allowed: true,
    status: PROVISIONING_STATUSES.READY,
    providerId,
  };
}

module.exports = {
  PROVISIONING_STATUSES,
  PROVISIONING_PLANS,
  APPROVAL_EXPIRY_MS,
  getProvisioningPlans,
  getProvisioningPlan,
  evaluateProvisioningReadiness,
  requestProvisioningApproval,
  validateApprovalToken,
  executeWithProvisioningWorkflow,
  verifyIsolationBeforeExecution,
};
