import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
const spawnAttempts = [];
childProcess.spawn = (...args) => {
  spawnAttempts.push(args);
  throw new Error('Unexpected subprocess attempt in fail-closed fixture.');
};

const sandboxRunner = require('../electron/coding-pipeline/windowsSandboxRunner.cjs');
const projectIsolation = require('../electron/coding-pipeline/projectProcessIsolation.cjs');
const providerAdapterContract = require('../electron/coding-pipeline/providerAdapterContract.cjs');
const developerFiles = require('../electron/developerFiles.cjs');
const { DevServerManager } = require('../electron/coding-pipeline/environment.cjs');
const developerFilesSource = await fs.readFile(
  new URL('../electron/developerFiles.cjs', import.meta.url),
  'utf8',
);
const environmentSource = await fs.readFile(
  new URL('../electron/coding-pipeline/environment.cjs', import.meta.url),
  'utf8',
);
const sandboxRunnerSource = await fs.readFile(
  new URL('../electron/coding-pipeline/windowsSandboxRunner.cjs', import.meta.url),
  'utf8',
);
const mainSource = await fs.readFile(
  new URL('../electron/main.cjs', import.meta.url),
  'utf8',
);
const projectIsolationSource = await fs.readFile(
  new URL('../electron/coding-pipeline/projectProcessIsolation.cjs', import.meta.url),
  'utf8',
);

const run = (authorization) => sandboxRunner.runWindowsSandboxCommand({
  projectRoot: 'C:\\synthetic-project',
  executable: 'npm.cmd',
  args: ['run', 'test'],
  authorization,
});

const untrustedAuthorizations = [
  undefined,
  null,
  'renderer-supplied-value',
  Object.freeze({ authorized: true, verified: true, capabilityStates: { osEnforcedProcessIsolation: 'SUPPORTED' } }),
  Object.freeze({
    state: 'approved',
    approved: true,
    projectRoot: 'C:\\synthetic-project',
    scope: '.',
    verificationAttempt: 1,
  }),
  Object.freeze({
    state: 'approved',
    approved: true,
    projectRoot: 'C:\\different-project',
    scope: 'outside-scope',
    verificationAttempt: 0,
    expiresAt: '2000-01-01T00:00:00.000Z',
  }),
];

for (const authorization of untrustedAuthorizations) {
  await assert.rejects(
    run(authorization),
    /Windows Sandbox project command authorization is unavailable/,
  );
}

const forgedCapabilityClaims = {
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
  capabilityStates: Object.fromEntries(
    providerAdapterContract.ISOLATION_CAPABILITIES.map((name) => [name, 'SUPPORTED']),
  ),
};
assert.throws(
  () => projectIsolation.requireProjectProcessIsolation(
    'Forged authorization regression test',
    {
      runId: 'forged-run',
      providerId: 'windows-sandbox',
      providerConfigRevision: 'current',
      approvedSnapshotDigest: 'a'.repeat(64),
      approvedManifestDigest: 'b'.repeat(64),
      verificationPlanDigest: 'c'.repeat(64),
      workerIdentity: 'forged-worker',
      evidenceTimestamp: new Date().toISOString(),
      evidenceExpiry: new Date(Date.now() + 60_000).toISOString(),
      provenance: 'INDEPENDENTLY_OBSERVED',
      trustClass: 'INDEPENDENTLY_OBSERVED',
    },
    { runId: 'forged-run' },
    forgedCapabilityClaims,
  ),
  (error) => error.code === 'PROJECT_EXECUTION_BLOCKED'
    && error.executionBlocked === true
    && error.executionStatus === 'BLOCKED'
    && error.evidenceState === 'NOT_ESTABLISHED',
);
assert.equal(projectIsolation.projectProcessIsolationStatus().available, false);
assert.equal(projectIsolation.projectProcessIsolationStatus().verified, false);
await projectIsolation.verifyProjectProcessIsolation();
assert.equal(projectIsolation.projectProcessIsolationStatus().available, false);

try {
  await assert.rejects(
    new DevServerManager().startDevServer('fixture-task', 'C:\\synthetic-project'),
    (error) => error.code === 'PROJECT_EXECUTION_BLOCKED' && error.executionBlocked === true,
  );

  const runVerification = developerFilesSource.indexOf('async function runVerification(');
  const outerGate = developerFilesSource.indexOf("requireProjectProcessIsolation('Project verification')", runVerification);
  const workspaceCall = developerFilesSource.indexOf('runVerificationInWorkspace(', runVerification);
  assert.ok(runVerification >= 0 && outerGate > runVerification && workspaceCall > outerGate);

  const workspaceStart = developerFilesSource.indexOf('async function runVerificationInWorkspace(');
  const workspaceEnd = developerFilesSource.indexOf('async function getVerificationScripts(', workspaceStart);
  const workspaceSource = developerFilesSource.slice(workspaceStart, workspaceEnd);
  for (const spawnNeedle of [
    'spawn(process.env.ComSpec',
    'spawn(phpCommand.executable',
    'spawn(commandSpec.executable',
    'spawn(executable, [\'run\', script]',
    'spawn(\'git\', args',
  ]) {
    const spawnIndex = workspaceSource.indexOf(spawnNeedle);
    assert.ok(spawnIndex >= 0, `Expected execution route ${spawnNeedle}.`);
    assert.ok(
      workspaceSource.lastIndexOf('requireProjectProcessIsolation(', spawnIndex) >= 0,
      `Missing shared gate before ${spawnNeedle}.`,
    );
  }
  const gitInspectionStart = developerFilesSource.indexOf('async function runGit(');
  const gitInspectionEnd = developerFilesSource.indexOf('const detectProjectType', gitInspectionStart);
  const gitInspectionSource = developerFilesSource.slice(gitInspectionStart, gitInspectionEnd);
  const gitGate = gitInspectionSource.indexOf("requireProjectProcessIsolation('Project Git inspection')");
  const gitSpawn = gitInspectionSource.indexOf("spawn('git'");
  assert.ok(gitGate >= 0 && gitSpawn > gitGate);

  const changedPhpStart = developerFilesSource.indexOf('async function findChangedPhpFiles(');
  const changedPhpEnd = developerFilesSource.indexOf('async function ', changedPhpStart + 1);
  const changedPhpSource = developerFilesSource.slice(changedPhpStart, changedPhpEnd);
  const changedPhpGate = changedPhpSource.indexOf("requireProjectProcessIsolation('PHP changed-file inspection')");
  const changedPhpSpawn = changedPhpSource.indexOf("spawn('git'");
  assert.ok(changedPhpGate >= 0 && changedPhpSpawn > changedPhpGate);

  const devServerStart = environmentSource.indexOf('async startDevServer(');
  const devServerGate = environmentSource.indexOf("this._requireIsolation('Project dev server')", devServerStart);
  const devServerSpawn = environmentSource.indexOf('this._spawnProcess(shellCmd, shellArgs', devServerStart);
  assert.ok(devServerStart >= 0 && devServerGate > devServerStart && devServerSpawn > devServerGate);

  const sandboxEntry = sandboxRunnerSource.indexOf('async function runWindowsSandboxCommand(');
  const sandboxAuthorization = sandboxRunnerSource.indexOf('projectCommandAuthorizations.has(authorization)', sandboxEntry);
  const sandboxGate = sandboxRunnerSource.indexOf("requireProjectProcessIsolation('Windows Sandbox project command')", sandboxEntry);
  const sandboxSpawn = sandboxRunnerSource.indexOf('spawn(SANDBOX_EXECUTABLE', sandboxEntry);
  assert.ok(sandboxEntry >= 0
    && sandboxAuthorization > sandboxEntry
    && sandboxGate > sandboxAuthorization
    && sandboxSpawn > sandboxGate);

  const toolHandler = mainSource.indexOf("ipcMain.handle('developer:tool'");
  const directVerificationHandler = mainSource.indexOf("ipcMain.handle('developer:run-verification'");
  const proposalApplyHandler = mainSource.indexOf("ipcMain.handle('developer:proposal-apply'");
  const devServerHandler = mainSource.indexOf("ipcMain.handle('developer:dev-server-manage'");
  assert.ok(toolHandler >= 0
    && mainSource.indexOf('developerFiles.runVerification(script, event.sender.id)', toolHandler) > toolHandler);
  assert.ok(directVerificationHandler >= 0
    && mainSource.indexOf('developerFiles.runVerification(script, event.sender.id)', directVerificationHandler) > directVerificationHandler);
  assert.ok(proposalApplyHandler >= 0
    && mainSource.indexOf('runCheck: (script) => developerFiles.runVerification', proposalApplyHandler) > proposalApplyHandler);
  assert.ok(devServerHandler >= 0
    && mainSource.indexOf('developerAgent.manageDevServer', devServerHandler) > devServerHandler);

  assert.match(
    projectIsolationSource,
    /process\.platform === 'win32' \|\| !status\.available \|\| !status\.verified/,
  );
  assert.equal(spawnAttempts.length, 0);
} finally {
  childProcess.spawn = originalSpawn;
}

console.log('Forged authorization is blocked before verification, Git, dev-server, or Sandbox process creation.');
