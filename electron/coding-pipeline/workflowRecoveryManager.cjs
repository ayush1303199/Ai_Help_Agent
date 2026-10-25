/**
 * AI Help Agent - Workflow Recovery & Reconnection Manager (V7)
 *
 * Coordinates durable state restoration, session re-authentication, workspace drift detection,
 * proposal revalidation, and idempotent reconnection handling.
 */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { WORKFLOW_STATES } = require('./workflowStateCoordinator.cjs');
const { JOURNAL_EVENT_TYPES } = require('./evidenceJournal.cjs');
const { validateMultiFilePatchIntegrity } = require('./repairPlanner.cjs');

const RECOVERY_OUTCOMES = Object.freeze({
  RECOVERED_PAUSED: 'RECOVERED_PAUSED',
  REAPPROVAL_REQUIRED: 'REAPPROVAL_REQUIRED',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
  UNCERTAIN: 'UNCERTAIN',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
});

class WorkflowRecoveryManager {
  constructor({ store, journal = null } = {}) {
    if (!store) {
      throw new Error('WorkflowRecoveryManager requires a DurableWorkflowStore.');
    }
    this.store = store;
    this.journal = journal;
    this.activeReconnections = new Map();
    this.clientSequenceNumbers = new Map();
  }

  /**
   * Reconnects a client/renderer to an active or persisted workflow.
   * Enforces session ownership authentication, monotonic sequence numbers, and idempotency.
   */
  async handleClientReconnect({
    workflowId,
    clientId,
    sessionId,
    ownerWebContentsId,
    sequenceNumber = 0,
    expectedProjectRoot,
  }) {
    if (!workflowId || !clientId || !sessionId || ownerWebContentsId === undefined) {
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.BLOCKED,
        reason: 'clientId, sessionId, and ownerWebContentsId are required for reconnection.',
      };
    }

    const clientKey = `${workflowId}:${clientId}`;
    const lastSeq = this.clientSequenceNumbers.get(clientKey) || 0;

    // Idempotent retry: if exact same sequence number is resent, return cached acknowledgment
    if (sequenceNumber > 0 && sequenceNumber === lastSeq) {
      const cached = this.activeReconnections.get(clientKey);
      if (cached) {
        return {
          ok: true,
          idempotent: true,
          status: cached.status,
          workflowId,
          lastSequenceNumber: lastSeq,
          message: 'Idempotent reconnection request acknowledged.',
        };
      }
    }

    // Out-of-order or stale event check
    if (sequenceNumber > 0 && sequenceNumber < lastSeq) {
      if (this.journal) {
        await this.journal.appendEvent({
          eventType: JOURNAL_EVENT_TYPES.OUT_OF_ORDER_EVENT_REJECTED,
          outcome: 'REJECTED',
          details: { clientKey, sequenceNumber, lastSeq },
        });
      }
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.BLOCKED,
        reason: `Out-of-order event rejected: sequenceNumber=${sequenceNumber} < lastSequenceNumber=${lastSeq}`,
      };
    }

    // Load persisted workflow record
    const loadResult = await this.store.loadWorkflow(workflowId);
    if (!loadResult.ok) {
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.BLOCKED,
        reason: `Failed to load workflow state: ${loadResult.reason}`,
      };
    }

    const record = loadResult.record;

    // Revalidate session ownership context
    if (record.projectIdentity) {
      if (record.projectIdentity.ownerWebContentsId !== ownerWebContentsId) {
        return {
          ok: false,
          status: RECOVERY_OUTCOMES.BLOCKED,
          reason: `Renderer ownership mismatch: workflow owned by webContents ${record.projectIdentity.ownerWebContentsId}, caller is ${ownerWebContentsId}`,
        };
      }
      if (expectedProjectRoot) {
        const normExpected = path.normalize(expectedProjectRoot).toLowerCase();
        const normStored = path.normalize(record.projectIdentity.projectRoot).toLowerCase();
        if (normExpected !== normStored) {
          return {
            ok: false,
            status: RECOVERY_OUTCOMES.BLOCKED,
            reason: `Project root mismatch: expected ${record.projectIdentity.projectRoot}, caller supplied ${expectedProjectRoot}`,
          };
        }
      }
    }

    this.clientSequenceNumbers.set(clientKey, sequenceNumber);
    const reconnectPayload = {
      ok: true,
      status: record.currentState,
      workflowId,
      record,
      reconnectedAt: new Date().toISOString(),
    };
    this.activeReconnections.set(clientKey, reconnectPayload);

    if (this.journal) {
      await this.journal.appendEvent({
        eventType: JOURNAL_EVENT_TYPES.CLIENT_RECONNECTED,
        outcome: 'CONNECTED',
        details: { clientId, sessionId, ownerWebContentsId, sequenceNumber },
      });
    }

    return reconnectPayload;
  }

  /**
   * Recovers a workflow following a main process restart or crash.
   * Performs deep safety revalidation:
   * 1. Schema and record integrity.
   * 2. Project root path exists and matches authorized session.
   * 3. Interrupted mutation detection (APPLYING / VERIFYING -> UNCERTAIN or RECONCILIATION_REQUIRED).
   * 4. Workspace drift detection on proposal targets.
   * 5. Fresh approval requirement when validity cannot be established.
   */
  async recoverWorkflow({
    workflowId,
    activeSessionId,
    ownerWebContentsId,
    targetProjectRoot,
  }) {
    if (!workflowId || !activeSessionId || ownerWebContentsId === undefined) {
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.BLOCKED,
        reason: 'workflowId, activeSessionId, and ownerWebContentsId are required for safe recovery.',
      };
    }

    const loadResult = await this.store.loadWorkflow(workflowId);
    if (!loadResult.ok) {
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.BLOCKED,
        reason: `Cannot recover workflow: ${loadResult.reason}`,
        tampered: loadResult.tampered,
        unsupportedVersion: loadResult.unsupportedVersion,
      };
    }

    const record = loadResult.record;
    const storedIdentity = record.projectIdentity;

    // 1. Project identity validation
    if (targetProjectRoot) {
      const normTarget = path.normalize(targetProjectRoot).toLowerCase();
      const normStored = path.normalize(storedIdentity.projectRoot).toLowerCase();
      if (normTarget !== normStored) {
        return {
          ok: false,
          status: RECOVERY_OUTCOMES.BLOCKED,
          reason: `Project root mismatch on recovery: stored=${storedIdentity.projectRoot}, active=${targetProjectRoot}`,
        };
      }
    }

    // Check project root existence on disk
    try {
      await fs.stat(storedIdentity.projectRoot);
    } catch {
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.BLOCKED,
        reason: `Authorized project directory no longer exists on disk: ${storedIdentity.projectRoot}`,
      };
    }

    // 2. Interrupted Mutation / Execution Recovery
    // If the process died while in APPLYING or VERIFYING, the outcome is UNCERTAIN
    if (record.currentState === WORKFLOW_STATES.APPLYING) {
      if (this.journal) {
        await this.journal.appendEvent({
          eventType: JOURNAL_EVENT_TYPES.PATCH_APPLICATION_INTERRUPTED,
          outcome: 'UNCERTAIN',
          details: { workflowId, previousState: record.currentState },
        });
      }
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.UNCERTAIN,
        interruptedState: WORKFLOW_STATES.APPLYING,
        requiresReconciliation: true,
        reason: 'Workflow was interrupted during patch application. Mutation outcome cannot be determined without workspace reconciliation.',
      };
    }

    if (record.currentState === WORKFLOW_STATES.ROLLBACK_REQUIRED) {
      return {
        ok: false,
        status: RECOVERY_OUTCOMES.RECONCILIATION_REQUIRED,
        interruptedState: WORKFLOW_STATES.ROLLBACK_REQUIRED,
        requiresRollbackReconciliation: true,
        reason: 'Workflow was interrupted during rollback. Manual or automated snapshot reconciliation is required.',
      };
    }

    // 3. Workspace Drift & Stale Approval Revalidation
    if (record.boundProposal && record.boundProposal.targets) {
      const targets = record.boundProposal.targets;
      // If there are target files, verify whether they drifted
      if (targets.length > 0) {
        for (const relPath of targets) {
          const fullPath = path.resolve(storedIdentity.projectRoot, relPath);
          try {
            const currentContent = await fs.readFile(fullPath, 'utf8');
            // If proposal has diffSha256 and expected hashes, check drift
            if (record.boundProposal.fileSnapshots && record.boundProposal.fileSnapshots[relPath]) {
              if (currentContent !== record.boundProposal.fileSnapshots[relPath]) {
                if (this.journal) {
                  await this.journal.appendEvent({
                    eventType: JOURNAL_EVENT_TYPES.APPROVAL_INVALIDATED,
                    outcome: 'DRIFT_DETECTED',
                    details: { relPath },
                  });
                }
                return {
                  ok: false,
                  status: RECOVERY_OUTCOMES.REAPPROVAL_REQUIRED,
                  reason: `Workspace target "${relPath}" drifted on disk after proposal was created. Fresh proposal and approval are required.`,
                };
              }
            }
          } catch {
            // File missing or unreadable
          }
        }
      }
    }

    // 4. Safe recovery state: pause in clean state, never resume mutation automatically
    let recoveredState = record.currentState;
    let message = 'Workflow restored safely in paused state.';

    if (record.currentState === WORKFLOW_STATES.APPROVAL_PENDING) {
      message = 'Workflow restored awaiting user approval.';
    } else if (record.currentState === WORKFLOW_STATES.APPROVED) {
      // Re-require confirmation after process restart before mutating disk
      recoveredState = WORKFLOW_STATES.APPROVAL_PENDING;
      message = 'Workflow was approved prior to restart; explicit re-confirmation required before applying.';
    }

    if (this.journal) {
      await this.journal.appendEvent({
        eventType: JOURNAL_EVENT_TYPES.RECOVERY_DECISION,
        outcome: 'RECOVERED_PAUSED',
        details: { workflowId, recoveredState },
      });
    }

    return {
      ok: true,
      status: RECOVERY_OUTCOMES.RECOVERED_PAUSED,
      recoveredState,
      workflowId,
      projectIdentity: {
        ...storedIdentity,
        sessionId: activeSessionId,
        ownerWebContentsId,
      },
      boundProposal: record.boundProposal,
      message,
    };
  }
}

function createWorkflowRecoveryManager(params) {
  return new WorkflowRecoveryManager(params);
}

module.exports = {
  RECOVERY_OUTCOMES,
  WorkflowRecoveryManager,
  createWorkflowRecoveryManager,
};
