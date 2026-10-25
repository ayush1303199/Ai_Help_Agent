/**
 * AI Help Agent - Worker Authorization Contract (V8)
 *
 * Defines and validates execution authorization, capability grants, project-root bindings,
 * plan digest bindings, and isolation evidence requirements at the trusted boundary.
 */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { verifyIsolationEvidence } = require('./sandboxExecutionAdapter.cjs');
const { redactSensitiveData } = require('./diagnosticEngine.cjs');

const WORKER_CAPABILITIES = Object.freeze({
  READ: 'READ',
  ANALYZE: 'ANALYZE',
  PROPOSE: 'PROPOSE',
  APPLY_PATCH: 'APPLY_PATCH',
  EXECUTE_COMMAND: 'EXECUTE_COMMAND',
});

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000; // 15 minutes default
const MAX_GRANT_TTL_MS = 60 * 60 * 1000;      // 1 hour maximum

function computeGrantDigest(grant) {
  const canonical = {
    grantId: grant.grantId,
    workerId: grant.workerId,
    workflowId: grant.workflowId,
    sessionId: grant.sessionId,
    ownerWebContentsId: grant.ownerWebContentsId,
    projectRoot: path.normalize(grant.projectIdentity?.projectRoot || ''),
    projectHash: grant.projectIdentity?.projectHash || '',
    permittedCapabilities: [...(grant.permittedCapabilities || [])].sort(),
    permittedScope: [...(grant.permittedScope || [])].sort(),
    approvedPlanDigest: grant.approvedPlanDigest || null,
    providerId: grant.providerId || null,
    isolationVerified: Boolean(grant.isolationVerified),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    revoked: Boolean(grant.revoked),
    correlationId: grant.correlationId,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Creates an authorized worker grant.
 */
function createWorkerAuthorizationGrant({
  workerId,
  workflowId,
  sessionId,
  ownerWebContentsId,
  projectIdentity,
  permittedCapabilities = [WORKER_CAPABILITIES.READ, WORKER_CAPABILITIES.ANALYZE],
  permittedScope = ['*'],
  approvedPlanDigest = null,
  providerId = 'local-desktop-broker',
  isolationEvidence = null,
  ttlMs = DEFAULT_GRANT_TTL_MS,
  correlationId = null,
}) {
  if (!workerId || typeof workerId !== 'string') {
    throw new Error('createWorkerAuthorizationGrant requires non-empty workerId.');
  }
  if (!workflowId || typeof workflowId !== 'string') {
    throw new Error('createWorkerAuthorizationGrant requires non-empty workflowId.');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('createWorkerAuthorizationGrant requires non-empty sessionId.');
  }
  if (ownerWebContentsId === undefined || !Number.isInteger(ownerWebContentsId)) {
    throw new Error('createWorkerAuthorizationGrant requires integer ownerWebContentsId.');
  }
  if (!projectIdentity || !projectIdentity.projectRoot) {
    throw new Error('createWorkerAuthorizationGrant requires projectIdentity with projectRoot.');
  }

  const normalizedCaps = Array.isArray(permittedCapabilities)
    ? [...new Set(permittedCapabilities.filter((c) => WORKER_CAPABILITIES[c]))]
    : [];

  // Check isolation if EXECUTE_COMMAND capability requested
  let isolationVerified = false;
  if (normalizedCaps.includes(WORKER_CAPABILITIES.EXECUTE_COMMAND)) {
    const isoCheck = verifyIsolationEvidence(isolationEvidence);
    isolationVerified = Boolean(isoCheck.isVerified);
  }

  const effectiveTtl = Math.max(1, Math.min(ttlMs || DEFAULT_GRANT_TTL_MS, MAX_GRANT_TTL_MS));
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + effectiveTtl).toISOString();

  const grant = {
    grantId: `grant-${crypto.randomUUID()}`,
    workerId: String(workerId),
    workflowId: String(workflowId),
    sessionId: String(sessionId),
    ownerWebContentsId,
    projectIdentity: {
      projectRoot: path.normalize(projectIdentity.projectRoot),
      projectHash: projectIdentity.projectHash || crypto.createHash('sha256').update(path.normalize(projectIdentity.projectRoot)).digest('hex'),
    },
    permittedCapabilities: normalizedCaps,
    permittedScope: Array.isArray(permittedScope) ? [...permittedScope] : ['*'],
    approvedPlanDigest: approvedPlanDigest ? String(approvedPlanDigest) : null,
    providerId: String(providerId),
    isolationEvidence: isolationEvidence ? redactSensitiveData(isolationEvidence) : null,
    isolationVerified,
    issuedAt,
    expiresAt,
    revoked: false,
    revocationReason: null,
    correlationId: correlationId || `corr-${crypto.randomUUID()}`,
    grantDigest: '',
  };

  grant.grantDigest = computeGrantDigest(grant);
  return grant;
}

/**
 * Validates a worker grant against security boundaries and invocation context.
 */
function validateWorkerAuthorizationGrant(grant, context = {}) {
  if (!grant || typeof grant !== 'object') {
    return { ok: false, status: 'BLOCKED', reason: 'Authorization grant is missing or null.' };
  }

  // 1. Grant structure validation
  if (!grant.grantId || !grant.workerId || !grant.workflowId || !grant.projectIdentity?.projectRoot) {
    return { ok: false, status: 'BLOCKED', reason: 'Malformed authorization grant: missing required identifiers.' };
  }

  // 2. Cryptographic digest validation (tamper protection)
  const computed = computeGrantDigest(grant);
  if (computed !== grant.grantDigest) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: 'Authorization grant digest mismatch: grant has been tampered with or corrupted.',
      tampered: true,
    };
  }

  // 3. Expiry check
  const expiryTime = Date.parse(grant.expiresAt);
  if (Number.isNaN(expiryTime) || Date.now() > expiryTime) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: `Authorization grant expired at ${grant.expiresAt}.`,
      expired: true,
    };
  }

  // 4. Revocation check
  if (grant.revoked) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: `Authorization grant was revoked: ${grant.revocationReason || 'No reason provided.'}`,
      revoked: true,
    };
  }

  // 5. Contextual Binding Checks (if context is supplied)
  if (context.workflowId && context.workflowId !== grant.workflowId) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: `Workflow binding mismatch: grant is for ${grant.workflowId}, context is ${context.workflowId}`,
    };
  }

  if (context.sessionId && context.sessionId !== grant.sessionId) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: `Session ownership mismatch: grant is for session ${grant.sessionId}, caller is ${context.sessionId}`,
    };
  }

  if (context.ownerWebContentsId !== undefined && context.ownerWebContentsId !== grant.ownerWebContentsId) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: `Renderer webContents mismatch: grant owned by ${grant.ownerWebContentsId}, caller is ${context.ownerWebContentsId}`,
    };
  }

  if (context.projectRoot) {
    const normContextRoot = path.normalize(context.projectRoot).toLowerCase();
    const normGrantRoot = path.normalize(grant.projectIdentity.projectRoot).toLowerCase();
    if (normContextRoot !== normGrantRoot) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Project root mismatch: grant bound to ${grant.projectIdentity.projectRoot}, context target is ${context.projectRoot}`,
      };
    }
  }

  // 6. Capability check
  if (context.requiredCapability) {
    if (!grant.permittedCapabilities.includes(context.requiredCapability)) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Unauthorized capability: worker lacks "${context.requiredCapability}" capability (has: ${grant.permittedCapabilities.join(', ') || 'none'}).`,
        unauthorizedCapability: true,
      };
    }

    // High-privilege capability gates
    if (context.requiredCapability === WORKER_CAPABILITIES.EXECUTE_COMMAND) {
      if (!grant.isolationVerified) {
        return {
          ok: false,
          status: 'BLOCKED',
          gate: 'PROCESS_ISOLATION_GATE',
          reason: 'Command execution blocked: worker does not possess verified process isolation evidence.',
          isolationBlocked: true,
        };
      }
    }

    if (context.requiredCapability === WORKER_CAPABILITIES.APPLY_PATCH) {
      if (!grant.approvedPlanDigest) {
        return {
          ok: false,
          status: 'BLOCKED',
          reason: 'Patch application blocked: grant has no bound approved plan digest.',
        };
      }
      if (context.planDigest && context.planDigest !== grant.approvedPlanDigest) {
        return {
          ok: false,
          status: 'BLOCKED',
          reason: `Approved plan digest mismatch: grant bound to ${grant.approvedPlanDigest}, caller supplied ${context.planDigest}`,
        };
      }
    }
  }

  // 7. Scope boundary check (path traversal & target scope)
  if (Array.isArray(context.targetFiles) && context.targetFiles.length > 0) {
    if (!grant.permittedScope.includes('*')) {
      for (const target of context.targetFiles) {
        const normTarget = path.normalize(target).replace(/^[\\/]+/, '');
        if (normTarget.startsWith('..') || path.isAbsolute(normTarget)) {
          return {
            ok: false,
            status: 'BLOCKED',
            reason: `Path traversal violation: target "${target}" escapes project root.`,
          };
        }
        const inScope = grant.permittedScope.some((s) => {
          const normScope = path.normalize(s).replace(/^[\\/]+/, '');
          return normTarget === normScope || normTarget.startsWith(normScope + path.sep);
        });
        if (!inScope) {
          return {
            ok: false,
            status: 'BLOCKED',
            reason: `Scope escalation rejected: target file "${target}" is outside worker permitted scope (${grant.permittedScope.join(', ')}).`,
          };
        }
      }
    }
  }

  return { ok: true, grant };
}

module.exports = {
  WORKER_CAPABILITIES,
  DEFAULT_GRANT_TTL_MS,
  MAX_GRANT_TTL_MS,
  computeGrantDigest,
  createWorkerAuthorizationGrant,
  validateWorkerAuthorizationGrant,
};
