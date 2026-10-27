import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  PROVISIONING_STATUSES,
  PROVISIONING_PLANS,
  getProvisioningPlans,
  getProvisioningPlan,
  evaluateProvisioningReadiness,
  requestProvisioningApproval,
  validateApprovalToken,
  executeWithProvisioningWorkflow,
  verifyIsolationBeforeExecution,
} = require('../electron/coding-pipeline/isolationProvisioningWorkflow.cjs');

const { ADAPTER_STATUSES } = require('../electron/coding-pipeline/sandboxExecutionAdapter.cjs');

console.log('Starting Complete Isolation Provisioning Workflow & Execution Lifecycle tests (V27.3)...');

async function makeTempProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v27-prov-test-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { test: 'node -v' } }));
  return dir;
}

// ---------------------------------------------------------------------------
// Test 1: Provisioning plans exist with full metadata
// ---------------------------------------------------------------------------
console.log('Test 1: Provisioning plan schemas, rollback commands, and metadata...');
const plans = getProvisioningPlans();
assert.equal(plans.length, 3, 'Expected 3 concrete provisioning plans.');
for (const plan of plans) {
  assert.ok(plan.providerId);
  assert.ok(plan.displayName);
  assert.ok(plan.expectedEffect);
  assert.ok(plan.rollbackCommand);
  assert.ok(plan.verificationCommand);
  assert.ok(Array.isArray(plan.prerequisiteCommands));
  assert.ok(plan.prerequisiteCommands.length > 0);
  assert.ok(Array.isArray(plan.isolationGuarantees));
}

// ---------------------------------------------------------------------------
// Test 2: Unprovisioned providers evaluate fail-closed
// ---------------------------------------------------------------------------
console.log('Test 2: Unprovisioned providers evaluate fail-closed...');
const dockerEval = evaluateProvisioningReadiness('docker-container');
assert.equal(dockerEval.ready, false);
assert.equal(dockerEval.status, PROVISIONING_STATUSES.AWAITING_APPROVAL);

const wslEval = evaluateProvisioningReadiness('wsl-isolated');
assert.equal(wslEval.ready, false);
assert.equal(wslEval.status, PROVISIONING_STATUSES.AWAITING_APPROVAL);

const sandboxEval = evaluateProvisioningReadiness('windows-sandbox');
assert.equal(sandboxEval.ready, false);
assert.ok(
  sandboxEval.status === PROVISIONING_STATUSES.AWAITING_APPROVAL ||
  sandboxEval.status === PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED
);

// ---------------------------------------------------------------------------
// Test 3: Explicit approval gate and token generation
// ---------------------------------------------------------------------------
console.log('Test 3: User approval gate and cryptographic token generation...');
const noApproval = requestProvisioningApproval({
  providerId: 'windows-sandbox',
  userApproved: false,
});
assert.equal(noApproval.approved, false);
assert.equal(noApproval.status, PROVISIONING_STATUSES.AWAITING_APPROVAL);
assert.equal(noApproval.actionRequired, 'USER_CONFIRMATION_REQUIRED');

const withApproval = requestProvisioningApproval({
  providerId: 'windows-sandbox',
  userApproved: true,
  context: { planDigest: 'abc12345', sessionId: 'sess-1' },
});
assert.equal(withApproval.approved, true);
assert.equal(withApproval.status, PROVISIONING_STATUSES.AWAITING_APPROVAL);
assert.equal(withApproval.actionRequired, 'ADMINISTRATOR_MANUAL_ACTION_REQUIRED');
assert.ok(withApproval.approvalToken);
assert.equal(withApproval.approvalToken.providerId, 'windows-sandbox');
assert.equal(withApproval.approvalToken.planDigest, 'abc12345');
assert.equal(withApproval.approvalToken.sessionId, 'sess-1');

// ---------------------------------------------------------------------------
// Test 4: Approval token tampering and replay rejection
// ---------------------------------------------------------------------------
console.log('Test 4: Approval token tampering, mismatch, and replay guards...');
const validToken = withApproval.approvalToken;

// Provider mismatch
const providerMismatch = validateApprovalToken(validToken, { providerId: 'docker-container', planDigest: 'abc12345' });
assert.equal(providerMismatch.valid, false);
assert.ok(providerMismatch.reason.includes('does not match'));

// Plan digest mismatch (replay attack on different plan)
const digestMismatch = validateApprovalToken(validToken, { providerId: 'windows-sandbox', planDigest: 'diff-digest' });
assert.equal(digestMismatch.valid, false);
assert.ok(digestMismatch.reason.includes('plan digest'));

// Session mismatch
const sessionMismatch = validateApprovalToken(validToken, { providerId: 'windows-sandbox', sessionId: 'other-session' });
assert.equal(sessionMismatch.valid, false);
assert.ok(sessionMismatch.reason.includes('session'));

// Stale / expired token rejection
const expiredToken = { ...validToken, expiresAt: new Date(Date.now() - 1000).toISOString() };
const staleCheck = validateApprovalToken(expiredToken, { providerId: 'windows-sandbox' });
assert.equal(staleCheck.valid, false);
assert.ok(staleCheck.reason.includes('expired'));

// ---------------------------------------------------------------------------
// Test 5: End-to-end executeWithProvisioningWorkflow fails closed without approval
// ---------------------------------------------------------------------------
console.log('Test 5: executeWithProvisioningWorkflow without approval returns AWAITING_APPROVAL...');
const dir = await makeTempProjectDir();
const ownerId = 101;

const testPlan = {
  projectRoot: dir,
  binary: 'npm',
  args: ['test'],
  planDigest: 'd'.repeat(64),
};

const unapprovedResult = await executeWithProvisioningWorkflow({
  plan: testPlan,
  ownerWebContentsId: ownerId,
  sessionId: 'sess-101',
  requestedProviderId: 'windows-sandbox',
  provisioningApproval: null,
});

assert.equal(unapprovedResult.ok, false);
assert.equal(unapprovedResult.executionBlocked, true);
assert.equal(unapprovedResult.actionRequired, 'USER_CONFIRMATION_REQUIRED');
assert.ok(unapprovedResult.status === PROVISIONING_STATUSES.AWAITING_APPROVAL || unapprovedResult.status === PROVISIONING_STATUSES.ISOLATION_NOT_ESTABLISHED);

// ---------------------------------------------------------------------------
// Test 6: executeWithProvisioningWorkflow with admin requirement returns manual action
// ---------------------------------------------------------------------------
console.log('Test 6: executeWithProvisioningWorkflow with approved admin action reports manual instructions...');
const matchingApproval = requestProvisioningApproval({
  providerId: 'windows-sandbox',
  userApproved: true,
  context: { planDigest: testPlan.planDigest, sessionId: 'sess-101' },
});

const approvedAdminResult = await executeWithProvisioningWorkflow({
  plan: testPlan,
  ownerWebContentsId: ownerId,
  sessionId: 'sess-101',
  requestedProviderId: 'windows-sandbox',
  provisioningApproval: matchingApproval.approvalToken,
});

assert.equal(approvedAdminResult.ok, false);
assert.equal(approvedAdminResult.executionBlocked, true);
assert.equal(approvedAdminResult.gate, 'ADMINISTRATOR_MANUAL_ACTION_REQUIRED');
assert.ok(Array.isArray(approvedAdminResult.commandsToRun));
assert.ok(approvedAdminResult.verificationCommand);
assert.ok(approvedAdminResult.rollbackCommand);

// ---------------------------------------------------------------------------
// Test 7: Mismatched approval token in workflow is blocked
// ---------------------------------------------------------------------------
console.log('Test 7: Mismatched approval token in workflow execution is blocked...');
const mismatchedWorkflowResult = await executeWithProvisioningWorkflow({
  plan: testPlan,
  ownerWebContentsId: ownerId,
  sessionId: 'sess-101',
  requestedProviderId: 'docker-container', // Token is for windows-sandbox
  provisioningApproval: withApproval.approvalToken,
});

assert.equal(mismatchedWorkflowResult.ok, false);
assert.equal(mismatchedWorkflowResult.executionBlocked, true);
assert.equal(mismatchedWorkflowResult.gate, 'APPROVAL_BINDING_GATE');

// ---------------------------------------------------------------------------
// Test 8: Forged or invalid isolation evidence fails closed
// ---------------------------------------------------------------------------
console.log('Test 8: Forged, fake, or synthetic isolation evidence fails closed...');
const forgedResult = await executeWithProvisioningWorkflow({
  plan: testPlan,
  ownerWebContentsId: ownerId,
  sessionId: 'sess-101',
  requestedProviderId: 'windows-sandbox',
  isolationEvidence: { sandbox: true }, // self-asserted boolean
});

assert.equal(forgedResult.ok, false);
assert.equal(forgedResult.executionBlocked, true);

// ---------------------------------------------------------------------------
// Test 9: Cancellation and timeout fail closed
// ---------------------------------------------------------------------------
console.log('Test 9: Cancellation and pre-execution abort fail closed...');
const abortController = new AbortController();
abortController.abort();

const cancelledResult = await executeWithProvisioningWorkflow({
  plan: testPlan,
  ownerWebContentsId: ownerId,
  sessionId: 'sess-101',
  requestedProviderId: 'windows-sandbox',
  signal: abortController.signal,
});

assert.equal(cancelledResult.ok, false);
assert.equal(cancelledResult.executionBlocked, true);

// ---------------------------------------------------------------------------
// Test 10: verifyIsolationBeforeExecution blocks project execution
// ---------------------------------------------------------------------------
console.log('Test 10: verifyIsolationBeforeExecution blocks project execution without verified provider...');
const execCheck = verifyIsolationBeforeExecution('windows-sandbox');
assert.equal(execCheck.allowed, false);
assert.equal(execCheck.error.code, 'ISOLATION_GATE_BLOCKED');

console.log('All Complete Isolation Provisioning Workflow & Execution Lifecycle tests passed successfully (10/10)!');
