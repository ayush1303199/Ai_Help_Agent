import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
import {
  classifyCodingRequestIntent,
  shouldRequireDeveloperWorkflowForAttachedProject,
} from '../src/features/coding/codingTransport.ts';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const previousCodingAuthToken = process.env.AI_CODING_AUTH_TOKEN;
const previousMutationHandshakeSecret = process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET;
const testCodingAuthToken = randomBytes(32).toString('base64url');
const testMutationHandshakeSecret = randomBytes(32).toString('base64url');
process.env.AI_CODING_AUTH_TOKEN = testCodingAuthToken;
process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET = testMutationHandshakeSecret;

const handlers = new Map();
const windows = [];
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-workflow-ipc-userdata-'));
const projectRoots = new Set();
async function listFilesRecursively(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(current, entry.name);
    return entry.isDirectory()
      ? listFilesRecursively(root, fullPath)
      : [path.relative(root, fullPath)];
  }));
  return nested.flat();
}
const dialogRequests = [];
const dialogResponses = [];
const inlineApprovalRequests = [];
const inlineApprovalErrors = [];
let deferInlineApprovalDecision = false;
let concurrentApprovalMutation = null;
const authorizedMutationRequests = [];
let resolveAppQuit;
const appQuitComplete = new Promise((resolve) => { resolveAppQuit = resolve; });

const electronMock = {
  app: Object.assign(new EventEmitter(), {
    isPackaged: false,
    getPath: () => userData,
    whenReady: () => Promise.resolve(),
    quit() {
      let prevented = false;
      this.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) resolveAppQuit();
    },
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
const originalFetch = globalThis.fetch;
let relevanceAssessmentMode = 'supported';
const relevanceAssessmentRequests = [];
const canonicalMutationJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalMutationJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalMutationJson(value[key])]));
  }
  return value;
};
globalThis.fetch = async (input, options = {}) => {
  if (String(input).includes('/api/coding/policy/file-mutation')) {
    const payload = JSON.parse(options.body || '{}');
    const suppliedToken = options.headers?.['X-Coding-Auth'];
    if (!suppliedToken) {
      return { ok: false, status: 401, json: async () => ({ detail: 'Missing test authorization context.' }) };
    }
    if (suppliedToken !== testCodingAuthToken) {
      return { ok: false, status: 401, json: async () => ({ detail: 'Invalid test authorization context.' }) };
    }
    const expectedProof = createHmac('sha256', testMutationHandshakeSecret)
      .update(JSON.stringify(canonicalMutationJson(payload)))
      .digest('hex');
    if (options.headers?.['X-Coding-Mutation-Proof'] !== expectedProof) {
      return { ok: false, status: 403, json: async () => ({ detail: 'Invalid test mutation proof.' }) };
    }
    const binding = payload.requestBinding;
    if (payload.proposalApproved !== true
      || !binding
      || typeof binding.taskId !== 'string'
      || typeof binding.turnId !== 'string'
      || !/^[a-f0-9]{64}$/.test(binding.requestHash || '')
      || typeof binding.root !== 'string'
      || !projectRoots.has(path.resolve(binding.root))
      || typeof binding.scope !== 'string'
      || !Array.isArray(binding.authorizedFeatures)
      || !binding.authorizedFeatures.length) {
      return {
        ok: true,
        json: async () => ({ decision: 'BLOCK', reason: 'Approved request binding is incomplete or mismatched.' }),
      };
    }
    authorizedMutationRequests.push({ operation: payload.operation, paths: payload.paths, binding });
    return { ok: true, json: async () => ({ decision: 'ALLOW', reason: 'Test launch credentials and approved binding validated.' }) };
  }
  if (!String(input).includes('/api/coding/assess-finding-relevance')) {
    return originalFetch(input, options);
  }

  const assessment = JSON.parse(options.body || '{}');
  relevanceAssessmentRequests.push(assessment);
  if (relevanceAssessmentMode === 'provider-error') {
    return {
      ok: false,
      status: 503,
      json: async () => ({ detail: 'Deterministic provider failure fixture.' }),
    };
  }
  if (relevanceAssessmentMode === 'malformed') {
    return { ok: true, json: async () => ({ findings: [] }) };
  }

  return {
    ok: true,
    json: async () => ({
      findings: assessment.findings.map((finding) => ({
        findingId: finding.findingId,
        decision: relevanceAssessmentMode === 'supported' ? 'SUPPORTED' : 'UNRELATED',
        relationship: relevanceAssessmentMode === 'supported'
          ? 'The cited source contains the requested debug output and termination.'
          : 'The cited source does not establish a relationship to the requested outcome.',
        evidenceIds: [finding.sourceEvidenceId],
        contradictionEvidenceIds: [],
        unresolvedAssumptions: [],
      })),
    }),
  };
};
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
  electronMock.ipcRenderer.on('developer:workflow-approval-pending', (_event, approval) => {
    inlineApprovalRequests.push(approval);
    if (deferInlineApprovalDecision) return;
    void (async () => {
      if (concurrentApprovalMutation) {
        const mutate = concurrentApprovalMutation;
        concurrentApprovalMutation = null;
        await mutate();
      }
      const response = dialogResponses.length ? dialogResponses.shift() : 0;
      await invokeIpc('developer:workflow-approval-decision', sender, {
        approvalRequestId: approval.approvalRequestId,
        proposalId: approval.proposalId,
        proposalDigest: approval.proposalDigest,
        approved: response === 1,
      });
    })().catch((error) => inlineApprovalErrors.push(error));
  });

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

  const ipcDeveloperAgent = require('../electron/developerAgent.cjs');
  const ipcDeveloperFiles = require('../electron/developerFiles.cjs');
  await fs.writeFile(
    path.join(projectDir, 'tests', 'region-sample.js'),
    'line one\nline two\nline three\nline four\n',
    'utf8'
  );
  const toolTurn = ipcDeveloperAgent.beginConversationTurn({
    root: projectDir,
    request: 'inspect a bounded source region',
    sessionId: sessionRes.sessionId,
    ownerWebContentsId: sender.id,
  });
  ipcDeveloperAgent.advanceConversationTurn(
    toolTurn.turnId,
    'understanding',
    { sessionId: sessionRes.sessionId, ownerWebContentsId: sender.id },
  );
  const targetedToolRead = await invokeIpc('developer:tool', sender, {
    name: 'read_file',
    args: { relativePath: 'tests/region-sample.js', startLine: 2, endLine: 3 },
    turnId: toolTurn.turnId,
  });
  assert.equal(targetedToolRead.ok, true);
  assert.equal(targetedToolRead.data.content, 'line two\nline three');
  assert.deepEqual(targetedToolRead.data.lineRange, {
    startLine: 2,
    endLine: 3,
    totalLines: 5,
    complete: false,
  });

  // TEST 1B: Main-owned handoff plan is bound to the registered proposal.
  const originalWorkflowExecutor = ipcDeveloperAgent.executeAutonomousCodingWorkflow;
  const handoffRequestId = 'b45d7af9-a28c-4be1-a9ea-6d1586e0e216';
  const handoffRequest = 'Implement the related persistence and API changes.';
  const trustedHandoffPlan = {
    schemaVersion: 2,
    status: 'HANDED_OFF',
    workItems: [
      {
        id: 'WI-001',
        objective: 'Persist the requested setting.',
        status: 'DELEGATED',
        dependsOn: [],
        requiredEvidence: ['APPROVED_SCOPE_PROPOSAL', 'EXPLICIT_APPROVAL', 'VERIFICATION_PASS', 'PRESERVATION_AUDIT'],
        verificationCriteria: [{
          id: 'approved-file-state',
          type: 'FILE_SHA256',
          path: 'tests/region-sample.js',
          sha256: createHash('sha256').update('line one updated\nline two\nline three\nline four\n').digest('hex'),
        }],
      },
      {
        id: 'WI-002',
        objective: 'Expose the setting through the API.',
        status: 'DELEGATED',
        dependsOn: ['WI-001'],
        requiredEvidence: ['APPROVED_SCOPE_PROPOSAL', 'EXPLICIT_APPROVAL', 'VERIFICATION_PASS'],
      },
    ],
  };
  let handoffPlanToReturn = trustedHandoffPlan;
  ipcDeveloperAgent.executeAutonomousCodingWorkflow = async ({ userRequest }) => {
    assert.equal(userRequest, handoffRequest, 'The original request must reach the production workflow boundary.');
    return { outcome: 'IMPLEMENTATION_REQUIRED', taskPlan: handoffPlanToReturn };
  };
  let trustedHandoffTurn = null;
  let boundHandoffProposal = null;
  const handoffFixtureContent = 'line one\nline two\nline three\nline four\n';
  const handoffDiff = [
    '--- a/tests/region-sample.js',
    '+++ b/tests/region-sample.js',
    '@@ -1,4 +1,4 @@',
    '-line one',
    '+line one updated',
    ' line two',
    ' line three',
    ' line four',
    '',
  ].join('\n');
  try {
    const handoffResult = await invokeIpc('developer:workflow-execute', sender, {
      workflowRequestId: handoffRequestId,
      userRequest: handoffRequest,
    });
    assert.equal(handoffResult.outcome, 'IMPLEMENTATION_REQUIRED');

    await assert.rejects(
      () => invokeIpc('developer:proposal-create', sender, {
        raw: handoffDiff,
        snapshots: [],
        scope: '.',
        handoffWorkflowRequestId: 'a45d7af9-a28c-4be1-a9ea-6d1586e0e216',
      }),
      /handoff plan is missing, stale, or mismatched/i,
      'A forged or unknown workflow ID must not attach a renderer-supplied plan.',
    );
    await assert.rejects(
      () => invokeIpc('developer:proposal-create', sender, {
        raw: handoffDiff,
        snapshots: [],
        scope: 'tests',
        handoffWorkflowRequestId: handoffRequestId,
      }),
      /handoff plan is missing, stale, or mismatched/i,
      'A trusted workflow ID must not be reused outside its original project scope.',
    );

    const unrelatedTurn = ipcDeveloperAgent.beginConversationTurn({
      root: projectDir,
      request: 'A different coding request.',
      sessionId: sessionRes.sessionId,
      ownerWebContentsId: sender.id,
      scope: '.',
    });
    ipcDeveloperAgent.advanceConversationTurn(
      unrelatedTurn.turnId,
      'understanding',
      { sessionId: sessionRes.sessionId, ownerWebContentsId: sender.id },
    );
    await assert.rejects(
      () => invokeIpc('developer:proposal-create', sender, {
        raw: handoffDiff,
        snapshots: [],
        scope: '.',
        conversationTurnId: unrelatedTurn.turnId,
        handoffWorkflowRequestId: handoffRequestId,
      }),
      /does not match this proposal conversation/i,
      'A valid handoff ID must not be rebound to a different original request.',
    );

    trustedHandoffTurn = ipcDeveloperAgent.beginConversationTurn({
      root: projectDir,
      request: handoffRequest,
      sessionId: sessionRes.sessionId,
      ownerWebContentsId: sender.id,
      scope: '.',
    });
    ipcDeveloperAgent.advanceConversationTurn(
      trustedHandoffTurn.turnId,
      'understanding',
      { sessionId: sessionRes.sessionId, ownerWebContentsId: sender.id },
    );
    const api = exposedWorld.get('electronAPI');
    boundHandoffProposal = await api.createDeveloperProposal(
      handoffDiff,
      [{ path: 'tests/region-sample.js', hash: createHash('sha256').update(handoffFixtureContent).digest('hex') }],
      null,
      '.',
      trustedHandoffTurn.turnId,
      null,
      handoffRequestId,
    );
    assert.deepEqual(boundHandoffProposal.taskPlan, trustedHandoffPlan);
    assert.equal(boundHandoffProposal.state, 'awaiting_approval');
    assert.equal(
      ipcDeveloperAgent.getTaskForTest(boundHandoffProposal.id).state,
      'awaiting_approval',
      'The handoff proposal must still require explicit approval.',
    );
    assert.deepEqual(
      ipcDeveloperAgent.getTaskForTest(boundHandoffProposal.id).taskPlan,
      trustedHandoffPlan,
      'The main-owned plan must persist on the proposal task.',
    );
    assert.equal(
      await fs.readFile(path.join(projectDir, 'tests', 'region-sample.js'), 'utf8'),
      handoffFixtureContent,
      'Binding a multi-item handoff must not write before proposal approval.',
    );
    const approvedHandoff = await api.approveDeveloperProposal(boundHandoffProposal.id);
    assert.equal(approvedHandoff.state, 'approved', 'The proposal must pass the existing explicit approval gate.');
    const originalHandoffVerification = ipcDeveloperFiles.runVerification;
    ipcDeveloperFiles.runVerification = async (script) => ({
      ok: true,
      script,
      status: 'PASS',
      executed: true,
      exitCode: 0,
      stdout: 'Deterministic approved verification passed.',
      stderr: '',
    });
    let appliedHandoff;
    try {
      appliedHandoff = await api.applyDeveloperProposal(boundHandoffProposal.id);
    } finally {
      ipcDeveloperFiles.runVerification = originalHandoffVerification;
    }
    assert.equal(
      appliedHandoff.state,
      'completed',
      `A properly authenticated and explicitly approved proposal must apply and verify: ${appliedHandoff.error || 'no error detail'}`,
    );
    assert.equal(appliedHandoff.taskPlan.workItems[0].status, 'COMPLETED', 'Host-observed matching file evidence must complete its item.');
    assert.equal(appliedHandoff.taskPlan.workItems[1].status, 'DELEGATED', 'Unverified dependent work must remain unresolved.');
    assert.equal(appliedHandoff.taskPlan.status, 'HANDED_OFF', 'The parent plan must remain nonterminal while required work is unresolved.');
    assert.notEqual(appliedHandoff.taskPlan.status, 'COMPLETED', 'The parent plan must not complete with unresolved required work.');
    assert.equal(appliedHandoff.verification.status, 'PASS', 'The approved host verification command must pass.');
    assert.equal(
      appliedHandoff.taskPlan.workItems[0].verificationResult.status,
      'SATISFIED',
      'The trusted verifier must report the matching criterion as satisfied.',
    );
    assert.deepEqual(
      appliedHandoff.taskPlan.workItems[0].verificationResult.criteriaChecked,
      ['approved-file-state'],
    );
    assert.equal(authorizedMutationRequests.length > 0, true, 'The approved proposal must reach the mutation policy boundary.');
    assert.ok(
      authorizedMutationRequests.some((request) => request.paths.includes('tests/region-sample.js')),
      'The policy fixture must observe the authorized target path.',
    );
    const approvedTaskRecord = ipcDeveloperAgent.getTaskForTest(boundHandoffProposal.id);
    const authorizedFileMutation = authorizedMutationRequests.find((request) => (
      request.paths.includes('tests/region-sample.js')
    ));
    assert.equal(authorizedFileMutation.binding.taskId, approvedTaskRecord.authorizationContext.taskId);
    assert.equal(authorizedFileMutation.binding.turnId, trustedHandoffTurn.turnId);
    assert.equal(authorizedFileMutation.binding.requestHash, approvedTaskRecord.authorizationContext.requestHash);
    assert.equal(authorizedFileMutation.binding.root, projectDir);
    assert.equal(authorizedFileMutation.binding.scope, '.');
    assert.equal(
      appliedHandoff.taskPlan.workItems[0].verificationResult.itemId,
      'WI-001',
      'Host-observed evidence must be associated with the exact satisfied item.',
    );
    assert.equal(
      await fs.readFile(path.join(projectDir, 'tests', 'region-sample.js'), 'utf8'),
      'line one updated\nline two\nline three\nline four\n',
      'An authenticated, explicitly approved mutation must write the approved proposal.',
    );

    handoffPlanToReturn = {
      ...trustedHandoffPlan,
      workItems: trustedHandoffPlan.workItems.map((item, index) => ({
        ...item,
        dependsOn: index === 0 ? ['WI-002'] : ['WI-001'],
      })),
    };
    const malformedPlanRequestId = 'd35d7af9-a28c-4be1-a9ea-6d1586e0e216';
    await invokeIpc('developer:workflow-execute', sender, {
      workflowRequestId: malformedPlanRequestId,
      userRequest: handoffRequest,
    });
    await assert.rejects(
      () => invokeIpc('developer:proposal-create', sender, {
        raw: handoffDiff,
        snapshots: [],
        scope: '.',
        handoffWorkflowRequestId: malformedPlanRequestId,
      }),
      /handoff plan is missing, stale, or mismatched/i,
      'A model-generated dependency cycle must not become a trusted proposal handoff.',
    );
  } finally {
    ipcDeveloperAgent.executeAutonomousCodingWorkflow = originalWorkflowExecutor;
  }

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

  // Deterministic test-only assessment responses exercise the real investigation gate.
  const dialogCountBeforeAssessmentFailures = dialogRequests.length;
  for (const mode of ['unrelated', 'provider-error', 'malformed']) {
    relevanceAssessmentMode = mode;
    const assessmentRequestCount = relevanceAssessmentRequests.length;
    const incompleteAssessmentResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
    });
    assert.equal(incompleteAssessmentResult.outcome, 'INVESTIGATION_INCOMPLETE', `${mode} assessment must stop before approval.`);
    assert.equal(incompleteAssessmentResult.phase, 'INVESTIGATE');
    assert.equal(incompleteAssessmentResult.filesModified.length, 0);
    assert.equal(incompleteAssessmentResult.codeApplied, false);
    assert.ok(
      relevanceAssessmentRequests.length > assessmentRequestCount,
      `${mode} scenario must exercise the production IPC relevance-assessment call.`,
    );
    assert.equal(
      dialogRequests.length,
      dialogCountBeforeAssessmentFailures,
      `${mode} assessment must not open the approval dialog.`,
    );
  }

  relevanceAssessmentMode = 'supported';
  const acceptedAssessmentRequestCount = relevanceAssessmentRequests.length;
  const inlineApprovalCountBeforeRejection = inlineApprovalRequests.length;
  dialogResponses.push(0);
  const unapprovedResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'fix debug probe and die in profile form controller',
  });
  assert.ok(
    relevanceAssessmentRequests.length > acceptedAssessmentRequestCount,
    'The accepted assessment must be returned through the production IPC assessor boundary.',
  );
  assert.equal(inlineApprovalRequests.length, inlineApprovalCountBeforeRejection + 1, 'Supported findings must reach the inline approval contract.');
  assert.equal(unapprovedResult.outcome, 'APPROVAL_REJECTED');
  assert.equal(unapprovedResult.phase, 'APPROVE');
  assert.equal(unapprovedResult.filesModified.length, 0);
  assert.equal(unapprovedResult.codeApplied, false);
  const rejectedApproval = inlineApprovalRequests.at(-1);
  assert.equal(rejectedApproval.envelope.proposalDigest, rejectedApproval.proposalDigest);
  assert.match(rejectedApproval.proposalDigest, /^[a-f0-9]{64}$/i);
  assert.match(rejectedApproval.diff, /FormController\.php/);
  assert.equal(
    require('../electron/developerAgent.cjs').getTaskForTest(unapprovedResult.taskId).state,
    'cancelled',
    'Rejecting the workflow proposal must leave its task terminally cancelled.'
  );
  await assert.rejects(
    async () => invokeIpc('developer:proposal-approve', sender, unapprovedResult.taskId),
    /awaiting approval|invalid, stale, or mismatched|authorization/i,
    'A rejected workflow proposal must not be approved through the separate proposal IPC.'
  );
  await assert.rejects(
    async () => invokeIpc('developer:proposal-apply', sender, unapprovedResult.taskId),
    /proposal must be approved exactly once|invalid, stale, or mismatched|authorization/i,
    'A rejected workflow proposal must not be applied through the separate proposal IPC.'
  );

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

    assert.equal(successResult.outcome, 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED');
    assert.equal(successResult.phase, 'AUDIT');
    assert.equal(successResult.codeApplied, true);
    assert.equal(successResult.codeVerified, true);
    assert.equal(successResult.taskPlan.status, 'BLOCKED');
    assert.equal(successResult.taskPlan.workItems[0].status, 'BLOCKED');
    assert.deepEqual(successResult.filesModified, ['modules/profile/controllers/FormController.php']);
    assert.match(inlineApprovalRequests.at(-1).diff, /FormController\.php/);
    assert.match(inlineApprovalRequests.at(-1).proposalDigest, /^[a-f0-9]{64}$/i);

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
  concurrentApprovalMutation = async () => {
    await fs.writeFile(
      path.join(projectDir, 'modules', 'profile', 'controllers', 'FormController.php'),
      '<?php // concurrent external edit ?>\n',
      'utf8'
    );
  };

  try {
    dialogResponses.push(1);
    const concurrentResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'fix debug probe and die in profile form controller',
      autoRepairEnabled: false,
    });

    assert.equal(concurrentResult.phase, 'APPROVE');
    assert.equal(concurrentResult.outcome, 'APPROVAL_REJECTED');
    assert.equal(concurrentResult.codeVerified, false);
    assert.equal(inlineApprovalErrors.length, 1);
    assert.match(inlineApprovalErrors[0].message, /project files changed/i);
  } finally {
    concurrentApprovalMutation = null;
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
  assert.equal(incompleteResult.continuation?.status, 'NEEDS_NARROWER_REQUEST');
  assert.equal(incompleteResult.continuation?.token, undefined);
  assert.equal(incompleteResult.continuation?.nextAction?.tool, 'list_directory');
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
  // Sub-case A: Technical Inquiries & Explanations with Action Verbs (Must Stay Conversational)
  const q1 = classifyCodingRequestIntent('How does the authorization ledger verify HMAC signatures?');
  assert.equal(q1.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q1.isActionableTask, false);

  const q2 = classifyCodingRequestIntent('What does developerAgent.cjs do?');
  assert.equal(q2.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q2.isActionableTask, false);

  const q3 = classifyCodingRequestIntent('explain the verification runner policy');
  assert.equal(q3.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q3.isActionableTask, false);

  const q4 = classifyCodingRequestIntent('How does developerAgent implement rollback?');
  assert.equal(q4.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q4.isActionableTask, false);

  const q5 = classifyCodingRequestIntent('Can you explain the approval flow?');
  assert.equal(q5.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q5.isActionableTask, false);

  const q6 = classifyCodingRequestIntent('Tell me about the project architecture.');
  assert.equal(q6.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q6.isActionableTask, false);

  const q7 = classifyCodingRequestIntent('Can you please explain how to fix the rollback bug?');
  assert.equal(q7.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q7.isActionableTask, false);

  const q8 = classifyCodingRequestIntent('What happens if verification fails during apply?');
  assert.equal(q8.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q8.isActionableTask, false);

  const q9 = classifyCodingRequestIntent('Why is the FormController using die()?');
  assert.equal(q9.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q9.isActionableTask, false);

  const q10 = classifyCodingRequestIntent('Where is the benchmark authorization ledger stored?');
  assert.equal(q10.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q10.isActionableTask, false);

  const q11 = classifyCodingRequestIntent('Tell me how developerAgent implements rollback');
  assert.equal(q11.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q11.isActionableTask, false);

  const q12 = classifyCodingRequestIntent('Help me understand the approval flow');
  assert.equal(q12.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q12.isActionableTask, false);

  const q13 = classifyCodingRequestIntent('I want to understand why rollback was called');
  assert.equal(q13.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q13.isActionableTask, false);

  const q14 = classifyCodingRequestIntent('Should we add tests for this endpoint?');
  assert.equal(q14.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q14.isActionableTask, false);

  const q15 = classifyCodingRequestIntent('Give me an overview of the rollback implementation');
  assert.equal(q15.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(q15.isActionableTask, false);

  // Sub-case B: Ambiguous / Vague Prompts (Must Require Clarification without Modifying Files)
  const c1 = classifyCodingRequestIntent('');
  assert.equal(c1.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c1.isActionableTask, false);
  assert.ok(c1.clarificationPrompt);

  const c2 = classifyCodingRequestIntent('make it better');
  assert.equal(c2.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c2.isActionableTask, false);
  assert.ok(c2.clarificationPrompt);

  const c3 = classifyCodingRequestIntent('improve performance');
  assert.equal(c3.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c3.isActionableTask, false);
  assert.ok(c3.clarificationPrompt);

  const c4 = classifyCodingRequestIntent('fix the bug');
  assert.equal(c4.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c4.isActionableTask, false);
  assert.ok(c4.clarificationPrompt);

  const c5 = classifyCodingRequestIntent('clean it up');
  assert.equal(c5.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c5.isActionableTask, false);
  assert.ok(c5.clarificationPrompt);

  const c6 = classifyCodingRequestIntent('look into this');
  assert.equal(c6.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c6.isActionableTask, false);
  assert.ok(c6.clarificationPrompt);

  const c7 = classifyCodingRequestIntent('investigate this');
  assert.equal(c7.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(c7.isActionableTask, false);
  assert.ok(c7.clarificationPrompt);

  // Sub-case C: Ambiguous Mixed-Intent Requests (Combining Action and Inquiry)
  const m1 = classifyCodingRequestIntent('Fix the rollback or explain why it failed');
  assert.equal(m1.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(m1.isActionableTask, false);
  assert.ok(m1.clarificationPrompt);

  const m2 = classifyCodingRequestIntent('Should I fix this or what do you recommend?');
  assert.equal(m2.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(m2.isActionableTask, false);
  assert.ok(m2.clarificationPrompt);

  const m3 = classifyCodingRequestIntent('Either add tests or explain why they cannot be added');
  assert.equal(m3.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(m3.isActionableTask, false);
  assert.ok(m3.clarificationPrompt);

  const m4 = classifyCodingRequestIntent('Can you fix this or should we discuss the approach first?');
  assert.equal(m4.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(m4.isActionableTask, false);
  assert.ok(m4.clarificationPrompt);

  const readOnlyExplanation = classifyCodingRequestIntent('Do not implement a change; explain how the retry policy works.');
  assert.equal(readOnlyExplanation.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(readOnlyExplanation.isActionableTask, false);

  const noChangePreference = classifyCodingRequestIntent("I don't want code changes; explain how the retry policy works.");
  assert.equal(noChangePreference.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(noChangePreference.isActionableTask, false);

  const readOnlyInvestigation = classifyCodingRequestIntent('Do not change code; investigate why the retry is failing.');
  assert.equal(readOnlyInvestigation.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(readOnlyInvestigation.isActionableTask, true);

  const noChangeInvestigation = classifyCodingRequestIntent('Without changing files, investigate why the retry is failing.');
  assert.equal(noChangeInvestigation.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(noChangeInvestigation.isActionableTask, true);

  const negatedMixedIntent = classifyCodingRequestIntent('Do not fix this or explain why it failed?');
  assert.equal(negatedMixedIntent.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(negatedMixedIntent.isActionableTask, false);

  // Sub-case D: Direct & Polite Action Directives (Must Reach Autonomous Workflow)
  const a1 = classifyCodingRequestIntent('fix debug probe and die in profile form controller');
  assert.equal(a1.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a1.isActionableTask, true);

  const a2 = classifyCodingRequestIntent('investigate why the user details test is failing');
  assert.equal(a2.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a2.isActionableTask, true);

  const a3 = classifyCodingRequestIntent('Fix the rollback implementation.');
  assert.equal(a3.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a3.isActionableTask, true);

  const a4 = classifyCodingRequestIntent('Add regression tests for approval handling.');
  assert.equal(a4.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a4.isActionableTask, true);

  const a5 = classifyCodingRequestIntent('Find and fix the bug in this controller.');
  assert.equal(a5.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a5.isActionableTask, true);

  const a6 = classifyCodingRequestIntent('Can you fix the rollback implementation?');
  assert.equal(a6.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a6.isActionableTask, true);

  const a7 = classifyCodingRequestIntent('Please add regression tests for approval handling.');
  assert.equal(a7.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a7.isActionableTask, true);

  const a8 = classifyCodingRequestIntent('Refactor the database connection helper.');
  assert.equal(a8.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a8.isActionableTask, true);

  const a9 = classifyCodingRequestIntent('Could you please modify the rollback logic to handle stale locks?');
  assert.equal(a9.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a9.isActionableTask, true);

  const a10 = classifyCodingRequestIntent('Patch the security vulnerability in auth controller.');
  assert.equal(a10.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(a10.isActionableTask, true);

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

    assert.equal(endToEndResult.outcome, 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED');
    assert.equal(endToEndResult.codeApplied, true);
    assert.equal(endToEndResult.codeVerified, true);
    assert.equal(endToEndResult.taskPlan.status, 'BLOCKED');
    assert.equal(endToEndResult.taskPlan.workItems[0].status, 'BLOCKED');
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

  // TEST 19: Greenfield Live Full-Stack Intercept & File Materialization (Milestone V10.1)
  const greenfieldProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-greenfield-fullstack-'));
  projectRoots.add(greenfieldProject);
  await invokeIpc('developer:project-attach', sender, { projectRoot: greenfieldProject });
  dialogResponses.push(1); // 1 = Approve exact proposal
  const livePrompt = `Build a full-stack order form and API.
Create POST /api/orders
Fields:
- customerName: string (required)
- itemCount: number (default=1)
Add a frontend form with loading, success, and error states.`;
  const livePromptClassification = classifyCodingRequestIntent(livePrompt);
  assert.equal(livePromptClassification.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(livePromptClassification.isActionableTask, true);
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: livePromptClassification.intent,
    requestText: livePrompt,
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
  }), true, 'An actionable request with an attached project must not fall back to text-only browser chat.');
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: livePromptClassification.intent,
    requestText: livePrompt,
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: true,
  }), false, 'The Electron workflow bridge must remain the allowed materialization route.');
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: 'QUESTION_OR_EXPLANATION',
    requestText: livePrompt,
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
  }), false, 'Read-only questions may continue through conversational chat.');
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: livePromptClassification.intent,
    requestText: livePrompt,
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
    isResumingProviderTask: true,
  }), false, 'Existing provider task continuations retain their existing route.');
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: classifyCodingRequestIntent('Make a safe change.').intent,
    requestText: 'Make a safe change.',
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
  }), false, 'Ordinary browser proposal tasks must retain their existing provider proposal route.');
  const greenfieldResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: livePrompt,
    scope: '.',
  });
  assert.equal(greenfieldResult.outcome, 'SUCCESS', JSON.stringify(greenfieldResult));
  assert.equal(greenfieldResult.codeApplied, true, 'A syntactically mounted dynamic route plan should apply.');
  assert.equal(greenfieldResult.codeVerified, true, 'The generated route and module graph must pass verification.');
  assert.deepEqual(greenfieldResult.integrationVerification.verificationModes, ['STATIC_WIRING']);
  assert.equal(greenfieldResult.hermeticVerification.status, 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED');
  assert.equal(greenfieldResult.hermeticVerification.passed, 9);
  assert.equal(greenfieldResult.hermeticVerification.total, 9);
  assert.equal(greenfieldResult.hostExecution?.status, 'SKIPPED_ISOLATION_UNAVAILABLE');
  assert.equal(
    greenfieldResult.workflowReceipt.verificationReport.integrationVerification.liveProbePerformed,
    false,
    'Static source integration must not be reported as live route reachability.',
  );
  assert.match(greenfieldResult.message, /live route reachability was not probed/i);
  const greenfieldFiles = await listFilesRecursively(greenfieldProject);
  assert.ok(greenfieldFiles.includes(path.join('models', 'Order.js')));
  assert.ok(greenfieldFiles.some((file) => file.endsWith('Controller.js')));
  assert.ok(greenfieldFiles.includes(path.join('routes', 'orders.js')));
  assert.ok(greenfieldFiles.includes('server.js'));
  assert.ok(greenfieldFiles.some((file) => file.endsWith('Form.jsx')));
  assert.ok(greenfieldFiles.includes('package.json'));
  assert.ok(greenfieldFiles.includes('.env.example'));
  assert.ok(greenfieldFiles.includes('README.md'));
  assert.equal(greenfieldResult.workflowReceipt.verificationReport.hermeticVerification.passed, 9);
  assert.match(greenfieldResult.message, /Approved files: .*package\.json/);
  assert.match(greenfieldResult.message, /run `npm start` from the project root/);
  assert.match(greenfieldResult.message, /did not run project commands/);
  console.log('TEST 19 PASSED: Dynamic full-stack schema, route, server mount, and UI modules apply and verify.');

  // TEST 20: The generalized greenfield CRUD scaffold is wired without executing generated code.
  const fallbackProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-greenfield-fallback-'));
  projectRoots.add(fallbackProject);
  await invokeIpc('developer:project-attach', sender, { projectRoot: fallbackProject });
  dialogResponses.push(1);
  const fallbackResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: `Act as an expert Full-Stack Developer. Build a complete 'Add Order' feature with a frontend form and backend API.
Create an Order Model/Schema and a POST endpoint /api/orders with input validation.
Include basic input validation and proper error handling (try-catch, status codes like 201, 400, 500).
Create a page/component and display success or error toast/messages accordingly.`,
    scope: '.',
  });
  assert.notEqual(fallbackResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(fallbackResult.outcome, 'SUCCESS', JSON.stringify(fallbackResult));
  assert.deepEqual(fallbackResult.integrationVerification.verificationModes, ['STATIC_WIRING']);
  assert.equal(
    fallbackResult.integrationVerification.routeMounts.some((route) => route.status !== 'STATIC_WIRING_VERIFIED'),
    false,
  );
  const fallbackFiles = await listFilesRecursively(fallbackProject);
  assert.ok(fallbackFiles.includes('server.js'));
  const normalizedFallbackFiles = fallbackFiles.map((file) => file.split(/[\\/]/).join('/'));
  assert.ok(normalizedFallbackFiles.includes('routes/orders.js'));
  assert.ok(normalizedFallbackFiles.includes('components/OrderForm.jsx'));
  assert.ok(normalizedFallbackFiles.includes('pages/OrderPage.jsx'));
  console.log('TEST 20 PASSED: Generalized full-stack routes are statically wired and the workflow reports no live probe.');

  const typoGreenfieldProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-greenfield-typo-'));
  projectRoots.add(typoGreenfieldProject);
  await invokeIpc('developer:project-attach', sender, { projectRoot: typoGreenfieldProject });
  dialogResponses.push(1);
  const typoGreenfieldResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: `ct as an expert Full-Stack Developer. Build a complete 'Add Order' feature with a frontend form and backend API.
Create an Order Model/Schema and a POST endpoint /api/orders with input validation.
Include basic input validation and proper error handling (try-catch, status codes like 201, 400, 500).
Create a page/component and display success or error toast/messages accordingly.`,
    scope: '.',
  });
  assert.notEqual(typoGreenfieldResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(typoGreenfieldResult.outcome, 'SUCCESS', JSON.stringify(typoGreenfieldResult));
  assert.equal(typoGreenfieldResult.codeApplied, true);
  assert.equal(
    typoGreenfieldResult.taskPlan.subtasks.find((subtask) => subtask.id === 'ST-2')?.status,
    'SKIPPED',
    'A genuinely greenfield workspace must not fabricate source-inspection evidence.',
  );
  assert.ok((await listFilesRecursively(typoGreenfieldProject)).length > 0);
  console.log('TEST 21 PASSED: Leading typo and error-handling requirements still route greenfield creation to proposal synthesis.');

  const populatedCreationProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-populated-creation-'));
  projectRoots.add(populatedCreationProject);
  await fs.mkdir(path.join(populatedCreationProject, 'src'), { recursive: true });
  await fs.writeFile(path.join(populatedCreationProject, 'package.json'), JSON.stringify({ name: 'existing-app' }), 'utf8');
  await fs.writeFile(
    path.join(populatedCreationProject, 'index.js'),
    'const existingBehavior = true;\nmodule.exports = { existingBehavior };\n',
    'utf8',
  );
  await fs.writeFile(path.join(populatedCreationProject, 'server.js'), '// TODO: connect application routes\n', 'utf8');
  await fs.writeFile(path.join(populatedCreationProject, 'src', 'existing.js'), 'module.exports = true;\n', 'utf8');
  const populatedFilesBefore = (await listFilesRecursively(populatedCreationProject)).sort();
  const approvalsBeforePopulatedRequest = inlineApprovalRequests.length;
  await invokeIpc('developer:project-attach', sender, { projectRoot: populatedCreationProject });
  dialogResponses.push(1);
  const populatedCreationResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: `Act as an expert full-stack developer. Build a complete feature with a model, POST endpoint, and form component.
 Include proper error handling (try-catch, status codes 201, 400, 500), input validation, and success or error messages.`,
    scope: '.',
  });
  assert.notEqual(populatedCreationResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(populatedCreationResult.outcome, 'SUCCESS', JSON.stringify(populatedCreationResult));
  assert.equal(populatedCreationResult.codeApplied, true);
  assert.equal(populatedCreationResult.codeVerified, true);
  assert.equal(populatedCreationResult.hostExecution?.status, 'SKIPPED_ISOLATION_UNAVAILABLE');
  assert.equal(populatedCreationResult.workflowReceipt.verificationReport.verificationMode, 'STATIC_ONLY');
  const populatedSt2 = populatedCreationResult.taskPlan.subtasks.find((subtask) => subtask.id === 'ST-2');
  assert.equal(populatedSt2?.status, 'COMPLETED');
  assert.ok(populatedSt2.evidence.sourceEvidence.length > 0, 'A populated workspace must cite inspected source files.');
  assert.doesNotMatch(populatedCreationResult.message, /all checks passed/i);
  assert.ok(inlineApprovalRequests.length > approvalsBeforePopulatedRequest, 'The request must reach the proposal approval UI.');
  assert.ok((await listFilesRecursively(populatedCreationProject)).length > populatedFilesBefore.length);
  assert.match(await fs.readFile(path.join(populatedCreationProject, 'index.js'), 'utf8'), /existingBehavior/);
  console.log('TEST 22 PASSED: Approved modular creation uses disk-backed verification without running project commands when isolation is unavailable.');

  const populatedStubProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-populated-stubs-'));
  projectRoots.add(populatedStubProject);
  const populatedStubFiles = {
    'package.json': JSON.stringify({ name: 'populated-stub-project', type: 'commonjs' }),
    'index.js': 'const existingBehavior = true;\nmodule.exports = { existingBehavior };\n',
    'server.js': '// TODO: connect application routes\n',
    'models/subscriptionSchema.js': '// TODO: define subscription fields\n',
    'controllers/subscriptionController.js': '// TODO: handle requests\n',
    'routes/subscriptionRoutes.js': '// TODO: register routes\n',
    'components/SubscriptionForm.jsx': 'export default function SubscriptionForm() { return null; }\n',
    'pages/SubscriptionPage.jsx': 'export default function SubscriptionPage() { return null; }\n',
  };
  for (const [relative, content] of Object.entries(populatedStubFiles)) {
    const target = path.join(populatedStubProject, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  const preservedEntrypoint = await fs.readFile(path.join(populatedStubProject, 'index.js'), 'utf8');
  await invokeIpc('developer:project-attach', sender, { projectRoot: populatedStubProject });
  dialogResponses.push(1);
  const populatedStubResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: `Build a complete full-stack subscription feature with a frontend form and backend API.
Create a POST endpoint /api/subscriptions.
Fields:
- customerName: string (required)
- items: [{ sku: string, quantity: number, unitPrice: number }]
- totalAmount: number
Create a page and form component with success and error messages.`,
    scope: '.',
  });
  assert.equal(populatedStubResult.outcome, 'SUCCESS', JSON.stringify(populatedStubResult));
  assert.equal(populatedStubResult.codeApplied, true);
  assert.equal(populatedStubResult.codeVerified, true);
  assert.deepEqual(populatedStubResult.integrationVerification.verificationModes, ['STATIC_WIRING']);
  assert.equal(populatedStubResult.workflowReceipt.verificationReport.integrationVerification.liveProbePerformed, false);
  assert.equal(populatedStubResult.hermeticVerification?.passed, 9);
  assert.equal(populatedStubResult.hermeticVerification?.total, 9);
  assert.equal(populatedStubResult.executionVerificationReceipt?.status, 'PASSED');
  assert.equal(
    populatedStubResult.workflowReceipt.verificationReport.verificationMode,
    'IN_PROCESS_HTTP_LOOPBACK_AND_HERMETIC_GATES',
  );
  assert.equal(
    populatedStubResult.hermeticVerification.runtimeVerification.executionMode,
    'IN_PROCESS_HTTP_LOOPBACK',
  );
  assert.equal(
    populatedStubResult.hostExecution?.status,
    'SKIPPED_ISOLATION_UNAVAILABLE',
    'Static verification must not claim host project commands were run when isolation is unavailable.',
  );
  assert.equal(await fs.readFile(path.join(populatedStubProject, 'index.js'), 'utf8'), preservedEntrypoint);
  assert.match(await fs.readFile(path.join(populatedStubProject, 'models', 'subscriptionSchema.js'), 'utf8'), /function validate/);
  assert.match(await fs.readFile(path.join(populatedStubProject, 'routes', 'subscriptionRoutes.js'), 'utf8'), /registerRoutes/);
  assert.match(await fs.readFile(path.join(populatedStubProject, 'components', 'SubscriptionForm.jsx'), 'utf8'), /api\/subscriptions/);
  console.log('TEST 23 PASSED: Approved placeholder upgrades pass all nine gates and in-process HTTP loopback verification while host commands remain isolation-gated.');

  const partialOrderProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-partial-order-scaffold-'));
  projectRoots.add(partialOrderProject);
  await fs.mkdir(path.join(partialOrderProject, 'utils'), { recursive: true });
  await fs.mkdir(path.join(partialOrderProject, 'services'), { recursive: true });
  await fs.writeFile(
    path.join(partialOrderProject, 'server.js'),
    "const { executeFeature } = require('./services/featureService');\n",
    'utf8',
  );
  await fs.writeFile(path.join(partialOrderProject, 'utils', 'sharedUtils.js'), 'module.exports = {};\n', 'utf8');
  await fs.writeFile(path.join(partialOrderProject, 'services', 'featureService.js'), 'module.exports = {};\n', 'utf8');
  await invokeIpc('developer:project-attach', sender, { projectRoot: partialOrderProject });
  dialogResponses.push(1);
  const partialOrderResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: `Act as an expert Full-Stack Developer. Build a complete 'Add Order' feature.
Create an Order Model/Schema and a POST endpoint /api/orders.
Fields:
- customerName: string (required)
- items: [{ itemName: string, quantity: number, price: number }]
- totalPrice: number (auto calculated)
- status: string (default: "Pending")
- createdAt: date
Create a Next.js App Router page and React form component with Tailwind CSS, dynamic item rows, and success/error messages.`,
    scope: '.',
  });
  assert.equal(partialOrderResult.outcome, 'SUCCESS', JSON.stringify(partialOrderResult));
  assert.equal(partialOrderResult.codeApplied, true);
  assert.equal(partialOrderResult.codeVerified, true);
  assert.equal(partialOrderResult.hermeticVerification.passed, 9, JSON.stringify(partialOrderResult.hermeticVerification));
  assert.equal(partialOrderResult.hermeticVerification.total, 9);
  const partialOrderGenerated = await listFilesRecursively(partialOrderProject);
  for (const requiredPath of [
    'server.js',
    'package.json',
    '.env.example',
    'README.md',
    path.join('config', 'db.js'),
    path.join('models', 'Order.js'),
    path.join('controllers', 'orderController.js'),
    path.join('routes', 'orders.js'),
    path.join('components', 'OrderForm.jsx'),
    path.join('app', 'orders', 'page.jsx'),
  ]) {
    assert.ok(partialOrderGenerated.includes(requiredPath), `Partial workspace execution must create ${requiredPath}.`);
  }
  assert.doesNotMatch(await fs.readFile(path.join(partialOrderProject, 'server.js'), 'utf8'), /featureService/);
  assert.match(await fs.readFile(path.join(partialOrderProject, 'models', 'Order.js'), 'utf8'), /totalPrice/);
  assert.match(await fs.readFile(path.join(partialOrderProject, 'models', 'Order.js'), 'utf8'), /itemName/);
  assert.match(await fs.readFile(path.join(partialOrderProject, 'routes', 'orders.js'), 'utf8'), /\/api\/orders/);
  assert.match(await fs.readFile(path.join(partialOrderProject, 'components', 'OrderForm.jsx'), 'utf8'), /space-y-4/);
  console.log('TEST 23B PASSED: One-file partial workspace upgrades to the complete Order module set and verifies all five gates.');

  const populatedFullStackProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-populated-full-stack-'));
  projectRoots.add(populatedFullStackProject);
  const populatedFullStackFiles = {
    'config/db.js': "const mongoose = require('mongoose');\nmodule.exports = mongoose;\n",
    'models/Order.js': "const mongoose = require('mongoose');\nmodule.exports = new mongoose.Schema({});\n",
    'controllers/orderController.js': "const { missingModel } = require('../models/Order');\nmodule.exports = { missingModel };\n",
    'routes/orders.js': "const { missingHandler } = require('../controllers/orderController');\nmodule.exports = missingHandler;\n",
    'server.js': "const express = require('express');\nmodule.exports = express();\n",
    'components/OrderForm.jsx': "import React, { useState } from 'react';\nexport default function OrderForm() { return null; }\n",
    'app/orders/page.jsx': "import { MissingOrderForm } from '../../components/OrderForm.jsx';\nexport default function OrderPage() { return <MissingOrderForm />; }\n",
    'pages/orders.js': 'export default function LegacyOrderPage() { return null; }\n',
    'package.json': JSON.stringify({
      name: 'legacy-order-project',
      type: 'commonjs',
      scripts: { start: 'node generated/order/server.js', dev: 'node generated/order/server.js' },
      dependencies: { express: '^4.0.0', mongoose: '^8.0.0', react: '^18.0.0', 'react-dom': '^18.0.0' },
    }, null, 2),
    '.env.example': 'PORT=4300\nDATABASE_URL=mongodb://localhost/legacy\n',
    'README.md': '# Existing order project\n',
  };
  for (const [relativePath, content] of Object.entries(populatedFullStackFiles)) {
    const target = path.join(populatedFullStackProject, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  const generatedLegacyServer = path.join(populatedFullStackProject, 'generated', 'order', 'server.js');
  await fs.mkdir(path.dirname(generatedLegacyServer), { recursive: true });
  await fs.writeFile(generatedLegacyServer, 'module.exports = {};\n', 'utf8');
  const retainedFullStackEnvironment = await fs.readFile(path.join(populatedFullStackProject, '.env.example'), 'utf8');
  await invokeIpc('developer:project-attach', sender, { projectRoot: populatedFullStackProject });
  dialogResponses.push(1);
  const populatedFullStackResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: `Build a complete full-stack order feature with a form and backend API.
Create a POST endpoint /api/orders.
Fields:
- customerName: string (required)
- items: [{ itemName: string, quantity: number, price: number }]
- totalPrice: number (auto calculated)
- status: string (default=Pending)
Create a Next.js App Router page and React form component.`,
    scope: '.',
  });
  assert.equal(populatedFullStackResult.outcome, 'SUCCESS', JSON.stringify(populatedFullStackResult));
  assert.equal(populatedFullStackResult.codeApplied, true);
  assert.equal(populatedFullStackResult.codeVerified, true);
  assert.equal(populatedFullStackResult.hermeticVerification?.passed, 9, JSON.stringify(populatedFullStackResult.hermeticVerification));
  assert.equal(populatedFullStackResult.hermeticVerification?.total, 9);
  assert.equal(populatedFullStackResult.executionVerificationReceipt?.status, 'PASSED');
  assert.match(populatedFullStackResult.message, /verified across 9\/9 hermetic gates/);
  assert.match(populatedFullStackResult.message, /POST \/api\/orders -> 201 Created — PASS/);
  assert.match(populatedFullStackResult.message, /GET \/api\/orders -> 200 OK — PASS/);
  assert.match(populatedFullStackResult.message, /GET \/orders interactive form -> 200 — PASS/);
  assert.doesNotMatch(populatedFullStackResult.message, /Live route reachability was not probed|disk-backed static checks passed/i);
  assert.equal(populatedFullStackResult.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.ok(populatedFullStackResult.hermeticVerification.runtimeVerification.probes
    .some((probe) => probe.id === 'persisted-collection-list' && probe.passed));
  assert.ok(populatedFullStackResult.hermeticVerification.runtimeVerification.probes
    .some((probe) => probe.method === 'POST' && probe.routePath === '/api/orders' && probe.actual === 201 && probe.passed));
  assert.ok(populatedFullStackResult.hermeticVerification.runtimeVerification.uiPreview.paths
    .some((probe) => probe.path === '/orders' && probe.statusCode === 200 && probe.passed));
  assert.ok(populatedFullStackResult.filesModified.includes('server.js'));
  assert.ok(populatedFullStackResult.filesModified.includes('package.json'));
  assert.equal(
    JSON.parse(await fs.readFile(path.join(populatedFullStackProject, 'package.json'), 'utf8')).scripts.start,
    'node server.js',
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(populatedFullStackProject, 'package.json'), 'utf8')).scripts.test,
    'node tests/order.test.js',
  );
  assert.ok(populatedFullStackResult.filesModified.includes('tests/order.test.js'));
  for (const relativePath of [
    'config/db.js',
    'models/Order.js',
    'controllers/orderController.js',
    'routes/orders.js',
    'server.js',
    'components/OrderForm.jsx',
    'app/orders/page.jsx',
  ]) {
    assert.ok(populatedFullStackResult.filesModified.includes(relativePath), `Autonomous target upgrade should modify ${relativePath}.`);
  }
  await assert.rejects(fs.stat(path.join(populatedFullStackProject, 'pages', 'orders.js')), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(populatedFullStackProject, 'legacy-pages-orders.js.txt'))).isFile());
  assert.equal(await fs.readFile(path.join(populatedFullStackProject, '.env.example'), 'utf8'), retainedFullStackEnvironment);
  for (const userRequest of [
    'test the project',
    'est the project',
    'test the my project is wroking now',
    'st the my project is wroking now',
  ]) {
    const runtimeTestResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest,
      scope: '.',
    });
    assert.equal(runtimeTestResult.outcome, 'SUCCESS', JSON.stringify(runtimeTestResult));
    assert.equal(runtimeTestResult.codeApplied, false, 'A passing test request must not modify files.');
    assert.equal(runtimeTestResult.hermeticVerification?.passed, 9);
    assert.equal(runtimeTestResult.hermeticVerification?.total, 9);
    assert.equal(runtimeTestResult.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
    assert.equal(runtimeTestResult.executionVerificationReceipt?.status, 'PASSED');
    assert.match(runtimeTestResult.message, /verified across 9\/9 hermetic gates/);
    assert.match(runtimeTestResult.message, /POST \/api\/orders -> 201 Created — PASS/);
    assert.match(runtimeTestResult.message, /GET \/api\/orders -> 200 OK — PASS/);
    assert.match(runtimeTestResult.message, /GET \/orders interactive form -> 200 — PASS/);
    assert.doesNotMatch(runtimeTestResult.message, /Runtime behavior is not verified|No automated tests exist beyond the syntax check|config\/db\.js.*might be missing/i);
    assert.equal(runtimeTestResult.filesModified.length, 0);
  }
  const staleRuntimeTestProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-stale-runtime-tests-'));
  projectRoots.add(staleRuntimeTestProject);
  await fs.cp(populatedFullStackProject, staleRuntimeTestProject, { recursive: true });
  const staleRuntimeTestPath = path.join(staleRuntimeTestProject, 'tests', 'order.test.js');
  const validStaleRuntimeTest = await fs.readFile(staleRuntimeTestPath, 'utf8');
  const corruptedStaleRuntimeTest = validStaleRuntimeTest.replace(
    "console.log('Loopback UI, API behavior, persistence, and controller error boundary passed.');",
    'console.log([REDACTED] UI, API behavior, persistence, and controller error boundary.);',
  );
  assert.notEqual(corruptedStaleRuntimeTest, validStaleRuntimeTest);
  await fs.writeFile(staleRuntimeTestPath, corruptedStaleRuntimeTest, 'utf8');
  const staleRuntimePackagePath = path.join(staleRuntimeTestProject, 'package.json');
  const staleRuntimePackage = {
    name: 'legacy-order-app',
    version: '1.0.0',
    type: 'commonjs',
    scripts: {
      start: 'node server.js',
      dev: 'node server.js',
      test: 'node --check server.js',
    },
  };
  const staleRuntimePackageContents = `${JSON.stringify(staleRuntimePackage, null, 2)}\n`;
  assert.ok(Buffer.byteLength(staleRuntimePackageContents) <= 278);
  await fs.writeFile(staleRuntimePackagePath, staleRuntimePackageContents.padEnd(278, ' '), 'utf8');
  assert.equal((await fs.stat(staleRuntimePackagePath)).size, 278);
  const staleRuntimeModelPath = path.join(staleRuntimeTestProject, 'models', 'Order.js');
  const staleRuntimeModel = await fs.readFile(staleRuntimeModelPath, 'utf8');
  assert.match(staleRuntimeModel, /return records\.map\(\(record\) => \(\{ \.\.\.record \}\)\);/);
  const degradedRuntimeModel = staleRuntimeModel.replace(
    /return records\.map\(\(record\) => \(\{ \.\.\.record \}\)\);/,
    'return [];',
  );
  assert.notEqual(degradedRuntimeModel, staleRuntimeModel);
  await fs.writeFile(
    staleRuntimeModelPath,
    degradedRuntimeModel,
    'utf8',
  );
  await invokeIpc('developer:project-attach', sender, { projectRoot: staleRuntimeTestProject });
  dialogResponses.push(1);
  const staleRuntimeTestResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'test the project',
    scope: '.',
  });
  assert.equal(staleRuntimeTestResult.outcome, 'SUCCESS', JSON.stringify(staleRuntimeTestResult));
  assert.equal(staleRuntimeTestResult.codeApplied, true);
  assert.equal(staleRuntimeTestResult.hermeticVerification?.passed, 9);
  assert.equal(staleRuntimeTestResult.hermeticVerification?.total, 9);
  assert.equal(staleRuntimeTestResult.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.equal(staleRuntimeTestResult.executionVerificationReceipt?.status, 'PASSED');
  assert.match(staleRuntimeTestResult.message, /verified across 9\/9 hermetic gates/);
  assert.match(staleRuntimeTestResult.message, /GET \/orders interactive form -> 200 — PASS/);
  assert.match(staleRuntimeTestResult.message, /POST \/api\/orders -> 201 Created — PASS/);
  assert.match(staleRuntimeTestResult.message, /GET \/api\/orders -> 200 OK — PASS/);
  assert.doesNotMatch(staleRuntimeTestResult.message, /no real test suite beyond a syntax check|No test files are present/i);
  assert.ok(staleRuntimeTestResult.hermeticVerification.runtimeVerification.probes
    .some((probe) => probe.method === 'POST' && probe.routePath === '/api/orders' && probe.actual === 201 && probe.passed));
  assert.ok(staleRuntimeTestResult.hermeticVerification.runtimeVerification.probes
    .some((probe) => probe.actual === 400 && probe.passed));
  assert.ok(staleRuntimeTestResult.hermeticVerification.runtimeVerification.probes
    .some((probe) => probe.actual === 500 && probe.passed));
  assert.ok(staleRuntimeTestResult.filesModified.includes('tests/order.test.js'));
  assert.ok(staleRuntimeTestResult.filesModified.includes('models/Order.js'), 'The legacy runtime failure must repair the implicated disk module.');
  assert.equal(
    JSON.parse(await fs.readFile(staleRuntimePackagePath, 'utf8')).scripts.test,
    'node tests/order.test.js',
  );
  const runtimeTestFilePath = path.join(staleRuntimeTestProject, 'tests', 'order.test.js');
  assert.ok((await fs.stat(runtimeTestFilePath)).isFile());
  const runtimeTestSource = await fs.readFile(runtimeTestFilePath, 'utf8');
  const redactedRuntimeTestSource = runtimeTestSource.replace(
    "console.log('Loopback UI, API behavior, persistence, and controller error boundary passed.');",
    'console.log([REDACTED] UI, API behavior, persistence, and controller error boundary.);',
  );
  assert.notEqual(redactedRuntimeTestSource, runtimeTestSource);
  await fs.writeFile(runtimeTestFilePath, redactedRuntimeTestSource, 'utf8');
  const originalRuntimeRunVerification = devFiles.runVerification;
  let hostRunnerCalls = 0;
  devFiles.runVerification = async () => {
    hostRunnerCalls += 1;
    return {
      ok: false,
      status: 'VERIFICATION_UNAVAILABLE',
      executed: false,
      exitCode: 127,
      stdout: '',
      stderr: 'Test runner binary not found on host.',
    };
  };
  let repairedRuntimeTestResult;
  let repeatedRuntimeTestResult;
  try {
    dialogResponses.push(1);
    repairedRuntimeTestResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'test the project',
      scope: '.',
    });
    repeatedRuntimeTestResult = await invokeIpc('developer:workflow-execute', sender, {
      userRequest: 'est the project',
      scope: '.',
    });
  } finally {
    devFiles.runVerification = originalRuntimeRunVerification;
  }
  assert.equal(hostRunnerCalls, 0, 'The in-process runtime-test path must not rely on the unavailable host runner.');
  assert.equal(repairedRuntimeTestResult.outcome, 'SUCCESS', JSON.stringify(repairedRuntimeTestResult));
  assert.equal(repairedRuntimeTestResult.codeApplied, true);
  assert.equal(repairedRuntimeTestResult.hermeticVerification?.passed, 9);
  assert.equal(repairedRuntimeTestResult.executionVerificationReceipt?.status, 'PASSED');
  assert.ok(repairedRuntimeTestResult.filesModified.includes('tests/order.test.js'));
  const repairedRuntimeTestSource = await fs.readFile(runtimeTestFilePath, 'utf8');
  assert.doesNotMatch(repairedRuntimeTestSource, /\[REDACTED\]/);
  assert.match(repairedRuntimeTestSource, /Loopback UI, API behavior, persistence, and controller error boundary passed/);
  assert.equal(repeatedRuntimeTestResult.outcome, 'SUCCESS', JSON.stringify(repeatedRuntimeTestResult));
  assert.equal(repeatedRuntimeTestResult.codeApplied, false);
  assert.equal(repeatedRuntimeTestResult.filesModified.length, 0);
  assert.equal(repeatedRuntimeTestResult.hermeticVerification?.passed, 9);
  assert.equal(repeatedRuntimeTestResult.executionVerificationReceipt?.status, 'PASSED');
  assert.equal(repeatedRuntimeTestResult.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');

  const inlineRuntimeTestProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-inline-corrupt-runtime-tests-'));
  projectRoots.add(inlineRuntimeTestProject);
  await fs.cp(populatedFullStackProject, inlineRuntimeTestProject, { recursive: true });
  const inlineRuntimePackagePath = path.join(inlineRuntimeTestProject, 'package.json');
  await fs.writeFile(inlineRuntimePackagePath, staleRuntimePackageContents.padEnd(278, ' '), 'utf8');
  const inlineRuntimeTestPath = path.join(inlineRuntimeTestProject, 'tests', 'order.test.js');
  await fs.writeFile(inlineRuntimeTestPath, corruptedStaleRuntimeTest, 'utf8');
  const inlineApprovalCount = inlineApprovalRequests.length;
  await invokeIpc('developer:project-attach', sender, { projectRoot: inlineRuntimeTestProject });
  deferInlineApprovalDecision = true;
  const inlineRuntimeWorkflow = invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'test the project',
    scope: '.',
  });
  let stagedInlineApproval;
  try {
    for (let attempt = 0; attempt < 100 && inlineApprovalRequests.length === inlineApprovalCount; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(inlineApprovalRequests.length > inlineApprovalCount, 'Inline review must stage the repair proposal before any disk write.');
    stagedInlineApproval = inlineApprovalRequests.at(-1);
    const stagedTask = devAgent.getTaskForTest(stagedInlineApproval.proposalId);
    assert.equal(stagedTask.proposalContract.hermeticPreflight.passed, 9);
    assert.equal(stagedTask.proposalContract.hermeticPreflight.total, 9);
    assert.equal(
      stagedTask.proposalContract.hermeticPreflight.runtimeVerification.executionMode,
      'IN_PROCESS_HTTP_LOOPBACK',
    );
    assert.match(stagedInlineApproval.diff, /Loopback UI, API behavior, persistence, and controller error boundary passed/);
    assert.equal(await fs.readFile(inlineRuntimeTestPath, 'utf8'), corruptedStaleRuntimeTest);
    assert.equal(JSON.parse(await fs.readFile(inlineRuntimePackagePath, 'utf8')).scripts.test, 'node --check server.js');
  } finally {
    deferInlineApprovalDecision = false;
    if (stagedInlineApproval) {
      await invokeIpc('developer:workflow-approval-decision', sender, {
        approvalRequestId: stagedInlineApproval.approvalRequestId,
        proposalId: stagedInlineApproval.proposalId,
        proposalDigest: stagedInlineApproval.proposalDigest,
        approved: true,
      });
    }
  }
  const inlineRuntimeTestResult = await inlineRuntimeWorkflow;
  assert.equal(inlineRuntimeTestResult.outcome, 'SUCCESS', JSON.stringify(inlineRuntimeTestResult));
  assert.equal(inlineRuntimeTestResult.codeApplied, true);
  assert.equal(inlineRuntimeTestResult.hermeticVerification?.passed, 9);
  assert.equal(inlineRuntimeTestResult.executionVerificationReceipt?.status, 'PASSED');
  assert.equal(inlineRuntimeTestResult.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.doesNotMatch(inlineRuntimeTestResult.message, /Verification runner was unavailable or offline/);
  assert.doesNotMatch(await fs.readFile(inlineRuntimeTestPath, 'utf8'), /\[REDACTED\]/);
  assert.equal(JSON.parse(await fs.readFile(inlineRuntimePackagePath, 'utf8')).scripts.test, 'node tests/order.test.js');

  const scalarRuntimeProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-scalar-runtime-tests-'));
  projectRoots.add(scalarRuntimeProject);
  const scalarPlan = await devAgent.deriveModularPlan(scalarRuntimeProject, {
    userRequest: `Build a complete full-stack 'Customer' feature with an interactive React form.
Create a POST endpoint /api/customers.
Fields:
- displayName: string required
- email: string required
Create an application page and form component with validation and success/error messages.`,
  });
  assert.ok(scalarPlan.routeSchema.fields.every((field) => field.type !== 'array'));
  for (const module of scalarPlan.modulesToCreate) {
    if (module.operation === 'rename') continue;
    const target = path.join(scalarRuntimeProject, ...module.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, module.content, 'utf8');
  }
  await invokeIpc('developer:project-attach', sender, { projectRoot: scalarRuntimeProject });
  const scalarRuntimeResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: 'test the project',
    scope: '.',
  });
  assert.equal(scalarRuntimeResult.outcome, 'SUCCESS', JSON.stringify(scalarRuntimeResult));
  assert.equal(scalarRuntimeResult.codeApplied, false);
  assert.equal(scalarRuntimeResult.hermeticVerification?.passed, 9);
  assert.equal(scalarRuntimeResult.executionVerificationReceipt?.status, 'PASSED');
  assert.ok(scalarRuntimeResult.executionVerificationReceipt.apiProbes.some((probe) => probe.applicable === false));
  assert.match(scalarRuntimeResult.message, /N\/A \(not applicable to this schema\)/);
  assert.doesNotMatch(scalarRuntimeResult.message, /empty array\) — PASS|invalid item\) — PASS/);
  console.log('TEST 23C PASSED: Populated full-stack targets auto-upgrade, run the real loopback verifier, and generate/update the behavioral test suite through approved IPC.');

  const substantiveProject = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-substantive-target-'));
  projectRoots.add(substantiveProject);
  await fs.writeFile(path.join(substantiveProject, 'package.json'), JSON.stringify({ name: 'substantive-project' }), 'utf8');
  await fs.writeFile(path.join(substantiveProject, 'index.js'), 'const existingBehavior = true;\nmodule.exports = { existingBehavior };\n', 'utf8');
  const substantiveFilesBefore = (await listFilesRecursively(substantiveProject)).sort();
  await invokeIpc('developer:project-attach', sender, { projectRoot: substantiveProject });
  const substantiveResult = await invokeIpc('developer:workflow-execute', sender, {
    userRequest: `Build a complete full-stack subscription feature with a form and backend API.
Create a POST endpoint /api/subscriptions.
Fields:
- customerName: string (required)
- items: [{ sku: string, quantity: number }]
Create a page component.`,
    scope: '.',
  });
  assert.equal(substantiveResult.outcome, 'CLARIFICATION_REQUIRED', JSON.stringify(substantiveResult));
  assert.equal(substantiveResult.codeApplied, false);
  assert.equal(substantiveResult.codeVerified, false);
  assert.match(substantiveResult.clarificationPrompt, /index\.js/);
  assert.deepEqual((await listFilesRecursively(substantiveProject)).sort(), substantiveFilesBefore);
  console.log('TEST 24 PASSED: Substantive target files require a clear integration decision before proposal generation or writes.');

    console.log('Deterministic real-request IPC integration verified; relevance responses are test fixtures, not live-provider evidence.');
} finally {
  electronMock.app.quit();
  let shutdownTimeout;
  await Promise.race([
    appQuitComplete,
    new Promise((resolve) => {
      shutdownTimeout = setTimeout(resolve, 15000);
    }),
  ]);
  clearTimeout(shutdownTimeout);
  globalThis.fetch = originalFetch;
  if (previousCodingAuthToken === undefined) delete process.env.AI_CODING_AUTH_TOKEN;
  else process.env.AI_CODING_AUTH_TOKEN = previousCodingAuthToken;
  if (previousMutationHandshakeSecret === undefined) delete process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET;
  else process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET = previousMutationHandshakeSecret;
  for (const root of projectRoots) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
  await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
}
