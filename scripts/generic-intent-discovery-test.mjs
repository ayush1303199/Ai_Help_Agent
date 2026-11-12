import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const developerAgent = require('../electron/developerAgent.cjs');
const developerFiles = require('../electron/developerFiles.cjs');
const {
  INTENT_CATEGORIES,
  PROCESSING_LEVELS,
  classifyTaskIntent,
  extractConstraints,
  checkAmbiguity,
} = require('../electron/coding-pipeline/genericIntentClassifier.cjs');
const {
  WORKSPACE_STATES,
  discoverWorkspace,
  verifyProjectAuthorization,
} = require('../electron/coding-pipeline/projectDiscovery.cjs');

console.log('Starting Generic Intent Classification & Project Discovery regression tests...');

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-v1-test-'));

try {
  // =========================================================================
  // 1. Each Intent Category Test
  // =========================================================================
  console.log('Testing each intent category...');

  const categoryTests = [
    {
      request: 'Create a new user authentication service with JWT token verification and password hashing',
      expected: INTENT_CATEGORIES.BUILD_OR_SCAFFOLD,
      actionable: true,
      mutationRequired: true,
    },
    {
      request: 'Investigate why the database connection pool exhausts and causes 500 internal server errors',
      expected: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG,
      actionable: true,
    },
    {
      request: 'Start the dev server locally on port 3000 to preview the interface',
      expected: INTENT_CATEGORIES.RUN_OR_LAUNCH,
      actionable: true,
      mutationRequired: false,
    },
    {
      request: 'Run the unit test suite and verify that all assertion checks pass',
      expected: INTENT_CATEGORIES.TEST_OR_VERIFY,
      actionable: true,
      mutationRequired: false,
    },
    {
      request: 'Refactor the payment processor to decouple billing logic and extract common helpers',
      expected: INTENT_CATEGORIES.REFACTOR,
      actionable: true,
      mutationRequired: true,
    },
    {
      request: 'Upgrade dependencies to the latest release and migrate the API routes to v2',
      expected: INTENT_CATEGORIES.UPGRADE_OR_MIGRATE,
      actionable: true,
      mutationRequired: true,
    },
    {
      request: 'How does the message queue routing and dispatch mechanism work in this codebase?',
      expected: INTENT_CATEGORIES.EXPLAIN_OR_ASK,
      actionable: false,
      mutationRequired: false,
    },
  ];

  for (const { request, expected, actionable, mutationRequired } of categoryTests) {
    const res = classifyTaskIntent({ request });
    assert.equal(res.primaryIntent, expected, `Expected primary intent ${expected} for: "${request}", got ${res.primaryIntent}`);
    assert.equal(res.actionable, actionable, `Expected actionable=${actionable} for: "${request}"`);
    if (mutationRequired !== undefined) {
      assert.equal(res.mutationRequired, mutationRequired, `Expected mutationRequired=${mutationRequired} for: "${request}"`);
    }
    assert.equal(res.originalRequest, request);
    assert.equal(res.needsClarification, false);
  }

  // =========================================================================
  // 2. Natural-language phrasing and multi-intent requests
  // =========================================================================
  console.log('Testing natural-language phrasing and multi-intent requests...');

  // Multi-intent: Investigate + Fix
  const multi1 = classifyTaskIntent({
    request: 'Please investigate the crash during user checkout and fix the null pointer exception',
  });
  assert.equal(multi1.primaryIntent, INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG);
  assert.equal(multi1.actionable, true);
  assert.equal(multi1.mutationRequired, true);

  // Multi-intent: Scaffold + Test
  const multi2 = classifyTaskIntent({
    request: 'Scaffold a new notification service and run unit tests to verify it',
  });
  assert.equal(multi2.primaryIntent, INTENT_CATEGORIES.BUILD_OR_SCAFFOLD);
  assert.ok(multi2.secondaryIntents.includes(INTENT_CATEGORIES.TEST_OR_VERIFY));

  // Multi-intent: Upgrade + Test
  const multi3 = classifyTaskIntent({
    request: 'Upgrade dependencies to latest version and run the test suite',
  });
  assert.equal(multi3.primaryIntent, INTENT_CATEGORIES.UPGRADE_OR_MIGRATE);
  assert.ok(multi3.secondaryIntents.includes(INTENT_CATEGORIES.TEST_OR_VERIFY));

  // Natural language conversational explanation
  const naturalExplain = classifyTaskIntent({
    request: 'Can you please explain how the routing architecture is structured here?',
  });
  assert.equal(naturalExplain.primaryIntent, INTENT_CATEGORIES.EXPLAIN_OR_ASK);
  assert.equal(naturalExplain.actionable, false);

  // =========================================================================
  // 3. Constraints extraction and preservation
  // =========================================================================
  console.log('Testing constraint extraction and preservation...');

  const constrainedRequest = 'Refactor the user model without modifying the database schema, do not touch auth.js, and maintain backwards compatibility';
  const constraints = extractConstraints(constrainedRequest);
  assert.ok(constraints.some((c) => c.includes('DO_NOT_MODIFY: the database schema')));
  assert.ok(constraints.some((c) => c.includes('DO_NOT_MODIFY: auth.js')));
  assert.ok(constraints.some((c) => c.includes('PRESERVE: backwards compatibility')));

  const classifiedConstrained = classifyTaskIntent({ request: constrainedRequest });
  assert.equal(classifiedConstrained.primaryIntent, INTENT_CATEGORIES.REFACTOR);
  assert.deepEqual(classifiedConstrained.constraints, constraints);
  assert.equal(classifiedConstrained.originalRequest, constrainedRequest);

  // Read-only constraint overrides mutation
  const readOnlyConstrained = classifyTaskIntent({
    request: 'Refactor the logic in read-only mode, do not modify any code',
  });
  assert.equal(readOnlyConstrained.mutationRequired, false);

  // =========================================================================
  // 4. Ambiguity and Clarification detection
  // =========================================================================
  console.log('Testing ambiguity and clarification...');

  const emptyRes = classifyTaskIntent({ request: '' });
  assert.equal(emptyRes.needsClarification, true);
  assert.ok(emptyRes.clarificationPrompt.length > 0);

  const vagueRequests = [
    'make it better',
    'fix the bug',
    'improve this',
    'do something',
  ];

  for (const vague of vagueRequests) {
    const res = classifyTaskIntent({ request: vague });
    assert.equal(res.needsClarification, true, `Expected needsClarification for: "${vague}"`);
    assert.match(res.clarificationPrompt, /ambiguous/i);
  }

  // =========================================================================
  // 5. Empty, Partially Initialized, and Existing Workspaces
  // =========================================================================
  console.log('Testing workspace discovery (empty, partial, existing)...');

  // A. Empty workspace
  const emptyDir = path.join(testRoot, 'empty-ws');
  await fs.mkdir(emptyDir, { recursive: true });
  const emptyDiscovery = await discoverWorkspace({ projectRoot: emptyDir });
  assert.equal(emptyDiscovery.workspaceState, WORKSPACE_STATES.EMPTY);
  assert.equal(emptyDiscovery.manifests.length, 0);
  assert.equal(emptyDiscovery.fileCount, 0);

  // Contextual classification in empty workspace
  const initInEmpty = classifyTaskIntent({
    request: 'Setup a new project from scratch',
    projectContext: emptyDiscovery,
  });
  assert.equal(initInEmpty.primaryIntent, INTENT_CATEGORIES.BUILD_OR_SCAFFOLD);

  // B. Partially initialized workspace (e.g. only README and .gitignore)
  const partialDir = path.join(testRoot, 'partial-ws');
  await fs.mkdir(partialDir, { recursive: true });
  await fs.writeFile(path.join(partialDir, 'README.md'), '# Upcoming Project\nWork in progress.', 'utf8');
  await fs.writeFile(path.join(partialDir, '.gitignore'), 'node_modules/\n.env\n', 'utf8');
  const partialDiscovery = await discoverWorkspace({ projectRoot: partialDir });
  assert.equal(partialDiscovery.workspaceState, WORKSPACE_STATES.PARTIALLY_INITIALIZED);
  assert.equal(partialDiscovery.manifests.length, 0);
  assert.equal(partialDiscovery.fileCount, 2);

  // C. Existing application workspace (Node.js)
  const nodeAppDir = path.join(testRoot, 'node-app-ws');
  await fs.mkdir(path.join(nodeAppDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(nodeAppDir, 'package.json'),
    JSON.stringify({
      name: 'sample-node-app',
      version: '1.0.0',
      type: 'module',
      scripts: {
        build: 'tsc',
        test: 'jest --ci',
        start: 'node src/index.js',
      },
      dependencies: {
        express: '^4.18.2',
      },
    }, null, 2),
    'utf8'
  );
  await fs.writeFile(path.join(nodeAppDir, 'src', 'index.js'), 'console.log("hello");', 'utf8');
  const nodeDiscovery = await discoverWorkspace({ projectRoot: nodeAppDir });
  assert.equal(nodeDiscovery.workspaceState, WORKSPACE_STATES.EXISTING_APPLICATION);
  assert.equal(nodeDiscovery.manifests.length, 1);
  assert.equal(nodeDiscovery.manifests[0].name, 'package.json');
  assert.equal(nodeDiscovery.manifests[0].language, 'javascript');
  assert.ok(nodeDiscovery.languages.includes('javascript'));
  assert.equal(nodeDiscovery.scripts.test, 'jest --ci');
  assert.equal(nodeDiscovery.scripts.build, 'tsc');
  assert.equal(nodeDiscovery.scripts.start, 'node src/index.js');
  assert.ok(nodeDiscovery.entrypoints.includes('src/index.js'));
  assert.ok(nodeDiscovery.evidence.length > 0);

  // D. Existing application workspace (PHP)
  const phpAppDir = path.join(testRoot, 'php-app-ws');
  await fs.mkdir(path.join(phpAppDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(phpAppDir, 'composer.json'),
    JSON.stringify({
      name: 'vendor/php-app',
      require: { php: '^8.1' },
      scripts: { test: 'phpunit' },
    }),
    'utf8'
  );
  await fs.writeFile(path.join(phpAppDir, 'index.php'), '<?php echo "hello";', 'utf8');
  const phpDiscovery = await discoverWorkspace({ projectRoot: phpAppDir });
  assert.equal(phpDiscovery.workspaceState, WORKSPACE_STATES.EXISTING_APPLICATION);
  assert.ok(phpDiscovery.languages.includes('php'));
  assert.equal(phpDiscovery.scripts.test, 'phpunit');
  assert.ok(phpDiscovery.entrypoints.includes('index.php'));

  // E. Existing application workspace (Go)
  const goAppDir = path.join(testRoot, 'go-app-ws');
  await fs.mkdir(goAppDir, { recursive: true });
  await fs.writeFile(path.join(goAppDir, 'go.mod'), 'module example.com/mygo\n\ngo 1.21\n', 'utf8');
  await fs.writeFile(path.join(goAppDir, 'main.go'), 'package main\nfunc main() {}\n', 'utf8');
  const goDiscovery = await discoverWorkspace({ projectRoot: goAppDir });
  assert.equal(goDiscovery.workspaceState, WORKSPACE_STATES.EXISTING_APPLICATION);
  assert.ok(goDiscovery.languages.includes('go'));
  assert.ok(goDiscovery.entrypoints.includes('main.go'));

  // =========================================================================
  // 6. Security Boundaries & Session Authorization
  // =========================================================================
  console.log('Testing security boundaries and authorization checks...');

  const ownerA = 99101;
  const ownerB = 99102;
  const originalRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  // Attach nodeAppDir to ownerA
  await developerFiles.attachProject(nodeAppDir, ownerA);

  // Authorization passes for ownerA with nodeAppDir
  const authPass = await verifyProjectAuthorization(nodeAppDir, ownerA);
  assert.equal(authPass.isAuthorized, true);

  // Authorization FAILS for ownerA with phpAppDir (mismatched project path)
  const authPathFail = await verifyProjectAuthorization(phpAppDir, ownerA);
  assert.equal(authPathFail.isAuthorized, false);

  // Authorization FAILS for ownerB (no project attached)
  const authOwnerFail = await verifyProjectAuthorization(nodeAppDir, ownerB);
  assert.equal(authOwnerFail.isAuthorized, false);

  // discoverWorkspace with unauthorized owner returns UNAUTHORIZED status
  const unauthDiscovery = await discoverWorkspace({ projectRoot: phpAppDir, ownerWebContentsId: ownerA });
  assert.equal(unauthDiscovery.status, 'UNAUTHORIZED');
  assert.equal(unauthDiscovery.isAuthorized, false);

  // =========================================================================
  // 7. Workflow Integration: executeAutonomousCodingWorkflow routing
  // =========================================================================
  console.log('Testing workflow integration and routing...');

  const sessionId = crypto.randomUUID();
  developerAgent.createSessionForBroker(ownerA, sessionId);

  // A. Clarification routing
  const clarifyResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'make it faster and better',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
  });
  assert.equal(clarifyResult.outcome, 'CLARIFICATION_REQUIRED');
  assert.equal(clarifyResult.phase, 'UNDERSTAND');
  assert.equal(clarifyResult.filesModified.length, 0);
  assert.equal(clarifyResult.taskPlan.originalRequest, 'make it faster and better');
  assert.ok(clarifyResult.taskPlan.intentClassification);

  // B. EXPLAIN_OR_ASK routing (read-only, no code mutation or proposal)
  const explainResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'How is the application entrypoint configured in this repository?',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
  });
  assert.equal(explainResult.outcome, 'COMPLETED');
  assert.equal(explainResult.phase, 'EXPLAIN');
  assert.equal(explainResult.filesModified.length, 0);
  assert.equal(explainResult.codeApplied, false);
  assert.equal(explainResult.codeVerified, false);
  assert.equal(explainResult.taskPlan.intentClassification.primaryIntent, INTENT_CATEGORIES.EXPLAIN_OR_ASK);
  assert.ok(explainResult.taskPlan.workspaceDiscovery);

  // C. RUN_OR_LAUNCH routing (gated/blocked by process isolation policy)
  const runResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Start the dev server on port 3000',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
  });
  assert.equal(runResult.outcome, 'BLOCKED');
  assert.equal(runResult.phase, 'RUN_OR_LAUNCH');
  assert.equal(runResult.executionBlocked, true);
  assert.match(runResult.reason, /process isolation/i);
  assert.equal(runResult.filesModified.length, 0);

  // D. Ambiguous add dependency request (asks clarification, does not silently convert to npm install)
  const ambigDepResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'add a package',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
  });
  assert.equal(ambigDepResult.outcome, 'CLARIFICATION_REQUIRED');
  assert.equal(ambigDepResult.phase, 'UNDERSTAND');
  assert.match(ambigDepResult.clarificationPrompt, /Which package or dependency would you like to install/i);

  // E. Language conflict in existing project without explicit path
  const conflictResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'write a python script to process the data',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
  });
  assert.equal(conflictResult.outcome, 'CLARIFICATION_REQUIRED');
  assert.equal(conflictResult.phase, 'UNDERSTAND');
  assert.match(conflictResult.clarificationPrompt, /conflicts with the detected/i);

  // F. Language conflict resolved when explicit path is provided
  const resolvedPathResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'write a python script in scripts/processor.py',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
  });
  assert.notEqual(resolvedPathResult.outcome, 'CLARIFICATION_REQUIRED');

  // =========================================================================
  // 7. Milestone V44.37: Adaptive Workflow Intelligence & Processing Levels
  // =========================================================================
  console.log('Testing Milestone V44.37: Adaptive Workflow Intelligence & Processing Levels...');

  // Level A: Pure conversational interaction
  const levelA1 = classifyTaskIntent({ request: 'Hello! How are you doing today?' });
  assert.equal(levelA1.processingLevel, PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION);
  assert.equal(levelA1.actionable, false);

  const levelA2 = classifyTaskIntent({ request: 'Thanks for your help!' });
  assert.equal(levelA2.processingLevel, PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION);
  assert.equal(levelA2.actionable, false);

  const levelA3 = classifyTaskIntent({ request: 'Sounds good, let us proceed.' });
  assert.equal(levelA3.processingLevel, PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION);
  assert.equal(levelA3.actionable, false);

  // Level B: Lightweight Understanding & Inquiries
  const levelB1 = classifyTaskIntent({ request: 'Can you explain how developerAgent implements rollback?' });
  assert.equal(levelB1.processingLevel, PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING);
  assert.equal(levelB1.actionable, false);

  const levelB2 = classifyTaskIntent({ request: 'How does the message queue routing work in this codebase?' });
  assert.equal(levelB2.processingLevel, PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING);
  assert.equal(levelB2.actionable, false);

  // Level C: Focused Read-only Investigation
  const levelC1 = classifyTaskIntent({ request: 'Please investigate the crash without modifying any files' });
  assert.equal(levelC1.processingLevel, PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION);
  assert.equal(levelC1.actionable, true);
  assert.equal(levelC1.mutationRequired, false);

  // Level D: Full Development Workflow
  const levelD1 = classifyTaskIntent({ request: 'Please fix the bug in server.js' });
  assert.equal(levelD1.processingLevel, PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT);
  assert.equal(levelD1.actionable, true);
  assert.equal(levelD1.mutationRequired, true);

  // Conversational preamble + action command must NOT be treated as greeting
  const preambleFix = classifyTaskIntent({ request: 'Hello! Good morning. Please fix the bug in server.js' });
  assert.equal(preambleFix.processingLevel, PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT);
  assert.equal(preambleFix.primaryIntent, INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG);
  assert.equal(preambleFix.actionable, true);
  assert.equal(preambleFix.mutationRequired, true);

  // Level A Workflow Execution: Unnecessary Investigation Eliminated
  const directResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Hello! How are you doing today?',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
  });
  assert.equal(directResult.outcome, 'COMPLETED');
  assert.equal(directResult.phase, 'DIRECT_INTERACTION');
  assert.equal(directResult.processingLevel, PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION);
  assert.equal(directResult.filesModified.length, 0);
  assert.equal(directResult.inspectedFiles.length, 0);
  assert.deepEqual(directResult.workflowReceipt.stagesCompleted, ['UNDERSTAND', 'DIRECT_INTERACTION']);

  // =========================================================================
  // 8. Milestone V44.41: Adversarial Context Integrity & Stale Isolation
  // =========================================================================
  console.log('Testing Milestone V44.41: Adversarial Context Integrity & Stale Isolation...');

  // A. Cancelled task context isolation
  const cancelledRes = checkAmbiguity('Fix it now.', { taskStatus: 'CANCELLED' }, [
    { role: 'assistant', content: 'Found a defect in auth.js: unhandled rejection.' }
  ]);
  assert.equal(cancelledRes.needsClarification, true);
  assert.equal(cancelledRes.cancelledContext, true);
  assert.match(cancelledRes.clarificationPrompt, /cancelled/i);

  // B. Failed task context isolation
  const failedRes = checkAmbiguity('Fix it now.', { taskStatus: 'FAILED' }, [
    { role: 'assistant', content: 'Found a defect in auth.js: unhandled rejection.' }
  ]);
  assert.equal(failedRes.needsClarification, true);
  assert.equal(failedRes.failedContext, true);
  assert.match(failedRes.clarificationPrompt, /failed/i);

  // C. Stale completed task isolation
  const staleRes = checkAmbiguity('Fix it now.', { taskStatus: 'COMPLETED' }, [
    { role: 'assistant', content: 'Found a defect in auth.js: unhandled rejection.' }
  ]);
  assert.equal(staleRes.needsClarification, true);
  assert.equal(staleRes.staleContext, true);
  assert.match(staleRes.clarificationPrompt, /already completed/i);

  // D. Social chat / non-defect context rejection
  const socialRes = checkAmbiguity('Fix it.', null, [
    { role: 'user', content: 'Hello there, how are you?' },
    { role: 'assistant', content: 'Doing great, thanks for asking!' }
  ]);
  assert.equal(socialRes.needsClarification, true);
  assert.match(socialRes.clarificationPrompt, /ambiguous/i);

  // E. Multiple findings ambiguity in projectContext
  const multiFindingsRes = checkAmbiguity('Fix it.', { priorFindings: ['Issue 1 in server.js', 'Issue 2 in db.js'] });
  assert.equal(multiFindingsRes.needsClarification, true);
  assert.equal(multiFindingsRes.multipleCandidates, true);
  assert.match(multiFindingsRes.clarificationPrompt, /Multiple issues were identified/i);

  // F. Multiple findings in latest assistant message
  const multiMsgRes = checkAmbiguity('Fix it.', null, [
    { role: 'assistant', content: 'Found multiple issues:\n1. Null pointer in server.js\n2. Timeout in db.js' }
  ]);
  assert.equal(multiMsgRes.needsClarification, true);
  assert.equal(multiMsgRes.multipleCandidates, true);
  assert.match(multiMsgRes.clarificationPrompt, /Multiple issues were identified/i);

  // G. Legitimate defect in context resolves cleanly
  const legitRes = checkAmbiguity('Fix it.', null, [
    { role: 'assistant', content: 'Identified a defect: unhandled rejection in auth.js:42.' }
  ]);
  assert.equal(legitRes.needsClarification, false);
  assert.equal(legitRes.resolvedFromContext, true);

  // =========================================================================
  // 9. Milestone V44.54: Workflow Quality, Context Follow-ups & Read-Only Investigation
  // =========================================================================
  console.log('Testing Milestone V44.54: Workflow Quality, Context Follow-ups & Read-Only Investigation...');

  // A. Read-only investigation without repair directive (Level C, mutationRequired: false)
  const roInv = classifyTaskIntent({ request: 'Investigate why user authentication tokens expire unexpectedly' });
  assert.equal(roInv.primaryIntent, INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG);
  assert.equal(roInv.processingLevel, PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION);
  assert.equal(roInv.mutationRequired, false);
  assert.equal(roInv.actionable, true);

  const roAudit = classifyTaskIntent({ request: 'Perform a read-only audit of FormController for defects' });
  assert.equal(roAudit.primaryIntent, INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG);
  assert.equal(roAudit.processingLevel, PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION);
  assert.equal(roAudit.mutationRequired, false);
  assert.equal(roAudit.actionable, true);

  // B. Natural conversation of any length without technical concepts (Level A, non-actionable)
  const casual = classifyTaskIntent({ request: 'Good morning! Just checking in to see how you are doing today.' });
  assert.equal(casual.primaryIntent, INTENT_CATEGORIES.CONVERSATION_OR_FEEDBACK);
  assert.equal(casual.processingLevel, PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION);
  assert.equal(casual.mutationRequired, false);
  assert.equal(casual.actionable, false);

  const longCasual = classifyTaskIntent({
    request: 'Good morning! Just wanted to say thank you for all the assistance you have been providing with our discussions and planning sessions. Hope you have a wonderful and productive day today!'
  });
  assert.equal(longCasual.primaryIntent, INTENT_CATEGORIES.CONVERSATION_OR_FEEDBACK);
  assert.equal(longCasual.processingLevel, PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION);
  assert.equal(longCasual.mutationRequired, false);
  assert.equal(longCasual.actionable, false);

  // C. Explicit repair requests are correctly classified as LEVEL_D_FULL_DEVELOPMENT with mutationRequired: true
  const explicitFix = classifyTaskIntent({ request: 'Fix the null pointer bug in auth.js when token is expired' });
  assert.equal(explicitFix.primaryIntent, INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG);
  assert.equal(explicitFix.processingLevel, PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT);
  assert.equal(explicitFix.mutationRequired, true);
  assert.equal(explicitFix.actionable, true);

  // D. Contextual follow-up phrases resolve ONLY when prior evidence supports them
  const followUpWithoutEvidence = checkAmbiguity('Please apply the proposed fix.', null, []);
  assert.equal(followUpWithoutEvidence.needsClarification, true);
  assert.equal(Boolean(followUpWithoutEvidence.resolvedFromContext), false);

  const followUpWithEvidence = checkAmbiguity('Please apply the proposed fix.', null, [
    { role: 'assistant', content: 'Identified a defect: unhandled rejection in auth.js:42.' }
  ]);
  assert.equal(followUpWithEvidence.needsClarification, false);
  assert.equal(followUpWithEvidence.resolvedFromContext, true);

  // E. Cross-Layer Parity with Renderer (classifyCodingRequestIntent)
  const { classifyCodingRequestIntent } = await import('../src/features/coding/codingTransport.ts');

  // Parity 1: Long casual conversation
  const rendererCasual = classifyCodingRequestIntent(
    'Good morning! Just wanted to say thank you for all the assistance you have been providing with our discussions and planning sessions. Hope you have a wonderful and productive day today!'
  );
  assert.equal(rendererCasual.intent, 'CONVERSATIONAL');
  assert.equal(rendererCasual.processingLevel, 'LEVEL_A_DIRECT_INTERACTION');
  assert.equal(rendererCasual.isActionableTask, false);

  // Parity 2: Read-only investigation
  const rendererRoInv = classifyCodingRequestIntent('Investigate why user authentication tokens expire unexpectedly');
  assert.equal(rendererRoInv.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(rendererRoInv.processingLevel, 'LEVEL_C_FOCUSED_INVESTIGATION');
  assert.equal(rendererRoInv.isActionableTask, true);

  // Parity 3: Read-only audit
  const rendererRoAudit = classifyCodingRequestIntent('Perform a read-only audit of FormController for defects');
  assert.equal(rendererRoAudit.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(rendererRoAudit.processingLevel, 'LEVEL_C_FOCUSED_INVESTIGATION');
  assert.equal(rendererRoAudit.isActionableTask, true);

  // Parity 4: Explicit repair
  const rendererRepair = classifyCodingRequestIntent('Fix the null pointer bug in auth.js when token is expired');
  assert.equal(rendererRepair.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(rendererRepair.processingLevel, 'LEVEL_D_FULL_DEVELOPMENT');
  assert.equal(rendererRepair.isActionableTask, true);

  // Parity 5: Ambiguous follow-up without prior context requires clarification
  const rendererAmbiguous = classifyCodingRequestIntent('Please apply the proposed fix.', []);
  assert.equal(rendererAmbiguous.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(rendererAmbiguous.processingLevel, 'LEVEL_B_LIGHTWEIGHT_UNDERSTANDING');
  assert.equal(rendererAmbiguous.isActionableTask, false);

  // Parity 6: Contextual follow-up with prior context resolves
  const rendererResolved = classifyCodingRequestIntent('Please apply the proposed fix.', [
    { role: 'assistant', content: 'Identified a defect: unhandled rejection in auth.js:42.' },
  ]);
  assert.equal(rendererResolved.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(rendererResolved.processingLevel, 'LEVEL_D_FULL_DEVELOPMENT');
  assert.equal(rendererResolved.isActionableTask, true);

  // Parity 7: Disjunctive inquiry combining action and informational question
  const rendererDisjunctive = classifyCodingRequestIntent('Fix the authentication bug or explain why it failed', []);
  assert.equal(rendererDisjunctive.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(rendererDisjunctive.processingLevel, 'LEVEL_B_LIGHTWEIGHT_UNDERSTANDING');
  assert.equal(rendererDisjunctive.isActionableTask, false);

  // Parity 8: Inquiry question on architecture/behavior
  const rendererInquiry = classifyCodingRequestIntent('How does developerAgent implement rollback?', []);
  assert.equal(rendererInquiry.intent, 'QUESTION_OR_EXPLANATION');
  assert.equal(rendererInquiry.processingLevel, 'LEVEL_B_LIGHTWEIGHT_UNDERSTANDING');
  assert.equal(rendererInquiry.isActionableTask, false);

  // Parity 9: Polite refactor action directive
  const rendererPoliteRefactor = classifyCodingRequestIntent('Could you please refactor the database session resolver?', []);
  assert.equal(rendererPoliteRefactor.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(rendererPoliteRefactor.processingLevel, 'LEVEL_D_FULL_DEVELOPMENT');
  assert.equal(rendererPoliteRefactor.isActionableTask, true);

  // Parity 10: Explicit no-change investigation directive
  const rendererNoChangeInv = classifyCodingRequestIntent('Investigate the network timeout issue without modifying any files', []);
  assert.equal(rendererNoChangeInv.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(rendererNoChangeInv.processingLevel, 'LEVEL_C_FOCUSED_INVESTIGATION');
  assert.equal(rendererNoChangeInv.isActionableTask, true);

  // Parity 11: Vague directive on completed task requires clarification
  const rendererCompleted = classifyCodingRequestIntent('Fix it.', [], { taskStatus: 'COMPLETED' });
  assert.equal(rendererCompleted.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(rendererCompleted.processingLevel, 'LEVEL_B_LIGHTWEIGHT_UNDERSTANDING');
  assert.equal(rendererCompleted.isActionableTask, false);

  // Parity 12: Vague directive on cancelled task requires clarification
  const rendererCancelled = classifyCodingRequestIntent('Fix it.', [], { taskStatus: 'CANCELLED' });
  assert.equal(rendererCancelled.intent, 'CLARIFICATION_REQUIRED');
  assert.equal(rendererCancelled.processingLevel, 'LEVEL_B_LIGHTWEIGHT_UNDERSTANDING');
  assert.equal(rendererCancelled.isActionableTask, false);

  // =========================================================================
  // 10. Generic Response-Only Code Generation vs Project Mutation Routing
  // =========================================================================
  console.log('Testing generic response-only code generation vs project mutation routing...');

  const standalonePrompts = [
    'Write a function to check if a string is a palindrome',
    'Implement binary search in Rust',
    'Can you write a sorting helper in Haskell?',
    'Generate a SQL query to find duplicate records',
    'Show me an example of LRU cache logic',
  ];

  for (const standalonePrompt of standalonePrompts) {
    const backendCls = classifyTaskIntent({ request: standalonePrompt });
    assert.equal(backendCls.primaryIntent, INTENT_CATEGORIES.EXPLAIN_OR_ASK, `Standalone prompt must route to EXPLAIN_OR_ASK: ${standalonePrompt}`);
    assert.equal(backendCls.processingLevel, PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING);
    assert.equal(backendCls.actionable, false);
    assert.equal(backendCls.mutationRequired, false);
    assert.equal(backendCls.responseOnly, true);

    const uiCls = classifyCodingRequestIntent(standalonePrompt, []);
    assert.equal(uiCls.intent, 'QUESTION_OR_EXPLANATION', `UI parity must route to QUESTION_OR_EXPLANATION: ${standalonePrompt}`);
    assert.equal(uiCls.processingLevel, 'LEVEL_B_LIGHTWEIGHT_UNDERSTANDING');
    assert.equal(uiCls.isActionableTask, false);
    assert.equal(uiCls.responseOnly, true);
  }

  // Standalone code request on attached Node app must NOT falsely claim language conflict or force diff mutation
  let generatedResponseCalled = false;
  const standaloneWorkflowResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Implement binary search in Rust',
    root: nodeAppDir,
    sessionId,
    ownerWebContentsId: ownerA,
    tools: {
      generateResponse: async ({ userRequest: reqText }) => {
        generatedResponseCalled = true;
        return `Generated standalone response for: ${reqText}`;
      },
    },
  });
  assert.equal(generatedResponseCalled, true);
  assert.equal(standaloneWorkflowResult.outcome, 'COMPLETED');
  assert.equal(standaloneWorkflowResult.phase, 'EXPLAIN');
  assert.equal(standaloneWorkflowResult.responseOnly, true);
  assert.equal(standaloneWorkflowResult.mutationRequired, false);
  assert.equal(standaloneWorkflowResult.filesModified.length, 0);
  assert.match(standaloneWorkflowResult.explanation, /Generated standalone response for: Implement binary search in Rust/);

  // Explicit repository/architectural targets MUST remain actionable mutation tasks
  const repoTargets = [
    'Add rate limiting middleware to src/routes/api.js',
    'Create a schema migration for the billing service',
    'Refactor the authentication controller to reject expired tokens',
  ];
  for (const targetPrompt of repoTargets) {
    const targetCls = classifyTaskIntent({ request: targetPrompt });
    assert.equal(targetCls.actionable, true, `Repo target prompt must remain actionable: ${targetPrompt}`);
    assert.equal(targetCls.mutationRequired, true, `Repo target prompt must require mutation: ${targetPrompt}`);
    assert.equal(targetCls.responseOnly, false);

    const targetUiCls = classifyCodingRequestIntent(targetPrompt, []);
    assert.equal(targetUiCls.intent, 'AUTONOMOUS_WORKFLOW_TASK', `Repo target UI prompt must use autonomous workflow: ${targetPrompt}`);
    assert.equal(targetUiCls.isActionableTask, true);
  }

  // Adversarial cross-layer parity: read-only review constraint & mixed-action requests
  const reviewPrompt = 'Code review this module and suggest improvements without modifying files';
  const reviewNode = classifyTaskIntent({ request: reviewPrompt });
  const reviewUi = classifyCodingRequestIntent(reviewPrompt, []);
  assert.equal(reviewNode.processingLevel, PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION);
  assert.equal(reviewNode.mutationRequired, false);
  assert.equal(reviewUi.processingLevel, 'LEVEL_C_FOCUSED_INVESTIGATION');

  const mixedActionPrompt = 'Write a quick sort function in Python, and also fix the bug in server.js';
  const mixedNode = classifyTaskIntent({ request: mixedActionPrompt });
  const mixedUi = classifyCodingRequestIntent(mixedActionPrompt, []);
  assert.equal(mixedNode.processingLevel, PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT);
  assert.equal(mixedNode.mutationRequired, true);
  assert.equal(mixedNode.responseOnly, false);
  assert.equal(mixedUi.intent, 'AUTONOMOUS_WORKFLOW_TASK');
  assert.equal(mixedUi.processingLevel, 'LEVEL_D_FULL_DEVELOPMENT');

  // Clean up sessions
  developerAgent.releaseSession(ownerA);
  developerFiles.releaseProject(ownerA);
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = originalRoots;

  console.log('All Generic Intent Classification & Project Discovery regression tests passed successfully!');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
