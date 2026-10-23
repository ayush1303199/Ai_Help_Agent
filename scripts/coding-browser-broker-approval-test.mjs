import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  codingFetch,
  executeTrustedBrokerWorkflow,
  getCodingBrowserSessionId,
  classifyCodingRequestIntent,
  shouldRequireDeveloperWorkflowForAttachedProject,
} from '../src/features/coding/codingTransport.ts';
import { runtimeConfig } from '../src/config/runtimeConfig.ts';

const runtimeSettings = JSON.parse(await readFile(new URL('../src/config/runtimeSettings.json', import.meta.url), 'utf8'));
const readinessPage = await readFile(new URL('../src/features/coding/CodingAgentPage.tsx', import.meta.url), 'utf8');
assert.match(readinessPage, /codingFetch\([\s\S]*?acceptance-preflight/, 'Readiness requests must use the transport that supplies the persistent browser session header.');
const browser = new JSDOM('', {
  url: `http://localhost:${runtimeSettings.services.devServer.port}/`,
});
globalThis.window = browser.window;

const projectId = '218be83a-441b-4fc9-93be-6224f1582f88';
const projectRoot = 'C:\\workspace\\selected-project';
const browserSessionId = 'c6248052-d5ad-4d28-bcc6-18d54ba9a637';
const creationPrompt = `Act as an expert Full-Stack Developer. Build a complete feature.
Create a model/schema and a POST endpoint with validation.
Include proper error handling (try-catch, status codes like 201, 400, 500).
Create a page/component and display success or error toast/messages accordingly.`;
const typoCreationPrompt = creationPrompt.replace(/^Act/, 'ct');
browser.window.localStorage.setItem('coding-browser-session-v1', browserSessionId);
assert.equal(getCodingBrowserSessionId(), browserSessionId, 'A restored browser should reuse its persisted coding session identity.');
for (const prompt of [creationPrompt, typoCreationPrompt]) {
  const classification = classifyCodingRequestIntent(prompt);
  assert.equal(classification.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: classification.intent,
    requestText: prompt,
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
  }), true, 'Full-stack creation requests must take the authorized workflow route.');
}
const lease = {
  brokerSessionId: 'session-handle',
  sessionLeaseToken: 'ephemeral-lease-token',
};
const pendingApproval = {
  taskId: 'task-handle',
  proposalId: 'proposal-handle',
  proposalDigest: 'a'.repeat(64),
  workflowRequestId: randomUUID(),
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
  assert.equal(
    new Headers(init.headers).get('X-Coding-Browser-Session'),
    browserSessionId,
    `${url.pathname} should carry the same persistent local browser session identity.`,
  );
  if (url.pathname === '/api/coding/project-attach') {
    assert.deepEqual(JSON.parse(init.body), { projectRoot });
    return Response.json({ status: 'PROJECT_ATTACHED', projectRoot });
  }
  if (url.pathname === '/api/coding/acceptance-preflight') {
    return Response.json({
      projectAttached: true,
      projectStatus: 'PROJECT_ATTACHED',
      projectRoot,
      projectIdentity: 'BROKER_VERIFIED',
    });
  }
  if (url.pathname === '/api/coding/broker') {
    return Response.json({ projects: [{ projectId }] });
  }
  if (url.pathname === '/api/coding/broker/sessions') {
    assert.deepEqual(JSON.parse(init.body), { projectId });
    return Response.json(lease);
  }
  if (url.pathname === '/api/coding/broker/sessions/heartbeat') {
    return Response.json({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
  }
  if (url.pathname === '/api/coding/broker/workflows') {
    const workflowPayload = JSON.parse(init.body);
    assert.equal(workflowPayload.executionMode, 'inline_review');
    assert.equal(workflowPayload.userRequest, creationPrompt);
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

const readinessResponse = await codingFetch(`${runtimeConfig.services.http.baseUrl}/api/coding/acceptance-preflight`);
assert.equal((await readinessResponse.json()).projectIdentity, 'BROKER_VERIFIED');

let surfacedApproval;
const workflow = executeTrustedBrokerWorkflow(
  creationPrompt,
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

async function verifyExpiredApprovalRecovery(freshDigest, expectedSurfaceCount) {
  let sessionCount = 0;
  let workflowCount = 0;
  let decisionCount = 0;
  let surfacedCount = 0;
  let surfacedActions;
  const freshApproval = freshDigest === pendingApproval.proposalDigest
    ? pendingApproval
    : {
      ...pendingApproval,
      proposalId: 'fresh-proposal-handle',
      proposalDigest: freshDigest,
      approvalNonce: 'fresh-approval-nonce',
      envelope: {
        ...pendingApproval.envelope,
        proposalId: 'fresh-proposal-handle',
        proposalDigest: freshDigest,
        approvalNonce: 'fresh-approval-nonce',
      },
    };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/coding/project-attach') return Response.json({ status: 'PROJECT_ATTACHED' });
    if (url.pathname === '/api/coding/broker') return Response.json({ projects: [{ projectId }] });
    if (url.pathname === '/api/coding/broker/sessions') {
      sessionCount += 1;
      return Response.json({ brokerSessionId: `recovery-session-${sessionCount}`, sessionLeaseToken: `lease-${sessionCount}` });
    }
    if (url.pathname === '/api/coding/broker/sessions/heartbeat') {
      return Response.json({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname === '/api/coding/broker/workflows') {
      workflowCount += 1;
      return Response.json({
        outcome: 'AWAITING_APPROVAL',
        phase: 'APPROVE',
        filesModified: [],
        approval: workflowCount === 1 ? pendingApproval : freshApproval,
      });
    }
    if (url.pathname === '/api/coding/broker/workflows/approval/decision') {
      decisionCount += 1;
      const decision = JSON.parse(init.body);
      if (decisionCount === 1) {
        return Response.json({
          detail: {
            code: 'BROKER_SESSION_UNAUTHORIZED',
            message: 'The broker session lease is invalid or expired.',
          },
        }, { status: 403 });
      }
      return Response.json({
        decisionAccepted: true,
        approved: decision.approved,
        result: {
          outcome: decision.approved ? 'SUCCESS' : 'APPROVAL_REJECTED',
          filesModified: decision.approved ? ['src/generated/module.ts'] : [],
          codeVerified: decision.approved,
        },
      });
    }
    if (url.pathname === '/api/coding/broker/sessions/release') return Response.json({ released: true });
    throw new Error(`Unexpected expired-lease recovery request: ${url.pathname}`);
  };

  const recoveryWorkflow = executeTrustedBrokerWorkflow(
    creationPrompt,
    '.',
    undefined,
    (_approval, actions) => {
      surfacedCount += 1;
      surfacedActions = actions;
    },
    { projectRoot, executionMode: 'inline_review', autoAuthorizeAttachedProject: true },
  );
  for (let attempt = 0; attempt < 100 && surfacedCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(surfacedCount, 1, 'The original proposal must be surfaced before a user decision.');
  const initialDecision = surfacedActions.approve(false);
  if (expectedSurfaceCount > 1) {
    for (let attempt = 0; attempt < 100 && surfacedCount < expectedSurfaceCount; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(surfacedCount, expectedSurfaceCount, 'A changed proposal must be shown again for explicit review.');
    await surfacedActions.approve(false);
  }
  await initialDecision;
  const recovered = await recoveryWorkflow;
  assert.equal(recovered.outcome, 'SUCCESS');
  assert.equal(workflowCount, 2, 'An expired approval lease should recreate the workflow exactly once.');
  assert.equal(decisionCount, 2);
  assert.equal(surfacedCount, expectedSurfaceCount);
}

await verifyExpiredApprovalRecovery(pendingApproval.proposalDigest, 1);
await verifyExpiredApprovalRecovery('c'.repeat(64), 2);

let safeGetAttempts = 0;
globalThis.fetch = async () => {
  safeGetAttempts += 1;
  if (safeGetAttempts === 1) throw new TypeError('Failed to fetch');
  return Response.json({ ready: true });
};
const recoveredStatus = await codingFetch('/api/coding/status');
assert.equal(recoveredStatus.status, 200, 'A transient startup fetch failure should be retried for safe status requests.');
assert.equal(safeGetAttempts, 2);

globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(
  codingFetch('/api/coding/status'),
  /backend is not reachable or the browser blocked the request/i,
  'Network failures should be surfaced with actionable context rather than raw Failed to fetch.',
);

browser.window.close();
console.log('Browser broker approval transport test passed (mocked backend responses; broker materialization is covered separately).');
