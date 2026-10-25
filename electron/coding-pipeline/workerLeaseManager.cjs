/**
 * AI Help Agent - Worker Lease & Cancellation Manager (V8)
 *
 * Manages worker lease lifecycles, event sequence ordering, cancellation propagation,
 * and unresolved outcome reconciliation at the trusted boundary.
 */

'use strict';

const crypto = require('node:crypto');
const { validateWorkerAuthorizationGrant, WORKER_CAPABILITIES } = require('./workerAuthorizationContract.cjs');

const LEASE_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  CANCELLATION_PENDING: 'CANCELLATION_PENDING',
  CANCELLED: 'CANCELLED',
  UNRESOLVED_CANCELLATION: 'UNRESOLVED_CANCELLATION',
});

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes default
const DEFAULT_CANCELLATION_TIMEOUT_MS = 5000; // 5 seconds for worker ACK

class WorkerLeaseManager {
  constructor({ journal = null } = {}) {
    this.journal = journal;
    this.leases = new Map();
    this.workerSequences = new Map();
  }

  /**
   * Creates a worker lease bound to an authorized grant.
   */
  createWorkerLease({
    grant,
    context = {},
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  }) {
    // 1. Validate authorization grant before issuing any lease
    const authResult = validateWorkerAuthorizationGrant(grant, context);
    if (!authResult.ok) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Worker lease denied: ${authResult.reason}`,
        gate: authResult.gate || 'AUTHORIZATION_GATE',
        authResult,
      };
    }

    const leaseId = `lease-${crypto.randomUUID()}`;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + Math.min(leaseTtlMs, DEFAULT_LEASE_TTL_MS);

    const lease = {
      leaseId,
      workerId: grant.workerId,
      workflowId: grant.workflowId,
      grantId: grant.grantId,
      grantDigest: grant.grantDigest,
      projectRoot: grant.projectIdentity.projectRoot,
      permittedCapabilities: [...grant.permittedCapabilities],
      permittedScope: [...grant.permittedScope],
      approvedPlanDigest: grant.approvedPlanDigest,
      isolationVerified: grant.isolationVerified,
      state: LEASE_STATES.ACTIVE,
      issuedAt,
      expiresAt,
      cancelledAt: null,
      cancelReason: null,
      cancellationAcknowledged: false,
      cancellationAckTime: null,
      lastEventSequence: 0,
      mutationsPerformed: [],
    };

    this.leases.set(leaseId, lease);
    this.workerSequences.set(leaseId, 0);

    return {
      ok: true,
      leaseId,
      lease,
    };
  }

  /**
   * Validates if a worker lease is currently active and authorized for a requested action.
   */
  validateWorkerLease(leaseId, { requiredCapability = null, targetFiles = [] } = {}) {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { ok: false, status: 'BLOCKED', reason: `Unknown worker lease: ${leaseId}` };
    }

    // Expiry check
    if (Date.now() > lease.expiresAt) {
      lease.state = LEASE_STATES.EXPIRED;
      return { ok: false, status: 'BLOCKED', reason: `Worker lease ${leaseId} has expired.`, expired: true };
    }

    // Revocation / Cancellation check
    if (lease.state === LEASE_STATES.REVOKED) {
      return { ok: false, status: 'BLOCKED', reason: `Worker lease ${leaseId} is revoked.`, revoked: true };
    }

    if (lease.state === LEASE_STATES.CANCELLED || lease.state === LEASE_STATES.CANCELLATION_PENDING) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Worker lease ${leaseId} has been cancelled; new actions are blocked.`,
        cancelled: true,
      };
    }

    if (lease.state === LEASE_STATES.UNRESOLVED_CANCELLATION) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Worker lease ${leaseId} is in unresolved cancellation state; reconciliation required.`,
        unresolved: true,
      };
    }

    // Capability check
    if (requiredCapability && !lease.permittedCapabilities.includes(requiredCapability)) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Lease lacks capability "${requiredCapability}".`,
        unauthorizedCapability: true,
      };
    }

    // High privilege isolation check
    if (requiredCapability === WORKER_CAPABILITIES.EXECUTE_COMMAND && !lease.isolationVerified) {
      return {
        ok: false,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        reason: 'Command execution blocked: lease does not possess verified process isolation.',
        isolationBlocked: true,
      };
    }

    return { ok: true, lease };
  }

  /**
   * Processes an incoming worker event with sequence checking and anti-replay protection.
   */
  handleWorkerEvent(leaseId, event) {
    const validation = this.validateWorkerLease(leaseId, {
      requiredCapability: event?.requiredCapability,
      targetFiles: event?.targetFiles,
    });
    if (!validation.ok) {
      return validation;
    }

    const lease = validation.lease;
    const lastSeq = this.workerSequences.get(leaseId) || 0;
    const incomingSeq = Number(event?.sequenceNumber);

    if (!Number.isInteger(incomingSeq) || incomingSeq <= 0) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: 'Malformed worker event: valid positive sequenceNumber is required.',
      };
    }

    // Replay or duplicate check
    if (incomingSeq === lastSeq) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Replayed worker event detected: sequenceNumber=${incomingSeq} has already been processed.`,
        replayed: true,
      };
    }

    // Out-of-order check
    if (incomingSeq < lastSeq) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `Out-of-order worker event rejected: incoming=${incomingSeq} < lastProcessed=${lastSeq}.`,
        outOfOrder: true,
      };
    }

    // Accept event and advance sequence
    this.workerSequences.set(leaseId, incomingSeq);
    lease.lastEventSequence = incomingSeq;

    if (event.mutation) {
      lease.mutationsPerformed.push({
        sequence: incomingSeq,
        timestamp: new Date().toISOString(),
        details: event.mutation,
      });
    }

    return {
      ok: true,
      leaseId,
      sequenceNumber: incomingSeq,
      accepted: true,
    };
  }

  /**
   * Propagates cancellation to an active worker lease.
   */
  requestCancellation(leaseId, reason = 'User or coordinator requested cancellation.') {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { ok: false, reason: `Lease not found: ${leaseId}` };
    }

    lease.state = LEASE_STATES.CANCELLATION_PENDING;
    lease.cancelledAt = Date.now();
    lease.cancelReason = String(reason);

    return {
      ok: true,
      leaseId,
      status: LEASE_STATES.CANCELLATION_PENDING,
      message: 'Cancellation requested; awaiting worker acknowledgement.',
    };
  }

  /**
   * Worker acknowledges cancellation.
   */
  acknowledgeCancellation(leaseId, { workerId } = {}) {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { ok: false, reason: `Lease not found: ${leaseId}` };
    }
    if (workerId && workerId !== lease.workerId) {
      return { ok: false, reason: 'Worker identity mismatch during cancellation ACK.' };
    }

    lease.state = LEASE_STATES.CANCELLED;
    lease.cancellationAcknowledged = true;
    lease.cancellationAckTime = Date.now();

    return {
      ok: true,
      leaseId,
      status: LEASE_STATES.CANCELLED,
      message: 'Cancellation acknowledged by worker.',
    };
  }

  /**
   * Checks cancellation status. If timeout elapsed without worker ACK, marks as UNRESOLVED_CANCELLATION.
   */
  evaluateCancellationStatus(leaseId, timeoutMs = DEFAULT_CANCELLATION_TIMEOUT_MS) {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { ok: false, reason: `Lease not found: ${leaseId}` };
    }

    if (lease.state === LEASE_STATES.CANCELLED) {
      return { ok: true, status: LEASE_STATES.CANCELLED, acknowledged: true };
    }

    if (lease.state === LEASE_STATES.CANCELLATION_PENDING) {
      const elapsed = Date.now() - (lease.cancelledAt || Date.now());
      if (elapsed >= timeoutMs) {
        // Missing ACK: cannot claim successful cancellation!
        lease.state = LEASE_STATES.UNRESOLVED_CANCELLATION;
        return {
          ok: false,
          status: LEASE_STATES.UNRESOLVED_CANCELLATION,
          acknowledged: false,
          reason: `Worker failed to acknowledge cancellation within ${timeoutMs}ms. Outcome is unresolved.`,
          requiresReconciliation: true,
        };
      }
      return { ok: true, status: LEASE_STATES.CANCELLATION_PENDING, acknowledged: false };
    }

    return { ok: true, status: lease.state };
  }

  /**
   * Revokes a worker lease immediately.
   */
  revokeLease(leaseId, reason = 'Lease revoked by coordinator.') {
    const lease = this.leases.get(leaseId);
    if (!lease) return { ok: false, reason: 'Lease not found.' };

    lease.state = LEASE_STATES.REVOKED;
    return { ok: true, leaseId, status: LEASE_STATES.REVOKED, reason };
  }
}

function createWorkerLeaseManager(params) {
  return new WorkerLeaseManager(params);
}

module.exports = {
  LEASE_STATES,
  WorkerLeaseManager,
  createWorkerLeaseManager,
};
