import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

console.log('Starting Milestone V28.1 — Real UI Workflow & IPC Lifecycle Verification Test...');

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;

const testCodingAuthToken = randomBytes(32).toString('base64url');
const testMutationHandshakeSecret = randomBytes(32).toString('base64url');
process.env.AI_CODING_AUTH_TOKEN = testCodingAuthToken;
process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET = testMutationHandshakeSecret;
process.env.AI_CODING_E2E_INLINE_APPROVAL = '1';

const handlers = new Map();
const windows = [];
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'v28-ui-workflow-userdata-'));
const projectRoots = new Set();

const inlineApprovalRequests = [];
const inlineApprovalDecisions = [];
let pendingApprovalResolver = null;

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
    showMessageBox: async () => ({ response: 0 }),
    showErrorBox() {},
  },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: Object.assign(new EventEmitter(), {
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      const sender = windows[0]?.webContents;
      return handler({ sender, senderFrame: { url: sender?.getURL() } }, ...args);
    },
  }),
};

class FakeWebContents extends EventEmitter {
  constructor(url = 'http://localhost:5173/') {
    super();
    this.id = windows.length + 1;
    this.url = url;
    this.sentMessages = [];
  }
  getURL() { return this.url; }
  send(channel, ...args) {
    this.sentMessages.push({ channel, args });
    if (channel === 'developer:workflow-approval-pending') {
      const approval = args[0];
      inlineApprovalRequests.push(approval);
      if (pendingApprovalResolver) {
        const resolve = pendingApprovalResolver;
        pendingApprovalResolver = null;
        resolve(approval);
      }
    }
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
  static getFocusedWindow() { return windows[0] || null; }
  static fromWebContents(contents) {
    return windows.find((window) => window.webContents === contents) || null;
  }
}
electronMock.BrowserWindow = FakeBrowserWindow;

Module._load = function mockElectronLoad(request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

const devFiles = require('../electron/developerFiles.cjs');
const devAgent = require('../electron/developerAgent.cjs');

// Import real electron main entry to register authentic IPC handlers
await import('../electron/main.cjs');

// Wait for IPC handlers to register
for (let i = 0; i < 200 && !handlers.has('developer:workflow-execute'); i++) {
  await new Promise((r) => setTimeout(r, 10));
}
assert.ok(handlers.has('developer:workflow-execute'), 'developer:workflow-execute IPC handler must be registered.');
assert.ok(handlers.has('developer:workflow-approval-decision'), 'developer:workflow-approval-decision IPC handler must be registered.');

const invokeIpc = async (name, sender, ...args) => {
  const handler = handlers.get(name);
  assert.ok(handler, `Missing IPC handler: ${name}`);
  return handler({ sender, senderFrame: { url: sender.getURL() } }, ...args);
};

const fixtureRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-v28-ui-workflow-fixture-'));

try {
  const sender = windows[0].webContents;

  // Initialize Developer Session via real IPC
  const sessionRes = await invokeIpc('developer:session', sender);
  assert.ok(sessionRes.sessionId, 'Developer session must be initialized');

  // =========================================================================
  // Test 1: Project Identity & Untrusted Sender Security Validation
  // =========================================================================
  console.log('\nTest 1: Project Identity & Untrusted Sender Validation through real IPC...');
  const untrustedSender = { id: 999999, getURL: () => 'http://attacker.com/' };

  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', untrustedSender, { userRequest: 'test the project' }),
    /main AI Help Agent window/i,
    'Untrusted sender must be rejected fail-closed.'
  );

  await assert.rejects(
    async () => invokeIpc('developer:workflow-execute', sender, { userRequest: 'test the project' }),
    /not owned by this renderer session|PROJECT_NOT_ATTACHED/i,
    'Workflow execute before project attach must be rejected fail-closed.'
  );
  console.log('  -> Test 1 passed: Security boundaries enforced.');

  // =========================================================================
  // Test 2: Dedicated Synthetic Fixture Setup (Isolated from Hello)
  // =========================================================================
  console.log('\nTest 2: Setting up dedicated synthetic fixture...');
  const projectDir = path.join(fixtureRoot, 'discount-service');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'tests'), { recursive: true });

  await fs.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'discount-service',
      version: '1.0.0',
      scripts: { test: 'node tests/calc.test.js' },
    }, null, 2),
    'utf8'
  );

  const initialCalculatorJs = [
    'function getStatusCode() {',
    '  // Initial defect: returns 500 instead of 200',
    '  return 500;',
    '}',
    'module.exports = { getStatusCode };',
    '',
  ].join('\n');
  await fs.writeFile(path.join(projectDir, 'src', 'calculator.js'), initialCalculatorJs, 'utf8');

  const testJs = [
    'const assert = require("node:assert/strict");',
    'const { getStatusCode } = require("../src/calculator.js");',
    'assert.equal(getStatusCode(), 200, "expected 200 but received 500 at src/calculator.js:3:10");',
    'console.log("PASS: Status code test passed");',
  ].join('\n');
  await fs.writeFile(path.join(projectDir, 'tests', 'calc.test.js'), testJs, 'utf8');

  // Attach project via real IPC
  const attachResult = await invokeIpc('developer:project-attach', sender, { projectRoot: projectDir });
  assert.equal(attachResult.status, 'PROJECT_ATTACHED', 'Project must attach successfully');
  console.log('  -> Test 2 passed: Project attached via real developer:project-attach IPC.');

  // =========================================================================
  // Test 3: Real UI-to-Workflow Path (Execute -> Fail -> Diagnose -> Repair Prompt -> User Approval -> Retest -> Pass)
  // =========================================================================
  console.log('\nTest 3: End-to-End Real UI-to-Workflow Lifecycle Execution...');

  let testRunCount = 0;
  const capturedExecutions = [];

  // Mock container runner injected into workflow execution options
  const mockContainerRunner = {
    execute: async () => {
      testRunCount++;
      const currentDisk = await fs.readFile(path.join(projectDir, 'src', 'calculator.js'), 'utf8');

      if (testRunCount === 1) {
        // Initial run fails with real error
        const failRecord = {
          ok: false,
          status: 'FAILED',
          exitCode: 1,
          stdout: '',
          stderr: 'AssertionError: expected 200 but received 500 at src/calculator.js:3:10',
        };
        capturedExecutions.push(failRecord);
        return failRecord;
      }

      // Retest passes with exit code 0
      assert.ok(currentDisk.includes('return 200;'), 'Retest must run against repaired disk content');
      const passRecord = {
        ok: true,
        status: 'PASSED',
        exitCode: 0,
        stdout: 'PASS: Status code test passed\n  √ all assertions passed',
        stderr: '',
      };
      capturedExecutions.push(passRecord);
      return passRecord;
    },
  };

  // Launch workflow via real UI IPC handler: developer:workflow-execute
  const workflowPromise = invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'test the project',
    scope: '.',
    autoRepairEnabled: true,
    tools: { containerRunner: mockContainerRunner },
  });

  // Wait for the inline approval event emitted from main process
  let approvalEvent;
  for (let i = 0; i < 100 && inlineApprovalRequests.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(inlineApprovalRequests.length > 0, 'UI must receive developer:workflow-approval-pending event');
  approvalEvent = inlineApprovalRequests[0];

  // CRITICAL CHECK: Verify disk has NOT been modified before approval decision
  const diskBeforeApproval = await fs.readFile(path.join(projectDir, 'src', 'calculator.js'), 'utf8');
  assert.equal(diskBeforeApproval, initialCalculatorJs, 'Disk MUST remain strictly unmodified before approval');
  assert.ok(approvalEvent.diff.includes('-  return 500;'), 'Approval diff must show defect removal');
  assert.ok(approvalEvent.diff.includes('+  return 200;'), 'Approval diff must show repair addition');

  // Send explicit approval decision through real UI IPC handler: developer:workflow-approval-decision
  console.log('  -> Simulating UI clicking [Approve] button via developer:workflow-approval-decision...');
  const decisionResult = await invokeIpc('developer:workflow-approval-decision', sender, {
    approvalRequestId: approvalEvent.approvalRequestId,
    proposalId: approvalEvent.proposalId,
    proposalDigest: approvalEvent.proposalDigest,
    approved: true,
  });
  assert.equal(decisionResult.approved, true, 'Approval decision must be recorded as approved');

  // Wait for workflow to finish
  const workflowResult = await workflowPromise;

  assert.equal(workflowResult.outcome, 'COMPLETED', `Workflow must complete with COMPLETED, got ${workflowResult.outcome}`);
  assert.equal(workflowResult.status, 'TESTS_PASSED');
  assert.equal(workflowResult.codeApplied, true, 'Code change must be applied');
  assert.equal(workflowResult.codeVerified, true, 'Code change must be verified');

  // Verify test executions
  assert.equal(capturedExecutions.length, 2, 'Must have executed test twice (initial failure + retest)');
  assert.equal(capturedExecutions[0].exitCode, 1, 'First test run must have exit code 1');
  assert.equal(capturedExecutions[1].exitCode, 0, 'Retest must have exit code 0');

  // Verify file on disk contains the repaired code
  const finalDiskContent = await fs.readFile(path.join(projectDir, 'src', 'calculator.js'), 'utf8');
  assert.ok(finalDiskContent.includes('return 200;'), 'File on disk must contain repaired code');
  console.log('  -> Test 3 passed: Real UI-to-workflow path verified end-to-end.');

  // =========================================================================
  // Test 4: Real UI Rejection Gate Enforces 0 Mutations
  // =========================================================================
  console.log('\nTest 4: Real UI Rejection Gate Enforces Zero Mutations...');
  inlineApprovalRequests.length = 0;

  // Reset file with defect
  await fs.writeFile(path.join(projectDir, 'src', 'calculator.js'), initialCalculatorJs, 'utf8');

  let rejectTestRunCount = 0;
  const rejectRunner = {
    execute: async () => {
      rejectTestRunCount++;
      return {
        ok: false,
        status: 'FAILED',
        exitCode: 1,
        stdout: '',
        stderr: 'AssertionError: expected 200 but received 500 at src/calculator.js:3:10',
      };
    },
  };

  const rejectWorkflowPromise = invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'test the project',
    scope: '.',
    autoRepairEnabled: true,
    tools: { containerRunner: rejectRunner },
  });

  for (let i = 0; i < 100 && inlineApprovalRequests.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(inlineApprovalRequests.length > 0, 'UI must receive second developer:workflow-approval-pending event');
  const rejectApprovalEvent = inlineApprovalRequests[0];

  // User clicks [Reject] in the UI
  console.log('  -> Simulating UI clicking [Reject] button via developer:workflow-approval-decision...');
  const rejectDecisionResult = await invokeIpc('developer:workflow-approval-decision', sender, {
    approvalRequestId: rejectApprovalEvent.approvalRequestId,
    proposalId: rejectApprovalEvent.proposalId,
    proposalDigest: rejectApprovalEvent.proposalDigest,
    approved: false,
  });
  assert.equal(rejectDecisionResult.approved, false, 'Decision must be recorded as rejected');

  const rejectWorkflowResult = await rejectWorkflowPromise;
  assert.equal(rejectWorkflowResult.outcome, 'APPROVAL_REJECTED', 'Workflow must end with APPROVAL_REJECTED');
  assert.equal(rejectWorkflowResult.codeApplied, false, 'No code must be applied on rejection');
  assert.deepEqual(rejectWorkflowResult.filesModified, [], 'filesModified must be empty');

  // Verify file on disk was NOT mutated
  const diskAfterRejection = await fs.readFile(path.join(projectDir, 'src', 'calculator.js'), 'utf8');
  assert.equal(diskAfterRejection, initialCalculatorJs, 'Disk MUST remain strictly untouched after rejection');
  console.log('  -> Test 4 passed: Zero disk mutations on UI rejection verified.');

  console.log('\n========================================================================');
  console.log('All Real UI Workflow & IPC Lifecycle Verification Tests Passed (4/4)!');
  console.log('========================================================================\n');
  process.exit(0);
} finally {
  try {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    await fs.rm(userData, { recursive: true, force: true });
  } catch {}
}
