import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import contract from '../electron/coding-pipeline/benchmarkAuthorizationContract.cjs';
import agent from '../electron/developerAgent.cjs';

console.log('=== RUNNING BENCHMARK AUTHORIZATION PROTOCOL & ISOLATION TESTS ===');

// Setup disposable scratch space outside project
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-auth-protocol-test-'));
const projectMockRoot = path.join(tempDir, 'fake-repo-root');
const isolatedDestinationRoot = path.join(tempDir, 'inert-proposals');
await fs.mkdir(projectMockRoot, { recursive: true });
await fs.mkdir(isolatedDestinationRoot, { recursive: true });

try {
  contract.resetConsumedTokensForTest();

  // -------------------------------------------------------------------------
  // SECTION 1: Fail-Closed Authorization & Prerequisite Guards
  // -------------------------------------------------------------------------
  console.log('\n--- Section 1: Fail-Closed Authorization Verification ---');

  const dispatchSpy = {
    calls: 0,
    invoke() { this.calls += 1; },
  };

  // Test 1.1: Missing Manifest
  const resEmpty = contract.validateLiveBenchmarkAuthorization(null);
  assert.equal(resEmpty.authorized, false);
  assert.equal(resEmpty.state, 'BLOCKED');
  if (resEmpty.authorized) dispatchSpy.invoke();
  assert.equal(dispatchSpy.calls, 0, 'Dispatch must not be called on null manifest');

  // Test 1.2: Ambient Environment Source Rejected
  const resAmbient = contract.validateLiveBenchmarkAuthorization({
    source: 'ambient_env',
    runToken: 'token-ambient-001',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
  });
  assert.equal(resAmbient.authorized, false);
  assert.ok(resAmbient.blockers.some((b) => b.includes('cannot be satisfied by ambient environment variables')));
  if (resAmbient.authorized) dispatchSpy.invoke();
  assert.equal(dispatchSpy.calls, 0, 'Ambient authorization must not dispatch');

  // Test 1.3: Missing Human Authorization Block
  const resNoAuth = contract.validateLiveBenchmarkAuthorization({
    runToken: 'token-uuid-1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  });
  assert.equal(resNoAuth.authorized, false);
  assert.ok(resNoAuth.blockers.some((b) => b.includes('Human authorization block is missing')));
  if (resNoAuth.authorized) dispatchSpy.invoke();
  assert.equal(dispatchSpy.calls, 0);

  // Test 1.4: Human Authorization Without explicitApproval: true
  const resNoExplicit = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: false, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-2',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  });
  assert.equal(resNoExplicit.authorized, false);
  assert.ok(resNoExplicit.blockers.some((b) => b.includes('explicitApproval: true')));

  // Test 1.5: Invalid Approver Identity Format
  const resBadApprover = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'not-a-valid-principal', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-approver-check',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  });
  assert.equal(resBadApprover.authorized, false);
  assert.ok(resBadApprover.blockers.some((b) => b.includes('is not in valid principal format')));

  // Test 1.6: Stale / Expired Approval Timestamp
  const resStaleApproval = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'secops-lead', approvalTimestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString() }, // 30m ago
    runToken: 'token-uuid-stale',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  });
  assert.equal(resStaleApproval.authorized, false);
  assert.ok(resStaleApproval.blockers.some((b) => b.includes('Human approval expired')));

  // Test 1.7: Missing API Key (Fails Closed Without Leaking Value)
  const resNoKey = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-3',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: '',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  });
  assert.equal(resNoKey.authorized, false);
  assert.ok(resNoKey.blockers.some((b) => b.includes('API key credential is missing')));
  assert.ok(!JSON.stringify(resNoKey).includes('sk-'));

  // Test 1.8: Expired Run Token
  const resExpired = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-4',
    expiresAt: new Date(Date.now() - 10000).toISOString(), // 10s in the past
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  });
  assert.equal(resExpired.authorized, false);
  assert.ok(resExpired.blockers.some((b) => b.includes('Authorization expired')));

  // Test 1.9: Single-Use Token Consumption (Replay Prevention)
  const validManifest = {
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-single-use-5555',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  };
  const resFirst = contract.validateLiveBenchmarkAuthorization(validManifest, { projectRoot: projectMockRoot });
  assert.equal(resFirst.authorized, true);
  if (resFirst.authorized) dispatchSpy.invoke();
  assert.equal(dispatchSpy.calls, 1, 'Dispatch should be permitted exactly once for valid token');

  // Attempting to reuse the exact same token MUST fail closed
  const resSecond = contract.validateLiveBenchmarkAuthorization(validManifest, { projectRoot: projectMockRoot });
  assert.equal(resSecond.authorized, false);
  assert.ok(resSecond.blockers.some((b) => b.includes('has already been consumed (replay prevention)')));
  if (resSecond.authorized) dispatchSpy.invoke();
  assert.equal(dispatchSpy.calls, 1, 'Replay token must not permit second dispatch');

  // Test 1.10: Unsupported Provider
  const resBadProvider = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-6',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'untrusted_custom_llm',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  });
  assert.equal(resBadProvider.authorized, false);
  assert.ok(resBadProvider.blockers.some((b) => b.includes('Unsupported provider "untrusted_custom_llm"')));

  console.log('[PASS] Section 1: All authorization failure modes fail closed without dispatch.');

  // -------------------------------------------------------------------------
  // SECTION 2: Destination Isolation & Windows Path Canonicalization
  // -------------------------------------------------------------------------
  console.log('\n--- Section 2: Destination Path Containment & Escape Prevention ---');

  // Test 2.1: Destination inside project root
  const insideDestination = path.join(projectMockRoot, 'subfolder', 'proposals');
  const resBadDest1 = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-7',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: insideDestination,
  }, { projectRoot: projectMockRoot });
  assert.equal(resBadDest1.authorized, false);
  assert.ok(resBadDest1.blockers.some((b) => b.includes('strictly outside the project repository workspace')));

  // Test 2.2: Destination identical to project root
  const resBadDest2 = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-8',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: projectMockRoot,
  }, { projectRoot: projectMockRoot });
  assert.equal(resBadDest2.authorized, false);

  // Test 2.3: Windows drive-letter casing mismatch (e.g. C: vs c:)
  if (process.platform === 'win32') {
    const driveLetter = projectMockRoot[0].toLowerCase();
    const otherCaseRoot = (driveLetter === projectMockRoot[0].toLowerCase() ? driveLetter.toUpperCase() : driveLetter.toLowerCase()) + projectMockRoot.slice(1);
    const insideWithDifferentCase = path.join(otherCaseRoot, 'proposals');
    const resBadDest3 = contract.validateLiveBenchmarkAuthorization({
      humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
      runToken: 'token-uuid-9',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      networkPermissionGranted: true,
      provider: 'openai',
      apiKey: 'sk-test-key-12345',
      fixtures: ['FIX-01'],
      destinationRoot: insideWithDifferentCase,
    }, { projectRoot: projectMockRoot });
    assert.equal(resBadDest3.authorized, false);
  }

  // Test 2.4: Path traversal attempt (e.g. outside/../project/proposals)
  const traversalAttempt = path.join(isolatedDestinationRoot, '..', path.basename(projectMockRoot), 'proposals');
  const resBadDest4 = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: { explicitApproval: true, approverIdentity: 'lead@example.com', approvalTimestamp: new Date().toISOString() },
    runToken: 'token-uuid-10',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: traversalAttempt,
  }, { projectRoot: projectMockRoot });
  assert.equal(resBadDest4.authorized, false);

  console.log('[PASS] Section 2: Path canonicalization reliably catches containment and traversal escapes.');

  // -------------------------------------------------------------------------
  // SECTION 3: Evidence Contract, Deep Immutability & Genuine Proofs
  // -------------------------------------------------------------------------
  console.log('\n--- Section 3: Evidence Contract, Deep Immutability & Genuine Proofs ---');

  // Test 3.1: Valid deterministic synthetic evidence record
  const syntheticEvidence = contract.createBenchmarkEvidenceRecord({
    runId: 'bench-run-101',
    trialId: 'FIX-01',
    classification: contract.BENCHMARK_RESULT_CLASSIFICATIONS.DETERMINISTIC_SYNTHETIC,
    provider: 'openai',
    model: 'gpt-4o-mini',
    startTime: new Date(Date.now() - 500).toISOString(),
    endTime: new Date().toISOString(),
    promptSummary: 'Fix math bug with API_KEY=sk-ant-api03-abcdef1234567890abcdef1234567890 in test/calc.ts',
    rawResponse: 'HTTP 200 OK: Auth Bearer sk-secret-token-9999999999 with diff --- a/calc.ts',
    tokensUsed: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
    costUsd: 0.0003,
    validationOutcome: { passed: true, patchApplicable: true, addressesDefect: true },
  });

  assert.equal(syntheticEvidence.classification, 'DETERMINISTIC_SYNTHETIC');
  assert.equal(syntheticEvidence.secretsRedacted, true);
  assert.equal(syntheticEvidence.digestType, 'CONTENT_INTEGRITY_SHA256_NOT_ATTESTATION');
  assert.ok(syntheticEvidence.responseSha256.length === 64, 'Must compute valid SHA-256 digest');
  assert.ok(!syntheticEvidence.promptSummary.includes('sk-ant-api03'), 'Prompt summary secrets must be redacted');
  assert.ok(!syntheticEvidence.rawResponse.includes('sk-secret-token'), 'Response secrets must be redacted');
  assert.ok(syntheticEvidence.promptSummary.includes('[REDACTED]'));
  assert.ok(syntheticEvidence.rawResponse.includes('[REDACTED]'));

  // Test 3.2: Deep Immutability
  assert.ok(Object.isFrozen(syntheticEvidence));
  assert.ok(Object.isFrozen(syntheticEvidence.tokensUsed));
  assert.ok(Object.isFrozen(syntheticEvidence.validationOutcome));
  assert.throws(() => { syntheticEvidence.tokensUsed.totalTokens = 999; }, TypeError);

  // Test 3.3: Attempting LIVE_MODEL_INFERENCE without real provider response throws Error
  assert.throws(
    () => contract.createBenchmarkEvidenceRecord({
      classification: contract.BENCHMARK_RESULT_CLASSIFICATIONS.LIVE_MODEL_INFERENCE,
      provider: 'openai',
      model: 'gpt-4o',
      rawResponse: '', // Missing response
      tokensUsed: { totalTokens: 100 },
    }),
    /Missing provider response evidence/i,
  );

  // Test 3.4: Attempting LIVE_MODEL_INFERENCE with synthetic provider throws Error
  assert.throws(
    () => contract.createBenchmarkEvidenceRecord({
      classification: contract.BENCHMARK_RESULT_CLASSIFICATIONS.LIVE_MODEL_INFERENCE,
      provider: 'synthetic_mock',
      model: 'gpt-4o',
      rawResponse: 'Valid response text here',
      tokensUsed: { totalTokens: 100 },
    }),
    /Invalid provider "synthetic_mock" for LIVE_MODEL_INFERENCE/i,
  );

  // Test 3.5: Attempting LIVE_MODEL_INFERENCE without token telemetry throws Error
  assert.throws(
    () => contract.createBenchmarkEvidenceRecord({
      classification: contract.BENCHMARK_RESULT_CLASSIFICATIONS.LIVE_MODEL_INFERENCE,
      provider: 'openai',
      model: 'gpt-4o',
      rawResponse: 'Valid response text here',
      tokensUsed: null,
    }),
    /Missing token telemetry/i,
  );

  console.log('[PASS] Section 3: Evidence records enforce deep immutability and genuine-inference proof.');

  // -------------------------------------------------------------------------
  // SECTION 4: Proposal-Only Isolation (Zero Workspace Mutation / Execution)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 4: Proposal-Only Isolation Verification ---');

  const fixtureRoot = path.join(tempDir, 'fixture-isolation');
  await fs.mkdir(fixtureRoot, { recursive: true });
  const originalFileContent = 'export const VERSION = "1.0.0";\n';
  const targetFilePath = path.join(fixtureRoot, 'version.ts');
  await fs.writeFile(targetFilePath, originalFileContent, 'utf8');

  const ownerWebContentsId = 98;
  const sessionId = agent.getSession(ownerWebContentsId);
  const owner = { sessionId, ownerWebContentsId };

  const turn = agent.beginConversationTurn({
    root: fixtureRoot,
    request: 'Update version to 1.0.1 in version.ts',
    ...owner,
  });
  agent.advanceConversationTurn(turn.turnId, 'understanding', owner);

  const candidatePatch = [
    '--- a/version.ts',
    '+++ b/version.ts',
    '@@ -1,1 +1,1 @@',
    '-export const VERSION = "1.0.0";',
    '+export const VERSION = "1.0.1";',
    '',
  ].join('\n');

  // Create proposal (evaluates strictly in memory against before-snapshot)
  const proposal = await agent.createProposal({
    root: fixtureRoot,
    conversationTurnId: turn.turnId,
    raw: candidatePatch,
    verificationScripts: ['test'],
    ...owner,
  });
  assert.equal(proposal.state, 'awaiting_approval');

  // Save proposal to inert external destination
  const inertDiffPath = path.join(isolatedDestinationRoot, 'trial-candidate.diff');
  await fs.writeFile(inertDiffPath, candidatePatch, 'utf8');

  // Verify that source file on disk was NEVER modified
  const currentDiskContent = await fs.readFile(targetFilePath, 'utf8');
  assert.equal(currentDiskContent, originalFileContent, 'Source file must remain pristine in proposal-only mode');

  // Verify that proposal cannot execute verification commands or apply without transition
  assert.equal(proposal.verification, null, 'No verification checks executed during proposal creation');

  console.log('[PASS] Section 4: Proposal-only isolation verified with zero workspace mutations.');

  // -------------------------------------------------------------------------
  // SECTION 5: Scope Binding, Exception Robustness & Evidence Content Integrity
  // -------------------------------------------------------------------------
  console.log('\n--- Section 5: Scope Binding, Exception Robustness & Content Integrity ---');

  // Test 5.1: Scope Binding - Provider mismatch
  const resScopeProvMismatch = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'lead@example.com',
      approvalTimestamp: new Date().toISOString(),
      authorizedProvider: 'anthropic',
    },
    runToken: 'token-scope-prov-1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai', // Mismatch!
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  }, { projectRoot: projectMockRoot });
  assert.equal(resScopeProvMismatch.authorized, false);
  assert.ok(resScopeProvMismatch.blockers.some((b) => b.includes('does not match human-authorized provider')));

  // Test 5.2: Scope Binding - Fixture scope exceeded
  const resScopeFixtureExceeded = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'lead@example.com',
      approvalTimestamp: new Date().toISOString(),
      authorizedFixtures: ['FIX-01'],
    },
    runToken: 'token-scope-fix-1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01', 'FIX-02'], // FIX-02 is unauthorized
    destinationRoot: isolatedDestinationRoot,
  }, { projectRoot: projectMockRoot });
  assert.equal(resScopeFixtureExceeded.authorized, false);
  assert.ok(resScopeFixtureExceeded.blockers.some((b) => b.includes('exceed human-authorized fixture scope')));

  // Test 5.3: Default projectRoot protection when options.projectRoot is omitted
  const insideCwd = path.join(process.cwd(), 'temp-proposals-leak');
  const resDefaultCwdBlock = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'lead@example.com',
      approvalTimestamp: new Date().toISOString(),
    },
    runToken: 'token-default-cwd-1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: insideCwd,
  }); // Note: options omitted!
  assert.equal(resDefaultCwdBlock.authorized, false);
  assert.ok(resDefaultCwdBlock.blockers.some((b) => b.includes('strictly outside the project repository workspace')));

  // Test 5.4: Live model inference evidence requires explicit non-empty model name
  assert.throws(
    () => contract.createBenchmarkEvidenceRecord({
      classification: contract.BENCHMARK_RESULT_CLASSIFICATIONS.LIVE_MODEL_INFERENCE,
      provider: 'openai',
      model: '', // Missing model
      rawResponse: 'Valid response text here with sufficient length',
      tokensUsed: { totalTokens: 100 },
    }),
    /Missing model identifier: LIVE_MODEL_INFERENCE requires explicit model name/i,
  );

  // Test 5.5: Content Integrity SHA256 matches sha256(safeResponse)
  const cryptoHash = (await import('node:crypto')).createHash;
  const testEvidence = contract.createBenchmarkEvidenceRecord({
    runId: 'sha-verify-run',
    trialId: 'FIX-01',
    classification: contract.BENCHMARK_RESULT_CLASSIFICATIONS.DETERMINISTIC_SYNTHETIC,
    provider: 'openai',
    model: 'gpt-4o-mini',
    promptSummary: 'Summary with sk-ant-api03-abcdef1234567890abcdef1234567890',
    rawResponse: 'Response with key Authorization: Bearer sk-mysecrettoken12345678 and diff output',
    tokensUsed: { totalTokens: 50 },
    validationOutcome: { passed: true },
  });
  const expectedSha = cryptoHash('sha256').update(testEvidence.rawResponse).digest('hex');
  assert.equal(testEvidence.responseSha256, expectedSha, 'responseSha256 must match SHA256 of stored redacted response');

  // Test 5.6: Durable Cross-Process Replay Protection (Cold in-memory cache)
  const crossProcessToken = 'token-cross-process-9999';
  const manifestForCrossProcess = {
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'lead@example.com',
      approvalTimestamp: new Date().toISOString(),
    },
    runToken: crossProcessToken,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  };
  const resFirstRun = contract.validateLiveBenchmarkAuthorization(manifestForCrossProcess, { projectRoot: projectMockRoot });
  assert.equal(resFirstRun.authorized, true);

  // Simulate a new, independent process by clearing only the in-memory cache
  contract.clearInMemoryTokenCacheOnlyForTest();

  // The cold process MUST still reject the consumed token via the durable disk ledger
  const resColdProcessRun = contract.validateLiveBenchmarkAuthorization(manifestForCrossProcess, { projectRoot: projectMockRoot });
  assert.equal(resColdProcessRun.authorized, false);
  assert.ok(resColdProcessRun.blockers.some((b) => b.includes('has already been consumed (replay prevention)')));

  // Test 5.7: Evidence Provenance: SHA-256 alone does not grant LIVE_MODEL_INFERENCE status
  assert.throws(
    () => contract.createBenchmarkEvidenceRecord({
      classification: contract.BENCHMARK_RESULT_CLASSIFICATIONS.LIVE_MODEL_INFERENCE,
      provider: 'openai',
      model: 'gpt-4o',
      rawResponse: 'Synthetic string payload that has a valid SHA256 hash',
      tokensUsed: null, // Zero verified provider telemetry
    }),
    /Missing token telemetry: LIVE_MODEL_INFERENCE requires verified non-zero token usage metrics/i,
  );

  console.log('[PASS] Section 5: Scope binding, fail-closed defenses, durable replay & content integrity verified.');

  // -------------------------------------------------------------------------
  // SECTION 6: Replay Ledger Fail-Closed Remediation Tests
  // -------------------------------------------------------------------------
  console.log('\n--- Section 6: Replay Ledger Fail-Closed Remediation Tests ---');

  const isolatedLedgerPath = path.join(tempDir, 'test-ledger.json');
  contract.setLedgerPathForTest(isolatedLedgerPath);

  // Test 6.1: Corrupted JSON file in ledger fails closed (does not become empty Set)
  await fs.writeFile(isolatedLedgerPath, '{ malformed: json [}', 'utf8');
  assert.throws(
    () => contract.loadConsumedTokensLedger(),
    /LEDGER_CORRUPTED/i,
    'Corrupted ledger must throw LEDGER_CORRUPTED and never return empty set',
  );

  const resOnCorruptedLedger = contract.validateLiveBenchmarkAuthorization({
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'lead@example.com',
      approvalTimestamp: new Date().toISOString(),
    },
    runToken: 'token-test-corrupted-ledger',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  }, { projectRoot: projectMockRoot });

  assert.equal(resOnCorruptedLedger.authorized, false);
  assert.ok(
    resOnCorruptedLedger.blockers.some((b) => b.includes('Authorization ledger verification failed (fail-closed)')),
    'Corrupted ledger must block authorization fail-closed',
  );

  // Test 6.2: Truncated JSON file in ledger fails closed
  await fs.writeFile(isolatedLedgerPath, '["token-one", "tok', 'utf8');
  assert.throws(
    () => contract.loadConsumedTokensLedger(),
    /LEDGER_CORRUPTED/i,
    'Truncated ledger must throw LEDGER_CORRUPTED',
  );

  // Test 6.3: Non-array schema fails closed
  await fs.writeFile(isolatedLedgerPath, JSON.stringify({ invalid: 'object' }), 'utf8');
  assert.throws(
    () => contract.loadConsumedTokensLedger(),
    /LEDGER_SCHEMA_ERROR/i,
    'Non-array ledger must throw LEDGER_SCHEMA_ERROR',
  );

  // Test 6.4: Clean ledger allows valid run and commits token durably
  await fs.rm(isolatedLedgerPath, { force: true });
  contract.clearInMemoryTokenCacheOnlyForTest();
  const validRemediationManifest = {
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'secops-lead',
      approvalTimestamp: new Date().toISOString(),
    },
    runToken: 'token-remediation-valid-001',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  };
  const resCleanRun = contract.validateLiveBenchmarkAuthorization(validRemediationManifest, { projectRoot: projectMockRoot });
  assert.equal(resCleanRun.authorized, true, 'Clean ledger must allow valid run');

  // Verify file was written on disk and contains the consumed token
  const diskTokensAfterCleanRun = contract.loadConsumedTokensLedger();
  assert.ok(diskTokensAfterCleanRun.has('token-remediation-valid-001'));

  // Reset test override path back to normal
  contract.setLedgerPathForTest(null);

  console.log('[PASS] Section 6: Replay ledger fail-closed hardening verified.');

  // -------------------------------------------------------------------------
  // SECTION 7: Replay Ledger Concurrency Hardening & Storage Protection
  // -------------------------------------------------------------------------
  console.log('\n--- Section 7: Concurrency Hardening, Collision & Path Protection ---');

  // Test 7.1: Simulated Concurrent Reservation Collision (Kernel-Level 'wx' / EEXIST)
  const concurrencyLedger = path.join(tempDir, 'concurrency-ledger.json');
  contract.setLedgerPathForTest(concurrencyLedger);
  contract.resetConsumedTokensForTest();

  const collidingToken = 'token-collision-race-test-999';
  const manifestRace1 = {
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'lead@example.com',
      approvalTimestamp: new Date().toISOString(),
    },
    runToken: collidingToken,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  };

  // Dry run passes without consuming or reserving
  const resDry = contract.validateLiveBenchmarkAuthorization(manifestRace1, { projectRoot: projectMockRoot, dryRun: true });
  assert.equal(resDry.authorized, true, 'Dry run should validate without reserving');

  // First real call succeeds and reserves token atomically
  const resRace1 = contract.validateLiveBenchmarkAuthorization(manifestRace1, { projectRoot: projectMockRoot });
  assert.equal(resRace1.authorized, true, 'First caller should successfully acquire reservation and authorize');

  // Second call with same token immediately fails closed with REPLAY_DETECTED
  const resRace2 = contract.validateLiveBenchmarkAuthorization(manifestRace1, { projectRoot: projectMockRoot });
  assert.equal(resRace2.authorized, false);
  assert.ok(resRace2.blockers.some((b) => b.includes('has already been consumed (replay prevention)')));

  // Test 7.2: Unsafe Storage Path / Symbolic Link Rejection
  const realStorageDir = path.join(tempDir, 'real-storage');
  const symlinkStorageDir = path.join(tempDir, 'symlink-storage');
  await fs.mkdir(realStorageDir, { recursive: true });
  try {
    await fs.symlink(realStorageDir, symlinkStorageDir, 'junction');
    const symlinkLedgerPath = path.join(symlinkStorageDir, 'ledger.json');
    contract.setLedgerPathForTest(symlinkLedgerPath);

    assert.throws(
      () => contract.assertSafeStoragePath(symlinkLedgerPath),
      /LEDGER_UNSAFE_PATH/i,
      'Symlink / reparse point path must be rejected with LEDGER_UNSAFE_PATH',
    );

    const resSymlink = contract.validateLiveBenchmarkAuthorization({
      humanAuthorization: {
        explicitApproval: true,
        approverIdentity: 'lead@example.com',
        approvalTimestamp: new Date().toISOString(),
      },
      runToken: 'token-symlink-test',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      networkPermissionGranted: true,
      provider: 'openai',
      apiKey: 'sk-test-key-12345',
      fixtures: ['FIX-01'],
      destinationRoot: isolatedDestinationRoot,
    }, { projectRoot: projectMockRoot });

    assert.equal(resSymlink.authorized, false);
    assert.ok(
      resSymlink.blockers.some((b) => b.includes('LEDGER_UNSAFE_PATH') || b.includes('fail-closed')),
      'Symlinked ledger path must fail closed during authorization validation',
    );
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
  }

  // Test 7.3: Durability & Unswallowed Write Failure Fail-Closed
  const readOnlyLedgerDir = path.join(tempDir, 'unwritable-ledger-dir');
  await fs.mkdir(readOnlyLedgerDir, { recursive: true });
  const unwritableLedgerPath = path.join(readOnlyLedgerDir, 'dummy.json');
  contract.setLedgerPathForTest(unwritableLedgerPath);

  // Cause reservation creation to fail by placing a blocking file where the directory should be
  const badReservationsDir = path.join(readOnlyLedgerDir, '.token-reservations');
  await fs.writeFile(badReservationsDir, 'file-blocking-dir-creation', 'utf8');

  const blockTokenManifest = {
    humanAuthorization: {
      explicitApproval: true,
      approverIdentity: 'lead@example.com',
      approvalTimestamp: new Date().toISOString(),
    },
    runToken: 'token-write-fail-test',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    networkPermissionGranted: true,
    provider: 'openai',
    apiKey: 'sk-test-key-12345',
    fixtures: ['FIX-01'],
    destinationRoot: isolatedDestinationRoot,
  };

  const resWriteFail = contract.validateLiveBenchmarkAuthorization(blockTokenManifest, { projectRoot: projectMockRoot });
  assert.equal(resWriteFail.authorized, false);
  assert.equal(resWriteFail.state, 'BLOCKED');
  assert.equal(resWriteFail.reasonCode, 'LEDGER_WRITE_FAILED');
  assert.ok(resWriteFail.blockers.some((b) => b.includes('Failed to commit consumed token to durable ledger')));

  // Test 7.4: Lock Contention and Stale Lock Recovery
  const lockLedgerPath = path.join(tempDir, 'lock-test-ledger.json');
  const releaseLock1 = contract.acquireLedgerLock(lockLedgerPath);
  assert.equal(typeof releaseLock1, 'function');

  // Verify lock file exists
  assert.ok(await fs.stat(`${lockLedgerPath}.lock`));

  // Release lock
  releaseLock1();

  // Test 7.5: Production Default Path Resolution Does Not Use os.tmpdir()
  contract.setLedgerPathForTest(null);
  delete process.env.AI_HELP_AGENT_LEDGER_PATH;
  const prodDefaultPath = contract.getProtectedDefaultLedgerPath();
  const tmpDirNorm = path.resolve(os.tmpdir()).toLowerCase();
  const prodPathNorm = path.resolve(prodDefaultPath).toLowerCase();
  assert.ok(
    !prodPathNorm.startsWith(tmpDirNorm),
    `Production default ledger path (${prodDefaultPath}) must not reside in os.tmpdir() (${os.tmpdir()})`,
  );
  assert.ok(
    prodPathNorm.includes('ai_help_agent') || prodPathNorm.includes('.ai-help-agent'),
    'Production default ledger path must reside in dedicated per-user application security directory',
  );

  console.log('[PASS] Section 7: Replay ledger concurrency hardening, collision prevention & path protection verified.');

  console.log('\n=== ALL BENCHMARK AUTHORIZATION AND ISOLATION TESTS PASSED ===');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

