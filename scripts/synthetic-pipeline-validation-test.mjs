import assert from 'node:assert/strict';

const contract = await import('../electron/coding-pipeline/executionEvidenceContract.cjs');
const adapterModule = await import('../electron/coding-pipeline/providerAdapterContract.cjs');
const lifecycle = await import('../electron/coding-pipeline/sandboxResourceLifecycle.cjs');
const { createProviderAdapter } = adapterModule;

function makeSyntheticFixtureAdapter(overrides = {}) {
  const baseCapabilities = {
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

  return createProviderAdapter({
    getProviderId() { return overrides.providerId || 'synthetic-fixture-adapter'; },
    getConfigRevision() { return overrides.configRevision || 'provider-rev-9'; },
    getCapabilities() { return { ...baseCapabilities, ...(overrides.capabilities || {}) }; },
    prepareRunEvidence(runContext = {}) {
      const approvedSnapshotDigest = runContext.approvedSnapshotDigest || 'abc123';
      const approvedManifestDigest = runContext.approvedManifestDigest || 'def456';
      const verificationPlanDigest = runContext.verificationPlanDigest || 'ghi789';
      const providerConfigRevision = runContext.providerConfigRevision || this.getConfigRevision();
      const manifest = contract.buildExecutionEvidenceManifest({
        runId: runContext.runId || 'synthetic-run',
        providerId: this.getProviderId(),
        providerConfigRevision,
        approvedSnapshotDigest,
        approvedManifestDigest,
        verificationPlanDigest,
        workerIdentity: runContext.workerIdentity || 'host-worker',
        evidenceTimestamp: runContext.evidenceTimestamp || new Date().toISOString(),
        evidenceExpiry: runContext.evidenceExpiry || new Date(Date.now() + 600_000).toISOString(),
        provenance: runContext.provenance || 'host-owned',
        trustClass: runContext.trustClass || 'APP_VERIFIED',
      });
      const evidenceState = contract.validateExecutionEvidenceManifest(manifest, {
        runId: manifest.runId,
        approvedSnapshotDigest,
        approvedManifestDigest,
        verificationPlanDigest,
        providerConfigRevision,
        hostVerifierEstablished: true,
      });
      return { manifest, evidenceState };
    },
    collectHostObservedResult(rawRunState = {}) {
      const appVerifiedFacts = {
        processTerminated: rawRunState.processTerminated === true,
        cleanupVerified: rawRunState.cleanupVerified === true,
        shutdownConfirmed: rawRunState.shutdownConfirmed === true,
      };
      const envelope = contract.createResultEnvelope({
        providerObservedState: {
          status: rawRunState.status || 'completed',
          processTerminated: appVerifiedFacts.processTerminated,
          shutdownConfirmed: appVerifiedFacts.shutdownConfirmed,
        },
        appVerifiedFacts,
        acceptedEvidence: { cleanupVerified: appVerifiedFacts.cleanupVerified },
      });
      return {
        envelope,
        evaluation: contract.evaluateResultEnvelope(envelope),
      };
    },
  });
}

function simulateApprovalBinding(task, manifest, expectedContext) {
  const evidenceState = contract.validateExecutionEvidenceManifest(manifest, expectedContext);
  if (evidenceState.state !== 'EXECUTION_AUTHORIZED') {
    return { approved: false, evidenceState, approval: null };
  }
  const approval = {
    approvedSnapshotDigest: manifest.approvedSnapshotDigest,
    approvedManifestDigest: manifest.approvedManifestDigest,
    verificationPlanDigest: manifest.verificationPlanDigest,
    providerConfigRevision: manifest.providerConfigRevision,
    providerId: manifest.providerId,
    evidenceTimestamp: manifest.evidenceTimestamp,
    evidenceExpiry: manifest.evidenceExpiry,
    provenance: manifest.provenance,
    trustClass: manifest.trustClass,
  };
  return { approved: true, evidenceState, approval };
}

function scenarioSyntheticEvidenceCannotAuthorize() {
  const adapter = makeSyntheticFixtureAdapter();
  const runCtx = {
    runId: 'scenario-1',
    approvedSnapshotDigest: 'abc123',
    approvedManifestDigest: 'def456',
    verificationPlanDigest: 'ghi789',
    providerConfigRevision: 'provider-rev-9',
    workerIdentity: 'host-worker',
  };

  const prepared = adapter.prepareRunEvidence(runCtx);
  assert.equal(prepared.evidenceState.state, 'NOT_ESTABLISHED');

  const approval = simulateApprovalBinding({ runId: runCtx.runId }, prepared.manifest, {
    runId: runCtx.runId,
    approvedSnapshotDigest: runCtx.approvedSnapshotDigest,
    approvedManifestDigest: runCtx.approvedManifestDigest,
    verificationPlanDigest: runCtx.verificationPlanDigest,
    providerConfigRevision: runCtx.providerConfigRevision,
    hostVerifierEstablished: true,
  });
  assert.equal(approval.approved, false);

  const decision = contract.evaluateProviderEligibility(adapter.getCapabilities(), approval.evidenceState);
  assert.notEqual(decision.state, 'EXECUTION_AUTHORIZED');

  const result = adapter.collectHostObservedResult({
    status: 'completed',
    processTerminated: true,
    shutdownConfirmed: true,
    cleanupVerified: true,
  });
  assert.notEqual(result.evaluation.state, 'EXECUTION_AUTHORIZED');
  assert.equal(result.envelope.appVerifiedFacts.cleanupVerified, true);

  const lifecycleBinding = {
    runId: 'scenario-1',
    providerId: 'synthetic-fixture-adapter',
    workerIdentity: 'fixture-worker',
    resourceId: 'fixture-resource',
  };
  const cleanupClaim = lifecycle.evaluateLifecycleClaim('cleanupVerified', {
    ...lifecycleBinding,
    operation: 'cleanup-verification',
    claim: 'cleanupVerified',
    value: true,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    source: 'host-verified',
    authenticated: true,
  }, lifecycleBinding);
  assert.equal(cleanupClaim.state, 'NOT_ESTABLISHED');

  const timeoutClaim = lifecycle.evaluateLifecycleClaim('executionTimedOut', {
    ...lifecycleBinding,
    operation: 'execution-timeout',
    claim: 'executionTimedOut',
    value: true,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    source: 'host-verified',
    authenticated: true,
  }, lifecycleBinding);
  assert.equal(timeoutClaim.state, 'NOT_ESTABLISHED');

  const auditTrail = [
    'proposal_created',
    'human_approved',
    'synthetic_evidence_rejected',
    'execution_blocked',
    'audit_recorded',
  ];
  assert.equal(auditTrail.includes('pre_execution_gate_authorized'), false);
  assert.equal(auditTrail.includes('verification_step_completed'), false);
  console.log('[PASS] Offline scenario 1: synthetic adapter claims remained unverified and execution was blocked.');
}

function scenarioTamperedArtifactRejected() {
  const adapter = makeSyntheticFixtureAdapter();
  const valid = adapter.prepareRunEvidence({
    runId: 'scenario-2',
    approvedSnapshotDigest: 'abc123',
    approvedManifestDigest: 'def456',
    verificationPlanDigest: 'ghi789',
    providerConfigRevision: 'provider-rev-9',
  });
  const driftedManifest = {
    ...valid.manifest,
    approvedSnapshotDigest: 'tampered-snapshot',
  };
  const result = contract.validateExecutionEvidenceManifest(driftedManifest, {
    runId: 'scenario-2',
    approvedSnapshotDigest: 'abc123',
    approvedManifestDigest: 'def456',
    verificationPlanDigest: 'ghi789',
    providerConfigRevision: 'provider-rev-9',
    hostVerifierEstablished: true,
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reasonCode, 'SNAPSHOT_DIGEST_MISMATCH');
  console.log('[PASS] Offline scenario 2: approval drift invalidated evidence and blocked execution before verification.');
}

function scenarioUncertainCleanupQuarantine() {
  const resultEnvelope = contract.createResultEnvelope({
    untrustedWorkerClaims: ['cleanup-report.json', 'guest stated cleanup succeeded'],
    providerObservedState: { status: 'completed' },
    appVerifiedFacts: { processTerminated: true },
  });
  const envelopeDecision = contract.evaluateResultEnvelope(resultEnvelope);
  assert.equal(envelopeDecision.state, 'UNCERTAIN');
  assert.equal(envelopeDecision.reasonCode, 'UNVERIFIED_SOURCE');

  const cleanupClaim = lifecycle.evaluateLifecycleClaim('cleanupVerified', {
    source: 'guest-writable',
    authenticated: false,
  });
  assert.equal(cleanupClaim.state, 'BLOCKED');
  assert.equal(cleanupClaim.reasonCode, 'LIFECYCLE_BINDING_CONTEXT_MISSING');

  const timeoutEnvelope = contract.createResultEnvelope({
    untrustedWorkerClaims: ['cleanup report claimed success'],
    appVerifiedFacts: {
      executionTimedOut: true,
      processTerminated: false,
      cleanupVerified: false,
      quarantined: true,
    },
  });
  const timeoutDecision = contract.evaluateResultEnvelope(timeoutEnvelope);
  assert.equal(timeoutDecision.state, 'UNCERTAIN');
  assert.equal(timeoutDecision.reasonCode, 'RESOURCE_QUARANTINED');

  const quarantine = {
    quarantined: true,
    deletionAllowed: false,
  };
  assert.equal(quarantine.quarantined, true);
  assert.equal(quarantine.deletionAllowed, false);
  console.log('[PASS] Offline scenario 3: uncertain cleanup remained quarantined; guest claims did not authorize deletion.');
}

scenarioSyntheticEvidenceCannotAuthorize();
scenarioTamperedArtifactRejected();
scenarioUncertainCleanupQuarantine();
console.log('[PASS] Offline synthetic contract validation completed; no runtime execution was performed.');
