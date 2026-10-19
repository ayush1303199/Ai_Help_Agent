import assert from 'node:assert/strict';
import contract from '../electron/coding-pipeline/executionEvidenceContract.cjs';
import isolation from '../electron/coding-pipeline/projectProcessIsolation.cjs';
import providerContract from '../electron/coding-pipeline/providerAdapterContract.cjs';

const uuid = (suffix) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const digest = (character) => character.repeat(64);
const now = Date.now();
const grant = {
  grantId: uuid('1'),
  requestDigest: digest('a'),
  taskId: uuid('2'),
  proposalId: uuid('3'),
  projectIdentityDigest: digest('b'),
  canonicalRootDigest: digest('c'),
  approvedSnapshotDigest: digest('d'),
  approvedManifestDigest: digest('e'),
  verificationPlanDigest: digest('f'),
  operationDigest: digest('1'),
  policyRevision: 'policy-revision-7',
  configRevision: 'config-revision-9',
  runId: uuid('4'),
  nonce: uuid('5'),
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(),
  issuerId: 'synthetic-supervisor-fixture',
  singleUse: true,
  consumedAt: null,
};

const expected = {
  approvalConsumed: true,
  snapshotValidated: true,
  requestDigest: grant.requestDigest,
  taskId: grant.taskId,
  proposalId: grant.proposalId,
  projectIdentityDigest: grant.projectIdentityDigest,
  canonicalRootDigest: grant.canonicalRootDigest,
  approvedSnapshotDigest: grant.approvedSnapshotDigest,
  approvedManifestDigest: grant.approvedManifestDigest,
  verificationPlanDigest: grant.verificationPlanDigest,
  operationDigest: grant.operationDigest,
  policyRevision: grant.policyRevision,
  configRevision: grant.configRevision,
  runId: grant.runId,
  issuerId: grant.issuerId,
};

const structurallyValid = contract.validateExecutionGrantStructure(grant, expected);
assert.equal(structurallyValid.state, 'NOT_ESTABLISHED');
assert.equal(structurallyValid.reasonCode, 'SUPERVISOR_ISSUER_NOT_ESTABLISHED');
assert.equal(
  contract.validateExecutionGrantStructure(grant, {
    ...expected,
    approvalConsumed: false,
  }).reasonCode,
  'GRANT_PRECONDITIONS_NOT_MET',
);
assert.equal(
  contract.validateExecutionGrantStructure(grant, {
    ...expected,
    snapshotValidated: false,
  }).reasonCode,
  'GRANT_PRECONDITIONS_NOT_MET',
);
assert.notEqual(structurallyValid.state, 'EXECUTION_AUTHORIZED');

let supervisorCalls = 0;
const syntheticSupervisorShape = Object.fromEntries(
  providerContract.TRUSTED_SUPERVISOR_OPERATIONS.map((operation) => [
    operation,
    () => { supervisorCalls += 1; },
  ]),
);
assert.doesNotThrow(() => providerContract.assertTrustedSupervisorInterface(syntheticSupervisorShape));
assert.equal(supervisorCalls, 0, 'Shape validation must not invoke supervisor operations.');
assert.throws(
  () => providerContract.assertTrustedSupervisorInterface({}),
  /missing required operation: issueExecutionGrant/,
);

for (const field of contract.EXECUTION_GRANT_BINDINGS) {
  const mismatch = { ...expected, [field]: field.endsWith('Digest') ? digest('9') : `different-${field}` };
  const result = contract.validateExecutionGrantStructure(grant, mismatch);
  assert.equal(result.state, 'BLOCKED', `${field} mismatch must block`);
  assert.equal(result.reasonCode, 'GRANT_BINDING_MISMATCH', `${field} mismatch reason`);
}

assert.equal(
  contract.validateExecutionGrantStructure(grant, { ...expected, projectIdentityDigest: undefined }).reasonCode,
  'GRANT_BINDING_CONTEXT_MISSING',
);
assert.equal(
  contract.validateExecutionGrantStructure({ ...grant, consumedAt: new Date().toISOString() }, expected).reasonCode,
  'GRANT_ALREADY_CONSUMED',
);
assert.equal(
  contract.validateExecutionGrantStructure({
    ...grant,
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now - 1).toISOString(),
  }, expected).reasonCode,
  'GRANT_EXPIRED',
);
assert.equal(
  contract.validateExecutionGrantStructure({ ...grant, singleUse: false }, expected).reasonCode,
  'GRANT_NOT_SINGLE_USE',
);
assert.equal(
  contract.validateExecutionGrantStructure({ ...grant, runId: grant.taskId }, expected).reasonCode,
  'GRANT_IDENTIFIER_NOT_UNIQUE',
);

const replayedForDifferentRun = contract.validateExecutionGrantStructure(
  grant,
  { ...expected, runId: uuid('6') },
);
assert.equal(replayedForDifferentRun.state, 'BLOCKED');
assert.equal(replayedForDifferentRun.reasonCode, 'GRANT_BINDING_MISMATCH');
const repeatedStructuralCheck = contract.validateExecutionGrantStructure(grant, expected);
assert.equal(repeatedStructuralCheck.state, 'NOT_ESTABLISHED');
assert.equal(repeatedStructuralCheck.reasonCode, 'SUPERVISOR_ISSUER_NOT_ESTABLISHED');
assert.notEqual(repeatedStructuralCheck.state, 'EXECUTION_AUTHORIZED');

for (const forged of [
  { ...grant, hostEvidence: { workerIdentity: 'caller-controlled' } },
  { ...grant, guestCleanupReport: { cleanupVerified: true } },
  { ...grant, rendererApproved: true },
]) {
  assert.equal(contract.validateExecutionGrantStructure(forged, expected).reasonCode, 'GRANT_FIELDS_UNSUPPORTED');
}

assert.equal(
  contract.validateExecutionGrantStructure(grant, { ...expected, issuerId: 'untrusted-renderer' }).reasonCode,
  'GRANT_BINDING_MISMATCH',
);
assert.throws(
  () => isolation.requireProjectProcessIsolation(
    'Structural execution-grant contract test',
    grant,
    expected,
    Object.fromEntries([
      'identityIsolation',
      'credentialIsolation',
      'egressControl',
      'resourceLimits',
      'runtimeCap',
      'outputCap',
      'cancellation',
      'cleanupEvidence',
    ].map((name) => [name, true]).concat([
      ['independentlyVerified', true],
      ['humanApproved', true],
      ['syntheticValidationPassed', true],
      ['executionAuthorized', true],
    ])),
  ),
  (error) => error.code === 'PROJECT_EXECUTION_BLOCKED',
);
assert.equal(isolation.projectProcessIsolationStatus().available, false);
assert.notEqual(structurallyValid.state, 'EXECUTION_AUTHORIZED');
assert.equal(supervisorCalls, 0, 'Synthetic interface methods are never treated as runtime evidence.');

console.log('Synthetic execution-grant and supervisor-shape contracts passed; no issuer or live authorization was exercised.');
