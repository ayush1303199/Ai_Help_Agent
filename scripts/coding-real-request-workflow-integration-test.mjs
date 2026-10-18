import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  digestText,
  evaluateRealTaskDataset,
  QUALITY_DIMENSIONS,
  REAL_TASK_RUBRIC_VERSION,
} from './coding-agent-real-task-evaluator.mjs';
import { classifyCodingRequestIntent } from '../src/features/coding/codingTransport.ts';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;

const handlers = new Map();
const windows = [];
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-workflow-ipc-userdata-'));
const projectRoots = new Set();
const dialogRequests = [];
const dialogResponses = [];

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
  contextBridge: {
    exposeInMainWorld(key, api) {
      exposedWorld.set(key, api);
    },
  },
  ipcRenderer: Object.assign(new EventEmitter(), {
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      const sender = windows[0]?.webContents;
      return handler({ sender, senderFrame: { url: sender?.getURL() } }, ...args);
    },
  }),
};
const exposedWorld = new Map();

class FakeWebContents extends EventEmitter {
  constructor(url = 'http://localhost:3000/') {
    super();
    this.id = windows.length + 1;
    this.url = url;
    this.sentMessages = [];
  }
  getURL() { return this.url; }
  send(channel, ...args) {
    this.sentMessages.push({ channel, args });
    electronMock.ipcRenderer.emit(channel, {}, ...args);
  }
  setWindowOpenHandler() {}
  loadURL(url) { this.url = url; }
  isDestroyed() { return false; }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.webContents = options instanceof FakeWebContents ? options : new FakeWebContents();
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

// Require production main.cjs to register real IPC handlers
require('../electron/main.cjs');
require('../electron/preload.cjs');
for (let index = 0; index < 200 && (!handlers.has('developer:workflow-execute') || windows.length === 0); index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

assert.ok(handlers.has('developer:workflow-execute'), 'The actual main-process developer:workflow-execute IPC handler did not register.');

const invokeIpc = async (name, sender, ...args) => {
  const handler = handlers.get(name);
  assert.ok(handler, `Missing IPC handler: ${name}`);
  return handler({ sender, senderFrame: { url: sender.getURL() } }, ...args);
};

try {
  const sender = windows[0].webContents;

  // Initialize Developer Session via real IPC
  const sessionRes = await invokeIpc('developer:session', sender);
  assert.ok(sessionRes.sessionId, 'Developer session must be initialized');

  // TEST 1: Security Gates — Untrusted Sender & Unattached Project Rejection
  const untrustedSender = { id: 999999, getURL: () => 'http://attacker.com/' };

  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', untrustedSender, { userRequest: 'fix something' }),
    /main AI Help Agent window/i,
    'Untrusted sender must be rejected fail-closed.'
  );

  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', sender, { userRequest: 'fix something' }),
    /not owned by this renderer session|PROJECT_NOT_ATTACHED/i,
    'Workflow execute before project attach must be rejected fail-closed.'
  );

  // Set up real temporary fixture repository
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-real-workflow-fixture-'));
  projectRoots.add(projectDir);

  await fs.mkdir(path.join(projectDir, 'modules', 'profile', 'controllers'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'tests'), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'fixture-app', version: '1.0.0', scripts: { test: 'node tests/profile.test.js' } }, null, 2),
    'utf8'
  );

  const initialProfileController = `<?php
namespace app\\modules\\profile\\controllers;
class FormController {
    public function actionSave() {
        var_dump($_POST); die('DEBUG_HALT');
        return ['status' => 'saved'];
    }
}
`;
  await fs.writeFile(
    path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
    initialProfileController,
    'utf8'
  );

  // Attach project via real IPC
  await invokeIpc('developer:project-attach', sender, { projectRoot: projectDir });

  // TEST 2: Real Production Entry Point Invokes Workflow & Streams Activity
  // Sub-case A: Empty / Missing Request Rejection
  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', sender, { userRequest: '' }),
    /user request is required/i,
    'Empty request must be rejected.'
  );

  // Sub-case B: Ambiguity Detection & Clarification Prompt (zero files modified)
  sender.sentMessages.length = 0;
  const clarificationResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'make the performance faster',
  });
  assert.equal(clarificationResult.outcome, 'CLARIFICATION_REQUIRED');
  assert.equal(clarificationResult.phase, 'UNDERSTAND');
  assert.equal(clarificationResult.filesModified.length, 0);
  assert.ok(clarificationResult.clarificationPrompt, 'Clarification prompt must be provided');

  // Verify activity events were streamed to sender
  const understandActivity = sender.sentMessages.find((m) => m.channel === 'developer:activity' && m.args[0]?.phase === 'UNDERSTAND');
  assert.ok(understandActivity, 'UNDERSTAND activity event must be streamed to renderer');

  // TEST 3: Approval Gate Enforcement (Fail-Closed when unapproved)
  sender.sentMessages.length = 0;
  const dialogCountBeforeForgedApproval = dialogRequests.length;
  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      userApproved: true,
    }),
    /renderer-supplied approval claims are not accepted/i,
    'Renderer approval claims must be rejected before workflow execution.'
  );
  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      autoApprove: true,
    }),
    /renderer-supplied approval claims are not accepted/i,
    'Renderer auto-approval claims must be rejected before workflow execution.'
  );
  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      requestApproval: async () => true,
    }),
    /renderer-supplied approval claims are not accepted/i,
    'Renderer-provided approval callbacks must be rejected before workflow execution.'
  );
  assert.equal(dialogRequests.length, dialogCountBeforeForgedApproval, 'Forged approval claims must not open or satisfy the approval prompt.');

  dialogResponses.push(0);
  const unapprovedResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'fix debug probe and die in profile form controller',
  });
  assert.equal(unapprovedResult.outcome, 'APPROVAL_REJECTED');
  assert.equal(unapprovedResult.phase, 'APPROVE');
  assert.equal(unapprovedResult.filesModified.length, 0);
  assert.equal(unapprovedResult.codeApplied, false);
  const rejectedApproval = dialogRequests.at(-1);
  assert.equal(rejectedApproval.buttons[0], 'Reject proposal');
  assert.equal(rejectedApproval.buttons[1], 'Approve exact proposal');
  assert.match(rejectedApproval.detail, /Exact proposed diff:/);
  assert.match(rejectedApproval.detail, /FormController\.php/);
  assert.match(rejectedApproval.detail, /Manifest: [a-f0-9]{64}/i);

  // Verify file on disk remained 100% untouched
  const untouchedContent = await fs.readFile(
    path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
    'utf8'
  );
  assert.equal(untouchedContent, initialProfileController, 'File must not be modified when unapproved');

  // TEST 4: Scope Expansion Rejection
  const devAgent = require('../electron/developerAgent.cjs');
  const unapprovedGate = devAgent.enforceApprovalGate({
    originalProposalTargets: ['modules/profile/controllers/FormController.php'],
    attemptedMutationTargets: [
      'modules/profile/controllers/FormController.php',
      'modules/billing/controllers/PaymentController.php', // Unapproved target!
    ],
    userApproved: true,
  });
  assert.equal(unapprovedGate.allowed, false);
  assert.match(unapprovedGate.rejectionReason, /scope expansion/i);

  // TEST 5: Failed Verification Diagnosis & Bounded Repair Governance
  const devFiles = require('../electron/developerFiles.cjs');
  const originalRunVerification = devFiles.runVerification;

  // Mock verification runner to simulate failing test
  devFiles.runVerification = async () => ({
    ok: false,
    status: 'CODE_FAILURE',
    executed: true,
    exitCode: 1,
    stdout: '',
    stderr: 'PHP Fatal error: Syntax error',
  });

  try {
    dialogResponses.push(1);
    const failedResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      autoRepairEnabled: false,
    });

    assert.equal(failedResult.outcome, 'TEST_FAILED');
    assert.equal(failedResult.codeApplied, false);
    assert.equal(failedResult.codeVerified, false);
    assert.equal(failedResult.filesModified.length, 0);

    // Rollback must have restored the original file
    const rolledBackContent = await fs.readFile(
      path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
      'utf8'
    );
    assert.equal(rolledBackContent, initialProfileController, 'Failed test must trigger rollback');
  } finally {
    devFiles.runVerification = originalRunVerification;
  }

  // TEST 6: Successful End-to-End Execution with Approved Proposal & Passing Verification
  // Mock verification runner to simulate passing test
  devFiles.runVerification = async () => ({
    ok: true,
    status: 'PASS',
    executed: true,
    exitCode: 0,
    stdout: 'OK (1 test, 1 assertion)',
    stderr: '',
  });

  try {
    dialogResponses.push(1);
    const successResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      autoRepairEnabled: false,
    });

    assert.equal(successResult.outcome, 'SUCCESS');
    assert.equal(successResult.phase, 'AUDIT');
    assert.equal(successResult.codeApplied, true);
    assert.equal(successResult.codeVerified, true);
    assert.deepEqual(successResult.filesModified, ['modules/profile/controllers/FormController.php']);
    assert.match(dialogRequests.at(-1).detail, /Exact proposed diff:/);
    assert.match(dialogRequests.at(-1).detail, /Manifest: [a-f0-9]{64}/i);

    // Verify file on disk was patched cleanly
    const patchedContent = await fs.readFile(
      path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
      'utf8'
    );
    assert.ok(!patchedContent.includes('die('), 'die() must be removed by patch');
    assert.ok(!patchedContent.includes('var_dump('), 'var_dump() must be removed by patch');
  } finally {
    devFiles.runVerification = originalRunVerification;
  }

  // TEST 7: Real-Task Evaluator Consumes Workflow Record and Rejects Agent Self-Authored Evidence
  const defaultIdentity = {
    projectId: 'fixture-app',
    rootDigest: digestText('digest-001'),
    branch: 'ayush1303199-run-project',
    head: '0cd301f52e90c2889ef156e1fe0bb6d8923245b3',
    evidenceId: 'agent-authored-identity',
  };

  const evalTask = {
    taskId: 'T01',
    taskVersion: 'v1',
    acceptanceCriteria: [
      { id: 'behavior-correct', required: true },
    ],
    requiredChecks: [{ checkId: 'focused-test', command: 'node tests/profile.test.js' }],
    allowedPaths: ['modules/profile/controllers/FormController.php'],
    prohibitedOperations: [],
    approvalRequiredOperations: [],
    stopRequired: false,
    stopEvidenceKinds: [],
    maxRepairAttempts: 1,
  };

  function makeEvidence(id, kind, state = 'unverified', binding = {}) {
    return {
      id,
      kind,
      state,
      reference: `evidence://${id}`,
      sha256: digestText(id),
      provenance: state === 'independently-verified' ? 'independently-collected' : 'agent-authored',
      taskId: evalTask.taskId,
      taskVersion: evalTask.taskVersion,
      runId: 'run-ipc-001',
      attemptNumber: 1,
      projectId: defaultIdentity.projectId,
      rootDigest: defaultIdentity.rootDigest,
      branch: defaultIdentity.branch,
      head: defaultIdentity.head,
      observedAt: '2026-10-18T08:00:30.000Z',
      scopePaths: ['modules/profile/controllers/FormController.php'],
      acceptanceCriterionIds: [],
      checkId: null,
      command: null,
      exitCode: null,
      repositorySnapshotPhase: null,
      ...binding,
    };
  }

  const beforeSnapshot = makeEvidence('before-snap', 'repository-snapshot', 'independently-verified', {
    observedAt: '2026-10-18T08:00:00.000Z',
    repositorySnapshotPhase: 'before',
  });
  const afterSnapshot = makeEvidence('after-snap', 'repository-snapshot', 'independently-verified', {
    observedAt: '2026-10-18T08:01:00.000Z',
    repositorySnapshotPhase: 'after',
  });

  const dimensionAssessments = Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [
    dimension,
    { status: 'unverified', evidenceIds: ['review-result'], justification: null },
  ]));

  const dataset = {
    schemaVersion: 1,
    datasetId: 'real-workflow-integration-eval',
    rubricVersion: REAL_TASK_RUBRIC_VERSION,
    agent: { name: 'ai-help-agent-coding', version: '0.1.0', buildId: 'local-test' },
    tasks: [evalTask],
    records: [{
      taskId: evalTask.taskId,
      taskVersion: evalTask.taskVersion,
      rubricVersion: REAL_TASK_RUBRIC_VERSION,
      agent: { name: 'ai-help-agent-coding', version: '0.1.0', buildId: 'local-test' },
      runId: 'run-ipc-001',
      attemptNumber: 1,
      state: 'completed',
      reportedSuccess: true,
      projectIdentity: { ...defaultIdentity },
      startedAt: '2026-10-18T08:00:00.000Z',
      endedAt: '2026-10-18T08:01:00.000Z',
      acceptance: [{
        criterionId: 'behavior-correct',
        state: 'completed',
        evidenceIds: ['agent-authored-acceptance'],
      }],
      changedPaths: ['modules/profile/controllers/FormController.php'],
      actions: [],
      checks: [{
        checkId: 'focused-test',
        command: 'node tests/profile.test.js',
        state: 'passed',
        exitCode: 0,
        evidenceId: 'agent-authored-test',
      }],
      repositoryObservations: {
        beforeEvidenceId: beforeSnapshot.id,
        afterEvidenceId: afterSnapshot.id,
        changedPaths: ['modules/profile/controllers/FormController.php'],
      },
      evidence: [
        makeEvidence('agent-authored-identity', 'project-identity', 'unverified'),
        makeEvidence('agent-authored-acceptance', 'acceptance-result', 'unverified', {
          acceptanceCriterionIds: ['behavior-correct'],
        }),
        makeEvidence('agent-authored-test', 'test-result', 'unverified', {
          checkId: 'focused-test',
          command: 'node tests/profile.test.js',
          exitCode: 0,
        }),
        makeEvidence('review-result', 'independent-review', 'independently-verified'),
        beforeSnapshot,
        afterSnapshot,
      ],
      review: {
        decision: 'accepted',
        reviewerId: 'reviewer-7',
        evidenceId: 'review-result',
        commit: 'commit-abc',
        diffSha256: digestText('diff'),
        dimensionAssessments,
      },
      elapsedSeconds: 60,
    }],
  };

  const evalResult = evaluateRealTaskDataset(dataset);
  assert.equal(evalResult.independentHostEvidenceStatus, 'NOT_ESTABLISHED');
  assert.equal(evalResult.realTaskPerformanceEstablished, false);
  assert.equal(evalResult.capabilityImprovementEstablished, false);
  assert.equal(evalResult.tasks[0].verifiedCompletion, false);
  assert.ok(
    evalResult.tasks[0].records[0].issues.length > 0,
    'Evaluator must record issues when agent evidence is unverified.'
  );
  assert.ok(
    evalResult.tasks[0].records[0].issues.some((issue) => issue.includes('without independently verified evidence') || issue.includes('untrusted') || issue.includes('missing')),
    'Evaluator must reject unverified agent completion claim.'
  );

  // TEST 8: Unavailable Verification Runner (Returns VERIFICATION_UNAVAILABLE, Rolls Back, No False Completion)
  await fs.writeFile(
    path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
    initialProfileController,
    'utf8'
  );
  devFiles.runVerification = async () => ({
    ok: false,
    status: 'VERIFICATION_UNAVAILABLE',
    executed: false,
    exitCode: 127,
    stdout: '',
    stderr: 'Test runner binary not found on host.',
  });

  try {
    dialogResponses.push(1);
    const unavailableResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      autoRepairEnabled: false,
    });

    assert.equal(unavailableResult.outcome, 'VERIFICATION_UNAVAILABLE');
    assert.equal(unavailableResult.codeApplied, false);
    assert.equal(unavailableResult.codeVerified, false);
    assert.equal(unavailableResult.filesModified.length, 0);

    const rolledBackContent = await fs.readFile(
      path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
      'utf8'
    );
    assert.equal(rolledBackContent, initialProfileController, 'Unavailable verification runner must trigger clean rollback.');
  } finally {
    devFiles.runVerification = originalRunVerification;
  }

  // TEST 9: Skipped Verification Check Fails Verification Gate (Eliminates False Success)
  await fs.writeFile(
    path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
    initialProfileController,
    'utf8'
  );
  devFiles.runVerification = async () => ({
    ok: true,
    status: 'SKIPPED',
    skipped: true,
    executed: true,
    exitCode: 0,
    stdout: 'Tests skipped: 0 tests executed.',
    stderr: '',
  });

  try {
    dialogResponses.push(1);
    const skippedResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      autoRepairEnabled: false,
    });

    assert.notEqual(skippedResult.outcome, 'SUCCESS', 'Skipped verification must NEVER yield SUCCESS outcome.');
    assert.equal(skippedResult.codeVerified, false);
    assert.equal(skippedResult.codeApplied, false);
    assert.equal(skippedResult.filesModified.length, 0);

    const rolledBackContent = await fs.readFile(
      path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
      'utf8'
    );
    assert.equal(rolledBackContent, initialProfileController, 'Skipped verification must trigger rollback to preserve worktree.');
  } finally {
    devFiles.runVerification = originalRunVerification;
  }

  // TEST 10: Missing or Malformed Verification Evidence Rejected Fail-Closed
  assert.equal(devAgent.isSuccessfulVerificationResult(null), false);
  assert.equal(devAgent.isSuccessfulVerificationResult(undefined), false);
  assert.equal(devAgent.isSuccessfulVerificationResult({ attempts: [] }), false);
  assert.equal(devAgent.isSuccessfulVerificationResult({ status: 'PASS', skipped: true }), false);
  assert.equal(devAgent.isSuccessfulVerificationResult({ status: 'PASS', cancelled: true }), false);
  assert.equal(devAgent.isSuccessfulVerificationResult({ status: 'PASS', timedOut: true }), false);
  assert.equal(devAgent.isSuccessfulVerificationAttempt({ ok: true, exitCode: 0, skipped: true }), false);
  assert.equal(devAgent.isSuccessfulVerificationAttempt({ ok: true, exitCode: 0, cancelled: true }), false);
  assert.equal(devAgent.normalizeVerificationStatus({ ok: true, skipped: true }), 'SKIPPED');
  assert.equal(devAgent.normalizeVerificationStatus({ ok: false, status: 'VERIFICATION_UNAVAILABLE' }), 'VERIFICATION_UNAVAILABLE');

  // TEST 11: Stale Baseline Snapshot / Concurrent File Edit Before Apply Fails Closed
  await fs.writeFile(
    path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
    initialProfileController,
    'utf8'
  );
  // Hook showMessageBox to simulate concurrent race edit right as approval is given
  const originalShowMessageBox = electronMock.dialog.showMessageBox;
  electronMock.dialog.showMessageBox = async (_window, options) => {
    dialogRequests.push(options);
    // Concurrent external write modifies target file before apply runs
    await fs.writeFile(
      path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
      '<?php // concurrent external edit ?>\n',
      'utf8'
    );
    return { response: 1 }; // User approves based on earlier snapshot
  };

  try {
    const concurrentResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      autoRepairEnabled: false,
    });

    assert.equal(concurrentResult.phase, 'IMPLEMENT');
    assert.equal(concurrentResult.outcome, 'APPLY_FAILED');
    assert.equal(concurrentResult.codeVerified, false);
    assert.match(concurrentResult.error, /snapshot|mismatch|modified|changed/i);
  } finally {
    electronMock.dialog.showMessageBox = originalShowMessageBox;
    // Restore clean initial file
    await fs.writeFile(
      path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
      initialProfileController,
      'utf8'
    );
  }

  // TEST 12: Cancelled Workflow Fails Closed with Cancelled State & No False Completion
  const cancelledTurn = devAgent.beginConversationTurn({
    root: projectDir,
    request: 'inspect background tasks',
    sessionId: sessionRes.sessionId,
    ownerWebContentsId: sender.id,
    scope: '.',
  });
  assert.ok(cancelledTurn?.turnId);
  devAgent.cancelSession(sender.id);
  const turnAfterCancel = devAgent.getConversationTurn(cancelledTurn.turnId, { sessionId: sessionRes.sessionId, ownerWebContentsId: sender.id });
  assert.equal(turnAfterCancel.state, 'cancelled', 'cancelSession must transition active turn to cancelled.');

  // TEST 13: Incomplete Investigation Fails Closed (No False Root Cause or Premature No-Defect Claim)
  const incompleteResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'investigate missingNonExistentMethodCallInUnreferencedModule that is failing',
  });
  assert.equal(incompleteResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(incompleteResult.phase, 'INVESTIGATE');
  assert.equal(incompleteResult.findings.length, 0);
  assert.equal(incompleteResult.filesModified.length, 0);
  assert.equal(incompleteResult.codeApplied, false);
  assert.equal(incompleteResult.codeVerified, false);
  assert.equal(incompleteResult.continuation?.status, 'READY_TO_RESUME');
  assert.match(incompleteResult.message, /investigation is incomplete/i);

  // TEST 14: Bounded Repair Governance Enforced (Clamped to at Most 3 Attempts)
  let loopCheckAttempts = 0;
  const loopResult = await devAgent.runEngineeringLoop({
    taskId: null,
    owner: { sessionId: sessionRes.sessionId, ownerWebContentsId: sender.id },
    checks: ['test'],
    maxAttempts: 100, // Request an excessive number of repair attempts
    runCheck: async () => {
      loopCheckAttempts += 1;
      return { ok: false, status: 'CODE_FAILURE', exitCode: 1, stderr: 'still failing' };
    },
    proposeFix: async () => null,
    approveFix: async () => true,
    applyFix: async () => {},
  });
  assert.ok(loopCheckAttempts <= 3, `Engineering loop attempts must be clamped to <= 3 (got ${loopCheckAttempts})`);
  assert.ok(loopResult.attempts.length <= 3, `Loop attempts array must be clamped to <= 3`);

  // TEST 15: Preload Bridge Invocation (electron/preload.cjs Contract Compliance)
  assert.ok(exposedWorld.has('electronAPI'), 'electron/preload.cjs must expose electronAPI in main world.');
  const exposedApi = exposedWorld.get('electronAPI');
  assert.equal(typeof exposedApi.executeDeveloperWorkflow, 'function', 'executeDeveloperWorkflow must be exposed in electronAPI.');
  assert.equal(typeof exposedApi.onDeveloperActivity, 'function', 'onDeveloperActivity must be exposed in electronAPI.');

  // Exercise executeDeveloperWorkflow through the preload bridge
  const bridgeClarification = await exposedApi.executeDeveloperWorkflow({
    userRequest: 'make the performance faster',
  });
  assert.equal(bridgeClarification.outcome, 'CLARIFICATION_REQUIRED', 'Preload bridge must route workflow request correctly.');
  assert.equal(bridgeClarification.phase, 'UNDERSTAND');

  // TEST 16: Intent Classification Routing Accuracy (classifyCodingRequestIntent)
  const q1 = classifyCodingRequestIntent('How does the authorization ledger verify HMAC signatures?');
  assert.equal(q1.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q1.isActionableTask, false);

  const q2 = classifyCodingRequestIntent('What does developerAgent.cjs do?');
  assert.equal(q2.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q2.isActionableTask, false);

  const q3 = classifyCodingRequestIntent('explain the verification runner policy');
  assert.equal(q3.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q3.isActionableTask, false);

  const c1 = classifyCodingRequestIntent('');
  assert.equal(c1.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c1.isActionableTask, false);
  assert.ok(c1.clarificationPrompt);

  const c2 = classifyCodingRequestIntent('make it better');
  assert.equal(c2.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c2.isActionableTask, false);
  assert.ok(c2.clarificationPrompt);

  const a1 = classifyCodingRequestIntent('fix debug probe and die in profile form controller');
  assert.equal(a1.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a1.isActionableTask, true);

  const a2 = classifyCodingRequestIntent('investigate why the user details test is failing');
  assert.equal(a2.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a2.isActionableTask, true);

  // TEST 17: Preload Bridge End-to-End Execution with Real-Time Activity Streaming
  await fs.writeFile(
    path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
    initialProfileController,
    'utf8'
  );

  devFiles.runVerification = async () => ({
    ok: true,
    status: 'PASS',
    executed: true,
    exitCode: 0,
    stdout: 'OK (1 test, 1 assertion)',
    stderr: '',
  });

  const streamedActivities = [];
  const unsubscribe = exposedApi.onDeveloperActivity((activity) => {
    streamedActivities.push(activity);
  });

  try {
    dialogResponses.push(1); // User approves native dialog
    const endToEndResult = await exposedApi.executeDeveloperWorkflow({
      userRequest: 'fix debug probe and die in profile form controller',
      autoRepairEnabled: false,
    });

    assert.equal(endToEndResult.outcome, 'SUCCESS');
    assert.equal(endToEndResult.codeApplied, true);
    assert.equal(endToEndResult.codeVerified, true);
    assert.ok(endToEndResult.filesModified.length > 0);

    // Verify activity stream received workflow progress events
    assert.ok(streamedActivities.length > 0, 'onDeveloperActivity must receive streamed workflow events');
    assert.ok(
      streamedActivities.some((act) => act.type === 'workflow_progress' || act.event === 'activity_event'),
      'Streamed activities must contain workflow_progress or activity_event'
    );

    const phasesSeen = streamedActivities.map((act) => act.phase).filter(Boolean);
    assert.ok(phasesSeen.includes('DISCOVER') || phasesSeen.includes('INVESTIGATE') || phasesSeen.includes('PLAN'));
  } finally {
    unsubscribe();
    devFiles.runVerification = originalRunVerification;
  }

  // TEST 18: Security & Reentrancy Guards (Bypassing Approval Rejection & Single Flight)
  // Renderer-supplied approval claims must be rejected fail-closed
  await assert.rejects(
    async () => exposedApi.executeDeveloperWorkflow({
      userRequest: 'fix something',
      userApproved: true,
    }),
    /Renderer-supplied approval claims are not accepted/i,
    'Renderer-supplied approval claims must be rejected fail-closed via preload bridge.'
  );

  await assert.rejects(
    async () => exposedApi.executeDeveloperWorkflow({
      userRequest: 'fix something',
      autoApprove: true,
    }),
    /Renderer-supplied approval claims are not accepted/i,
    'Renderer-supplied autoApprove claims must be rejected fail-closed via preload bridge.'
  );

  console.log('Real request-to-code workflow IPC integration verified successfully.');
} finally {
  for (const root of projectRoots) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
  await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
}
