import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { executeTrustedBrokerWorkflow } from '../src/features/coding/codingTransport.ts';

const runtimeSettings = JSON.parse(await readFile(new URL('../src/config/runtimeSettings.json', import.meta.url), 'utf8'));
const browser = new JSDOM('', {
  url: `http://localhost:${runtimeSettings.services.devServer.port}/`,
});
globalThis.window = browser.window;

const projectId = '218be83a-441b-4fc9-93be-6224f1582f88';
const projectRoot = 'C:\\workspace\\selected-project';
const lease = {
  brokerSessionId: 'session-handle',
  sessionLeaseToken: 'ephemeral-lease-token',
};
const pendingApproval = {
  taskId: 'task-handle',
  proposalId: 'proposal-handle',
  proposalDigest: 'a'.repeat(64),
  approvalNonce: 'one-time-approval-nonce',
  deleteConfirmationRequired: false,
  fileOperations: [{
    path: 'src/generated/module.ts',
    sourcePath: null,
    operation: 'create',
    hash: 'b'.repeat(64),
    content: 'export const generated = true;\n',
  }],
  diff: '--- /dev/null\n+++ src/generated/module.ts\n+export const generated = true;',
  envelope: {
    proposalId: 'proposal-handle',
    proposalDigest: 'a'.repeat(64),
    projectId,
    approvalNonce: 'one-time-approval-nonce',
    summary: '1 create across 1 file operation',
    fileBadges: [{ filePath: 'src/generated/module.ts', action: 'create', lineCount: 1 }],
    diffPreview: [{
      filePath: 'src/generated/module.ts',
      action: 'create',
      lines: ['--- /dev/null', '+++ src/generated/module.ts'],
    }],
    debugTrace: {
      stage: 'AWAITING_INLINE_APPROVAL',
      timestamp: new Date().toISOString(),
      sessionId: 'session-handle',
      verificationStatus: 'NOT_STARTED',
    },
  },
};

let observedDecision;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/coding/project-attach') {
    assert.deepEqual(JSON.parse(init.body), { projectRoot });
    return Response.json({ status: 'PROJECT_ATTACHED', projectRoot });
  }
  if (url.pathname === '/api/coding/broker') {
    return Response.json({ projects: [{ projectId }] });
  }
  if (url.pathname === '/api/coding/broker/sessions') {
    assert.deepEqual(JSON.parse(init.body), { projectId });
    return Response.json(lease);
  }
  if (url.pathname === '/api/coding/broker/workflows') {
    assert.equal(JSON.parse(init.body).executionMode, 'inline_review');
    return Response.json({
      outcome: 'AWAITING_APPROVAL',
      phase: 'APPROVE',
      filesModified: [],
      approval: pendingApproval,
    });
  }
  if (url.pathname === '/api/coding/broker/workflows/approval') {
    throw new Error('The browser must use the staged workflow response, not poll for approval.');
  }
  if (url.pathname === '/api/coding/broker/workflows/approval/decision') {
    observedDecision = JSON.parse(init.body);
    return Response.json({
      decisionAccepted: true,
      approved: observedDecision.approved,
      result: {
        outcome: observedDecision.approved ? 'SUCCESS' : 'APPROVAL_REJECTED',
        filesModified: observedDecision.approved ? ['src/generated/module.ts'] : [],
        codeVerified: observedDecision.approved,
      },
    });
  }
  if (url.pathname === '/api/coding/broker/sessions/release') {
    return Response.json({ released: true });
  }
  throw new Error(`Unexpected broker transport request: ${url.pathname}`);
};

let surfacedApproval;
const workflow = executeTrustedBrokerWorkflow(
  'Create a generic module.',
  '.',
  undefined,
  (approval, actions) => {
    surfacedApproval = { approval, actions };
  },
  { projectRoot, executionMode: 'inline_review', autoAuthorizeAttachedProject: true },
);

for (let attempt = 0; attempt < 100 && !surfacedApproval; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.ok(surfacedApproval, 'The browser transport should surface the pending proposal to the UI.');
assert.equal(surfacedApproval.approval.proposalDigest, pendingApproval.proposalDigest);
assert.equal(surfacedApproval.approval.fileOperations[0].path, pendingApproval.fileOperations[0].path);
assert.equal(surfacedApproval.approval.approvalNonce, pendingApproval.approvalNonce);
await surfacedApproval.actions.approve(false);
const result = await workflow;

assert.equal(observedDecision.approved, true, 'The UI action should send an explicit approval decision.');
assert.equal(observedDecision.approvalNonce, pendingApproval.approvalNonce);
assert.equal(observedDecision.proposalId, pendingApproval.proposalId);
assert.equal(observedDecision.proposalDigest, pendingApproval.proposalDigest);
assert.equal(result.outcome, 'SUCCESS');
assert.deepEqual(result.filesModified, ['src/generated/module.ts']);
assert.equal(browser.window.electronAPI, undefined, 'The browser approval flow must not depend on Electron IPC.');

browser.window.close();
console.log('Browser broker approval transport test passed (mocked backend responses; broker materialization is covered separately).');
