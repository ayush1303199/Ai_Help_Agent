import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  codingFetch,
  executeTrustedBrokerWorkflow,
  buildProjectRuntimeInspectionActivities,
  getCodingBrowserSessionId,
  classifyCodingRequestIntent,
  isProjectRuntimeTestRequest,
  formatProjectRuntimeTestCompletionMessage,
  normalizeProjectRuntimeTestWorkflowResult,
  shouldRequireDeveloperWorkflowForAttachedProject,
} from '../src/features/coding/codingTransport.ts';
import { runtimeConfig } from '../src/config/runtimeConfig.ts';

const runtimeSettings = JSON.parse(await readFile(new URL('../src/config/runtimeSettings.json', import.meta.url), 'utf8'));
const readinessPage = await readFile(new URL('../src/features/coding/CodingAgentPage.tsx', import.meta.url), 'utf8');
const codingController = await readFile(new URL('../src/features/coding/useCodingAgentController.ts', import.meta.url), 'utf8');
assert.match(readinessPage, /codingFetch\([\s\S]*?acceptance-preflight/, 'Readiness requests must use the transport that supplies the persistent browser session header.');
assert.match(
  codingController,
  /isRuntimeProjectTest\s*\|\|\s*continuationToken\s*\|\|\s*classification\.intent === 'AUTONOMOUS_WORKFLOW_TASK'/,
  'Project-test requests must route into the deterministic workflow even when general intent classification misses them.',
);
assert.match(
  codingController,
  /Candidate verification \(pre-approval\)[\s\S]*formatProjectRuntimeTestReceiptMessage/,
  'Inline review must format the candidate receipt and workspace audit without claiming unapproved files were applied.',
);
assert.match(
  codingController,
  /formatProjectRuntimeTestCompletionMessage\([\s\S]*?result\.filesModified/,
  'The final project-test chat receipt must place the workspace audit before the modified-files list.',
);
assert.match(
  codingController,
  /buildProjectRuntimeInspectionActivities\(requestId, result\)/,
  'The controller must turn broker inspection metadata into rendered workspace activity cards.',
);
assert.match(
  codingController,
  /engineeringAnalysis:\s*result\.engineeringAnalysis/,
  'Final runtime-test messages must include engineering summaries preserved in the receipt.',
);
const codingWorkspace = await readFile(new URL('../src/features/coding/CodingAgentWorkspace.tsx', import.meta.url), 'utf8');
assert.match(codingWorkspace, /Engineering Analysis & Inspected Files/);
assert.match(codingWorkspace, /open=\{hasEngineeringEvidence \|\| Boolean/);
const browser = new JSDOM('', {
  url: `http://localhost:${runtimeSettings.services.devServer.port}/`,
});
globalThis.window = browser.window;

const projectId = '218be83a-441b-4fc9-93be-6224f1582f88';
const projectRoot = 'C:\\workspace\\selected-project';
const browserSessionId = 'c6248052-d5ad-4d28-bcc6-18d54ba9a637';
const creationPrompt = `Act as an expert Full-Stack Developer. Build a complete feature.
Create a model/schema and a POST endpoint with validation.
Include proper error handling (try-catch, status codes like 201, 400, 500).
Create a page/component and display success or error toast/messages accordingly.`;
const typoCreationPrompt = creationPrompt.replace(/^Act/, 'ct');
browser.window.localStorage.setItem('coding-browser-session-v1', browserSessionId);
assert.equal(getCodingBrowserSessionId(), browserSessionId, 'A restored browser should reuse its persisted coding session identity.');
for (const prompt of [creationPrompt, typoCreationPrompt]) {
  const classification = classifyCodingRequestIntent(prompt);
  assert.equal(classification.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: classification.intent,
    requestText: prompt,
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
  }), true, 'Full-stack creation requests must take the authorized workflow route.');
}
for (const prompt of [
  'test the project',
  'test the project\n\nWorkspace resolution: UPDATE_AND_INTEGRATE.',
  'test the project\n\nWorkspace resolution: KEEP_AND_SCAFFOLD.',
  'test project',
  'test my project',
  'run tests',
  'run the tests',
  'test it',
  'test app',
  'verify the project',
  'verify project',
  'check if the project works',
  'is the project working',
  'test server.js',
  'test api',
]) {
  assert.equal(isProjectRuntimeTestRequest(prompt), true, `${prompt} should be recognized as a project runtime test.`);
  const classification = classifyCodingRequestIntent(prompt);
  assert.equal(classification.intent, 'AUTONOMOUS_WORKFLOW_TASK', `${prompt} should use the autonomous workflow.`);
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: classification.intent,
    requestText: prompt,
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
  }), true, `${prompt} must route through the trusted browser broker.`);
}
for (const context of [
  { isResumingProviderTask: true },
  { hasRepairContext: true },
]) {
  assert.equal(shouldRequireDeveloperWorkflowForAttachedProject({
    intent: 'AUTONOMOUS_WORKFLOW_TASK',
    requestText: 'test the project',
    hasAttachedProject: true,
    hasDeveloperWorkflowBridge: false,
    ...context,
  }), true, 'A project test must supersede stale resume/repair routing and reach the broker.');
}
for (const prompt of [
  'Explain how to test the project',
  'How does project test selection work?',
  'Should we add tests for this endpoint?',
]) {
  assert.equal(isProjectRuntimeTestRequest(prompt), false, `${prompt} is an inquiry, not a test command.`);
  assert.equal(classifyCodingRequestIntent(prompt).intent, 'QUESTION_OR_EXPLANATION');
}
const lease = {
  brokerSessionId: 'session-handle',
  sessionLeaseToken: 'ephemeral-lease-token',
};
const pendingApproval = {
  taskId: 'task-handle',
  proposalId: 'proposal-handle',
  proposalDigest: 'a'.repeat(64),
  workflowRequestId: randomUUID(),
  approvalNonce: 'one-time-approval-nonce',
  deleteConfirmationRequired: false,
  fileOperations: [{
    path: 'src/generated/module.ts',
    sourcePath: null,
    operation: 'create',
    hash: 'b'.repeat(64),
    content: 'export const generated = true;\n',
  }],
  diff: '--- /dev/null\n+++ src/generated/module.ts\n+export const generated = true;',
  envelope: {
    proposalId: 'proposal-handle',
    proposalDigest: 'a'.repeat(64),
    projectId,
    approvalNonce: 'one-time-approval-nonce',
    summary: '1 create across 1 file operation',
    fileBadges: [{ filePath: 'src/generated/module.ts', action: 'create', lineCount: 1 }],
    diffPreview: [{
      filePath: 'src/generated/module.ts',
      action: 'create',
      lines: ['--- /dev/null', '+++ src/generated/module.ts'],
    }],
    debugTrace: {
      stage: 'AWAITING_INLINE_APPROVAL',
      timestamp: new Date().toISOString(),
      sessionId: 'session-handle',
      verificationStatus: 'NOT_STARTED',
    },
  },
};

let observedDecision;
let expectedWorkflowRequest = creationPrompt;
let expectedExecutionMode = 'inline_review';
let runtimeTestTransport = false;
const runtimeTestHermeticVerification = {
  passed: 9,
  total: 9,
  gates: Array.from({ length: 9 }, (_, index) => ({ id: `gate-${index + 1}`, passed: true })),
};
const runtimeTestExecutionReceipt = {
  status: 'PASSED',
  message: 'The staged project-test candidate was verified across 9/9 hermetic gates.\nPOST /api/orders -> 201 Created — PASS.',
  apiProbes: [{ method: 'POST', path: '/api/orders', statusCode: 201, passed: true }],
  inspectedFiles: [
    'package.json',
    'server.js',
    'config/db.js',
    'models/Order.js',
    'controllers/orderController.js',
    'routes/orders.js',
    'components/OrderForm.jsx',
    'app/orders/page.jsx',
    'tests/order.test.js',
  ].map((path) => ({ path, lineCount: 12, byteSize: 420 })),
  exploredDirectories: [
    '.', 'config', 'models', 'controllers', 'routes', 'components', 'app', 'tests',
  ].map((path) => ({ path, entryCount: 3 })),
  engineeringSummary: [
    { phase: 'Workspace topology', summary: 'Read 9 workspace files and enumerated 8 directories.' },
    { phase: 'Runtime contract', summary: 'Validated the Order route and generated behavior tests.' },
    { phase: 'Environment and drift', summary: 'Missing .env and stale server.js were detected.' },
    { phase: 'Verification', summary: '9/9 gates and all applicable loopback probes passed.' },
  ],
  workspaceAudit: {
    findings: [
      '[DETECTED WORKSPACE GAP] Missing node_modules for JSX source files (app/orders/page.jsx, components/OrderForm.jsx): standalone Next.js/React compilation requires installed dependencies.',
      '[DETECTED WORKSPACE GAP] Missing .env file: .env.example exists, but .env has not been created.',
      '[DETECTED BUG] Stale server.js UI contract; review routes/orders.js, app/orders/page.jsx, and config/db.js against models/Order.js and controllers/orderController.js.',
    ],
    bugs: [{ path: 'server.js', line: 88, description: 'Embedded form is missing the items[] schema fields.' }],
    syncPlan: [{ path: 'server.js', action: 'REPAIR', reason: 'Synchronize the embedded form with the Order items[] contract.' }],
    dependencies: { declared: [], nodeModulesPresent: false },
    environment: { envExamplePresent: true, envFilePresent: false, jsxFiles: ['app/orders/page.jsx', 'components/OrderForm.jsx'] },
  },
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(
    new Headers(init.headers).get('X-Coding-Browser-Session'),
    browserSessionId,
    `${url.pathname} should carry the same persistent local browser session identity.`,
  );
  if (url.pathname === '/api/coding/project-attach') {
    assert.deepEqual(JSON.parse(init.body), { projectRoot });
    return Response.json({ status: 'PROJECT_ATTACHED', projectRoot });
  }
  if (url.pathname === '/api/coding/acceptance-preflight') {
    return Response.json({
      projectAttached: true,
      projectStatus: 'PROJECT_ATTACHED',
      projectRoot,
      projectIdentity: 'BROKER_VERIFIED',
    });
  }
  if (url.pathname === '/api/coding/broker') {
    return Response.json({ projects: [{ projectId }] });
  }
  if (url.pathname === '/api/coding/broker/sessions') {
    assert.deepEqual(JSON.parse(init.body), { projectId });
    return Response.json(lease);
  }
  if (url.pathname === '/api/coding/broker/sessions/heartbeat') {
    return Response.json({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
  }
  if (url.pathname === '/api/coding/broker/workflows') {
    const workflowPayload = JSON.parse(init.body);
    assert.equal(workflowPayload.executionMode, expectedExecutionMode);
    assert.equal(workflowPayload.userRequest, expectedWorkflowRequest);
    if (runtimeTestTransport) {
      if (expectedExecutionMode === 'inline_review') {
        return Response.json({
          outcome: 'AWAITING_APPROVAL',
          phase: 'APPROVE',
          filesModified: [],
          codeApplied: false,
          codeVerified: false,
          hermeticVerification: runtimeTestHermeticVerification,
          executionVerificationReceipt: runtimeTestExecutionReceipt,
          inspectedFiles: runtimeTestExecutionReceipt.inspectedFiles,
          exploredDirectories: runtimeTestExecutionReceipt.exploredDirectories,
          engineeringSummary: runtimeTestExecutionReceipt.engineeringSummary,
          approval: {
            ...pendingApproval,
            hermeticVerification: runtimeTestHermeticVerification,
            executionVerificationReceipt: runtimeTestExecutionReceipt,
            inspectedFiles: runtimeTestExecutionReceipt.inspectedFiles,
            exploredDirectories: runtimeTestExecutionReceipt.exploredDirectories,
            engineeringSummary: runtimeTestExecutionReceipt.engineeringSummary,
          },
        });
      }
      return Response.json({
        outcome: 'VERIFICATION_UNAVAILABLE',
        filesModified: ['package.json', 'tests/order.test.js'],
        codeVerified: false,
        rolledBack: false,
        executionVerificationReceipt: {
          status: 'PASSED',
          message: 'Verified across 9/9 hermetic gates; POST /api/orders -> 201 Created — PASS.',
          probes: [{ method: 'POST', routePath: '/api/orders', statusCode: 201, passed: true }],
          workspaceAudit: runtimeTestExecutionReceipt.workspaceAudit,
          inspectedFiles: runtimeTestExecutionReceipt.inspectedFiles,
          exploredDirectories: runtimeTestExecutionReceipt.exploredDirectories,
          engineeringSummary: runtimeTestExecutionReceipt.engineeringSummary,
        },
        inspectedFiles: runtimeTestExecutionReceipt.inspectedFiles,
        exploredDirectories: runtimeTestExecutionReceipt.exploredDirectories,
        engineeringSummary: runtimeTestExecutionReceipt.engineeringSummary,
        hermeticVerification: {
          status: 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED',
          passed: 9,
          total: 9,
          gates: Array.from({ length: 9 }, (_, index) => ({ id: `gate-${index + 1}`, passed: true })),
        },
      });
    }
    return Response.json({
      outcome: 'AWAITING_APPROVAL',
      phase: 'APPROVE',
      filesModified: [],
      approval: pendingApproval,
    });
  }
  if (url.pathname === '/api/coding/broker/workflows/approval') {
    throw new Error('The browser must use the staged workflow response, not poll for approval.');
  }
  if (url.pathname === '/api/coding/broker/workflows/approval/decision') {
    observedDecision = JSON.parse(init.body);
    return Response.json({
      decisionAccepted: true,
      approved: observedDecision.approved,
      result: {
        outcome: observedDecision.approved ? 'SUCCESS' : 'APPROVAL_REJECTED',
        filesModified: observedDecision.approved ? ['src/generated/module.ts'] : [],
        codeVerified: observedDecision.approved,
        ...(runtimeTestTransport ? {
          hermeticVerification: runtimeTestHermeticVerification,
          executionVerificationReceipt: runtimeTestExecutionReceipt,
          inspectedFiles: runtimeTestExecutionReceipt.inspectedFiles,
          exploredDirectories: runtimeTestExecutionReceipt.exploredDirectories,
          engineeringSummary: runtimeTestExecutionReceipt.engineeringSummary,
        } : {}),
      },
    });
  }
  if (url.pathname === '/api/coding/broker/sessions/release') {
    return Response.json({ released: true });
  }
  throw new Error(`Unexpected broker transport request: ${url.pathname}`);
};

const readinessResponse = await codingFetch(`${runtimeConfig.services.http.baseUrl}/api/coding/acceptance-preflight`);
assert.equal((await readinessResponse.json()).projectIdentity, 'BROKER_VERIFIED');

let surfacedApproval;
const workflow = executeTrustedBrokerWorkflow(
  creationPrompt,
  '.',
  undefined,
  (approval, actions) => {
    surfacedApproval = { approval, actions };
  },
  { projectRoot, executionMode: 'inline_review', autoAuthorizeAttachedProject: true },
);

for (let attempt = 0; attempt < 100 && !surfacedApproval; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.ok(surfacedApproval, 'The browser transport should surface the pending proposal to the UI.');
assert.equal(surfacedApproval.approval.proposalDigest, pendingApproval.proposalDigest);
assert.equal(surfacedApproval.approval.fileOperations[0].path, pendingApproval.fileOperations[0].path);
assert.equal(surfacedApproval.approval.approvalNonce, pendingApproval.approvalNonce);
await surfacedApproval.actions.approve(false);
const result = await workflow;

assert.equal(observedDecision.approved, true, 'The UI action should send an explicit approval decision.');
assert.equal(observedDecision.approvalNonce, pendingApproval.approvalNonce);
assert.equal(observedDecision.proposalId, pendingApproval.proposalId);
assert.equal(observedDecision.proposalDigest, pendingApproval.proposalDigest);
assert.equal(result.outcome, 'SUCCESS');
assert.deepEqual(result.filesModified, ['src/generated/module.ts']);
assert.equal(browser.window.electronAPI, undefined, 'The browser approval flow must not depend on Electron IPC.');

expectedWorkflowRequest = 'test the project';
expectedExecutionMode = 'autonomous_auto_apply';
runtimeTestTransport = true;
const runtimeTestWorkflow = await executeTrustedBrokerWorkflow(
  expectedWorkflowRequest,
  '.',
  undefined,
  undefined,
  { projectRoot, executionMode: expectedExecutionMode, autoAuthorizeAttachedProject: true },
);
assert.equal(runtimeTestWorkflow.outcome, 'VERIFICATION_UNAVAILABLE');
assert.equal(runtimeTestWorkflow.rolledBack, false);
assert.equal(runtimeTestWorkflow.executionVerificationReceipt?.status, 'PASSED');
assert.equal(runtimeTestWorkflow.hermeticVerification?.passed, 9);
const normalizedRuntimeTestWorkflow = normalizeProjectRuntimeTestWorkflowResult(
  expectedWorkflowRequest,
  runtimeTestWorkflow,
);
assert.equal(normalizedRuntimeTestWorkflow.outcome, 'SUCCESS');
assert.equal(normalizedRuntimeTestWorkflow.codeVerified, true);
assert.equal(normalizedRuntimeTestWorkflow.message, runtimeTestWorkflow.executionVerificationReceipt.message);
assert.equal(normalizedRuntimeTestWorkflow.executionVerificationReceipt?.probes?.[0].statusCode, 201);
assert.match(normalizedRuntimeTestWorkflow.message, /Detected Workspace Issues & Readiness Audit:/);
assert.equal(normalizedRuntimeTestWorkflow.hermeticVerification?.total, 9);
assert.equal(normalizedRuntimeTestWorkflow.rolledBack, false);
assert.doesNotMatch(
  normalizedRuntimeTestWorkflow.message,
  /Verification runner was unavailable or offline|All changes were rolled back/,
);
const autonomousChatReceipt = formatProjectRuntimeTestCompletionMessage(
  normalizedRuntimeTestWorkflow.message,
  normalizedRuntimeTestWorkflow.executionVerificationReceipt?.workspaceAudit,
  ['tests/order.test.js', '[workflow] Starting the authorized autonomous coding workflow.'],
  undefined,
  {
    inspectedFiles: normalizedRuntimeTestWorkflow.executionVerificationReceipt?.inspectedFiles,
    exploredDirectories: normalizedRuntimeTestWorkflow.executionVerificationReceipt?.exploredDirectories,
    engineeringSummary: normalizedRuntimeTestWorkflow.executionVerificationReceipt?.engineeringSummary,
  },
);
const autonomousInspectionActivities = buildProjectRuntimeInspectionActivities(
  'autonomous-hello',
  normalizedRuntimeTestWorkflow,
);
assert.equal(autonomousInspectionActivities.filter((item) => 'event' in item && item.activityType === 'READING_FILE').length, 9);
assert.ok(autonomousInspectionActivities.some((item) => !('event' in item) && item.phase === 'Runtime contract'));
assert.ok(autonomousInspectionActivities.some((item) => 'event' in item && item.activityType === 'DISCOVERING_REPOSITORY' && item.action.target === 'models'));
assert.ok(autonomousInspectionActivities.some((item) => 'event' in item && item.action.target === 'tests/order.test.js' && item.result.lineCount === 12));
assert.match(autonomousChatReceipt, /Missing node_modules for JSX source files/);
assert.match(autonomousChatReceipt, /Missing \.env file/);
assert.match(autonomousChatReceipt, /Stale server\.js UI contract/);
assert.match(autonomousChatReceipt, /Engineering Analysis & Inspected Files/);
assert.match(autonomousChatReceipt, /Read `models\/Order\.js` \(12 lines, 420 bytes\)/);
assert.doesNotMatch(autonomousChatReceipt, /\[workflow\] Starting the authorized autonomous coding workflow/);
assert.ok(
  autonomousChatReceipt.indexOf('Engineering Analysis & Inspected Files:')
    < autonomousChatReceipt.indexOf('Detected Workspace Issues & Readiness Audit:')
    && autonomousChatReceipt.indexOf('Detected Workspace Issues & Readiness Audit:')
      < autonomousChatReceipt.indexOf('Modified files:'),
  'Autonomous project-test output must order engineering evidence, the workspace audit, and modified files.',
);
const zeroChangeRepeat = normalizeProjectRuntimeTestWorkflowResult(expectedWorkflowRequest, {
  outcome: 'SUCCESS',
  noChangesRequired: true,
  filesModified: [],
  executionVerificationReceipt: {
    ...runtimeTestExecutionReceipt,
    workspaceAudit: {
      ...runtimeTestExecutionReceipt.workspaceAudit,
      inspectedFiles: runtimeTestExecutionReceipt.inspectedFiles,
      exploredDirectories: runtimeTestExecutionReceipt.exploredDirectories,
      engineeringSummary: runtimeTestExecutionReceipt.engineeringSummary,
    },
  },
});
const zeroChangeChatReceipt = formatProjectRuntimeTestCompletionMessage(
  zeroChangeRepeat.message,
  zeroChangeRepeat.executionVerificationReceipt.workspaceAudit,
  zeroChangeRepeat.filesModified,
  zeroChangeRepeat.detectedWorkspaceIssues,
  {
    inspectedFiles: zeroChangeRepeat.inspectedFiles,
    exploredDirectories: zeroChangeRepeat.exploredDirectories,
    engineeringSummary: zeroChangeRepeat.engineeringSummary,
    engineeringAnalysis: zeroChangeRepeat.engineeringAnalysis,
  },
);
const zeroChangeActivities = buildProjectRuntimeInspectionActivities('hello-repeat-run', zeroChangeRepeat);
assert.match(zeroChangeChatReceipt, /Engineering Analysis & Inspected Files:/);
for (const inspectedPath of [
  'package.json',
  'server.js',
  'models/Order.js',
  'controllers/orderController.js',
  'routes/orders.js',
  'components/OrderForm.jsx',
  'app/orders/page.jsx',
  'tests/order.test.js',
]) {
  assert.ok(
    zeroChangeChatReceipt.includes(`Read \`${inspectedPath}\` (12 lines`),
    `The zero-change receipt should show the inspected line count for ${inspectedPath}.`,
  );
}
assert.match(zeroChangeChatReceipt, /Detected Workspace Issues & Readiness Audit:/);
assert.match(zeroChangeChatReceipt, /Modified files:\n- No repository files were modified\./);
assert.ok(
  zeroChangeChatReceipt.indexOf('Engineering Analysis & Inspected Files:')
    < zeroChangeChatReceipt.indexOf('Detected Workspace Issues & Readiness Audit:')
    && zeroChangeChatReceipt.indexOf('Detected Workspace Issues & Readiness Audit:')
      < zeroChangeChatReceipt.indexOf('Modified files:'),
  'A zero-change repeat run must preserve the required receipt section order.',
);
assert.ok(zeroChangeActivities.some((item) => 'event' in item
  && item.activityType === 'DISCOVERING_REPOSITORY'
  && item.action.target === 'tests'));
assert.ok(zeroChangeActivities.some((item) => 'event' in item
  && item.activityType === 'READING_FILE'
  && item.action.target === 'tests/order.test.js'
  && item.result.lineCount === 12));
assert.match(codingController, /inspectionActivities\.length\)[\s\S]*?setActivity\(\(previous\) => inspectionActivities\.reduce/);
assert.match(codingWorkspace, /case 'READING_FILE': return 'Read file'/);
assert.match(codingWorkspace, /case 'DISCOVERING_REPOSITORY': return 'Explored directory'/);
const auditOnlyRuntimeTestWorkflow = normalizeProjectRuntimeTestWorkflowResult(expectedWorkflowRequest, {
  outcome: 'SUCCESS',
  filesModified: [],
  executionVerificationReceipt: {
    status: 'PASSED',
    message: 'Hermetic gates: 9/9 PASS',
    workspaceAudit: {
      findings: [{ message: '[DETECTED WORKSPACE GAP] Missing .env file.' }],
      bugs: [],
      syncPlan: [],
    },
  },
});
assert.match(auditOnlyRuntimeTestWorkflow.message, /Detected Workspace Issues & Readiness Audit/);
assert.match(auditOnlyRuntimeTestWorkflow.message, /Missing \.env file/);
assert.match(auditOnlyRuntimeTestWorkflow.executionVerificationReceipt.message, /Missing \.env file/);
assert.equal(runtimeTestWorkflow.outcome, 'SUCCESS');
assert.deepEqual(runtimeTestWorkflow.filesModified, ['package.json', 'tests/order.test.js']);
expectedExecutionMode = 'inline_review';
let surfacedRuntimeApproval;
const inlineRuntimeWorkflow = executeTrustedBrokerWorkflow(
  expectedWorkflowRequest,
  '.',
  undefined,
  (approval, actions) => { surfacedRuntimeApproval = { approval, actions }; },
  { projectRoot, executionMode: expectedExecutionMode, autoAuthorizeAttachedProject: true },
);
for (let attempt = 0; attempt < 100 && !surfacedRuntimeApproval; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.ok(surfacedRuntimeApproval, 'Project-test inline review must surface the staged proposal.');
assert.equal(surfacedRuntimeApproval.approval.executionVerificationReceipt?.status, 'PASSED');
assert.equal(surfacedRuntimeApproval.approval.hermeticVerification?.passed, 9);
const inlineCandidateReceipt = formatProjectRuntimeTestCompletionMessage(
  surfacedRuntimeApproval.approval.executionVerificationReceipt?.message,
  surfacedRuntimeApproval.approval.executionVerificationReceipt?.workspaceAudit
    || surfacedRuntimeApproval.approval.hermeticVerification?.workspaceAudit,
  [],
  undefined,
  {
    inspectedFiles: surfacedRuntimeApproval.approval.inspectedFiles,
    exploredDirectories: surfacedRuntimeApproval.approval.exploredDirectories,
    engineeringSummary: surfacedRuntimeApproval.approval.engineeringSummary,
  },
);
const inlineInspectionActivities = buildProjectRuntimeInspectionActivities('inline-hello', {
  outcome: 'AWAITING_APPROVAL',
  executionVerificationReceipt: surfacedRuntimeApproval.approval.executionVerificationReceipt,
  hermeticVerification: surfacedRuntimeApproval.approval.hermeticVerification,
  inspectedFiles: surfacedRuntimeApproval.approval.inspectedFiles,
  exploredDirectories: surfacedRuntimeApproval.approval.exploredDirectories,
  engineeringSummary: surfacedRuntimeApproval.approval.engineeringSummary,
});
assert.equal(inlineInspectionActivities.filter((item) => 'event' in item && item.activityType === 'READING_FILE').length, 9);
assert.ok(inlineInspectionActivities.some((item) => !('event' in item) && item.phase === 'Workspace topology'));
assert.ok(inlineInspectionActivities.some((item) => 'event' in item && item.activityType === 'READING_FILE' && item.action.target === 'models/Order.js'));
assert.match(inlineCandidateReceipt, /Detected Workspace Issues & Readiness Audit:/);
assert.match(inlineCandidateReceipt, /Missing \.env file/);
assert.match(inlineCandidateReceipt, /Engineering Analysis & Inspected Files/);
assert.match(inlineCandidateReceipt, /Read `tests\/order\.test\.js` \(12 lines, 420 bytes\)/);
assert.ok(
  inlineCandidateReceipt.indexOf('Engineering Analysis & Inspected Files:')
    < inlineCandidateReceipt.indexOf('Detected Workspace Issues & Readiness Audit:')
    && inlineCandidateReceipt.indexOf('Detected Workspace Issues & Readiness Audit:')
      < inlineCandidateReceipt.indexOf('Modified files:'),
  'Inline-review output must order engineering evidence, the workspace audit, and modified files.',
);
const stagedRuntimeTestResult = await normalizeProjectRuntimeTestWorkflowResult(expectedWorkflowRequest, {
  outcome: 'AWAITING_APPROVAL',
  filesModified: [],
  codeApplied: false,
  codeVerified: false,
  hermeticVerification: runtimeTestHermeticVerification,
  executionVerificationReceipt: runtimeTestExecutionReceipt,
});
assert.equal(stagedRuntimeTestResult.outcome, 'AWAITING_APPROVAL');
assert.equal(stagedRuntimeTestResult.codeVerified, false);
await surfacedRuntimeApproval.actions.approve(false);
const approvedRuntimeTestResult = await inlineRuntimeWorkflow;
assert.equal(approvedRuntimeTestResult.outcome, 'SUCCESS');
assert.equal(approvedRuntimeTestResult.executionVerificationReceipt?.status, 'PASSED');
assert.equal(approvedRuntimeTestResult.hermeticVerification?.passed, 9);
const rolledBackRuntimeTestWorkflow = normalizeProjectRuntimeTestWorkflowResult(
  expectedWorkflowRequest,
  {
    outcome: 'VERIFICATION_UNAVAILABLE',
    filesModified: ['package.json'],
    rolledBack: true,
    executionVerificationReceipt: {
      status: 'PASSED',
      message: 'This contradictory receipt must not override a reported rollback.',
    },
  },
);
assert.equal(rolledBackRuntimeTestWorkflow.outcome, 'RUNTIME_VERIFICATION_INCOMPLETE');
assert.equal(rolledBackRuntimeTestWorkflow.rolledBack, true);
assert.match(rolledBackRuntimeTestWorkflow.message, /rolled back/i);
const failedGateRuntimeWorkflow = normalizeProjectRuntimeTestWorkflowResult(
  expectedWorkflowRequest,
  {
    outcome: 'VERIFICATION_UNAVAILABLE',
    message: 'Verification runner was unavailable or offline.',
    rolledBack: false,
    hermeticVerification: {
      passed: 8,
      total: 9,
      gates: [
        { id: 'SYNTAX_AND_AST', passed: true },
        { id: 'CANDIDATE_RUNTIME_BEHAVIOR', passed: false, diagnostics: [{ path: 'tests/order.test.js', reason: 'Unexpected token.' }] },
      ],
    },
  },
);
assert.equal(failedGateRuntimeWorkflow.outcome, 'HERMETIC_VERIFICATION_FAILED');
assert.match(failedGateRuntimeWorkflow.message, /CANDIDATE_RUNTIME_BEHAVIOR @ tests\/order\.test\.js: Unexpected token/);
assert.doesNotMatch(failedGateRuntimeWorkflow.message, /Verification runner was unavailable or offline/);

async function verifyExpiredApprovalRecovery(freshDigest, expectedSurfaceCount) {
  let sessionCount = 0;
  let workflowCount = 0;
  let decisionCount = 0;
  let surfacedCount = 0;
  let surfacedActions;
  const freshApproval = freshDigest === pendingApproval.proposalDigest
    ? pendingApproval
    : {
      ...pendingApproval,
      proposalId: 'fresh-proposal-handle',
      proposalDigest: freshDigest,
      approvalNonce: 'fresh-approval-nonce',
      envelope: {
        ...pendingApproval.envelope,
        proposalId: 'fresh-proposal-handle',
        proposalDigest: freshDigest,
        approvalNonce: 'fresh-approval-nonce',
      },
    };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/coding/project-attach') return Response.json({ status: 'PROJECT_ATTACHED' });
    if (url.pathname === '/api/coding/broker') return Response.json({ projects: [{ projectId }] });
    if (url.pathname === '/api/coding/broker/sessions') {
      sessionCount += 1;
      return Response.json({ brokerSessionId: `recovery-session-${sessionCount}`, sessionLeaseToken: `lease-${sessionCount}` });
    }
    if (url.pathname === '/api/coding/broker/sessions/heartbeat') {
      return Response.json({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname === '/api/coding/broker/workflows') {
      workflowCount += 1;
      return Response.json({
        outcome: 'AWAITING_APPROVAL',
        phase: 'APPROVE',
        filesModified: [],
        approval: workflowCount === 1 ? pendingApproval : freshApproval,
      });
    }
    if (url.pathname === '/api/coding/broker/workflows/approval/decision') {
      decisionCount += 1;
      const decision = JSON.parse(init.body);
      if (decisionCount === 1) {
        return Response.json({
          detail: {
            code: 'BROKER_SESSION_UNAUTHORIZED',
            message: 'The broker session lease is invalid or expired.',
          },
        }, { status: 403 });
      }
      return Response.json({
        decisionAccepted: true,
        approved: decision.approved,
        result: {
          outcome: decision.approved ? 'SUCCESS' : 'APPROVAL_REJECTED',
          filesModified: decision.approved ? ['src/generated/module.ts'] : [],
          codeVerified: decision.approved,
        },
      });
    }
    if (url.pathname === '/api/coding/broker/sessions/release') return Response.json({ released: true });
    throw new Error(`Unexpected expired-lease recovery request: ${url.pathname}`);
  };

  const recoveryWorkflow = executeTrustedBrokerWorkflow(
    creationPrompt,
    '.',
    undefined,
    (_approval, actions) => {
      surfacedCount += 1;
      surfacedActions = actions;
    },
    { projectRoot, executionMode: 'inline_review', autoAuthorizeAttachedProject: true },
  );
  for (let attempt = 0; attempt < 100 && surfacedCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(surfacedCount, 1, 'The original proposal must be surfaced before a user decision.');
  const initialDecision = surfacedActions.approve(false);
  if (expectedSurfaceCount > 1) {
    for (let attempt = 0; attempt < 100 && surfacedCount < expectedSurfaceCount; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(surfacedCount, expectedSurfaceCount, 'A changed proposal must be shown again for explicit review.');
    await surfacedActions.approve(false);
  }
  await initialDecision;
  const recovered = await recoveryWorkflow;
  assert.equal(recovered.outcome, 'SUCCESS');
  assert.equal(workflowCount, 2, 'An expired approval lease should recreate the workflow exactly once.');
  assert.equal(decisionCount, 2);
  assert.equal(surfacedCount, expectedSurfaceCount);
}

await verifyExpiredApprovalRecovery(pendingApproval.proposalDigest, 1);
await verifyExpiredApprovalRecovery('c'.repeat(64), 2);

let safeGetAttempts = 0;
globalThis.fetch = async () => {
  safeGetAttempts += 1;
  if (safeGetAttempts === 1) throw new TypeError('Failed to fetch');
  return Response.json({ ready: true });
};
const recoveredStatus = await codingFetch('/api/coding/status');
assert.equal(recoveredStatus.status, 200, 'A transient startup fetch failure should be retried for safe status requests.');
assert.equal(safeGetAttempts, 2);

globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(
  codingFetch('/api/coding/status'),
  /backend is not reachable or the browser blocked the request/i,
  'Network failures should be surfaced with actionable context rather than raw Failed to fetch.',
);

browser.window.close();
console.log('Browser broker approval transport test passed (mocked backend responses; broker materialization is covered separately).');
