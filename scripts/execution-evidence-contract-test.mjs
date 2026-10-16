import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const contract = await import('../electron/coding-pipeline/executionEvidenceContract.cjs');
const lifecycle = await import('../electron/coding-pipeline/sandboxResourceLifecycle.cjs');
const adapterModule = await import('../electron/coding-pipeline/providerAdapterContract.cjs');
const dockerAdapterModule = await import('../electron/coding-pipeline/dockerProviderAdapter.cjs');
const isolation = await import('../electron/coding-pipeline/projectProcessIsolation.cjs');
const mainSource = await fs.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preloadSource = await fs.readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

const { createHostObservedEvidenceCollector, createProviderAdapter } = adapterModule;
const { createLocalDockerProviderAdapter } = dockerAdapterModule;
const { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, normalizeTimeoutMs } = contract;

const validManifest = contract.buildExecutionEvidenceManifest({
  runId: 'run-123',
  providerId: 'isolated-worker',
  providerConfigRevision: 'rev-42',
  approvedSnapshotDigest: 'abc123',
  approvedManifestDigest: 'def456',
  verificationPlanDigest: 'ghi789',
  workerIdentity: 'worker-1',
  evidenceTimestamp: new Date().toISOString(),
  evidenceExpiry: new Date(Date.now() + 60_000).toISOString(),
  provenance: 'host-owned',
  trustClass: 'APP_VERIFIED',
});

const result = contract.validateExecutionEvidenceManifest(validManifest, {
  runId: 'run-123',
  approvedSnapshotDigest: 'abc123',
  approvedManifestDigest: 'def456',
  verificationPlanDigest: 'ghi789',
  providerConfigRevision: 'rev-42',
  hostVerifierEstablished: true,
});
assert.equal(result.state, 'NOT_ESTABLISHED');
assert.equal(result.reasonCode, 'HOST_VERIFIER_NOT_ESTABLISHED');
assert.equal(validManifest.executionTimeoutMs, DEFAULT_TIMEOUT_MS);
assert.equal(normalizeTimeoutMs('60000'), 60000);
assert.throws(() => normalizeTimeoutMs(-1), /positive finite/i);
assert.throws(() => normalizeTimeoutMs(MAX_TIMEOUT_MS + 1), /exceeds the maximum/i);
assert.equal(isolation.projectProcessIsolationStatus().available, false);
assert.equal(isolation.projectProcessIsolationStatus().verified, false);
const allCapabilitiesClaimed = Object.fromEntries([
  'identityIsolation',
  'credentialIsolation',
  'egressControl',
  'resourceLimits',
  'runtimeCap',
  'outputCap',
  'cancellation',
  'cleanupEvidence',
].map((name) => [name, true]));
Object.assign(allCapabilitiesClaimed, {
  independentlyVerified: true,
  humanApproved: true,
  syntheticValidationPassed: true,
  executionAuthorized: true,
});
const stillBlocked = isolation.evaluateExecutionEvidence(validManifest, {
  runId: 'run-123',
  approvedSnapshotDigest: 'abc123',
  approvedManifestDigest: 'def456',
  verificationPlanDigest: 'ghi789',
  providerConfigRevision: 'rev-42',
}, allCapabilitiesClaimed);
assert.equal(stillBlocked.state, 'NOT_ESTABLISHED');
assert.throws(
  () => isolation.requireProjectProcessIsolation('Offline contract test', validManifest, { runId: 'run-123' }, {}),
  /was not started/i,
);

const expired = {
  ...validManifest,
  evidenceTimestamp: new Date(Date.now() - 60_000).toISOString(),
  evidenceExpiry: new Date(Date.now() - 1000).toISOString(),
};
const expiredResult = contract.validateExecutionEvidenceManifest(expired, { runId: 'run-123' });
assert.equal(expiredResult.state, 'BLOCKED');
assert.equal(expiredResult.reasonCode, 'EVIDENCE_EXPIRED');

const futureDated = {
  ...validManifest,
  evidenceTimestamp: new Date(Date.now() + 60_000).toISOString(),
};
const futureResult = contract.validateExecutionEvidenceManifest(futureDated, { runId: 'run-123' });
assert.equal(futureResult.state, 'BLOCKED');
assert.equal(futureResult.reasonCode, 'EVIDENCE_FUTURE_DATED');

const stale = {
  ...validManifest,
  evidenceTimestamp: new Date(Date.now() - 60_000).toISOString(),
};
const staleResult = contract.validateExecutionEvidenceManifest(stale, {
  runId: 'run-123',
  maxEvidenceAgeMs: 10_000,
});
assert.equal(staleResult.state, 'BLOCKED');
assert.equal(staleResult.reasonCode, 'EVIDENCE_STALE');

const contradictoryExpiry = {
  ...validManifest,
  evidenceExpiry: new Date(Date.parse(validManifest.evidenceTimestamp) - 1).toISOString(),
};
const contradictoryExpiryResult = contract.validateExecutionEvidenceManifest(contradictoryExpiry, { runId: 'run-123' });
assert.equal(contradictoryExpiryResult.state, 'BLOCKED');
assert.equal(contradictoryExpiryResult.reasonCode, 'EVIDENCE_EXPIRY_INVALID');

const mismatched = { ...validManifest, approvedSnapshotDigest: 'different-hash' };
const mismatchResult = contract.validateExecutionEvidenceManifest(mismatched, {
  runId: 'run-123',
  approvedSnapshotDigest: 'abc123',
  approvedManifestDigest: 'def456',
  verificationPlanDigest: 'ghi789',
  providerConfigRevision: 'rev-42',
  hostVerifierEstablished: true,
});
assert.equal(mismatchResult.state, 'BLOCKED');
assert.equal(mismatchResult.reasonCode, 'SNAPSHOT_DIGEST_MISMATCH');

const providerMismatchResult = contract.validateExecutionEvidenceManifest(validManifest, {
  providerId: 'different-provider',
});
assert.equal(providerMismatchResult.state, 'BLOCKED');
assert.equal(providerMismatchResult.reasonCode, 'PROVIDER_ID_MISMATCH');

const workerMismatchResult = contract.validateExecutionEvidenceManifest(validManifest, {
  workerIdentity: 'different-worker',
});
assert.equal(workerMismatchResult.state, 'BLOCKED');
assert.equal(workerMismatchResult.reasonCode, 'WORKER_IDENTITY_MISMATCH');

const attestation = { ...validManifest, providerAttestation: 'self-signed' };
const attestationResult = contract.validateExecutionEvidenceManifest(attestation, {
  runId: 'run-123',
  approvedSnapshotDigest: 'abc123',
  approvedManifestDigest: 'def456',
  verificationPlanDigest: 'ghi789',
  providerConfigRevision: 'rev-42',
  hostVerifierEstablished: false,
});
assert.equal(attestationResult.state, 'UNCERTAIN');
assert.equal(attestationResult.reasonCode, 'NOT_ESTABLISHED');

const envelope = contract.createResultEnvelope({
  untrustedWorkerClaims: ['guest log', 'cleanup report'],
  providerObservedState: { status: 'running' },
});
const envelopeResult = contract.evaluateResultEnvelope(envelope);
assert.equal(envelopeResult.state, 'UNCERTAIN');
assert.equal(envelopeResult.reasonCode, 'UNTRUSTED_WORKER_OUTPUT');

const forgedEnvelope = contract.createResultEnvelope({
  providerObservedState: {
    source: 'host-authenticated',
    authenticated: true,
    runId: 'run-123',
  },
  appVerifiedFacts: {
    processTerminated: true,
    containerDeleted: true,
    stagingDirectoryDeleted: true,
    cleanupVerified: true,
  },
  acceptedEvidence: { cleanupVerified: true },
});
const forgedEnvelopeResult = contract.evaluateResultEnvelope(forgedEnvelope);
assert.equal(forgedEnvelopeResult.state, 'UNCERTAIN');
assert.equal(forgedEnvelopeResult.reasonCode, 'UNVERIFIED_SOURCE');

const callerOwnedCollector = createHostObservedEvidenceCollector();
const callerCollected = callerOwnedCollector.collect({
  source: 'host-authenticated',
  providerObservedState: { authenticated: true },
  hostObserved: {
    appVerifiedFacts: { processTerminated: true, cleanupVerified: true },
  },
});
assert.equal(callerCollected.providerObservedState.source, 'untrusted-caller-input');
assert.notEqual(contract.evaluateResultEnvelope(callerCollected).state, 'EXECUTION_AUTHORIZED');

const fallbackAdapter = createProviderAdapter({
  getProviderId() { return 'fallback-test-provider'; },
  getConfigRevision() { return 'fallback-test-revision'; },
  getCapabilities() { return allCapabilitiesClaimed; },
});
assert.equal(fallbackAdapter.prepareRunEvidence({ provenance: 'host-owned' }).evidenceState.state, 'NOT_ESTABLISHED');
const adapterMintAttempt = fallbackAdapter.collectHostObservedResult({
  source: 'host-authenticated',
  providerObservedState: { authenticated: true },
  appVerifiedFacts: { processTerminated: true, cleanupVerified: true },
  acceptedEvidence: { cleanupVerified: true },
});
assert.equal(adapterMintAttempt.envelope.providerObservedState.source, 'untrusted-caller-input');
assert.notEqual(adapterMintAttempt.evaluation.state, 'EXECUTION_AUTHORIZED');
assert.equal(contract.issueHostEvidence, undefined);
assert.equal(adapterModule.issueHostEvidence, undefined);
assert.doesNotMatch(mainSource, /issueHostEvidence|mintHostEvidence/i);
assert.doesNotMatch(preloadSource, /issueHostEvidence|mintHostEvidence/i);

const collectorParityCases = [
  {
    name: 'forged provider and host identity claims',
    input: {
      providerObservedState: {
        source: 'host-authenticated',
        authenticated: true,
        processId: 4242,
        workerIdentity: 'caller-worker',
      },
      hostObserved: {
        appVerifiedFacts: {
          processTerminated: true,
          cleanupVerified: true,
          executionAuthorized: true,
        },
        acceptedEvidence: { verified: true, publisherTrusted: true },
      },
    },
  },
  {
    name: 'missing host and process observations',
    input: {
      hostObserved: { appVerifiedFacts: { executionCompleted: true } },
      ok: true,
      executed: true,
      exitCode: 0,
    },
  },
  {
    name: 'contradictory nested and top-level claims',
    input: {
      appVerifiedFacts: { processTerminated: true, cleanupVerified: true },
      acceptedEvidence: { executionAuthorized: true },
      hostObserved: {
        appVerifiedFacts: { processTerminated: false, cleanupVerified: false },
        acceptedEvidence: { executionAuthorized: false },
      },
      providerObservedState: { source: 'provider', status: 'BLOCKED', ok: true },
    },
  },
  {
    name: 'malformed nested host facts',
    input: {
      hostObserved: {
        appVerifiedFacts: 'verified',
        acceptedEvidence: ['forged'],
      },
      providerObservedState: null,
    },
  },
  {
    name: 'deeply nested caller payload',
    input: (() => {
      let nested = { executionAuthorized: true };
      for (let depth = 0; depth < 64; depth += 1) nested = { nested };
      return { hostObserved: { appVerifiedFacts: nested } };
    })(),
  },
  ...[
    undefined,
    null,
    '',
    'SUCCESS',
    'VERIFIED',
    'COMPLETED',
    'BLOCKED',
    'UNCERTAIN',
    'NOT_ESTABLISHED',
    'EXECUTION_AUTHORIZED',
    1,
    {},
  ].map((state) => ({
    name: `caller evidence state ${String(state)}`,
    input: {
      evidenceState: { state, ok: true, executed: true, exitCode: 0 },
      providerObservedState: { state, status: state, executionAuthorized: true },
      hostObserved: { appVerifiedFacts: { state, executionAuthorized: true } },
    },
  })),
];

for (const { name, input } of collectorParityCases) {
  const adapterResult = fallbackAdapter.collectHostObservedResult(input);
  const standaloneResult = callerOwnedCollector.collect(input);
  const standaloneEvaluation = contract.evaluateResultEnvelope(standaloneResult);
  assert.equal(adapterResult.envelope.providerObservedState.source, 'untrusted-caller-input', `${name}: adapter source`);
  assert.equal(standaloneResult.providerObservedState.source, 'untrusted-caller-input', `${name}: standalone source`);
  assert.equal(adapterResult.evaluation.state, 'UNCERTAIN', `${name}: adapter must remain unresolved`);
  assert.equal(standaloneEvaluation.state, 'UNCERTAIN', `${name}: standalone must remain unresolved`);
  assert.equal(adapterResult.evaluation.reasonCode, 'SIMULATED_EVIDENCE', `${name}: adapter reason`);
  assert.equal(standaloneEvaluation.reasonCode, 'SIMULATED_EVIDENCE', `${name}: standalone reason`);
  assert.notEqual(adapterResult.evaluation.state, 'ELIGIBLE_FOR_HUMAN_REVIEW');
  assert.notEqual(standaloneEvaluation.state, 'ELIGIBLE_FOR_HUMAN_REVIEW');
  assert.notEqual(adapterResult.evaluation.state, 'EXECUTION_AUTHORIZED');
  assert.notEqual(standaloneEvaluation.state, 'EXECUTION_AUTHORIZED');
}

const legacyTopLevelClaims = {
  appVerifiedFacts: { processTerminated: true, cleanupVerified: true },
  acceptedEvidence: { cleanupVerified: true },
};
// The adapter has an explicit legacy top-level fallback; the standalone collector
// only reads nested hostObserved facts. Both paths must still remain unresolved.
const adapterLegacyResult = fallbackAdapter.collectHostObservedResult(legacyTopLevelClaims);
const standaloneLegacyResult = callerOwnedCollector.collect(legacyTopLevelClaims);
const standaloneLegacyEvaluation = contract.evaluateResultEnvelope(standaloneLegacyResult);
assert.deepEqual(adapterLegacyResult.envelope.appVerifiedFacts, legacyTopLevelClaims.appVerifiedFacts);
assert.deepEqual(adapterLegacyResult.envelope.acceptedEvidence, legacyTopLevelClaims.acceptedEvidence);
assert.deepEqual(standaloneLegacyResult.appVerifiedFacts, {});
assert.deepEqual(standaloneLegacyResult.acceptedEvidence, {});
assert.equal(adapterLegacyResult.evaluation.state, 'UNCERTAIN');
assert.equal(standaloneLegacyEvaluation.state, 'UNCERTAIN');
assert.equal(adapterLegacyResult.evaluation.reasonCode, 'SIMULATED_EVIDENCE');
assert.equal(standaloneLegacyEvaluation.reasonCode, 'SIMULATED_EVIDENCE');

const successfulCapabilityClaims = {
  ...allCapabilitiesClaimed,
  independentlyVerified: true,
  humanApproved: true,
  syntheticValidationPassed: true,
  executionAuthorized: true,
};
const invalidEvidenceStates = [
  {},
  { state: '' },
  { state: '   ' },
  { state: 'SUCCESS' },
  { state: 'VERIFIED' },
  { state: 'COMPLETED' },
  { state: 'ELIGIBLE_FOR_HUMAN_REVIEW' },
  { state: 1 },
  { state: {} },
  { state: null },
  { state: undefined },
  null,
  undefined,
  'EXECUTION_AUTHORIZED',
];
for (const evidenceState of invalidEvidenceStates) {
  const decision = contract.evaluateProviderEligibility(successfulCapabilityClaims, evidenceState);
  assert.equal(decision.state, 'BLOCKED', `Invalid evidence state ${JSON.stringify(evidenceState)} must fail closed.`);
  assert.equal(decision.reasonCode, 'EVIDENCE_STATE_INVALID');
  assert.notEqual(decision.state, 'ELIGIBLE_FOR_HUMAN_REVIEW');
  assert.notEqual(decision.state, 'EXECUTION_AUTHORIZED');

  const contradictoryDecision = contract.evaluateProviderEligibility(successfulCapabilityClaims, {
    ...(evidenceState && typeof evidenceState === 'object' && !Array.isArray(evidenceState) ? evidenceState : {}),
    ok: true,
    executed: true,
    exitCode: 0,
  });
  assert.equal(contradictoryDecision.state, 'BLOCKED');
  assert.equal(contradictoryDecision.reasonCode, 'EVIDENCE_STATE_INVALID');
}

const omittedEvidenceStateDecision = contract.evaluateProviderEligibility(successfulCapabilityClaims);
assert.equal(omittedEvidenceStateDecision.state, 'BLOCKED');
assert.equal(omittedEvidenceStateDecision.reasonCode, 'EVIDENCE_INVALID');

for (const [state, expected] of [
  ['BLOCKED', 'BLOCKED'],
  ['UNCERTAIN', 'UNCERTAIN'],
  ['NOT_ESTABLISHED', 'UNCERTAIN'],
]) {
  const decision = contract.evaluateProviderEligibility(successfulCapabilityClaims, {
    state,
    ok: true,
    executed: true,
    exitCode: 0,
  });
  assert.equal(decision.state, expected, `${state} must retain its existing fail-closed behavior.`);
  assert.notEqual(decision.state, 'EXECUTION_AUTHORIZED');
}

const callerSuppliedAuthorizationForReview = contract.evaluateProviderEligibility({
  ...successfulCapabilityClaims,
  humanApproved: false,
}, {
  state: 'EXECUTION_AUTHORIZED',
  ok: true,
  executed: true,
  exitCode: 0,
});
assert.equal(callerSuppliedAuthorizationForReview.state, 'ELIGIBLE_FOR_HUMAN_REVIEW');
assert.notEqual(callerSuppliedAuthorizationForReview.state, 'EXECUTION_AUTHORIZED');
assert.throws(
  () => isolation.requireProjectProcessIsolation(
    'Human-review eligibility is not authorization',
    validManifest,
    { runId: 'run-123' },
    successfulCapabilityClaims,
  ),
  /was not started/i,
);

const providerDecision = contract.evaluateProviderEligibility({
  identityIsolation: true,
  credentialIsolation: true,
  egressControl: true,
  resourceLimits: true,
  runtimeCap: true,
  outputCap: true,
  cancellation: true,
  cleanupEvidence: true,
  independentlyVerified: false,
  humanApproved: true,
  syntheticValidationPassed: true,
  executionAuthorized: true,
}, { state: 'EXECUTION_AUTHORIZED', reasonCode: 'VALID', reason: 'valid' });
assert.equal(providerDecision.state, 'UNCERTAIN');
assert.equal(providerDecision.reasonCode, 'VERIFICATION_NOT_ESTABLISHED');

const forgedProviderDecision = contract.evaluateProviderEligibility({
  identityIsolation: true,
  credentialIsolation: true,
  egressControl: true,
  resourceLimits: true,
  runtimeCap: true,
  outputCap: true,
  cancellation: true,
  cleanupEvidence: true,
  independentlyVerified: true,
  humanApproved: true,
  syntheticValidationPassed: true,
  executionAuthorized: true,
}, { state: 'EXECUTION_AUTHORIZED', reasonCode: 'VALID', reason: 'caller-supplied' });
assert.equal(forgedProviderDecision.state, 'NOT_ESTABLISHED');
assert.equal(forgedProviderDecision.reasonCode, 'HOST_EVIDENCE_ISSUER_MISSING');

for (const missingCapability of [
  'identityIsolation',
  'credentialIsolation',
  'egressControl',
  'resourceLimits',
  'runtimeCap',
  'outputCap',
  'cancellation',
  'cleanupEvidence',
]) {
  const incompleteCapabilities = {
    ...allCapabilitiesClaimed,
    [missingCapability]: false,
  };
  const incompleteDecision = contract.evaluateProviderEligibility(incompleteCapabilities, {
    state: 'EXECUTION_AUTHORIZED',
    reasonCode: 'FIXTURE_ONLY',
    reason: 'Caller-supplied state must not establish host authorization.',
  });
  assert.equal(incompleteDecision.state, 'BLOCKED', `${missingCapability} must remain mandatory`);
  assert.equal(incompleteDecision.reasonCode, 'REQUIRED_CAPABILITY_MISSING');
}

const lifecycleBinding = {
  runId: 'run-123',
  providerId: 'isolated-worker',
  workerIdentity: 'worker-1',
  resourceId: 'resource-1',
};
const completeShutdownObservation = {
  launcherPid: 123,
  launcherTerminated: true,
  sandboxClientsRemaining: 0,
  ownedSandboxProcessCount: 0,
  sandboxResourceAbsent: true,
  sandboxHandlesReleased: true,
};
assert.equal(lifecycle.hasVerifiedShutdownObservation(completeShutdownObservation, 123), true);
for (const [field, value] of [
  ['launcherPid', 456],
  ['launcherTerminated', false],
  ['sandboxClientsRemaining', 1],
  ['ownedSandboxProcessCount', 1],
  ['sandboxResourceAbsent', false],
  ['sandboxHandlesReleased', false],
]) {
  assert.equal(
    lifecycle.hasVerifiedShutdownObservation({ ...completeShutdownObservation, [field]: value }, 123),
    false,
    `${field} must be required to release a started resource`,
  );
}
let incompleteShutdownRemovalAttempted = false;
const incompleteShutdownLifecycle = lifecycle.createSandboxResourceLifecycle({
  createTemporaryRoot: async () => 'fixture-root',
  waitForShutdown: async () => ({
    launcherPid: 123,
    launcherTerminated: true,
    sandboxClientsRemaining: 0,
    ownedSandboxProcessCount: 0,
    sandboxResourceAbsent: true,
    sandboxHandlesReleased: false,
  }),
  removeTemporaryRoot: async () => {
    incompleteShutdownRemovalAttempted = true;
  },
  verifyTemporaryRootRemoved: async () => true,
});
const incompleteShutdownResource = await incompleteShutdownLifecycle.createResource({ runId: 'incomplete-shutdown-run' });
incompleteShutdownLifecycle.markLaunchStarting(incompleteShutdownResource);
incompleteShutdownLifecycle.markLauncherStarted(incompleteShutdownResource, { pid: 123 });
await assert.rejects(incompleteShutdownLifecycle.cleanup(incompleteShutdownResource), /shutdown.*unverified/i);
assert.equal(incompleteShutdownRemovalAttempted, false);
assert.equal(incompleteShutdownLifecycle.getStatus(incompleteShutdownResource).quarantined, true);
assert.equal(incompleteShutdownLifecycle.getStatus(incompleteShutdownResource).leaseActive, true);
assert.throws(
  () => lifecycle.transitionSandboxResourceState({
    launchState: 'started',
    cleanupVerified: false,
    stagingDirectoryRemoved: false,
    quarantined: true,
    leaseActive: true,
  }, 'cleanup-succeeded'),
  /cannot release its lease/i,
);
await assert.rejects(
  incompleteShutdownLifecycle.createResource({ runId: 'blocked-after-incomplete-shutdown' }),
  /still active or quarantined/i,
);

function lifecycleEvidence(claim, operation, overrides = {}) {
  return {
    ...lifecycleBinding,
    operation,
    claim,
    value: true,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    operationId: `operation-${claim}`,
    nonce: `nonce-${claim}`,
    sequenceNumber: 1,
    source: 'host-verified',
    authenticated: true,
    ...overrides,
  };
}

const cleanupReview = lifecycle.evaluateLifecycleClaim(
  'cleanupVerified',
  lifecycleEvidence('cleanupVerified', 'cleanup-verification'),
  lifecycleBinding,
);
assert.equal(cleanupReview.state, 'NOT_ESTABLISHED');
assert.equal(cleanupReview.reasonCode, 'HOST_EVIDENCE_ISSUER_MISSING');

const timeoutReview = lifecycle.evaluateLifecycleClaim(
  'executionTimedOut',
  lifecycleEvidence('executionTimedOut', 'execution-timeout'),
  lifecycleBinding,
);
assert.equal(timeoutReview.state, 'NOT_ESTABLISHED');

for (const [claim, operation] of [
  ['runtimeIdentityVerified', 'runtime-identity-observation'],
  ['networkPolicyEnforced', 'endpoint-policy-observation'],
  ['processCreated', 'process-creation'],
  ['processTerminated', 'process-termination'],
  ['launcherTerminated', 'launcher-termination'],
  ['guestTerminated', 'guest-termination'],
  ['workerTerminated', 'worker-termination'],
  ['processTreeTerminated', 'process-tree-termination'],
  ['resourceCreated', 'resource-creation'],
  ['resourceDeleted', 'resource-deletion'],
  ['stagingDirectoryRemoved', 'staging-directory-removal'],
  ['sandboxHandlesReleased', 'handle-release'],
  ['cleanupVerified', 'cleanup-verification'],
  ['secureErasureProven', 'secure-erasure'],
]) {
  const observed = lifecycle.evaluateLifecycleClaim(claim, lifecycleEvidence(claim, operation), lifecycleBinding);
  assert.equal(observed.state, 'NOT_ESTABLISHED');
  assert.notEqual(observed.state, 'EXECUTION_AUTHORIZED');
}

for (const [claim, operation] of [
  ['launcherTerminated', 'launcher-termination'],
  ['guestTerminated', 'guest-termination'],
  ['workerTerminated', 'worker-termination'],
  ['processTreeTerminated', 'process-tree-termination'],
]) {
  const missingTermination = lifecycle.evaluateLifecycleClaim(claim, null, lifecycleBinding);
  assert.equal(missingTermination.state, 'NOT_ESTABLISHED');
  assert.equal(missingTermination.reasonCode, 'NOT_ESTABLISHED');
  const wrongTerminationSubject = lifecycle.evaluateLifecycleClaim(
    claim,
    lifecycleEvidence('launcherTerminated', 'launcher-termination'),
    lifecycleBinding,
  );
  if (operation === 'launcher-termination') {
    assert.equal(wrongTerminationSubject.state, 'NOT_ESTABLISHED');
  } else {
    assert.equal(wrongTerminationSubject.state, 'BLOCKED');
    assert.equal(wrongTerminationSubject.reasonCode, 'LIFECYCLE_BINDING_MISMATCH');
  }
}

for (const [claim, operation] of [
  ['processTerminated', 'staging-directory-removal'],
  ['resourceDeleted', 'handle-release'],
  ['stagingDirectoryRemoved', 'resource-deletion'],
  ['sandboxHandlesReleased', 'process-termination'],
  ['secureErasureProven', 'resource-deletion'],
]) {
  const mismatchedClaim = lifecycle.evaluateLifecycleClaim(
    claim,
    lifecycleEvidence(claim, operation),
    lifecycleBinding,
  );
  assert.equal(mismatchedClaim.state, 'BLOCKED');
  assert.equal(mismatchedClaim.reasonCode, 'LIFECYCLE_BINDING_MISMATCH');
}

const forgedDeletionReview = lifecycle.evaluateLifecycleClaim(
  'resourceDeleted',
  lifecycleEvidence('resourceDeleted', 'resource-deletion', { source: 'guest', authenticated: true }),
  lifecycleBinding,
);
assert.equal(forgedDeletionReview.state, 'NOT_ESTABLISHED');

for (const [field, value] of [
  ['runId', 'different-run'],
  ['providerId', 'different-provider'],
  ['workerIdentity', 'different-worker'],
  ['resourceId', 'different-resource'],
  ['operation', 'process-termination'],
]) {
  const evidence = lifecycleEvidence('cleanupVerified', 'cleanup-verification', { [field]: value });
  const result = lifecycle.evaluateLifecycleClaim('cleanupVerified', evidence, lifecycleBinding);
  assert.equal(result.state, 'BLOCKED', `${field} mismatch must block`);
  assert.equal(result.reasonCode, 'LIFECYCLE_BINDING_MISMATCH');
}

const replayedLifecycleEvidence = lifecycle.evaluateLifecycleClaim(
  'cleanupVerified',
  lifecycleEvidence('cleanupVerified', 'cleanup-verification'),
  { ...lifecycleBinding, runId: 'next-run' },
);
assert.equal(replayedLifecycleEvidence.state, 'BLOCKED');
assert.equal(replayedLifecycleEvidence.reasonCode, 'LIFECYCLE_BINDING_MISMATCH');

const lifecycleLedger = lifecycle.createLifecycleObservationLedger();
const firstSequencedObservation = lifecycleEvidence(
  'cleanupVerified',
  'cleanup-verification',
  { operationId: 'operation-1', nonce: 'nonce-1', sequenceNumber: 1 },
);
assert.equal(
  lifecycleLedger.review('cleanupVerified', firstSequencedObservation, lifecycleBinding).state,
  'NOT_ESTABLISHED',
);
const duplicatedSequencedObservation = lifecycleLedger.review(
  'cleanupVerified',
  firstSequencedObservation,
  lifecycleBinding,
);
assert.equal(duplicatedSequencedObservation.state, 'BLOCKED');
assert.equal(duplicatedSequencedObservation.reasonCode, 'LIFECYCLE_REPLAY_OR_REORDER');
assert.equal(
  lifecycleLedger.review(
    'cleanupVerified',
    lifecycleEvidence('cleanupVerified', 'cleanup-verification', {
      operationId: 'operation-2',
      nonce: 'nonce-2',
      sequenceNumber: 2,
    }),
    lifecycleBinding,
  ).state,
  'NOT_ESTABLISHED',
);
const outOfOrderObservation = lifecycleLedger.review(
  'cleanupVerified',
  lifecycleEvidence('cleanupVerified', 'cleanup-verification', {
    operationId: 'operation-3',
    nonce: 'nonce-3',
    sequenceNumber: 1,
  }),
  lifecycleBinding,
);
assert.equal(outOfOrderObservation.state, 'BLOCKED');
assert.equal(outOfOrderObservation.reasonCode, 'LIFECYCLE_REPLAY_OR_REORDER');
const incompleteSequencedObservation = lifecycle.createLifecycleObservationLedger().review(
  'cleanupVerified',
  lifecycleEvidence('cleanupVerified', 'cleanup-verification', { nonce: '', sequenceNumber: 0 }),
  lifecycleBinding,
);
assert.equal(incompleteSequencedObservation.state, 'BLOCKED');
assert.equal(incompleteSequencedObservation.reasonCode, 'LIFECYCLE_ENVELOPE_INCOMPLETE');

const staleLifecycleEvidence = lifecycle.evaluateLifecycleClaim(
  'cleanupVerified',
  lifecycleEvidence('cleanupVerified', 'cleanup-verification', {
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  }),
  lifecycleBinding,
);
assert.equal(staleLifecycleEvidence.state, 'BLOCKED');
assert.equal(staleLifecycleEvidence.reasonCode, 'LIFECYCLE_OBSERVATION_STALE');

const staleByObservationTime = lifecycle.evaluateLifecycleClaim(
  'cleanupVerified',
  lifecycleEvidence('cleanupVerified', 'cleanup-verification', {
    observedAt: new Date(Date.now() - lifecycle.MAX_LIFECYCLE_OBSERVATION_AGE_MS - 1).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  lifecycleBinding,
);
assert.equal(staleByObservationTime.state, 'BLOCKED');
assert.equal(staleByObservationTime.reasonCode, 'LIFECYCLE_OBSERVATION_STALE');

const contradictoryLifecycleTimestamps = lifecycle.evaluateLifecycleClaim(
  'cleanupVerified',
  lifecycleEvidence('cleanupVerified', 'cleanup-verification', {
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 120_000).toISOString(),
  }),
  lifecycleBinding,
);
assert.equal(contradictoryLifecycleTimestamps.state, 'BLOCKED');
assert.equal(contradictoryLifecycleTimestamps.reasonCode, 'LIFECYCLE_OBSERVATION_INVALID');

for (const unknownClaim of ['constructor', 'toString', '__proto__', 'unknown-operation']) {
  const invalidClaim = lifecycle.evaluateLifecycleClaim(unknownClaim, {}, lifecycleBinding);
  assert.equal(invalidClaim.state, 'BLOCKED', `${unknownClaim} must not resolve through the claim-map prototype`);
  assert.equal(invalidClaim.reasonCode, 'CLAIM_INVALID');
}

const contradictoryLifecycleEvidence = lifecycle.evaluateLifecycleClaim(
  'resourceDeleted',
  lifecycleEvidence('resourceDeleted', 'resource-deletion', { contradictory: true }),
  lifecycleBinding,
);
assert.equal(contradictoryLifecycleEvidence.state, 'UNCERTAIN');
assert.equal(contradictoryLifecycleEvidence.reasonCode, 'LIFECYCLE_OBSERVATION_INCOMPLETE');

const operationReplay = lifecycle.evaluateLifecycleClaim(
  'resourceDeleted',
  lifecycleEvidence('processTerminated', 'process-termination'),
  lifecycleBinding,
);
assert.equal(operationReplay.state, 'BLOCKED');

const secureErasureReview = lifecycle.evaluateLifecycleClaim(
  'secureErasureProven',
  lifecycleEvidence('secureErasureProven', 'secure-erasure'),
  lifecycleBinding,
);
assert.equal(secureErasureReview.state, 'NOT_ESTABLISHED');
assert.equal(secureErasureReview.reasonCode, 'SECURE_ERASURE_NOT_ESTABLISHED');

const dockerAdapter = createLocalDockerProviderAdapter();
const dockerLifecycleExpected = {
  runId: 'run-123',
  providerId: 'local-docker',
  workerIdentity: 'worker-1',
  resourceId: 'container-1',
};
const dockerLifecycleEvidence = {
  ...dockerLifecycleExpected,
  claim: 'resourceDeleted',
  operation: 'resource-deletion',
  value: true,
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  source: 'fixture',
  authenticated: true,
};
assert.equal(
  dockerAdapter.evaluateLifecycle('resourceDeleted', dockerLifecycleEvidence).reasonCode,
  'LIFECYCLE_BINDING_CONTEXT_MISSING',
);
const dockerLifecycleDecision = dockerAdapter.evaluateLifecycle(
  'resourceDeleted',
  dockerLifecycleEvidence,
  dockerLifecycleExpected,
);
assert.equal(dockerLifecycleDecision.state, 'NOT_ESTABLISHED');
assert.equal(dockerLifecycleDecision.reasonCode, 'HOST_EVIDENCE_ISSUER_MISSING');
const dockerLifecycleMismatch = dockerAdapter.evaluateLifecycle(
  'resourceDeleted',
  dockerLifecycleEvidence,
  { ...dockerLifecycleExpected, resourceId: 'other-container' },
);
assert.equal(dockerLifecycleMismatch.state, 'BLOCKED');
assert.equal(dockerLifecycleMismatch.reasonCode, 'LIFECYCLE_BINDING_MISMATCH');

const syntheticVerifiedAdapter = createProviderAdapter({
  getProviderId() { return 'synthetic-host-verified'; },
  getConfigRevision() { return 'provider-rev-9'; },
  getCapabilities() {
    return {
      documented: true,
      configured: true,
      runtimeAvailable: true,
      independentlyVerified: true,
      humanApproved: true,
      syntheticValidationPassed: true,
      executionAuthorized: true,
      identityIsolation: true,
      credentialIsolation: true,
      egressControl: true,
      resourceLimits: true,
      runtimeCap: true,
      outputCap: true,
      cancellation: true,
      cleanupEvidence: true,
    };
  },
  prepareRunEvidence(runContext = {}) {
    const manifest = contract.buildExecutionEvidenceManifest({
      runId: runContext.runId || 'synthetic-run',
      providerId: this.getProviderId(),
      providerConfigRevision: this.getConfigRevision(),
      approvedSnapshotDigest: 'abc123',
      approvedManifestDigest: 'def456',
      verificationPlanDigest: 'ghi789',
      workerIdentity: 'host-worker',
      evidenceExpiry: new Date(Date.now() + 600_000).toISOString(),
      provenance: 'host-owned',
      trustClass: 'APP_VERIFIED',
    });
    const evidenceState = contract.validateExecutionEvidenceManifest(manifest, {
      runId: runContext.runId || 'synthetic-run',
      approvedSnapshotDigest: 'abc123',
      approvedManifestDigest: 'def456',
      verificationPlanDigest: 'ghi789',
      providerConfigRevision: this.getConfigRevision(),
      hostVerifierEstablished: true,
    });
    return { manifest, evidenceState };
  },
  collectHostObservedResult(rawRunState = {}) {
    const envelope = contract.createResultEnvelope({
      providerObservedState: {
        source: 'host-authenticated',
        authenticated: true,
        status: 'completed',
        runId: rawRunState.runId,
      },
      appVerifiedFacts: {
        processTerminated: true,
        cleanupVerified: true,
        runId: rawRunState.runId,
      },
      acceptedEvidence: { cleanupVerified: true },
    });
    return {
      envelope,
      evaluation: contract.evaluateResultEnvelope(envelope),
    };
  },
});

const syntheticRun = syntheticVerifiedAdapter.prepareRunEvidence({
  runId: 'synthetic-run',
  approvedSnapshotDigest: 'abc123',
  approvedManifestDigest: 'def456',
  verificationPlanDigest: 'ghi789',
  providerConfigRevision: 'provider-rev-9',
  hostVerifierEstablished: true,
});
assert.equal(syntheticRun.evidenceState.state, 'NOT_ESTABLISHED');
const syntheticResult = syntheticVerifiedAdapter.collectHostObservedResult({
  runId: 'synthetic-run',
  approvedSnapshotDigest: 'abc123',
  approvedManifestDigest: 'def456',
  verificationPlanDigest: 'ghi789',
  providerConfigRevision: 'provider-rev-9',
  hostVerifierEstablished: true,
});
assert.equal(syntheticResult.evaluation.state, 'UNCERTAIN');
assert.equal(syntheticResult.evaluation.reasonCode, 'UNVERIFIED_SOURCE');
assert.equal(syntheticResult.envelope.appVerifiedFacts.cleanupVerified, true);

const unverifiedAdapter = createProviderAdapter({
  getProviderId() { return 'synthetic-unverified'; },
  getConfigRevision() { return 'rev-1'; },
  getCapabilities() {
    return {
      documented: true,
      configured: true,
      runtimeAvailable: true,
      independentlyVerified: false,
      humanApproved: true,
      syntheticValidationPassed: true,
      executionAuthorized: true,
      identityIsolation: true,
      credentialIsolation: true,
      egressControl: true,
      resourceLimits: true,
      runtimeCap: true,
      outputCap: true,
      cancellation: true,
      cleanupEvidence: true,
    };
  },
  prepareRunEvidence(runContext = {}) {
    const manifest = contract.buildExecutionEvidenceManifest({
      runId: runContext.runId || 'synthetic-unverified-run',
      providerId: this.getProviderId(),
      providerConfigRevision: this.getConfigRevision(),
      approvedSnapshotDigest: runContext.approvedSnapshotDigest || 'abc123',
      approvedManifestDigest: runContext.approvedManifestDigest || 'def456',
      verificationPlanDigest: runContext.verificationPlanDigest || 'ghi789',
      workerIdentity: 'host-worker',
      evidenceExpiry: new Date(Date.now() + 600_000).toISOString(),
      provenance: 'host-owned',
      trustClass: 'APP_VERIFIED',
    });
    const evidenceState = contract.validateExecutionEvidenceManifest(manifest, {
      runId: runContext.runId || 'synthetic-unverified-run',
      approvedSnapshotDigest: runContext.approvedSnapshotDigest || 'abc123',
      approvedManifestDigest: runContext.approvedManifestDigest || 'def456',
      verificationPlanDigest: runContext.verificationPlanDigest || 'ghi789',
      providerConfigRevision: this.getConfigRevision(),
      hostVerifierEstablished: true,
    });
    return { manifest, evidenceState };
  },
  collectHostObservedResult(rawRunState = {}) {
    return { envelope: contract.createResultEnvelope({ providerObservedState: { status: 'running' }, appVerifiedFacts: { processRunning: true } }), evaluation: contract.evaluateResultEnvelope(contract.createResultEnvelope({ providerObservedState: { status: 'running' }, appVerifiedFacts: { processRunning: true } })) };
  },
});
const unverifiedDecision = contract.evaluateProviderEligibility(unverifiedAdapter.getCapabilities(), {
  state: 'EXECUTION_AUTHORIZED',
  reasonCode: 'VALID',
  reason: 'evidence accepted for validation',
});
assert.equal(unverifiedDecision.state, 'UNCERTAIN');
assert.equal(unverifiedDecision.reasonCode, 'VERIFICATION_NOT_ESTABLISHED');

console.log('[PASS] Execution evidence contract rules and lifecycle trust boundary verified.');
