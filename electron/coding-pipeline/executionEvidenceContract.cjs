const REQUIRED_EVIDENCE_FIELDS = Object.freeze([
  'runId',
  'providerId',
  'providerConfigRevision',
  'approvedSnapshotDigest',
  'approvedManifestDigest',
  'verificationPlanDigest',
  'workerIdentity',
  'evidenceTimestamp',
  'evidenceExpiry',
  'provenance',
  'trustClass',
]);

const MANDATORY_CAPABILITIES = Object.freeze([
  'identityIsolation',
  'credentialIsolation',
  'egressControl',
  'resourceLimits',
  'runtimeCap',
  'outputCap',
  'cancellation',
  'cleanupEvidence',
]);

const TRUST_CLASSES = Object.freeze([
  'APP_VERIFIED',
  'INDEPENDENTLY_OBSERVED',
  'PROVIDER_ATTESTED',
  'UNTRUSTED',
]);

const EVIDENCE_STATES = Object.freeze([
  'BLOCKED',
  'UNCERTAIN',
  'NOT_ESTABLISHED',
  'EXECUTION_AUTHORIZED',
]);

const SIMULATED_OR_UNTRUSTED_SOURCES = new Set([
  'mock',
  'fixture',
  'synthetic',
  'simulated',
  'offline',
  'test-fixture',
  'guest',
  'guest-writable',
  'worker',
  'untrusted-caller-input',
]);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

function normalizeSourceName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isSimulatedOrUntrustedSource(value) {
  const normalized = normalizeSourceName(value);
  return normalized === '' || SIMULATED_OR_UNTRUSTED_SOURCES.has(normalized);
}

function normalizeTimeoutMs(value, options = {}) {
  const defaultMs = Number.isFinite(options.defaultMs) ? Number(options.defaultMs) : DEFAULT_TIMEOUT_MS;
  const maxMs = Number.isFinite(options.maxMs) ? Number(options.maxMs) : MAX_TIMEOUT_MS;
  if (value === undefined || value === null || value === '') {
    return defaultMs;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Execution timeout must be a positive finite number of milliseconds.');
  }
  if (numeric > maxMs) {
    throw new Error(`Execution timeout exceeds the maximum allowed value of ${maxMs}ms.`);
  }
  return Math.trunc(numeric);
}

function normalizeHash(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function makeDecision(state, reasonCode, reason, extra = {}) {
  return Object.freeze({
    state,
    reasonCode,
    reason,
    invalidationReason: reason,
    ...extra,
  });
}

function parseTimestamp(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty ISO timestamp string.`);
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new Error(`${fieldName} must be a valid ISO timestamp string.`);
  }
  return time;
}

function buildExecutionEvidenceManifest(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const now = nowIso();
  const safeExpiry = typeof source.evidenceExpiry === 'string' && source.evidenceExpiry.trim()
    ? source.evidenceExpiry
    : new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const manifest = {
    runId: source.runId || 'unknown-run',
    providerId: source.providerId || 'host-controlled',
    providerConfigRevision: source.providerConfigRevision || 'unmanaged',
    approvedSnapshotDigest: source.approvedSnapshotDigest || 'unapproved-snapshot',
    approvedManifestDigest: source.approvedManifestDigest || 'unapproved-manifest',
    verificationPlanDigest: source.verificationPlanDigest || 'unapproved-verification-plan',
    workerIdentity: source.workerIdentity || 'unknown-worker',
    evidenceTimestamp: source.evidenceTimestamp || now,
    evidenceExpiry: safeExpiry,
    provenance: source.provenance || 'untrusted-caller-input',
    trustClass: source.trustClass || 'UNTRUSTED',
    providerAttestation: source.providerAttestation || null,
    executionTimeoutMs: normalizeTimeoutMs(source.executionTimeoutMs ?? source.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  return manifest;
}

function validateExecutionEvidenceManifest(manifest, expectedContext = {}) {
  if (!manifest || typeof manifest !== 'object') {
    return makeDecision('BLOCKED', 'MANIFEST_MISSING', 'Execution evidence manifest is missing or malformed.');
  }

  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      return makeDecision('BLOCKED', 'MANDATORY_FIELD_MISSING', `Execution evidence is missing required field: ${field}.`, { fieldName: field });
    }
  }

  if (manifest.providerAttestation && !expectedContext.hostVerifierEstablished) {
    return makeDecision('UNCERTAIN', 'NOT_ESTABLISHED', 'providerAttestation is not self-authenticating without a host verifier.', {
      fieldName: 'providerAttestation',
    });
  }

  try {
    const evidenceTimestampMs = parseTimestamp(manifest.evidenceTimestamp, 'evidenceTimestamp');
    const evidenceExpiryMs = parseTimestamp(manifest.evidenceExpiry, 'evidenceExpiry');
    if (evidenceTimestampMs > Date.now()) {
      return makeDecision('BLOCKED', 'EVIDENCE_FUTURE_DATED', 'Execution evidence timestamp is in the future.', { fieldName: 'evidenceTimestamp' });
    }
    if (evidenceExpiryMs <= evidenceTimestampMs) {
      return makeDecision('BLOCKED', 'EVIDENCE_EXPIRY_INVALID', 'Execution evidence expires before or at its observation timestamp.', { fieldName: 'evidenceExpiry' });
    }
    if (evidenceExpiryMs <= Date.now()) {
      return makeDecision('BLOCKED', 'EVIDENCE_EXPIRED', 'Execution evidence has expired.', { fieldName: 'evidenceExpiry' });
    }
    if (Number.isFinite(expectedContext.maxEvidenceAgeMs)
      && expectedContext.maxEvidenceAgeMs > 0
      && Date.now() - evidenceTimestampMs > expectedContext.maxEvidenceAgeMs) {
      return makeDecision('BLOCKED', 'EVIDENCE_STALE', 'Execution evidence exceeds the maximum permitted age.', { fieldName: 'evidenceTimestamp' });
    }
    const timeoutMs = normalizeTimeoutMs(manifest.executionTimeoutMs ?? expectedContext.executionTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (expectedContext.maxExecutionTimeoutMs && timeoutMs > expectedContext.maxExecutionTimeoutMs) {
      return makeDecision('BLOCKED', 'TIMEOUT_EXCEEDS_LIMIT', `Execution timeout exceeds the configured maximum of ${expectedContext.maxExecutionTimeoutMs}ms.`, {
        fieldName: 'executionTimeoutMs',
      });
    }
  } catch (error) {
    return makeDecision('BLOCKED', 'INVALID_TIMEOUT', error.message);
  }

  const normalized = {
    runId: manifest.runId,
    providerId: manifest.providerId,
    providerConfigRevision: manifest.providerConfigRevision,
    approvedSnapshotDigest: normalizeHash(manifest.approvedSnapshotDigest),
    approvedManifestDigest: normalizeHash(manifest.approvedManifestDigest),
    verificationPlanDigest: normalizeHash(manifest.verificationPlanDigest),
    workerIdentity: manifest.workerIdentity,
    provenance: manifest.provenance,
    trustClass: manifest.trustClass,
  };

  if (normalized.provenance === 'worker' || normalized.provenance === 'guest') {
    return makeDecision('UNCERTAIN', 'UNTRUSTED_PROVENANCE', 'Worker or guest provenance is not trusted unless a host verified channel is established.', {
      provenance: manifest.provenance,
    });
  }

  if (!TRUST_CLASSES.includes(normalized.trustClass)) {
    return makeDecision('BLOCKED', 'INVALID_TRUST_CLASS', `Unsupported trust class: ${manifest.trustClass}.`);
  }

  if (normalized.trustClass === 'UNTRUSTED') {
    return makeDecision('UNCERTAIN', 'UNTRUSTED', 'The evidence is explicitly untrusted and cannot authorize execution or deletion.');
  }

  const expected = expectedContext || {};
  if (expected.runId && normalized.runId !== expected.runId) {
    return makeDecision('BLOCKED', 'RUN_ID_MISMATCH', 'Execution evidence runId does not match the expected run.');
  }
  if (expected.approvedSnapshotDigest && normalized.approvedSnapshotDigest !== normalizeHash(expected.approvedSnapshotDigest)) {
    return makeDecision('BLOCKED', 'SNAPSHOT_DIGEST_MISMATCH', 'Approved snapshot digest does not match the expected snapshot digest.');
  }
  if (expected.approvedManifestDigest && normalized.approvedManifestDigest !== normalizeHash(expected.approvedManifestDigest)) {
    return makeDecision('BLOCKED', 'MANIFEST_DIGEST_MISMATCH', 'Approved manifest digest does not match the expected manifest digest.');
  }
  if (expected.verificationPlanDigest && normalized.verificationPlanDigest !== normalizeHash(expected.verificationPlanDigest)) {
    return makeDecision('BLOCKED', 'VERIFICATION_PLAN_MISMATCH', 'Verification plan digest does not match the expected plan digest.');
  }
  if (expected.providerConfigRevision && normalized.providerConfigRevision !== expected.providerConfigRevision) {
    return makeDecision('BLOCKED', 'CONFIG_REVISION_MISMATCH', 'Provider configuration revision drift invalidates this evidence.');
  }
  if (expected.providerId && normalized.providerId !== expected.providerId) {
    return makeDecision('BLOCKED', 'PROVIDER_ID_MISMATCH', 'Execution evidence provider does not match the expected provider.');
  }
  if (expected.workerIdentity && normalized.workerIdentity !== expected.workerIdentity) {
    return makeDecision('BLOCKED', 'WORKER_IDENTITY_MISMATCH', 'Execution evidence worker does not match the expected worker.');
  }

  const timeoutValue = normalizeTimeoutMs(manifest.executionTimeoutMs ?? expected.executionTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (expected.maxExecutionTimeoutMs && timeoutValue > expected.maxExecutionTimeoutMs) {
    return makeDecision('BLOCKED', 'TIMEOUT_EXCEEDS_LIMIT', `Execution timeout exceeds the configured maximum of ${expected.maxExecutionTimeoutMs}ms.`, {
      fieldName: 'executionTimeoutMs',
    });
  }

  return makeDecision('NOT_ESTABLISHED', 'HOST_VERIFIER_NOT_ESTABLISHED', 'Manifest fields and expected bindings are structurally valid, but no trusted host evidence issuer is available.', {
    evidence: { ...normalized, executionTimeoutMs: timeoutValue },
  });
}

function createResultEnvelope(overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  return Object.freeze({
    untrustedWorkerClaims: Array.isArray(source.untrustedWorkerClaims) ? source.untrustedWorkerClaims.slice() : [],
    providerObservedState: source.providerObservedState && typeof source.providerObservedState === 'object' ? { ...source.providerObservedState } : {},
    appVerifiedFacts: source.appVerifiedFacts && typeof source.appVerifiedFacts === 'object' ? { ...source.appVerifiedFacts } : {},
    acceptedEvidence: source.acceptedEvidence && typeof source.acceptedEvidence === 'object' ? { ...source.acceptedEvidence } : {},
    receivedAt: source.receivedAt || nowIso(),
  });
}

function evaluateResultEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return makeDecision('BLOCKED', 'RESULT_ENVELOPE_MISSING', 'Result envelope is missing.');
  }
  const untrusted = Array.isArray(envelope.untrustedWorkerClaims) ? envelope.untrustedWorkerClaims : [];
  const providerObserved = envelope.providerObservedState && typeof envelope.providerObservedState === 'object'
    ? envelope.providerObservedState
    : {};
  const verified = envelope.appVerifiedFacts && typeof envelope.appVerifiedFacts === 'object'
    ? envelope.appVerifiedFacts
    : {};
  const accepted = envelope.acceptedEvidence && typeof envelope.acceptedEvidence === 'object'
    ? envelope.acceptedEvidence
    : {};
  const providerSource = normalizeSourceName(providerObserved.source);
  const hasVerifiedEvidence = Object.keys(verified).length > 0 || Object.keys(accepted).length > 0;

  if (providerObserved.source && isSimulatedOrUntrustedSource(providerSource)) {
    return makeDecision('UNCERTAIN', 'SIMULATED_EVIDENCE', 'Provider-observed state is simulated, untrusted, or caller-supplied and cannot authorize host actions or teardown.', {
      canAuthorizeHostAction: false,
      untrustedWorkerClaims: untrusted,
      providerObservedState: providerObserved,
      appVerifiedFacts: verified,
      acceptedEvidence: accepted,
    });
  }

  if (verified.quarantined === true || providerObserved.quarantined === true) {
    return makeDecision('UNCERTAIN', 'RESOURCE_QUARANTINED', 'Resource remains quarantined because host-verified cleanup or termination could not be established.', {
      canAuthorizeHostAction: false,
      untrustedWorkerClaims: untrusted,
      providerObservedState: providerObserved,
      appVerifiedFacts: verified,
      acceptedEvidence: accepted,
    });
  }

  if (verified.executionTimedOut === true && verified.processTerminated !== true) {
    return makeDecision('UNCERTAIN', 'TIMEOUT_TERMINATION_UNVERIFIED', 'The execution timed out but host termination was not independently confirmed.', {
      canAuthorizeHostAction: false,
      untrustedWorkerClaims: untrusted,
      providerObservedState: providerObserved,
      appVerifiedFacts: verified,
      acceptedEvidence: accepted,
    });
  }

  if (verified.executionCancelled === true && verified.processTerminated !== true) {
    return makeDecision('UNCERTAIN', 'CANCELLATION_NOT_CONFIRMED', 'The execution was cancelled but host termination was not independently confirmed.', {
      canAuthorizeHostAction: false,
      untrustedWorkerClaims: untrusted,
      providerObservedState: providerObserved,
      appVerifiedFacts: verified,
      acceptedEvidence: accepted,
    });
  }

  if (verified.cleanupVerified !== true && (verified.containerRemoved === true || verified.stagingDirectoryRemoved === true || verified.executionTimedOut === true || verified.executionCancelled === true || verified.executionCompleted === true)) {
    return makeDecision('UNCERTAIN', 'CLEANUP_NOT_VERIFIED', 'Host-verified cleanup was not established; guest or worker cleanup claims are not sufficient.', {
      canAuthorizeHostAction: false,
      untrustedWorkerClaims: untrusted,
      providerObservedState: providerObserved,
      appVerifiedFacts: verified,
      acceptedEvidence: accepted,
    });
  }

  if (!hasVerifiedEvidence) {
    if (untrusted.length > 0) {
      return makeDecision('UNCERTAIN', 'UNTRUSTED_WORKER_OUTPUT', 'Guest or worker-generated output is untrusted and cannot authorize host actions, deletion, or execution decisions.', {
        canAuthorizeHostAction: false,
        untrustedWorkerClaims: untrusted,
        providerObservedState: providerObserved,
        appVerifiedFacts: verified,
        acceptedEvidence: accepted,
      });
    }
    return makeDecision('BLOCKED', 'NO_APP_VERIFIED_FACTS', 'Result envelope contains no app-verified facts or accepted evidence.');
  }

  return makeDecision('UNCERTAIN', 'UNVERIFIED_SOURCE', 'The observed result lacks a host-authoritative provenance source and cannot authorize execution or deletion.', {
    canAuthorizeHostAction: false,
    untrustedWorkerClaims: untrusted,
    providerObservedState: providerObserved,
    appVerifiedFacts: verified,
    acceptedEvidence: accepted,
  });
}

function evaluateProviderEligibility(capabilities, evidenceState) {
  if (!capabilities || typeof capabilities !== 'object') {
    return makeDecision('BLOCKED', 'CAPABILITIES_MISSING', 'Provider capabilities are missing.');
  }

  const stateInput = arguments.length < 2 ? { state: 'BLOCKED' } : evidenceState;
  if (!stateInput || typeof stateInput !== 'object' || Array.isArray(stateInput)
    || !Object.prototype.hasOwnProperty.call(stateInput, 'state')
    || !EVIDENCE_STATES.includes(stateInput.state)) {
    return makeDecision('BLOCKED', 'EVIDENCE_STATE_INVALID', 'Evidence state is missing, malformed, or unsupported.', {
      capabilities,
    });
  }

  const state = stateInput.state;
  if (state === 'BLOCKED' || state === 'UNCERTAIN' || state === 'NOT_ESTABLISHED') {
    return makeDecision(state === 'NOT_ESTABLISHED' ? 'UNCERTAIN' : state, stateInput.reasonCode || 'EVIDENCE_INVALID', stateInput.reason || 'Mandatory evidence is absent or invalid.', {
      capabilities,
    });
  }

  const missingRequired = MANDATORY_CAPABILITIES.filter((name) => capabilities[name] !== true);
  if (missingRequired.length > 0) {
    return makeDecision('BLOCKED', 'REQUIRED_CAPABILITY_MISSING', `Missing required capability: ${missingRequired[0]}.`, {
      missingRequiredCapabilities: missingRequired,
      capabilities,
    });
  }

  if (capabilities.independentlyVerified !== true) {
    return makeDecision('UNCERTAIN', 'VERIFICATION_NOT_ESTABLISHED', 'The provider capability has not been independently verified.', {
      capabilities,
    });
  }

  if (capabilities.humanApproved !== true) {
    return makeDecision('ELIGIBLE_FOR_HUMAN_REVIEW', 'WAITING_FOR_HUMAN_APPROVAL', 'The provider is technically available but requires explicit human approval before execution.', {
      capabilities,
    });
  }

  if (capabilities.syntheticValidationPassed !== true) {
    return makeDecision('ELIGIBLE_FOR_HUMAN_REVIEW', 'SYNTHETIC_VALIDATION_PENDING', 'Synthetic non-sensitive validation has not yet passed.', {
      capabilities,
    });
  }

  if (capabilities.executionAuthorized !== true) {
    return makeDecision('BLOCKED', 'EXECUTION_NOT_AUTHORIZED', 'Execution has not been explicitly authorized.', {
      capabilities,
    });
  }

  return makeDecision('NOT_ESTABLISHED', 'HOST_EVIDENCE_ISSUER_MISSING', 'Capability flags and caller-supplied evidence state cannot establish host authorization without a trusted issuer.', {
    capabilities,
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  EVIDENCE_STATES,
  MAX_TIMEOUT_MS,
  MANDATORY_CAPABILITIES,
  REQUIRED_EVIDENCE_FIELDS,
  TRUST_CLASSES,
  buildExecutionEvidenceManifest,
  createResultEnvelope,
  evaluateProviderEligibility,
  evaluateResultEnvelope,
  normalizeTimeoutMs,
  validateExecutionEvidenceManifest,
};
