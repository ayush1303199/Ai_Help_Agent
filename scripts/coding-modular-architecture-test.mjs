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
  deriveModularPlan,
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
  assert.equal(populatedCreationResult.outcome, 'SUCCESS');
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
  assert.equal(runtimeCandidate.gates.at(-1).probes.length, 5);
  assert.ok(runtimeCandidate.gates.at(-1).probes.every((probe) => probe.applicable && probe.passed));
  assert.equal(runtimeCandidate.gates.at(-1).uiPreview.passed, true);
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
      scripts: { start: 'node old-server.js', dev: 'node old-server.js', test: 'echo legacy' },
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
    .filter((module) => module.path !== '.env.example')
    .every((module) => module.operation === 'modify'),
  'Each existing full-stack target must be staged as a modification.');
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
    await fs.writeFile(target, module.content, 'utf8');
  }
  assert.equal(await fs.readFile(path.join(legacyUpgradeDir, '.env.example'), 'utf8'), retainedLegacyEnvironment);
  const legacyDiskVerification = await verifyHermeticEngineeringGatesOnDisk(legacyUpgradeDir, legacyUpgradePlan);
  assert.equal(legacyDiskVerification.status, 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED', JSON.stringify(legacyDiskVerification));
  assert.equal(legacyDiskVerification.passed, 9, JSON.stringify(legacyDiskVerification));
  assert.equal(legacyDiskVerification.total, 9);
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
  console.log('[TEST 4I PASSED] Legacy populated workspaces self-heal stale backend/frontend modules, preserve .env.example, and pass nine on-disk gates on repeat.');
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
