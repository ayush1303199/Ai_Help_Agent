import assert from 'node:assert/strict';
import sandboxRunner from '../electron/coding-pipeline/windowsSandboxRunner.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import evidenceContract from '../electron/coding-pipeline/executionEvidenceContract.cjs';

const { parseSandboxCleanupOutcome } = sandboxRunner;
const runId = 'synthetic-run-9e418e';
const validOutcome = {
  version: 1,
  runId,
  complete: true,
  accountCleanup: 'succeeded',
  shutdownCommand: 'succeeded',
};

assert.deepEqual(parseSandboxCleanupOutcome(JSON.stringify(validOutcome), runId), validOutcome);
assert.deepEqual(parseSandboxCleanupOutcome(JSON.stringify({
  ...validOutcome,
  accountCleanup: 'failed',
  shutdownCommand: 'failed',
}), runId), {
  ...validOutcome,
  accountCleanup: 'failed',
  shutdownCommand: 'failed',
});

for (const key of Object.keys(validOutcome)) {
  const missingProperty = { ...validOutcome };
  delete missingProperty[key];
  assert.equal(parseSandboxCleanupOutcome(JSON.stringify(missingProperty), runId), null, `missing ${key}`);
}
assert.equal(parseSandboxCleanupOutcome(JSON.stringify({ ...validOutcome, extra: true }), runId), null);
assert.equal(parseSandboxCleanupOutcome(JSON.stringify(validOutcome), 'different-run'), null);
assert.equal(parseSandboxCleanupOutcome('null', runId), null);
assert.equal(parseSandboxCleanupOutcome('[]', runId), null);

for (const [key, value] of [
  ['version', 1.5],
  ['version', '1'],
  ['version', true],
  ['complete', false],
  ['complete', 'true'],
  ['accountCleanup', 'unknown'],
  ['accountCleanup', 'pending'],
  ['accountCleanup', 0],
  ['shutdownCommand', 'unknown'],
  ['shutdownCommand', 'pending'],
  ['shutdownCommand', null],
]) {
  assert.equal(
    parseSandboxCleanupOutcome(JSON.stringify({ ...validOutcome, [key]: value }), runId),
    null,
    `invalid ${key}=${String(value)}`,
  );
}

assert.throws(() => parseSandboxCleanupOutcome('{malformed', runId), SyntaxError);
assert.equal(parseSandboxCleanupOutcome(JSON.stringify({ ...validOutcome, complete: false }), runId), null);

const projectResult = {
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  stderr: '',
  runId,
  executionResultAuthenticated: false,
  hostLifecycleObservation: null,
  cleanupOutcome: {
    ...validOutcome,
    accountCleanup: 'failed',
    shutdownCommand: 'failed',
  },
};
const evaluatedResult = developerFiles.applyWindowsCleanupOutcome(projectResult);
assert.equal(evaluatedResult.ok, false);
assert.equal(evaluatedResult.exitCode, 0);
assert.deepEqual(evaluatedResult.cleanupOutcome, projectResult.cleanupOutcome);
assert.equal(projectResult.exitCode, 0);
assert.match(evaluatedResult.cleanupError, /Guest account cleanup failed/);
assert.match(evaluatedResult.cleanupError, /Guest shutdown command failed/);
assert.equal(evaluatedResult.stderr, evaluatedResult.cleanupError);

const invalidCleanupResult = developerFiles.applyWindowsCleanupOutcome({
  ...projectResult,
  cleanupOutcome: {
    ...validOutcome,
    accountCleanup: 'unknown',
  },
});
assert.equal(invalidCleanupResult.ok, false);
assert.match(invalidCleanupResult.cleanupError, /account cleanup outcome is unknown or invalid/i);

const guestClaimsOnly = developerFiles.applyWindowsCleanupOutcome({
  runId,
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  stderr: '',
  executionResultAuthenticated: true,
  cleanupOutcome: validOutcome,
});
assert.equal(guestClaimsOnly.ok, false);
assert.match(guestClaimsOnly.cleanupError, /Host-observed Windows Sandbox termination/i);
assert.match(guestClaimsOnly.cleanupError, /guest result channel is writable by the guest/i);

const hostCleanupButNoAuthenticatedResult = developerFiles.applyWindowsCleanupOutcome({
  runId,
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  stderr: '',
  executionResultAuthenticated: true,
  hostLifecycleObservation: {
    runId,
    launcherTerminated: true,
    sandboxClientsRemaining: 0,
    stagingDirectoryRemoved: true,
    cleanupVerified: true,
    resourceDeleted: true,
  },
  cleanupOutcome: validOutcome,
});
assert.equal(hostCleanupButNoAuthenticatedResult.ok, false);
assert.match(hostCleanupButNoAuthenticatedResult.cleanupError, /guest result channel is writable by the guest/i);

const guestOnlyEnvelope = evidenceContract.createResultEnvelope({
  untrustedWorkerClaims: [JSON.stringify(validOutcome)],
  providerObservedState: {
    hostLifecycleObservation: {
      runId,
      launcherTerminated: true,
      sandboxClientsRemaining: 0,
      stagingDirectoryRemoved: true,
    },
  },
});
const guestOnlyDecision = evidenceContract.evaluateResultEnvelope(guestOnlyEnvelope);
assert.equal(guestOnlyDecision.state, 'UNCERTAIN');
assert.equal(guestOnlyDecision.reasonCode, 'UNTRUSTED_WORKER_OUTPUT');

console.log('Windows Sandbox cleanup report schema checks passed.');
