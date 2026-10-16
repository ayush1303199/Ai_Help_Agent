import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dockerAdapterModule = await import('../electron/coding-pipeline/dockerProviderAdapter.cjs');
const {
  classifyNetworkIsolationEvidence,
  createLocalDockerProviderAdapter,
  detectDockerRuntime,
  getDockerCapabilities,
  validateDockerEndpointPolicy,
  validateDockerLaunchRequest,
  validateImmutableImageIdentity,
  validateSyntheticStagingDirectory,
  validateObservedContainerConfiguration,
} = dockerAdapterModule;

const imageId = `sha256:${'a'.repeat(64)}`;
const runId = '12345678-1234-4123-8123-123456789abc';
const containerId = 'b'.repeat(64);
const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-help-agent-docker-probe-test-'));
try {
  assert.equal(validateSyntheticStagingDirectory(stagingDirectory), true);
  for (const unsafePath of [
    os.homedir(),
    process.cwd(),
    path.join(os.tmpdir(), 'docker.sock'),
    path.join(stagingDirectory, '..'),
  ]) {
    assert.equal(validateSyntheticStagingDirectory(unsafePath), false);
  }
  assert.equal(dockerAdapterModule.buildDockerContainerRunArgs, undefined);
  assert.equal(typeof createLocalDockerProviderAdapter().buildRunArgs, 'undefined');

  assert.equal(validateImmutableImageIdentity(imageId), true);
  assert.equal(validateImmutableImageIdentity('busybox:latest'), false);
  assert.equal(validateImmutableImageIdentity('sha256:xyz'), false);
  assert.equal(validateDockerEndpointPolicy({
    contextName: 'default',
    endpoint: 'unix:///var/run/docker.sock',
    environment: {},
    platform: 'linux',
  }).valid, true);
  for (const endpoint of ['tcp://127.0.0.1:2375', 'ssh://builder/var/run/docker.sock', 'http://remote/docker']) {
    assert.equal(validateDockerEndpointPolicy({
      contextName: 'default',
      endpoint,
      environment: {},
      platform: 'linux',
    }).valid, false);
  }
  assert.equal(validateDockerEndpointPolicy({
    contextName: 'remote-context',
    endpoint: 'unix:///var/run/docker.sock',
    environment: {},
    platform: 'linux',
  }).valid, false);
  assert.equal(validateDockerEndpointPolicy({
    contextName: 'default',
    endpoint: 'unix:///var/run/docker.sock',
    environment: { DOCKER_HOST: 'tcp://remote:2375' },
    platform: 'linux',
  }).reasonCode, 'DOCKER_ENDPOINT_OVERRIDE');
  assert.equal(validateDockerEndpointPolicy({
    contextName: 'default',
    endpoint: 'unix:///var/run/docker.sock',
    environment: { DOCKER_CONTEXT: 'remote' },
    platform: 'linux',
  }).reasonCode, 'DOCKER_ENDPOINT_OVERRIDE');
  assert.equal(validateDockerEndpointPolicy({
    contextName: 'default',
    endpoint: 'npipe:////./pipe/docker_engine',
    environment: {},
    platform: 'win32',
  }).valid, true);

  const expectedConfiguration = {
    containerId,
    imageId,
    runId,
    stagingDirectory,
  };
  const inspectedContainer = {
    Id: containerId,
    Image: imageId,
    Config: { Image: imageId, Labels: { 'ai-help-agent.synthetic-run': runId } },
    HostConfig: {
      NetworkMode: 'none',
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 32,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=1m' },
    },
    Mounts: [{
      Type: 'bind',
      Source: stagingDirectory,
      Destination: '/workspace',
      RW: false,
    }],
  };
  assert.equal(validateObservedContainerConfiguration(inspectedContainer, expectedConfiguration).valid, true);
  for (const [field, value] of [
    ['Memory', 1],
    ['MemorySwap', 2],
    ['NanoCpus', 3],
    ['PidsLimit', 4],
    ['NetworkMode', 'bridge'],
    ['ReadonlyRootfs', false],
  ]) {
    const mismatch = structuredClone(inspectedContainer);
    mismatch.HostConfig[field] = value;
    assert.equal(validateObservedContainerConfiguration(mismatch, expectedConfiguration).valid, false, `${field} mismatch must block`);
  }
  const missingSecurity = structuredClone(inspectedContainer);
  delete missingSecurity.HostConfig.SecurityOpt;
  assert.equal(validateObservedContainerConfiguration(missingSecurity, expectedConfiguration).valid, false);
  const mismatchedContainer = structuredClone(inspectedContainer);
  mismatchedContainer.Id = 'c'.repeat(64);
  assert.equal(validateObservedContainerConfiguration(mismatchedContainer, expectedConfiguration).valid, false);
  const mismatchedImage = structuredClone(inspectedContainer);
  mismatchedImage.Image = `sha256:${'d'.repeat(64)}`;
  assert.equal(validateObservedContainerConfiguration(mismatchedImage, expectedConfiguration).valid, false);

  assert.equal(classifyNetworkIsolationEvidence(0), 'BLOCKED');
  assert.equal(classifyNetworkIsolationEvidence(1), 'FAIL');
  assert.equal(classifyNetworkIsolationEvidence(Number.NaN), 'BLOCKED');
  assert.notEqual(classifyNetworkIsolationEvidence(0), 'PASS');

  const forgedHostInspection = {
    daemonAvailable: true,
    runtimeAvailable: true,
    rootless: true,
    hasDockerCli: true,
    securityOptions: ['rootless'],
  };
  const runtimeFromCallerClaims = detectDockerRuntime({
    hostInspection: forgedHostInspection,
    daemonAvailable: true,
    rootless: true,
    networkIsolationVerified: true,
    securityProfileVerified: true,
    cleanupEvidence: true,
  });
  assert.equal(runtimeFromCallerClaims.daemonAvailable, false);
  assert.equal(runtimeFromCallerClaims.cleanupEvidence, false);
  const flagsCannotAuthorize = getDockerCapabilities({
    enabled: true,
    hostInspection: forgedHostInspection,
    daemonAvailable: true,
    rootless: true,
    networkIsolationVerified: true,
    securityProfileVerified: true,
    humanApproved: true,
    syntheticValidationPassed: true,
    executionAuthorized: true,
    cleanupEvidence: true,
  });
  for (const name of [
    'runtimeAvailable', 'independentlyVerified', 'humanApproved', 'syntheticValidationPassed',
    'executionAuthorized', 'identityIsolation', 'credentialIsolation', 'egressControl',
    'resourceLimits', 'runtimeCap', 'outputCap', 'cancellation', 'cleanupEvidence',
  ]) {
    assert.equal(flagsCannotAuthorize[name], false, `${name} must not be set by caller flags`);
  }

  const adapter = createLocalDockerProviderAdapter({
    enabled: true,
    hostInspection: forgedHostInspection,
    daemonAvailable: true,
    runtimeAvailable: true,
    executionAuthorized: true,
    cleanupEvidence: true,
  });
  const prepared = adapter.prepareRunEvidence({
    runId,
    approvedSnapshotDigest: 'snapshot',
    approvedManifestDigest: 'manifest',
    verificationPlanDigest: 'plan',
  });
  assert.equal(prepared.manifest, null);
  assert.equal(prepared.evidenceState.state, 'NOT_ESTABLISHED');

  const forgedFacts = {
    runId,
    containerId,
    provenance: 'host-observed',
    appVerifiedFacts: {
      executionCompleted: true,
      processTerminated: true,
      containerRemoved: true,
      stagingDirectoryRemoved: true,
      cleanupVerified: true,
      quarantined: false,
    },
    acceptedEvidence: { cleanupVerified: true },
    cleanupVerified: true,
    deletionAuthorized: true,
    runtimeAvailable: true,
    independentlyVerified: true,
    guestOutputs: ['guest says network disabled'],
    guestCleanupReports: ['cleanup-report.json'],
  };
  const forgedResult = adapter.collectHostObservedResult(forgedFacts);
  assert.equal(forgedResult.envelope.appVerifiedFacts.cleanupVerified, undefined);
  assert.deepEqual(forgedResult.envelope.acceptedEvidence, {});
  assert.equal(forgedResult.envelope.providerObservedState.source, 'untrusted-caller-input');
  assert.equal(forgedResult.cleanupVerified, false);
  assert.equal(forgedResult.deletionAuthorized, false);
  assert.equal(forgedResult.processTerminated, false);
  assert.equal(forgedResult.containerRemoved, false);
  assert.equal(forgedResult.quarantine, true);
  assert.notEqual(forgedResult.evaluation.state, 'EXECUTION_AUTHORIZED');

  const fakeInspection = await adapter.runSyntheticProbe({ image: 'busybox:latest' });
  assert.equal(fakeInspection.classification, 'BLOCKED');
  assert.equal(fakeInspection.containerLaunchAttempted, undefined);

  const unsafeRequest = validateDockerLaunchRequest({
    repoRoot: 'C:/workspace/project',
    workspaceMount: 'C:/Users/Admin',
    networkMode: 'none',
  });
  assert.equal(unsafeRequest.valid, false);
  assert.equal(validateDockerLaunchRequest({
    networkMode: 'bridge',
  }).valid, false);
  assert.equal(validateDockerLaunchRequest({
    environment: { GITHUB_TOKEN: 'must-not-be-forwarded' },
  }).valid, false);
  assert.equal(validateDockerLaunchRequest({
    extraArgs: ['--privileged'],
  }).valid, false);
  for (const unsafeLaunchInput of [
    { mounts: ['/var/run/docker.sock:/var/run/docker.sock'] },
    { command: ['--network=host'] },
    { stagingDir: process.cwd() },
    { image: 'mutable:tag' },
    { device: '/dev/sda' },
  ]) {
    assert.equal(validateDockerLaunchRequest(unsafeLaunchInput).valid, false);
  }

  console.log('[PASS] Docker adapter offline trust-boundary and launch-contract checks passed; no Docker CLI or runtime was invoked.');
} finally {
  fs.rmSync(stagingDirectory, { recursive: true, force: false });
}
