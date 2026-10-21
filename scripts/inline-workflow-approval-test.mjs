import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createInlineWorkflowApprovalBroker } = require('../electron/coding-pipeline/inlineWorkflowApproval.cjs');
const {
  createInlineProposalEnvelope,
  executePostApplyVerification,
  resolveInlineApproval,
} = require('../electron/coding-pipeline/inlineInteractionEngine.cjs');

const engineEnvelope = createInlineProposalEnvelope({
  proposalId: 'proposal-engine',
  proposalDigest: 'b'.repeat(64),
  fileOperations: [{ path: 'src/created.ts', operation: 'create', content: 'export {};' }],
  diff: '+++ b/src/created.ts\n+export {};\n',
}, { projectId: 'project-engine', sessionId: 'session-engine' });
assert.equal(engineEnvelope.fileBadges[0].lineCount, 3);
assert.equal(engineEnvelope.diffPreview[0].filePath, 'src/created.ts');
const engineTransitions = [];
assert.deepEqual(await resolveInlineApproval(engineEnvelope, { action: 'approve' }, {
  assertSessionOwnership: () => ({ owned: true, projectId: 'project-engine', sessionId: 'session-engine' }),
  validateProposalDigest: () => true,
  validateSnapshots: () => true,
  resolveDecision: (_envelope, decision) => decision,
  onTransition: (snapshot) => engineTransitions.push(snapshot.stage),
}), { approved: true, deleteConfirmed: false });
assert.deepEqual(engineTransitions, ['AWAITING_INLINE_APPROVAL', 'APPLYING_FILES']);
await assert.rejects(resolveInlineApproval(engineEnvelope, { action: 'approve' }, {
  assertSessionOwnership: () => ({ owned: true, projectId: 'project-engine', sessionId: 'session-engine' }),
  validateProposalDigest: () => true,
  validateSnapshots: () => false,
  resolveDecision: () => assert.fail('A stale proposal must not be approved.'),
}), /snapshots changed/);
const rejected = await resolveInlineApproval(engineEnvelope, { action: 'reject' }, {
  assertSessionOwnership: () => ({ owned: true, projectId: 'project-engine', sessionId: 'session-engine' }),
  validateProposalDigest: () => true,
  resolveDecision: (_envelope, decision) => decision,
});
assert.deepEqual(rejected, { approved: false, deleteConfirmed: false });
const verification = await executePostApplyVerification('workspace', ['src/created.ts'], {
  terminalRunner: async () => ({ ok: true }),
  checks: [{ command: 'configured-check' }],
  verifyIntegrationReachability: async () => ({ isValid: true }),
});
assert.equal(verification.status, 'PASS');

const approvals = createInlineWorkflowApprovalBroker({ timeoutMs: 1000 });
const sent = [];
const webContents = {
  id: 17,
  isDestroyed: () => false,
  send: (channel, payload) => sent.push({ channel, payload }),
};
const proposal = {
  workflowRequestId: '54b0130f-5fed-4564-a64e-03d8b6c7f4bd',
  proposalId: 'fd53bf0b-2e07-4c6f-ae37-43ef4cf7c80c',
  proposalDigest: 'a'.repeat(64),
  fileOperations: [{ path: 'src/module.ts', operation: 'create' }],
  diff: '+++ b/src/module.ts\n+export const value = true;\n',
  deleteConfirmationRequired: true,
};

const pending = approvals.request({ webContents, ...proposal });
assert.equal(sent.length, 1);
assert.equal(sent[0].channel, 'developer:workflow-approval-pending');
assert.equal(sent[0].payload.proposalDigest, proposal.proposalDigest);
assert.equal(sent[0].payload.envelope.summary, '1 create across 1 file operation');
assert.equal('approvalNonce' in sent[0].payload, false, 'The desktop renderer receives no broker nonce or master token.');
await assert.rejects(
  approvals.decide({
    webContentsId: 99,
    approvalRequestId: pending.approvalRequestId,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    approved: true,
    deleteConfirmed: true,
  }),
  /does not match/,
);
await assert.rejects(
  approvals.decide({
    webContentsId: webContents.id,
    approvalRequestId: pending.approvalRequestId,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    approved: true,
    deleteConfirmed: false,
  }),
  /does not match/,
);
assert.deepEqual(await approvals.decide({
  webContentsId: webContents.id,
  approvalRequestId: pending.approvalRequestId,
  proposalId: proposal.proposalId,
  proposalDigest: proposal.proposalDigest,
  approved: true,
  deleteConfirmed: true,
}), { decisionAccepted: true, approved: true });
assert.deepEqual(await pending.promise, { approved: true, deleteConfirmed: true });
await assert.rejects(
  approvals.decide({
    webContentsId: webContents.id,
    approvalRequestId: pending.approvalRequestId,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    approved: true,
    deleteConfirmed: true,
  }),
  /does not match/,
  'An approval request is single-use.',
);

const cancelled = approvals.request({
  webContents,
  ...proposal,
  deleteConfirmationRequired: false,
});
assert.equal(approvals.cancel(cancelled.approvalRequestId, webContents.id), true);
assert.deepEqual(await cancelled.promise, { approved: false, deleteConfirmed: false });

console.log('Inline workflow approval contract passed: renderer ownership, proposal digest, explicit delete confirmation, and single-use decisions.');
