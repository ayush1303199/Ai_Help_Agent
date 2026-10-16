import assert from 'node:assert/strict';

const os = await import('node:os');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const net = await import('node:net');
const developerFiles = (await import('../electron/developerFiles.cjs')).default;
const developerContext = (await import('../electron/developerContext.cjs')).default;
const { DevServerManager } = await import('../electron/coding-pipeline/environment.cjs');
const {
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
} = await import('../electron/coding-pipeline/projectProcessIsolation.cjs');
const sandboxRunner = await import('../electron/coding-pipeline/windowsSandboxRunner.cjs');
const {
  assertSandboxProbe,
  isValidSandboxGuestResult,
  runWindowsSandboxCommand,
  requestSandboxLauncherTermination,
  waitForSandboxResult,
  waitForSandboxShutdown,
} = sandboxRunner;
const {
  canDeleteSandboxTemporaryRoot,
  createSandboxResourceLifecycle,
  transitionSandboxResourceState,
} = await import('../electron/coding-pipeline/sandboxResourceLifecycle.cjs');
assert.equal('probeWindowsSandbox' in sandboxRunner.default, false);
assert.equal('cleanupSandboxResources' in sandboxRunner.default, false);
const windowsSandboxRunnerSource = await fs.readFile(
  new URL('../electron/coding-pipeline/windowsSandboxRunner.cjs', import.meta.url),
  'utf8',
);
const projectProcessIsolationSource = await fs.readFile(
  new URL('../electron/coding-pipeline/projectProcessIsolation.cjs', import.meta.url),
  'utf8',
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-project-isolation-'));
const projectA = path.join(tempRoot, 'project-a');
const projectB = path.join(tempRoot, 'project-b');
await fs.mkdir(projectA, { recursive: true });
await fs.mkdir(projectB, { recursive: true });
await fs.writeFile(path.join(projectA, 'alpha.txt'), 'A');
await fs.writeFile(path.join(projectB, 'beta.txt'), 'B');

await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectA] }) }, 'owner-a');
await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectB] }) }, 'owner-b');
assert.equal(developerFiles.getProjectRoot('owner-a'), projectA);
assert.equal(developerFiles.getProjectRoot('owner-b'), projectB);
assert.equal(developerFiles.getProjectRoot(), null);
assert.equal((await developerFiles.readFile('alpha.txt', 'owner-a')).content, 'A');
assert.equal((await developerFiles.readFile('beta.txt', 'owner-b')).content, 'B');
assert.throws(() => developerFiles.assertProjectOwner('owner-c'), /not owned/i);
assert.equal(developerFiles.normalizeScopedProjectPath(projectA, 'models', 'models'), 'models');
assert.equal(
  developerFiles.normalizeScopedProjectPath(projectA, 'models', 'models/AdmOuPrgList.php'),
  'models/AdmOuPrgList.php',
);
assert.equal(
  developerFiles.normalizeScopedProjectPath(projectA, 'models', 'AdmOuPrgList.php'),
  'models/AdmOuPrgList.php',
);
assert.equal(developerFiles.normalizeScopedProjectPath(projectA, '.', 'models/AdmOuPrgList.php'), 'models/AdmOuPrgList.php');
assert.throws(
  () => developerFiles.normalizeScopedProjectPath(projectA, 'models', '../outside.php'),
  /traversal|outside the selected scope/i,
);

developerFiles.releaseProject('owner-a');
assert.equal(developerFiles.getProjectRoot('owner-a'), null);
assert.throws(() => developerFiles.assertProjectOwner('owner-a'), /not owned/i);
await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectA] }) }, 'owner-a-reloaded');
assert.equal(developerFiles.getProjectRoot('owner-a-reloaded'), projectA);
assert.equal((await developerFiles.readFile('alpha.txt', 'owner-a-reloaded')).content, 'A');
assert.equal((await developerFiles.readFile('beta.txt', 'owner-b')).content, 'B');

const sharedResult = [{ path: 'src/login.ts', text: 'login timeout is read from config', matchType: 'content' }];
const contextA = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectA, maxTokens: 1200 });
const contextB = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectB, maxTokens: 1200 });
assert.notEqual(contextA.root, contextB.root);
assert.equal(contextA.items[0]?.path, sharedResult[0].path);
assert.equal(contextB.items[0]?.path, sharedResult[0].path);
assert.equal(contextA.cached, false);
assert.equal(contextB.cached, false);
developerContext.invalidateContextCache(projectA);
const contextARefreshed = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectA, maxTokens: 1200 });
assert.equal(contextARefreshed.cached, false);

const projectBContextBeforeClear = developerContext.assembleContext({ query: 'beta', results: [{ path: 'src/beta.ts', text: 'beta service timeout', matchType: 'content' }], root: projectB, maxTokens: 1200 });
developerContext.invalidateContextCache(projectB);
const projectBContextAfterClear = developerContext.assembleContext({ query: 'beta', results: [{ path: 'src/beta.ts', text: 'beta service timeout', matchType: 'content' }], root: projectB, maxTokens: 1200 });
assert.equal(projectBContextBeforeClear.cached, false);
assert.equal(projectBContextAfterClear.cached, false);

const portProbe = net.createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const devServerPort = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
const devProject = path.join(tempRoot, 'dev-project');
await fs.mkdir(devProject, { recursive: true });
await fs.mkdir(path.join(devProject, '.ssh'), { recursive: true });
await fs.writeFile(path.join(devProject, '.env'), 'API_TOKEN=fixture-only\n');
await fs.writeFile(path.join(devProject, '.npmrc'), '//registry.example/:_authToken=fixture-only\n');
await fs.writeFile(path.join(devProject, '.ssh', 'id_rsa'), 'fixture-only-private-key');
await fs.writeFile(
  path.join(devProject, 'package.json'),
  JSON.stringify({
    scripts: {
      dev: `node -e "require('fs').writeFileSync('dev-server-write.txt','isolated');require('http').createServer((_,response)=>response.end('ok')).listen(${devServerPort})" -- --port ${devServerPort}`,
    },
  }),
);
const copiedWorkspace = await developerFiles.createIsolatedWorkspaceCopy(devProject);
await assert.rejects(fs.access(path.join(copiedWorkspace.root, '.env')), { code: 'ENOENT' });
await assert.rejects(fs.access(path.join(copiedWorkspace.root, '.npmrc')), { code: 'ENOENT' });
await assert.rejects(fs.access(path.join(copiedWorkspace.root, '.ssh')), { code: 'ENOENT' });
await assert.ok(await fs.readFile(path.join(copiedWorkspace.root, 'package.json'), 'utf8'));
await copiedWorkspace.cleanup();
const devServerManager = new DevServerManager();
assert.equal(projectProcessIsolationStatus().available, false);
assert.equal(projectProcessIsolationStatus().verified, false);
const windowsIsolationStatus = projectProcessIsolationStatus('win32');
assert.equal(windowsIsolationStatus.available, false);
assert.equal(windowsIsolationStatus.verified, false);
assert.match(windowsIsolationStatus.reason, /disabled/i);
assert.match(
  projectProcessIsolationSource,
  /process\.platform === 'win32' \|\| !status\.available \|\| !status\.verified/,
);
assert.throws(
  () => requireProjectProcessIsolation('Project test'),
  /Project test was not started/,
);
assert.throws(
  () => requireProjectProcessIsolation('Windows project test'),
  /Windows project test was not started/,
);
await assert.rejects(
  runWindowsSandboxCommand({
    projectRoot: projectA,
    executable: 'npm.cmd',
    args: ['run', 'test'],
  }),
  /Windows Sandbox project command authorization is unavailable/,
);
const runnerEntry = windowsSandboxRunnerSource.indexOf('async function runWindowsSandboxCommand');
const runnerAuthorizationCheck = windowsSandboxRunnerSource.indexOf('projectCommandAuthorizations.has(authorization)', runnerEntry);
const runnerIsolationGate = windowsSandboxRunnerSource.indexOf("requireProjectProcessIsolation('Windows Sandbox project command')", runnerEntry);
const runnerResourceCreation = windowsSandboxRunnerSource.indexOf('sandboxResourceLifecycle.createResource(', runnerEntry);
const runnerStaging = windowsSandboxRunnerSource.indexOf('await fs.mkdir(controlRoot', runnerEntry);
const runnerSpawn = windowsSandboxRunnerSource.indexOf('spawn(SANDBOX_EXECUTABLE', runnerEntry);
assert.ok(runnerEntry >= 0 && runnerAuthorizationCheck > runnerEntry);
assert.ok(runnerAuthorizationCheck < runnerIsolationGate);
assert.ok(runnerIsolationGate < runnerResourceCreation);
assert.ok(runnerResourceCreation < runnerStaging);
assert.ok(runnerStaging < runnerSpawn);
assert.match(windowsSandboxRunnerSource, /sandboxResourceLifecycle\.cleanup\(resource\)/);
assert.match(windowsSandboxRunnerSource, /createTemporaryRoot: \(\) => fs\.mkdtemp/);
if (process.platform === 'win32') {
  await assert.rejects(
    developerFiles.runGit(['status', '--short'], 'owner-a-reloaded'),
    /Windows host-side Git inspection is unavailable pending verified isolation/,
  );
}
assert.match(windowsSandboxRunnerSource, /<Networking>Disable<\/Networking>/);
assert.match(windowsSandboxRunnerSource, /<ReadOnly>true<\/ReadOnly>/);
assert.match(windowsSandboxRunnerSource, /Windows Sandbox currently permits only validated npm verification scripts/);
assert.match(windowsSandboxRunnerSource, /CreateProcess|Diagnostics\.Process/);
assert.match(windowsSandboxRunnerSource, /executionResultAuthenticated: false/);
assert.doesNotMatch(windowsSandboxRunnerSource, /appVerifiedFacts:\s*\{[\s\S]*?hostObservedProbeOutcome/);
assert.match(windowsSandboxRunnerSource, /guest-shutdown-start/);
assert.match(windowsSandboxRunnerSource, /guest-shutdown-exit-\$shutdownExitCode/);
assert.match(
  windowsSandboxRunnerSource,
  /function Write-ProgressBestEffort[\s\S]*?Add-Content -LiteralPath \$progressPath[\s\S]*?catch \{\}/,
);
assert.match(windowsSandboxRunnerSource, /Write-ProgressBestEffort 'bootstrap-start'/);
assert.match(windowsSandboxRunnerSource, /Guest account cleanup failed/);
assert.match(windowsSandboxRunnerSource, /Guest shutdown failed/);
assert.match(
  windowsSandboxRunnerSource,
  /\$accountDeleteExitCode = \$null\s*& "\$env:WINDIR\\System32\\net\.exe" user \$user \/delete/,
);
assert.match(
  windowsSandboxRunnerSource,
  /\$shutdownExitCode = \$null\s*& "\$env:WINDIR\\System32\\shutdown\.exe" \/s \/t 0 \/f/,
);
assert.match(
  windowsSandboxRunnerSource,
  /\$passwordBytes = New-Object byte\[\] 11[\s\S]*?\$password = 'A7!' \+ \[Convert\]::ToBase64String\(\$passwordBytes\)[\s\S]*?Substring\(0, 11\)/,
);
assert.doesNotMatch(windowsSandboxRunnerSource, /'Y' \| & .*net\.exe/);
assert.match(windowsSandboxRunnerSource, /const SANDBOX_CLEANUP_TIMEOUT_MS = 180_000;/);
assert.match(windowsSandboxRunnerSource, /Windows Sandbox cleanup timed out after \$\{cleanupTimeoutMs\}ms/);
assert.match(windowsSandboxRunnerSource, /Isolation is not verified\. Temporary probe data was retained at/);
assert.match(windowsSandboxRunnerSource, /requestSandboxLauncherTermination\(process\)/);
assert.match(windowsSandboxRunnerSource, /executionResultAuthenticated: false/);
assert.doesNotMatch(windowsSandboxRunnerSource, /cleanupObserved: cleanupOutcome/);
assert.match(windowsSandboxRunnerSource, /verifyTemporaryRootRemoved: verifySandboxTemporaryRootRemoved/);
let lifecycleClock = 0;
const lifecycleLauncher = { pid: 42, exitCode: null, unref() {} };
let lifecycleClients = [100, 200];
const shutdownObservation = await waitForSandboxShutdown(lifecycleLauncher, [100], 'sandbox-lifecycle-success', {
  listClients: () => lifecycleClients,
  cleanupTimeoutMs: 500,
  now: () => lifecycleClock,
  sleep: async (milliseconds) => {
    lifecycleClock += milliseconds;
    lifecycleClients = [];
    lifecycleLauncher.exitCode = 0;
  },
});
assert.equal(lifecycleLauncher.exitCode, 0);
assert.equal(shutdownObservation.launcherTerminated, true);
assert.equal(shutdownObservation.sandboxClientsRemaining, 0);

for (const scenario of [
  {
    name: 'launcher remains after client exit',
    launcherExitCode: null,
    clientPids: [],
    expected: /launcher is still running.*no guest clients remain/i,
  },
  {
    name: 'guest client remains after launcher exit',
    launcherExitCode: 0,
    clientPids: [200],
    expected: /launcher exited.*guest client\(s\) are still running: 200/i,
  },
]) {
  let clock = 0;
  const launcher = {
    pid: 42,
    exitCode: scenario.launcherExitCode,
    unref() {},
  };
  await assert.rejects(
    waitForSandboxShutdown(launcher, [100], `sandbox-lifecycle-${scenario.name}`, {
      listClients: () => scenario.clientPids,
      cleanupTimeoutMs: 500,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
    (error) => {
      assert.match(error.message, scenario.expected);
      assert.match(error.message, /Isolation is not verified/);
      return true;
    },
  );
}

const startingResource = {
  launchState: 'starting',
  shutdownConfirmed: false,
  quarantined: false,
  leaseActive: true,
};
assert.equal(canDeleteSandboxTemporaryRoot(startingResource), false);
const failedSpawnResource = transitionSandboxResourceState(startingResource, 'launch-failed');
assert.equal(failedSpawnResource.launchState, 'failed');
assert.equal(canDeleteSandboxTemporaryRoot(failedSpawnResource), true);

const startedResource = transitionSandboxResourceState(startingResource, 'launch-started');
assert.equal(startedResource.launchState, 'started');
assert.equal(canDeleteSandboxTemporaryRoot(startedResource), false);
const laterErrorResource = transitionSandboxResourceState(startedResource, 'launch-failed');
assert.equal(laterErrorResource.launchState, 'started');
assert.equal(canDeleteSandboxTemporaryRoot(laterErrorResource), false);

const shutdownConfirmedResource = transitionSandboxResourceState(startedResource, 'shutdown-confirmed');
assert.equal(canDeleteSandboxTemporaryRoot(shutdownConfirmedResource), true);
const quarantinedResource = transitionSandboxResourceState(startedResource, 'cleanup-failed');
assert.equal(quarantinedResource.quarantined, true);
assert.equal(quarantinedResource.leaseActive, true);
assert.equal(canDeleteSandboxTemporaryRoot(quarantinedResource), false);
assert.throws(
  () => transitionSandboxResourceState(shutdownConfirmedResource, 'cleanup-succeeded'),
  /cannot release its lease/i,
);
const releasedResource = transitionSandboxResourceState({
  ...shutdownConfirmedResource,
  cleanupVerified: true,
  stagingDirectoryRemoved: true,
}, 'cleanup-succeeded');
assert.equal(releasedResource.quarantined, false);
assert.equal(releasedResource.leaseActive, false);

const cleanupFixture = (options = {}) => {
  let nextRoot = 0;
  const removedRoots = [];
  const shutdownCalls = [];
  const lifecycle = createSandboxResourceLifecycle({
    createTemporaryRoot: async () => `owned-fixture-root-${++nextRoot}`,
    waitForShutdown: async (process, baselinePids, temporaryRoot) => {
      shutdownCalls.push({ process, baselinePids, temporaryRoot });
      if (options.waitForShutdown) return options.waitForShutdown(process, baselinePids, temporaryRoot);
      return {
        launcherPid: process.pid,
        launcherTerminated: true,
        sandboxClientsRemaining: 0,
        ownedSandboxProcessCount: 0,
        sandboxResourceAbsent: true,
        sandboxHandlesReleased: true,
      };
    },
    removeTemporaryRoot: async (temporaryRoot) => {
      removedRoots.push(temporaryRoot);
      if (options.removeTemporaryRoot) await options.removeTemporaryRoot(temporaryRoot);
    },
    verifyTemporaryRootRemoved: async (temporaryRoot) => {
      if (options.verifyTemporaryRootRemoved) return options.verifyTemporaryRootRemoved(temporaryRoot);
      return removedRoots.includes(temporaryRoot);
    },
  });
  return { lifecycle, removedRoots, shutdownCalls };
};

const successfulCleanup = cleanupFixture();
const successfulResource = await successfulCleanup.lifecycle.createResource();
const successfulRoot = successfulCleanup.lifecycle.getTemporaryRoot(successfulResource);
successfulCleanup.lifecycle.setBaselinePids(successfulResource, [101]);
successfulCleanup.lifecycle.markLaunchStarting(successfulResource);
const successfulLauncher = { pid: 55 };
successfulCleanup.lifecycle.markLauncherStarted(successfulResource, successfulLauncher);
const successfulHostCleanup = await successfulCleanup.lifecycle.cleanup(successfulResource);
assert.deepEqual(successfulHostCleanup, {
  launcherTerminated: true,
  sandboxClientsRemaining: 0,
  sandboxResourceDeleted: true,
  sandboxHandlesReleased: true,
  stagingDirectoryRemoved: true,
  cleanupVerified: true,
  resourceDeleted: true,
  runId: null,
  secureErasureProven: 'NOT_ESTABLISHED',
  evidenceState: 'NOT_ESTABLISHED',
});
assert.deepEqual(successfulCleanup.removedRoots, [successfulRoot]);
assert.deepEqual(successfulCleanup.shutdownCalls, [{
  process: successfulLauncher,
  baselinePids: [101],
  temporaryRoot: successfulRoot,
}]);
assert.throws(
  () => successfulCleanup.lifecycle.getStatus(successfulResource),
  /not owned/,
);

const timeoutCleanup = cleanupFixture({
  waitForShutdown: async () => { throw new Error('synthetic shutdown timeout'); },
});
const timedOutResource = await timeoutCleanup.lifecycle.createResource();
const timedOutRoot = timeoutCleanup.lifecycle.getTemporaryRoot(timedOutResource);
timeoutCleanup.lifecycle.markLaunchStarting(timedOutResource);
timeoutCleanup.lifecycle.markLauncherStarted(timedOutResource, { pid: 56 });
await assert.rejects(timeoutCleanup.lifecycle.cleanup(timedOutResource), /synthetic shutdown timeout/);
assert.deepEqual(timeoutCleanup.removedRoots, []);
assert.equal(timeoutCleanup.lifecycle.getTemporaryRoot(timedOutResource), timedOutRoot);
assert.deepEqual(timeoutCleanup.lifecycle.getStatus(timedOutResource), {
  launchState: 'started',
  shutdownConfirmed: false,
  quarantined: true,
  leaseActive: true,
  cleanupVerified: false,
  resourceDeleted: false,
  secureErasureProven: 'NOT_ESTABLISHED',
});
await assert.rejects(timeoutCleanup.lifecycle.createResource(), /still active or quarantined/);

const removalFailure = cleanupFixture({
  removeTemporaryRoot: async () => { throw new Error('synthetic removal failure'); },
});
const failedRemovalResource = await removalFailure.lifecycle.createResource();
removalFailure.lifecycle.markLaunchStarting(failedRemovalResource);
removalFailure.lifecycle.markLauncherStarted(failedRemovalResource, { pid: 57 });
await assert.rejects(removalFailure.lifecycle.cleanup(failedRemovalResource), /synthetic removal failure/);
assert.equal(removalFailure.lifecycle.getStatus(failedRemovalResource).quarantined, true);
assert.equal(removalFailure.lifecycle.getStatus(failedRemovalResource).leaseActive, true);
await assert.rejects(removalFailure.lifecycle.createResource(), /still active or quarantined/);

const unverifiedRemoval = cleanupFixture({ verifyTemporaryRootRemoved: async () => false });
const unverifiedRemovalResource = await unverifiedRemoval.lifecycle.createResource({ runId: 'run-removal-check' });
unverifiedRemoval.lifecycle.markLaunchStarting(unverifiedRemovalResource);
unverifiedRemoval.lifecycle.markLauncherStarted(unverifiedRemovalResource, { pid: 59 });
await assert.rejects(unverifiedRemoval.lifecycle.cleanup(unverifiedRemovalResource), /removal could not be verified/);
assert.deepEqual(unverifiedRemoval.lifecycle.getStatus(unverifiedRemovalResource), {
  launchState: 'started',
  shutdownConfirmed: true,
  quarantined: true,
  leaseActive: true,
  cleanupVerified: false,
  resourceDeleted: false,
  secureErasureProven: 'NOT_ESTABLISHED',
});
assert.equal(canDeleteSandboxTemporaryRoot(unverifiedRemoval.lifecycle.getStatus(unverifiedRemovalResource)), false);
await assert.rejects(unverifiedRemoval.lifecycle.createResource(), /still active or quarantined/);
await assert.rejects(unverifiedRemoval.lifecycle.cleanup(unverifiedRemovalResource), /shutdown was not confirmed|removal could not be verified/i);

const forgedCleanup = cleanupFixture();
await assert.rejects(forgedCleanup.lifecycle.cleanup({ temporaryRoot: 'unowned-arbitrary-path' }), /not owned/);
assert.deepEqual(forgedCleanup.removedRoots, []);

const spawnFailureCleanup = cleanupFixture();
const spawnFailureResource = await spawnFailureCleanup.lifecycle.createResource();
const spawnFailureRoot = spawnFailureCleanup.lifecycle.getTemporaryRoot(spawnFailureResource);
spawnFailureCleanup.lifecycle.markLaunchStarting(spawnFailureResource);
spawnFailureCleanup.lifecycle.markLaunchFailed(spawnFailureResource);
await spawnFailureCleanup.lifecycle.cleanup(spawnFailureResource);
assert.deepEqual(spawnFailureCleanup.shutdownCalls, []);
assert.deepEqual(spawnFailureCleanup.removedRoots, [spawnFailureRoot]);

const postStartFailureCleanup = cleanupFixture();
const postStartFailureResource = await postStartFailureCleanup.lifecycle.createResource();
postStartFailureCleanup.lifecycle.markLaunchStarting(postStartFailureResource);
postStartFailureCleanup.lifecycle.markLauncherStarted(postStartFailureResource, { pid: 58 });
postStartFailureCleanup.lifecycle.markLaunchFailed(postStartFailureResource);
await postStartFailureCleanup.lifecycle.cleanup(postStartFailureResource);
assert.equal(postStartFailureCleanup.shutdownCalls.length, 1);

const independentCleanup = cleanupFixture();
const independentlyOwnedResource = await independentCleanup.lifecycle.createResource();
assert.throws(
  () => requireProjectProcessIsolation('Prior Windows project operation'),
  /Prior Windows project operation was not started/,
);
await independentCleanup.lifecycle.cleanup(independentlyOwnedResource);
assert.deepEqual(independentCleanup.removedRoots, ['owned-fixture-root-1']);

const sandboxProbeEvidence = {
  administrator: false,
  mediumIntegrity: true,
  readOnlyInput: true,
  resultMountWritable: true,
  hostPathUnavailable: true,
  externalJunctionUnavailable: true,
  hostEnvironmentUnavailable: true,
  ipv4DefaultRoutes: 0,
  ipv6DefaultRoutes: 0,
  outboundBlocked: true,
  guestWorkspaceWritable: true,
  childProcessCreated: true,
};
const successfulSandboxProbe = { exitCode: 0 };
assert.equal(assertSandboxProbe(sandboxProbeEvidence, successfulSandboxProbe), successfulSandboxProbe);
assert.throws(
  () => assertSandboxProbe({ ...sandboxProbeEvidence, administrator: true }, { exitCode: 0 }),
  /guest process was not a standard user/i,
);

const syntheticRunId = 'sandbox-run-1';
const guestResult = {
  runId: syntheticRunId,
  exitCode: 0,
  stdout: 'guest output',
  stderr: '',
  timedOut: false,
  cancelled: false,
  durationMs: 12,
};
assert.equal(isValidSandboxGuestResult(guestResult, syntheticRunId), true);
assert.equal(isValidSandboxGuestResult(guestResult, 'stale-run'), false);
assert.equal(isValidSandboxGuestResult({ ...guestResult, extra: 'forged' }, syntheticRunId), false);

let validResultReads = 0;
const hostAcceptedFreshnessOnly = await waitForSandboxResult({
  runId: syntheticRunId,
  resultPath: 'fixture-result',
  cleanupOutcomePath: 'fixture-cleanup',
  cancelPath: 'fixture-cancel',
  process: { pid: 6234, exitCode: null, signalCode: null },
  timeoutMs: 100,
  readFile: async (file) => {
    if (file === 'fixture-result') {
      validResultReads += 1;
      return JSON.stringify({ ...guestResult, timedOut: true, cancelled: true });
    }
    if (file === 'fixture-cleanup') {
      return JSON.stringify({
        version: 1,
        runId: syntheticRunId,
        complete: true,
        accountCleanup: 'succeeded',
        shutdownCommand: 'succeeded',
      });
    }
    throw missingSyntheticFile();
  },
});
assert.equal(validResultReads, 1);
assert.equal(hostAcceptedFreshnessOnly.result.timedOut, false);
assert.equal(hostAcceptedFreshnessOnly.result.cancelled, false);
assert.equal(hostAcceptedFreshnessOnly.hostWait.deadlineObserved, false);

const terminationTarget = {
  pid: 1234,
  exitCode: null,
  signalCode: null,
  calls: 0,
  kill() {
    this.calls += 1;
    this.signalCode = 'SIGTERM';
    return true;
  },
};
assert.deepEqual(requestSandboxLauncherTermination(terminationTarget), {
  requested: true,
  accepted: true,
  processId: 1234,
});

const failedTerminationTarget = {
  pid: 1334,
  exitCode: null,
  signalCode: null,
  kill: () => false,
};
assert.deepEqual(requestSandboxLauncherTermination(failedTerminationTarget), {
  requested: true,
  accepted: false,
  processId: 1334,
});
assert.equal(terminationTarget.calls, 1);
assert.deepEqual(requestSandboxLauncherTermination(terminationTarget), {
  requested: false,
  accepted: false,
  processId: 1234,
});

const missingSyntheticFile = () => {
  const error = new Error('synthetic file does not exist');
  error.code = 'ENOENT';
  return error;
};
let hostClock = 0;
const timedOutLauncher = {
  pid: 2234,
  exitCode: null,
  signalCode: null,
  kill() {
    this.signalCode = 'SIGTERM';
    return true;
  },
};
const cancellationWrites = [];
await assert.rejects(
  waitForSandboxResult({
    runId: syntheticRunId,
    resultPath: 'fixture-result',
    cleanupOutcomePath: 'fixture-cleanup',
    cancelPath: 'fixture-cancel',
    process: timedOutLauncher,
    timeoutMs: 5,
    startupTimeoutMs: 10,
    pollIntervalMs: 5,
    now: () => hostClock,
    sleep: async (milliseconds) => { hostClock += milliseconds; },
    readFile: async () => { throw missingSyntheticFile(); },
    writeFile: async (...args) => cancellationWrites.push(args),
  }),
  (error) => {
    assert.equal(error.code, 'SANDBOX_HOST_DEADLINE');
    assert.equal(error.timedOut, true);
    assert.equal(error.hostWait.terminationAttempt.accepted, true);
    return true;
  },
);
assert.equal(cancellationWrites.at(-1)[1], `${syntheticRunId}\n`);

const cancelledLauncher = {
  pid: 3234,
  exitCode: null,
  signalCode: null,
  kill() {
    this.signalCode = 'SIGTERM';
    return true;
  },
};
let cancellationRequestedCount = 0;
await assert.rejects(
  waitForSandboxResult({
    runId: syntheticRunId,
    resultPath: 'fixture-result',
    cleanupOutcomePath: 'fixture-cleanup',
    cancelPath: 'fixture-cancel',
    process: cancelledLauncher,
    timeoutMs: 100,
    isCancelled: () => true,
    readFile: async () => { throw missingSyntheticFile(); },
    writeFile: async () => { cancellationRequestedCount += 1; },
  }),
  (error) => {
    assert.equal(error.code, 'SANDBOX_EXITED_WITHOUT_RESULT');
    assert.equal(error.hostWait.cancelled, true);
    assert.equal(error.hostWait.terminationAttempt.accepted, true);
    return true;
  },
);
assert.equal(cancellationRequestedCount, 1);

await assert.rejects(
  waitForSandboxResult({
    runId: syntheticRunId,
    resultPath: 'fixture-result',
    cleanupOutcomePath: 'fixture-cleanup',
    cancelPath: 'fixture-cancel',
    process: { exitCode: null, signalCode: null, pid: 4234 },
    timeoutMs: Number.POSITIVE_INFINITY,
    readFile: async () => { throw missingSyntheticFile(); },
  }),
  /positive finite/i,
);
await assert.rejects(
  waitForSandboxResult({
    runId: syntheticRunId,
    resultPath: 'fixture-result',
    cleanupOutcomePath: 'fixture-cleanup',
    cancelPath: 'fixture-cancel',
    process: { exitCode: null, signalCode: null, pid: 5234 },
    timeoutMs: 100,
    startupTimeoutMs: 10,
    readFile: async () => JSON.stringify({ ...guestResult, runId: 'prior-run' }),
  }),
  /malformed or cross-run guest result/i,
);
await assert.rejects(
  devServerManager.startDevServer('isolated-dev-server-test', devProject),
  /Project dev server was not started/,
);
assert.equal(devServerManager.getActiveServer('isolated-dev-server-test'), null);
const cachedTaskId = 'isolated-dev-server-cached-test';
const cachedRecord = { taskId: cachedTaskId, reused: true, port: 4173 };
devServerManager._activeServers.set(cachedTaskId, cachedRecord);
try {
  await assert.rejects(
    devServerManager.startDevServer(cachedTaskId, devProject),
    /Project dev server was not started/,
  );
  assert.equal(devServerManager.getActiveServer(cachedTaskId), cachedRecord);
} finally {
  devServerManager._activeServers.delete(cachedTaskId);
}
await assert.rejects(fs.access(path.join(devProject, 'dev-server-write.txt')), { code: 'ENOENT' });

developerFiles.clearProject('owner-a');
developerFiles.clearProject('owner-b');
developerFiles.clearProject('owner-a-reloaded');

console.log(JSON.stringify({
  projectIsolation: true,
}));
