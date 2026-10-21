'use strict';

const crypto = require('node:crypto');
const {
  createInlineProposalEnvelope,
  diagnosticSnapshot,
  resolveInlineApproval,
} = require('./inlineInteractionEngine.cjs');

function createInlineWorkflowApprovalBroker({ timeoutMs = 5 * 60 * 1000 } = {}) {
  const pending = new Map();

  const settle = (approvalRequestId, decision) => {
    const request = pending.get(approvalRequestId);
    if (!request) return false;
    pending.delete(approvalRequestId);
    clearTimeout(request.timer);
    request.resolve(decision);
    return true;
  };

  return {
    request({
      webContents,
      workflowRequestId,
      proposalId,
      proposalDigest,
      fileOperations,
      diff,
      deleteConfirmationRequired = false,
      projectId = null,
      sessionId = null,
      validateSnapshots = async () => true,
      onTransition,
    }) {
      if (!webContents || webContents.isDestroyed?.()
        || typeof workflowRequestId !== 'string'
        || typeof proposalId !== 'string'
        || typeof proposalDigest !== 'string'
        || !/^[a-f0-9]{64}$/i.test(proposalDigest)
        || !Array.isArray(fileOperations)
        || typeof diff !== 'string'
        || !diff.trim()) {
        throw new Error('The inline proposal review could not be bound to a valid renderer and proposal.');
      }

      const approvalRequestId = crypto.randomUUID();
      const proposalEnvelope = createInlineProposalEnvelope({
        proposalId,
        proposalDigest,
        fileOperations,
        diff,
      }, { projectId, sessionId });
      onTransition?.(diagnosticSnapshot(proposalEnvelope, 'AWAITING_INLINE_APPROVAL'));
      let resolveDecision;
      const promise = new Promise((resolve) => {
        resolveDecision = resolve;
      });
      const timer = setTimeout(() => {
        settle(approvalRequestId, { approved: false, deleteConfirmed: false, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      pending.set(approvalRequestId, {
        webContentsId: webContents.id,
        workflowRequestId,
        proposalId,
        proposalDigest,
        projectId,
        sessionId,
        envelope: proposalEnvelope,
        deleteConfirmationRequired,
        validateSnapshots,
        onTransition,
        resolve: resolveDecision,
        timer,
      });

      try {
        webContents.send('developer:workflow-approval-pending', {
          approvalRequestId,
          workflowRequestId,
          proposalId,
          proposalDigest,
          fileOperations,
          diff,
          deleteConfirmationRequired,
          envelope: proposalEnvelope,
        });
      } catch (error) {
        settle(approvalRequestId, { approved: false, deleteConfirmed: false });
        throw error;
      }
      return { approvalRequestId, promise };
    },

    async decide({
      webContentsId,
      approvalRequestId,
      proposalId,
      proposalDigest,
      approved,
      deleteConfirmed = false,
    }) {
      const request = pending.get(approvalRequestId);
      if (!request
        || request.webContentsId !== webContentsId
        || request.proposalId !== proposalId
        || request.proposalDigest !== proposalDigest
        || typeof approved !== 'boolean'
        || typeof deleteConfirmed !== 'boolean'
        || (approved && request.deleteConfirmationRequired && !deleteConfirmed)) {
        throw new Error('The inline approval decision does not match the active proposal or renderer.');
      }
      try {
        const decisionResult = await resolveInlineApproval(request.envelope, {
          action: approved ? 'approve' : 'reject',
          deleteConfirmed,
        }, {
          assertSessionOwnership: (envelope) => ({
            sessionId: request.sessionId,
            projectId: request.projectId,
            owned: request.webContentsId === webContentsId
              && request.proposalId === envelope.proposalId,
          }),
          validateProposalDigest: (envelope) => (
            request.proposalDigest === envelope.proposalDigest
          ),
          validateSnapshots: request.validateSnapshots,
          resolveDecision: (_envelope, decision) => {
            if (pending.get(approvalRequestId) !== request) {
              throw new Error('The inline proposal approval is no longer active.');
            }
            settle(approvalRequestId, decision);
            return { decisionAccepted: true, approved: decision.approved };
          },
          onTransition: (snapshot) => request.onTransition?.(snapshot),
        });
        return decisionResult || { decisionAccepted: true, approved };
      } catch (error) {
        if (pending.get(approvalRequestId) === request
          && (error?.code === 'STALE_PROPOSAL_DRIFT'
            || /snapshot.*changed|project files changed/i.test(error?.message || ''))) {
          settle(approvalRequestId, {
            approved: false,
            deleteConfirmed: false,
            rejectionReason: error.message,
          });
        }
        throw error;
      }
    },

    cancel(approvalRequestId, webContentsId) {
      const request = pending.get(approvalRequestId);
      if (!request || request.webContentsId !== webContentsId) return false;
      return settle(approvalRequestId, { approved: false, deleteConfirmed: false });
    },
  };
}

module.exports = { createInlineWorkflowApprovalBroker };
