import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

console.log('========================================================================');
console.log('Starting Milestone V29.0 — Complete Task Activity, Persistent Logs & E2E Integration Test');
console.log('========================================================================\n');

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;

const {
  TaskActivityService,
  taskActivityService,
  TASK_LIFECYCLE_STATES,
  TERMINAL_STATES,
  ALLOWED_TASK_TRANSITIONS,
  sanitizeText,
  redactObject,
} = require('../electron/coding-pipeline/taskActivityService.cjs');

// ============================================================================
// PART 1: TaskActivityService State Machine, Persistence & Security Tests
// ============================================================================
console.log('--- PART 1: TaskActivityService Core Contract & Security Verification ---');

// 1.1 State Machine & Illegal Transition Rejection
console.log('Case 1.1: Authoritative Lifecycle State Machine & Legal Transitions...');
const testService = new TaskActivityService();
const testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v29-task-activity-test-'));
const testJournalFile = path.join(testTempDir, 'test-developer-task-history.json');
testService.configureStorage({ storageRoot: testTempDir, journalFile: testJournalFile });

const task1 = testService.createTask({
  taskId: 'task-auth-001',
  title: 'Implement persistent task logging',
  projectRoot: 'C:\\Users\\Admin\\Downloads\\Hello',
  sessionId: 'session-123',
  ownerWebContentsId: 1,
});

assert.equal(task1.taskId, 'task-auth-001');
assert.equal(task1.status, 'CREATED');
assert.equal(task1.events.length, 1);
assert.equal(task1.events[0].type, 'TASK_CREATED');

// Valid transition sequence: CREATED -> RUNNING -> INSPECTING -> PROPOSAL_READY -> WAITING_FOR_APPROVAL -> APPLYING -> VERIFYING -> COMPLETED
testService.transitionTaskState('task-auth-001', 'RUNNING', 'Starting agent runner');
assert.equal(testService.getTask('task-auth-001').status, 'RUNNING');

testService.transitionTaskState('task-auth-001', 'INSPECTING', 'Reading source files');
assert.equal(testService.getTask('task-auth-001').status, 'INSPECTING');

testService.transitionTaskState('task-auth-001', 'PROPOSAL_READY', 'Proposal generated');
assert.equal(testService.getTask('task-auth-001').status, 'PROPOSAL_READY');

testService.transitionTaskState('task-auth-001', 'WAITING_FOR_APPROVAL', 'Awaiting user decision');
assert.equal(testService.getTask('task-auth-001').status, 'WAITING_FOR_APPROVAL');

testService.transitionTaskState('task-auth-001', 'APPLYING', 'User approved changes');
assert.equal(testService.getTask('task-auth-001').status, 'APPLYING');

testService.transitionTaskState('task-auth-001', 'VERIFYING', 'Running automated tests');
assert.equal(testService.getTask('task-auth-001').status, 'VERIFYING');

testService.transitionTaskState('task-auth-001', 'COMPLETED', 'Tests verified');
assert.equal(testService.getTask('task-auth-001').status, 'COMPLETED');
assert.equal(testService.getTask('task-auth-001').terminalStatus, 'COMPLETED');
assert.ok(testService.getTask('task-auth-001').finishedAt);

// Test illegal transition from terminal state
assert.throws(() => {
  testService.transitionTaskState('task-auth-001', 'APPLYING', 'Illegal mutation after completion');
}, /Illegal task transition/);

console.log('  -> Case 1.1 passed: Legal state progression enforced and illegal transitions rejected.');

// 1.2 Secret Redaction & Output Bounding
console.log('Case 1.2: Secret Redaction & Safe Output Bounding...');
const task2 = testService.createTask({
  taskId: 'task-sec-002',
  title: 'Test secret sanitization',
  sessionId: 'session-123',
});

const giantStderr = 'Error: ' + 'x'.repeat(10000);
const secretOutput = 'Connected using sk-proj-1234567890abcdef and password=SuperSecretPassword123! in .env: DB_PASSWORD=SecretVal';

testService.recordEvent('task-sec-002', 'COMMAND_COMPLETED', {
  command: 'npm test --token=ghp_secretTokenVal123456',
  exitCode: 1,
  stdout: secretOutput,
  stderr: giantStderr,
});

const recordedTask = testService.getTask('task-sec-002');
const lastEvent = recordedTask.events[recordedTask.events.length - 1];

assert.ok(!lastEvent.stdoutExcerpt.includes('sk-proj-1234567890abcdef'), 'OpenAI key must be redacted');
assert.ok(!lastEvent.stdoutExcerpt.includes('SuperSecretPassword123!'), 'Password must be redacted');
assert.ok(lastEvent.stdoutExcerpt.includes('[REDACTED]'), 'Redaction placeholder present');
assert.ok(lastEvent.stderrExcerpt.length <= 4200, 'Stderr must be bounded to safe excerpt length');
assert.ok(lastEvent.stderrExcerpt.includes('truncated'), 'Stderr includes truncation marker');

console.log('  -> Case 1.2 passed: Credentials and giant output safely sanitized.');

// 1.3 Incremental Persistence & Application Restart Reconciliation
console.log('Case 1.3: Incremental Persistence & Restart Reconciliation...');
const interruptedTask = testService.createTask({
  taskId: 'task-interrupted-003',
  title: 'Task running during crash',
  sessionId: 'session-123',
});
testService.transitionTaskState('task-interrupted-003', 'RUNNING');
testService.transitionTaskState('task-interrupted-003', 'APPLYING');

// Flush persistence to disk
await testService.flush();

// Simulate fresh app restart by instantiating new service instance from the same journal file
const restartedService = new TaskActivityService();
restartedService.configureStorage({ storageRoot: testTempDir, journalFile: testJournalFile });
const { loaded, reconciled } = await restartedService.loadHistory();

assert.ok(loaded >= 3, `Expected at least 3 tasks loaded, got ${loaded}`);
assert.ok(reconciled >= 1, `Expected at least 1 task reconciled, got ${reconciled}`);

const restoredInterrupted = restartedService.getTask('task-interrupted-003');
assert.equal(restoredInterrupted.status, 'INTERRUPTED');
assert.equal(restoredInterrupted.terminalStatus, 'INTERRUPTED');
assert.ok(restoredInterrupted.error.includes('interrupted during previous application shutdown'));
assert.equal(restoredInterrupted.events[restoredInterrupted.events.length - 1].type, 'STARTUP_RECONCILIATION');

// Completed task remains completed
const restoredCompleted = restartedService.getTask('task-auth-001');
assert.equal(restoredCompleted.status, 'COMPLETED');
assert.equal(restoredCompleted.terminalStatus, 'COMPLETED');

console.log('  -> Case 1.3 passed: Restart successfully restored tasks and reconciled interrupted ones.');

// 1.4 Access Control and Session Authorization
console.log('Case 1.4: Session & Project Access Control...');
assert.throws(() => {
  restartedService.getTask('task-auth-001', { owner: { sessionId: 'unauthorized-session', ownerWebContentsId: 999 } });
}, /Unauthorized access/);

const listOwner1 = restartedService.listTasks({ sessionId: 'session-123', limit: 10 });
assert.ok(listOwner1.total >= 3);

console.log('  -> Case 1.4 passed: Unauthorized history retrieval rejected.');

// ============================================================================
// PART 2: Real Electron Main Process IPC & UI Boundary Integration Test
// ============================================================================
console.log('\n--- PART 2: Real IPC Lifecycle & UI Boundary Integration ---');

const testCodingAuthToken = randomBytes(32).toString('base64url');
const testMutationHandshakeSecret = randomBytes(32).toString('base64url');
process.env.AI_CODING_AUTH_TOKEN = testCodingAuthToken;
process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET = testMutationHandshakeSecret;
process.env.AI_CODING_E2E_INLINE_APPROVAL = '1';

const handlers = new Map();
const windows = [];
const mainUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'v29-main-userdata-'));

const inlineApprovalRequests = [];
const liveEventsReceived = [];
const liveTaskEventsReceived = [];

const electronMock = {
  app: Object.assign(new EventEmitter(), {
    isPackaged: false,
    getPath: () => mainUserData,
    whenReady: () => Promise.resolve(),
    quit() {},
  }),
  ipcMain: {
    handle(name, handler) {
      if (handlers.has(name)) throw new Error(`Duplicate IPC handler: ${name}`);
      handlers.set(name, handler);
    },
  },
  webContents: {
    fromId(id) {
      return windows.find((w) => w.webContents.id === id)?.webContents || windows[0]?.webContents || null;
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
      id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  },
  desktopCapturer: { getSources: async () => [] },
  dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox() {} },
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
    if (channel === 'developer:activity') {
      liveEventsReceived.push(args[0]);
    }
    if (channel === 'developer:task-event') {
      liveTaskEventsReceived.push(args[0]);
    }
    if (channel === 'developer:workflow-approval-pending') {
      inlineApprovalRequests.push(args[0]);
    }
    electronMock.ipcRenderer.emit(channel, {}, ...args);
  }
  setWindowOpenHandler() {}
  loadURL(url) { this.url = url; }
  isDestroyed() { return false; }
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
  static getFocusedWindow() { return windows[0] || null; }
  static fromWebContents(contents) {
    return windows.find((window) => window.webContents === contents) || null;
  }
}
electronMock.BrowserWindow = FakeBrowserWindow;

Module._load = function hookedLoad(request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

// Import real electron/main.cjs to register authentic handlers
await import('../electron/main.cjs');

// Wait for IPC handlers to register
for (let i = 0; i < 200 && !handlers.has('developer:workflow-execute'); i++) {
  await new Promise((r) => setTimeout(r, 10));
}
assert.ok(handlers.has('developer:workflow-execute'), 'developer:workflow-execute IPC handler must be registered.');

const sender = windows[0]?.webContents;
assert.ok(sender, 'Main window webContents must exist');

const invokeIpc = async (name, ...args) => {
  const handler = handlers.get(name);
  assert.ok(handler, `Missing IPC handler: ${name}`);
  return handler({ sender, senderFrame: { url: sender.getURL() } }, ...args);
};

// Initialize developer session
const sessionRes = await invokeIpc('developer:session');
assert.ok(sessionRes.sessionId, 'Developer session must be initialized');

// Set up synthetic test project workspace
const testWorkspace = path.join(process.cwd(), `.coding-v29-task-history-fixture-${randomBytes(3).toString('hex')}`);
await fs.mkdir(path.join(testWorkspace, 'src'), { recursive: true });
await fs.mkdir(path.join(testWorkspace, 'tests'), { recursive: true });

await fs.writeFile(
  path.join(testWorkspace, 'package.json'),
  JSON.stringify({
    name: 'task-activity-fixture',
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
await fs.writeFile(path.join(testWorkspace, 'src', 'calculator.js'), initialCalculatorJs, 'utf8');

const testJs = [
  'const assert = require("node:assert/strict");',
  'const { getStatusCode } = require("../src/calculator.js");',
  'assert.equal(getStatusCode(), 200, "expected 200 but received 500 at src/calculator.js:3:10");',
  'console.log("PASS: Status code test passed");',
].join('\n');
await fs.writeFile(path.join(testWorkspace, 'tests', 'calc.test.js'), testJs, 'utf8');

try {
  // 2.1 Attach Project via Real IPC
  console.log('Case 2.1: Project Attachment via developer:project-attach...');
  const attachRes = await invokeIpc('developer:project-attach', { projectRoot: testWorkspace });
  assert.equal(attachRes.status, 'PROJECT_ATTACHED');
  console.log('  -> Project attached successfully.');

  // 2.2 Execute Workflow via Real developer:workflow-execute IPC
  console.log('Case 2.2: Full End-to-End Workflow Execution with Task Logging...');
  const workflowRequestId = '11111111-2222-4333-8444-555555555555';

  let testRunCount = 0;
  const capturedExecutions = [];

  const mockContainerRunner = {
    execute: async () => {
      testRunCount++;
      const currentDisk = await fs.readFile(path.join(testWorkspace, 'src', 'calculator.js'), 'utf8');

      if (testRunCount === 1) {
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

  const workflowPromise = invokeIpc('developer:workflow-execute', {
    workflowRequestId,
    userRequest: 'test the project',
    scope: '.',
    autoRepairEnabled: true,
    tools: { containerRunner: mockContainerRunner },
  });

  // Wait for approval event emitted from main process
  for (let i = 0; i < 100 && inlineApprovalRequests.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(inlineApprovalRequests.length > 0, 'UI must receive developer:workflow-approval-pending event');
  const approvalEvent = inlineApprovalRequests[0];

  // Send explicit approval decision via developer:workflow-approval-decision
  console.log('  -> Simulating UI clicking [Approve] button via developer:workflow-approval-decision...');
  const decisionResult = await invokeIpc('developer:workflow-approval-decision', {
    approvalRequestId: approvalEvent.approvalRequestId,
    proposalId: approvalEvent.proposalId,
    proposalDigest: approvalEvent.proposalDigest,
    approved: true,
  });
  assert.equal(decisionResult.approved, true, 'Approval decision must be recorded as approved');

  // Wait for workflow to finish
  const workflowResult = await workflowPromise;
  assert.equal(workflowResult.outcome, 'COMPLETED');
  assert.equal(workflowResult.status, 'TESTS_PASSED');
  assert.equal(workflowResult.codeApplied, true);
  assert.equal(workflowResult.codeVerified, true);
  console.log('  -> Workflow completed with outcome COMPLETED and codeVerified: true.');

  // 2.3 Verify History Retrieval via developer:task-history-list & developer:task-history-get
  console.log('Case 2.3: UI History Retrieval via developer:task-history-list & developer:task-history-get...');
  const historyList = await invokeIpc('developer:task-history-list', { limit: 10 });
  assert.ok(historyList.total >= 1, 'Task history list must contain at least 1 task');

  const taskSummary = historyList.tasks.find((t) => t.taskId === workflowRequestId);
  assert.ok(taskSummary, `Task summary for ${workflowRequestId} must exist`);
  assert.equal(taskSummary.status, 'COMPLETED');
  assert.equal(taskSummary.terminalStatus, 'COMPLETED');
  assert.ok(taskSummary.eventCount > 3, 'Must record multiple chronological events');

  const taskDetail = await invokeIpc('developer:task-history-get', workflowRequestId);
  assert.ok(taskDetail, 'Task detail must be returned');
  assert.equal(taskDetail.taskId, workflowRequestId);
  assert.equal(taskDetail.status, 'COMPLETED');

  // Verify ordered event entries
  const eventTypes = taskDetail.events.map((e) => e.type);
  console.log('  -> Recorded event types in chronological order:', eventTypes);

  assert.ok(eventTypes.includes('TASK_CREATED'), 'Must record TASK_CREATED');
  assert.ok(eventTypes.includes('STATE_TRANSITION'), 'Must record STATE_TRANSITION');
  assert.ok(eventTypes.includes('APPROVAL_REQUESTED'), 'Must record APPROVAL_REQUESTED');
  assert.ok(eventTypes.includes('APPROVAL_DECISION'), 'Must record APPROVAL_DECISION');
  assert.ok(eventTypes.includes('WORKFLOW_SETTLED'), 'Must record WORKFLOW_SETTLED');

  // Verify approval decision recorded in event
  const approvalDecisionEvent = taskDetail.events.find((e) => e.type === 'APPROVAL_DECISION');
  assert.equal(approvalDecisionEvent.approved, true);
  assert.equal(approvalDecisionEvent.decision, 'APPROVED');

  // Verify live events were streamed to renderer
  assert.ok(liveTaskEventsReceived.length > 0, 'Live task events must be broadcast over developer:task-event');
  assert.ok(liveEventsReceived.length > 0, 'Live activity events must be broadcast over developer:activity');

  console.log('  -> Case 2.3 passed: Full UI data retrieval verified matching real execution trace.');

  // 2.4 Cancellation Semantics via developer:task-cancel
  console.log('Case 2.4: Cancellation Semantics via developer:task-cancel...');
  const cancelTaskId = 'test-cancel-task-uuid-444';
  taskActivityService.createTask({
    taskId: cancelTaskId,
    title: 'Task to be cancelled',
    sessionId: sessionRes.sessionId,
    ownerWebContentsId: sender.id,
  });
  taskActivityService.transitionTaskState(cancelTaskId, 'RUNNING');

  const cancelRes = await invokeIpc('developer:task-cancel', cancelTaskId);
  assert.equal(cancelRes.status, 'CANCELLED');
  assert.equal(cancelRes.terminalStatus, 'CANCELLED');
  console.log('  -> Case 2.4 passed: Cancellation accurately transitions to CANCELLED.');

  // 2.5 Forced Termination Semantics via developer:task-kill
  console.log('Case 2.5: Forced Termination Semantics via developer:task-kill...');
  const killTaskId = 'test-kill-task-uuid-555';
  taskActivityService.createTask({
    taskId: killTaskId,
    title: 'Task to be killed',
    sessionId: sessionRes.sessionId,
    ownerWebContentsId: sender.id,
  });
  taskActivityService.transitionTaskState(killTaskId, 'RUNNING');

  const killRes = await invokeIpc('developer:task-kill', killTaskId);
  assert.equal(killRes.status, 'KILLED');
  assert.equal(killRes.terminalStatus, 'KILLED');
  console.log('  -> Case 2.5 passed: Forced termination accurately transitions to KILLED.');

  console.log('\n========================================================================');
  console.log('All Milestone V29.0 Task Activity & Persistent History Tests Passed (100%)!');
  console.log('========================================================================\n');
  process.exit(0);
} finally {
  try {
    await fs.rm(testWorkspace, { recursive: true, force: true });
    await fs.rm(testTempDir, { recursive: true, force: true });
    await fs.rm(mainUserData, { recursive: true, force: true });
  } catch {}
}
