const crypto = require('node:crypto');
const path = require('node:path');

const CURRENT_ATTESTATION_SCHEMA_VERSION = '1.0.0';
const SUPPORTED_SIGNATURE_ALGORITHMS = Object.freeze([
  'ed25519',
  'es256',
  'rsa-pss-sha256',
]);

const ATTESTATION_ENVELOPE_FIELDS = Object.freeze([
  'schemaVersion',
  'issuerId',
  'keyId',
  'algorithm',
  'signature',
  'payload',
]);

const ATTESTATION_PAYLOAD_FIELDS = Object.freeze([
  'schemaVersion',
  'issuerId',
  'keyId',
  'algorithm',
  'runId',
  'executionId',
  'nonce',
  'issuedAt',
  'expiresAt',
  'projectIdentityDigest',
  'sessionId',
  'providerId',
  'runtimeId',
  'grantId',
  'policyDigest',
  'verificationPlanDigest',
  'configDigest',
  'capabilities',
]);

const ISSUER_SERVICE_STATES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  NOT_TRUSTED: 'NOT_TRUSTED',
  READY: 'READY',
  ISSUANCE_FAILED: 'ISSUANCE_FAILED',
  REVOKED: 'REVOKED',
});

const ISSUER_TRUST_DOMAINS = Object.freeze({
  ELECTRON_RENDERER: 'ELECTRON_RENDERER',
  ELECTRON_MAIN: 'ELECTRON_MAIN',
  LOCAL_BACKEND: 'LOCAL_BACKEND',
  PROVIDER_ADAPTER: 'PROVIDER_ADAPTER',
  ISOLATED_HOST_SERVICE: 'ISOLATED_HOST_SERVICE',
  OS_KERNEL: 'OS_KERNEL',
});

const EVIDENCE_FACT_ORIGINS = Object.freeze({
  CALLER_CONFIGURATION: 'CALLER_CONFIGURATION',
  PROVIDER_REPORTED: 'PROVIDER_REPORTED',
  DAEMON_REPORTED: 'DAEMON_REPORTED',
  HOST_OBSERVED: 'HOST_OBSERVED',
  KERNEL_ENFORCED: 'KERNEL_ENFORCED',
  INDEPENDENT_OS_AUTHENTICATED: 'INDEPENDENT_OS_AUTHENTICATED',
});

const DOCKER_DAEMON_TRUST_STATES = Object.freeze({
  NOT_ESTABLISHED: 'NOT_ESTABLISHED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  ENDPOINT_UNTRUSTED: 'ENDPOINT_UNTRUSTED',
  TLS_UNVERIFIED: 'TLS_UNVERIFIED',
  CERTIFICATE_UNTRUSTED: 'CERTIFICATE_UNTRUSTED',
  VERIFIED: 'VERIFIED',
});

const DOCKER_OBSERVATION_STATES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  DAEMON_UNTRUSTED: 'DAEMON_UNTRUSTED',
  DAEMON_REPORTED: 'DAEMON_REPORTED',
  HOST_OBSERVED: 'HOST_OBSERVED',
  KERNEL_ENFORCED: 'KERNEL_ENFORCED',
  INDEPENDENTLY_VERIFIED: 'INDEPENDENTLY_VERIFIED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  UNKNOWN: 'UNKNOWN',
});

const DOCKER_OBSERVATION_BINDING_FIELDS = Object.freeze([
  'daemonId',
  'endpoint',
  'containerId',
  'containerCreationIdentity',
  'executionId',
  'projectId',
  'sessionId',
  'grantId',
  'policyDigest',
  'planDigest',
  'observationTimestamp',
  'nonce',
]);

const KERNEL_OBSERVATION_STATES = Object.freeze({
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  DAEMON_REPORTED: 'DAEMON_REPORTED',
  HOST_OBSERVED: 'HOST_OBSERVED',
  KERNEL_ENFORCEMENT_NOT_VERIFIED: 'KERNEL_ENFORCEMENT_NOT_VERIFIED',
  KERNEL_ENFORCED: 'KERNEL_ENFORCED',
  OBSERVATION_CONFLICT: 'OBSERVATION_CONFLICT',
  STALE_OBSERVATION: 'STALE_OBSERVATION',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
});

const KERNEL_OBSERVATION_BINDING_FIELDS = Object.freeze([
  'evidenceSource',
  'verificationMethod',
  'containerId',
  'cgroupPath',
  'mountNamespaceId',
  'projectId',
  'executionId',
  'policyDigest',
  'verificationPlanDigest',
  'observationTimestamp',
  'nonce',
  'verificationState',
]);

const OBSERVER_IDENTITY_SOURCES = Object.freeze({
  CALLER_PROVIDED: 'CALLER_PROVIDED',
  ELECTRON_RENDERER: 'ELECTRON_RENDERER',
  ELECTRON_MAIN: 'ELECTRON_MAIN',
  CHILD_PROCESS: 'CHILD_PROCESS',
  OS_AUTHENTICATED_PROCESS: 'OS_AUTHENTICATED_PROCESS',
  INDEPENDENT_AUTHENTICATED_OBSERVER: 'INDEPENDENT_AUTHENTICATED_OBSERVER',
});

const OBSERVER_AUTHENTICATION_STATES = Object.freeze({
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  CALLER_FORGED: 'CALLER_FORGED',
  UNTRUSTED_PROCESS_DOMAIN: 'UNTRUSTED_PROCESS_DOMAIN',
  PEER_UNAUTHENTICATED: 'PEER_UNAUTHENTICATED',
  LIFECYCLE_TERMINATED: 'LIFECYCLE_TERMINATED',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  STALE_HEARTBEAT: 'STALE_HEARTBEAT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  AUTHENTICATED: 'AUTHENTICATED',
});

const OBSERVER_CONTEXT_BINDING_FIELDS = Object.freeze([
  'projectId',
  'projectRoot',
  'sessionId',
  'executionId',
  'containerId',
  'cgroupPath',
  'mountNamespaceId',
  'grantId',
  'policyDigest',
  'verificationPlanDigest',
  'observedAt',
  'observerNonce',
]);

const WINDOWS_IPC_SECURITY_STATES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  PIPE_PATH_KNOWN: 'PIPE_PATH_KNOWN',
  PIPE_ACL_CONFIGURED: 'PIPE_ACL_CONFIGURED',
  CONNECTING_CLIENT_AUTHENTICATED: 'CONNECTING_CLIENT_AUTHENTICATED',
  CLIENT_OS_IDENTITY_VERIFIED: 'CLIENT_OS_IDENTITY_VERIFIED',
  OBSERVER_IDENTITY_TRUSTED: 'OBSERVER_IDENTITY_TRUSTED',
  UNAUTHORIZED_CLIENT: 'UNAUTHORIZED_CLIENT',
  PID_REUSE_DETECTED: 'PID_REUSE_DETECTED',
  SECURITY_PRINCIPAL_MISMATCH: 'SECURITY_PRINCIPAL_MISMATCH',
  CROSS_SESSION_REJECTED: 'CROSS_SESSION_REJECTED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  NOT_VERIFIED: 'NOT_VERIFIED',
  AUTHENTICATED: 'AUTHENTICATED',
  REJECTED: 'REJECTED',
});

const WINDOWS_TRUSTED_SECURITY_PRINCIPALS = Object.freeze([
  'S-1-5-18', // Local System
  'S-1-5-19', // Local Service
  'S-1-5-20', // Network Service
  'S-1-5-32-544', // Built-in Administrators
]);

const ISSUER_REQUEST_FIELDS = Object.freeze([
  'requestId',
  'requestTimestamp',
  'nonce',
  'sessionId',
  'runId',
  'grantId',
  'projectIdentityDigest',
  'policyDigest',
  'verificationPlanDigest',
  'providerId',
  'runtimeId',
  'requestedCapabilities',
  'claimsToVerify',
  'callerAuthorization',
]);

const ISSUER_RESPONSE_FIELDS = Object.freeze([
  'responseId',
  'requestId',
  'status',
  'issuerIdentity',
  'attestationEnvelope',
  'observedFacts',
  'rejectionReason',
  'errorCode',
  'issuedAt',
  'expiresAt',
]);

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
const MAX_EXECUTION_GRANT_TTL_MS = 5 * 60 * 1000;
const EXECUTION_GRANT_FIELDS = Object.freeze([
  'grantId',
  'requestDigest',
  'taskId',
  'proposalId',
  'projectIdentityDigest',
  'canonicalRootDigest',
  'approvedSnapshotDigest',
  'approvedManifestDigest',
  'verificationPlanDigest',
  'operationDigest',
  'policyRevision',
  'configRevision',
  'runId',
  'nonce',
  'issuedAt',
  'expiresAt',
  'issuerId',
  'singleUse',
  'consumedAt',
]);
const EXECUTION_GRANT_BINDINGS = Object.freeze([
  'requestDigest',
  'taskId',
  'proposalId',
  'projectIdentityDigest',
  'canonicalRootDigest',
  'approvedSnapshotDigest',
  'approvedManifestDigest',
  'verificationPlanDigest',
  'operationDigest',
  'policyRevision',
  'configRevision',
  'runId',
  'issuerId',
]);

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

function validateExecutionGrantStructure(grant, expectedContext = {}) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    return makeDecision('BLOCKED', 'GRANT_MISSING', 'Execution grant is missing or malformed.');
  }
  const unknownFields = Object.keys(grant).filter((field) => !EXECUTION_GRANT_FIELDS.includes(field));
  if (unknownFields.length) {
    return makeDecision('BLOCKED', 'GRANT_FIELDS_UNSUPPORTED', `Execution grant contains unsupported fields: ${unknownFields.join(', ')}.`);
  }
  for (const field of EXECUTION_GRANT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(grant, field)) {
      return makeDecision('BLOCKED', 'GRANT_FIELD_MISSING', `Execution grant is missing required field: ${field}.`, { fieldName: field });
    }
  }
  for (const field of EXECUTION_GRANT_FIELDS.filter((name) => !['singleUse', 'consumedAt'].includes(name))) {
    if (typeof grant[field] !== 'string' || !grant[field].trim()) {
      return makeDecision('BLOCKED', 'GRANT_FIELD_INVALID', `Execution grant field '${field}' must be a non-empty string.`, { fieldName: field });
    }
  }
  const digestFields = [
    'requestDigest',
    'projectIdentityDigest',
    'canonicalRootDigest',
    'approvedSnapshotDigest',
    'approvedManifestDigest',
    'verificationPlanDigest',
    'operationDigest',
  ];
  for (const field of digestFields) {
    if (!/^[a-f0-9]{64}$/i.test(grant[field])) {
      return makeDecision('BLOCKED', 'GRANT_DIGEST_INVALID', `Execution grant field '${field}' must be a SHA-256 digest.`, { fieldName: field });
    }
  }
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  for (const field of ['grantId', 'runId', 'nonce']) {
    if (!uuidPattern.test(grant[field])) {
      return makeDecision('BLOCKED', 'GRANT_IDENTIFIER_INVALID', `Execution grant field '${field}' must be a UUID v4.`, { fieldName: field });
    }
  }
  if (grant.grantId === grant.runId || grant.grantId === grant.nonce || grant.runId === grant.nonce
    || grant.runId === grant.taskId) {
    return makeDecision('BLOCKED', 'GRANT_IDENTIFIER_NOT_UNIQUE', 'Grant, nonce, run, and task identifiers must be distinct; runId must not reuse taskId.');
  }
  if (grant.singleUse !== true) {
    return makeDecision('BLOCKED', 'GRANT_NOT_SINGLE_USE', 'Execution grant must be explicitly single-use.');
  }
  if (grant.consumedAt !== null) {
    return makeDecision('BLOCKED', 'GRANT_ALREADY_CONSUMED', 'Execution grant has already been consumed.');
  }

  let issuedAt;
  let expiresAt;
  try {
    issuedAt = parseTimestamp(grant.issuedAt, 'issuedAt');
    expiresAt = parseTimestamp(grant.expiresAt, 'expiresAt');
  } catch (error) {
    return makeDecision('BLOCKED', 'GRANT_TIMESTAMP_INVALID', error.message);
  }
  const currentTime = Date.now();
  if (issuedAt > currentTime || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_EXECUTION_GRANT_TTL_MS) {
    return makeDecision('BLOCKED', 'GRANT_TIMESTAMP_INVALID', 'Execution grant timestamps are future-dated, contradictory, or exceed the maximum lifetime.');
  }
  if (expiresAt <= currentTime) {
    return makeDecision('BLOCKED', 'GRANT_EXPIRED', 'Execution grant has expired.');
  }

  if (expectedContext.approvalConsumed !== true || expectedContext.snapshotValidated !== true) {
    return makeDecision('BLOCKED', 'GRANT_PRECONDITIONS_NOT_MET', 'Proposal approval must be consumed and the approved project snapshot revalidated before a grant can be considered.');
  }
  for (const field of EXECUTION_GRANT_BINDINGS) {
    if (typeof expectedContext[field] !== 'string' || !expectedContext[field].trim()) {
      return makeDecision('BLOCKED', 'GRANT_BINDING_CONTEXT_MISSING', `Trusted grant binding context is missing '${field}'.`, { fieldName: field });
    }
    if (grant[field] !== expectedContext[field]) {
      return makeDecision('BLOCKED', 'GRANT_BINDING_MISMATCH', `Execution grant does not match the expected '${field}'.`, { fieldName: field });
    }
  }

  return makeDecision(
    'NOT_ESTABLISHED',
    'SUPERVISOR_ISSUER_NOT_ESTABLISHED',
    'Execution grant structure and bindings are valid, but no trusted supervisor issuer, durable single-use ledger, or host isolation evidence verifier is connected. This result cannot authorize execution.',
    { grantId: grant.grantId, runId: grant.runId },
  );
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

function canonicalizeJson(value) {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${value}`);
    }
    if (Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'bigint') {
    throw new Error('BigInt is not supported in canonical JSON');
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined || typeof item === 'symbol' || typeof item === 'function') {
        return 'null';
      }
      return canonicalizeJson(item);
    });
    return `[${items.join(',')}]`;
  }
  if (type === 'object') {
    if (typeof value.toJSON === 'function') {
      return canonicalizeJson(value.toJSON());
    }
    const keys = Object.keys(value).filter((k) => {
      const v = value[k];
      return v !== undefined && typeof v !== 'symbol' && typeof v !== 'function';
    });
    // RFC 8785: Keys are sorted lexicographically by UTF-16 code units
    keys.sort();
    const pairs = keys.map((key) => {
      const keyStr = JSON.stringify(key);
      const valStr = canonicalizeJson(value[key]);
      return `${keyStr}:${valStr}`;
    });
    return `{${pairs.join(',')}}`;
  }
  return undefined;
}

function parseSignatureBuffer(sig) {
  if (Buffer.isBuffer(sig)) return sig;
  if (typeof sig !== 'string') return null;
  const trimmed = sig.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex');
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    try {
      const buf = Buffer.from(trimmed, 'base64');
      if (buf.length > 0) return buf;
    } catch {}
  }
  return null;
}

function lookupPublicKey(trustStore, issuerId, keyId) {
  if (!trustStore) return null;
  if (typeof trustStore.getPublicKey === 'function') {
    return trustStore.getPublicKey(issuerId, keyId);
  }
  if (typeof trustStore === 'function') {
    return trustStore(issuerId, keyId);
  }
  if (typeof trustStore === 'object') {
    if (trustStore[issuerId] && trustStore[issuerId][keyId]) {
      return trustStore[issuerId][keyId];
    }
    if (trustStore[keyId]) {
      return trustStore[keyId];
    }
  }
  return null;
}

function isKeyRevoked(trustStore, issuerId, keyId) {
  if (!trustStore) return false;
  if (typeof trustStore.isRevoked === 'function') {
    return Boolean(trustStore.isRevoked(issuerId, keyId));
  }
  if (Array.isArray(trustStore.revokedKeys)) {
    return trustStore.revokedKeys.includes(keyId) || trustStore.revokedKeys.includes(`${issuerId}:${keyId}`);
  }
  return false;
}

function createAttestationPayload(overrides = {}) {
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const randomHex = () => crypto.randomBytes(32).toString('hex');

  return {
    schemaVersion: CURRENT_ATTESTATION_SCHEMA_VERSION,
    issuerId: overrides.issuerId || 'attestation-authority-1',
    keyId: overrides.keyId || 'key-ed25519-1',
    algorithm: overrides.algorithm || 'ed25519',
    runId: overrides.runId || crypto.randomUUID(),
    executionId: overrides.executionId || crypto.randomUUID(),
    nonce: overrides.nonce || crypto.randomUUID(),
    issuedAt: overrides.issuedAt || issuedAt,
    expiresAt: overrides.expiresAt || expiresAt,
    projectIdentityDigest: overrides.projectIdentityDigest || randomHex(),
    sessionId: overrides.sessionId || crypto.randomUUID(),
    providerId: overrides.providerId || 'docker-container-provider',
    runtimeId: overrides.runtimeId || 'docker-runc',
    grantId: overrides.grantId || crypto.randomUUID(),
    policyDigest: overrides.policyDigest || randomHex(),
    verificationPlanDigest: overrides.verificationPlanDigest || randomHex(),
    configDigest: overrides.configDigest || randomHex(),
    capabilities: overrides.capabilities || {
      processIsolation: true,
      networkDeny: true,
      readOnlyRootfs: true,
      ephemeralCow: true,
      credentialIsolation: true,
      resourceLimits: true,
      cleanupAttested: true,
      runtimeSupervisorVerified: true,
    },
    ...overrides,
  };
}

function signAttestationPayload({ payload, privateKey, algorithm, keyId, issuerId }) {
  const normAlgo = (algorithm || payload?.algorithm || 'ed25519').toLowerCase();
  const effectiveKeyId = keyId || payload?.keyId || 'key-1';
  const effectiveIssuerId = issuerId || payload?.issuerId || 'issuer-1';
  const canonical = canonicalizeJson(payload);
  const dataBuf = Buffer.from(canonical, 'utf8');
  let sigBuf;

  if (normAlgo === 'ed25519') {
    sigBuf = crypto.sign(null, dataBuf, privateKey);
  } else if (normAlgo === 'es256') {
    sigBuf = crypto.sign('sha256', dataBuf, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  } else if (normAlgo === 'rsa-pss-sha256') {
    sigBuf = crypto.sign('sha256', dataBuf, {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  return {
    schemaVersion: payload?.schemaVersion || CURRENT_ATTESTATION_SCHEMA_VERSION,
    issuerId: effectiveIssuerId,
    keyId: effectiveKeyId,
    algorithm: normAlgo,
    signature: sigBuf.toString('hex'),
    payload,
  };
}

function verifyAttestationSignature({ attestation, trustStore, expectedContext = {} } = {}) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return makeDecision('BLOCKED', 'ATTESTATION_MISSING', 'Attestation envelope is missing or malformed.');
  }

  if (attestation.publicKey !== undefined || (attestation.payload && attestation.payload.publicKey !== undefined)) {
    return makeDecision('BLOCKED', 'SELF_SIGNED_KEY_REJECTED', 'Self-signed or caller-supplied public keys are rejected; keys must come from an independently established trust store.');
  }

  for (const field of ATTESTATION_ENVELOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(attestation, field)) {
      return makeDecision('BLOCKED', 'ATTESTATION_FIELD_MISSING', `Attestation is missing required field: ${field}.`, { fieldName: field });
    }
  }

  if (attestation.schemaVersion !== CURRENT_ATTESTATION_SCHEMA_VERSION) {
    return makeDecision('BLOCKED', 'UNSUPPORTED_SCHEMA_VERSION', `Attestation schema version "${attestation.schemaVersion}" is unsupported. Supported: ${CURRENT_ATTESTATION_SCHEMA_VERSION}.`);
  }

  const normAlgo = String(attestation.algorithm || '').toLowerCase();
  if (!SUPPORTED_SIGNATURE_ALGORITHMS.includes(normAlgo)) {
    return makeDecision('BLOCKED', 'UNSUPPORTED_ALGORITHM', `Signature algorithm "${attestation.algorithm}" is not supported. Supported: ${SUPPORTED_SIGNATURE_ALGORITHMS.join(', ')}.`);
  }

  const payload = attestation.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return makeDecision('BLOCKED', 'PAYLOAD_MALFORMED', 'Attestation payload must be a non-null object.');
  }

  for (const field of ATTESTATION_PAYLOAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      return makeDecision('BLOCKED', 'PAYLOAD_FIELD_MISSING', `Attestation payload is missing required field: ${field}.`, { fieldName: field });
    }
  }

  if (payload.schemaVersion !== attestation.schemaVersion) {
    return makeDecision('BLOCKED', 'SCHEMA_VERSION_MISMATCH', 'Payload schemaVersion does not match envelope schemaVersion.');
  }
  if (payload.issuerId !== attestation.issuerId) {
    return makeDecision('BLOCKED', 'ISSUER_ID_MISMATCH', 'Payload issuerId does not match envelope issuerId.');
  }
  if (payload.keyId !== attestation.keyId) {
    return makeDecision('BLOCKED', 'KEY_ID_MISMATCH', 'Payload keyId does not match envelope keyId.');
  }
  if (String(payload.algorithm || '').toLowerCase() !== normAlgo) {
    return makeDecision('BLOCKED', 'ALGORITHM_MISMATCH', 'Payload algorithm does not match envelope algorithm.');
  }

  // Trust root check
  const publicKeyRef = lookupPublicKey(trustStore, attestation.issuerId, attestation.keyId);
  if (!publicKeyRef) {
    return makeDecision('BLOCKED', 'TRUST_ROOT_NOT_ESTABLISHED', `No trusted public key established for issuer "${attestation.issuerId}" and keyId "${attestation.keyId}".`);
  }

  if (isKeyRevoked(trustStore, attestation.issuerId, attestation.keyId)) {
    return makeDecision('BLOCKED', 'KEY_REVOKED', `Public key "${attestation.keyId}" for issuer "${attestation.issuerId}" has been revoked.`);
  }

  let publicKeyObj;
  if (publicKeyRef && typeof publicKeyRef === 'object' && publicKeyRef.type === 'public') {
    publicKeyObj = publicKeyRef;
  } else {
    try {
      publicKeyObj = crypto.createPublicKey(publicKeyRef);
    } catch (err) {
      return makeDecision('BLOCKED', 'MALFORMED_PUBLIC_KEY', `Failed to parse public key for issuer "${attestation.issuerId}": ${err.message}`);
    }
  }

  // Parse signature
  const sigBuf = parseSignatureBuffer(attestation.signature);
  if (!sigBuf || sigBuf.length === 0) {
    return makeDecision('BLOCKED', 'MALFORMED_SIGNATURE', 'Attestation signature is empty or not valid hex/base64.');
  }

  // Canonicalize payload
  let canonicalPayload;
  try {
    canonicalPayload = canonicalizeJson(payload);
  } catch (err) {
    return makeDecision('BLOCKED', 'PAYLOAD_CANONICALIZATION_FAILED', `Payload canonicalization failed: ${err.message}`);
  }
  const dataBuf = Buffer.from(canonicalPayload, 'utf8');

  // Verify signature
  let verified = false;
  try {
    if (normAlgo === 'ed25519') {
      if (publicKeyObj.asymmetricKeyType !== 'ed25519') {
        return makeDecision('BLOCKED', 'KEY_ALGORITHM_MISMATCH', `Key type "${publicKeyObj.asymmetricKeyType}" cannot be used with ed25519.`);
      }
      verified = crypto.verify(null, dataBuf, publicKeyObj, sigBuf);
    } else if (normAlgo === 'es256') {
      if (publicKeyObj.asymmetricKeyType !== 'ec') {
        return makeDecision('BLOCKED', 'KEY_ALGORITHM_MISMATCH', `Key type "${publicKeyObj.asymmetricKeyType}" cannot be used with es256.`);
      }
      try {
        verified = crypto.verify('sha256', dataBuf, { key: publicKeyObj, dsaEncoding: 'ieee-p1363' }, sigBuf);
      } catch {
        verified = crypto.verify('sha256', dataBuf, { key: publicKeyObj, dsaEncoding: 'der' }, sigBuf);
      }
    } else if (normAlgo === 'rsa-pss-sha256') {
      if (publicKeyObj.asymmetricKeyType !== 'rsa' && publicKeyObj.asymmetricKeyType !== 'rsa-pss') {
        return makeDecision('BLOCKED', 'KEY_ALGORITHM_MISMATCH', `Key type "${publicKeyObj.asymmetricKeyType}" cannot be used with rsa-pss-sha256.`);
      }
      verified = crypto.verify(
        'sha256',
        dataBuf,
        {
          key: publicKeyObj,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        },
        sigBuf
      );
    }
  } catch (err) {
    return makeDecision('BLOCKED', 'SIGNATURE_VERIFICATION_FAILED', `Signature verification error: ${err.message}`);
  }

  if (!verified) {
    return makeDecision('BLOCKED', 'SIGNATURE_VERIFICATION_FAILED', 'Cryptographic signature verification failed: payload tampered or signature mismatch.');
  }

  // Validate timestamps
  let issuedAtMs;
  let expiresAtMs;
  try {
    issuedAtMs = parseTimestamp(payload.issuedAt, 'issuedAt');
    expiresAtMs = parseTimestamp(payload.expiresAt, 'expiresAt');
  } catch (err) {
    return makeDecision('BLOCKED', 'INVALID_TIMESTAMP', err.message);
  }

  const now = Date.now();
  if (issuedAtMs > now + 60000) {
    return makeDecision('BLOCKED', 'EVIDENCE_FUTURE_DATED', `Attestation timestamp is in the future: ${payload.issuedAt}.`);
  }
  if (expiresAtMs <= issuedAtMs) {
    return makeDecision('BLOCKED', 'EVIDENCE_EXPIRY_INVALID', 'Attestation expires before or at its issuance timestamp.');
  }
  if (expiresAtMs <= now) {
    return makeDecision('BLOCKED', 'EVIDENCE_EXPIRED', `Attestation has expired at ${payload.expiresAt}.`);
  }
  if (Number.isFinite(expectedContext.maxEvidenceAgeMs) && expectedContext.maxEvidenceAgeMs > 0) {
    if (now - issuedAtMs > expectedContext.maxEvidenceAgeMs) {
      return makeDecision('BLOCKED', 'EVIDENCE_STALE', `Attestation age exceeds the maximum permitted age of ${expectedContext.maxEvidenceAgeMs}ms.`);
    }
  }

  // Context bindings verification
  const contextBindings = [
    { field: 'runId', name: 'runId' },
    { field: 'sessionId', name: 'sessionId' },
    { field: 'providerId', name: 'providerId' },
    { field: 'grantId', name: 'grantId' },
    { field: 'nonce', name: 'nonce' },
    { field: 'projectIdentityDigest', name: 'projectIdentityDigest', isDigest: true },
    { field: 'policyDigest', name: 'policyDigest', isDigest: true },
    { field: 'verificationPlanDigest', name: 'verificationPlanDigest', isDigest: true },
  ];

  for (const { field, name, isDigest } of contextBindings) {
    if (expectedContext[field] !== undefined && expectedContext[field] !== null) {
      const expVal = isDigest ? normalizeHash(expectedContext[field]) : expectedContext[field];
      const actVal = isDigest ? normalizeHash(payload[field]) : payload[field];
      if (expVal !== actVal) {
        return makeDecision('BLOCKED', 'CONTEXT_BINDING_MISMATCH', `Context binding mismatch for "${name}": expected "${expVal}", got "${actVal}".`, {
          field: name,
          expected: expVal,
          actual: actVal,
        });
      }
    }
  }

  // Also check expectedContext.planDigest vs verificationPlanDigest
  if (expectedContext.planDigest && normalizeHash(expectedContext.planDigest) !== normalizeHash(payload.verificationPlanDigest)) {
    return makeDecision('BLOCKED', 'CONTEXT_BINDING_MISMATCH', `Context binding mismatch for "verificationPlanDigest": expected "${expectedContext.planDigest}", got "${payload.verificationPlanDigest}".`);
  }

  // Replay check
  if (expectedContext.consumedNonces instanceof Set) {
    if (expectedContext.consumedNonces.has(payload.nonce)) {
      return makeDecision('BLOCKED', 'NONCE_REPLAYED', `Nonce "${payload.nonce}" has already been consumed.`);
    }
    expectedContext.consumedNonces.add(payload.nonce);
  } else if (trustStore && typeof trustStore.consumeNonce === 'function') {
    if (!trustStore.consumeNonce(payload.nonce, expiresAtMs)) {
      return makeDecision('BLOCKED', 'NONCE_REPLAYED', `Nonce "${payload.nonce}" has already been consumed.`);
    }
  }

  return makeDecision('AUTHENTICATED', 'SIGNATURE_VERIFIED', 'Cryptographic attestation signature and all context bindings verified successfully.', {
    valid: true,
    issuerId: attestation.issuerId,
    keyId: attestation.keyId,
    algorithm: normAlgo,
    payload,
    verifiedAt: new Date().toISOString(),
  });
}

function evaluateIssuerServiceBoundary(serviceDescriptor = {}) {
  if (!serviceDescriptor || typeof serviceDescriptor !== 'object') {
    return {
      state: ISSUER_SERVICE_STATES.NOT_CONFIGURED,
      isTrustedBoundary: false,
      reason: 'No out-of-process evidence issuer service configured.',
      reasonCode: 'ISSUER_NOT_CONFIGURED',
    };
  }

  // Check if service is claimed to be an ordinary child process or in-process module
  if (serviceDescriptor.isOrdinaryChildProcess === true || serviceDescriptor.runsInUserDesktopSession === true) {
    return {
      state: ISSUER_SERVICE_STATES.NOT_TRUSTED,
      isTrustedBoundary: false,
      reason: 'Ordinary child process or user-desktop-session process lacks an independent security boundary (shares user tokens and credentials).',
      reasonCode: 'NOT_A_SECURITY_BOUNDARY',
    };
  }

  // Check if caller, renderer, backend or provider is impersonating issuer
  if (serviceDescriptor.domain === ISSUER_TRUST_DOMAINS.ELECTRON_RENDERER ||
      serviceDescriptor.domain === ISSUER_TRUST_DOMAINS.PROVIDER_ADAPTER ||
      serviceDescriptor.domain === ISSUER_TRUST_DOMAINS.LOCAL_BACKEND) {
    return {
      state: ISSUER_SERVICE_STATES.NOT_TRUSTED,
      isTrustedBoundary: false,
      reason: `Domain "${serviceDescriptor.domain}" cannot act as an independent evidence issuer.`,
      reasonCode: 'DOMAIN_CANNOT_ISSUE',
    };
  }

  // Check OS isolation mechanisms
  // To be considered an independent boundary on Windows, it requires a dedicated OS service
  // with an isolated OS identity, restricted DACL, isolated IPC, and OS-protected key storage.
  const hasOsIsolation = Boolean(
    serviceDescriptor.hasIndependentOsIdentity &&
    serviceDescriptor.hasIsolatedIpcChannel &&
    serviceDescriptor.hasProtectedKeyStorage
  );

  if (!hasOsIsolation) {
    return {
      state: ISSUER_SERVICE_STATES.NOT_TRUSTED,
      isTrustedBoundary: false,
      reason: 'Service lacks required OS security boundary (independent OS identity, isolated IPC channel, and hardware/OS-protected key storage).',
      reasonCode: 'OS_BOUNDARY_INSUFFICIENT',
    };
  }

  if (serviceDescriptor.isRevoked === true) {
    return {
      state: ISSUER_SERVICE_STATES.REVOKED,
      isTrustedBoundary: false,
      reason: 'Issuer service or key has been revoked.',
      reasonCode: 'ISSUER_REVOKED',
    };
  }

  if (serviceDescriptor.isAvailable === false || serviceDescriptor.isCrashed === true) {
    return {
      state: ISSUER_SERVICE_STATES.UNAVAILABLE,
      isTrustedBoundary: false,
      reason: serviceDescriptor.unavailabilityReason || 'Issuer service is currently offline or unreachable.',
      reasonCode: serviceDescriptor.isCrashed ? 'SERVICE_CRASHED' : 'ISSUER_UNAVAILABLE',
    };
  }

  if (serviceDescriptor.isAuthenticated !== true) {
    return {
      state: ISSUER_SERVICE_STATES.UNAUTHENTICATED,
      isTrustedBoundary: false,
      reason: 'Issuer service authentication has not been established.',
      reasonCode: 'ISSUER_UNAUTHENTICATED',
    };
  }

  // In production, no independent issuer exists yet!
  if (serviceDescriptor.isProductionService === true || !serviceDescriptor.isSyntheticTestService) {
    return {
      state: ISSUER_SERVICE_STATES.NOT_CONFIGURED,
      isTrustedBoundary: false,
      reason: 'Independent evidence issuer service is not implemented in production.',
      reasonCode: 'INDEPENDENT_ISSUER_NOT_IMPLEMENTED',
    };
  }

  return {
    state: ISSUER_SERVICE_STATES.READY,
    isTrustedBoundary: true,
    serviceId: serviceDescriptor.serviceId,
    reason: 'Synthetic test issuer service configured with test boundary.',
    reasonCode: 'SYNTHETIC_TEST_READY',
  };
}

function collectEvidenceFacts({
  callerClaims = {},
  providerClaims = {},
  daemonClaims = {},
  hostObservations = {},
  kernelObservations = {},
  collectedAt = new Date().toISOString(),
} = {}) {
  const facts = [];

  for (const [key, val] of Object.entries(callerClaims || {})) {
    facts.push({
      fact: key,
      value: val,
      origin: EVIDENCE_FACT_ORIGINS.CALLER_CONFIGURATION,
      trustLevel: 'UNVERIFIED_CLAIM',
      collectedAt,
    });
  }

  for (const [key, val] of Object.entries(providerClaims || {})) {
    facts.push({
      fact: key,
      value: val,
      origin: EVIDENCE_FACT_ORIGINS.PROVIDER_REPORTED,
      trustLevel: 'PROVIDER_SELF_REPORTED',
      collectedAt,
    });
  }

  for (const [key, val] of Object.entries(daemonClaims || {})) {
    facts.push({
      fact: key,
      value: val,
      origin: EVIDENCE_FACT_ORIGINS.DAEMON_REPORTED,
      trustLevel: 'DAEMON_SELF_REPORTED',
      collectedAt,
    });
  }

  for (const [key, val] of Object.entries(hostObservations || {})) {
    facts.push({
      fact: key,
      value: val,
      origin: EVIDENCE_FACT_ORIGINS.HOST_OBSERVED,
      trustLevel: 'INDEPENDENTLY_OBSERVED',
      collectedAt,
    });
  }

  for (const [key, val] of Object.entries(kernelObservations || {})) {
    facts.push({
      fact: key,
      value: val,
      origin: EVIDENCE_FACT_ORIGINS.KERNEL_ENFORCED,
      trustLevel: 'KERNEL_ENFORCED',
      collectedAt,
    });
  }

  return Object.freeze(facts);
}

function validateIssuerRequest({
  request,
  expectedContext = {},
  serviceDescriptor = null,
  activeNonces = new Set(),
  maxRequestAgeMs = 60000,
} = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return makeDecision('BLOCKED', 'REQUEST_MALFORMED', 'Issuer service request is missing or malformed.');
  }

  // Reject caller-supplied issuer identities, signatures, or public keys in request
  if (request.issuerIdentity !== undefined || request.issuerId !== undefined) {
    return makeDecision('BLOCKED', 'CALLER_FORGED_ISSUER_IDENTITY', 'Caller-supplied issuer identity rejected.');
  }
  if (request.signature !== undefined || request.attestationEnvelope !== undefined) {
    return makeDecision('BLOCKED', 'CALLER_FORGED_SIGNATURE', 'Caller-supplied signature rejected.');
  }
  if (request.publicKey !== undefined) {
    return makeDecision('BLOCKED', 'SELF_SIGNED_KEY_REJECTED', 'Caller-supplied public key rejected.');
  }

  // Validate required request fields
  for (const field of ISSUER_REQUEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(request, field)) {
      return makeDecision('BLOCKED', 'REQUEST_FIELD_MISSING', `Issuer service request missing required field: ${field}.`, { fieldName: field });
    }
  }

  // Validate caller authorization domain
  const callerAuth = request.callerAuthorization;
  if (!callerAuth || typeof callerAuth !== 'object') {
    return makeDecision('BLOCKED', 'REQUEST_UNAUTHENTICATED', 'Caller authorization credentials missing.');
  }

  if (callerAuth.sourceDomain === ISSUER_TRUST_DOMAINS.ELECTRON_RENDERER) {
    return makeDecision('BLOCKED', 'UNTRUSTED_CALLER_DOMAIN', 'Electron renderer cannot directly request attestation issuance.');
  }
  if (callerAuth.sourceDomain === ISSUER_TRUST_DOMAINS.PROVIDER_ADAPTER) {
    return makeDecision('BLOCKED', 'UNTRUSTED_CALLER_DOMAIN', 'Provider adapter cannot request its own attestation issuance.');
  }
  if (callerAuth.isAuthorized !== true) {
    return makeDecision('BLOCKED', 'UNAUTHORIZED_REQUEST', 'Caller authorization is not verified.');
  }

  // Validate service boundary
  const serviceCheck = evaluateIssuerServiceBoundary(serviceDescriptor);
  if (serviceCheck.state !== ISSUER_SERVICE_STATES.READY) {
    return makeDecision('BLOCKED', serviceCheck.reasonCode, serviceCheck.reason, { serviceState: serviceCheck.state });
  }

  // Validate request timestamp freshness
  let reqTs;
  try {
    reqTs = parseTimestamp(request.requestTimestamp, 'requestTimestamp');
  } catch (err) {
    return makeDecision('BLOCKED', 'REQUEST_TIMESTAMP_INVALID', err.message);
  }

  const now = Date.now();
  if (reqTs > now + 30000) {
    return makeDecision('BLOCKED', 'REQUEST_FUTURE_DATED', 'Request timestamp is in the future.');
  }
  if (now - reqTs > maxRequestAgeMs) {
    return makeDecision('BLOCKED', 'REQUEST_STALE', 'Request timestamp exceeds maximum allowed age.');
  }

  // Replay protection on requestId and nonce
  const nonceKey = `${request.requestId}:${request.nonce}`;
  if (activeNonces.has(nonceKey) || activeNonces.has(request.nonce) || activeNonces.has(request.requestId)) {
    return makeDecision('BLOCKED', 'REPLAY_DETECTED', 'Request identifier or nonce has already been used.');
  }
  activeNonces.add(nonceKey);
  activeNonces.add(request.nonce);
  activeNonces.add(request.requestId);

  // Validate context bindings
  const digestBindings = ['projectIdentityDigest', 'policyDigest', 'verificationPlanDigest'];
  for (const digestField of digestBindings) {
    if (!/^[a-f0-9]{64}$/i.test(request[digestField])) {
      return makeDecision('BLOCKED', 'CONTEXT_DIGEST_INVALID', `Field "${digestField}" must be a 64-character hex digest.`);
    }
  }

  const contextMatches = ['sessionId', 'runId', 'grantId', 'providerId', 'runtimeId'];
  for (const field of contextMatches) {
    if (expectedContext[field] && request[field] !== expectedContext[field]) {
      return makeDecision('BLOCKED', 'CONTEXT_BINDING_MISMATCH', `Context mismatch on "${field}": expected "${expectedContext[field]}", got "${request[field]}".`, {
        field,
        expected: expectedContext[field],
        actual: request[field],
      });
    }
  }

  for (const digestField of digestBindings) {
    if (expectedContext[digestField] && normalizeHash(request[digestField]) !== normalizeHash(expectedContext[digestField])) {
      return makeDecision('BLOCKED', 'CONTEXT_BINDING_MISMATCH', `Context digest mismatch on "${digestField}": expected "${expectedContext[digestField]}", got "${request[digestField]}".`, {
        field: digestField,
        expected: expectedContext[digestField],
        actual: request[digestField],
      });
    }
  }

  return makeDecision('VALID', 'REQUEST_VALIDATED', 'Issuer service request passed all authorization, boundary, freshness, and anti-replay checks.', {
    validatedRequest: request,
  });
}

function issueAttestation({
  validatedRequestResult,
  observedFacts = [],
  serviceDescriptor,
  signingKeyContext = null,
} = {}) {
  if (!validatedRequestResult || validatedRequestResult.state !== 'VALID' || !validatedRequestResult.validatedRequest) {
    return {
      status: 'ISSUANCE_FAILED',
      errorCode: validatedRequestResult?.reasonCode || 'REQUEST_NOT_VALIDATED',
      rejectionReason: validatedRequestResult?.reason || 'Cannot issue attestation without a validated request.',
      attestationEnvelope: null,
    };
  }

  const request = validatedRequestResult.validatedRequest;

  // Verify service boundary
  const boundaryCheck = evaluateIssuerServiceBoundary(serviceDescriptor);
  if (boundaryCheck.state !== ISSUER_SERVICE_STATES.READY) {
    return {
      status: 'ISSUANCE_FAILED',
      errorCode: boundaryCheck.reasonCode,
      rejectionReason: boundaryCheck.reason,
      attestationEnvelope: null,
    };
  }

  // FACT VERIFICATION RULE:
  // Every capability in request.requestedCapabilities MUST have a corresponding
  // fact in observedFacts with origin HOST_OBSERVED, KERNEL_ENFORCED or INDEPENDENT_OS_AUTHENTICATED that is true!
  const requestedCaps = Array.isArray(request.requestedCapabilities)
    ? request.requestedCapabilities
    : Object.keys(request.requestedCapabilities || {});

  const unverifiedCapabilities = [];
  const verifiedCapabilities = {};

  for (const cap of requestedCaps) {
    const matchingFact = (observedFacts || []).find((f) =>
      f.fact === cap &&
      (f.origin === EVIDENCE_FACT_ORIGINS.HOST_OBSERVED ||
       f.origin === EVIDENCE_FACT_ORIGINS.KERNEL_ENFORCED ||
       f.origin === EVIDENCE_FACT_ORIGINS.INDEPENDENT_OS_AUTHENTICATED) &&
      f.value === true
    );

    if (!matchingFact) {
      unverifiedCapabilities.push(cap);
    } else {
      verifiedCapabilities[cap] = true;
    }
  }

  if (unverifiedCapabilities.length > 0) {
    return {
      status: 'ISSUANCE_FAILED',
      errorCode: 'UNVERIFIED_RUNTIME_FACTS',
      rejectionReason: `Cannot issue attestation: capabilities [${unverifiedCapabilities.join(', ')}] lack independent host or kernel observation.`,
      unverifiedCapabilities,
      attestationEnvelope: null,
    };
  }

  // In production, no signing keys or issuer exists
  if (!signingKeyContext || !signingKeyContext.privateKey || !serviceDescriptor?.isSyntheticTestService) {
    return {
      status: 'ISSUANCE_FAILED',
      errorCode: 'TRUSTED_ISSUER_NOT_IMPLEMENTED',
      rejectionReason: 'Independent evidence issuer and production signing key are not implemented.',
      attestationEnvelope: null,
    };
  }

  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

  const payload = createAttestationPayload({
    schemaVersion: CURRENT_ATTESTATION_SCHEMA_VERSION,
    issuerId: serviceDescriptor.serviceId || 'synthetic-issuer-service',
    keyId: signingKeyContext.keyId || 'synthetic-key-1',
    algorithm: signingKeyContext.algorithm || 'ed25519',
    runId: request.runId,
    executionId: crypto.randomUUID(),
    nonce: request.nonce,
    issuedAt,
    expiresAt,
    projectIdentityDigest: request.projectIdentityDigest,
    sessionId: request.sessionId,
    providerId: request.providerId,
    runtimeId: request.runtimeId,
    grantId: request.grantId,
    policyDigest: request.policyDigest,
    verificationPlanDigest: request.verificationPlanDigest,
    configDigest: request.policyDigest,
    capabilities: verifiedCapabilities,
  });

  const envelope = signAttestationPayload({
    payload,
    privateKey: signingKeyContext.privateKey,
    algorithm: signingKeyContext.algorithm || 'ed25519',
    keyId: signingKeyContext.keyId || 'synthetic-key-1',
    issuerId: serviceDescriptor.serviceId || 'synthetic-issuer-service',
  });

  return {
    responseId: crypto.randomUUID(),
    requestId: request.requestId,
    status: 'ISSUED',
    issuerIdentity: {
      issuerId: serviceDescriptor.serviceId || 'synthetic-issuer-service',
      keyId: signingKeyContext.keyId || 'synthetic-key-1',
      algorithm: signingKeyContext.algorithm || 'ed25519',
      trustDomain: serviceDescriptor.domain || ISSUER_TRUST_DOMAINS.ISOLATED_HOST_SERVICE,
    },
    attestationEnvelope: envelope,
    observedFacts: (observedFacts || []).filter((f) =>
      f.origin === EVIDENCE_FACT_ORIGINS.HOST_OBSERVED || f.origin === EVIDENCE_FACT_ORIGINS.KERNEL_ENFORCED
    ),
    rejectionReason: null,
    errorCode: null,
    issuedAt,
    expiresAt,
  };
}

function authorizeExecution({
  attestationVerificationResult,
  serviceDescriptor,
  providerDescriptor,
  policy,
  osEnforcementEvidence,
} = {}) {
  // Enforces the final fail-closed gate
  if (!attestationVerificationResult || attestationVerificationResult.state !== 'AUTHENTICATED') {
    return makeDecision('BLOCKED', 'ATTESTATION_UNAUTHENTICATED', 'Execution blocked: attestation is unauthenticated or signature verification failed.');
  }

  // Service boundary check
  const boundaryCheck = evaluateIssuerServiceBoundary(serviceDescriptor);
  if (!boundaryCheck.isTrustedBoundary || boundaryCheck.state !== ISSUER_SERVICE_STATES.READY) {
    return makeDecision('BLOCKED', 'ISSUER_TRUST_BOUNDARY_NOT_ESTABLISHED', 'Execution blocked: issuer service does not have an independently verified OS trust boundary.');
  }

  // Provider readiness & capability policy
  const { verifyIsolationCapabilities } = require('./isolationCapabilityVerifier.cjs');
  const capResult = verifyIsolationCapabilities({
    providerDescriptor,
    policy,
    evidence: {
      provenance: 'host-observed',
      trustClass: 'APP_VERIFIED',
    },
  });

  if (!capResult.ready || capResult.status !== 'READY') {
    return makeDecision('BLOCKED', 'PROVIDER_CAPABILITIES_BLOCKED', capResult.reason || 'Provider capabilities are not ready.', {
      blockingReasons: capResult.blockingReasons,
    });
  }

  // OS kernel enforcement check: on Windows / WSL, kernel enforcement is not verified
  if (!osEnforcementEvidence || osEnforcementEvidence.kernelEnforced !== true) {
    return makeDecision('BLOCKED', 'OS_ENFORCEMENT_NOT_VERIFIED', 'Execution blocked: OS kernel runtime enforcement is not verified on this platform.');
  }

  // In production, always fail closed
  return makeDecision('BLOCKED', 'PROCESS_ISOLATION_GATE_BLOCKED', 'Execution gate remains blocked: production out-of-process issuer and kernel enforcement are not operational.');
}

function evaluateDockerDaemonTrust({
  endpoint,
  contextName,
  daemonInfo,
  endpointCert,
  callerOverrides,
  platform = process.platform,
  trustStore,
} = {}) {
  // Reject caller-supplied endpoint substitution or environment overrides
  if (callerOverrides && (callerOverrides.DOCKER_HOST || callerOverrides.DOCKER_CONTEXT || callerOverrides.hasOverride)) {
    return {
      isTrusted: false,
      trustState: DOCKER_DAEMON_TRUST_STATES.ENDPOINT_UNTRUSTED,
      reasonCode: 'ENDPOINT_SUBSTITUTION_REJECTED',
      reason: 'Docker endpoint override or caller substitution rejected.',
    };
  }

  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    return {
      isTrusted: false,
      trustState: DOCKER_DAEMON_TRUST_STATES.UNAUTHENTICATED,
      reasonCode: 'DOCKER_ENDPOINT_MISSING',
      reason: 'Docker endpoint is missing or empty.',
    };
  }

  const normEndpoint = endpoint.trim().toLowerCase();

  // Evaluate TCP endpoints: requires verified TLS and trusted certificate
  if (normEndpoint.startsWith('tcp://') || normEndpoint.startsWith('http://') || normEndpoint.startsWith('https://')) {
    if (!endpointCert || !endpointCert.tlsEnabled) {
      return {
        isTrusted: false,
        trustState: DOCKER_DAEMON_TRUST_STATES.TLS_UNVERIFIED,
        reasonCode: 'TLS_UNVERIFIED',
        reason: 'Docker TCP endpoint does not have verified TLS enabled.',
      };
    }
    const isCertTrusted = trustStore && typeof trustStore.verifyCertificate === 'function'
      ? trustStore.verifyCertificate(endpointCert)
      : false;
    if (!isCertTrusted) {
      return {
        isTrusted: false,
        trustState: DOCKER_DAEMON_TRUST_STATES.CERTIFICATE_UNTRUSTED,
        reasonCode: 'CERTIFICATE_UNTRUSTED',
        reason: 'Docker daemon TLS certificate is untrusted, self-signed, or unverified against host trust root.',
      };
    }
  }

  // Local named pipe or Unix socket:
  // While local, the Docker daemon runs outside the application's process boundary and
  // does not cryptographically authenticate its identity or provide kernel enforcement attestations.
  return {
    isTrusted: false,
    trustState: DOCKER_DAEMON_TRUST_STATES.NOT_ESTABLISHED,
    reasonCode: 'DOCKER_DAEMON_TRUST_NOT_ESTABLISHED',
    reason: 'Docker daemon does not possess an independent cryptographic identity or host OS attestation. DOCKER_DAEMON_TRUST remains NOT_ESTABLISHED.',
  };
}

function bindDockerObservationEvidence({
  observation,
  expectedBindings = {},
  maxObservationAgeMs = 60000,
  activeNonces = new Set(),
} = {}) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return {
      valid: false,
      reasonCode: 'OBSERVATION_MALFORMED',
      reason: 'Docker runtime observation must be a non-null object.',
    };
  }

  // Reject caller-supplied forged flags
  if (observation.independentlyVerified === true || observation.kernelEnforced === true
      || observation.state === DOCKER_OBSERVATION_STATES.INDEPENDENTLY_VERIFIED
      || observation.state === DOCKER_OBSERVATION_STATES.KERNEL_ENFORCED) {
    return {
      valid: false,
      reasonCode: 'CALLER_FORGED_OBSERVATION_STATE',
      reason: 'Caller-supplied "independentlyVerified" or "kernelEnforced" state rejected as unverified.',
    };
  }

  if (observation.isTrustedDaemon === true || observation.daemonTrust === 'VERIFIED') {
    return {
      valid: false,
      reasonCode: 'CALLER_FORGED_DAEMON_TRUST',
      reason: 'Caller-supplied daemon trust verification rejected.',
    };
  }

  // Check required binding fields
  for (const field of DOCKER_OBSERVATION_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(observation, field)) {
      return {
        valid: false,
        reasonCode: 'MISSING_BINDING_FIELD',
        reason: `Docker observation missing required binding field: ${field}.`,
        fieldName: field,
      };
    }
  }

  // Validate timestamp freshness
  let obsTime;
  try {
    obsTime = parseTimestamp(observation.observationTimestamp, 'observationTimestamp');
  } catch (err) {
    return {
      valid: false,
      reasonCode: 'OBSERVATION_TIMESTAMP_INVALID',
      reason: err.message,
    };
  }

  const now = Date.now();
  if (obsTime > now + 30000) {
    return {
      valid: false,
      reasonCode: 'OBSERVATION_FUTURE_DATED',
      reason: 'Observation timestamp is in the future.',
    };
  }
  if (now - obsTime > maxObservationAgeMs) {
    return {
      valid: false,
      reasonCode: 'OBSERVATION_STALE',
      reason: 'Observation timestamp exceeds maximum allowed age.',
    };
  }

  // Replay check on nonce
  if (activeNonces.has(observation.nonce)) {
    return {
      valid: false,
      reasonCode: 'REPLAY_DETECTED',
      reason: `Nonce "${observation.nonce}" has already been used.`,
    };
  }
  activeNonces.add(observation.nonce);

  // Validate bindings against expected
  if (expectedBindings.projectId && observation.projectId !== expectedBindings.projectId) {
    return {
      valid: false,
      reasonCode: 'CROSS_PROJECT_EVIDENCE_SUBSTITUTION',
      reason: `Cross-project evidence substitution rejected: expected projectId "${expectedBindings.projectId}", got "${observation.projectId}".`,
    };
  }

  if (expectedBindings.containerId && observation.containerId !== expectedBindings.containerId) {
    return {
      valid: false,
      reasonCode: 'FORGED_CONTAINER_IDENTITY',
      reason: `Container identity mismatch: expected containerId "${expectedBindings.containerId}", got "${observation.containerId}".`,
    };
  }

  for (const [key, val] of Object.entries(expectedBindings)) {
    if (observation[key] !== undefined && val !== undefined && observation[key] !== val) {
      return {
        valid: false,
        reasonCode: 'BINDING_MISMATCH',
        reason: `Observation binding mismatch for "${key}": expected "${val}", got "${observation[key]}".`,
      };
    }
  }

  return {
    valid: true,
    reasonCode: 'BINDING_VALIDATED',
    reason: 'Observation runtime bindings validated successfully.',
    observation,
  };
}

function evaluateDockerObservation({
  observation,
  expectedBindings = {},
  cgroupEvidence,
  mountEvidence,
  networkEvidence,
  processEvidence,
  cleanupEvidence,
  activeNonces = new Set(),
  maxObservationAgeMs = 60000,
  trustStore,
} = {}) {
  if (!observation) {
    return {
      state: DOCKER_OBSERVATION_STATES.NOT_CONFIGURED,
      reasonCode: 'OBSERVATION_MISSING',
      reason: 'No Docker runtime observation provided.',
      isVerified: false,
      kernelEnforcement: 'NOT_VERIFIED',
      daemonTrust: DOCKER_DAEMON_TRUST_STATES.NOT_ESTABLISHED,
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Validate bindings
  const bindingResult = bindDockerObservationEvidence({
    observation,
    expectedBindings,
    maxObservationAgeMs,
    activeNonces,
  });

  if (!bindingResult.valid) {
    return {
      state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: bindingResult.reasonCode,
      reason: bindingResult.reason,
      isVerified: false,
      kernelEnforcement: 'NOT_VERIFIED',
      daemonTrust: DOCKER_DAEMON_TRUST_STATES.NOT_ESTABLISHED,
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Evaluate daemon trust
  const daemonTrustResult = evaluateDockerDaemonTrust({
    endpoint: observation.endpoint,
    daemonInfo: { id: observation.daemonId },
    trustStore,
  });

  // Evaluate Capabilities:
  // A. Read-only Rootfs
  const hasConfigReadOnly = observation.configuredReadOnly === true;
  const daemonReportedReadOnly = observation.daemonReportedReadOnly === true;
  const kernelObservedReadOnly = mountEvidence?.kernelEnforcedReadOnly === true;
  let readOnlyState = DOCKER_OBSERVATION_STATES.UNKNOWN;
  if (kernelObservedReadOnly) {
    readOnlyState = DOCKER_OBSERVATION_STATES.KERNEL_ENFORCED;
  } else if (daemonReportedReadOnly) {
    readOnlyState = DOCKER_OBSERVATION_STATES.DAEMON_REPORTED;
  } else if (hasConfigReadOnly) {
    readOnlyState = DOCKER_OBSERVATION_STATES.NOT_CONFIGURED;
  }

  // B. Network Isolation
  const networkMode = observation.networkMode || 'none';
  if (networkMode === 'bridge') {
    return {
      state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'NETWORK_EGRESS_UNVERIFIED',
      reason: 'Bridge network mode does not enforce default-deny egress filtering.',
      isVerified: false,
      kernelEnforcement: 'NOT_VERIFIED',
      daemonTrust: daemonTrustResult.trustState,
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // C. CPU & Memory limits (cgroups)
  if (cgroupEvidence) {
    if (cgroupEvidence.cgroupControllersMissing === true || cgroupEvidence.controllersAvailable === false) {
      return {
        state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'CGROUP_CONTROLLERS_MISSING',
        reason: 'Kernel cgroup v2 controllers for CPU/memory are missing or disabled.',
        isVerified: false,
        kernelEnforcement: 'NOT_VERIFIED',
        daemonTrust: daemonTrustResult.trustState,
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
    if (cgroupEvidence.conflictDetected === true ||
        (cgroupEvidence.effectiveMemoryMax && observation.memoryLimitBytes &&
         cgroupEvidence.effectiveMemoryMax !== observation.memoryLimitBytes)) {
      return {
        state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'CGROUP_OBSERVATION_CONFLICT',
        reason: 'Cgroup v2 controller memory.max value conflicts with daemon-reported limits.',
        isVerified: false,
        kernelEnforcement: 'NOT_VERIFIED',
        daemonTrust: daemonTrustResult.trustState,
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
  }

  // D. PID Limits
  if (cgroupEvidence && cgroupEvidence.pidsControllerMissing === true) {
    return {
      state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'CGROUP_CONTROLLERS_MISSING',
      reason: 'Kernel cgroup v2 pids controller is missing or unverified.',
      isVerified: false,
      kernelEnforcement: 'NOT_VERIFIED',
      daemonTrust: daemonTrustResult.trustState,
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // E. Filesystem isolation & sensitive mounts
  const mounts = Array.isArray(observation.mounts) ? observation.mounts : [];
  const sensitivePatterns = [/\.git/i, /\.ssh/i, /\.aws/i, /docker\.sock/i, /^\/etc/i];
  for (const m of mounts) {
    const src = String(m.source || m.Source || '');
    if (sensitivePatterns.some((p) => p.test(src))) {
      return {
        state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'SENSITIVE_HOST_PATH_EXPOSED',
        reason: `Sensitive host path "${src}" exposed via bind mount.`,
        isVerified: false,
        kernelEnforcement: 'NOT_VERIFIED',
        daemonTrust: daemonTrustResult.trustState,
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
  }

  // F. Cleanup
  if (cleanupEvidence) {
    if (cleanupEvidence.queryFailed === true || cleanupEvidence.timedOut === true) {
      return {
        state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'CLEANUP_QUERY_FAILED',
        reason: 'Docker container cleanup query failed or timed out; cannot confirm removal.',
        isVerified: false,
        kernelEnforcement: 'NOT_VERIFIED',
        daemonTrust: daemonTrustResult.trustState,
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
    if (cleanupEvidence.daemonAbsenceConfirmed === true && cleanupEvidence.hostProcessesRemaining > 0) {
      return {
        state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'ORPHAN_PROCESS_DETECTED',
        reason: 'Container removed by daemon, but orphan container processes remain active in host process table.',
        isVerified: false,
        kernelEnforcement: 'NOT_VERIFIED',
        daemonTrust: daemonTrustResult.trustState,
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
  }

  // G. Process supervision
  if (processEvidence && processEvidence.hostObservedTermination === false && processEvidence.containerStopped === true) {
    return {
      state: DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'PROCESS_TERMINATION_UNVERIFIED',
      reason: 'Daemon reports container stopped, but host process-tree termination could not be independently observed.',
      isVerified: false,
      kernelEnforcement: 'NOT_VERIFIED',
      daemonTrust: daemonTrustResult.trustState,
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // In production, Docker daemon is not an authenticated security authority and
  // kernel-level enforcement is not independently attested:
  return {
    state: DOCKER_OBSERVATION_STATES.DAEMON_REPORTED,
    reasonCode: 'KERNEL_ENFORCEMENT_NOT_VERIFIED',
    reason: 'Docker observations recorded at DAEMON_REPORTED level; OS kernel-level runtime enforcement is not independently attested.',
    isVerified: false,
    kernelEnforcement: 'NOT_VERIFIED',
    daemonTrust: daemonTrustResult.trustState,
    readOnlyRootfs: readOnlyState,
    networkIsolation: networkMode === 'none' ? DOCKER_OBSERVATION_STATES.DAEMON_REPORTED : DOCKER_OBSERVATION_STATES.UNKNOWN,
    gate: 'PROCESS_ISOLATION_GATE',
    gateStatus: 'BLOCKED',
  };
}

function validateCgroupV2Enforcement({
  cgroupObservation,
  expectedPolicy = {},
  expectedContainerId = null,
} = {}) {
  if (!cgroupObservation || typeof cgroupObservation !== 'object' || Array.isArray(cgroupObservation)) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.NOT_AVAILABLE,
      reasonCode: 'CGROUP_OBSERVATION_MISSING',
      reason: 'Cgroup observation is missing or malformed.',
    };
  }

  // Check cgroup v2 hierarchy
  if (cgroupObservation.cgroupVersion !== 2 && cgroupObservation.isCgroupV2 !== true) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.NOT_SUPPORTED,
      reasonCode: 'CGROUP_V2_HIERARCHY_MISSING',
      reason: 'Unified cgroup v2 hierarchy is missing or unverified.',
    };
  }

  // Check container cgroup identity binding
  const cgroupPath = String(cgroupObservation.cgroupPath || '');
  if (!cgroupPath.trim()) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'CGROUP_PATH_MISSING',
      reason: 'Cgroup path is missing from observation.',
    };
  }

  if (expectedContainerId && !cgroupPath.includes(expectedContainerId)) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'CGROUP_PATH_MISMATCH',
      reason: `Cgroup path "${cgroupPath}" does not match container identity "${expectedContainerId}".`,
    };
  }

  // Check controllers availability in cgroup.controllers and delegation in cgroup.subtree_control
  const controllers = Array.isArray(cgroupObservation.controllers) ? cgroupObservation.controllers : [];
  if (!controllers.includes('cpu')) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'CPU_CONTROLLER_MISSING',
      reason: 'Cgroup v2 cpu controller is missing or not enabled.',
    };
  }
  if (!controllers.includes('memory')) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'MEMORY_CONTROLLER_MISSING',
      reason: 'Cgroup v2 memory controller is missing or not enabled.',
    };
  }
  if (!controllers.includes('pids')) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'PIDS_CONTROLLER_MISSING',
      reason: 'Cgroup v2 pids controller is missing or not enabled.',
    };
  }

  // Evaluate CPU enforcement: cpu.max format is "<quota> <period>"
  const cpuMax = cgroupObservation.cpuMax !== undefined ? cgroupObservation.cpuMax : cgroupObservation['cpu.max'];
  if (typeof cpuMax !== 'string' || !cpuMax.trim()) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'CPU_MAX_MALFORMED',
      reason: 'cgroup cpu.max value is missing or not a string.',
    };
  }

  const cpuTokens = cpuMax.trim().split(/\s+/);
  if (cpuTokens.length !== 2) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'CPU_MAX_MALFORMED',
      reason: `Malformed cpu.max format: "${cpuMax}"; expected "<quota> <period>".`,
    };
  }

  const [quotaStr, periodStr] = cpuTokens;
  const periodVal = Number.parseInt(periodStr, 10);
  if (!Number.isInteger(periodVal) || periodVal <= 0) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'CPU_MAX_MALFORMED',
      reason: `Malformed cpu.max period value: "${periodStr}".`,
    };
  }

  if (quotaStr.toLowerCase() === 'max') {
    if (expectedPolicy.requireResourceLimits !== false) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'UNEXPECTED_UNLIMITED_CPU',
        reason: 'Resource limits policy requires bounded CPU quota, but cgroup cpu.max is "max" (unlimited).',
      };
    }
  } else {
    const quotaVal = Number.parseInt(quotaStr, 10);
    if (!Number.isInteger(quotaVal) || quotaVal <= 0) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'CPU_MAX_MALFORMED',
        reason: `Malformed cpu.max quota value: "${quotaStr}".`,
      };
    }
  }

  // Evaluate Memory enforcement: memory.max
  const memoryMax = cgroupObservation.memoryMax !== undefined ? cgroupObservation.memoryMax : cgroupObservation['memory.max'];
  if (memoryMax === undefined || memoryMax === null || (typeof memoryMax !== 'string' && typeof memoryMax !== 'number')) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'MEMORY_MAX_MALFORMED',
      reason: 'cgroup memory.max value is missing or not string/number.',
    };
  }

  const memStr = String(memoryMax).trim().toLowerCase();
  if (memStr === 'max') {
    if (expectedPolicy.requireResourceLimits !== false) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'UNEXPECTED_UNLIMITED_MEMORY',
        reason: 'Resource limits policy requires bounded memory limit, but cgroup memory.max is "max" (unlimited).',
      };
    }
  } else {
    const memVal = Number(memStr);
    if (!Number.isFinite(memVal) || memVal <= 0 || !Number.isInteger(memVal)) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'MEMORY_MAX_MALFORMED',
        reason: `Malformed memory.max value: "${memStr}".`,
      };
    }
  }

  // Evaluate PID enforcement: pids.max
  const pidsMax = cgroupObservation.pidsMax !== undefined ? cgroupObservation.pidsMax : cgroupObservation['pids.max'];
  if (pidsMax === undefined || pidsMax === null || (typeof pidsMax !== 'string' && typeof pidsMax !== 'number')) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'PIDS_MAX_MALFORMED',
      reason: 'cgroup pids.max value is missing or not string/number.',
    };
  }

  const pidsStr = String(pidsMax).trim().toLowerCase();
  if (pidsStr === 'max') {
    if (expectedPolicy.requireResourceLimits !== false) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'UNEXPECTED_UNLIMITED_PIDS',
        reason: 'Resource limits policy requires bounded PID limit, but cgroup pids.max is "max" (unlimited).',
      };
    }
  } else {
    const pidsVal = Number(pidsStr);
    if (!Number.isFinite(pidsVal) || pidsVal <= 0 || !Number.isInteger(pidsVal)) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'PIDS_MAX_MALFORMED',
        reason: `Malformed pids.max value: "${pidsStr}".`,
      };
    }
  }

  return {
    valid: true,
    state: KERNEL_OBSERVATION_STATES.HOST_OBSERVED,
    reasonCode: 'CGROUP_V2_ENFORCEMENT_OBSERVED',
    reason: 'Host-observed cgroup v2 controllers and bounded limits validated.',
    effectiveLimits: {
      cpuMax: String(cpuMax).trim(),
      memoryMax: memStr,
      pidsMax: pidsStr,
      cgroupPath,
    },
  };
}

function validateReadOnlyMountEnforcement({
  mountObservation,
  expectedContainerId = null,
  expectedMountNamespaceId = null,
} = {}) {
  if (!mountObservation || typeof mountObservation !== 'object' || Array.isArray(mountObservation)) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.NOT_AVAILABLE,
      reasonCode: 'MOUNT_OBSERVATION_MISSING',
      reason: 'Mount observation is missing or malformed.',
    };
  }

  // Validate mount namespace ID
  const mountNsId = String(mountObservation.mountNamespaceId || '').trim();
  if (!mountNsId) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'MOUNT_NAMESPACE_MISSING',
      reason: 'Container mount namespace ID is missing.',
    };
  }

  if (expectedMountNamespaceId && mountNsId !== expectedMountNamespaceId) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'MOUNT_NAMESPACE_MISMATCH',
      reason: `Mount namespace mismatch: expected "${expectedMountNamespaceId}", got "${mountNsId}".`,
    };
  }

  // Validate root mount read-only status in kernel mountinfo
  const mounts = Array.isArray(mountObservation.mounts) ? mountObservation.mounts : [];
  const rootMount = mounts.find((m) => m.target === '/' || m.destination === '/');
  if (!rootMount) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'ROOT_MOUNT_MISSING',
      reason: 'Root filesystem mount "/" not found in mount observations.',
    };
  }

  const rootFlags = Array.isArray(rootMount.flags)
    ? rootMount.flags.map((f) => String(f).toLowerCase())
    : (typeof rootMount.flags === 'string' ? rootMount.flags.toLowerCase().split(/[\s,]+/) : []);
  const rootIsReadOnly = rootFlags.includes('ro') && !rootFlags.includes('rw');
  if (!rootIsReadOnly && rootMount.readOnly !== true) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'WRITABLE_ROOT_FILESYSTEM',
      reason: 'Container root filesystem is not mounted read-only in kernel mountinfo.',
    };
  }

  // Check bind mounts and volume mounts
  const sensitivePatterns = [/\.git/i, /\.ssh/i, /\.aws/i, /docker\.sock/i, /^\/etc/i];
  for (const m of mounts) {
    const src = String(m.source || m.Source || '');
    const dest = String(m.destination || m.target || '');
    const flags = Array.isArray(m.flags)
      ? m.flags.map((f) => String(f).toLowerCase())
      : (typeof m.flags === 'string' ? m.flags.toLowerCase().split(/[\s,]+/) : []);
    const isRw = flags.includes('rw') || m.readOnly === false || m.rw === true;

    // Check sensitive host path exposure
    if (sensitivePatterns.some((p) => p.test(src))) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'SENSITIVE_HOST_PATH_EXPOSED',
        reason: `Sensitive host path "${src}" exposed via mount at "${dest}".`,
      };
    }

    // Writable bind mount check
    if (m.isBindMount === true || m.type === 'bind' || m.propagation) {
      if (isRw && dest !== '/tmp') {
        return {
          valid: false,
          state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
          reasonCode: 'WRITABLE_BIND_MOUNT_DETECTED',
          reason: `Bind mount "${dest}" is writable in kernel mountinfo.`,
        };
      }
    }

    // Writable volume check
    if (m.isVolume === true || m.type === 'volume') {
      if (isRw && dest !== '/tmp') {
        return {
          valid: false,
          state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
          reasonCode: 'WRITABLE_VOLUME_DETECTED',
          reason: `Volume mount "${dest}" is writable in kernel mountinfo.`,
        };
      }
    }
  }

  return {
    valid: true,
    state: KERNEL_OBSERVATION_STATES.HOST_OBSERVED,
    reasonCode: 'READ_ONLY_MOUNTS_OBSERVED',
    reason: 'Host-observed kernel mountinfo confirms read-only root and no unauthorized writable mounts.',
    mountNamespaceId: mountNsId,
  };
}

function evaluateHostKernelEnforcement({
  kernelObservation,
  cgroupObservation,
  mountObservation,
  daemonInspect,
  expectedBindings = {},
  expectedPolicy = {},
  maxObservationAgeMs = 60000,
  activeNonces = new Set(),
} = {}) {
  if (!kernelObservation || typeof kernelObservation !== 'object' || Array.isArray(kernelObservation)) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.NOT_AVAILABLE,
      reasonCode: 'KERNEL_OBSERVATION_MISSING',
      reason: 'Host kernel observation record is missing or malformed.',
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Reject caller-supplied claims of kernel enforcement or observer authentication
  if (kernelObservation.kernelEnforced === true || kernelObservation.independentlyVerified === true
      || kernelObservation.observerAuthenticated === true
      || kernelObservation.verificationState === KERNEL_OBSERVATION_STATES.KERNEL_ENFORCED
      || kernelObservation.state === KERNEL_OBSERVATION_STATES.KERNEL_ENFORCED) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'CALLER_FORGED_KERNEL_ENFORCEMENT',
      reason: 'Caller-supplied "kernelEnforced" or "observerAuthenticated" state rejected as unverified.',
      kernelEnforcement: 'NOT_VERIFIED',
      readOnlyFilesystemEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Validate required provenance binding fields
  for (const field of KERNEL_OBSERVATION_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(kernelObservation, field)) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
        reasonCode: 'MISSING_BINDING_FIELD',
        reason: `Host kernel observation missing required binding field: ${field}.`,
        fieldName: field,
        kernelEnforcement: 'NOT_VERIFIED',
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
  }

  // Validate observation timestamp freshness
  let obsTime;
  try {
    obsTime = parseTimestamp(kernelObservation.observationTimestamp, 'observationTimestamp');
  } catch (err) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'OBSERVATION_TIMESTAMP_INVALID',
      reason: err.message,
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  const now = Date.now();
  if (obsTime > now + 30000) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'OBSERVATION_FUTURE_DATED',
      reason: 'Kernel observation timestamp is in the future.',
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }
  if (now - obsTime > maxObservationAgeMs) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.STALE_OBSERVATION,
      reasonCode: 'STALE_OBSERVATION',
      reason: 'Kernel observation timestamp exceeds maximum allowed age.',
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Anti-replay check on nonce
  if (activeNonces.has(kernelObservation.nonce)) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.VERIFICATION_FAILED,
      reasonCode: 'REPLAY_DETECTED',
      reason: `Nonce "${kernelObservation.nonce}" has already been used.`,
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }
  activeNonces.add(kernelObservation.nonce);

  // Validate project and container identity bindings
  if (expectedBindings.projectId && kernelObservation.projectId !== expectedBindings.projectId) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'CROSS_PROJECT_OBSERVATION_SUBSTITUTION',
      reason: `Cross-project observation substitution rejected: expected projectId "${expectedBindings.projectId}", got "${kernelObservation.projectId}".`,
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  if (expectedBindings.containerId && kernelObservation.containerId !== expectedBindings.containerId) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'CONTAINER_ID_MISMATCH',
      reason: `Container identity mismatch: expected containerId "${expectedBindings.containerId}", got "${kernelObservation.containerId}".`,
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  if (expectedBindings.projectRoot && kernelObservation.projectRoot) {
    const expRoot = path.resolve(expectedBindings.projectRoot).toLowerCase();
    const obsRoot = path.resolve(kernelObservation.projectRoot).toLowerCase();
    if (expRoot !== obsRoot) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
        reasonCode: 'PROJECT_ROOT_MISMATCH',
        reason: `Project root mismatch: expected "${expectedBindings.projectRoot}", got "${kernelObservation.projectRoot}".`,
        kernelEnforcement: 'NOT_VERIFIED',
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
  }

  if (expectedBindings.sessionId && kernelObservation.sessionId && kernelObservation.sessionId !== expectedBindings.sessionId) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'CROSS_SESSION_OBSERVATION_SUBSTITUTION',
      reason: `Cross-session observation substitution rejected: expected sessionId "${expectedBindings.sessionId}", got "${kernelObservation.sessionId}".`,
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Evaluate Cgroup v2 observation
  const cgroupResult = validateCgroupV2Enforcement({
    cgroupObservation: cgroupObservation || kernelObservation.cgroupObservation,
    expectedPolicy,
    expectedContainerId: expectedBindings.containerId || kernelObservation.containerId,
  });
  if (!cgroupResult.valid) {
    return {
      valid: false,
      state: cgroupResult.state,
      reasonCode: cgroupResult.reasonCode,
      reason: cgroupResult.reason,
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Evaluate Mount observation
  const mountResult = validateReadOnlyMountEnforcement({
    mountObservation: mountObservation || kernelObservation.mountObservation,
    expectedContainerId: expectedBindings.containerId || kernelObservation.containerId,
    expectedMountNamespaceId: expectedBindings.mountNamespaceId || kernelObservation.mountNamespaceId,
  });
  if (!mountResult.valid) {
    return {
      valid: false,
      state: mountResult.state,
      reasonCode: mountResult.reasonCode,
      reason: mountResult.reason,
      kernelEnforcement: 'NOT_VERIFIED',
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  // Check daemon vs host conflicts
  if (daemonInspect && typeof daemonInspect === 'object') {
    const daemonMemory = daemonInspect.HostConfig?.Memory;
    const observedMem = Number(cgroupResult.effectiveLimits?.memoryMax);
    if (daemonMemory && Number.isFinite(observedMem) && daemonMemory !== observedMem) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.OBSERVATION_CONFLICT,
        reasonCode: 'DAEMON_HOST_OBSERVATION_CONFLICT',
        reason: `Daemon reported memory limit (${daemonMemory}) conflicts with cgroup memory.max (${observedMem}).`,
        kernelEnforcement: 'NOT_VERIFIED',
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }

    const daemonRo = daemonInspect.HostConfig?.ReadonlyRootfs;
    if (daemonRo === false) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.OBSERVATION_CONFLICT,
        reasonCode: 'DAEMON_HOST_OBSERVATION_CONFLICT',
        reason: 'Daemon reports ReadonlyRootfs: false, conflicting with host read-only expectation.',
        kernelEnforcement: 'NOT_VERIFIED',
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
  }

  // Independent observer authentication:
  if (kernelObservation.observerDescriptor) {
    const authResult = authenticateObserver({
      observerDescriptor: kernelObservation.observerDescriptor,
      peerCredentials: kernelObservation.peerCredentials,
      ipcChannel: kernelObservation.ipcChannel,
      processContext: kernelObservation.processContext,
      isSyntheticTest: kernelObservation.isSyntheticTest === true,
    });
    if (!authResult.isAuthenticated) {
      return {
        valid: false,
        state: KERNEL_OBSERVATION_STATES.KERNEL_ENFORCEMENT_NOT_VERIFIED,
        reasonCode: authResult.reasonCode || 'INDEPENDENT_OBSERVER_NOT_AUTHENTICATED',
        reason: authResult.reason,
        kernelEnforcement: 'NOT_VERIFIED',
        readOnlyFilesystemEnforcement: 'NOT_VERIFIED',
        cgroupState: cgroupResult.state,
        mountState: mountResult.state,
        gate: 'PROCESS_ISOLATION_GATE',
        gateStatus: 'BLOCKED',
      };
    }
  } else if (kernelObservation.observerAuthentication !== 'AUTHENTICATED' || !kernelObservation.hasIndependentSecurityPrincipal) {
    return {
      valid: false,
      state: KERNEL_OBSERVATION_STATES.KERNEL_ENFORCEMENT_NOT_VERIFIED,
      reasonCode: 'INDEPENDENT_OBSERVER_NOT_AUTHENTICATED',
      reason: 'Host kernel observation is not authenticated by an independent OS security principal. KERNEL_RESOURCE_ENFORCEMENT and READ_ONLY_FILESYSTEM_ENFORCEMENT remain NOT_VERIFIED.',
      kernelEnforcement: 'NOT_VERIFIED',
      readOnlyFilesystemEnforcement: 'NOT_VERIFIED',
      cgroupState: cgroupResult.state,
      mountState: mountResult.state,
      gate: 'PROCESS_ISOLATION_GATE',
      gateStatus: 'BLOCKED',
    };
  }

  return {
    valid: true,
    state: KERNEL_OBSERVATION_STATES.HOST_OBSERVED,
    reasonCode: 'HOST_KERNEL_OBSERVATION_RECORDED',
    reason: 'Host kernel telemetry recorded and cross-validated; independent OS attestation pending.',
    kernelEnforcement: 'NOT_VERIFIED',
    readOnlyFilesystemEnforcement: 'NOT_VERIFIED',
    cgroupState: cgroupResult.state,
    mountState: mountResult.state,
    gate: 'PROCESS_ISOLATION_GATE',
    gateStatus: 'BLOCKED',
  };
}

function authenticateObserver({
  observerDescriptor,
  peerCredentials = null,
  ipcChannel = null,
  processContext = {},
  isSyntheticTest = false,
} = {}) {
  if (!observerDescriptor || typeof observerDescriptor !== 'object' || Array.isArray(observerDescriptor)) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNAUTHENTICATED,
      reasonCode: 'OBSERVER_DESCRIPTOR_MISSING',
      reason: 'Observer descriptor is missing or malformed.',
    };
  }

  // 1. Rejection of caller-forged authentication flags
  if (observerDescriptor.observerAuthenticated === true ||
      observerDescriptor.authenticated === true ||
      observerDescriptor.independentlyVerified === true ||
      observerDescriptor.kernelEnforced === true ||
      observerDescriptor.trustedIssuer === true ||
      observerDescriptor.hostObserved === true ||
      observerDescriptor.windowsPipeVerified === true ||
      observerDescriptor.osProcessIdentityVerified === true ||
      observerDescriptor.ipcClientAuthenticated === true) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.CALLER_FORGED,
      reasonCode: 'CALLER_FORGED_OBSERVER_IDENTITY',
      reason: 'Caller-supplied observer authentication flag rejected as unverified.',
    };
  }

  // 2. Identity source differentiation
  const idSource = observerDescriptor.identitySource;
  if (!idSource || idSource === OBSERVER_IDENTITY_SOURCES.CALLER_PROVIDED) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNAUTHENTICATED,
      reasonCode: 'CALLER_PROVIDED_IDENTITY_UNTRUSTED',
      reason: 'Caller-provided identity cannot be accepted as an authoritative observer source.',
    };
  }

  if (idSource === OBSERVER_IDENTITY_SOURCES.ELECTRON_RENDERER) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNTRUSTED_PROCESS_DOMAIN,
      reasonCode: 'RENDERER_PROCESS_UNTRUSTED',
      reason: 'Electron renderer process cannot act as an authenticated host observer.',
    };
  }

  if (idSource === OBSERVER_IDENTITY_SOURCES.ELECTRON_MAIN) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNTRUSTED_PROCESS_DOMAIN,
      reasonCode: 'MAIN_PROCESS_UNTRUSTED',
      reason: 'Electron main process cannot self-authenticate as an independent OS observer.',
    };
  }

  if (idSource === OBSERVER_IDENTITY_SOURCES.CHILD_PROCESS) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNTRUSTED_PROCESS_DOMAIN,
      reasonCode: 'CHILD_PROCESS_UNTRUSTED',
      reason: 'Child process spawned by untrusted application cannot act as an independent OS observer.',
    };
  }

  // 3. Process identity and parent-child relationship check
  const currentPid = processContext.currentPid || process.pid;
  if (observerDescriptor.pid !== undefined && observerDescriptor.pid === currentPid) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNTRUSTED_PROCESS_DOMAIN,
      reasonCode: 'IN_PROCESS_OBSERVER_REJECTED',
      reason: 'Observer cannot reside in the same process as the application runner.',
    };
  }

  if (observerDescriptor.parentPid !== undefined && observerDescriptor.parentPid === currentPid) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNTRUSTED_PROCESS_DOMAIN,
      reasonCode: 'CHILD_PROCESS_OBSERVER_REJECTED',
      reason: 'Observer cannot be a child or descendant of the application runner.',
    };
  }

  // 4. Observer executable identity check
  const execPath = String(observerDescriptor.executablePath || '').trim();
  if (!execPath) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNAUTHENTICATED,
      reasonCode: 'OBSERVER_EXECUTABLE_PATH_MISSING',
      reason: 'Observer executable path is missing or empty.',
    };
  }

  const normExecPath = path.normalize(execPath);
  const untrustedPathPatterns = [
    /node_modules/i,
    /AppData[\\/]Local[\\/]Temp/i,
    /\/tmp\//i,
    /\/var\/tmp\//i,
    /Desktop[\\/]Ai_Help_Agent/i,
  ];
  if (untrustedPathPatterns.some((pattern) => pattern.test(normExecPath))) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNAUTHENTICATED,
      reasonCode: 'UNTRUSTED_OBSERVER_EXECUTABLE_PATH',
      reason: `Observer binary located in user-writable or untrusted path: "${execPath}".`,
    };
  }

  // 5. IPC peer authentication
  if (!peerCredentials || peerCredentials.authenticated !== true) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.PEER_UNAUTHENTICATED,
      reasonCode: 'IPC_PEER_UNAUTHENTICATED',
      reason: 'IPC connection lacks OS-level peer authentication (SO_PEERCRED / Windows named pipe impersonation).',
    };
  }

  if (peerCredentials.peerPid !== undefined && observerDescriptor.pid !== undefined && peerCredentials.peerPid !== observerDescriptor.pid) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.IDENTITY_MISMATCH,
      reasonCode: 'IPC_PEER_PID_MISMATCH',
      reason: `IPC peer PID (${peerCredentials.peerPid}) does not match declared observer PID (${observerDescriptor.pid}).`,
    };
  }

  // 6. IPC channel access control
  if (ipcChannel && ipcChannel.restrictedAcl === false) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.UNAUTHENTICATED,
      reasonCode: 'INSECURE_IPC_CHANNEL',
      reason: 'IPC channel lacks restricted OS security descriptors / ACLs.',
    };
  }

  // 7. Observer lifecycle and liveness
  if (observerDescriptor.isAlive === false || observerDescriptor.terminated === true) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.LIFECYCLE_TERMINATED,
      reasonCode: 'OBSERVER_PROCESS_TERMINATED',
      reason: 'Observer process is terminated or no longer alive.',
    };
  }

  if (observerDescriptor.lastHeartbeat) {
    const hbTime = Date.parse(observerDescriptor.lastHeartbeat);
    const maxHeartbeatAge = observerDescriptor.maxHeartbeatAgeMs || 15000;
    if (Number.isNaN(hbTime) || Date.now() - hbTime > maxHeartbeatAge) {
      return {
        isAuthenticated: false,
        state: OBSERVER_AUTHENTICATION_STATES.STALE_HEARTBEAT,
        reasonCode: 'OBSERVER_HEARTBEAT_STALE',
        reason: 'Observer heartbeat is stale or timed out.',
      };
    }
  }

  // 7b. Windows Named Pipe and OS process peer validation
  if (observerDescriptor.windowsNamedPipe || ipcChannel?.channelType === 'named_pipe' || peerCredentials?.namedPipeConfig) {
    const pipeConfig = observerDescriptor.windowsNamedPipe || peerCredentials?.namedPipeConfig || {};
    const pipeCheck = validateWindowsNamedPipeSecurity({
      pipePath: pipeConfig.pipePath || ipcChannel?.pipePath || observerDescriptor.pipePath,
      securityDescriptor: pipeConfig.securityDescriptor || ipcChannel?.securityDescriptor,
      clientContext: pipeConfig.clientContext || processContext,
      isSyntheticTest,
    });
    if (!pipeCheck.valid) {
      return {
        isAuthenticated: false,
        state: pipeCheck.state || OBSERVER_AUTHENTICATION_STATES.REJECTED,
        reasonCode: pipeCheck.reasonCode || 'WINDOWS_PIPE_SECURITY_REJECTED',
        reason: pipeCheck.reason,
      };
    }
  }

  if (observerDescriptor.windowsProcessPeer || peerCredentials?.peerProcessDescriptor) {
    const peerDesc = observerDescriptor.windowsProcessPeer || peerCredentials?.peerProcessDescriptor;
    const peerCheck = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: peerDesc,
      expectedPrincipalSid: observerDescriptor.expectedPrincipalSid || 'S-1-5-18',
      expectedContext: processContext,
      isSyntheticTest,
    });
    if (!peerCheck.valid) {
      return {
        isAuthenticated: false,
        state: peerCheck.state || OBSERVER_AUTHENTICATION_STATES.REJECTED,
        reasonCode: peerCheck.reasonCode || 'WINDOWS_PROCESS_IDENTITY_REJECTED',
        reason: peerCheck.reason,
      };
    }
  }

  // 8. Production check: independent OS daemon is NOT implemented on this host
  if (!isSyntheticTest) {
    return {
      isAuthenticated: false,
      state: OBSERVER_AUTHENTICATION_STATES.NOT_IMPLEMENTED,
      reasonCode: 'INDEPENDENT_OBSERVER_NOT_IMPLEMENTED',
      reason: 'Independent host observer daemon running under a distinct OS security principal is NOT implemented on this platform.',
    };
  }

  return {
    isAuthenticated: true,
    state: OBSERVER_AUTHENTICATION_STATES.AUTHENTICATED,
    reasonCode: 'OBSERVER_AUTHENTICATED',
    reason: 'Observer identity authenticated via verified OS peer credentials and security descriptor.',
    observerDescriptor,
  };
}

function validateWindowsNamedPipeSecurity({
  pipePath,
  securityDescriptor,
  clientContext = {},
  isSyntheticTest = false,
} = {}) {
  if (typeof pipePath !== 'string' || !pipePath.trim()) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'PIPE_PATH_MISSING',
      reason: 'Windows named pipe path is missing or not a string.',
    };
  }

  const normPath = pipePath.trim().toLowerCase().replace(/\//g, '\\');
  if (!normPath.startsWith('\\\\.\\pipe\\')) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'INVALID_PIPE_PATH',
      reason: `Pipe path "${pipePath}" is invalid; Windows named pipes must begin with "\\\\.\\pipe\\".`,
    };
  }

  // 1. Pipe Path Known
  // 2. Validate Security Descriptor & DACL
  if (!securityDescriptor || typeof securityDescriptor !== 'object') {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.PIPE_PATH_KNOWN,
      reasonCode: 'SECURITY_DESCRIPTOR_MISSING',
      reason: 'Named pipe lacks an explicit Windows security descriptor.',
    };
  }

  if (securityDescriptor.nullDacl === true || securityDescriptor.dacl === null) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'NULL_DACL_REJECTED',
      reason: 'Named pipe with NULL DACL allows unrestricted access to any local process and is strictly rejected.',
    };
  }

  const sddl = String(securityDescriptor.sddl || '').toUpperCase();
  if (sddl.includes('WD') || sddl.includes('EVERYONE')) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'EVERYONE_ACCESS_REJECTED',
      reason: 'Named pipe DACL grants access to Everyone (WD); restricted security principal required.',
    };
  }

  if (securityDescriptor.restrictedDacl !== true && !sddl.includes('SY') && !sddl.includes('BA')) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.PIPE_ACL_CONFIGURED,
      reasonCode: 'INSECURE_PIPE_DACL',
      reason: 'Named pipe DACL is not restricted to trusted OS administrators or system service accounts.',
    };
  }

  // 3. Cross-session access prevention (Terminal Services Session ID)
  if (clientContext.terminalSessionId !== undefined && securityDescriptor.terminalSessionId !== undefined) {
    if (clientContext.terminalSessionId !== securityDescriptor.terminalSessionId) {
      return {
        valid: false,
        state: WINDOWS_IPC_SECURITY_STATES.CROSS_SESSION_REJECTED,
        reasonCode: 'CROSS_SESSION_ACCESS_REJECTED',
        reason: `Cross-session IPC rejected: client terminal session (${clientContext.terminalSessionId}) does not match pipe server session (${securityDescriptor.terminalSessionId}).`,
      };
    }
  }

  // 4. OS Authentication Feasibility Check in Pure Node.js
  if (!isSyntheticTest) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.NOT_IMPLEMENTED,
      reasonCode: 'WINDOWS_NATIVE_IPC_AUTH_NOT_IMPLEMENTED',
      reason: 'Pure Node.js runtime cannot safely invoke ImpersonateNamedPipeClient or GetNamedPipeClientProcessId without native Win32 FFI bindings. Windows named pipe OS authentication is NOT_IMPLEMENTED.',
    };
  }

  return {
    valid: true,
    state: WINDOWS_IPC_SECURITY_STATES.PIPE_ACL_CONFIGURED,
    reasonCode: 'WINDOWS_PIPE_SECURITY_VALIDATED',
    reason: 'Windows named pipe path and restricted DACL security descriptor structurally validated.',
    pipePath: normPath,
  };
}

function validateWindowsProcessPeerIdentity({
  peerProcessDescriptor,
  expectedPrincipalSid = 'S-1-5-18',
  expectedContext = {},
  isSyntheticTest = false,
} = {}) {
  if (!peerProcessDescriptor || typeof peerProcessDescriptor !== 'object') {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'PEER_DESCRIPTOR_MISSING',
      reason: 'Windows peer process descriptor is missing or malformed.',
    };
  }

  // 1. Process ID validation
  const pid = peerProcessDescriptor.pid;
  if (!Number.isInteger(pid) || pid <= 4) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'INVALID_CLIENT_PID',
      reason: `Client PID ${pid} is invalid (must be a valid non-system PID > 4).`,
    };
  }

  // 2. Process handle validation
  if (peerProcessDescriptor.handleValid === false || peerProcessDescriptor.processExited === true) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'INVALID_PROCESS_HANDLE',
      reason: 'Client process handle is invalid, closed, or process has terminated.',
    };
  }

  // 3. Process creation identity & PID reuse protection
  const creationTime = peerProcessDescriptor.processCreationTimeUtc || peerProcessDescriptor.creationTimestamp;
  if (!creationTime) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'CREATION_TIME_MISSING',
      reason: 'Process creation timestamp missing; PID reuse cannot be protected against.',
    };
  }

  if (expectedContext.processCreationTimeUtc && creationTime !== expectedContext.processCreationTimeUtc) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.PID_REUSE_DETECTED,
      reasonCode: 'PID_REUSE_DETECTED',
      reason: `PID reuse detected: process creation time (${creationTime}) does not match expected creation time (${expectedContext.processCreationTimeUtc}).`,
    };
  }

  // 4. Executable identity
  const execPath = String(peerProcessDescriptor.executablePath || '').trim();
  if (!execPath) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'EXECUTABLE_PATH_MISSING',
      reason: 'Client process executable path is missing.',
    };
  }
  const normExec = path.normalize(execPath);
  const untrustedPatterns = [
    /node_modules/i,
    /AppData[\\/]Local[\\/]Temp/i,
    /\/tmp\//i,
    /\/var\/tmp\//i,
    /Desktop[\\/]Ai_Help_Agent/i,
  ];
  if (untrustedPatterns.some((p) => p.test(normExec))) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'UNTRUSTED_OBSERVER_EXECUTABLE_PATH',
      reason: `Observer binary in untrusted or user-writable path: "${execPath}".`,
    };
  }

  // 5. OS Security Principal (TokenUser SID)
  const tokenSid = String(peerProcessDescriptor.tokenUserSid || '').trim().toUpperCase();
  if (!tokenSid) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'TOKEN_SID_MISSING',
      reason: 'Windows process security token user SID is missing.',
    };
  }

  if (expectedPrincipalSid && tokenSid !== expectedPrincipalSid.toUpperCase() && !WINDOWS_TRUSTED_SECURITY_PRINCIPALS.includes(tokenSid)) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.SECURITY_PRINCIPAL_MISMATCH,
      reasonCode: 'SECURITY_PRINCIPAL_MISMATCH',
      reason: `OS security principal mismatch: client runs under "${tokenSid}", expected "${expectedPrincipalSid}".`,
    };
  }

  // 6. Process domain checks
  const domain = peerProcessDescriptor.identitySource;
  if (domain === OBSERVER_IDENTITY_SOURCES.ELECTRON_RENDERER || domain === OBSERVER_IDENTITY_SOURCES.ELECTRON_MAIN || domain === OBSERVER_IDENTITY_SOURCES.CHILD_PROCESS) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.REJECTED,
      reasonCode: 'UNTRUSTED_PROCESS_DOMAIN',
      reason: `Client process domain "${domain}" cannot act as an independent OS observer.`,
    };
  }

  // 7. Production feasibility check
  if (!isSyntheticTest) {
    return {
      valid: false,
      state: WINDOWS_IPC_SECURITY_STATES.NOT_VERIFIED,
      reasonCode: 'OS_PROCESS_IDENTITY_NOT_VERIFIED',
      reason: 'Windows OS-authenticated process token and creation identity are not independently attested in production.',
    };
  }

  return {
    valid: true,
    state: WINDOWS_IPC_SECURITY_STATES.CLIENT_OS_IDENTITY_VERIFIED,
    reasonCode: 'PROCESS_PEER_IDENTITY_VERIFIED',
    reason: 'Windows client OS process creation time, handle, and security principal verified.',
    peerProcessDescriptor,
  };
}

function validateObservationContext({
  observation,
  expectedBindings = {},
} = {}) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return {
      valid: false,
      reasonCode: 'OBSERVATION_MALFORMED',
      reason: 'Observation record is missing or not an object.',
    };
  }

  // Check all 12 mandatory context binding fields
  for (const field of OBSERVER_CONTEXT_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(observation, field)) {
      return {
        valid: false,
        reasonCode: 'MISSING_CONTEXT_BINDING_FIELD',
        reason: `Observation missing mandatory context binding field: "${field}".`,
        fieldName: field,
      };
    }
  }

  // Check expected bindings
  if (expectedBindings.projectId && observation.projectId !== expectedBindings.projectId) {
    return {
      valid: false,
      reasonCode: 'CROSS_PROJECT_EVIDENCE_REUSE',
      reason: `Cross-project evidence reuse rejected: expected "${expectedBindings.projectId}", got "${observation.projectId}".`,
    };
  }

  if (expectedBindings.projectRoot) {
    const expRoot = path.resolve(expectedBindings.projectRoot).toLowerCase();
    const obsRoot = path.resolve(observation.projectRoot).toLowerCase();
    if (expRoot !== obsRoot) {
      return {
        valid: false,
        reasonCode: 'PROJECT_ROOT_MISMATCH',
        reason: `Project root mismatch: expected "${expectedBindings.projectRoot}", got "${observation.projectRoot}".`,
      };
    }
  }

  if (expectedBindings.sessionId && observation.sessionId !== expectedBindings.sessionId) {
    return {
      valid: false,
      reasonCode: 'CROSS_SESSION_EVIDENCE_REUSE',
      reason: `Cross-session evidence reuse rejected: expected "${expectedBindings.sessionId}", got "${observation.sessionId}".`,
    };
  }

  if (expectedBindings.executionId && observation.executionId !== expectedBindings.executionId) {
    return {
      valid: false,
      reasonCode: 'EXECUTION_ID_MISMATCH',
      reason: `Execution ID mismatch: expected "${expectedBindings.executionId}", got "${observation.executionId}".`,
    };
  }

  if (expectedBindings.containerId && observation.containerId !== expectedBindings.containerId) {
    return {
      valid: false,
      reasonCode: 'CONTAINER_ID_MISMATCH',
      reason: `Container ID mismatch: expected "${expectedBindings.containerId}", got "${observation.containerId}".`,
    };
  }

  if (expectedBindings.grantId && observation.grantId !== expectedBindings.grantId) {
    return {
      valid: false,
      reasonCode: 'GRANT_ID_MISMATCH',
      reason: `Grant ID mismatch: expected "${expectedBindings.grantId}", got "${observation.grantId}".`,
    };
  }

  if (expectedBindings.policyDigest && normalizeHash(observation.policyDigest) !== normalizeHash(expectedBindings.policyDigest)) {
    return {
      valid: false,
      reasonCode: 'POLICY_DIGEST_MISMATCH',
      reason: 'Policy digest in observation does not match expected execution policy digest.',
    };
  }

  if (expectedBindings.verificationPlanDigest && normalizeHash(observation.verificationPlanDigest) !== normalizeHash(expectedBindings.verificationPlanDigest)) {
    return {
      valid: false,
      reasonCode: 'PLAN_DIGEST_MISMATCH',
      reason: 'Verification plan digest in observation does not match approved plan proposal digest.',
    };
  }

  return {
    valid: true,
    reasonCode: 'CONTEXT_BINDINGS_VALIDATED',
    reason: 'Observation context bindings successfully verified.',
  };
}

function verifyObservationFreshness({
  observationTimestamp,
  observedAt,
  maxObservationAgeMs = 60000,
  activeNonces = new Set(),
  nonce,
  observerNonce,
} = {}) {
  const tsRaw = observedAt || observationTimestamp;
  if (!tsRaw) {
    return {
      fresh: false,
      reasonCode: 'TIMESTAMP_MISSING',
      reason: 'Observation timestamp is missing.',
    };
  }

  let tsMs;
  try {
    tsMs = parseTimestamp(tsRaw, 'observedAt');
  } catch (err) {
    return {
      fresh: false,
      reasonCode: 'TIMESTAMP_INVALID',
      reason: err.message,
    };
  }

  const now = Date.now();
  if (tsMs > now + 30000) {
    return {
      fresh: false,
      reasonCode: 'OBSERVATION_FUTURE_DATED',
      reason: 'Observation timestamp is in the future.',
    };
  }

  if (now - tsMs > maxObservationAgeMs) {
    return {
      fresh: false,
      reasonCode: 'OBSERVATION_STALE',
      reason: `Observation timestamp exceeds maximum allowed age of ${maxObservationAgeMs}ms.`,
    };
  }

  // Anti-replay on nonce (Note: In-memory nonce tracking is non-durable and does not survive restarts or concurrent processes)
  const effectiveNonce = observerNonce || nonce;
  if (!effectiveNonce || typeof effectiveNonce !== 'string') {
    return {
      fresh: false,
      reasonCode: 'NONCE_MISSING',
      reason: 'Observer nonce is missing or not a string.',
    };
  }

  if (activeNonces.has(effectiveNonce)) {
    return {
      fresh: false,
      reasonCode: 'REPLAY_DETECTED',
      reason: `Observer nonce "${effectiveNonce}" has already been used.`,
    };
  }
  activeNonces.add(effectiveNonce);

  return {
    fresh: true,
    reasonCode: 'FRESHNESS_VALIDATED',
    reason: 'Observation timestamp and nonce freshness validated.',
    observedTimeMs: tsMs,
  };
}

function validateObserverRequest({
  request,
  observerDescriptor = null,
  expectedContext = {},
  activeNonces = new Set(),
  maxRequestAgeMs = 60000,
  isSyntheticTest = false,
} = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return makeDecision('BLOCKED', 'REQUEST_MALFORMED', 'Observer request is missing or malformed.');
  }

  // Reject caller-forged flags
  if (request.observerAuthenticated === true || request.independentlyVerified === true || request.kernelEnforced === true) {
    return makeDecision('BLOCKED', 'CALLER_FORGED_OBSERVER_IDENTITY', 'Caller-supplied authentication flag in request rejected.');
  }

  // Required request fields
  const requiredFields = ['requestId', 'requestTimestamp', 'nonce', 'grantId', 'projectId', 'sessionId', 'executionId', 'containerId'];
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(request, field)) {
      return makeDecision('BLOCKED', 'REQUEST_FIELD_MISSING', `Observer request missing required field: ${field}.`, { fieldName: field });
    }
  }

  // Freshness check
  const freshness = verifyObservationFreshness({
    observationTimestamp: request.requestTimestamp,
    maxObservationAgeMs: maxRequestAgeMs,
    activeNonces,
    nonce: request.nonce,
  });
  if (!freshness.fresh) {
    return makeDecision('BLOCKED', freshness.reasonCode, freshness.reason);
  }

  // Context bindings
  for (const field of ['projectId', 'sessionId', 'executionId', 'containerId', 'grantId']) {
    if (expectedContext[field] && request[field] !== expectedContext[field]) {
      return makeDecision('BLOCKED', 'CONTEXT_BINDING_MISMATCH', `Context binding mismatch on "${field}": expected "${expectedContext[field]}", got "${request[field]}".`, {
        field,
        expected: expectedContext[field],
        actual: request[field],
      });
    }
  }

  // Observer identity check
  if (observerDescriptor) {
    const authCheck = authenticateObserver({
      observerDescriptor,
      isSyntheticTest,
    });
    if (!authCheck.isAuthenticated) {
      return makeDecision('BLOCKED', authCheck.reasonCode, authCheck.reason);
    }
  }

  return makeDecision('VALID', 'OBSERVER_REQUEST_VALIDATED', 'Observer request validated successfully.', {
    validatedRequest: request,
  });
}

function validateExecutionEvidenceManifest(manifest, expectedContext = {}) {
  if (manifest && (manifest.schemaVersion === CURRENT_ATTESTATION_SCHEMA_VERSION || manifest.attestation)) {
    const attestation = manifest.attestation || manifest;
    const attestationResult = verifyAttestationSignature({
      attestation,
      trustStore: expectedContext.trustStore,
      expectedContext,
    });
    if (!attestationResult.valid || attestationResult.state !== 'AUTHENTICATED') {
      return attestationResult;
    }
  }
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
  ISSUER_SERVICE_STATES,
  ISSUER_TRUST_DOMAINS,
  EVIDENCE_FACT_ORIGINS,
  ISSUER_REQUEST_FIELDS,
  ISSUER_RESPONSE_FIELDS,
  DOCKER_DAEMON_TRUST_STATES,
  DOCKER_OBSERVATION_STATES,
  DOCKER_OBSERVATION_BINDING_FIELDS,
  KERNEL_OBSERVATION_STATES,
  KERNEL_OBSERVATION_BINDING_FIELDS,
  OBSERVER_IDENTITY_SOURCES,
  OBSERVER_AUTHENTICATION_STATES,
  OBSERVER_CONTEXT_BINDING_FIELDS,
  WINDOWS_IPC_SECURITY_STATES,
  WINDOWS_TRUSTED_SECURITY_PRINCIPALS,
  validateWindowsNamedPipeSecurity,
  validateWindowsProcessPeerIdentity,
  evaluateDockerDaemonTrust,
  bindDockerObservationEvidence,
  evaluateDockerObservation,
  validateCgroupV2Enforcement,
  validateReadOnlyMountEnforcement,
  evaluateHostKernelEnforcement,
  authenticateObserver,
  validateObserverRequest,
  validateObservationContext,
  verifyObservationFreshness,
  evaluateIssuerServiceBoundary,
  collectEvidenceFacts,
  validateIssuerRequest,
  issueAttestation,
  authorizeExecution,
  ATTESTATION_ENVELOPE_FIELDS,
  ATTESTATION_PAYLOAD_FIELDS,
  CURRENT_ATTESTATION_SCHEMA_VERSION,
  SUPPORTED_SIGNATURE_ALGORITHMS,
  canonicalizeJson,
  createAttestationPayload,
  signAttestationPayload,
  verifyAttestationSignature,
  DEFAULT_TIMEOUT_MS,
  EVIDENCE_STATES,
  EXECUTION_GRANT_BINDINGS,
  EXECUTION_GRANT_FIELDS,
  MAX_EXECUTION_GRANT_TTL_MS,
  MAX_TIMEOUT_MS,
  MANDATORY_CAPABILITIES,
  REQUIRED_EVIDENCE_FIELDS,
  TRUST_CLASSES,
  buildExecutionEvidenceManifest,
  createResultEnvelope,
  evaluateProviderEligibility,
  evaluateResultEnvelope,
  normalizeTimeoutMs,
  validateExecutionGrantStructure,
  validateExecutionEvidenceManifest,
};
