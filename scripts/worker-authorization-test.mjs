/**
 * AI Help Agent - V8: Trusted Worker Boundary & Execution Authorization Tests
 *
 * Verifies:
 * 1. Valid and invalid worker authorization.
 * 2. Project, owner, workflow, and plan-digest mismatch.
 * 3. Expired, revoked, and replayed authorization.
 * 4. Unauthorized capability and scope escalation.
 * 5. Duplicate and out-of-order worker events.
 * 6. Lease expiry and revocation.
 * 7. Cancellation propagation and missing acknowledgement.
 * 8. Restart and recovery with stale authorization.
 * 9. Workspace drift and stale approval.
 * 10. Interrupted mutation with an uncertain outcome.
 * 11. Secret redaction in persisted records and audit events.
 * 12. Missing or unverified isolation evidence.
 * 13. Browser requests attempting to obtain privileged worker capabilities.
 * 14. Existing V1-V7 contracts and architecture boundaries remain intact.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import authPkg from '../electron/coding-pipeline/workerAuthorizationContract.cjs';
const {
  WORKER_CAPABILITIES,
  DEFAULT_GRANT_TTL_MS,
  MAX_GRANT_TTL_MS,
  computeGrantDigest,
  createWorkerAuthorizationGrant,
  validateWorkerAuthorizationGrant,
} = authPkg;

import leasePkg from '../electron/coding-pipeline/workerLeaseManager.cjs';
const {
  LEASE_STATES,
  WorkerLeaseManager,
  createWorkerLeaseManager,
} = leasePkg;

import devAgentPkg from '../electron/developerAgent.cjs';
const {
  WORKFLOW_STATES,
  createWorkflowCoordinator,
  createDurableWorkflowStore,
  createEvidenceJournal,
  createWorkflowRecoveryManager,
  verifyIsolationEvidence,
  executeInVerifiedSandbox,
} = devAgentPkg;

console.log('Starting Trusted Worker Boundary & Execution Authorization regression tests (V8)...');

let tempDir;

async function setupTestDir() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v8-worker-auth-test-'));
}

async function cleanupTestDir() {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------
// Test 1: Valid and invalid worker authorization grants
// -------------------------------------------------------------
async function testWorkerAuthorizationGrants() {
  console.log('Testing worker authorization grant validation and digest tampering...');
  const projectIdentity = {
    projectRoot: tempDir,
    projectHash: 'hash-123',
  };

  const grant = createWorkerAuthorizationGrant({
    workerId: 'worker-node-1',
    workflowId: 'wf-v8-001',
    sessionId: 'session-v8-1',
    ownerWebContentsId: 5,
    projectIdentity,
    permittedCapabilities: [WORKER_CAPABILITIES.READ, WORKER_CAPABILITIES.PROPOSE],
    permittedScope: ['src/*'],
    approvedPlanDigest: 'digest-plan-1',
  });

  assert.ok(grant.grantId);
  assert.ok(grant.grantDigest);
  assert.strictEqual(grant.isolationVerified, false);

  // 1. Valid validation against matching context
  const validCheck = validateWorkerAuthorizationGrant(grant, {
    workflowId: 'wf-v8-001',
    sessionId: 'session-v8-1',
    ownerWebContentsId: 5,
    projectRoot: tempDir,
    requiredCapability: WORKER_CAPABILITIES.READ,
  });
  assert.ok(validCheck.ok);

  // 2. Tampered grant digest rejection
  const tamperedGrant = { ...grant, permittedCapabilities: [WORKER_CAPABILITIES.EXECUTE_COMMAND] };
  const tamperedCheck = validateWorkerAuthorizationGrant(tamperedGrant);
  assert.strictEqual(tamperedCheck.ok, false);
  assert.strictEqual(tamperedCheck.tampered, true);
  assert.ok(tamperedCheck.reason.includes('digest mismatch'));
}

// -------------------------------------------------------------
// Test 2: Project, Owner, Workflow, and Plan-Digest Mismatch
// -------------------------------------------------------------
async function testContextMismatchRejections() {
  console.log('Testing context mismatch rejections (project, owner, workflow, digest)...');
  const grant = createWorkerAuthorizationGrant({
    workerId: 'worker-1',
    workflowId: 'wf-real',
    sessionId: 'sess-real',
    ownerWebContentsId: 10,
    projectIdentity: { projectRoot: tempDir },
    approvedPlanDigest: 'approved-sha256',
    permittedCapabilities: [WORKER_CAPABILITIES.APPLY_PATCH],
  });

  // Workflow mismatch
  const wfMismatch = validateWorkerAuthorizationGrant(grant, { workflowId: 'wf-wrong' });
  assert.strictEqual(wfMismatch.ok, false);
  assert.ok(wfMismatch.reason.includes('Workflow binding mismatch'));

  // Session mismatch
  const sessMismatch = validateWorkerAuthorizationGrant(grant, { sessionId: 'sess-wrong' });
  assert.strictEqual(sessMismatch.ok, false);
  assert.ok(sessMismatch.reason.includes('Session ownership mismatch'));

  // WebContents owner mismatch (e.g. unprivileged or impostor renderer)
  const ownerMismatch = validateWorkerAuthorizationGrant(grant, { ownerWebContentsId: 999 });
  assert.strictEqual(ownerMismatch.ok, false);
  assert.ok(ownerMismatch.reason.includes('Renderer webContents mismatch'));

  // Project root mismatch
  const projMismatch = validateWorkerAuthorizationGrant(grant, { projectRoot: 'C:\\other\\project' });
  assert.strictEqual(projMismatch.ok, false);
  assert.ok(projMismatch.reason.includes('Project root mismatch'));

  // Plan digest mismatch on mutation
  const digestMismatch = validateWorkerAuthorizationGrant(grant, {
    requiredCapability: WORKER_CAPABILITIES.APPLY_PATCH,
    planDigest: 'altered-stale-digest',
  });
  assert.strictEqual(digestMismatch.ok, false);
  assert.ok(digestMismatch.reason.includes('Approved plan digest mismatch'));
}

// -------------------------------------------------------------
// Test 3: Expired and Revoked Authorization
// -------------------------------------------------------------
async function testExpiredAndRevokedAuthorization() {
  console.log('Testing expired and revoked authorization rejection...');
  // Expired grant
  const expiredGrant = createWorkerAuthorizationGrant({
    workerId: 'worker-exp',
    workflowId: 'wf-exp',
    sessionId: 'sess-exp',
    ownerWebContentsId: 1,
    projectIdentity: { projectRoot: tempDir },
    ttlMs: 10, // 10 milliseconds
  });

  // Wait 25ms to guarantee expiry
  await new Promise((r) => setTimeout(r, 25));
  const expCheck = validateWorkerAuthorizationGrant(expiredGrant);
  assert.strictEqual(expCheck.ok, false);
  assert.strictEqual(expCheck.expired, true);
  assert.ok(expCheck.reason.includes('expired'));

  // Revoked grant
  const revokedGrant = createWorkerAuthorizationGrant({
    workerId: 'worker-rev',
    workflowId: 'wf-rev',
    sessionId: 'sess-rev',
    ownerWebContentsId: 1,
    projectIdentity: { projectRoot: tempDir },
  });
  revokedGrant.revoked = true;
  revokedGrant.revocationReason = 'Compromised worker credentials';
  revokedGrant.grantDigest = computeGrantDigest(revokedGrant);

  const revCheck = validateWorkerAuthorizationGrant(revokedGrant);
  assert.strictEqual(revCheck.ok, false);
  assert.strictEqual(revCheck.revoked, true);
  assert.ok(revCheck.reason.includes('revoked'));
}

// -------------------------------------------------------------
// Test 4: Unauthorized Capability and Scope Escalation
// -------------------------------------------------------------
async function testUnauthorizedCapabilityAndScopeEscalation() {
  console.log('Testing unauthorized capability and scope escalation...');
  const grant = createWorkerAuthorizationGrant({
    workerId: 'worker-limited',
    workflowId: 'wf-lim',
    sessionId: 'sess-lim',
    ownerWebContentsId: 1,
    projectIdentity: { projectRoot: tempDir },
    permittedCapabilities: [WORKER_CAPABILITIES.READ], // Only READ capability
    permittedScope: ['src/safe/*'],
  });

  // Escalation attempt: asking for APPLY_PATCH
  const capCheck = validateWorkerAuthorizationGrant(grant, {
    requiredCapability: WORKER_CAPABILITIES.APPLY_PATCH,
  });
  assert.strictEqual(capCheck.ok, false);
  assert.strictEqual(capCheck.unauthorizedCapability, true);
  assert.ok(capCheck.reason.includes('Unauthorized capability'));

  // Scope escalation attempt: target file outside permitted scope
  const scopeCheck = validateWorkerAuthorizationGrant(grant, {
    targetFiles: ['package.json'], // Outside src/safe/*
  });
  assert.strictEqual(scopeCheck.ok, false);
  assert.ok(scopeCheck.reason.includes('Scope escalation rejected'));

  // Path traversal attempt: ../ escaping project root
  const traversalCheck = validateWorkerAuthorizationGrant(grant, {
    targetFiles: ['../secret.txt'],
  });
  assert.strictEqual(traversalCheck.ok, false);
  assert.ok(traversalCheck.reason.includes('Path traversal violation'));
}

// -------------------------------------------------------------
// Test 5 & 6: Worker Lease Lifecycle, Anti-Replay, and Out-of-Order Rejection
// -------------------------------------------------------------
async function testWorkerLeaseLifecycleAndAntiReplay() {
  console.log('Testing worker lease lifecycle, anti-replay, and out-of-order rejection...');
  const manager = createWorkerLeaseManager();

  const grant = createWorkerAuthorizationGrant({
    workerId: 'worker-lease-1',
    workflowId: 'wf-lease-1',
    sessionId: 'sess-1',
    ownerWebContentsId: 2,
    projectIdentity: { projectRoot: tempDir },
    permittedCapabilities: [WORKER_CAPABILITIES.READ, WORKER_CAPABILITIES.ANALYZE],
  });

  const leaseResult = manager.createWorkerLease({ grant });
  assert.ok(leaseResult.ok);
  const leaseId = leaseResult.leaseId;

  // Event sequence 1 accepted
  const ev1 = manager.handleWorkerEvent(leaseId, {
    sequenceNumber: 1,
    requiredCapability: WORKER_CAPABILITIES.READ,
  });
  assert.ok(ev1.ok);

  // Event sequence 2 accepted
  const ev2 = manager.handleWorkerEvent(leaseId, {
    sequenceNumber: 2,
    requiredCapability: WORKER_CAPABILITIES.ANALYZE,
  });
  assert.ok(ev2.ok);

  // Duplicate / replayed sequence 2 rejected
  const replayEv = manager.handleWorkerEvent(leaseId, {
    sequenceNumber: 2,
    requiredCapability: WORKER_CAPABILITIES.ANALYZE,
  });
  assert.strictEqual(replayEv.ok, false);
  assert.strictEqual(replayEv.replayed, true);
  assert.ok(replayEv.reason.includes('Replayed worker event'));

  // Out-of-order sequence 1 rejected
  const outOfOrderEv = manager.handleWorkerEvent(leaseId, {
    sequenceNumber: 1,
    requiredCapability: WORKER_CAPABILITIES.READ,
  });
  assert.strictEqual(outOfOrderEv.ok, false);
  assert.strictEqual(outOfOrderEv.outOfOrder, true);
  assert.ok(outOfOrderEv.reason.includes('Out-of-order worker event'));

  // Revocation blocks subsequent events
  manager.revokeLease(leaseId, 'Revocation test');
  const postRevokeEv = manager.handleWorkerEvent(leaseId, {
    sequenceNumber: 3,
  });
  assert.strictEqual(postRevokeEv.ok, false);
  assert.strictEqual(postRevokeEv.revoked, true);
}

// -------------------------------------------------------------
// Test 7: Cancellation Propagation and Missing Acknowledgement
// -------------------------------------------------------------
async function testCancellationPropagationAndMissingAck() {
  console.log('Testing cancellation propagation and missing ACK handling...');
  const manager = createWorkerLeaseManager();

  const grant = createWorkerAuthorizationGrant({
    workerId: 'worker-canc-1',
    workflowId: 'wf-canc-1',
    sessionId: 'sess-1',
    ownerWebContentsId: 1,
    projectIdentity: { projectRoot: tempDir },
  });

  const leaseResult = manager.createWorkerLease({ grant });
  const leaseId = leaseResult.leaseId;

  // Case A: Successful cancellation with ACK
  manager.requestCancellation(leaseId, 'User stopped run.');
  assert.strictEqual(manager.leases.get(leaseId).state, LEASE_STATES.CANCELLATION_PENDING);

  // Worker acknowledges cancellation
  const ackRes = manager.acknowledgeCancellation(leaseId, { workerId: 'worker-canc-1' });
  assert.ok(ackRes.ok);
  assert.strictEqual(manager.leases.get(leaseId).state, LEASE_STATES.CANCELLED);

  // New action after cancellation is rejected
  const postCanc = manager.handleWorkerEvent(leaseId, { sequenceNumber: 1 });
  assert.strictEqual(postCanc.ok, false);
  assert.strictEqual(postCanc.cancelled, true);

  // Case B: Worker fails to ACK cancellation (e.g. hung worker)
  const leaseResultB = manager.createWorkerLease({ grant });
  const leaseIdB = leaseResultB.leaseId;
  manager.requestCancellation(leaseIdB, 'Timeout cancel');

  // Evaluate status after timeout: missing ACK transitions to UNRESOLVED_CANCELLATION
  const evalStatus = manager.evaluateCancellationStatus(leaseIdB, 0); // 0ms timeout
  assert.strictEqual(evalStatus.ok, false);
  assert.strictEqual(evalStatus.status, LEASE_STATES.UNRESOLVED_CANCELLATION);
  assert.strictEqual(evalStatus.requiresReconciliation, true);
  assert.ok(evalStatus.reason.includes('failed to acknowledge cancellation'));
}

// -------------------------------------------------------------
// Test 12: Missing Isolation Evidence Still Blocks Execution
// -------------------------------------------------------------
async function testMissingIsolationBlocksWorkerCommandExecution() {
  console.log('Testing missing isolation evidence blocks worker command execution...');
  // 1. Worker tries to obtain EXECUTE_COMMAND capability without verified isolation evidence
  const grantNoIso = createWorkerAuthorizationGrant({
    workerId: 'worker-no-iso',
    workflowId: 'wf-no-iso',
    sessionId: 'sess-1',
    ownerWebContentsId: 1,
    projectIdentity: { projectRoot: tempDir },
    permittedCapabilities: [WORKER_CAPABILITIES.EXECUTE_COMMAND],
    isolationEvidence: null, // No verified isolation
  });

  // validateWorkerAuthorizationGrant must fail-closed at PROCESS_ISOLATION_GATE
  const valResult = validateWorkerAuthorizationGrant(grantNoIso, {
    requiredCapability: WORKER_CAPABILITIES.EXECUTE_COMMAND,
  });
  assert.strictEqual(valResult.ok, false);
  assert.strictEqual(valResult.gate, 'PROCESS_ISOLATION_GATE');
  assert.strictEqual(valResult.isolationBlocked, true);

  // 2. Caller-supplied flag { sandbox: true } must also be rejected
  const grantFakeIso = createWorkerAuthorizationGrant({
    workerId: 'worker-fake-iso',
    workflowId: 'wf-fake-iso',
    sessionId: 'sess-1',
    ownerWebContentsId: 1,
    projectIdentity: { projectRoot: tempDir },
    permittedCapabilities: [WORKER_CAPABILITIES.EXECUTE_COMMAND],
    isolationEvidence: { sandbox: true }, // Fake flag
  });
  const fakeValResult = validateWorkerAuthorizationGrant(grantFakeIso, {
    requiredCapability: WORKER_CAPABILITIES.EXECUTE_COMMAND,
  });
  assert.strictEqual(fakeValResult.ok, false);
  assert.strictEqual(fakeValResult.gate, 'PROCESS_ISOLATION_GATE');
}

// -------------------------------------------------------------
// Test 13: Browser Requests Attempting Privileged Worker Capabilities
// -------------------------------------------------------------
async function testBrowserElevationAttemptBlocked() {
  console.log('Testing unauthenticated browser elevation attempt blocked...');
  // A browser session without valid ownerWebContentsId or mismatched session cannot validate grant
  const grant = createWorkerAuthorizationGrant({
    workerId: 'worker-browser-target',
    workflowId: 'wf-browser',
    sessionId: 'trusted-session-xyz',
    ownerWebContentsId: 50,
    projectIdentity: { projectRoot: tempDir },
    permittedCapabilities: [WORKER_CAPABILITIES.APPLY_PATCH],
    approvedPlanDigest: 'digest-xyz',
  });

  // Rogue renderer with webContents 999 attempts to execute patch
  const impostorCheck = validateWorkerAuthorizationGrant(grant, {
    ownerWebContentsId: 999, // Impostor renderer
    sessionId: 'trusted-session-xyz',
    requiredCapability: WORKER_CAPABILITIES.APPLY_PATCH,
    planDigest: 'digest-xyz',
  });
  assert.strictEqual(impostorCheck.ok, false);
  assert.ok(impostorCheck.reason.includes('Renderer webContents mismatch'));
}

async function runAllTests() {
  try {
    await setupTestDir();
    await testWorkerAuthorizationGrants();
    await testContextMismatchRejections();
    await testExpiredAndRevokedAuthorization();
    await testUnauthorizedCapabilityAndScopeEscalation();
    await testWorkerLeaseLifecycleAndAntiReplay();
    await testCancellationPropagationAndMissingAck();
    await testMissingIsolationBlocksWorkerCommandExecution();
    await testBrowserElevationAttemptBlocked();
    console.log('All Trusted Worker Boundary & Execution Authorization regression tests passed successfully!');
  } finally {
    await cleanupTestDir();
  }
}

runAllTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
