/**
 * AI Help Agent - Workflow State Coordinator (V6)
 *
 * Manages explicit lifecycle states, valid state transitions, cross-stage evidence binding,
 * project identity verification, and idempotent state recovery for autonomous coding tasks.
 */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const WORKFLOW_STATES = Object.freeze({
  REQUEST_RECEIVED: 'REQUEST_RECEIVED',
  INTENT_CLASSIFIED: 'INTENT_CLASSIFIED',
  PROJECT_AUTHORIZED: 'PROJECT_AUTHORIZED',
  DISCOVERY_COMPLETED: 'DISCOVERY_COMPLETED',
  PLAN_CREATED: 'PLAN_CREATED',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVED: 'APPROVED',
  APPLYING: 'APPLYING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  CLARIFICATION_REQUIRED: 'CLARIFICATION_REQUIRED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  ROLLBACK_REQUIRED: 'ROLLBACK_REQUIRED',
  UNCERTAIN: 'UNCERTAIN',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
});

const TERMINAL_STATES = new Set([
  WORKFLOW_STATES.COMPLETED,
  WORKFLOW_STATES.PARTIALLY_COMPLETED,
  WORKFLOW_STATES.BLOCKED,
  WORKFLOW_STATES.CANCELLED,
  WORKFLOW_STATES.FAILED,
  WORKFLOW_STATES.CLARIFICATION_REQUIRED,
  WORKFLOW_STATES.UNCERTAIN,
]);

/**
 * Explicit state transition table.
 * Every forward and recovery edge is defined here.
 */
const VALID_TRANSITIONS = Object.freeze({
  [WORKFLOW_STATES.REQUEST_RECEIVED]: new Set([
    WORKFLOW_STATES.INTENT_CLASSIFIED,
    WORKFLOW_STATES.CLARIFICATION_REQUIRED,
    WORKFLOW_STATES.BLOCKED,
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.INTENT_CLASSIFIED]: new Set([
    WORKFLOW_STATES.PROJECT_AUTHORIZED,
    WORKFLOW_STATES.CLARIFICATION_REQUIRED,
    WORKFLOW_STATES.BLOCKED,
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.PROJECT_AUTHORIZED]: new Set([
    WORKFLOW_STATES.DISCOVERY_COMPLETED,
    WORKFLOW_STATES.BLOCKED,
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.DISCOVERY_COMPLETED]: new Set([
    WORKFLOW_STATES.PLAN_CREATED,
    WORKFLOW_STATES.COMPLETED, // Read-only query / explain after discovery
    WORKFLOW_STATES.BLOCKED,   // Dependency or prerequisite missing
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.PLAN_CREATED]: new Set([
    WORKFLOW_STATES.APPROVAL_PENDING,
    WORKFLOW_STATES.BLOCKED,   // Isolation gate blocked or prerequisites unfulfilled
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.APPROVAL_PENDING]: new Set([
    WORKFLOW_STATES.APPROVED,
    WORKFLOW_STATES.BLOCKED,   // User denied approval
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.APPROVED]: new Set([
    WORKFLOW_STATES.APPLYING,
    WORKFLOW_STATES.VERIFYING, // Read-only plans (e.g. build / test plan without mutation)
    WORKFLOW_STATES.BLOCKED,   // Workspace drift detected before apply
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.APPLYING]: new Set([
    WORKFLOW_STATES.VERIFYING,
    WORKFLOW_STATES.ROLLBACK_REQUIRED,
    WORKFLOW_STATES.BLOCKED,
    WORKFLOW_STATES.CANCELLED,
    WORKFLOW_STATES.FAILED,
  ]),
  [WORKFLOW_STATES.ROLLBACK_REQUIRED]: new Set([
    WORKFLOW_STATES.FAILED,
    WORKFLOW_STATES.BLOCKED,
    WORKFLOW_STATES.CANCELLED,
  ]),
  [WORKFLOW_STATES.VERIFYING]: new Set([
    WORKFLOW_STATES.COMPLETED,
    WORKFLOW_STATES.PARTIALLY_COMPLETED,
    WORKFLOW_STATES.ROLLBACK_REQUIRED,
    WORKFLOW_STATES.FAILED,
    WORKFLOW_STATES.BLOCKED,
    WORKFLOW_STATES.UNCERTAIN,
    WORKFLOW_STATES.CANCELLED,
  ]),
  // Terminal states cannot transition to other states
  [WORKFLOW_STATES.COMPLETED]: new Set([]),
  [WORKFLOW_STATES.PARTIALLY_COMPLETED]: new Set([]),
  [WORKFLOW_STATES.BLOCKED]: new Set([]),
  [WORKFLOW_STATES.CANCELLED]: new Set([]),
  [WORKFLOW_STATES.FAILED]: new Set([]),
  [WORKFLOW_STATES.CLARIFICATION_REQUIRED]: new Set([]),
  [WORKFLOW_STATES.UNCERTAIN]: new Set([]),
});

/**
 * Standardized Stage Evidence Contract (Step 4)
 */
function createStageEvidenceRecord({
  workflowId,
  stage,
  status,
  projectIdentity,
  inputEvidence = {},
  outputEvidence = {},
  reason = null,
  limitations = [],
  plannedCommands = [],
  executedCommands = [],
  proposedChanges = [],
  approvedChanges = [],
  appliedPatches = [],
  staticChecks = [],
  runtimeExecution = null,
  isSimulated = false,
}) {
  return {
    workflowId,
    stage: String(stage),
    status: String(status),
    projectIdentity: projectIdentity ? { ...projectIdentity } : null,
    inputEvidence: inputEvidence ? { ...inputEvidence } : {},
    outputEvidence: outputEvidence ? { ...outputEvidence } : {},
    reason: reason ? String(reason) : null,
    limitations: Array.isArray(limitations) ? [...limitations] : [],
    plannedCommands: Array.isArray(plannedCommands) ? [...plannedCommands] : [],
    executedCommands: Array.isArray(executedCommands) ? [...executedCommands] : [],
    proposedChanges: Array.isArray(proposedChanges) ? [...proposedChanges] : [],
    approvedChanges: Array.isArray(approvedChanges) ? [...approvedChanges] : [],
    appliedPatches: Array.isArray(appliedPatches) ? [...appliedPatches] : [],
    staticChecks: Array.isArray(staticChecks) ? [...staticChecks] : [],
    runtimeExecution: runtimeExecution ? { ...runtimeExecution } : null,
    isSimulated: Boolean(isSimulated),
    recordedAt: new Date().toISOString(),
  };
}

class WorkflowStateCoordinator {
  constructor({
    workflowId = null,
    projectIdentity,
    originalRequest,
    constraints = [],
  }) {
    if (!originalRequest || typeof originalRequest !== 'string') {
      throw new Error('WorkflowStateCoordinator requires non-empty originalRequest string.');
    }
    if (!projectIdentity || !projectIdentity.projectRoot) {
      throw new Error('WorkflowStateCoordinator requires valid projectIdentity with projectRoot.');
    }

    this.workflowId = workflowId || `wf-${crypto.randomUUID()}`;
    this.projectIdentity = Object.freeze({
      projectRoot: path.normalize(projectIdentity.projectRoot),
      sessionId: projectIdentity.sessionId || null,
      ownerWebContentsId: projectIdentity.ownerWebContentsId ?? null,
      projectHash: projectIdentity.projectHash || crypto.createHash('sha256').update(path.normalize(projectIdentity.projectRoot)).digest('hex'),
    });
    this.originalRequest = String(originalRequest);
    this.constraints = Object.freeze(Array.isArray(constraints) ? [...constraints] : []);

    this.currentState = WORKFLOW_STATES.REQUEST_RECEIVED;
    this.history = [];
    this.stageEvidence = new Map();
    this.idempotencyTokens = new Set();
    this.boundProposal = null;
    this.appliedPatches = [];
    this.cancelled = false;
    this.cancelReason = null;

    this._recordTransition(null, WORKFLOW_STATES.REQUEST_RECEIVED, {
      reason: 'Workflow initialized from user request.',
      authorizedBy: 'USER_REQUEST',
    });
  }

  getWorkflowId() {
    return this.workflowId;
  }

  getState() {
    return this.currentState;
  }

  getProjectIdentity() {
    return this.projectIdentity;
  }

  getOriginalRequest() {
    return this.originalRequest;
  }

  getConstraints() {
    return this.constraints;
  }

  isTerminal() {
    return TERMINAL_STATES.has(this.currentState);
  }

  isCancelled() {
    return this.cancelled || this.currentState === WORKFLOW_STATES.CANCELLED;
  }

  /**
   * Validates that project identity matches the authorized session project.
   */
  validateProjectIdentity(identity) {
    if (!identity || !identity.projectRoot) {
      return { ok: false, reason: 'Missing project root in caller identity.' };
    }
    const normalizedTarget = path.normalize(identity.projectRoot);
    if (normalizedTarget.toLowerCase() !== this.projectIdentity.projectRoot.toLowerCase()) {
      return {
        ok: false,
        reason: `Project root mismatch: authorized=${this.projectIdentity.projectRoot}, caller=${normalizedTarget}`,
      };
    }
    if (identity.sessionId && this.projectIdentity.sessionId && identity.sessionId !== this.projectIdentity.sessionId) {
      return { ok: false, reason: 'Session ID mismatch.' };
    }
    return { ok: true };
  }

  /**
   * Attempts a state transition.
   * Rejects invalid or stale transitions.
   * Handles idempotency keys so repeated calls don't duplicate mutations or corrupt state.
   */
  transitionTo(targetState, {
    reason = '',
    evidence = null,
    authorizedBy = 'PIPELINE',
    idempotencyKey = null,
  } = {}) {
    if (!WORKFLOW_STATES[targetState]) {
      return {
        ok: false,
        error: `Unknown target state: ${targetState}`,
        currentState: this.currentState,
      };
    }

    // Idempotent retry: if already at target state and matching token or same state requested
    if (this.currentState === targetState) {
      if (idempotencyKey) {
        this.idempotencyTokens.add(idempotencyKey);
      }
      return {
        ok: true,
        idempotent: true,
        currentState: this.currentState,
        message: `Already in state ${targetState}. Transition is idempotent.`,
      };
    }

    // Check for duplicate idempotency key on a different state
    if (idempotencyKey && this.idempotencyTokens.has(idempotencyKey)) {
      return {
        ok: false,
        error: `Duplicate transition with key ${idempotencyKey} already consumed.`,
        currentState: this.currentState,
      };
    }

    // If workflow was cancelled, reject transitions
    if (this.isCancelled()) {
      return {
        ok: false,
        error: `Workflow is cancelled; cannot transition to ${targetState}.`,
        currentState: this.currentState,
      };
    }

    // Check valid transitions
    const validNextStates = VALID_TRANSITIONS[this.currentState] || new Set();
    if (!validNextStates.has(targetState)) {
      return {
        ok: false,
        error: `Illegal state transition from ${this.currentState} to ${targetState}.`,
        currentState: this.currentState,
        validNextStates: Array.from(validNextStates),
      };
    }

    const previousState = this.currentState;
    this.currentState = targetState;

    if (idempotencyKey) {
      this.idempotencyTokens.add(idempotencyKey);
    }

    if (targetState === WORKFLOW_STATES.CANCELLED) {
      this.cancelled = true;
      this.cancelReason = reason || 'User or system cancellation.';
    }

    this._recordTransition(previousState, targetState, {
      reason,
      evidenceRef: evidence ? (evidence.stage || evidence.types || 'EVIDENCE') : null,
      authorizedBy,
    });

    if (evidence) {
      this.recordEvidence(targetState, evidence);
    }

    return {
      ok: true,
      previousState,
      currentState: this.currentState,
    };
  }

  /**
   * Binds an approved proposal to the workflow.
   * Guarantees that only the approved patch and digests can be applied.
   */
  bindProposal({
    proposalId,
    planDigest,
    targets = [],
    diff = '',
    snapshotDigests = [],
  }) {
    if (!proposalId || !planDigest) {
      throw new Error('Proposal binding requires proposalId and planDigest.');
    }
    this.boundProposal = Object.freeze({
      proposalId,
      planDigest,
      targets: Object.freeze([...targets]),
      diffSha256: crypto.createHash('sha256').update(diff || '').digest('hex'),
      snapshotDigests: Object.freeze([...snapshotDigests]),
      boundAt: new Date().toISOString(),
    });
  }

  /**
   * Verifies that the patch attempting to be applied matches the bound proposal.
   */
  validateProposalBinding({ proposalId, planDigest, diff = null }) {
    if (!this.boundProposal) {
      return { ok: false, reason: 'No proposal has been bound to this workflow.' };
    }
    if (this.boundProposal.proposalId !== proposalId) {
      return {
        ok: false,
        reason: `Proposal ID mismatch: bound=${this.boundProposal.proposalId}, requested=${proposalId}`,
      };
    }
    if (this.boundProposal.planDigest !== planDigest) {
      return {
        ok: false,
        reason: `Plan digest mismatch: bound=${this.boundProposal.planDigest}, requested=${planDigest}`,
      };
    }
    if (diff !== null) {
      const incomingSha = crypto.createHash('sha256').update(diff).digest('hex');
      if (incomingSha !== this.boundProposal.diffSha256) {
        return {
          ok: false,
          reason: 'Diff content hash does not match the approved proposal digest.',
        };
      }
    }
    return { ok: true };
  }

  /**
   * Records structured stage evidence.
   */
  recordEvidence(stage, evidence) {
    if (!stage) return;
    const stageKey = String(stage);
    const existing = this.stageEvidence.get(stageKey) || [];
    existing.push({
      ...evidence,
      recordedAt: new Date().toISOString(),
    });
    this.stageEvidence.set(stageKey, existing);
  }

  /**
   * Gets evidence for a given stage.
   */
  getEvidence(stage) {
    return this.stageEvidence.get(String(stage)) || [];
  }

  /**
   * Returns all recorded stage evidence as a map object.
   */
  getAllEvidence() {
    const result = {};
    for (const [key, records] of this.stageEvidence.entries()) {
      result[key] = records;
    }
    return result;
  }

  /**
   * Records applied patch details.
   */
  recordAppliedPatch(patchInfo) {
    this.appliedPatches.push({
      ...patchInfo,
      appliedAt: new Date().toISOString(),
    });
  }

  getAppliedPatches() {
    return [...this.appliedPatches];
  }

  /**
   * Cancels the workflow.
   */
  cancel(reason = 'Workflow cancelled by user or coordinator.') {
    if (this.isTerminal()) {
      return { ok: false, reason: `Cannot cancel workflow already in terminal state: ${this.currentState}` };
    }
    return this.transitionTo(WORKFLOW_STATES.CANCELLED, {
      reason,
      authorizedBy: 'CANCELLATION',
    });
  }

  getHistory() {
    return [...this.history];
  }

  _recordTransition(from, to, { reason = '', evidenceRef = null, authorizedBy = 'PIPELINE' } = {}) {
    this.history.push({
      from,
      to,
      timestamp: new Date().toISOString(),
      reason: String(reason || ''),
      evidenceRef,
      authorizedBy: String(authorizedBy || ''),
    });
  }
}

function createWorkflowCoordinator(params) {
  return new WorkflowStateCoordinator(params);
}

module.exports = {
  WORKFLOW_STATES,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  createStageEvidenceRecord,
  WorkflowStateCoordinator,
  createWorkflowCoordinator,
};
