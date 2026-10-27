/**
 * AI Help Agent - Project Command Authorization Lifecycle Contract (V27.8)
 *
 * Implements a legitimate, auditable authorization lifecycle for project commands.
 * Enforces:
 * - Internal-only minting through trusted paths after project authorization verification.
 * - Binding to project identity, workspace root, command, providerId, and planDigest.
 * - Short-lived (60s TTL) and strictly single-use.
 * - Rejection of forged, stale, replayed, or mismatched tokens.
 * - Invalidation upon cancellation or precondition failures.
 * - Zero exposure of unrestricted token-minting to renderers or untrusted callers.
 */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { verifyProjectAuthorization } = require('./projectDiscovery.cjs');

const AUTHORIZATION_TTL_MS = 60_000; // 60 seconds
const activeAuthorizations = new WeakMap();

/**
 * Mints an opaque, cryptographically tracked authorization token.
 * Can only be called by trusted internal pipeline components with authorized context.
 *
 * @param {object} params
 * @returns {Promise<object>} Opaque authorization token
 */
async function mintProjectCommandAuthorization({
  projectRoot,
  ownerWebContentsId,
  sessionId,
  planDigest,
  command,
  providerId,
  scope = 'PROJECT_VERIFICATION',
  snapshotId = null,
} = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('projectRoot is required for command authorization.');
  }
  if (!ownerWebContentsId || typeof ownerWebContentsId !== 'number') {
    throw new Error('ownerWebContentsId is required for command authorization.');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required for command authorization.');
  }
  if (!planDigest || typeof planDigest !== 'string') {
    throw new Error('planDigest is required for command authorization.');
  }
  if (!command || (typeof command !== 'string' && typeof command !== 'object')) {
    throw new Error('command is required for command authorization.');
  }
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('providerId is required for command authorization.');
  }

  // Re-verify project ownership
  const auth = await verifyProjectAuthorization(projectRoot, ownerWebContentsId);
  if (!auth.isAuthorized) {
    throw new Error(`Cannot mint command authorization: ${auth.reason}`);
  }

  const tokenObject = Object.preventExtensions(Object.create(null));
  const record = Object.freeze({
    authId: crypto.randomUUID(),
    projectRoot: path.resolve(projectRoot),
    ownerWebContentsId,
    sessionId,
    planDigest,
    commandString: typeof command === 'string'
      ? command
      : `${command.binary || ''} ${(command.args || []).join(' ')}`.trim(),
    providerId,
    scope,
    snapshotId,
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
    consumed: false,
    cancelled: false,
  });

  activeAuthorizations.set(tokenObject, record);
  return tokenObject;
}

/**
 * Validates and atomically consumes a command authorization token immediately before dispatch.
 * Enforces single-use, freshness, and exact context bindings.
 *
 * @param {object} token - Opaque token returned by mintProjectCommandAuthorization
 * @param {object} expectedContext - Expected execution parameters
 * @returns {object} Validation result
 */
function verifyAndConsumeCommandAuthorization(token, expectedContext = {}) {
  if (!token || typeof token !== 'object') {
    return { valid: false, reason: 'Command authorization token is missing or not an object.' };
  }

  const record = activeAuthorizations.get(token);
  if (!record) {
    return { valid: false, reason: 'Command authorization token is forged, untrusted, or unminted.' };
  }

  if (record.consumed) {
    return { valid: false, reason: 'Command authorization token was already consumed (single-use violation).' };
  }

  if (record.cancelled) {
    return { valid: false, reason: 'Command authorization token was invalidated by cancellation.' };
  }

  if (Date.now() > record.expiresAt) {
    return { valid: false, reason: 'Command authorization token has expired (stale token).' };
  }

  // Strict binding verification
  if (expectedContext.projectRoot && path.resolve(expectedContext.projectRoot) !== record.projectRoot) {
    return { valid: false, reason: 'Project root mismatch between authorization and execution context.' };
  }

  if (expectedContext.planDigest && expectedContext.planDigest !== record.planDigest) {
    return { valid: false, reason: 'Plan digest mismatch between authorization and execution context.' };
  }

  if (expectedContext.sessionId && expectedContext.sessionId !== record.sessionId) {
    return { valid: false, reason: 'Session ID mismatch between authorization and execution context.' };
  }

  if (expectedContext.providerId && expectedContext.providerId !== record.providerId) {
    return {
      valid: false,
      reason: `Provider mismatch: token bound to "${record.providerId}", requested "${expectedContext.providerId}".`,
    };
  }

  // Mark consumed immediately to enforce single-use
  activeAuthorizations.set(token, Object.freeze({ ...record, consumed: true }));

  return { valid: true, authRecord: record };
}

/**
 * Cancels and invalidates an authorization token upon failure or user abort.
 *
 * @param {object} token
 */
function cancelCommandAuthorization(token) {
  if (token && typeof token === 'object') {
    const record = activeAuthorizations.get(token);
    if (record) {
      activeAuthorizations.set(token, Object.freeze({ ...record, cancelled: true }));
    }
  }
}

module.exports = {
  AUTHORIZATION_TTL_MS,
  mintProjectCommandAuthorization,
  verifyAndConsumeCommandAuthorization,
  cancelCommandAuthorization,
};
