import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import {
  validateSafePath,
  isGreenfieldWorkspace,
  isFullStackBuildRequest,
  discoverProjectConventions,
  isProjectRuntimeTestRequest,
  deriveModularPlan,
  deriveExistingProjectTestPlan,
  runHermeticRegressionLoop,
  runHermeticRegressionLoopWithRuntime,
  repairHermeticCandidate,
  verifyHermeticEngineeringGates,
  verifyHermeticEngineeringGatesOnDisk,
  synthesizeMultiFilePatch,
  verifyIntegrationReachability,
} from '../electron/coding-pipeline/modularArchitectureEngine.cjs';

const {
  createSession,
  executeAutonomousCodingWorkflow,
} = developerAgent;
const runtimeRequire = createRequire(import.meta.url);

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-modular-test-'));
const ownerId = 73001;

try {
  console.log('--- STARTING SECTION 4.F MODULAR ARCHITECTURE & REUSABILITY TEST SUITE ---');

  // =========================================================================
  // TEST 1: Greenfield Request Creates Multiple Separated Modules (Config, Utils, Service, Entrypoint)
  // =========================================================================
  const greenfieldDir = path.join(testRoot, 'greenfield-app');
  await fs.mkdir(greenfieldDir, { recursive: true });

  const isGreenfield = await isGreenfieldWorkspace(greenfieldDir);
  assert.equal(isGreenfield, true, 'Empty workspace must be detected as greenfield');

  const greenfieldPlan = await deriveModularPlan(greenfieldDir, {
    userRequest: 'Create a calculation service with configurable multipliers and math utilities',
  });
  assert.equal(greenfieldPlan.isGreenfield, true);
  assert.equal(greenfieldPlan.modulesToCreate.length, 4, 'Greenfield plan must separate config, utils, service, and entrypoint');

  const responsibilities = greenfieldPlan.modulesToCreate.map((m) => m.responsibility);
  assert.ok(responsibilities.includes('CONFIGURATION'), 'Must include configuration module');
  assert.ok(responsibilities.includes('SHARED_UTILITY'), 'Must include shared utility module');
  assert.ok(responsibilities.includes('CORE_BUSINESS_LOGIC'), 'Must include core business logic module');
  assert.ok(responsibilities.includes('APPLICATION_ENTRYPOINT'), 'Must include application entrypoint module');

  const greenfieldSessionId = 'session-v10-greenfield';
  createSession(greenfieldSessionId, ownerId);

  let greenfieldProposalCaptured = null;
  const greenfieldResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Scaffold calculation service in greenfield project',
    root: greenfieldDir,
    scope: '.',
    sessionId: greenfieldSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async ({ proposalContract }) => {
      greenfieldProposalCaptured = proposalContract;
      return true;
    },
    tools: {
      deriveModularPlan: true,
    },
  });

  assert.equal(greenfieldResult.outcome, 'SUCCESS');
  assert.equal(greenfieldResult.codeApplied, true);
  assert.equal(greenfieldResult.codeVerified, true);
  assert.ok(greenfieldProposalCaptured.isGreenfield);

  // Verify all 4 modular files exist on disk
  for (const mod of greenfieldPlan.modulesToCreate) {
    const stat = await fs.stat(path.join(greenfieldDir, mod.path));
    assert.ok(stat.isFile(), `Module ${mod.path} must exist on disk`);
  }
  console.log('[TEST 1 PASSED] Greenfield request creates multiple appropriately separated modules.');

  // =========================================================================
  // TEST 2: Feature Request in Existing Project Reuses Established Architecture
  // =========================================================================
  const existingDir = path.join(testRoot, 'existing-app');
  await fs.mkdir(path.join(existingDir, 'services'), { recursive: true });
  await fs.mkdir(path.join(existingDir, 'utils'), { recursive: true });
  await fs.writeFile(path.join(existingDir, 'package.json'), JSON.stringify({ name: 'existing-app', version: '1.0.0' }), 'utf8');
  await fs.writeFile(path.join(existingDir, 'index.js'), '// Main Application Entrypoint\nconst existingApp = true;\n', 'utf8');

  const existingConventions = await discoverProjectConventions(existingDir);
  assert.equal(existingConventions.isGreenfield, false);
  assert.equal(existingConventions.language, 'javascript');
  assert.ok(existingConventions.serviceDirs.includes('services'));
  assert.ok(existingConventions.utilDirs.includes('utils'));

  const existingPlan = await deriveModularPlan(existingDir, {
    userRequest: 'Add order processing feature',
  });
  assert.equal(existingPlan.isGreenfield, false);
  // Reuses services/ directory instead of scaffolding new app root
  assert.ok(existingPlan.modulesToCreate.some((m) => m.path.startsWith('services/')));
  assert.ok(existingPlan.integrationPoints.some((p) => p.targetFile === 'index.js'));
  console.log('[TEST 2 PASSED] Feature request in existing project reuses established architecture.');

  // =========================================================================
  // TEST 3: Shared Logic is Reused Instead of Duplicated Where Applicable
  // =========================================================================
  const sharedModulePath = path.join(existingDir, 'utils', 'sharedUtils.js');
  await fs.writeFile(sharedModulePath, 'function formatResponse(d) { return { d }; }\nmodule.exports = { formatResponse };\n', 'utf8');

  const sharedPlan = await deriveModularPlan(existingDir, {
    userRequest: 'Add payment notification service reusing existing shared utils',
  });
  assert.ok(sharedPlan.reusedModules.length > 0, 'Existing shared utility must be detected and reused');
  assert.ok(!sharedPlan.modulesToCreate.some((m) => m.path === 'utils/sharedUtils.js'), 'Must not duplicate existing utility file');
  console.log('[TEST 3 PASSED] Shared logic is reused instead of duplicated where applicable.');

  // =========================================================================
  // TEST 4: Required Integration Points Are Updated and Verified
  // =========================================================================
  const existingSessionId = 'session-v10-existing';
  createSession(existingSessionId, ownerId);
  await developerFiles.attachProject(existingDir, ownerId);

  const existingResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Implement feature service in existing project',
    root: existingDir,
    scope: '.',
    sessionId: existingSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async () => true,
    tools: {
      modularPlan: sharedPlan,
    },
  });

  assert.equal(existingResult.outcome, 'SUCCESS');
  assert.equal(existingResult.codeApplied, true);
  assert.equal(existingResult.codeVerified, true);

  // Check that index.js integration point was updated
  const indexContentAfter = await fs.readFile(path.join(existingDir, 'index.js'), 'utf8');
  assert.ok(indexContentAfter.includes('executeFeature'), 'Integration point in index.js must import executeFeature');
  console.log('[TEST 4 PASSED] Required integration points are updated and verified.');

  // =========================================================================
  // TEST 4A: Creation Directives with Defensive Requirements Stay Actionable on Populated Workspaces
  // =========================================================================
  const populatedCreationDir = path.join(testRoot, 'populated-creation-app');
  await fs.mkdir(path.join(populatedCreationDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(populatedCreationDir, 'package.json'),
    JSON.stringify({ name: 'populated-creation-app', version: '1.0.0' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(populatedCreationDir, 'index.js'),
    'const existingBehavior = true;\nmodule.exports = { existingBehavior };\n',
    'utf8',
  );
  await fs.writeFile(path.join(populatedCreationDir, 'src', 'existing.js'), 'module.exports = 1;\n', 'utf8');
  const populatedCreationSessionId = 'session-v12-populated-creation';
  createSession(populatedCreationSessionId, ownerId);
  let populatedCreationApprovalCount = 0;
  const populatedCreationResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Act as an expert full-stack developer. Build a complete feature with a model, POST endpoint, and form component. Include proper error handling (try-catch, status codes 201, 400, 500) and success or error messages. Workspace resolution: UPDATE_AND_INTEGRATE.',
    root: populatedCreationDir,
    scope: '.',
    sessionId: populatedCreationSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async () => {
      populatedCreationApprovalCount += 1;
      return true;
    },
  });
  assert.notEqual(populatedCreationResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(populatedCreationResult.outcome, 'SUCCESS', JSON.stringify(populatedCreationResult.hermeticVerification));
  assert.equal(populatedCreationResult.codeApplied, true);
  assert.equal(populatedCreationApprovalCount, 1, 'The populated workspace creation must reach the approved proposal flow.');
  assert.ok(populatedCreationResult.filesModified.length > 0, 'The creation request must apply an actionable proposal.');
  console.log('[TEST 4A PASSED] Defensive error-handling language does not divert populated workspace creation into investigation.');

  // =========================================================================
  // TEST 4B: Dynamic full-stack requests upgrade only inspected placeholder modules
  // =========================================================================
  const populatedStubDir = path.join(testRoot, 'populated-stub-app');
  const stubFiles = {
    'package.json': JSON.stringify({ name: 'populated-stub-app', type: 'commonjs' }),
    'index.js': 'const existingBehavior = true;\nmodule.exports = { existingBehavior };\n',
    'server.js': '',
    'models/subscriptionSchema.js': '// TODO: define subscription fields\n',
    'controllers/subscriptionController.js': '// TODO: handle requests\n',
    'routes/subscriptionRoutes.js': '// TODO: register routes\n',
    'components/SubscriptionForm.jsx': 'export default function SubscriptionForm() { return null; }\n',
    'pages/SubscriptionPage.jsx': 'export default function SubscriptionPage() { return null; }\n',
  };
  for (const [relative, content] of Object.entries(stubFiles)) {
    const target = path.join(populatedStubDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content.replace(/\n/g, '\r\n'), 'utf8');
  }
  const populatedStubPlan = await deriveModularPlan(populatedStubDir, {
    userRequest: `Build a complete full-stack subscription feature with a frontend form and backend API.
Create a POST endpoint /api/subscriptions.
Fields:
- customerName: string (required)
- items: [{ sku: string, quantity: number, unitPrice: number }]
- totalAmount: number
Create a page and form component with success and error messages.`,
  });
  assert.equal(populatedStubPlan.isGreenfield, false);
  assert.ok(populatedStubPlan.workspaceInspection.inspectedFiles.includes('server.js'));
  assert.ok(populatedStubPlan.modulesToCreate.some((module) => (
    module.path === 'models/subscriptionSchema.js' && module.operation === 'modify'
  )));
  assert.ok(populatedStubPlan.modulesToCreate.some((module) => (
    module.path === 'routes/subscriptionRoutes.js' && module.operation === 'modify'
  )));
  assert.ok(populatedStubPlan.modulesToCreate.some((module) => (
    module.path === 'server.js' && module.operation === 'modify'
  )));
  assert.match(populatedStubPlan.modulesToCreate.find((module) => module.path === 'models/subscriptionSchema.js').content, /items\[item\] must be an object/);
  const populatedStubPatch = await synthesizeMultiFilePatch(populatedStubDir, populatedStubPlan);
  assert.ok(populatedStubPatch.filesList.filter((file) => file.operation === 'modify').length >= 6);
  assert.ok(populatedStubPatch.expectedSnapshots.some((snapshot) => (
    snapshot.path === 'server.js' && snapshot.exists === true
  )));
  assert.ok(populatedStubPatch.rawPatch.includes('--- a/server.js'));
  const parsedPopulatedPatch = developerAgent.parsePatch(populatedStubPatch.rawPatch);
  const emptyServerPatch = parsedPopulatedPatch.find((operation) => operation.path === 'server.js');
  assert.ok(emptyServerPatch, 'An existing zero-byte server entrypoint should remain a modify operation.');
  assert.match(
    emptyServerPatch.lines[0],
    /^@@ -0,0 \+\d+,\d+ @@$/,
    'A zero-byte target must use a zero-line source hunk.',
  );
  for (const operation of parsedPopulatedPatch) {
    const snapshot = populatedStubPatch.expectedSnapshots.find((item) => item.path === operation.path);
    const expectedModule = populatedStubPlan.modulesToCreate.find((module) => module.path === operation.path);
    assert.ok(snapshot, `${operation.path} must bind to its pre-proposal disk snapshot.`);
    assert.equal(
      snapshot.exists,
      operation.operation !== 'create',
      `${operation.path} must be classified against its exact pre-proposal disk snapshot.`,
    );
    const expectedContent = expectedModule?.content
      ?? populatedStubPlan.integrationPoints.find((point) => point.targetFile === operation.path)?.patchedContent;
    let expectedOnDisk = expectedContent.replace(/\r\n/g, '\n');
    if (snapshot.exists && snapshot.content && !/(?:\r\n|\n)$/.test(snapshot.content)) {
      expectedOnDisk = expectedOnDisk.replace(/\n$/, '');
    }
    assert.equal(
      developerAgent.applyFilePatch(snapshot.content || '', operation.lines).replace(/\r\n/g, '\n'),
      expectedOnDisk,
      `${operation.path} full-file operation must apply against its exact CRLF snapshot.`,
    );
  }
  const duplicatePlan = {
    ...populatedStubPlan,
    modulesToCreate: [
      ...populatedStubPlan.modulesToCreate,
      { ...populatedStubPlan.modulesToCreate[0] },
    ],
  };
  const deduplicatedPatch = await synthesizeMultiFilePatch(populatedStubDir, duplicatePlan);
  assert.equal(
    deduplicatedPatch.filesList.filter((file) => file.path === populatedStubPlan.modulesToCreate[0].path).length,
    1,
    'Repeated module operations for one target should stage only one coherent write.',
  );
  console.log('[TEST 4B PASSED] Dynamic full-stack plans inspect and snapshot existing placeholder modules as modifications.');

  const partialOrderDir = path.join(testRoot, 'partial-order-stub');
  await fs.mkdir(path.join(partialOrderDir, 'utils'), { recursive: true });
  await fs.mkdir(path.join(partialOrderDir, 'services'), { recursive: true });
  await fs.writeFile(
    path.join(partialOrderDir, 'server.js'),
    "const { executeFeature } = require('./services/featureService');\n",
    'utf8',
  );
  await fs.writeFile(path.join(partialOrderDir, 'utils', 'sharedUtils.js'), 'module.exports = {};\n', 'utf8');
  await fs.writeFile(path.join(partialOrderDir, 'services', 'featureService.js'), 'module.exports = {};\n', 'utf8');
  const retainedEnvironmentExample = 'PORT=3000\nDATABASE_URL=mongodb://127.0.0.1:27017/app_dev\nAPI_URL=http://127.0.0.1:3000\n';
  await fs.writeFile(path.join(partialOrderDir, '.env.example'), retainedEnvironmentExample, 'utf8');
  const partialOrderPrompt = `Act as an expert Full-Stack Developer. Build a complete 'Add Order' feature.
Create an Order Model/Schema and a POST endpoint /api/orders.
Fields:
- customerName: string (required)
- items: [{ itemName: string, quantity: number, price: number }]
- totalPrice: number (auto calculated)
- status: string (default: "Pending")
- createdAt: date
Create a Next.js App Router page and React form component with Tailwind CSS, dynamic item rows, and success/error messages.`;
  assert.equal(isFullStackBuildRequest(partialOrderPrompt), true);
  const partialOrderPlan = await deriveModularPlan(partialOrderDir, { userRequest: partialOrderPrompt });
  const partialOrderFiles = partialOrderPlan.modulesToCreate.map((module) => module.path);
  assert.equal(partialOrderPlan.blockedReason, undefined);
  assert.equal(partialOrderPlan.modulesToCreate.find((module) => module.path === 'server.js')?.operation, 'modify');
  for (const requiredPath of [
    'package.json',
    '.env.example',
    'README.md',
    'config/db.js',
    'models/Order.js',
    'controllers/orderController.js',
    'routes/orders.js',
    'components/OrderForm.jsx',
    'app/orders/page.jsx',
  ]) {
    assert.ok(partialOrderFiles.includes(requiredPath), `Partial full-stack workspace must include ${requiredPath}.`);
  }
  assert.ok(!partialOrderFiles.includes('utils/sharedUtils.js'));
  assert.ok(!partialOrderFiles.includes('services/featureService.js'));
  const retainedEnvironmentModule = partialOrderPlan.modulesToCreate.find((module) => module.path === '.env.example');
  assert.equal(retainedEnvironmentModule.operation, 'reuse');
  assert.doesNotMatch(retainedEnvironmentModule.content, /DATABASE_URL=/);
  repairHermeticCandidate(partialOrderPlan);
  const partialOrderVerification = verifyHermeticEngineeringGates(partialOrderPlan);
  assert.equal(partialOrderVerification.status, 'HERMETIC_CONTRACT_AND_SYNTAX_VERIFIED', JSON.stringify(partialOrderVerification));
  assert.equal(partialOrderVerification.passed, 8);
  assert.equal(partialOrderVerification.total, 8);
  assert.ok(!(await fs.readdir(partialOrderDir)).includes('node_modules'));
  const partialOrderPatch = await synthesizeMultiFilePatch(partialOrderDir, partialOrderPlan);
  assert.ok(partialOrderPatch.filesList.some((file) => file.path === 'server.js' && file.operation === 'modify'));
  assert.ok(partialOrderPatch.filesList.some((file) => file.path === 'models/Order.js' && file.operation === 'create'));
  assert.ok(!partialOrderPatch.filesList.some((file) => file.path === '.env.example'));
  assert.equal(await fs.readFile(path.join(partialOrderDir, '.env.example'), 'utf8'), retainedEnvironmentExample);
  console.log('[TEST 4F PASSED] Partial generic scaffolds upgrade to a prompt-grounded full-stack module set and all eight hermetic gates.');

  const hermeticDir = path.join(testRoot, 'hermetic-full-stack');
  await fs.mkdir(hermeticDir, { recursive: true });
  const hermeticPlan = await deriveModularPlan(hermeticDir, {
    userRequest: `Build a complete order feature with a frontend form and backend API.
Create a POST endpoint /api/orders.
Fields:
- customerName: string (required)
- items: [{ itemName: string, quantity: number, price: number }]
- totalPrice: number
- status: string (default "Pending")
- createdAt: string
Create a page and form component with loading, success and error messages.
Return status codes 201, 400, and 500.`,
  });
  assert.deepEqual(await fs.readdir(hermeticDir), [], 'Planning and repair must not write workspace files before approval.');
  repairHermeticCandidate(hermeticPlan);
  const hermeticCandidate = verifyHermeticEngineeringGates(hermeticPlan);
  assert.equal(hermeticCandidate.status, 'HERMETIC_CONTRACT_AND_SYNTAX_VERIFIED', JSON.stringify(hermeticCandidate));
  assert.equal(hermeticCandidate.passed, 8);
  assert.equal(hermeticCandidate.total, 8);
  assert.deepEqual(
    hermeticCandidate.behavioralMatrix.vectors.map((vector) => vector.id),
    [
      'valid-multi-item-total-defaults-and-creation',
      'required-scalar-whitespace-rejected',
      'empty-or-non-array-nested-collection-rejected',
      'invalid-nested-item-values-rejected',
      'structured-client-and-server-error-responses',
    ],
  );
  assert.ok(hermeticCandidate.behavioralMatrix.vectors.every((vector) => vector.passed));
  const runtimeCandidate = await runHermeticRegressionLoopWithRuntime(hermeticPlan, { root: hermeticDir });
  assert.equal(runtimeCandidate.passed, 9, JSON.stringify(runtimeCandidate.gates.filter((gate) => !gate.passed)));
  assert.equal(runtimeCandidate.total, 9);
  assert.equal(runtimeCandidate.gates.at(-1).id, 'CANDIDATE_RUNTIME_BEHAVIOR');
  assert.equal(runtimeCandidate.gates.at(-1).probes.length, 6);
  assert.ok(runtimeCandidate.gates.at(-1).probes.every((probe) => probe.applicable && probe.passed));
  assert.equal(runtimeCandidate.gates.at(-1).executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.equal(runtimeCandidate.gates.at(-1).host, '127.0.0.1');
  assert.equal(runtimeCandidate.gates.at(-1).behavioralApiProbes.length, 5);
  assert.equal(runtimeCandidate.gates.at(-1).behavioralTestSuite.status, 'EXECUTED & PASSED');
  assert.ok(runtimeCandidate.gates.at(-1).behavioralTestSuite.assertionCount > 0);
  assert.equal(runtimeCandidate.gates.at(-1).collectionProbe.method, 'GET');
  assert.equal(runtimeCandidate.gates.at(-1).collectionProbe.passed, true);
  assert.equal(runtimeCandidate.gates.at(-1).uiPreview.passed, true);
  const runtimeResource = hermeticPlan.routeContracts[0].path.split('/').filter(Boolean).at(-1);
  assert.deepEqual(runtimeCandidate.gates.at(-1).uiPreview.paths.map((probe) => probe.path), ['/', `/${runtimeResource}`]);
  assert.ok(runtimeCandidate.gates.at(-1).uiPreview.paths.every((probe) => probe.passed));
  const runtimeDefectPlan = {
    ...hermeticPlan,
    modulesToCreate: hermeticPlan.modulesToCreate.map((module) => ({ ...module })),
    routeContracts: hermeticPlan.routeContracts.map((route) => ({ ...route })),
    routeSchema: JSON.parse(JSON.stringify(hermeticPlan.routeSchema)),
  };
  const runtimeDefectModel = runtimeDefectPlan.modulesToCreate.find((module) => module.responsibility === 'DATA_MODEL');
  runtimeDefectModel.content = runtimeDefectModel.content.replace(
    'function create(payload) {',
    "function create(payload) { throw new Error('Runtime-only persistence defect.');",
  );
  assert.equal(verifyHermeticEngineeringGates(runtimeDefectPlan).passed, 8, 'The fixture defect must evade textual gates.');
  const runtimeRepairMessages = [];
  const runtimeRepair = await runHermeticRegressionLoopWithRuntime(runtimeDefectPlan, {
    root: hermeticDir,
    onProgress: (event) => runtimeRepairMessages.push(event.message),
  });
  assert.equal(runtimeRepair.passed, 9, JSON.stringify(runtimeRepair.gates.filter((gate) => !gate.passed)));
  assert.ok(runtimeRepair.regressionLoop.repairs.some((repair) => repair.includes('models/Order.js')));
  assert.ok(runtimeRepairMessages.some((message) => message.includes('[SELF-REPAIR]')));
  console.log('[TEST 4H PASSED] Candidate-only runtime probes execute all five behavioral cases and repair a runtime-only model defect.');
  const astDefectPlan = {
    ...hermeticPlan,
    modulesToCreate: hermeticPlan.modulesToCreate.map((module) => ({ ...module })),
    routeContracts: hermeticPlan.routeContracts.map((route) => ({ ...route })),
  };
  const astDefectForm = astDefectPlan.modulesToCreate.find((module) => module.path === 'components/OrderForm.jsx');
  astDefectForm.content = astDefectForm.content.replace('method: "POST"', 'method: "GET"');
  assert.equal(
    verifyHermeticEngineeringGates(astDefectPlan).gates.find((gate) => gate.id === 'CROSS_LAYER_DATA_FLOW').passed,
    false,
    'AST data-flow verification must reject a frontend request method that diverges from its route contract.',
  );
  const astRepairEvents = [];
  const astRepair = runHermeticRegressionLoop(astDefectPlan, {
    root: hermeticDir,
    onProgress: (event) => astRepairEvents.push(event.message),
  });
  assert.equal(astRepair.passed, 8, JSON.stringify(astRepair));
  assert.ok(astRepairEvents.some((message) => message.includes('[DEEP-THINK REPAIR PASS')));
  assert.ok(astRepairEvents.some((message) => message.includes('CROSS_LAYER_DATA_FLOW @ components/OrderForm.jsx')));
  for (const requiredFile of ['package.json', '.env.example', 'README.md']) {
    assert.ok(hermeticPlan.modulesToCreate.some((module) => module.path === requiredFile), `${requiredFile} must be part of the proposal.`);
  }
  const controllerModule = hermeticPlan.modulesToCreate.find((module) => module.responsibility === 'CORE_BUSINESS_LOGIC');
  controllerModule.content = controllerModule.content.replace('status: 400', 'status: 422');
  const modelModule = hermeticPlan.modulesToCreate.find((module) => module.responsibility === 'DATA_MODEL');
  modelModule.content = modelModule.content.replace('"customerName"', '"removedField"');
  const packageModule = hermeticPlan.modulesToCreate.find((module) => module.path === 'package.json');
  packageModule.content = packageModule.content
    .replace('"start": "node server.js"', '"start": "node wrong.js"')
    .replace('"dev": "node server.js"', '"dev": "node wrong.js"');
  repairHermeticCandidate(hermeticPlan);
  assert.equal(
    verifyHermeticEngineeringGates(hermeticPlan).status,
    'HERMETIC_CONTRACT_AND_SYNTAX_VERIFIED',
    'Pre-proposal self-healing must restore missing field/status/run-script contracts before staging.',
  );
  const loopPlan = {
    ...hermeticPlan,
    modulesToCreate: hermeticPlan.modulesToCreate.map((module) => ({ ...module })),
    routeContracts: hermeticPlan.routeContracts.map((route) => ({ ...route })),
  };
  const loopServer = loopPlan.modulesToCreate.find((module) => module.path === 'server.js');
  loopServer.content = `const unusedDependency = require('missing-v14-test-package');\n${loopServer.content}`;
  const loopModel = loopPlan.modulesToCreate.find((module) => module.responsibility === 'DATA_MODEL');
  loopModel.content = loopModel.content.replace(/if \(Array\.isArray\(value\["items"\]\)\) \{[\s\S]*?\n  \}/, '');
  const failedModuleGate = verifyHermeticEngineeringGates(loopPlan, undefined, { root: hermeticDir });
  assert.equal(
    failedModuleGate.gates.find((gate) => gate.id === 'MODULE_AND_RUNTIME_RESOLUTION').passed,
    false,
    'An unguarded missing package import must fail Gate 6 before repair.',
  );
  const regressionEvents = [];
  const regressionResult = runHermeticRegressionLoop(loopPlan, {
    root: hermeticDir,
    onProgress: (event) => regressionEvents.push(event.message),
  });
  assert.equal(regressionResult.passed, 8, JSON.stringify(regressionResult));
  assert.equal(regressionResult.regressionLoop.passes, 2);
  assert.ok(regressionResult.regressionLoop.repairs.length >= 2);
  assert.ok(regressionEvents.some((message) => message.includes('[THINK / REGRESSION LOOP]')));
  assert.ok(!loopServer.content.includes('missing-v14-test-package'));
  assert.match(loopModel.content, /\.reduce\(/);
  const badBindingPlan = {
    ...hermeticPlan,
    modulesToCreate: hermeticPlan.modulesToCreate.map((module) => ({ ...module })),
    routeContracts: hermeticPlan.routeContracts.map((route) => ({ ...route })),
  };
  const badBindingServer = badBindingPlan.modulesToCreate.find((module) => module.path === 'server.js');
  const badBindingModel = badBindingPlan.modulesToCreate.find((module) => module.responsibility === 'DATA_MODEL');
  const badBindingSpecifier = `./${path.posix.relative(path.posix.dirname(badBindingServer.path), badBindingModel.path)}`;
  badBindingServer.content = `const { missingBinding } = require(${JSON.stringify(badBindingSpecifier)});\n${badBindingServer.content}`;
  const badBindingGate = verifyHermeticEngineeringGates(badBindingPlan, undefined, { root: hermeticDir })
    .gates.find((gate) => gate.id === 'MODULE_AND_RUNTIME_RESOLUTION');
  assert.equal(badBindingGate.passed, false, 'Missing named exports on relative imports must fail Gate 6.');
  assert.match(JSON.stringify(badBindingGate.evidence), /missingBinding/);
  console.log('[TEST 4G PASSED] Gate 6 fails closed on missing packages and bindings; the bounded regression loop repairs safe generated defects.');
  const candidatePatch = await synthesizeMultiFilePatch(hermeticDir, hermeticPlan);
  for (const module of hermeticPlan.modulesToCreate) {
    const target = path.join(hermeticDir, module.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, module.content, 'utf8');
  }
  assert.equal((await verifyHermeticEngineeringGatesOnDisk(hermeticDir, hermeticPlan)).passed, 9);
  const portReservation = net.createServer();
  await new Promise((resolve, reject) => {
    portReservation.once('error', reject);
    portReservation.listen(0, '127.0.0.1', resolve);
  });
  const serverPort = portReservation.address().port;
  await new Promise((resolve, reject) => portReservation.close((error) => (error ? reject(error) : resolve())));
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: hermeticDir,
    env: { ...process.env, PORT: String(serverPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk; });
  serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk; });
  try {
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    let readyResponse;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (serverProcess.exitCode !== null) break;
      try {
        readyResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(readyResponse, `Generated server should start without node_modules. ${serverOutput}`);
    const initialListPayload = await readyResponse.json();
    assert.equal(readyResponse.status, 200, JSON.stringify(initialListPayload));
    assert.deepEqual(initialListPayload.data, []);
    const previewResponse = await fetch(baseUrl);
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get('content-type') || '', /text\/html/i);
    const previewHtml = await previewResponse.text();
    assert.match(previewHtml, /<form>/);
    assert.ok(previewHtml.includes(`fetch(${JSON.stringify(hermeticPlan.routeContracts[0].path)}`));
    const createdResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Sample customer',
        items: [
          { itemName: 'Sample item', quantity: 2, price: 3.5 },
          { itemName: 'Second item', quantity: 1, price: 2 },
        ],
      }),
    });
    assert.equal(createdResponse.status, 201);
    const createdRecord = (await createdResponse.json()).data;
    assert.equal(createdRecord.totalPrice, 9);
    assert.equal(createdRecord.status, 'Pending');
    assert.ok(createdRecord.createdAt);
    const invalidResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'Sample customer', items: 'invalid' }),
    });
    assert.equal(invalidResponse.status, 400);
    const emptyItemsResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'Sample customer', items: [] }),
    });
    assert.equal(emptyItemsResponse.status, 400);
    const whitespaceResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: '   ', items: [{ itemName: 'item', quantity: 1, price: 1 }] }),
    });
    assert.equal(whitespaceResponse.status, 400);
    const invalidItemResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'Sample customer', items: [{ itemName: 'Valid item', quantity: 0, price: 1 }] }),
    });
    assert.equal(invalidItemResponse.status, 400);
    const negativePriceResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'Sample customer', items: [{ itemName: 'Valid item', quantity: 1, price: -1 }] }),
    });
    assert.equal(negativePriceResponse.status, 400);
    const listResponse = await fetch(`${baseUrl}${hermeticPlan.routeContracts[0].path}`);
    assert.equal((await listResponse.json()).data.length, 1);
    const runtimeModel = runtimeRequire(path.join(hermeticDir, hermeticPlan.routeContracts[0].modelFile));
    const runtimeController = runtimeRequire(path.join(hermeticDir, hermeticPlan.routeContracts[0].controllerFile));
    const originalCreate = runtimeModel.create;
    runtimeModel.create = () => { throw new Error('simulated storage failure'); };
    try {
      const failureResult = await runtimeController[hermeticPlan.routeContracts[0].controllerHandler]({
        body: { customerName: 'Valid customer', items: [{ itemName: 'Valid item', quantity: 1, price: 1 }] },
      });
      assert.equal(failureResult.status, 500);
      assert.equal(typeof failureResult.body.error, 'string');
    } finally {
      runtimeModel.create = originalCreate;
    }
  } finally {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once('close', resolve));
  }
  console.log('[TEST 4H PASSED] Generated server starts without node_modules and serves POST/GET with computed totals and validation statuses.');
  packageModule.content = packageModule.content.replace('"start": "node server.js"', '"start": "node wrong.js"');
  await fs.writeFile(path.join(hermeticDir, 'package.json'), packageModule.content, 'utf8');
  const diskFailure = await verifyHermeticEngineeringGatesOnDisk(hermeticDir, hermeticPlan);
  assert.equal(diskFailure.status, 'HERMETIC_VERIFICATION_FAILED');
  assert.equal(diskFailure.passed, 7, 'Post-apply gates must detect a bad on-disk start script.');
  assert.ok(candidatePatch.rawPatch.includes('package.json'));
  console.log('[TEST 4D PASSED] Eight hermetic gates, package/docs/env proposals, and pre-proposal field/status repairs are verified.');

  const esmDir = path.join(testRoot, 'hermetic-esm');
  await fs.mkdir(esmDir, { recursive: true });
  await fs.writeFile(path.join(esmDir, 'package.json'), JSON.stringify({ name: 'esm-project', type: 'module' }), 'utf8');
  const esmPlan = await deriveModularPlan(esmDir, {
    userRequest: `Build a full-stack catalog feature with an API form.
Create a POST endpoint /api/catalog.
Fields:
- title: string (required)
Create a form and page.`,
  });
  repairHermeticCandidate(esmPlan);
  assert.equal(verifyHermeticEngineeringGates(esmPlan).passed, 8);
  const esmPackage = JSON.parse(esmPlan.modulesToCreate.find((module) => module.path === 'package.json').content);
  assert.equal(esmPackage.type, 'module', 'Existing package module format must be preserved.');
  assert.match(esmPlan.modulesToCreate.find((module) => module.path === 'server.js').content, /import http from/);
  const esmRuntime = await runHermeticRegressionLoopWithRuntime(esmPlan, { root: esmDir });
  assert.equal(esmRuntime.passed, 9, JSON.stringify(esmRuntime.gates.filter((gate) => !gate.passed)));
  console.log('[TEST 4E PASSED] Existing ESM package metadata is preserved with compatible generated backend modules.');

  const legacyUpgradeDir = path.join(testRoot, 'legacy-hermetic-upgrade');
  await fs.mkdir(legacyUpgradeDir, { recursive: true });
  const legacyEnvironmentContents = 'PORT=4300\nDATABASE_URL=mongodb://localhost/legacy\n';
  const legacyWorkspaceFiles = {
    'config/db.js': "const mongoose = require('mongoose');\nmodule.exports = mongoose;\n",
    'models/Catalog.js': "const { Schema } = require('mongoose');\nmodule.exports = new Schema({});\n",
    'controllers/catalogController.js': "const { findCatalog } = require('../models/Catalog');\nmodule.exports = { findCatalog };\n",
    'routes/catalog.js': "const express = require('express');\nmodule.exports = express.Router();\n",
    'server.js': "const express = require('express');\nconst app = express();\nmodule.exports = app;\n",
    'components/CatalogForm.jsx': "import React, { useState } from 'react';\nexport default function CatalogForm() { return null; }\n",
    'app/catalog/page.jsx': "import { MissingCatalogForm } from '../../components/CatalogForm.jsx';\nexport default function CatalogPage() { return <MissingCatalogForm />; }\n",
    'package.json': JSON.stringify({
      name: 'legacy-catalog',
      type: 'commonjs',
      scripts: {
        start: 'node old-server.js',
        dev: 'node old-server.js',
        test: 'echo legacy',
        'test:existing': 'node preserved-suite.js',
      },
      dependencies: { express: '^4.0.0', mongoose: '^8.0.0', react: '^18.0.0', 'react-dom': '^18.0.0' },
    }, null, 2),
    '.env.example': legacyEnvironmentContents,
    'README.md': '# Legacy catalog workspace\n\nRetain this documentation.\n',
    'services/featureService.js': "const express = require('express');\nmodule.exports = express;\n",
    'utils/sharedUtils.js': 'module.exports = {};\n',
  };
  for (const [relativePath, contents] of Object.entries(legacyWorkspaceFiles)) {
    const target = path.join(legacyUpgradeDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents.replace(/\n/g, '\r\n'), 'utf8');
  }
  const retainedLegacyEnvironment = await fs.readFile(path.join(legacyUpgradeDir, '.env.example'), 'utf8');
  const legacyUpgradePrompt = `Build a complete full-stack catalog feature with a React form.
Create a POST endpoint /api/catalog.
Fields:
- title: string (required)
- items: [{ label: string, quantity: number, price: number }]
- total: number (calculated)
- status: string (default=Pending)
Create a page and form with validation and status messages.
Workspace resolution: UPDATE_AND_INTEGRATE.`;
  const legacyUpgradePlan = await deriveModularPlan(legacyUpgradeDir, { userRequest: legacyUpgradePrompt });
  assert.ok(legacyUpgradePlan.modulesToCreate.length >= 9);
  assert.ok(legacyUpgradePlan.modulesToCreate
    .filter((module) => module.path !== '.env.example' && module.responsibility !== 'TEST_SUITE')
    .every((module) => module.operation === 'modify'),
  'Each existing full-stack target must be staged as a modification.');
  const generatedTestModule = legacyUpgradePlan.modulesToCreate.find((module) => module.responsibility === 'TEST_SUITE');
  assert.equal(generatedTestModule.path, 'tests/catalog.test.js');
  assert.equal(generatedTestModule.operation, 'create');
  assert.match(generatedTestModule.content, /node:http/);
  assert.equal(
    JSON.parse(legacyUpgradePlan.modulesToCreate.find((module) => module.path === 'package.json').content).scripts.test,
    'node tests/catalog.test.js',
  );
  const legacyGeneratedScripts = JSON.parse(
    legacyUpgradePlan.modulesToCreate.find((module) => module.path === 'package.json').content,
  ).scripts;
  assert.equal(legacyGeneratedScripts['test:existing'], 'node preserved-suite.js');
  assert.equal(legacyGeneratedScripts['test:existing-1'], 'echo legacy');
  assert.match(
    legacyUpgradePlan.modulesToCreate.find((module) => module.path === 'README.md').content,
    /Run `npm test` to execute the zero-dependency behavioral suite/,
  );
  assert.equal(
    legacyUpgradePlan.modulesToCreate.find((module) => module.path === '.env.example').operation,
    'reuse',
    'An existing environment example must remain read-only.',
  );
  const legacyServer = legacyUpgradePlan.modulesToCreate.find((module) => module.path === 'server.js');
  const legacyModel = legacyUpgradePlan.modulesToCreate.find((module) => module.responsibility === 'DATA_MODEL');
  const legacyPage = legacyUpgradePlan.modulesToCreate.find((module) => module.path.startsWith('app/'));
  legacyServer.content = `const express = require('express');\nconst app = express();\n${legacyServer.content}`;
  legacyModel.content = "const mongoose = require('mongoose');\nmodule.exports = {};\n";
  legacyPage.content = "import { MissingCatalogForm } from '../../components/CatalogForm.jsx';\nexport default function CatalogPage() { return <MissingCatalogForm />; }\n";
  const legacyProgress = [];
  const legacyRepair = runHermeticRegressionLoop(legacyUpgradePlan, {
    root: legacyUpgradeDir,
    onProgress: (event) => legacyProgress.push(event.message),
  });
  assert.equal(legacyRepair.status, 'HERMETIC_CONTRACT_AND_SYNTAX_VERIFIED', JSON.stringify(legacyRepair));
  assert.equal(legacyRepair.passed, 8);
  assert.equal(legacyRepair.total, 8);
  assert.ok(legacyRepair.regressionLoop.repairs.some((repair) => repair.includes('server.js')));
  assert.ok(legacyRepair.regressionLoop.repairs.some((repair) => repair.includes(legacyModel.path)));
  assert.ok(legacyRepair.regressionLoop.repairs.some((repair) => repair.includes(legacyPage.path)));
  assert.ok(legacyProgress.some((message) => message.includes('MODULE_AND_RUNTIME_RESOLUTION @ server.js')));
  assert.ok(legacyProgress.some((message) => message.includes('MODULE_AND_RUNTIME_RESOLUTION @ app/')));
  assert.ok(legacyProgress.some((message) => message.includes('[SELF-REPAIR]')));
  const legacyUpgradePatch = await synthesizeMultiFilePatch(legacyUpgradeDir, legacyUpgradePlan);
  for (const targetPath of [
    'config/db.js', 'models/Catalog.js', 'controllers/catalogController.js',
    'routes/catalog.js', 'server.js', 'components/CatalogForm.jsx',
    'app/catalog/page.jsx', 'package.json',
  ]) {
    assert.ok(legacyUpgradePatch.filesList.some((file) => file.path === targetPath && file.operation === 'modify'));
  }
  assert.ok(!legacyUpgradePatch.filesList.some((file) => file.path === '.env.example'));
  for (const module of legacyUpgradePlan.modulesToCreate.filter((candidate) => candidate.operation !== 'reuse')) {
    const target = path.join(legacyUpgradeDir, ...module.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, module.content, 'utf8');
  }
  assert.equal(await fs.readFile(path.join(legacyUpgradeDir, '.env.example'), 'utf8'), retainedLegacyEnvironment);
  const legacyDiskVerification = await verifyHermeticEngineeringGatesOnDisk(legacyUpgradeDir, legacyUpgradePlan);
  assert.equal(legacyDiskVerification.status, 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED', JSON.stringify(legacyDiskVerification));
  assert.equal(legacyDiskVerification.passed, 9, JSON.stringify(legacyDiskVerification));
  assert.equal(legacyDiskVerification.total, 9);
  const generatedTestProcess = spawn(process.execPath, ['tests/catalog.test.js'], { cwd: legacyUpgradeDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let generatedTestStdout = '';
  let generatedTestStderr = '';
  generatedTestProcess.stdout.setEncoding('utf8');
  generatedTestProcess.stderr.setEncoding('utf8');
  generatedTestProcess.stdout.on('data', (chunk) => { generatedTestStdout += chunk; });
  generatedTestProcess.stderr.on('data', (chunk) => { generatedTestStderr += chunk; });
  const generatedTestExitCode = await new Promise((resolve, reject) => {
    generatedTestProcess.once('error', reject);
    generatedTestProcess.once('close', resolve);
  });
  assert.equal(generatedTestExitCode, 0, generatedTestStderr);
  assert.match(generatedTestStdout, /Loopback UI, API behavior, persistence, and controller error boundary passed/);
  for (const prompt of [
    'test the project',
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
    'test the my project is wroking now',
    'st the my project is wroking now',
    'est the project',
  ]) {
    assert.equal(isProjectRuntimeTestRequest(prompt), true, `${prompt} should enter the runtime test flow.`);
  }
  for (const prompt of [
    'Explain how to test the project',
    'Investigate how project test selection works',
  ]) {
    assert.equal(isProjectRuntimeTestRequest(prompt), false, `${prompt} must remain a normal inquiry.`);
  }
  const runtimeVerificationFixture = path.join(testRoot, 'existing-runtime-test-upgrade');
  await fs.cp(legacyUpgradeDir, runtimeVerificationFixture, { recursive: true });
  await fs.rm(path.join(runtimeVerificationFixture, 'tests'), { recursive: true, force: true });
  await fs.mkdir(path.join(runtimeVerificationFixture, 'pages'), { recursive: true });
  await fs.writeFile(
    path.join(runtimeVerificationFixture, 'pages', 'catalog.js'),
    "export default function LegacyCatalogPage() { return null; }\n",
    'utf8',
  );
  const oldPackagePath = path.join(runtimeVerificationFixture, 'package.json');
  const oldPackage = {
    name: 'legacy-order-app',
    version: '1.0.0',
    type: 'commonjs',
    scripts: {
      start: 'node server.js',
      dev: 'node server.js',
      test: 'node --check server.js',
    },
  };
  const legacyPackageContents = `${JSON.stringify(oldPackage, null, 2)}\n`;
  assert.ok(Buffer.byteLength(legacyPackageContents) <= 278);
  await fs.writeFile(oldPackagePath, legacyPackageContents.padEnd(278, ' '), 'utf8');
  assert.equal((await fs.stat(oldPackagePath)).size, 278, 'The V18-style package manifest fixture must be exactly 278 bytes.');
  const existingRuntimePlan = await deriveExistingProjectTestPlan(runtimeVerificationFixture);
  assert.ok(existingRuntimePlan?.isProjectRuntimeTest);
  assert.ok(
    !existingRuntimePlan.modulesToCreate.some((module) => module.operation === 'rename'),
    'A test-only request must not propose route migration or mutate an unrelated legacy Pages Router file.',
  );
  const runtimeSuiteModule = existingRuntimePlan.modulesToCreate.find((module) => module.responsibility === 'TEST_SUITE');
  assert.equal(runtimeSuiteModule.path, 'tests/catalog.test.js');
  assert.equal(runtimeSuiteModule.operation, 'create');
  const runtimePackageModule = existingRuntimePlan.modulesToCreate.find((module) => module.path === 'package.json');
  assert.equal(JSON.parse(runtimePackageModule.content).scripts.test, 'node tests/catalog.test.js');
  assert.equal(JSON.parse(runtimePackageModule.content).scripts['test:existing'], 'node --check server.js');
  const existingRuntimeVerification = await runHermeticRegressionLoopWithRuntime(existingRuntimePlan, { root: runtimeVerificationFixture });
  assert.equal(existingRuntimeVerification.passed, 9, JSON.stringify(existingRuntimeVerification));
  assert.equal(existingRuntimeVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  const existingRuntimePatch = await synthesizeMultiFilePatch(runtimeVerificationFixture, existingRuntimePlan);
  assert.deepEqual(
    existingRuntimePatch.filesList.map((file) => file.path).sort(),
    ['package.json', 'tests/catalog.test.js'],
  );
  assert.ok((await fs.stat(path.join(runtimeVerificationFixture, 'pages', 'catalog.js'))).isFile());
  const repeatedLegacyPlan = await deriveModularPlan(legacyUpgradeDir, { userRequest: legacyUpgradePrompt });
  const repeatedLegacyVerification = await runHermeticRegressionLoopWithRuntime(repeatedLegacyPlan, { root: legacyUpgradeDir });
  assert.equal(repeatedLegacyVerification.status, 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED');
  assert.equal(repeatedLegacyVerification.passed, 9);
  assert.equal(repeatedLegacyVerification.total, 9);
  const repeatedLegacyPatch = await synthesizeMultiFilePatch(legacyUpgradeDir, repeatedLegacyPlan);
  assert.ok(
    !repeatedLegacyPatch.filesList.some((file) => file.path === 'package.json'),
    'A repeated plan must not emit a package patch for terminal-newline-only differences.',
  );
  assert.ok(!(await fs.readdir(legacyUpgradeDir)).includes('node_modules'));
  const runtimeModeSessionId = 'session-runtime-test-mode-override';
  createSession(runtimeModeSessionId, ownerId);
  await developerFiles.attachProject(legacyUpgradeDir, ownerId);
  const runtimeModeOverride = await executeAutonomousCodingWorkflow({
    userRequest: 'test the project',
    root: legacyUpgradeDir,
    scope: '.',
    sessionId: runtimeModeSessionId,
    ownerWebContentsId: ownerId,
    continuationToken: 'stale-investigation-continuation',
    requestApproval: async () => {
      throw new Error('An up-to-date runtime-test request must not ask for write approval.');
    },
    tools: { operatingMode: 'INVESTIGATE' },
  });
  assert.equal(runtimeModeOverride.outcome, 'SUCCESS', JSON.stringify(runtimeModeOverride));
  assert.equal(runtimeModeOverride.hermeticVerification?.passed, 9);
  assert.equal(runtimeModeOverride.executionVerificationReceipt?.status, 'PASSED');
  assert.equal(runtimeModeOverride.codeApplied, false);
  console.log('[TEST 4I PASSED] Legacy populated workspaces self-heal stale backend/frontend modules, preserve .env.example, and pass nine on-disk gates on repeat.');

  const orderRuntimeFixture = path.join(testRoot, 'v17-order-runtime-upgrade');
  await fs.mkdir(orderRuntimeFixture, { recursive: true });
  const orderSeedRoot = path.join(testRoot, 'order-plan-source');
  await fs.mkdir(orderSeedRoot, { recursive: true });
  const orderSeedPlan = await deriveModularPlan(orderSeedRoot, {
    userRequest: `Build a complete full-stack order feature with a React form.
Create a POST endpoint /api/orders.
Fields:
- customerName: string (required)
- items: [{ itemName: string, quantity: number, price: number }]
- totalPrice: number (calculated)
- status: string (default=Pending)
- createdAt: string
Create an App Router page and form component with validation.`,
  });
  for (const module of orderSeedPlan.modulesToCreate) {
    if (module.responsibility === 'TEST_SUITE' || module.operation === 'rename') continue;
    const target = path.join(orderRuntimeFixture, ...module.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, module.content, 'utf8');
  }
  const orderManifest = {
    name: 'legacy-order-app',
    version: '1.0.0',
    type: 'commonjs',
    scripts: {
      start: 'node server.js',
      dev: 'node server.js',
      test: 'node --check server.js',
    },
  };
  const orderManifestContents = `${JSON.stringify(orderManifest, null, 2)}\n`;
  assert.ok(Buffer.byteLength(orderManifestContents) <= 278);
  await fs.writeFile(
    path.join(orderRuntimeFixture, 'package.json'),
    orderManifestContents.padEnd(278, ' '),
    'utf8',
  );
  await fs.rm(path.join(orderRuntimeFixture, 'tests'), { recursive: true, force: true });
  const orderModelPath = path.join(orderRuntimeFixture, 'models', 'Order.js');
  const staleOrderModel = await fs.readFile(orderModelPath, 'utf8');
  assert.match(staleOrderModel, /return records\.map\(\(record\) => \(\{ \.\.\.record \}\)\);/);
  await fs.writeFile(
    orderModelPath,
    staleOrderModel.replace('return records.map((record) => ({ ...record }));', 'return [];'),
    'utf8',
  );
  const diskInferredOrderPlan = await deriveExistingProjectTestPlan(orderRuntimeFixture);
  assert.ok(diskInferredOrderPlan?.isProjectRuntimeTest, 'A fresh test-only prompt must derive its plan from disk.');
  assert.equal(diskInferredOrderPlan.routeSchema.entity, 'Order');
  assert.equal(diskInferredOrderPlan.routeContracts[0].path, '/api/orders');
  assert.deepEqual(
    diskInferredOrderPlan.routeSchema.fields.map((field) => field.name),
    ['customerName', 'items', 'totalPrice', 'status', 'createdAt'],
  );
  assert.deepEqual(
    diskInferredOrderPlan.routeSchema.fields.find((field) => field.name === 'items').items.map((field) => field.name),
    ['itemName', 'quantity', 'price'],
  );
  const scalarOrderInferenceFixture = path.join(testRoot, 'scalar-order-with-nested-form');
  await fs.cp(orderRuntimeFixture, scalarOrderInferenceFixture, { recursive: true });
  const scalarOrderFields = diskInferredOrderPlan.routeSchema.fields.filter((field) => field.type !== 'array');
  const scalarOrderModel = `'use strict';\n\nconst fields = ${JSON.stringify(scalarOrderFields, null, 2)};\nconst records = [];\nlet nextId = 1;\nfunction validate(payload) {\n  const errors = [];\n  for (const field of fields) {\n    if (field.required && (payload[field.name] === undefined || payload[field.name] === null || payload[field.name] === '')) errors.push(field.name + ' is required.');\n  }\n  return { valid: errors.length === 0, errors };\n}\nfunction applyDefaults(payload) { return { ...payload }; }\nfunction create(payload) { const value = { ...applyDefaults(payload), id: String(nextId++) }; records.push(value); return { ...value }; }\nfunction list() { return records.map((record) => ({ ...record })); }\nmodule.exports = { fields, validate, applyDefaults, create, list };\n`;
  await fs.writeFile(path.join(scalarOrderInferenceFixture, 'models', 'Order.js'), scalarOrderModel, 'utf8');
  const inferredArrayOrderPlan = await deriveExistingProjectTestPlan(scalarOrderInferenceFixture);
  assert.ok(inferredArrayOrderPlan?.isProjectRuntimeTest);
  const inferredItemsField = inferredArrayOrderPlan.routeSchema.fields.find((field) => field.name === 'items');
  assert.equal(inferredItemsField?.type, 'array');
  assert.deepEqual(
    inferredItemsField.items.map((field) => [field.name, field.type]),
    [['itemName', 'string'], ['quantity', 'number'], ['price', 'number']],
  );
  const inferredArrayOrderVerification = await runHermeticRegressionLoopWithRuntime(
    inferredArrayOrderPlan,
    { root: scalarOrderInferenceFixture },
  );
  assert.equal(inferredArrayOrderVerification.passed, 9, JSON.stringify(inferredArrayOrderVerification));
  assert.equal(inferredArrayOrderVerification.runtimeVerification.behavioralApiProbes.length, 5);
  assert.ok(inferredArrayOrderVerification.runtimeVerification.behavioralApiProbes.every(
    (probe) => probe.applicable && probe.passed,
  ), JSON.stringify(inferredArrayOrderVerification.runtimeVerification.behavioralApiProbes));
  const upgradeProgress = [];
  const diskInferredOrderVerification = await runHermeticRegressionLoopWithRuntime(
    diskInferredOrderPlan,
    { root: orderRuntimeFixture, onProgress: (event) => upgradeProgress.push(event.message) },
  );
  assert.equal(diskInferredOrderVerification.status, 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED', JSON.stringify(diskInferredOrderVerification));
  assert.equal(diskInferredOrderVerification.passed, 9);
  const orderWorkspaceAudit = diskInferredOrderVerification.workspaceAudit;
  assert.equal(orderWorkspaceAudit.dependencies.nodeModulesPresent, false);
  assert.equal(orderWorkspaceAudit.environment.envExamplePresent, true);
  assert.equal(orderWorkspaceAudit.environment.envFilePresent, false);
  assert.match(orderWorkspaceAudit.findings.map((finding) => finding.message).join('\n'), /Missing node_modules directory/);
  assert.match(orderWorkspaceAudit.findings.map((finding) => finding.message).join('\n'), /Backend & Test Runtime .* WILL RUN WITHOUT node_modules/);
  assert.match(orderWorkspaceAudit.findings.map((finding) => finding.message).join('\n'), /standalone Next\.js\/React compilation is unavailable/);
  assert.match(orderWorkspaceAudit.findings.map((finding) => finding.message).join('\n'), /Missing \.env file/);
  assert.ok(upgradeProgress.some((message) => (
    message.includes('CANDIDATE_RUNTIME_BEHAVIOR @ models/Order.js')
      && message.includes('persisted-collection-list')
  )), 'The V17 fixture should reproduce the failing persisted-list Gate 9 probe before self-repair.');
  assert.ok(diskInferredOrderVerification.regressionLoop.repairs.some((repair) => repair.includes('models/Order.js')));
  const orderUpgradePatch = await synthesizeMultiFilePatch(orderRuntimeFixture, diskInferredOrderPlan);
  assert.ok(orderUpgradePatch.filesList.some((file) => file.path === 'models/Order.js' && file.operation === 'modify'));
  assert.ok(orderUpgradePatch.filesList.some((file) => file.path === 'package.json' && file.operation === 'modify'));
  assert.ok(orderUpgradePatch.filesList.some((file) => file.path === 'tests/order.test.js' && file.operation === 'create'));
  for (const module of diskInferredOrderPlan.modulesToCreate.filter((candidate) => (
    candidate.operation === 'create' || candidate.operation === 'modify'
  ))) {
    const target = path.join(orderRuntimeFixture, ...module.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, module.content, 'utf8');
  }
  const repeatedDiskInferredOrderPlan = await deriveExistingProjectTestPlan(orderRuntimeFixture);
  assert.ok(repeatedDiskInferredOrderPlan?.isProjectRuntimeTest);
  const repeatedDiskInferredOrderVerification = await runHermeticRegressionLoopWithRuntime(
    repeatedDiskInferredOrderPlan,
    { root: orderRuntimeFixture },
  );
  assert.equal(repeatedDiskInferredOrderVerification.passed, 9, JSON.stringify(repeatedDiskInferredOrderVerification));
  assert.ok(!repeatedDiskInferredOrderVerification.workspaceAudit.findings.some((finding) => /Stale inline UI contract/.test(finding.message)));
  assert.equal(repeatedDiskInferredOrderVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.equal(repeatedDiskInferredOrderVerification.runtimeVerification.behavioralTestSuite.status, 'EXECUTED & PASSED');
  assert.equal(repeatedDiskInferredOrderVerification.runtimeVerification.probes.filter((probe) => probe.passed).length, 6);
  const repeatedOrderPatch = await synthesizeMultiFilePatch(orderRuntimeFixture, repeatedDiskInferredOrderPlan);
  assert.deepEqual(repeatedOrderPatch.filesList, [], 'A second project-test run must verify live behavior without proposing changes.');

  const workspaceAuditHelloFixture = path.join(testRoot, 'workspace-audit-hello');
  await fs.cp(path.join(process.cwd(), 'scripts', 'fixtures', 'hello-runtime-workspace'), workspaceAuditHelloFixture, { recursive: true });
  const workspaceAuditHelloPlan = await deriveExistingProjectTestPlan(workspaceAuditHelloFixture);
  const workspaceAuditHelloVerification = await runHermeticRegressionLoopWithRuntime(
    workspaceAuditHelloPlan,
    { root: workspaceAuditHelloFixture },
  );
  assert.equal(workspaceAuditHelloVerification.passed, 9, JSON.stringify(workspaceAuditHelloVerification.gates.filter((gate) => !gate.passed)));
  assert.ok(workspaceAuditHelloVerification.workspaceAudit.bugs.some((bug) => (
    bug.path === 'server.js' && /embedded previewHtml/i.test(bug.description)
  )), JSON.stringify(workspaceAuditHelloVerification.workspaceAudit));
  assert.ok(workspaceAuditHelloVerification.workspaceAudit.syncPlan.some((item) => item.path === 'server.js' && item.action === 'REPAIR'));
  for (const expectedSyncPath of ['routes/orders.js', 'app/orders/page.jsx', 'config/db.js']) {
    assert.ok(workspaceAuditHelloVerification.workspaceAudit.syncPlan.some((item) => item.path === expectedSyncPath));
  }
  assert.ok(workspaceAuditHelloPlan.modulesToCreate.some((module) => module.path === 'server.js' && module.operation === 'modify'));

  const missingDependencyFixture = path.join(testRoot, 'workspace-audit-missing-dependency');
  await fs.cp(orderRuntimeFixture, missingDependencyFixture, { recursive: true });
  const missingDependencyManifestPath = path.join(missingDependencyFixture, 'package.json');
  const missingDependencyManifest = JSON.parse(await fs.readFile(missingDependencyManifestPath, 'utf8'));
  missingDependencyManifest.dependencies = { ...(missingDependencyManifest.dependencies || {}), express: '^4.19.2' };
  await fs.writeFile(missingDependencyManifestPath, JSON.stringify(missingDependencyManifest, null, 2), 'utf8');
  await fs.rm(path.join(missingDependencyFixture, 'node_modules'), { recursive: true, force: true });
  const missingDependencyPlan = await deriveExistingProjectTestPlan(missingDependencyFixture);
  const missingDependencyVerification = await runHermeticRegressionLoopWithRuntime(
    missingDependencyPlan,
    { root: missingDependencyFixture },
  );
  assert.ok(missingDependencyVerification.workspaceAudit.findings.some((finding) => (
    finding.message.includes('[WARN / ENV_ISSUE]')
      && finding.message.includes('express')
      && finding.message.includes('Missing node_modules directory')
  )), JSON.stringify(missingDependencyVerification.workspaceAudit));

  const orderTestPath = path.join(orderRuntimeFixture, 'tests', 'order.test.js');
  const generatedOrderTest = await fs.readFile(orderTestPath, 'utf8');
  assert.match(generatedOrderTest, /console\.log\('Loopback UI, API behavior, persistence, and controller error boundary passed\.'\);/);
  assert.doesNotMatch(generatedOrderTest, /\[REDACTED\]/);
  const redactedOrderTest = generatedOrderTest.replace(
    "console.log('Loopback UI, API behavior, persistence, and controller error boundary passed.');",
    'console.log([REDACTED] UI, API behavior, persistence, and controller error boundary.);',
  );
  assert.notEqual(redactedOrderTest, generatedOrderTest);
  await fs.writeFile(orderTestPath, redactedOrderTest, 'utf8');
  const corruptedOrderPlan = await deriveExistingProjectTestPlan(orderRuntimeFixture);
  const repairedOrderVerification = await runHermeticRegressionLoopWithRuntime(
    corruptedOrderPlan,
    { root: orderRuntimeFixture },
  );
  assert.equal(repairedOrderVerification.passed, 9, JSON.stringify(repairedOrderVerification));
  const repairedOrderPatch = await synthesizeMultiFilePatch(orderRuntimeFixture, corruptedOrderPlan);
  assert.ok(repairedOrderPatch.filesList.some((file) => file.path === 'tests/order.test.js' && file.operation === 'modify'));
  for (const module of corruptedOrderPlan.modulesToCreate.filter((candidate) => (
    candidate.operation === 'create' || candidate.operation === 'modify'
  ))) {
    const target = path.join(orderRuntimeFixture, ...module.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, module.content, 'utf8');
  }
  const repairedTestPlan = await deriveExistingProjectTestPlan(orderRuntimeFixture);
  const repairedTestVerification = await runHermeticRegressionLoopWithRuntime(
    repairedTestPlan,
    { root: orderRuntimeFixture },
  );
  assert.equal(repairedTestVerification.passed, 9, JSON.stringify(repairedTestVerification));
  const repairedTestNoOp = await synthesizeMultiFilePatch(orderRuntimeFixture, repairedTestPlan);
  assert.deepEqual(repairedTestNoOp.filesList, [], 'A repaired test suite must pass the next zero-operation runtime verification.');
  console.log('[TEST 4J PASSED] Fresh test-only plans infer Order from disk, self-heal the failed list probe, and pass a no-op repeat with live loopback verification.');

  const staleRootServerDir = path.join(testRoot, 'stale-root-server');
  await fs.mkdir(staleRootServerDir, { recursive: true });
  const staleRootFiles = {
    ...legacyWorkspaceFiles,
    'package.json': JSON.stringify({
      name: 'stale-root-server',
      type: 'commonjs',
      scripts: { start: 'node generated/catalog/server.js', dev: 'node generated/catalog/server.js' },
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    }, null, 2),
  };
  for (const [relativePath, contents] of Object.entries(staleRootFiles)) {
    const target = path.join(staleRootServerDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  const staleRootPlan = await deriveModularPlan(staleRootServerDir, { userRequest: legacyUpgradePrompt });
  assert.equal(staleRootPlan.workspaceResolution, 'UPDATE_AND_INTEGRATE');
  assert.equal(staleRootPlan.workspaceDoctor?.rootServerOutdated, true);
  assert.ok(staleRootPlan.modulesToCreate.some((module) => module.path === 'server.js' && module.operation === 'modify'));
  assert.ok(staleRootPlan.modulesToCreate.some((module) => module.path === 'package.json' && module.operation === 'modify'));

  const splitBrainDir = path.join(testRoot, 'split-brain-workspace');
  await fs.mkdir(splitBrainDir, { recursive: true });
  const splitBrainFiles = {
    ...legacyWorkspaceFiles,
    'package.json': JSON.stringify({
      name: 'split-brain-workspace',
      type: 'commonjs',
      scripts: { start: 'node generated/catalog/server.js', dev: 'node generated/catalog/server.js' },
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    }, null, 2),
  };
  for (const [relativePath, contents] of Object.entries(splitBrainFiles)) {
    const target = path.join(splitBrainDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  await fs.mkdir(path.join(splitBrainDir, 'generated', 'catalog'), { recursive: true });
  await fs.writeFile(path.join(splitBrainDir, 'generated', 'catalog', 'server.js'), 'module.exports = {};\n', 'utf8');
  await fs.mkdir(path.join(splitBrainDir, 'pages'), { recursive: true });
  const splitBrainPrompt = `Build a complete full-stack catalog feature with a React form.
Create a POST endpoint /api/catalog.
Fields:
- title: string (required)
- items: [{ label: string, quantity: number, price: number }]
- total: number (calculated)
- status: string (default=Pending)
Create a page and form with validation and status messages.`;
  const splitBrainPlan = await deriveModularPlan(splitBrainDir, { userRequest: splitBrainPrompt });
  assert.equal(splitBrainPlan.workspaceResolution, 'UPDATE_AND_INTEGRATE');
  assert.equal(splitBrainPlan.workspaceDoctor?.staleGeneratedShadowDetected, true);
  for (const targetPath of [
    'config/db.js', 'models/Catalog.js', 'controllers/catalogController.js',
    'routes/catalog.js', 'server.js', 'components/CatalogForm.jsx',
    'app/catalog/page.jsx', 'package.json',
  ]) {
    assert.ok(splitBrainPlan.modulesToCreate.some((module) => module.path === targetPath && module.operation === 'modify'),
      `Split-brain plan must repair canonical root target ${targetPath}.`);
  }
  const splitBrainPackage = JSON.parse(splitBrainPlan.modulesToCreate.find((module) => module.path === 'package.json').content);
  assert.equal(splitBrainPackage.scripts.start, 'node server.js');
  const splitBrainDiskCheck = await verifyHermeticEngineeringGatesOnDisk(splitBrainDir, splitBrainPlan);
  assert.ok(splitBrainDiskCheck.passed < splitBrainDiskCheck.total,
    'The disk-first audit must reject the stale root entrypoint before a repair is applied.');
  assert.ok(splitBrainDiskCheck.gates.some((gate) => gate.id === 'SYNTAX_AND_AST' && !gate.passed),
    'Disk verification must reject the missing generated behavioral suite before claiming success.');
  const splitBrainSessionId = 'session-v17-split-brain';
  createSession(splitBrainSessionId, ownerId);
  let splitBrainProposalCount = 0;
  const splitBrainResult = await executeAutonomousCodingWorkflow({
    userRequest: splitBrainPrompt,
    root: splitBrainDir,
    scope: '.',
    sessionId: splitBrainSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async () => {
      splitBrainProposalCount += 1;
      return true;
    },
  });
  assert.equal(splitBrainResult.outcome, 'SUCCESS', JSON.stringify(splitBrainResult));
  assert.equal(splitBrainResult.codeApplied, true);
  assert.equal(splitBrainResult.codeVerified, true);
  assert.equal(splitBrainProposalCount, 1, 'The damaged root layout must produce an approved modification proposal.');
  assert.equal(splitBrainResult.hermeticVerification?.passed, 9, JSON.stringify(splitBrainResult.hermeticVerification));
  assert.equal(splitBrainResult.hermeticVerification?.total, 9);
  assert.equal(splitBrainResult.executionVerificationReceipt?.gateCount, 9);
  assert.match(splitBrainResult.message, /verified across 9\/9 hermetic gates/);
  assert.match(splitBrainResult.message, /POST \/api\/catalog -> 201 Created — PASS/);
  assert.match(splitBrainResult.message, /GET \/api\/catalog -> 200 OK — PASS/);
  assert.match(splitBrainResult.message, /GET \/catalog interactive form -> 200 — PASS/);
  assert.match(splitBrainResult.message, /npm start.*http:\/\/localhost:5000\/catalog/);
  assert.equal(splitBrainResult.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.ok(splitBrainResult.hermeticVerification.runtimeVerification.behavioralApiProbes
    .every((probe) => probe.passed && probe.applicable));
  assert.ok(splitBrainResult.hermeticVerification.runtimeVerification.uiPreview.paths
    .every((probe) => probe.passed && probe.applicable));
  assert.ok(splitBrainResult.filesModified.includes('server.js'));
  assert.ok(splitBrainResult.filesModified.includes('package.json'));
  assert.equal(JSON.parse(await fs.readFile(path.join(splitBrainDir, 'package.json'), 'utf8')).scripts.start, 'node server.js');
  assert.match(await fs.readFile(path.join(splitBrainDir, 'README.md'), 'utf8'), /npm start/);
  assert.match(await fs.readFile(path.join(splitBrainDir, 'README.md'), 'utf8'), /no `npm install` or `node_modules` directory is needed/i);
  assert.ok(!(await fs.readdir(splitBrainDir)).includes('node_modules'));
  console.log('[TEST 4J PASSED] Split-brain generated/root workspaces default to approved canonical healing and pass all nine gates.');

  const emptyEnvironmentDir = path.join(testRoot, 'empty-existing-environment');
  await fs.mkdir(emptyEnvironmentDir, { recursive: true });
  await fs.writeFile(path.join(emptyEnvironmentDir, '.env.example'), '');
  const emptyEnvironmentPlan = await deriveModularPlan(emptyEnvironmentDir, { userRequest: legacyUpgradePrompt });
  assert.equal(emptyEnvironmentPlan.modulesToCreate.find((module) => module.path === '.env.example').operation, 'reuse');
  assert.equal(runHermeticRegressionLoop(emptyEnvironmentPlan, { root: emptyEnvironmentDir }).passed, 8);
  assert.ok(!(await synthesizeMultiFilePatch(emptyEnvironmentDir, emptyEnvironmentPlan)).filesList.some((file) => file.path === '.env.example'));

  const routeConflictDir = path.join(testRoot, 'next-route-conflict');
  await fs.mkdir(path.join(routeConflictDir, 'pages'), { recursive: true });
  await fs.writeFile(path.join(routeConflictDir, 'pages', 'catalog.jsx'), 'export default function LegacyCatalogPage() { return null; }\n');
  const routeConflictPlan = await deriveModularPlan(routeConflictDir, {
    userRequest: `Build a full-stack catalog feature for the Next.js App Router with an API form.
Create a POST endpoint /api/catalog.
Fields:
- title: string (required)
Create a page and form component.`,
  });
  assert.equal(routeConflictPlan.routeContracts[0].pageFile, 'app/catalog/page.jsx');
  assert.deepEqual(routeConflictPlan.routeContracts[0].nextRouteConflicts, []);
  assert.deepEqual(routeConflictPlan.routeContracts[0].legacyRouteMigrations, [{
    sourcePath: 'pages/catalog.jsx',
    targetPath: 'legacy-pages-catalog.jsx.txt',
  }]);
  const routeConflictVerification = runHermeticRegressionLoop(routeConflictPlan, { root: routeConflictDir });
  const routeConflictGate = routeConflictVerification.gates.find((gate) => gate.id === 'CROSS_LAYER_DATA_FLOW');
  assert.equal(routeConflictGate.passed, true);
  assert.equal(routeConflictVerification.passed, 8);
  assert.equal(routeConflictPlan.modulesToCreate.find((module) => module.sourcePath === 'pages/catalog.jsx')?.operation, 'rename');

  const substantivePlan = await deriveModularPlan(populatedCreationDir, {
    userRequest: `Build a full-stack subscription feature with a form and backend API.
Create a POST endpoint /api/subscriptions.
Fields:
- customerName: string (required)
- items: [{ sku: string, quantity: number }]
Create a page component.`,
  });
  assert.match(substantivePlan.blockedReason, /existing substantive modules/i);
  assert.deepEqual(substantivePlan.modulesToCreate, []);
  assert.ok(
    substantivePlan.workspaceInspection.targets.some((target) => target.classification === 'SUBSTANTIVE'),
    'The plan must expose why existing workspace files were not replaced.',
  );
  const keepExistingPlan = await deriveModularPlan(populatedCreationDir, {
    userRequest: `Build a full-stack subscription feature with a form and backend API.
Create a POST endpoint /api/subscriptions.
Fields:
- customerName: string (required)
Create a page component.
Workspace resolution: KEEP_AND_SCAFFOLD`,
  });
  assert.ok(
    keepExistingPlan.modulesToCreate.some((module) => module.path.startsWith('generated/subscription/')),
    'Keep-and-scaffold resolution must place replacement modules in an isolated generated directory.',
  );
  assert.equal(
    keepExistingPlan.modulesToCreate.some((module) => module.path === 'index.js'),
    false,
    'Keep-and-scaffold resolution must not target the substantive existing entrypoint.',
  );
  assert.equal(runHermeticRegressionLoop(keepExistingPlan, { root: populatedCreationDir }).passed, 8);

  const resolutionFixture = path.join(testRoot, 'resolution-fixture');
  const legacyFullStackFiles = {
    'config/db.js': "const mongoose = require('mongoose');\nmodule.exports = mongoose;\n",
    'models/Order.js': "const mongoose = require('mongoose');\nmodule.exports = new mongoose.Schema({});\n",
    'controllers/orderController.js': "const { missingModel } = require('../models/Order');\nmodule.exports = { missingModel };\n",
    'routes/orders.js': "const { missingHandler } = require('../controllers/orderController');\nmodule.exports = missingHandler;\n",
    'server.js': "const express = require('express');\nmodule.exports = express();\n",
    'components/OrderForm.jsx': "import React, { useState } from 'react';\nexport default function OrderForm() { return null; }\n",
    'app/orders/page.jsx': "import { MissingOrderForm } from '../../components/OrderForm.jsx';\nexport default function OrderPage() { return <MissingOrderForm />; }\n",
    'pages/orders.js': 'export default function LegacyOrderPage() { return null; }\n',
    'pages/about.jsx': 'export default function AboutPage() { return null; }\n',
    'package.json': JSON.stringify({
      name: 'legacy-order-workspace',
      type: 'commonjs',
      dependencies: { express: '^4.0.0', mongoose: '^8.0.0', react: '^18.0.0', 'react-dom': '^18.0.0' },
    }, null, 2),
    '.env.example': 'PORT=4300\n',
    'README.md': '# Existing order workspace\n',
  };
  for (const [relativePath, content] of Object.entries(legacyFullStackFiles)) {
    const target = path.join(resolutionFixture, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  const resolutionPrompt = `Build a complete full-stack order feature with a form and backend API.
Create a POST endpoint /api/orders.
Fields:
- customerName: string (required)
- items: [{ itemName: string, quantity: number, price: number }]
- totalPrice: number (auto calculated)
- status: string (default=Pending)
Create a Next.js App Router page and React form component.`;
  for (const resolution of [null, 'UPDATE_AND_INTEGRATE', 'REPLACE_TARGETS', 'KEEP_AND_SCAFFOLD']) {
    const plan = await deriveModularPlan(resolutionFixture, {
      userRequest: `${resolutionPrompt}${resolution ? `\nWorkspace resolution: ${resolution}` : ''}`,
    });
    assert.equal(plan.blockedReason, undefined, `${resolution || 'autonomous'} resolution must not stop for clarification.`);
    const verification = await runHermeticRegressionLoopWithRuntime(plan, { root: resolutionFixture });
    assert.equal(verification.passed, 9, `${resolution || 'autonomous'} resolution should pass all gates: ${JSON.stringify(verification.gates.filter((gate) => !gate.passed))}`);
    assert.equal(verification.total, 9);
    assert.deepEqual(plan.routeContracts[0].nextRouteConflicts, []);
    assert.ok(plan.modulesToCreate.some((module) => (
      module.operation === 'rename' && module.sourcePath === 'pages/orders.js'
    )), 'A colliding legacy Pages Router file must be preserved outside the active router.');
    const patch = await synthesizeMultiFilePatch(resolutionFixture, plan);
    assert.ok(patch.filesList.some((file) => (
      file.operation === 'rename' && file.sourcePath === 'pages/orders.js'
    )), 'The route migration must remain a snapshot-bound proposal operation.');
    if (resolution === 'KEEP_AND_SCAFFOLD') {
      const server = plan.modulesToCreate.find((module) => module.path === 'generated/order/server.js');
      assert.match(server.content, /require\("\.\/config\/environment\.js"\)/);
      assert.ok(plan.modulesToCreate.some((module) => module.path === 'generated/order/models/Order.js'));
      assert.ok(plan.modulesToCreate.some((module) => module.path === 'generated/order/app/orders/page.jsx'));
    } else if (resolution) {
      for (const target of [
        'config/db.js',
        'models/Order.js',
        'controllers/orderController.js',
        'routes/orders.js',
        'server.js',
        'components/OrderForm.jsx',
        'app/orders/page.jsx',
      ]) {
        assert.ok(plan.modulesToCreate.some((module) => module.path === target && module.operation === 'modify'));
      }
    } else {
      assert.ok(plan.modulesToCreate.some((module) => module.path === 'server.js' && module.operation === 'modify'));
    }
  }
  const staleDirectivePlan = await deriveModularPlan(resolutionFixture, {
    userRequest: resolutionPrompt,
    requirements: ['Workspace resolution: KEEP_AND_SCAFFOLD'],
  });
  assert.ok(
    staleDirectivePlan.modulesToCreate.some((module) => module.path === 'server.js'),
    'A resolution directive in extracted/historical requirements must not override the current user request.',
  );
  const resolutionSessionId = 'session-v15-resolution-autonomous';
  createSession(resolutionSessionId, ownerId);
  await developerFiles.attachProject(resolutionFixture, ownerId);
  const autonomousUpgrade = await executeAutonomousCodingWorkflow({
    userRequest: resolutionPrompt,
    root: resolutionFixture,
    scope: '.',
    sessionId: resolutionSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async () => true,
    tools: { deriveModularPlan: true },
  });
  assert.equal(autonomousUpgrade.outcome, 'SUCCESS', JSON.stringify(autonomousUpgrade));
  assert.equal(autonomousUpgrade.codeApplied, true);
  assert.equal(autonomousUpgrade.hermeticVerification?.passed, 9);
  assert.equal(autonomousUpgrade.hermeticVerification?.total, 9);
  await assert.rejects(fs.stat(path.join(resolutionFixture, 'pages', 'orders.js')), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(resolutionFixture, 'legacy-pages-orders.js.txt'))).isFile());
  console.log('[TEST 4C PASSED] Populated full-stack workspaces auto-upgrade, preserve all resolution modes, and migrate only conflicting legacy routes.');

  // =========================================================================
  // TEST 5: Missing or Failed File Write Prevents False Success Report
  // =========================================================================
  const missingPlan = {
    isGreenfield: false,
    modulesToCreate: [{ path: 'services/ghostService.js', responsibility: 'CORE_BUSINESS_LOGIC', content: 'module.exports = {};' }],
    integrationPoints: [{ targetFile: 'index.js', integrationSnippet: 'require("./services/ghostService");' }],
    planRecord: [],
  };
  // Do NOT write the ghostService to disk; simulate verification
  const reachabilityFailure = await verifyIntegrationReachability(existingDir, missingPlan);
  assert.equal(reachabilityFailure.isValid, false, 'Missing module file must fail reachability check');
  assert.match(reachabilityFailure.rejectionReason, /ghostService\.js/);
  console.log('[TEST 5 PASSED] Missing or failed file write prevents false success report.');

  const syntaxDir = path.join(testRoot, 'syntax-verification');
  await fs.mkdir(syntaxDir, { recursive: true });
  await fs.writeFile(path.join(syntaxDir, 'valid.js'), 'module.exports = { ready: true };\n', 'utf8');
  await fs.writeFile(path.join(syntaxDir, 'valid.jsx'), 'export default function View() { return <main />; }\n', 'utf8');
  const validSyntax = await verifyIntegrationReachability(syntaxDir, {
    modulesToCreate: [{ path: 'valid.js' }, { path: 'valid.jsx' }],
    integrationPoints: [],
  });
  assert.equal(validSyntax.isValid, true);
  assert.deepEqual(
    validSyntax.syntaxChecks.map((check) => check.status),
    ['SYNTAX_VERIFIED', 'SYNTAX_VERIFIED'],
  );
  await fs.writeFile(path.join(syntaxDir, 'invalid.js'), 'function broken( {\n', 'utf8');
  const invalidSyntax = await verifyIntegrationReachability(syntaxDir, {
    modulesToCreate: [{ path: 'invalid.js' }],
    integrationPoints: [],
  });
  assert.equal(invalidSyntax.isValid, false);
  assert.equal(invalidSyntax.syntaxChecks[0].status, 'SYNTAX_INVALID');
  console.log('[TEST 5A PASSED] Static syntax checks validate JavaScript and JSX without executing source.');

  // =========================================================================
  // TEST 6: Existing Files and Unrelated User Changes Are Preserved
  // =========================================================================
  assert.ok(indexContentAfter.includes('const existingApp = true;'), 'Existing original logic in index.js must be preserved');
  const pkgContent = await fs.readFile(path.join(existingDir, 'package.json'), 'utf8');
  assert.ok(pkgContent.includes('existing-app'), 'Existing package.json must remain 100% untouched');
  console.log('[TEST 6 PASSED] Existing files and unrelated user changes are preserved.');

  // =========================================================================
  // TEST 7: Path Validation and Approval Requirements Remain Enforced
  // =========================================================================
  assert.throws(
    () => validateSafePath(existingDir, '../../outside.js'),
    /escapes the project root/,
    'Path escaping root must be rejected'
  );
  assert.throws(
    () => validateSafePath(existingDir, '/absolute/path.js'),
    /escapes the project root/,
    'Absolute paths must be rejected'
  );

  // Approval rejection prevents writing
  const declinedSessionId = 'session-v10-declined';
  createSession(declinedSessionId, ownerId);
  const declinedResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Implement unauthorized feature',
    root: existingDir,
    scope: '.',
    sessionId: declinedSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async () => false, // USER REJECTS
    tools: {
      modularPlan: {
        isGreenfield: false,
        modulesToCreate: [{ path: 'services/unauthorizedService.js', responsibility: 'CORE', content: 'bad' }],
        integrationPoints: [],
        planRecord: [],
      },
    },
  });
  assert.equal(declinedResult.outcome, 'APPROVAL_REJECTED');
  assert.equal(declinedResult.codeApplied, false);
  const unauthorizedExists = await fs.stat(path.join(existingDir, 'services/unauthorizedService.js')).then(() => true).catch(() => false);
  assert.equal(unauthorizedExists, false, '0 bytes must be written when approval is declined');
  console.log('[TEST 7 PASSED] Path validation and approval requirements remain enforced.');

  // =========================================================================
  // TEST 8: Existing Single-File Tasks Continue to Work
  // =========================================================================
  const singleFileRel = 'services/SingleFileFix.js';
  await fs.writeFile(path.join(existingDir, singleFileRel), 'function debugMe() {\n  debugger;\n  return true;\n}\n', 'utf8');

  const singleFileSessionId = 'session-v10-single-file';
  createSession(singleFileSessionId, ownerId);
  const singleFileResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix the debugger statement in SingleFileFix.js',
    root: existingDir,
    scope: '.',
    sessionId: singleFileSessionId,
    ownerWebContentsId: ownerId,
    assessFindingRelevance: async ({ findings }) => ({
      findings: findings.map((f) => ({
        findingId: f.findingId,
        decision: 'SUPPORTED',
        relationship: 'The single file fix directly links the cited debugger statement to the requested outcome.',
        evidenceIds: [f.sourceEvidenceId],
        contradictionEvidenceIds: [],
        unresolvedAssumptions: [],
        provenance: 'TEST_FIXTURE',
      })),
    }),
    requestApproval: async () => true,
    runCheck: async (script) => ({ ok: true, executed: true, exitCode: 0, check: script || 'test' }),
    tools: {
      searchCode: async () => ({
        results: [{ path: singleFileRel, score: 95, line: 2 }],
      }),
      readFile: async () => ({ content: 'function debugMe() {\n  debugger;\n  return true;\n}\n' }),
    },
  });
  assert.ok(['SUCCESS', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(singleFileResult.outcome));
  assert.equal(singleFileResult.codeApplied, true);
  const singleFileContent = await fs.readFile(path.join(existingDir, singleFileRel), 'utf8');
  assert.ok(!singleFileContent.includes('debugger;'), 'Single file bug fix must still work seamlessly');
  console.log('[TEST 8 PASSED] Existing single-file tasks continue to work without regression.');

  // =========================================================================
  // TEST 9: Created Modules Can Be Imported, Resolved, and Reached
  // =========================================================================
  // Test requiring the greenfield entrypoint and calculation service
  await fs.writeFile(path.join(greenfieldDir, 'package.json'), JSON.stringify({ name: 'greenfield-app', type: 'commonjs' }), 'utf8');
  const { createRequire } = await import('node:module');
  const requireGreenfield = createRequire(path.join(greenfieldDir, 'index.js'));
  const greenfieldEntry = requireGreenfield('./index.js');
  assert.equal(typeof greenfieldEntry.run, 'function', 'Greenfield entrypoint run() must be a functional export');
  const calcOutput = greenfieldEntry.run();
  assert.equal(calcOutput, 100, 'Greenfield calculation service must be reachable and return expected result (50 * 2 = 100)');
  console.log('[TEST 9 PASSED] Created modules can be imported, resolved, and reached through execution path.');

  // =========================================================================
  // TEST 10: Tests Detect Incomplete Integration, Not Just File Existence
  // =========================================================================
  const orphanModulePath = path.join(existingDir, 'services', 'orphanService.js');
  await fs.writeFile(orphanModulePath, 'function orphanLogic() { return 123; }\nmodule.exports = { orphanLogic };\n', 'utf8');

  // Plan says orphanService should be integrated into index.js with specific snippet, but index.js does not have it!
  const incompleteIntegrationPlan = {
    isGreenfield: false,
    modulesToCreate: [{ path: 'services/orphanService.js', responsibility: 'CORE_BUSINESS_LOGIC', content: 'x' }],
    integrationPoints: [{
      targetFile: 'index.js',
      integrationSnippet: 'const { orphanLogic } = require("./services/orphanService");',
    }],
    planRecord: [],
  };

  const incompleteCheck = await verifyIntegrationReachability(existingDir, incompleteIntegrationPlan);
  assert.equal(incompleteCheck.isValid, false, 'Must detect incomplete integration even when the file exists on disk');
  assert.match(incompleteCheck.rejectionReason, /Incomplete integration/i);
  assert.ok(incompleteCheck.incompleteIntegrations.length > 0);
  console.log('[TEST 10 PASSED] Tests detect incomplete integration, not just file existence.');

  console.log('--- ALL 10 SECTION 4.F MODULAR ARCHITECTURE & REUSABILITY TESTS PASSED SUCCESSFULLY! ---');
} finally {
  developerFiles.releaseProject(ownerId);
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
