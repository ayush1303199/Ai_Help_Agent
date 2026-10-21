import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadElectronE2eTestMode } = require('../electron/electronE2eTestMode.cjs');
const settings = require('../src/config/runtimeSettings.json');
const envKeys = [
  'AI_CODING_E2E_TEST_MODE',
  'AI_CODING_E2E_ROOT',
  'AI_CODING_E2E_TOKEN',
  'AI_CODING_E2E_SETTINGS_PATH',
  'AI_CODING_E2E_USER_DATA',
  'AI_CODING_E2E_WORKSPACE',
  'AI_CODING_E2E_APPROVAL',
];
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-coding-electron-e2e-contract-'));
const token = randomBytes(32).toString('hex');
const workspace = path.join(root, 'workspace');
const userData = path.join(root, 'user-data');
const settingsPath = path.join(root, 'runtimeSettings.json');
const ownerPath = path.join(root, '.ai-coding-electron-e2e-owner');

function setTestEnvironment(approvalMode = 'approve-once') {
  process.env.AI_CODING_E2E_TEST_MODE = '1';
  process.env.AI_CODING_E2E_ROOT = root;
  process.env.AI_CODING_E2E_TOKEN = token;
  process.env.AI_CODING_E2E_SETTINGS_PATH = settingsPath;
  process.env.AI_CODING_E2E_USER_DATA = userData;
  process.env.AI_CODING_E2E_WORKSPACE = workspace;
  process.env.AI_CODING_E2E_APPROVAL = approvalMode;
}

try {
  await Promise.all([fs.mkdir(workspace), fs.mkdir(userData)]);
  await fs.writeFile(ownerPath, token, { flag: 'wx' });
  const testSettings = {
    ...settings,
    services: {
      ...settings.services,
      http: { host: '127.0.0.1', port: 43101, baseUrl: 'http://127.0.0.1:43101' },
      websocket: { host: '127.0.0.1', port: 43102, baseUrl: 'ws://127.0.0.1:43102' },
      codingWebsocket: { host: '127.0.0.1', port: 43103, baseUrl: 'ws://127.0.0.1:43103' },
      devServer: { ...settings.services.devServer, host: '127.0.0.1', port: 43104 },
    },
  };
  await fs.writeFile(settingsPath, JSON.stringify(testSettings), { flag: 'wx' });

  for (const key of envKeys) delete process.env[key];
  assert.equal(loadElectronE2eTestMode(settings), null, 'Normal application startup must not enter E2E test mode.');
  process.env.AI_CODING_E2E_TEST_MODE = 'true';
  assert.throws(() => loadElectronE2eTestMode(settings), /must be exactly "1"/);

  setTestEnvironment();
  const testMode = loadElectronE2eTestMode(settings);
  assert.equal(testMode.workspaceRoot, workspace);
  assert.equal(testMode.userDataDirectory, userData);
  assert.equal(testMode.runtimeSettings.services.http.port, 43101);

  const approved = await testMode.requestApproval({
    root: workspace,
    scope: '.',
    workflowRequestId: 'request-1',
    proposal: {
      taskId: 'task-1',
      targetFiles: ['src/index.js'],
      manifestHash: 'a'.repeat(64),
    },
    proposalContract: { isGreenfield: true },
    diff: '+export const value = true;\n',
  });
  assert.equal(approved, true, 'The isolated test adapter must explicitly record its one approved proposal.');
  const evidence = JSON.parse(await fs.readFile(testMode.evidencePath, 'utf8'));
  assert.equal(evidence.status, 'TEST_APPROVED');
  assert.deepEqual(evidence.files, [path.join('src', 'index.js')]);
  assert.equal(await fs.stat(path.join(workspace, 'src')).then(() => false, (error) => error.code === 'ENOENT'), true,
    'Approval evidence must not itself write project files.');
  await assert.rejects(
    () => testMode.requestApproval({
      root: workspace,
      scope: '.',
      workflowRequestId: 'request-2',
      proposal: { taskId: 'task-2', targetFiles: ['another.js'], manifestHash: 'b'.repeat(64) },
      proposalContract: { isGreenfield: true },
      diff: '+content\n',
    }),
    /only one proposal approval/,
  );

  setTestEnvironment();
  const pathGuard = loadElectronE2eTestMode(settings);
  await assert.rejects(
    () => pathGuard.requestApproval({
      root: workspace,
      scope: '.',
      workflowRequestId: 'request-3',
      proposal: { taskId: 'task-3', targetFiles: ['..\\outside.js'], manifestHash: 'c'.repeat(64) },
      proposalContract: { isGreenfield: true },
      diff: '+content\n',
    }),
    /escapes the empty workspace/,
  );
  assert.equal(await fs.stat(path.join(root, 'outside.js')).then(() => true, () => false), false);

  process.env.AI_CODING_E2E_TOKEN = 'wrong-owner-token-that-is-long-enough-to-fail';
  assert.throws(() => loadElectronE2eTestMode(settings), /ownership marker/);
  console.log('Electron E2E harness contract passed: normal-mode isolation, explicit test config, one-time approval, workspace containment, and no adapter writes.');
} finally {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (await fs.readFile(ownerPath, 'utf8').catch(() => null) === token) {
    await fs.rm(root, { recursive: true, force: false });
  } else {
    throw new Error(`Harness contract test did not clean its owned temporary root: ${root}`);
  }
}
