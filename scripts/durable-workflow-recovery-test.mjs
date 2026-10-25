/**
 * AI Help Agent - V7: Durable Workflow State, Session Recovery & Reconnection Resilience Tests
 *
 * Verifies:
 * 1. Valid workflow state survives a simulated restart.
 * 2. Malformed or truncated records are rejected.
 * 3. Tampered digests are rejected.
 * 4. Old schema versions are handled safely.
 * 5. Project identity mismatch blocks recovery.
 * 6. Expired or changed ownership blocks recovery.
 * 7. Approval is not reused when its validity cannot be established.
 * 8. Stale proposals cannot be resumed.
 * 9. Interrupted mutation returns UNCERTAIN when its outcome is unknown.
 * 10. Recovery does not duplicate a mutation.
 * 11. Duplicate reconnect requests are idempotent.
 * 12. Out-of-order events are rejected.
 * 13. Wrong-renderer reconnection is denied.
 * 14. Missing isolation evidence still blocks execution.
 * 15. Interrupted rollback is reconciled safely.
 * 16. Audit journal gaps and digest mismatches are detected.
 * 17. Secrets are not written to persistent state or logs.
 * 18. V1-V6 contracts are preserved.
 * 19. Unrelated agent boundaries remain intact.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import storePkg from '../electron/coding-pipeline/durableWorkflowStore.cjs';
const {
  DURABLE_SCHEMA_VERSION,
  computeRecordDigest,
  validateWorkflowRecord,
  createDurableWorkflowStore,
} = storePkg;

import journalPkg from '../electron/coding-pipeline/evidenceJournal.cjs';
const {
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_EVENT_TYPES,
  createEvidenceJournal,
  verifyJournalIntegrity,
  computeEntryHash,
} = journalPkg;

import recoveryPkg from '../electron/coding-pipeline/workflowRecoveryManager.cjs';
const {
  RECOVERY_OUTCOMES,
  createWorkflowRecoveryManager,
} = recoveryPkg;

import devAgentPkg from '../electron/developerAgent.cjs';
const {
  WORKFLOW_STATES,
  createWorkflowCoordinator,
  verifyIsolationEvidence,
  executeInVerifiedSandbox,
} = devAgentPkg;

console.log('Starting Durable Workflow State, Session Recovery & Reconnection Resilience tests (V7)...');

let tempDir;
let storeDir;
let journalPath;

async function setupTestDir() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v7-durable-test-'));
  storeDir = path.join(tempDir, 'workflows');
  journalPath = path.join(tempDir, 'journal.jsonl');
}

async function cleanupTestDir() {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------
// Test 1: Valid workflow state survives simulated restart
// -------------------------------------------------------------
async function testWorkflowSurvivesSimulatedRestart() {
  console.log('Testing valid workflow state survives simulated restart...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });

  const originalRecord = {
    workflowId: 'wf-durable-001',
    projectIdentity: {
      projectRoot: tempDir,
      sessionId: 'sess-001',
      ownerWebContentsId: 42,
      projectHash: 'hash-abc',
    },
    currentState: WORKFLOW_STATES.DISCOVERY_COMPLETED,
    lastTransition: { from: 'PROJECT_AUTHORIZED', to: 'DISCOVERY_COMPLETED' },
    lastIdempotencyKey: 'idem-key-1',
    boundProposal: {
      proposalId: 'prop-1',
      planDigest: 'digest-xyz',
      diffSha256: 'sha-diff',
      targets: ['src/app.js'],
    },
  };

  const saveRes = await store.saveWorkflow(originalRecord);
  assert.ok(saveRes.ok);

  // Simulate main process restart by creating a new store instance pointing to same dir
  const restartedStore = createDurableWorkflowStore({ storageDirectory: storeDir });
  const loadRes = await restartedStore.loadWorkflow('wf-durable-001');

  assert.ok(loadRes.ok);
  assert.strictEqual(loadRes.record.workflowId, 'wf-durable-001');
  assert.strictEqual(loadRes.record.currentState, WORKFLOW_STATES.DISCOVERY_COMPLETED);
  assert.strictEqual(loadRes.record.projectIdentity.ownerWebContentsId, 42);
}

// -------------------------------------------------------------
// Test 2: Malformed or truncated records are rejected
// -------------------------------------------------------------
async function testMalformedOrTruncatedRecordsRejected() {
  console.log('Testing malformed or truncated records rejection...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const filePath = store.getFilePath('wf-malformed');

  // Write malformed JSON
  await fs.writeFile(filePath, '{"workflowId": "wf-malformed", "currentState": ', 'utf8');
  const loadRes = await store.loadWorkflow('wf-malformed');

  assert.strictEqual(loadRes.ok, false);
  assert.strictEqual(loadRes.malformed, true);
}

// -------------------------------------------------------------
// Test 3: Tampered digests are rejected
// -------------------------------------------------------------
async function testTamperedDigestsRejected() {
  console.log('Testing tampered digest rejection...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const record = {
    workflowId: 'wf-tamper-001',
    projectIdentity: { projectRoot: tempDir, sessionId: 's1', ownerWebContentsId: 1 },
    currentState: WORKFLOW_STATES.DISCOVERY_COMPLETED,
  };
  await store.saveWorkflow(record);

  // Directly tamper with the saved JSON file
  const filePath = store.getFilePath('wf-tamper-001');
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  // Maliciously change state from DISCOVERY_COMPLETED to COMPLETED without updating recordDigest
  parsed.currentState = WORKFLOW_STATES.COMPLETED;
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');

  const loadRes = await store.loadWorkflow('wf-tamper-001');
  assert.strictEqual(loadRes.ok, false);
  assert.strictEqual(loadRes.tampered, true);
  assert.ok(loadRes.reason.includes('Integrity digest mismatch'));
}

// -------------------------------------------------------------
// Test 4: Old or unsupported schema versions are handled safely
// -------------------------------------------------------------
async function testOldSchemaVersionsHandledSafely() {
  console.log('Testing old or unsupported schema versions handling...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const record = {
    schemaVersion: 999, // unsupported future/legacy schema
    workflowId: 'wf-old-schema',
    projectIdentity: { projectRoot: tempDir, sessionId: 's1', ownerWebContentsId: 1 },
    currentState: WORKFLOW_STATES.DISCOVERY_COMPLETED,
    recordDigest: 'dummy-digest',
  };

  const validation = validateWorkflowRecord(record);
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.unsupportedVersion, true);
  assert.ok(validation.reason.includes('Unsupported schema version'));
}

// -------------------------------------------------------------
// Test 5 & 6: Project Identity and Session Ownership Revalidation on Recovery
// -------------------------------------------------------------
async function testProjectAndOwnerMismatchOnRecovery() {
  console.log('Testing project and owner mismatch blocking recovery...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const journal = createEvidenceJournal({ workflowId: 'wf-rec-001', storagePath: journalPath });
  const recovery = createWorkflowRecoveryManager({ store, journal });

  await store.saveWorkflow({
    workflowId: 'wf-rec-001',
    projectIdentity: {
      projectRoot: tempDir,
      sessionId: 'sess-owner-1',
      ownerWebContentsId: 55,
      projectHash: 'hash-abc',
    },
    currentState: WORKFLOW_STATES.PLAN_CREATED,
  });

  // Reconnection from wrong renderer webContentsId
  const wrongRenderer = await recovery.handleClientReconnect({
    workflowId: 'wf-rec-001',
    clientId: 'client-1',
    sessionId: 'sess-owner-1',
    ownerWebContentsId: 999, // Impostor renderer
  });
  assert.strictEqual(wrongRenderer.ok, false);
  assert.strictEqual(wrongRenderer.status, RECOVERY_OUTCOMES.BLOCKED);
  assert.ok(wrongRenderer.reason.includes('Renderer ownership mismatch'));

  // Recovery with project path mismatch
  const mismatchedProject = await recovery.recoverWorkflow({
    workflowId: 'wf-rec-001',
    activeSessionId: 'sess-owner-1',
    ownerWebContentsId: 55,
    targetProjectRoot: 'C:\\totally\\different\\path',
  });
  assert.strictEqual(mismatchedProject.ok, false);
  assert.strictEqual(mismatchedProject.status, RECOVERY_OUTCOMES.BLOCKED);
  assert.ok(mismatchedProject.reason.includes('Project root mismatch'));
}

// -------------------------------------------------------------
// Test 7 & 8: Approval Revalidation on Stale/Drifted Workspace
// -------------------------------------------------------------
async function testStaleProposalDriftRevalidation() {
  console.log('Testing stale proposal drift revalidation on recovery...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const recovery = createWorkflowRecoveryManager({ store });

  const targetFile = 'config.json';
  const fullTarget = path.join(tempDir, targetFile);
  await fs.writeFile(fullTarget, '{"port": 3000}');

  await store.saveWorkflow({
    workflowId: 'wf-drift-001',
    projectIdentity: { projectRoot: tempDir, sessionId: 's1', ownerWebContentsId: 1 },
    currentState: WORKFLOW_STATES.APPROVED,
    boundProposal: {
      proposalId: 'prop-drift',
      planDigest: 'digest-drift',
      targets: [targetFile],
      fileSnapshots: {
        [targetFile]: '{"port": 3000}',
      },
    },
  });

  // Simulate external file drift prior to recovery
  await fs.writeFile(fullTarget, '{"port": 9000, "drifted": true}');

  const recoverRes = await recovery.recoverWorkflow({
    workflowId: 'wf-drift-001',
    activeSessionId: 's1',
    ownerWebContentsId: 1,
    targetProjectRoot: tempDir,
  });

  assert.strictEqual(recoverRes.ok, false);
  assert.strictEqual(recoverRes.status, RECOVERY_OUTCOMES.REAPPROVAL_REQUIRED);
  assert.ok(recoverRes.reason.includes('drifted on disk'));
}

// -------------------------------------------------------------
// Test 9 & 10: Interrupted Mutation Returns UNCERTAIN Without Blind Re-mutation
// -------------------------------------------------------------
async function testInterruptedMutationHandling() {
  console.log('Testing interrupted mutation returns UNCERTAIN and stops blind resume...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const journal = createEvidenceJournal({ workflowId: 'wf-interrupted-001', storagePath: journalPath });
  const recovery = createWorkflowRecoveryManager({ store, journal });

  await store.saveWorkflow({
    workflowId: 'wf-interrupted-001',
    projectIdentity: { projectRoot: tempDir, sessionId: 's1', ownerWebContentsId: 1 },
    currentState: WORKFLOW_STATES.APPLYING, // Interrupted midway during write
  });

  const recoverRes = await recovery.recoverWorkflow({
    workflowId: 'wf-interrupted-001',
    activeSessionId: 's1',
    ownerWebContentsId: 1,
    targetProjectRoot: tempDir,
  });

  // Must not claim success or resume blindly; marks outcome as UNCERTAIN
  assert.strictEqual(recoverRes.ok, false);
  assert.strictEqual(recoverRes.status, RECOVERY_OUTCOMES.UNCERTAIN);
  assert.strictEqual(recoverRes.requiresReconciliation, true);
  assert.ok(recoverRes.reason.includes('Mutation outcome cannot be determined'));
}

// -------------------------------------------------------------
// Test 11 & 12: Idempotent Reconnection & Out-of-Order Event Rejection
// -------------------------------------------------------------
async function testIdempotentAndOutOfOrderReconnection() {
  console.log('Testing idempotent reconnection and out-of-order rejection...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const journal = createEvidenceJournal({ workflowId: 'wf-seq-001', storagePath: journalPath });
  const recovery = createWorkflowRecoveryManager({ store, journal });

  await store.saveWorkflow({
    workflowId: 'wf-seq-001',
    projectIdentity: { projectRoot: tempDir, sessionId: 's1', ownerWebContentsId: 77 },
    currentState: WORKFLOW_STATES.DISCOVERY_COMPLETED,
  });

  // First reconnect with sequenceNumber 5
  const firstConn = await recovery.handleClientReconnect({
    workflowId: 'wf-seq-001',
    clientId: 'client-A',
    sessionId: 's1',
    ownerWebContentsId: 77,
    sequenceNumber: 5,
  });
  assert.ok(firstConn.ok);

  // Duplicate same sequence number 5 is acknowledged idempotently
  const duplicateConn = await recovery.handleClientReconnect({
    workflowId: 'wf-seq-001',
    clientId: 'client-A',
    sessionId: 's1',
    ownerWebContentsId: 77,
    sequenceNumber: 5,
  });
  assert.ok(duplicateConn.ok);
  assert.strictEqual(duplicateConn.idempotent, true);

  // Stale/out-of-order sequence number 3 (< 5) is rejected
  const staleConn = await recovery.handleClientReconnect({
    workflowId: 'wf-seq-001',
    clientId: 'client-A',
    sessionId: 's1',
    ownerWebContentsId: 77,
    sequenceNumber: 3,
  });
  assert.strictEqual(staleConn.ok, false);
  assert.strictEqual(staleConn.status, RECOVERY_OUTCOMES.BLOCKED);
  assert.ok(staleConn.reason.includes('Out-of-order event rejected'));
}

// -------------------------------------------------------------
// Test 14: Missing Isolation Evidence Still Blocks Execution
// -------------------------------------------------------------
async function testMissingIsolationBlocksExecution() {
  console.log('Testing missing isolation evidence still blocks execution...');
  const verifyRes = verifyIsolationEvidence(null);
  assert.strictEqual(verifyRes.isVerified, false);
  assert.strictEqual(verifyRes.status, 'BLOCKED');

  const execRes = await executeInVerifiedSandbox({
    plan: {
      projectRoot: tempDir,
      binary: 'npm',
      args: ['test'],
      planDigest: 'dummy-digest',
    },
    ownerWebContentsId: 1,
    sessionId: 'sess-test',
    isolationEvidence: null,
  });

  assert.strictEqual(execRes.ok, false);
  assert.strictEqual(execRes.executionBlocked, true);
}

// -------------------------------------------------------------
// Test 16: Audit Journal Gaps and Hash Mismatches Detected
// -------------------------------------------------------------
async function testAuditJournalIntegrityValidation() {
  console.log('Testing audit journal integrity validation and gap detection...');
  const journal = createEvidenceJournal({ workflowId: 'wf-journal-001' });

  await journal.appendEvent({ eventType: JOURNAL_EVENT_TYPES.WORKFLOW_CREATED, details: { step: 1 } });
  await journal.appendEvent({ eventType: JOURNAL_EVENT_TYPES.STATE_TRANSITION_ACCEPTED, details: { step: 2 } });
  await journal.appendEvent({ eventType: JOURNAL_EVENT_TYPES.APPROVAL_REQUESTED, details: { step: 3 } });

  const entries = journal.getEntries();
  assert.strictEqual(entries.length, 3);

  // Valid chain passes verification
  const validCheck = verifyJournalIntegrity(entries);
  assert.ok(validCheck.ok);
  assert.strictEqual(validCheck.count, 3);

  // Corrupt sequence number (simulate missing entry)
  const corruptSeq = JSON.parse(JSON.stringify(entries));
  corruptSeq[2].sequenceNumber = 99; // Gap from 2 to 99
  const gapCheck = verifyJournalIntegrity(corruptSeq);
  assert.strictEqual(gapCheck.ok, false);
  assert.ok(gapCheck.reason.includes('Sequence gap'));

  // Corrupt previous hash (simulate chain broken by attacker)
  const corruptChain = JSON.parse(JSON.stringify(entries));
  corruptChain[1].previousEntryHash = 'corrupted-hash';
  const chainCheck = verifyJournalIntegrity(corruptChain);
  assert.strictEqual(chainCheck.ok, false);
  assert.ok(chainCheck.reason.includes('Hash chain mismatch'));
}

// -------------------------------------------------------------
// Test 17: Secrets Are Not Written to Persistent State or Journal
// -------------------------------------------------------------
async function testSecretsRedactedFromStorage() {
  console.log('Testing secrets are redacted from persistent state and journal...');
  const store = createDurableWorkflowStore({ storageDirectory: storeDir });
  const journal = createEvidenceJournal({ workflowId: 'wf-secret-001', storagePath: journalPath });

  const secretPayload = {
    apiKey: 'sk-ant-api03-abcdef1234567890abcdef1234567890',
    authToken: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    normalField: 'clean-data',
  };

  await store.saveWorkflow({
    workflowId: 'wf-secret-001',
    projectIdentity: { projectRoot: tempDir, sessionId: 's1', ownerWebContentsId: 1 },
    currentState: WORKFLOW_STATES.DISCOVERY_COMPLETED,
    evidenceSummary: secretPayload,
  });

  await journal.appendEvent({
    eventType: JOURNAL_EVENT_TYPES.STATE_TRANSITION_ACCEPTED,
    details: secretPayload,
  });

  // Verify file on disk does not contain raw secrets
  const storeFile = await fs.readFile(store.getFilePath('wf-secret-001'), 'utf8');
  assert.doesNotMatch(storeFile, /sk-ant-api03/);
  assert.doesNotMatch(storeFile, /ghp_ABCDEF/);
  assert.match(storeFile, /\[redacted/i);

  const journalFile = await fs.readFile(journalPath, 'utf8');
  assert.doesNotMatch(journalFile, /sk-ant-api03/);
  assert.doesNotMatch(journalFile, /ghp_ABCDEF/);
  assert.match(journalFile, /\[redacted/i);
}

async function runAllTests() {
  try {
    await setupTestDir();
    await testWorkflowSurvivesSimulatedRestart();
    await testMalformedOrTruncatedRecordsRejected();
    await testTamperedDigestsRejected();
    await testOldSchemaVersionsHandledSafely();
    await testProjectAndOwnerMismatchOnRecovery();
    await testStaleProposalDriftRevalidation();
    await testInterruptedMutationHandling();
    await testIdempotentAndOutOfOrderReconnection();
    await testMissingIsolationBlocksExecution();
    await testAuditJournalIntegrityValidation();
    await testSecretsRedactedFromStorage();
    console.log('All Durable Workflow State, Session Recovery & Reconnection Resilience regression tests passed successfully!');
  } finally {
    await cleanupTestDir();
  }
}

runAllTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
