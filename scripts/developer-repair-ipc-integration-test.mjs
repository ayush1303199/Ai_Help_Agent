import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const handlers = new Map();
const windows = [];
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-ipc-userdata-'));
const projectRoots = new Set();
const dialogResponses = [];
const dialogRequests = [];
const policyRequests = [];
const policyProofs = [];
let policyDecision = 'ALLOW';
let providerListFixture = { providers: [], activeProvider: null };
const electronMock = {
  app: Object.assign(new EventEmitter(), {
    isPackaged: false,
    getPath: () => userData,
    whenReady: () => Promise.resolve(),
    quit() {},
  }),
  ipcMain: {
    handle(name, handler) {
      if (handlers.has(name)) throw new Error(`Duplicate IPC handler: ${name}`);
      handlers.set(name, handler);
    },
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived() {} },
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      setDisplayMediaRequestHandler() {},
    },
  },
  globalShortcut: {
    isRegistered: () => false,
    register: () => true,
    unregister() {},
    unregisterAll() {},
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
  },
  desktopCapturer: { getSources: async () => [] },
  dialog: {
    showMessageBox: async (_window, options) => {
      dialogRequests.push(options);
      return { response: dialogResponses.length ? dialogResponses.shift() : 0 };
    },
    showErrorBox() {},
  },
  BrowserWindow: null,
};

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = windows.length + 1;
    this.url = 'http://localhost:3000/';
  }
  getURL() { return this.url; }
  send() {}
  setWindowOpenHandler() {}
  loadURL(url) { this.url = url; }
}

class FakeBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    windows.push(this);
  }
  setContentProtection() {}
  loadURL(url) { this.webContents.loadURL(url); }
  loadFile() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return true; }
  hide() {}
  show() {}
  showInactive() {}
  focus() {}
  setBounds() {}
  setAlwaysOnTop() {}
  setSkipTaskbar() {}
  static getAllWindows() { return windows.filter((window) => !window.destroyed); }
  static fromWebContents(contents) {
    return windows.find((window) => window.webContents === contents) || null;
  }
}
electronMock.BrowserWindow = FakeBrowserWindow;

Module._load = function patchedLoad(request, parent, isMain) {
  return request === 'electron' ? electronMock : originalLoad.call(this, request, parent, isMain);
};

const developerFiles = require('../electron/developerFiles.cjs');
const developerAgent = require('../electron/developerAgent.cjs');
const { multiRepoCoordinator } = require('../electron/coding-pipeline/multiRepo.cjs');
const originalRunVerification = developerFiles.runVerification;
let verificationOutcome = 'failure';
let verificationCalls = 0;
developerFiles.runVerification = async (script) => {
  verificationCalls += 1;
  if (verificationOutcome === 'pass') {
    return { ok: true, script, executed: true, exitCode: 0, stdout: '', stderr: '' };
  }
  return { ok: false, script, executed: true, exitCode: 1, stdout: '', stderr: 'assertion failed' };
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/api/settings/providers')) {
    assert.match(options.headers?.['X-Coding-Auth'] || '', /\S/, 'Preflight provider lookup must authenticate.');
    return { ok: true, json: async () => providerListFixture };
  }
  if (String(url).includes('/api/coding/policy/file-mutation')) {
    policyRequests.push(JSON.parse(options.body || '{}'));
    policyProofs.push(options.headers?.['X-Coding-Mutation-Proof']);
    return { ok: true, json: async () => ({ decision: policyDecision }) };
  }
  return { ok: true, json: async () => ({ decision: 'ALLOW' }) };
};

let mainLoaded = false;
let realNow;
try {
  require('../electron/main.cjs');
  mainLoaded = true;
  for (let index = 0; index < 200 && (!handlers.has('developer:proposal-create') || windows.length === 0); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(handlers.has('developer:proposal-create'), 'The actual main-process IPC handlers did not register.');

  const invoke = async (name, sender, ...args) => {
    const handler = handlers.get(name);
    assert.ok(handler, `Missing IPC handler ${name}`);
    return handler({ sender, senderFrame: { url: sender.getURL() } }, ...args);
  };
  const createProject = async (sender, withScript = true) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-repair-project-'));
    projectRoots.add(root);
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'const value = 1;\n');
    await fs.mkdir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'tests', 'sample.test.js'), 'test("sample", () => {});\n');
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.writeFile(path.join(root, 'scripts', 'verify.js'), 'process.exit(0);\n');
    await fs.writeFile(path.join(root, 'vite.config.js'), 'export default { test: true };\n');
    if (withScript) {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'ipc-test-project',
        scripts: { test: 'node -e "process.exit(0)"' },
      }, null, 2));
    } else {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ipc-test-project', scripts: {} }, null, 2));
    }
    const attached = await invoke('developer:project-attach', sender, { projectRoot: root });
    assert.equal(attached.status, 'PROJECT_ATTACHED');
    return root;
  };
  const patch = (file, before, after) => [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${before}`,
    `+${after}`,
    '',
  ].join('\n');
  const createProposal = async (sender, raw, extra = {}) => {
    const conversation = await invoke('developer:conversation-start', sender, {
      request: 'Update the project according to this test proposal.',
      scope: '.',
      repairToken: extra.repairToken,
    });
    await invoke('developer:conversation-update', sender, {
      turnId: conversation.turnId,
      state: 'understanding',
      phase: 'test-proposal',
    });
    return invoke('developer:proposal-create', sender, {
      raw,
      scope: '.',
      ...extra,
      conversationTurnId: conversation.turnId,
    });
  };
  const failProposal = async (sender, raw, extra = {}) => {
    const proposal = await createProposal(sender, raw, extra);
    await invoke('developer:proposal-approve', sender, proposal.id);
    const result = await invoke('developer:proposal-apply', sender, proposal.id, {
      attemptNumber: 99,
      repairOf: 'renderer-forged-proposal',
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.verification.status, 'CODE_FAILURE');
    assert.equal(result.attemptNumber, 1, 'Renderer-supplied attempt counters must be ignored.');
    assert.equal(await fs.readFile(path.join(projectRootBySender.get(sender.id), 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
    return { proposal, result };
  };
  const projectRootBySender = new Map();
  const senderFor = () => windows[0].webContents;
  const sender = senderFor(1);
  const ownerId = sender.id;
  assert.ok(handlers.has('developer:acceptance-preflight'));
  const unattachedPreflight = await invoke('developer:acceptance-preflight', sender);
  assert.ok(unattachedPreflight.blockers.some((item) => item.code === 'runtime_provider_missing'));
  assert.ok(unattachedPreflight.blockers.some((item) => item.code === 'project_missing'));
  assert.ok(unattachedPreflight.blockers.some((item) => item.code === 'sandbox_unverified'));
  assert.equal(unattachedPreflight.canRunProjectCommands, false);
  const projectRoot = await createProject(sender);
  projectRootBySender.set(ownerId, projectRoot);
  const missingProviderPreflight = await invoke('developer:acceptance-preflight', sender);
  assert.equal(missingProviderPreflight.projectAttached, true);
  assert.ok(missingProviderPreflight.blockers.some((item) => item.code === 'runtime_provider_missing'));
  providerListFixture = {
    activeProvider: 'active-provider',
    providers: [{
      id: 'active-provider',
      enabled: true,
      hasApiKey: true,
      assistantCapable: true,
      developerToolCalling: true,
    }],
  };
  const providerReadyPreflight = await invoke('developer:acceptance-preflight', sender);
  assert.equal(providerReadyPreflight.providerConfigured, true);
  assert.ok(providerReadyPreflight.blockers.some((item) => item.code === 'sandbox_unverified'));
  assert.equal(providerReadyPreflight.canRunProjectCommands, false);

  const initial = await createProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 2;'), {
    attemptNumber: 77,
    repairOf: 'forged',
  });
  assert.equal(initial.attemptNumber, 1);
  assert.equal(initial.maxAttempts, 3);
  assert.equal(initial.attemptLabel, 'attempt 1 of 3');

  const checkpointEscape = path.join(os.tmpdir(), `renderer-checkpoint-${process.pid}.json`);
  await invoke('developer:task-checkpoint-save-disk', sender, {
    taskId: initial.id,
    checkpointPath: checkpointEscape,
  });
  const ownedCheckpoint = path.join(userData, 'developer-checkpoints', `${initial.id}.json`);
  assert.equal(JSON.parse(await fs.readFile(ownedCheckpoint, 'utf8')).task.taskId, initial.id);
  await assert.rejects(() => fs.access(checkpointEscape), { code: 'ENOENT' });
  await invoke('developer:task-checkpoint-restore-disk', sender, {
    taskId: initial.id,
    checkpointPath: checkpointEscape,
  });
  await assert.rejects(
    () => invoke('developer:dev-server-manage', sender, {
      taskId: initial.id,
      action: 'status',
      projectRoot: path.dirname(projectRoot),
    }),
    /Renderer-supplied dev server root does not match the selected project/i,
  );

  const denied = await createProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 9;'));
  assert.ok(Array.isArray(developerAgent.getTaskForTest(denied.id).authorizationContext?.authorizedFeatures));
  assert.ok(Array.isArray(developerAgent.getTaskForTest(denied.id).requestedFeatures));
  await invoke('developer:proposal-approve', sender, denied.id);
  policyDecision = 'DENY';
  const deniedResult = await invoke('developer:proposal-apply', sender, denied.id);
  policyDecision = 'ALLOW';
  assert.equal(deniedResult.state, 'failed');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
  assert.ok(policyRequests.some((request) => request.operation === 'modify'));
  assert.ok(policyProofs.length > 0 && policyProofs.every((proof) => /^[a-f0-9]{64}$/.test(proof)));

  const autoInitial = await createProposal(
    sender,
    patch('src/app.js', 'const value = 1;', 'const value = 2;'),
  );
  const autoApproval = await invoke('developer:proposal-approve', sender, autoInitial.id, { autoRepair: true });
  assert.equal(autoApproval.autoRepairEnabled, true);
  assert.equal(autoApproval.maxAttempts, 4, 'Auto mode permits one initial attempt plus three repairs.');
  const autoInitialFailure = await invoke('developer:proposal-apply', sender, autoInitial.id);
  assert.equal(autoInitialFailure.state, 'failed');
  assert.equal(autoInitialFailure.repairAvailable, true);
  assert.equal(
    await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'),
    'const value = 1;\n',
    'The failed initial Auto-mode attempt must be rolled back before repair creation.',
  );
  const autoRepairContext = await invoke('developer:verification-repair-context', sender, autoInitial.id);
  const autoRepairProposal = await createProposal(
    sender,
    patch('src/app.js', 'const value = 1;', 'const value = 3;'),
    { repairToken: autoRepairContext.repairToken },
  );
  assert.equal(autoRepairProposal.state, 'approved', 'An in-scope repair must be approved by the existing main-process chain.');
  assert.equal(autoRepairProposal.autoRepairAuthorized, true);
  assert.ok(developerAgent.getTaskForTest(autoRepairProposal.id).approval);
  verificationOutcome = 'pass';
  const autoRepairResult = await invoke('developer:proposal-apply', sender, autoRepairProposal.id);
  verificationOutcome = 'failure';
  assert.equal(autoRepairResult.state, 'completed');
  assert.equal(autoRepairResult.verification.status, 'PASS');
  assert.ok(policyRequests.some((request) => request.operation === 'modify' && request.paths.includes('src/app.js')));

  const autoExpansionInitial = await createProposal(
    sender,
    patch('src/app.js', 'const value = 3;', 'const value = 4;'),
  );
  await invoke('developer:proposal-approve', sender, autoExpansionInitial.id, { autoRepair: true });
  const autoExpansionFailure = await invoke('developer:proposal-apply', sender, autoExpansionInitial.id);
  assert.equal(autoExpansionFailure.state, 'failed');
  const autoExpansionContext = await invoke('developer:verification-repair-context', sender, autoExpansionInitial.id);
  const autoExpandedProposal = await createProposal(
    sender,
    patch('tests/sample.test.js', 'test("sample", () => {});', 'test("expanded", () => {});'),
    { repairToken: autoExpansionContext.repairToken },
  );
  assert.equal(autoExpandedProposal.state, 'awaiting_approval');
  assert.equal(autoExpandedProposal.autoRepairAuthorized, false);
  assert.equal(autoExpandedProposal.autoRepairEnabled, false);
  assert.match(autoExpandedProposal.autoRepairBlockedReason, /outside the initial approval|test or verification configuration/i);
  await invoke('developer:verification-repair-cancel', sender, autoExpandedProposal.id);
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'const value = 1;\n');

  const meetingDirectory = path.join(projectRoot, 'src', 'features', 'meeting');
  await fs.mkdir(meetingDirectory, { recursive: true });
  await fs.writeFile(path.join(meetingDirectory, 'transcript.ts'), 'export const current = true;\n');
  const crossFeature = await createProposal(
    sender,
    patch('src/features/meeting/transcript.ts', 'export const current = true;', 'export const current = false;'),
  );
  dialogResponses.push(1);
  await assert.rejects(
    () => invoke('developer:proposal-approve', sender, crossFeature.id),
    /Cross-feature authorization was not granted/,
  );
  assert.equal(developerAgent.getTaskForTest(crossFeature.id).state, 'awaiting_approval');
  dialogResponses.push(0);
  await invoke('developer:proposal-approve', sender, crossFeature.id);
  assert.ok(developerAgent.getTaskForTest(crossFeature.id).approval.authorizedFeatures.includes('meeting'));

  const createdRollbackPath = path.join(projectRoot, 'src', 'rollback-created.js');
  await multiRepoCoordinator.captureBaselineSnapshot(initial.id, projectRoot, [createdRollbackPath]);
  await fs.writeFile(createdRollbackPath, 'created by coordinated change\n');
  await multiRepoCoordinator.recordRepoModification(initial.id, projectRoot, [createdRollbackPath]);
  dialogResponses.push(0, 1);
  await assert.rejects(
    () => invoke('developer:task-multi-repo-rollback', sender, { taskId: initial.id }),
    /deletion was not confirmed/i,
  );
  assert.equal(await fs.readFile(createdRollbackPath, 'utf8'), 'created by coordinated change\n');
  assert.equal(dialogRequests.at(-1).title, 'Confirm rollback deletion');
  assert.equal(dialogRequests.at(-1).detail, createdRollbackPath);
  policyDecision = 'DENY';
  dialogResponses.push(0, 0);
  await assert.rejects(
    () => invoke('developer:task-multi-repo-rollback', sender, { taskId: initial.id }),
    /Policy Gate denied/i,
  );
  policyDecision = 'ALLOW';
  assert.equal(await fs.readFile(createdRollbackPath, 'utf8'), 'created by coordinated change\n');
  dialogResponses.push(0, 0);
  const rollbackResult = await invoke('developer:task-multi-repo-rollback', sender, { taskId: initial.id });
  assert.equal(rollbackResult.ok, true);
  await assert.rejects(() => fs.access(createdRollbackPath), { code: 'ENOENT' });
  const rollbackPolicy = policyRequests.at(-1);
  assert.equal(rollbackPolicy.operation, 'delete');
  assert.deepEqual(rollbackPolicy.paths, ['src/rollback-created.js']);

  const proposalDeletePath = path.join(projectRoot, 'src', 'delete-target.js');
  await fs.writeFile(proposalDeletePath, 'delete me\n');
  const deletionDiff = [
    '--- a/src/delete-target.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-delete me',
    '',
  ].join('\n');
  const cancelledDelete = await createProposal(sender, deletionDiff);
  await invoke('developer:proposal-approve', sender, cancelledDelete.id);
  const policyCountBeforeDeleteCancel = policyRequests.length;
  dialogResponses.push(1);
  const deleteCancelResult = await invoke('developer:proposal-apply', sender, cancelledDelete.id);
  assert.equal(deleteCancelResult.state, 'failed');
  assert.equal(await fs.readFile(proposalDeletePath, 'utf8'), 'delete me\n');
  assert.equal(policyRequests.slice(policyCountBeforeDeleteCancel).some((request) => request.operation === 'delete'), false);
  assert.equal(dialogRequests.at(-1).title, 'Confirm file deletion');

  const approvedDelete = await createProposal(sender, deletionDiff);
  await invoke('developer:proposal-approve', sender, approvedDelete.id);
  verificationOutcome = 'pass';
  const approvedDeleteResult = await invoke('developer:proposal-apply', sender, approvedDelete.id);
  verificationOutcome = 'failure';
  assert.equal(approvedDeleteResult.state, 'completed');
  await assert.rejects(() => fs.access(proposalDeletePath), { code: 'ENOENT' });
  const proposalDeletePolicy = policyRequests.at(-1);
  assert.equal(proposalDeletePolicy.operation, 'delete');
  assert.deepEqual(proposalDeletePolicy.paths, ['src/delete-target.js']);
  assert.equal(proposalDeletePolicy.deleteConfirmed, true);

  const generatedUndoPath = path.join(projectRoot, 'src', 'generated-undo.js');
  const createForUndoDiff = [
    '--- /dev/null',
    '+++ b/src/generated-undo.js',
    '@@ -0,0 +1 @@',
    '+generated',
    '',
  ].join('\n');
  const generatedProposal = await createProposal(sender, createForUndoDiff);
  await invoke('developer:proposal-approve', sender, generatedProposal.id);
  verificationOutcome = 'pass';
  const generatedResult = await invoke('developer:proposal-apply', sender, generatedProposal.id);
  verificationOutcome = 'failure';
  assert.equal(generatedResult.state, 'completed');
  assert.equal(await fs.readFile(generatedUndoPath, 'utf8'), 'generated\n');
  dialogResponses.push(0, 1);
  await assert.rejects(
    () => invoke('developer:proposal-undo', sender, generatedProposal.id),
    /deletion was not confirmed/i,
  );
  assert.equal(await fs.readFile(generatedUndoPath, 'utf8'), 'generated\n');
  dialogResponses.push(0, 0);
  await invoke('developer:proposal-undo', sender, generatedProposal.id);
  await assert.rejects(() => fs.access(generatedUndoPath), { code: 'ENOENT' });
  assert.equal(policyRequests.at(-1).operation, 'delete');
  assert.equal(policyRequests.at(-1).deleteConfirmed, true);

  // A competing proposal on the same project replaces the single active chain.
  const failure = await failProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 2;'));
  assert.equal(typeof developerAgent.getTaskForTest(failure.proposal.id)?.root, 'string');
  const context = await invoke('developer:verification-repair-context', sender, failure.proposal.id);
  const competing = await createProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 3;'));
  await assert.rejects(
    () => createProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 4;'), { repairToken: context.repairToken }),
    /invalid|expired|active/i,
    'A repair token must not authorize a proposal after another chain replaces it.',
  );
  await invoke('developer:proposal-reject', sender, competing.id);

  // Expiry is exercised through the context IPC, with the chain expiry clock advanced.
  const expiryFailure = await failProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 5;'));
  realNow = Date.now;
  Date.now = () => realNow() + 31 * 60 * 1000;
  await assert.rejects(
    () => invoke('developer:verification-repair-context', sender, expiryFailure.proposal.id),
    /verified rollback|remaining repair attempt/i,
  );
  Date.now = realNow;

  // Exhaustion reports the final failed check and restored file state, not success.
  let lastFailure = await failProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 6;'));
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    const repairContext = await invoke('developer:verification-repair-context', sender, lastFailure.proposal.id);
    const repair = await createProposal(sender, patch('src/app.js', 'const value = 1;', `const value = ${attempt + 5};`), {
      repairToken: repairContext.repairToken,
      attemptNumber: -200,
      repairOf: 'renderer-forged-parent',
    });
    assert.equal(repair.attemptNumber, attempt);
    assert.equal(repair.attemptLabel, `attempt ${attempt} of 3`);
    await assert.rejects(
      () => createProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 99;'), {
        repairToken: repairContext.repairToken,
      }),
      /invalid|expired/i,
      'A used repair token must not authorize another proposal.',
    );
    await invoke('developer:proposal-approve', sender, repair.id);
    lastFailure = {
      proposal: repair,
      result: await invoke('developer:proposal-apply', sender, repair.id, {
        attemptNumber: 1,
        repairOf: 'untrusted-renderer-value',
      }),
    };
    assert.equal(lastFailure.result.attemptNumber, attempt);
    assert.equal(lastFailure.result.verification.status, 'CODE_FAILURE');
  }
  assert.equal(lastFailure.result.chainStatus, 'exhausted');
  assert.equal(lastFailure.result.repairAvailable, false);
  assert.equal(lastFailure.result.attemptLabel, 'attempt 3 of 3');
  assert.equal(lastFailure.result.verification.status, 'CODE_FAILURE');
  assert.match(lastFailure.result.verification.attempts[0].stderr, /assertion failed/);
  assert.match(lastFailure.result.fileState, /current project files|pre-attempt snapshot/i);
  assert.doesNotMatch(lastFailure.result.state, /success|completed/i);
  await assert.rejects(
    () => invoke('developer:verification-repair-context', sender, lastFailure.proposal.id),
    /verified rollback and remaining repair attempt/i,
  );
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');

  // Repair edits to tests/build configuration are flagged; pinned verification scripts remain authoritative.
  const reviewFailure = await failProposal(sender, patch('src/app.js', 'const value = 1;', 'const value = 7;'));
  const reviewContext = await invoke('developer:verification-repair-context', sender, reviewFailure.proposal.id);
  const packageBefore = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
  const oldScriptLine = packageBefore.split('\n').find((line) => line.includes('"test":'));
  const scriptLineNumber = packageBefore.split('\n').indexOf(oldScriptLine) + 1;
  const newScriptLine = oldScriptLine.replace('process.exit(0)', 'process.exit(1)');
  const packagePatch = [
    '--- a/package.json',
    '+++ b/package.json',
    `@@ -${scriptLineNumber},1 +${scriptLineNumber},1 @@`,
    `-${oldScriptLine}`,
    `+${newScriptLine}`,
    '',
  ].join('\n');
  const multiPatch = [
    patch('tests/sample.test.js', 'test("sample", () => {});', 'test("changed", () => {});'),
    patch('scripts/verify.js', 'process.exit(0);', 'process.exit(1);'),
    patch('vite.config.js', 'export default { test: true };', 'export default { test: false };'),
    packagePatch,
  ].join('');
  const tamperedRepair = await createProposal(sender, multiPatch, { repairToken: reviewContext.repairToken });
  assert.ok(tamperedRepair.reviewFlags.includes('test-file'));
  assert.ok(tamperedRepair.reviewFlags.includes('verification-or-build-configuration'));
  assert.ok(tamperedRepair.reviewFlags.includes('package-script-or-dependency-manifest'));
  assert.deepEqual(tamperedRepair.verificationScripts, ['test']);
  await invoke('developer:proposal-approve', sender, tamperedRepair.id);
  const verificationCallsBeforeTamperApply = verificationCalls;
  const tamperResult = await invoke('developer:proposal-apply', sender, tamperedRepair.id);
  assert.equal(tamperResult.verification.status, 'UNVERIFIED');
  assert.equal(verificationCalls, verificationCallsBeforeTamperApply, 'The pinned allow-listed command must not run after its config is modified.');
  assert.equal(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'), packageBefore);

  // No available verification script can never be surfaced as a successful apply.
  const noScriptSender = senderFor(2);
  const noScriptRoot = await createProject(noScriptSender, false);
  projectRootBySender.set(noScriptSender.id, noScriptRoot);
  await assert.rejects(
    () => invoke('developer:task-checkpoint-restore-disk', noScriptSender, { taskId: initial.id }),
    /different Coding Agent (session|project)/i,
  );
  const noScriptProposal = await createProposal(
    noScriptSender,
    patch('src/app.js', 'const value = 1;', 'const value = 8;'),
  );
  await invoke('developer:proposal-approve', noScriptSender, noScriptProposal.id);
  const noScriptResult = await invoke('developer:proposal-apply', noScriptSender, noScriptProposal.id);
  assert.equal(noScriptResult.state, 'failed');
  assert.equal(noScriptResult.verification.status, 'UNVERIFIED');
  assert.notEqual(noScriptResult.chainStatus, 'completed');
  assert.equal(await fs.readFile(path.join(noScriptRoot, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');

  const alternateProjectRoot = await createProject(sender);
  await assert.rejects(
    () => invoke('developer:task-checkpoint-restore-disk', sender, { taskId: initial.id }),
    /different Coding Agent project/i,
  );
  await invoke('developer:project-attach', sender, { projectRoot });
  projectRootBySender.set(sender.id, projectRoot);
  assert.equal(alternateProjectRoot !== projectRoot, true);

  console.log('Main-process repair IPC integration tests passed.');
} finally {
  if (realNow) Date.now = realNow;
  Module._load = originalLoad;
  developerFiles.runVerification = originalRunVerification;
  globalThis.fetch = originalFetch;
  if (mainLoaded) {
    const closeHandler = electronMock.app.listeners('will-quit')[0];
    closeHandler?.();
  }
  await developerAgent.flushDurability();
  for (const root of projectRoots) await fs.rm(root, { recursive: true, force: true });
  await fs.rm(userData, { recursive: true, force: true });
}
