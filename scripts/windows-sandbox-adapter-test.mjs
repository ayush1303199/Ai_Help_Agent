import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import windowsSandboxProvider from '../electron/coding-pipeline/windowsSandboxProviderAdapter.cjs';
import projectIsolation from '../electron/coding-pipeline/projectProcessIsolation.cjs';
import providerAdapterContract from '../electron/coding-pipeline/providerAdapterContract.cjs';

const {
  DISABLED_REASON,
  buildWindowsSandboxConfiguration,
  createWindowsSandboxHostLifecycle,
  createWindowsSandboxProviderAdapter,
} = windowsSandboxProvider;

async function createFixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-adapter-test-'));
  const controlDirectory = path.join(temporaryRoot, 'control');
  const outputDirectory = path.join(temporaryRoot, 'output');
  await fs.mkdir(controlDirectory);
  await fs.mkdir(outputDirectory);
  await fs.writeFile(path.join(controlDirectory, 'synthetic-probe.txt'), 'synthetic\n', 'utf8');
  return { temporaryRoot, controlDirectory, outputDirectory };
}

const fixture = await createFixture();
try {
  const configuration = await buildWindowsSandboxConfiguration(fixture);
  assert.match(configuration, /<Networking>Disable<\/Networking>/);
  assert.match(configuration, /<MemoryInMB>1024<\/MemoryInMB>/);
  assert.match(configuration, /<VGpu>Disable<\/VGpu>/);
  assert.match(configuration, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);
  assert.match(configuration, /<PrinterRedirection>Disable<\/PrinterRedirection>/);
  assert.match(configuration, /<AudioInput>Disable<\/AudioInput>/);
  assert.match(configuration, /<VideoInput>Disable<\/VideoInput>/);
  assert.match(configuration, /<ProtectedClient>Enable<\/ProtectedClient>/);
  assert.match(configuration, /<ReadOnly>true<\/ReadOnly>/);
  assert.match(configuration, /<ReadOnly>false<\/ReadOnly>/);
  assert.equal((configuration.match(/<MappedFolder>/g) || []).length, 2);
  assert.ok(!configuration.includes(path.resolve(process.cwd())));
  await assert.rejects(
    buildWindowsSandboxConfiguration({ ...fixture, xml: '<Configuration />' }),
    /unsupported options.*xml/i,
  );
  await assert.rejects(
    buildWindowsSandboxConfiguration({ ...fixture, projectRoot: process.cwd() }),
    /unsupported options.*projectRoot/i,
  );
  await assert.rejects(
    buildWindowsSandboxConfiguration({ ...fixture, outputDirectory: path.join(fixture.temporaryRoot, '..', 'outside') }),
    /direct child/i,
  );
  await assert.rejects(
    buildWindowsSandboxConfiguration({ ...fixture, memoryInMB: 64 }),
    /memory must be an integer/i,
  );
} finally {
  await fs.rm(fixture.temporaryRoot, { recursive: true, force: true });
}

const adapter = createWindowsSandboxProviderAdapter();
assert.equal(adapter.getProviderId(), 'windows-sandbox');
assert.equal(adapter.getCapabilities().configured, false);
assert.equal(adapter.getCapabilities().runtimeAvailable, false);
assert.equal(adapter.getCapabilities().independentlyVerified, false);
assert.match(adapter.getCapabilities().disabledReason, /handle release/i);
assert.equal(adapter.getCapabilities().capabilityStates.osEnforcedProcessIsolation, 'BLOCKED');
for (const capability of providerAdapterContract.ISOLATION_CAPABILITIES.filter(
  (name) => name !== 'osEnforcedProcessIsolation',
)) {
  assert.equal(adapter.getCapabilities().capabilityStates[capability], 'NOT_ESTABLISHED');
}
assert.equal(adapter.prepareRunEvidence({ runId: 'test-run' }).evidenceState.state, 'BLOCKED');

const allSupportedClaims = Object.fromEntries(
  providerAdapterContract.ISOLATION_CAPABILITIES.map((name) => [name, 'SUPPORTED']),
);
const untrustedCapabilityAdapter = providerAdapterContract.createProviderAdapter({
  getProviderId: () => 'untrusted-capability-claims',
  getConfigRevision: () => 'fixture',
  getCapabilities: () => ({ capabilityStates: allSupportedClaims }),
});
assert.ok(Object.values(untrustedCapabilityAdapter.getCapabilities().capabilityStates)
  .every((state) => state === 'NOT_ESTABLISHED'));
assert.throws(
  () => providerAdapterContract.createCapabilityStateMap({ osEnforcedProcessIsolation: 'VERIFIED' }),
  /Invalid state/,
);

const forgedGuestResult = adapter.collectHostObservedResult({
  guestOutputs: ['guest says successful'],
  guestCleanupReports: [{ resourceDeleted: true, cleanupVerified: true }],
  guestFiles: [{ name: 'cleanup.json', resourceDeleted: true }],
});
assert.equal(forgedGuestResult.classification, 'BLOCKED');
assert.deepEqual(forgedGuestResult.envelope.appVerifiedFacts, {});
assert.deepEqual(forgedGuestResult.envelope.acceptedEvidence, {});
assert.equal(forgedGuestResult.envelope.untrustedWorkerClaims.length, 3);
assert.notEqual(forgedGuestResult.evaluation.state, 'EXECUTION_AUTHORIZED');
for (const claims of [
  {},
  { guestCleanupReports: [{ complete: false, resourceDeleted: true, cleanupVerified: false }] },
  { guestCleanupReports: [{ complete: true, resourceDeleted: false, cleanupVerified: true }] },
]) {
  const guestOnlyResult = adapter.collectHostObservedResult(claims);
  assert.deepEqual(guestOnlyResult.envelope.appVerifiedFacts, {});
  assert.deepEqual(guestOnlyResult.envelope.acceptedEvidence, {});
  assert.notEqual(guestOnlyResult.evaluation.state, 'EXECUTION_AUTHORIZED');
}

const safeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-lifecycle-test-'));
let removed = false;
let observedRunId;
const lifecycle = createWindowsSandboxHostLifecycle({
  createTemporaryRoot: async () => safeRoot,
  observeShutdown: async ({ process, runId }) => {
    observedRunId = runId;
    return {
      source: 'host-process-inspection',
      runId,
      launcherPid: process.pid,
      launcherTerminated: true,
      sandboxClientsRemaining: 0,
      ownedSandboxProcessCount: 0,
      sandboxResourceAbsent: true,
      sandboxHandlesReleased: true,
    };
  },
  removeTemporaryRoot: async (temporaryRoot) => {
    assert.equal(temporaryRoot, safeRoot);
    await fs.rm(temporaryRoot, { recursive: true, force: false });
    removed = true;
  },
  verifyTemporaryRootRemoved: async (temporaryRoot) => {
    try {
      await fs.lstat(temporaryRoot);
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  },
});
const resource = await lifecycle.createResource({ runId: 'host-observed-run' });
lifecycle.markLaunchStarting(resource);
lifecycle.markLauncherStarted(resource, { pid: 742 });
const cleanup = await lifecycle.cleanup(resource);
assert.equal(observedRunId, 'host-observed-run');
assert.equal(removed, true);
assert.equal(cleanup.launcherTerminated, true);
assert.equal(cleanup.sandboxClientsRemaining, 0);
assert.equal(cleanup.sandboxHandlesReleased, true);
assert.equal(cleanup.sandboxResourceDeleted, true);
assert.equal(cleanup.processTerminated, undefined);
assert.equal(cleanup.evidenceState, 'NOT_ESTABLISHED');
assert.equal(cleanup.stagingDirectoryDeleted, true);
assert.equal(cleanup.cleanupVerified, true);
assert.equal(cleanup.resourceDeleted, true);
assert.equal(cleanup.secureErasureProven, 'NOT_ESTABLISHED');

const uncertainRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-quarantine-test-'));
let uncertainRemovalAttempted = false;
const uncertainLifecycle = createWindowsSandboxHostLifecycle({
  createTemporaryRoot: async () => uncertainRoot,
  observeShutdown: async ({ process, runId }) => ({
    source: 'host-process-inspection',
    runId,
    launcherPid: process.pid,
    launcherTerminated: true,
    sandboxClientsRemaining: 0,
    ownedSandboxProcessCount: 0,
    sandboxResourceAbsent: true,
    sandboxHandlesReleased: false,
  }),
  removeTemporaryRoot: async () => {
    uncertainRemovalAttempted = true;
    await fs.rm(uncertainRoot, { recursive: true, force: false });
  },
  verifyTemporaryRootRemoved: async () => true,
});
const uncertainResource = await uncertainLifecycle.createResource({ runId: 'uncertain-run' });
uncertainLifecycle.markLaunchStarting(uncertainResource);
uncertainLifecycle.markLauncherStarted(uncertainResource, { pid: 743 });
await assert.rejects(uncertainLifecycle.cleanup(uncertainResource), /handle release/i);
assert.equal(uncertainRemovalAttempted, false);
assert.equal(uncertainLifecycle.getStatus(uncertainResource).quarantined, true);
assert.equal(uncertainLifecycle.getStatus(uncertainResource).leaseActive, true);
assert.equal(uncertainLifecycle.getStatus(uncertainResource).secureErasureProven, 'NOT_ESTABLISHED');
await assert.rejects(uncertainLifecycle.createResource({ runId: 'blocked-next-run' }), /still active or quarantined/i);
await fs.rm(uncertainRoot, { recursive: true, force: true });

const ownershipRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-ownership-test-'));
let ownershipRemovalAttempted = false;
const ownershipLifecycle = createWindowsSandboxHostLifecycle({
  createTemporaryRoot: async () => ownershipRoot,
  observeShutdown: async ({ runId }) => ({
    source: 'host-process-inspection',
    runId,
    launcherPid: 999_999,
    launcherTerminated: true,
    sandboxClientsRemaining: 0,
    ownedSandboxProcessCount: 0,
    sandboxResourceAbsent: true,
    sandboxHandlesReleased: true,
  }),
  removeTemporaryRoot: async () => {
    ownershipRemovalAttempted = true;
    await fs.rm(ownershipRoot, { recursive: true, force: false });
  },
  verifyTemporaryRootRemoved: async () => true,
});
const ownershipResource = await ownershipLifecycle.createResource({ runId: 'ownership-run' });
ownershipLifecycle.markLaunchStarting(ownershipResource);
ownershipLifecycle.markLauncherStarted(ownershipResource, { pid: 745 });
await assert.rejects(ownershipLifecycle.cleanup(ownershipResource), /handle release/i);
assert.equal(ownershipRemovalAttempted, false);
assert.equal(ownershipLifecycle.getStatus(ownershipResource).quarantined, true);
await fs.rm(ownershipRoot, { recursive: true, force: true });

const missingObserverRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-missing-observer-'));
const missingObserverLifecycle = createWindowsSandboxHostLifecycle({
  createTemporaryRoot: async () => missingObserverRoot,
});
const missingObserverResource = await missingObserverLifecycle.createResource({ runId: 'no-host-api' });
missingObserverLifecycle.markLaunchStarting(missingObserverResource);
missingObserverLifecycle.markLauncherStarted(missingObserverResource, { pid: 744 });
await assert.rejects(missingObserverLifecycle.cleanup(missingObserverResource), /disabled until per-instance/i);
assert.equal(missingObserverLifecycle.getStatus(missingObserverResource).quarantined, true);
await fs.rm(missingObserverRoot, { recursive: true, force: true });

assert.throws(
  () => projectIsolation.requireProjectProcessIsolation('Windows Sandbox adapter test'),
  /was not started/i,
);
assert.equal(projectIsolation.projectProcessIsolationStatus('win32').available, false);
assert.equal(projectIsolation.projectProcessIsolationStatus('win32').capabilityStates.osEnforcedProcessIsolation, 'BLOCKED');
for (const platform of ['darwin', 'linux']) {
  const status = projectIsolation.projectProcessIsolationStatus(platform);
  assert.equal(status.available, false);
  assert.equal(status.verified, false);
  assert.ok(Object.values(status.capabilityStates).every((state) => state === 'UNSUPPORTED'));
}
assert.ok(DISABLED_REASON.includes('independently verified'));

console.log('Windows Sandbox adapter contract and fail-closed lifecycle checks passed.');
