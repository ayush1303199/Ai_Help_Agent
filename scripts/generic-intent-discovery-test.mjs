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

  // Clean up sessions
  developerAgent.releaseSession(ownerA);
  developerFiles.releaseProject(ownerA);
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = originalRoots;

  console.log('All Generic Intent Classification & Project Discovery regression tests passed successfully!');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
