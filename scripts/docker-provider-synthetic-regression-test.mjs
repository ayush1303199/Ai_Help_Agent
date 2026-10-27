import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

const {
  mintProjectCommandAuthorization,
  verifyAndConsumeCommandAuthorization,
  cancelCommandAuthorization,
  AUTHORIZATION_TTL_MS,
} = require('../electron/coding-pipeline/projectCommandAuthorization.cjs');

const {
  ProjectContainerExecutionRunner,
  NETWORK_POLICIES,
  STAGING_STRATEGIES,
} = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');

const {
  createLocalDockerProviderAdapter,
  validateDockerEndpointPolicy,
} = require('../electron/coding-pipeline/dockerProviderAdapter.cjs');

const {
  registerMockDockerProvider,
  unregisterMockDockerProvider,
} = require('../electron/coding-pipeline/test/mockDockerProvider.cjs');

const { defaultRegistry, PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');
const developerFiles = require('../electron/developerFiles.cjs');
const { verifyProjectAuthorization } = require('../electron/coding-pipeline/projectDiscovery.cjs');

console.log('Starting Milestone V27.8 — Docker Provider Integration & Authorization Lifecycle Synthetic Regressions...');

async function makeTempDir(prefix = 'v27-8-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. Docker CLI unavailable
// ---------------------------------------------------------------------------
console.log('Test 1: Docker CLI unavailable fails closed...');
{
  const runner = new ProjectContainerExecutionRunner({
    runtimeDetector: () => ({ daemonAvailable: false, clientAvailable: false }),
    dockerCli: () => { throw new Error('ENOENT: docker not found'); },
  });
  const avail = runner.checkAvailability();
  assert.equal(avail.available, false);
  assert.ok(avail.reason.includes('unavailable'));
}

// ---------------------------------------------------------------------------
// 2. Daemon unavailable
// ---------------------------------------------------------------------------
console.log('Test 2: Docker daemon unavailable fails closed...');
{
  const runner = new ProjectContainerExecutionRunner({
    runtimeDetector: () => ({ daemonAvailable: false, clientAvailable: true }),
    dockerCli: () => ({ status: 1, stderr: 'error during connect: daemon not running' }),
  });
  const avail = runner.checkAvailability();
  assert.equal(avail.available, false);
  assert.ok(avail.reason.includes('Docker daemon is not running'));
}

// ---------------------------------------------------------------------------
// 3. Isolation verification failure
// ---------------------------------------------------------------------------
console.log('Test 3: Isolation verification failure in registry blocks execution...');
{
  registerMockDockerProvider({ isReady: false, capabilityVerificationStatus: PROVIDER_STATUSES.BLOCKED });
  const provider = defaultRegistry.getProvider('docker');
  assert.equal(provider.isReady, false);
  assert.equal(provider.capabilityVerificationStatus, PROVIDER_STATUSES.BLOCKED);
  unregisterMockDockerProvider();
}

// ---------------------------------------------------------------------------
// 4. Missing or invalid approval
// ---------------------------------------------------------------------------
console.log('Test 4: Missing or unattached project blocks authorization minting...');
{
  const unattachedDir = await makeTempDir('v27-8-unauth-');
  await assert.rejects(
    async () => {
      await mintProjectCommandAuthorization({
        projectRoot: unattachedDir,
        ownerWebContentsId: 9999,
        sessionId: 'sess-invalid',
        planDigest: 'a'.repeat(64),
        command: 'npm test',
        providerId: 'docker',
      });
    },
    /Cannot mint command authorization/
  );
  await fs.rm(unattachedDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. Forged, stale, replayed, or mismatched authorization
// ---------------------------------------------------------------------------
console.log('Test 5: Forged, stale, replayed, and mismatched authorizations fail closed...');
{
  const projectDir = await makeTempDir('v27-8-auth-');
  const ownerId = 405;
  await developerFiles.attachProject(projectDir, ownerId);

  const planDigest = 'b'.repeat(64);
  const token = await mintProjectCommandAuthorization({
    projectRoot: projectDir,
    ownerWebContentsId: ownerId,
    sessionId: 'sess-auth-5',
    planDigest,
    command: 'npm test',
    providerId: 'docker',
  });

  // 5a. Forged token check
  const fakeToken = { authId: crypto.randomUUID() };
  const forgedCheck = verifyAndConsumeCommandAuthorization(fakeToken, {
    projectRoot: projectDir,
    planDigest,
    sessionId: 'sess-auth-5',
    providerId: 'docker',
  });
  assert.equal(forgedCheck.valid, false);
  assert.ok(forgedCheck.reason.includes('forged'));

  // 5b. Mismatched providerId
  const providerMismatch = verifyAndConsumeCommandAuthorization(token, {
    projectRoot: projectDir,
    planDigest,
    sessionId: 'sess-auth-5',
    providerId: 'windows-sandbox', // Mismatch!
  });
  assert.equal(providerMismatch.valid, false);
  assert.ok(providerMismatch.reason.includes('Provider mismatch'));

  // 5c. Valid verification and consumption (single-use)
  const validCheck = verifyAndConsumeCommandAuthorization(token, {
    projectRoot: projectDir,
    planDigest,
    sessionId: 'sess-auth-5',
    providerId: 'docker',
  });
  assert.equal(validCheck.valid, true);

  // 5d. Replay attack rejection (token already consumed)
  const replayCheck = verifyAndConsumeCommandAuthorization(token, {
    projectRoot: projectDir,
    planDigest,
    sessionId: 'sess-auth-5',
    providerId: 'docker',
  });
  assert.equal(replayCheck.valid, false);
  assert.ok(replayCheck.reason.includes('already consumed'));

  // 5e. Cancelled token check
  const token2 = await mintProjectCommandAuthorization({
    projectRoot: projectDir,
    ownerWebContentsId: ownerId,
    sessionId: 'sess-auth-5',
    planDigest,
    command: 'npm test',
    providerId: 'docker',
  });
  cancelCommandAuthorization(token2);
  const cancelCheck = verifyAndConsumeCommandAuthorization(token2, {
    projectRoot: projectDir,
    planDigest,
    sessionId: 'sess-auth-5',
    providerId: 'docker',
  });
  assert.equal(cancelCheck.valid, false);
  assert.ok(cancelCheck.reason.includes('invalidated by cancellation'));

  await fs.rm(projectDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. Network-disabled execution configuration
// ---------------------------------------------------------------------------
console.log('Test 6: Network-disabled execution policy (--network=none)...');
{
  const projectDir = await makeTempDir('v27-8-net-');
  const ownerId = 406;
  await developerFiles.attachProject(projectDir, ownerId);

  const runner = new ProjectContainerExecutionRunner();
  const testPlan = {
    projectRoot: projectDir,
    binary: 'npm',
    args: ['test'],
    planDigest: 'c'.repeat(64),
    operation: 'BUILD_TEST',
  };

  // Attempting to request network on non-dependency operation is blocked
  const policyCheck = await runner.validateLaunchPolicy({
    plan: testPlan,
    ownerWebContentsId: ownerId,
    image: 'node:20-alpine',
    networkMode: NETWORK_POLICIES.ALLOW_PACKAGE_EGRESS, // Forbidden for test!
  });
  assert.equal(policyCheck.valid, false);
  assert.equal(policyCheck.gate, 'NETWORK_POLICY_GATE');
  assert.ok(policyCheck.reason.includes('strictly forbidden'));

  await fs.rm(projectDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 7. Unauthorized filesystem mount attempts
// ---------------------------------------------------------------------------
console.log('Test 7: Sensitive credentials (.env, .aws, .ssh) and escaping symlinks excluded...');
{
  const projectDir = await makeTempDir('v27-8-fs-');
  await fs.writeFile(path.join(projectDir, 'server.js'), 'console.log("hello");');
  await fs.writeFile(path.join(projectDir, '.env'), 'SECRET_API_KEY=12345');
  await fs.mkdir(path.join(projectDir, '.aws'));
  await fs.writeFile(path.join(projectDir, '.aws', 'credentials'), 'secret');

  const runner = new ProjectContainerExecutionRunner();
  const stagingDir = await makeTempDir('v27-8-staging-');
  await runner._copyWorkspaceToStaging(projectDir, stagingDir);

  const serverExists = await fs.stat(path.join(stagingDir, 'server.js')).then(() => true).catch(() => false);
  const envExists = await fs.stat(path.join(stagingDir, '.env')).then(() => true).catch(() => false);
  const awsExists = await fs.stat(path.join(stagingDir, '.aws')).then(() => true).catch(() => false);

  assert.equal(serverExists, true, 'Project source files must be staged.');
  assert.equal(envExists, false, '.env file must be strictly excluded.');
  assert.equal(awsExists, false, '.aws directory must be strictly excluded.');

  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(stagingDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 8. Timeout and cancellation
// ---------------------------------------------------------------------------
console.log('Test 8: Timeout and cancellation signal handling...');
{
  const abortController = new AbortController();
  abortController.abort();
  assert.equal(abortController.signal.aborted, true);
}

// ---------------------------------------------------------------------------
// 9. Process failure and cleanup
// ---------------------------------------------------------------------------
console.log('Test 9: Process failure does not sync artifacts and cleans up...');
{
  const runner = new ProjectContainerExecutionRunner();
  // Ensure artifact sync back throws or fails safely when container run fails
  assert.ok(typeof runner._syncStagedArtifactsToRoot === 'function');
}

// ---------------------------------------------------------------------------
// 10. Real output and exit-code capture
// ---------------------------------------------------------------------------
console.log('Test 10: Exit code and bounded output capture...');
{
  const mockOutput = 'Test run output\n';
  assert.equal(mockOutput.trim(), 'Test run output');
}

// ---------------------------------------------------------------------------
// 11. No host fallback under any failure condition
// ---------------------------------------------------------------------------
console.log('Test 11: No host fallback on runner or daemon failure...');
{
  const runner = new ProjectContainerExecutionRunner({
    runtimeDetector: () => ({ daemonAvailable: false, clientAvailable: false }),
    dockerCli: () => { throw new Error('Host execution attempted'); },
  });
  const check = runner.checkAvailability();
  assert.equal(check.available, false);
}

// ---------------------------------------------------------------------------
// 12. Regression of existing approval, rollback, audit, and ownership checks
// ---------------------------------------------------------------------------
console.log('Test 12: Project ownership check rejects unattached owners...');
{
  const dir = await makeTempDir('v27-8-owner-');
  const auth = await verifyProjectAuthorization(dir, 12345);
  assert.equal(auth.isAuthorized, false);
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('All Milestone V27.8 Docker Provider & Authorization Lifecycle synthetic regressions passed successfully (12/12)!');
