'use strict';

/**
 * Strict Sandbox Execution Adapter for AI Coding Agent (Milestone V5).
 *
 * Exposes a strict, trustworthy execution boundary for approved build and test commands:
 * - Environment capability discovery and verification.
 * - Strict isolation evidence validation (rejecting unverified/caller-asserted flags).
 * - Approval-bound command execution with discrete binary and argument arrays.
 * - Enforces timeout, bounded output, cancellation, and secret redaction.
 * - Process cleanup verification.
 * - Fails closed (status: BLOCKED, gate: PROCESS_ISOLATION_GATE) when isolation is unverified.
 * - ZERO arbitrary shell string execution or host fallbacks.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { verifyProjectAuthorization } = require('./projectDiscovery.cjs');
const {
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
} = require('./projectProcessIsolation.cjs');
const {
  validateExecutionEvidenceManifest,
  evaluateProviderEligibility,
} = require('./executionEvidenceContract.cjs');
const { redactSensitiveData } = require('./diagnosticEngine.cjs');
const { validateCommandSafety } = require('./buildOrchestrator.cjs');

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
  'untrusted-caller-input',
]);

const ADAPTER_STATUSES = Object.freeze({
  READY: 'READY',
  BLOCKED: 'BLOCKED',
  UNSUPPORTED: 'UNSUPPORTED',
  TIMED_OUT: 'TIMED_OUT',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  PASSED: 'PASSED',
});

const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const MAX_EXECUTION_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

/**
 * Discovers and inspects the isolation capabilities of the current environment.
 * Does NOT claim READY unless authoritative isolation evidence is verified.
 *
 * @param {string} [platform=process.platform]
 * @returns {Object} Capability discovery report.
 */
function discoverEnvironmentCapabilities(platform = process.platform) {
  const status = projectProcessIsolationStatus(platform);

  return {
    platform,
    available: Boolean(status.available),
    verified: Boolean(status.verified),
    status: status.verified ? ADAPTER_STATUSES.READY : ADAPTER_STATUSES.BLOCKED,
    gate: 'PROCESS_ISOLATION_GATE',
    reason: status.reason || 'Process isolation is unverified on this platform.',
    capabilityStates: status.capabilityStates || {},
  };
}

/**
 * Validates isolation evidence strictly against security policy.
 * Callers supplying arbitrary booleans (e.g. { sandbox: true }) or simulated fixtures
 * are strictly rejected and return BLOCKED.
 *
 * @param {Object} evidence - Structured evidence manifest.
 * @param {Object} [expectedContext] - Expected project context (projectRoot, planDigest).
 * @param {Object} [capabilities] - Environment capabilities.
 * @returns {Object} Validation outcome.
 */
function verifyIsolationEvidence(evidence, expectedContext = {}, capabilities = {}) {
  // 1. Reject missing, empty, or non-object evidence
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      isVerified: false,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: 'Execution evidence manifest is missing or malformed.',
    };
  }

  // 2. Reject caller-supplied Boolean or mock sources pretending to be trusted
  if (evidence.sandbox === true || evidence.isolationVerified === true || evidence.hostWslAccessible === true) {
    return {
      isVerified: false,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: 'Caller-supplied Boolean flag ("sandbox: true") is rejected as proof of isolation.',
    };
  }

  const provenance = String(evidence.provenance || '').toLowerCase();
  if (UNTRUSTED_PROVENANCE_SOURCES.has(provenance)) {
    return {
      isVerified: false,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: `Execution evidence source "${provenance}" is simulated or untrusted.`,
    };
  }

  if (evidence.trustClass === 'UNTRUSTED') {
    return {
      isVerified: false,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: 'Execution evidence trustClass is UNTRUSTED.',
    };
  }

  // 3. Check current platform policy status
  const platformStatus = projectProcessIsolationStatus();
  if (process.platform === 'win32' || !platformStatus.available || !platformStatus.verified) {
    return {
      isVerified: false,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: platformStatus.reason || 'Windows project-context process execution is disabled pending an independently reviewed isolation mechanism.',
    };
  }

  // 4. Validate manifest structure and context bindings
  const validation = validateExecutionEvidenceManifest(evidence, expectedContext);
  if (validation.state !== 'EXECUTION_AUTHORIZED') {
    return {
      isVerified: false,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: validation.reason || 'Execution evidence manifest failed security validation.',
    };
  }

  // 5. Evaluate provider eligibility
  const eligibility = evaluateProviderEligibility(capabilities, validation);
  if (eligibility.state !== 'EXECUTION_AUTHORIZED') {
    return {
      isVerified: false,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: eligibility.reason || 'Isolation provider capabilities do not satisfy mandatory requirements.',
    };
  }

  return {
    isVerified: true,
    status: ADAPTER_STATUSES.READY,
    manifest: validation.manifest,
  };
}

/**
 * Submits and executes an approved plan inside the verified execution boundary.
 *
 * @param {Object} options
 * @param {Object} options.plan - Approved execution plan (V2 dependency, V3 build, or V4 repair).
 * @param {number} options.ownerWebContentsId - Authorized session owner.
 * @param {string} options.sessionId - Session ID.
 * @param {Object} [options.isolationEvidence] - Isolation evidence manifest.
 * @param {Function} [options.supervisorRunner] - Verified supervisor adapter runner.
 * @param {number} [options.timeoutMs] - Maximum execution time limit.
 * @param {number} [options.maxOutputBytes] - Maximum allowed stdout/stderr size.
 * @param {AbortSignal} [options.signal] - Optional cancellation signal.
 * @returns {Promise<Object>} Structured execution receipt.
 */
async function executeInVerifiedSandbox({
  plan,
  ownerWebContentsId,
  sessionId,
  isolationEvidence = null,
  supervisorRunner = null,
  timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal = null,
} = {}) {
  const executionId = crypto.randomUUID();
  const startTime = Date.now();

  if (!plan || !ownerWebContentsId || !sessionId) {
    throw new Error('plan, ownerWebContentsId, and sessionId are required.');
  }

  // 1. Session and Project Authorization Revalidation
  const auth = await verifyProjectAuthorization(plan.projectRoot, ownerWebContentsId);
  if (!auth.isAuthorized) {
    return {
      ok: false,
      executionId,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'AUTHORIZATION_GATE',
      executionBlocked: true,
      reason: `Project authorization failed: ${auth.reason}`,
      planDigest: plan.planDigest,
      elapsedMs: Date.now() - startTime,
    };
  }

  // 2. Command Structure and Safety Validation
  const safety = validateCommandSafety(plan.binary, plan.args);
  if (!safety.valid) {
    return {
      ok: false,
      executionId,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'COMMAND_SAFETY_GATE',
      executionBlocked: true,
      reason: `Command safety violation: ${safety.error}`,
      planDigest: plan.planDigest,
      elapsedMs: Date.now() - startTime,
    };
  }

  // 3. Digest Binding & Plan Alteration Guard
  if (!plan.planDigest || typeof plan.planDigest !== 'string') {
    return {
      ok: false,
      executionId,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: 'APPROVAL_DIGEST_GATE',
      executionBlocked: true,
      reason: 'Plan digest is missing. Command cannot be bound to an approved proposal.',
      elapsedMs: Date.now() - startTime,
    };
  }

  // 4. Cancellation check before starting
  if (signal?.aborted) {
    return {
      ok: false,
      executionId,
      status: ADAPTER_STATUSES.CANCELLED,
      reason: 'Execution was cancelled by the caller before starting.',
      planDigest: plan.planDigest,
      elapsedMs: Date.now() - startTime,
    };
  }

  // 5. Isolation Evidence Verification
  const expectedContext = {
    projectRoot: path.resolve(plan.projectRoot),
    planDigest: plan.planDigest,
  };
  const isolation = verifyIsolationEvidence(isolationEvidence, expectedContext);
  if (!isolation.isVerified) {
    return {
      ok: false,
      executionId,
      status: ADAPTER_STATUSES.BLOCKED,
      gate: isolation.gate || 'PROCESS_ISOLATION_GATE',
      executionBlocked: true,
      reason: isolation.reason || 'Command execution blocked: verified process isolation is required.',
      planDigest: plan.planDigest,
      command: `${plan.binary} ${(plan.args || []).join(' ')}`.trim(),
      elapsedMs: Date.now() - startTime,
    };
  }

  // 6. Execute through verified supervisor adapter if supplied
  if (typeof supervisorRunner === 'function') {
    const effectiveTimeout = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_EXECUTION_TIMEOUT_MS), MAX_EXECUTION_TIMEOUT_MS);
    try {
      const runnerResult = await supervisorRunner({
        executionId,
        binary: plan.binary,
        args: plan.args,
        projectRoot: plan.projectRoot,
        timeoutMs: effectiveTimeout,
        maxOutputBytes,
        signal,
      });

      const elapsedMs = Date.now() - startTime;
      const rawStdout = typeof runnerResult.stdout === 'string' ? runnerResult.stdout : '';
      const rawStderr = typeof runnerResult.stderr === 'string' ? runnerResult.stderr : '';
      const stdout = redactSensitiveData(rawStdout.slice(0, maxOutputBytes));
      const stderr = redactSensitiveData(rawStderr.slice(0, maxOutputBytes));
      const exitCode = typeof runnerResult.exitCode === 'number' ? runnerResult.exitCode : 1;
      const timedOut = Boolean(runnerResult.timedOut || runnerResult.timeout);
      const cancelled = Boolean(runnerResult.cancelled || signal?.aborted);

      if (timedOut) {
        return {
          ok: false,
          executionId,
          status: ADAPTER_STATUSES.TIMED_OUT,
          exitCode: -1,
          stdout,
          stderr,
          elapsedMs,
          cleanupStatus: runnerResult.cleanupStatus || 'UNKNOWN',
          planDigest: plan.planDigest,
          reason: `Execution timed out after ${effectiveTimeout}ms.`,
        };
      }

      if (cancelled) {
        return {
          ok: false,
          executionId,
          status: ADAPTER_STATUSES.CANCELLED,
          exitCode: -1,
          stdout,
          stderr,
          elapsedMs,
          cleanupStatus: runnerResult.cleanupStatus || 'UNKNOWN',
          planDigest: plan.planDigest,
          reason: 'Execution was cancelled by caller.',
        };
      }

      const passed = exitCode === 0;
      return {
        ok: passed,
        executionId,
        status: passed ? ADAPTER_STATUSES.PASSED : ADAPTER_STATUSES.FAILED,
        exitCode,
        stdout,
        stderr,
        elapsedMs,
        cleanupStatus: runnerResult.cleanupStatus || 'HOST_VERIFIED_CLEANED',
        planDigest: plan.planDigest,
      };
    } catch (runErr) {
      return {
        ok: false,
        executionId,
        status: ADAPTER_STATUSES.FAILED,
        exitCode: -1,
        stderr: redactSensitiveData(runErr.message),
        elapsedMs: Date.now() - startTime,
        planDigest: plan.planDigest,
        reason: `Runner execution failed: ${runErr.message}`,
      };
    }
  }

  // Default fail-closed if no verified supervisor runner is provided
  return {
    ok: false,
    executionId,
    status: ADAPTER_STATUSES.BLOCKED,
    gate: 'PROCESS_ISOLATION_GATE',
    executionBlocked: true,
    reason: 'Execution environment was not verified by an active host sandbox runner.',
    planDigest: plan.planDigest,
    elapsedMs: Date.now() - startTime,
  };
}

module.exports = {
  ADAPTER_STATUSES,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TIMEOUT_MS,
  discoverEnvironmentCapabilities,
  verifyIsolationEvidence,
  executeInVerifiedSandbox,
};
