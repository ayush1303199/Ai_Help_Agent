import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import { buildRepositoryMap } from '../electron/developerIndex.cjs';
import { detectProject } from '../electron/coding-pipeline/detect/projectDetector.cjs';
import { maskNonCodeSource, extractEnclosingFunctionBlock, generateSymbolVariants } from '../electron/coding-pipeline/investigationWorkflowContract.cjs';
import { routeTaskMode, OPERATING_MODES } from '../electron/coding-pipeline/modes.cjs';

const {
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_LIKELY,
  CLASSIFICATION_UNVERIFIED,
  CLASSIFICATION_NOT_A_BUG,
  VALID_SUBTASK_STATUSES,
  VALID_HYPOTHESIS_STATUSES,
  LEGAL_SUBTASK_TRANSITIONS,
  LEGAL_HYPOTHESIS_TRANSITIONS,
  classifyDefect,
  traceExecutionFlow,
  validateEvidenceReport,
  validatePatchScope,
  validateProposalContract,
  enforceApprovalGate,
  validateApplyScope,
  extractFailureDiagnostics,
  analyzeTaskRequirements,
  planProgressiveSearch,
  discoverProjectArchitecture,
  executeToolWithSafeguards,
  manageRepairLoop,
  selectVerificationChecks,
  createTaskPlan,
  advanceTaskPlan,
  detectSourceLanguage,
  executeAutonomousCodingWorkflow,
  beginConversationTurn,
  createProposal,
  apply,
  createSession,
  buildWorkflowReceipt,
  validateWorkflowReceipt,
} = developerAgent;

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-investigation-test-'));
const ownerId = 72001;
const mockSupportedRelevance = async ({ findings }) => ({
  findings: findings.map((finding) => ({
    findingId: finding.findingId,
    decision: 'SUPPORTED',
    relationship: 'The mocked fixture directly links the cited source behavior to the requested outcome.',
    evidenceIds: [finding.sourceEvidenceId],
    contradictionEvidenceIds: [],
    unresolvedAssumptions: [],
    provenance: 'TEST_FIXTURE',
  })),
});

try {
  const creationPrompt = (opening) => `${opening} as an expert Full-Stack Developer. Build a complete 'Add Order' feature.
Create an Order Model/Schema with customer name and item details.
Create a POST endpoint /api/orders with input validation.
Include basic input validation and proper error handling (try-catch, status codes like 201, 400, 500).
Create a page/component and display success or error toast/messages accordingly.`;
  for (const prompt of [
    creationPrompt('Act'),
    creationPrompt('ct'),
  ]) {
    const creationRequirements = analyzeTaskRequirements(prompt);
    assert.equal(
      creationRequirements.isModular,
      true,
      'Explicit feature/model/endpoint creation must outrank defensive error-handling requirements.',
    );
    assert.equal(
      routeTaskMode({ goal: prompt }).mode,
      OPERATING_MODES.AUTONOMOUS,
      'Creation directives inside a role-prefaced request must stay actionable despite error-handling terms.',
    );
  }
  assert.equal(
    analyzeTaskRequirements('Why does the endpoint fail with an error? Find the root cause without changing files.').isModular,
    false,
    'Actual read-only root-cause inquiries must remain on the investigation path.',
  );
  assert.equal(
    routeTaskMode({ goal: 'Why does the endpoint fail with an error? Find the root cause without changing files.' }).mode,
    OPERATING_MODES.ASK,
    'Root-cause questions must remain non-actionable rather than being promoted to creation.',
  );
  assert.equal(
    routeTaskMode({
      goal: 'Build a complete feature with a model and endpoint, including error handling.',
      userRequestedMode: 'INVESTIGATE',
    }).mode,
    OPERATING_MODES.AUTONOMOUS,
    'Explicit creation must not be diverted into a read-only investigation mode.',
  );
  assert.equal(
    routeTaskMode({
      goal: 'Build a complete feature with a model and endpoint, without making code changes.',
      userRequestedMode: 'BUILD',
    }).mode,
    OPERATING_MODES.BUILD,
    'An explicit no-change constraint must preserve the requested non-applying mode.',
  );
  assert.equal(
    routeTaskMode({
      goal: 'Build a complete feature with a model and endpoint.',
      userRequestedMode: 'AUDIT',
    }).mode,
    OPERATING_MODES.AUDIT,
    'AUDIT remains read-only even when the goal contains a creation directive.',
  );
  assert.equal(
    analyzeTaskRequirements('Implement:\n- Persist settings.\n- Add API.\n- Add tests.').isModular,
    false,
    'A composite implementation handoff must not be collapsed into generic modular synthesis.',
  );

  // Set up mock heterogeneous project fixtures
  const projectModular = path.join(testRoot, 'modular-app');
  const projectPython = path.join(testRoot, 'py-app');
  const projectNode = path.join(testRoot, 'node-app');
  const projectUnknown = path.join(testRoot, 'unknown-app');

  // Modular project fixture (e.g. modular MVC)
  await fs.mkdir(path.join(projectModular, 'modules', 'personal', 'controllers'), { recursive: true });
  await fs.mkdir(path.join(projectModular, 'modules', 'personal', 'models'), { recursive: true });
  await fs.mkdir(path.join(projectModular, 'modules', 'academic', 'controllers'), { recursive: true });
  await fs.mkdir(path.join(projectModular, 'config'), { recursive: true });

  await fs.writeFile(
    path.join(projectModular, 'composer.json'),
    JSON.stringify({ name: 'test/modular-app', type: 'project' }),
    'utf8'
  );
  await fs.writeFile(
    path.join(projectModular, 'yii'),
    '#!/usr/bin/env php\n<?php exit(0);',
    'utf8'
  );
  await fs.writeFile(
    path.join(projectModular, 'modules', 'personal', 'controllers', 'FormController.php'),
    `<?php
namespace app\\modules\\personal\\controllers;
use yii\\web\\Controller;
use app\\modules\\personal\\models\\CandidatePersonalDetails;

class FormController extends Controller {
    public function actionUpdate($id) {
        $model = CandidatePersonalDetails::findOne($id);
        $transaction = \\Yii::$app->db->beginTransaction();
        try {
            if ($model->load(\\Yii::$app->request->post()) && $model->validate()) {
                $model->save(false);
                $transaction->commit();
                return $this->redirect(['view', 'id' => $model->id]);
            }
        } catch (\\Exception $e) {
            // BUG: missing transaction rollback before return/exit
            return $this->asJson(['error' => $e->getMessage()]);
        }
        return $this->render('update', ['model' => $model]);
    }

    public function actionDebugProbe($id) {
        // BUG: production debug die left behind
        var_dump($_POST);
        die("DEBUG_PROBE_EXIT");
    }
}
`,
    'utf8'
  );
  await fs.writeFile(
    path.join(projectModular, 'modules', 'personal', 'models', 'CandidatePersonalDetails.php'),
    `<?php
namespace app\\modules\\personal\\models;
use yii\\db\\ActiveRecord;

class CandidatePersonalDetails extends ActiveRecord {
    public static function tableName() { return 'candidate_personal_details'; }
    public function rules() {
        return [
            [['first_name', 'email'], 'required'],
            ['email', 'email'],
        ];
    }
}
`,
    'utf8'
  );
  await fs.writeFile(
    path.join(projectModular, 'modules', 'academic', 'controllers', 'UpdateAcademicController.php'),
    `<?php
namespace app\\modules\\academic\\controllers;
use yii\\web\\Controller;
class UpdateAcademicController extends Controller {}
`,
    'utf8'
  );

  // Python project fixture
  await fs.mkdir(path.join(projectPython, 'routes'), { recursive: true });
  await fs.mkdir(path.join(projectPython, 'services'), { recursive: true });
  await fs.writeFile(path.join(projectPython, 'manage.py'), '#!/usr/bin/env python\n', 'utf8');
  await fs.writeFile(
    path.join(projectPython, 'services', 'UserRegistrationService.py'),
    `class UserRegistrationService:
    def register(self, email):
        return True
`,
    'utf8'
  );

  // Node project fixture
  await fs.mkdir(path.join(projectNode, 'src', 'controllers'), { recursive: true });
  await fs.writeFile(
    path.join(projectNode, 'package.json'),
    JSON.stringify({ name: 'node-app', scripts: { test: 'vitest run' } }),
    'utf8'
  );
  await fs.writeFile(
    path.join(projectNode, 'src', 'controllers', 'AuthHandler.ts'),
    `export class AuthHandler {
    handleLogin() { return true; }
}
`,
    'utf8'
  );

  // Unknown / Custom project fixture (flat directory, no package manager)
  await fs.mkdir(path.join(projectUnknown, 'misc'), { recursive: true });
  await fs.writeFile(
    path.join(projectUnknown, 'misc', 'custom_worker.sh'),
    '#!/bin/bash\necho "custom worker"',
    'utf8'
  );

  // Set project discovery root to testRoot
  const originalRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  // SCENARIO 1: Absent expected filename (`PersonalController`), but feature discovered through modular path
  const discoveryResult = await developerFiles.discoverProjectByName('modular-app', ownerId);
  assert.equal(discoveryResult.projectRoot, await fs.realpath(projectModular));

  const searchPersonalController = await developerFiles.searchCode('PersonalController', ownerId);
  assert.ok(searchPersonalController.results.length > 0, 'Must find modular controllers when searching PersonalController');
  const matchedPaths = searchPersonalController.results.map((r) => r.path.replace(/\\/g, '/'));
  assert.ok(
    matchedPaths.some((p) => p.includes('modules/personal/controllers/FormController.php')),
    'Must resolve PersonalController tokens to modules/personal/controllers/FormController.php'
  );
  // Must NOT match unrelated controllers as scope-fallback
  assert.ok(
    !matchedPaths.some((p) => p.includes('modules/academic/controllers/UpdateAcademicController.php')),
    'Must NOT dump unrelated academic controllers for PersonalController query'
  );

  // SCENARIO 2: Case variation and multi-token search tokenization matches across heterogeneous project layouts
  developerFiles.releaseProject(ownerId);
  await developerFiles.discoverProjectByName('py-app', ownerId);
  const searchPythonService = await developerFiles.searchCode('UserRegistration', ownerId);
  assert.ok(searchPythonService.results.length > 0, 'Must match PascalCase UserRegistration in Python project');
  assert.ok(
    searchPythonService.results.some((r) => r.path.replace(/\\/g, '/').includes('UserRegistrationService.py')),
    'Must locate UserRegistrationService.py from UserRegistration'
  );

  developerFiles.releaseProject(ownerId);
  await developerFiles.discoverProjectByName('node-app', ownerId);
  const searchNodeAuth = await developerFiles.searchCode('authHandler', ownerId);
  assert.ok(searchNodeAuth.results.length > 0, 'Must match camelCase authHandler in Node project');
  assert.ok(
    searchNodeAuth.results.some((r) => r.path.replace(/\\/g, '/').includes('AuthHandler.ts')),
    'Must locate AuthHandler.ts from authHandler'
  );

  // SCENARIO 3: End-to-end trace mapping across architectural layers (route -> controller -> model -> transaction/view)
  developerFiles.releaseProject(ownerId);
  await developerFiles.discoverProjectByName('modular-app', ownerId);

  const fileData = await developerFiles.readFile('modules/personal/controllers/FormController.php', ownerId);
  const trace = traceExecutionFlow({
    route: 'personal/form/update',
    controllerFile: 'modules/personal/controllers/FormController.php',
    controllerContent: fileData.content,
    action: 'actionUpdate',
  });
  assert.equal(trace.layers.route, 'personal/form/update');
  assert.equal(trace.layers.controller, 'FormController');
  assert.equal(trace.layers.model, 'CandidatePersonalDetails');
  assert.equal(trace.layers.hasTransaction, true);
  assert.equal(trace.layers.transactionCommits, true);
  assert.equal(trace.layers.transactionRollbacksInCatch, false); // Traced missing rollback defect

  // SCENARIO 4: Ambiguous tasks requiring clarification vs concrete tasks
  const vagueAnalysis = analyzeTaskRequirements('make the personal details page faster and better');
  assert.equal(vagueAnalysis.needsClarification, true);
  assert.equal(vagueAnalysis.ambiguityScore, 'HIGH');
  assert.match(vagueAnalysis.clarificationPrompt, /ambiguous/i);

  const concreteAnalysis = analyzeTaskRequirements('add transaction rollback in catch block of FormController');
  assert.equal(concreteAnalysis.needsClarification, false);
  assert.equal(concreteAnalysis.ambiguityScore, 'LOW');
  assert.ok(concreteAnalysis.acceptanceCriteria.length > 0);

  // SCENARIO 5: Distinguishing confirmed defects from valid code
  const defect1 = classifyDefect({
    filePath: 'modules/personal/controllers/FormController.php',
    symbol: 'actionDebugProbe',
    lines: '30-33',
    codeSnippet: 'var_dump($_POST);\ndie("DEBUG_PROBE_EXIT");',
    controlFlow: 'Direct exit with debug dump reachable in production path',
    expected: 'Structured response returned to caller without terminating process',
    observed: 'die() statement terminates execution abruptly and exposes raw request',
    evidenceType: 'STATIC_INSPECTION_CONFIRMED',
  });
  assert.equal(defect1.classification, CLASSIFICATION_CONFIRMED);
  assert.equal(defect1.isConfirmed, true);

  const defect2 = classifyDefect({
    filePath: 'modules/personal/controllers/FormController.php',
    symbol: 'actionUpdate',
    lines: '17-21',
    codeSnippet: 'catch (\\Exception $e) {\n    return $this->asJson([\'error\' => $e->getMessage()]);\n}',
    controlFlow: 'Transaction opened at line 9 is not rolled back when exception is caught at line 17',
    expected: '$transaction->rollBack() before exiting catch block',
    observed: 'No rollBack() call in catch block, leaving uncommitted transaction in error flow',
    evidenceType: 'CONTROL_FLOW_CONFIRMED',
  });
  assert.equal(defect2.classification, CLASSIFICATION_CONFIRMED);

  const notABug = classifyDefect({
    filePath: 'modules/personal/models/CandidatePersonalDetails.php',
    symbol: 'rules',
    lines: '7-12',
    codeSnippet: 'public function rules() { return [[[\'first_name\', \'email\'], \'required\']]; }',
    controlFlow: 'Standard declarative Yii2 validation rules returned as array',
    expected: 'Array of validation rule tuples',
    observed: 'Array of validation rule tuples',
    evidenceType: 'STATIC_INSPECTION_VALID',
  });
  assert.equal(notABug.classification, CLASSIFICATION_NOT_A_BUG);

  // SCENARIO 6: Minimal patch proposal generated with scoped acceptance criteria
  const patchScope = validatePatchScope({
    targetFiles: ['modules/personal/controllers/FormController.php'],
    proposedChanges: [
      {
        action: 'replace',
        path: 'modules/personal/controllers/FormController.php',
        reason: 'Add $transaction->rollBack() in catch block and remove debugProbe',
      },
    ],
    acceptanceCriteria: [
      'Exception in actionUpdate rolls back transaction before returning error response',
      'actionDebugProbe removed or disabled in production',
    ],
  });
  assert.equal(patchScope.isMinimal, true);
  assert.equal(patchScope.targetFiles.length, 1);
  assert.equal(patchScope.acceptanceCriteria.length, 2);

  // SCENARIO 7: Unrelated user changes remain untouched
  const untouchedCheck = validatePatchScope({
    targetFiles: ['modules/personal/controllers/FormController.php'],
    modifiedFiles: ['modules/personal/controllers/FormController.php'],
    existingDirtyFiles: ['modules/academic/controllers/UpdateAcademicController.php'],
  });
  assert.equal(untouchedCheck.preservesUnrelatedFiles, true);
  assert.ok(!untouchedCheck.touchedFiles.includes('modules/academic/controllers/UpdateAcademicController.php'));

  // SCENARIO 8: Contradictory/forged test evidence rejected (never verified)
  const forgedEvidence = validateEvidenceReport({
    userGoal: 'Fix transaction rollback',
    inspectedFiles: ['modules/personal/controllers/FormController.php'],
    claimedVerification: 'PASSED',
    executionAuditLog: null,
    simulatedOutput: 'Tests passed: 10/10 (simulated)',
  });
  assert.equal(forgedEvidence.isValid, false);
  assert.equal(forgedEvidence.verificationAccepted, false);
  assert.match(forgedEvidence.rejectionReason, /authoritative/i);

  // SCENARIO 9: Failed tests remain visible and cannot be reported as passing
  const failedTestReport = validateEvidenceReport({
    userGoal: 'Run test suite',
    inspectedFiles: ['modules/personal/controllers/FormController.php'],
    executionAuditLog: {
      command: 'vendor/bin/phpunit',
      exitCode: 1,
      output: 'FAILURES!\nTests: 12, Assertions: 20, Failures: 1.',
    },
    claimedVerification: 'FAILED',
  });
  assert.equal(failedTestReport.verificationAccepted, true);
  assert.equal(failedTestReport.finalStatus, 'FAILED');
  assert.equal(failedTestReport.exitCode, 1);

  const fraudulentPassingReport = validateEvidenceReport({
    userGoal: 'Run test suite',
    inspectedFiles: ['modules/personal/controllers/FormController.php'],
    executionAuditLog: {
      command: 'vendor/bin/phpunit',
      exitCode: 1,
      output: 'FAILURES!\nTests: 12, Assertions: 20, Failures: 1.',
    },
    claimedVerification: 'PASSED',
  });
  assert.equal(fraudulentPassingReport.isValid, false);
  assert.equal(fraudulentPassingReport.verificationAccepted, false);

  // SCENARIO 10: Scope expansion and deletion remain strictly approval-gated
  const unapprovedScopeExpansion = enforceApprovalGate({
    originalProposalTargets: ['modules/personal/controllers/FormController.php'],
    attemptedMutationTargets: [
      'modules/personal/controllers/FormController.php',
      'modules/personal/models/CandidatePersonalDetails.php',
    ],
    userApproved: true,
  });
  assert.equal(unapprovedScopeExpansion.allowed, false);
  assert.match(unapprovedScopeExpansion.rejectionReason, /scope expansion/i);

  const unapprovedDeletion = enforceApprovalGate({
    originalProposalTargets: ['modules/personal/controllers/FormController.php'],
    attemptedMutationTargets: ['modules/personal/controllers/FormController.php'],
    operationType: 'DELETE_FILE',
    userApproved: false,
  });
  assert.equal(unapprovedDeletion.allowed, false);
  assert.match(unapprovedDeletion.rejectionReason, /approval/i);

  // SCENARIO 11: Unknown / unsupported project layouts handled gracefully
  const unknownArch = discoverProjectArchitecture({
    languages: [],
    frameworks: [],
    entryPoints: [],
    sourceDirectories: ['.'],
    configFiles: [],
  });
  assert.equal(unknownArch.ecosystem, 'UNKNOWN_OR_CUSTOM');
  assert.equal(unknownArch.isUnstructured, true);
  assert.equal(unknownArch.recommendedScope, '.');

  // SCENARIO 12: Tool execution safeguards: timeout protection & failure preservation
  const timeoutTool = await executeToolWithSafeguards({
    toolName: 'long_running_search',
    toolFn: async () => new Promise((resolve) => setTimeout(resolve, 200)),
    timeoutMs: 50,
  });
  assert.equal(timeoutTool.success, false);
  assert.equal(timeoutTool.errorCode, 'TOOL_TIMEOUT');
  assert.equal(timeoutTool.failurePreserved, true);

  const deterministicTool = await executeToolWithSafeguards({
    toolName: 'read_nonexistent',
    toolFn: async () => { throw new Error('File not found: /missing.txt'); },
    timeoutMs: 1000,
    maxRetries: 2,
  });
  assert.equal(deterministicTool.success, false);
  assert.equal(deterministicTool.attempts, 1); // No blind retries on deterministic failures!

  // SCENARIO 13: Search planning and deduplication
  const firstPlan = planProgressiveSearch({
    query: 'PersonalController',
    scope: '.',
    sessionSearches: [],
  });
  assert.equal(firstPlan.isDuplicate, false);
  assert.equal(firstPlan.tier, 2);

  const duplicatePlan = planProgressiveSearch({
    query: 'personal controller',
    scope: '.',
    sessionSearches: [{ query: 'PersonalController', scope: '.' }],
  });
  assert.equal(duplicatePlan.isDuplicate, true);
  assert.match(duplicatePlan.rationale, /prevent redundant/i);

  // SCENARIO 14: Minimal repair loop governance
  const disabledRepair = manageRepairLoop({
    approvedTargets: ['modules/personal/controllers/FormController.php'],
    autoRepairEnabled: false,
  });
  assert.equal(disabledRepair.allowRepair, false);
  assert.match(disabledRepair.reason, /disabled by default/i);

  const exceededRepair = manageRepairLoop({
    approvedTargets: ['modules/personal/controllers/FormController.php'],
    attemptCount: 2,
    maxAttempts: 2,
    autoRepairEnabled: true,
  });
  assert.equal(exceededRepair.allowRepair, false);
  assert.match(exceededRepair.reason, /Maximum repair attempts/i);

  const expandedRepair = manageRepairLoop({
    approvedTargets: ['modules/personal/controllers/FormController.php'],
    attemptCount: 1,
    maxAttempts: 2,
    autoRepairEnabled: true,
    proposedMutationTargets: [
      'modules/personal/controllers/FormController.php',
      'modules/unapproved/evil.js',
    ],
  });
  assert.equal(expandedRepair.allowRepair, false);
  assert.match(expandedRepair.reason, /Scope expansion/i);

  const validRepair = manageRepairLoop({
    approvedTargets: ['modules/personal/controllers/FormController.php'],
    attemptCount: 0,
    maxAttempts: 2,
    autoRepairEnabled: true,
    proposedMutationTargets: ['modules/personal/controllers/FormController.php'],
  });
  assert.equal(validRepair.allowRepair, true);
  assert.equal(validRepair.attemptNumber, 1);

  // SCENARIO 15: Dynamic verification command discovery across ecosystems
  const nodeChecks = selectVerificationChecks({
    scripts: { test: 'vitest run', lint: 'eslint .' },
  });
  assert.deepEqual(nodeChecks, ['test', 'lint']);

  const phpChecks = selectVerificationChecks({
    hasPhpUnitConfig: true,
    frameworks: ['yii2'],
  });
  assert.deepEqual(phpChecks, ['phpunit']);

  const pyChecks = selectVerificationChecks({
    languages: ['python'],
    frameworks: ['django'],
  });
  assert.deepEqual(pyChecks, ['python-test']);

  const goChecks = selectVerificationChecks({
    languages: ['go'],
  });
  assert.deepEqual(goChecks, ['go-test']);

  // Verify Project Detector and Repo Map on modular app
  const projectInfo = await detectProject(projectModular);
  assert.equal(projectInfo.hasYii, true);
  assert.equal(projectInfo.composer, 'composer.json');

  const repoMap = await buildRepositoryMap(projectModular);
  assert.ok(repoMap.frameworks.includes('yii2'));
  assert.ok(repoMap.frameworks.includes('composer'));
  assert.ok(repoMap.sourceDirectories.some((dir) => dir.includes('modules')));
  assert.ok(repoMap.sourceDirectories.some((dir) => dir.includes('controllers')));

  // SCENARIO 16: Multi-framework dynamic execution flow tracing (Laravel, Express, Nest, Python, Spring)
  const laravelTrace = traceExecutionFlow({
    controllerFile: 'app/Http/Controllers/OrderController.php',
    controllerContent: `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Support\\Facades\\Route;
use App\\Models\\Order;

Route::post('/orders', [OrderController::class, 'store']);
class OrderController extends Controller {
    public function store(Request $request) {
        $order = Order::create($request->all());
        return response()->json($order);
    }
}
`,
  });
  assert.equal(laravelTrace.layers.framework, 'laravel');
  assert.equal(laravelTrace.layers.controller, 'OrderController');
  assert.equal(laravelTrace.layers.action, 'store');
  assert.equal(laravelTrace.layers.model, 'Order');
  assert.ok(laravelTrace.layers.callChain.includes('controller:OrderController'));
  assert.ok(laravelTrace.layers.callChain.includes('model:Order'));

  const expressTrace = traceExecutionFlow({
    controllerFile: 'src/routes/userRouter.ts',
    controllerContent: `
import { Router } from 'express';
const router = Router();
router.get('/api/users', async (req, res) => {
    const user = UserModel.find();
    res.json(user);
});
export function handleUsers() {}
`,
  });
  assert.equal(expressTrace.layers.framework, 'express');
  assert.equal(expressTrace.layers.route, '/api/users');
  assert.equal(expressTrace.layers.model, 'UserModel');

  const pythonTrace = traceExecutionFlow({
    controllerFile: 'services/items.py',
    controllerContent: `
from fastapi import FastAPI, Depends
app = FastAPI()
@app.get("/items/{item_id}")
async def read_item(item_id: int):
    return {"item_id": item_id}
`,
  });
  assert.equal(pythonTrace.layers.framework, 'python-web');
  assert.equal(pythonTrace.layers.route, '/items/{item_id}');
  assert.equal(pythonTrace.layers.action, 'read_item');

  // SCENARIO 17: Structured Antigravity-level Task Plan and Subtasks Artifact
  const autonomousPlan = createTaskPlan({
    userRequest: 'Investigate and resolve missing transaction rollback in personal controller',
    operatingMode: 'AUTONOMOUS',
    complexity: 'DEEP',
  });
  assert.equal(autonomousPlan.schemaVersion, 2);
  assert.equal(autonomousPlan.planType, 'REQUEST_DRIVEN');
  assert.equal(autonomousPlan.operatingMode, 'AUTONOMOUS');
  assert.equal(autonomousPlan.complexity, 'DEEP');
  assert.equal(autonomousPlan.subtasks.length, 6);
  assert.equal(autonomousPlan.subtasks[0].id, 'ST-1');
  assert.equal(autonomousPlan.subtasks[0].status, 'PENDING');
  assert.equal(autonomousPlan.subtasks[1].status, 'PENDING');
  assert.equal(autonomousPlan.workItems.length, 1);
  assert.equal(autonomousPlan.workItems[0].stageId, 'ST-6');
  assert.ok(autonomousPlan.workItems[0].requiredEvidence.includes('VERIFICATION_PASS'));
  assert.equal(autonomousPlan.hypotheses.length, 1);
  assert.ok(autonomousPlan.constraints.length >= 3);

  const explanationPlan = createTaskPlan({
    userRequest: 'Explain how the request router dispatches a message',
    requirements: analyzeTaskRequirements('Explain how the request router dispatches a message'),
    projectArch: { ecosystem: 'UNKNOWN' },
    operatingMode: 'ASK',
  });
  assert.equal(explanationPlan.workItems.length, 1);
  assert.equal(explanationPlan.workItems[0].stageId, 'ST-2');
  assert.deepEqual(explanationPlan.permissions, {
    canPropose: false,
    canApply: false,
    canVerify: false,
  });
  assert.ok(explanationPlan.workItems[0].requiredEvidence.includes('SOURCE_INSPECTION'));

  const investigationPlan = createTaskPlan({
    userRequest: 'Trace the request handler and explain why the response is delayed',
    requirements: analyzeTaskRequirements('Trace the request handler and explain why the response is delayed'),
    operatingMode: 'INVESTIGATE',
    capabilities: { canPropose: false, canApply: false, canVerify: true },
  });
  assert.equal(investigationPlan.workItems.length, 1);
  assert.equal(investigationPlan.workItems[0].stageId, 'ST-2');
  assert.equal(investigationPlan.permissions.canApply, false);
  assert.equal(investigationPlan.permissions.canVerify, true);

  const singleChangePlan = createTaskPlan({
    userRequest: 'Add a typed setting for the active workspace',
    requirements: analyzeTaskRequirements('Add a typed setting for the active workspace'),
    operatingMode: 'AUTONOMOUS',
  });
  assert.equal(singleChangePlan.workItems.length, 1);
  assert.deepEqual(singleChangePlan.workItems[0].requiredEvidence, [
    'APPROVED_SCOPE_PROPOSAL',
    'EXPLICIT_APPROVAL',
    'VERIFICATION_PASS',
    'PRESERVATION_AUDIT',
  ]);
  const forgedCompletionPlan = createTaskPlan({
    userRequest: 'Explain the configured request entry point',
    requirements: analyzeTaskRequirements('Explain the configured request entry point'),
    operatingMode: 'ASK',
  });
  advanceTaskPlan(forgedCompletionPlan, {
    workItemId: forgedCompletionPlan.workItems[0].id,
    status: 'IN_PROGRESS',
  });
  assert.throws(
    () => advanceTaskPlan(forgedCompletionPlan, {
      workItemId: forgedCompletionPlan.workItems[0].id,
      status: 'COMPLETED',
      evidence: {
        types: ['SOURCE_INSPECTION'],
        objective: forgedCompletionPlan.workItems[0].objective,
        sourceEvidence: [{ path: 'src/router.ts', sourceHash: 'caller-supplied-hash', lineRange: [1, 10] }],
        provenance: 'HOST_SOURCE_INSPECTION',
      },
    }),
    /trusted, item-bound host verification result/i,
    'Caller-supplied provenance labels and source references must not complete a request work item.',
  );

  const multiRequest = [
    'Implement the requested settings changes:',
    '- Persist user preferences through the existing storage boundary.',
    '- Expose a typed settings operation to the renderer.',
    '- Add focused coverage for the settings workflow.',
  ].join('\n');
  const multiRequirements = analyzeTaskRequirements(multiRequest);
  const multiPlan = createTaskPlan({
    userRequest: multiRequest,
    requirements: multiRequirements,
    projectArch: { ecosystem: 'UNKNOWN' },
    operatingMode: 'AUTONOMOUS',
  });
  assert.equal(multiPlan.workItems.length, 3);
  assert.deepEqual(multiPlan.workItems.map((item) => item.objective), multiRequirements.explicitRequirements);
  assert.ok(multiPlan.workItems.every((item) => item.status === 'PENDING'));
  assert.ok(multiPlan.workItems.every((item) => Array.isArray(item.dependsOn)));
  assert.equal(new Set(multiPlan.workItems.map((item) => item.id)).size, 3);
  multiPlan.workItems[1].dependsOn = [multiPlan.workItems[0].id];
  assert.throws(
    () => advanceTaskPlan(multiPlan, { workItemId: multiPlan.workItems[1].id, status: 'IN_PROGRESS' }),
    /cannot advance before dependency WI-001 is completed/i
  );
  const mixedOutcomePlan = createTaskPlan({
    userRequest: multiRequest,
    requirements: multiRequirements,
    operatingMode: 'AUTONOMOUS',
  });
  advanceTaskPlan(mixedOutcomePlan, {
    workItemId: mixedOutcomePlan.workItems[0].id,
    status: 'DELEGATED',
    outcome: 'This item was handed to the standard proposal workflow.',
    evidence: {
      types: ['STANDARD_PROPOSAL_HANDOFF'],
      objective: mixedOutcomePlan.workItems[0].objective,
      provenance: 'HOST_WORKFLOW_ROUTER',
    },
  });
  advanceTaskPlan(mixedOutcomePlan, {
    workItemId: mixedOutcomePlan.workItems[1].id,
    status: 'IN_PROGRESS',
  });
  advanceTaskPlan(mixedOutcomePlan, {
    workItemId: mixedOutcomePlan.workItems[1].id,
    status: 'FAILED',
    outcome: 'The second work item failed before proposal creation.',
  });
  assert.equal(mixedOutcomePlan.status, 'FAILED', 'A failed work item must not be masked by another handed-off item.');
  const blockedOutcomePlan = createTaskPlan({
    userRequest: multiRequest,
    requirements: multiRequirements,
    operatingMode: 'AUTONOMOUS',
  });
  advanceTaskPlan(blockedOutcomePlan, {
    workItemId: blockedOutcomePlan.workItems[0].id,
    status: 'DELEGATED',
    outcome: 'This item was handed to the standard proposal workflow.',
    evidence: {
      types: ['STANDARD_PROPOSAL_HANDOFF'],
      objective: blockedOutcomePlan.workItems[0].objective,
      provenance: 'HOST_WORKFLOW_ROUTER',
    },
  });
  advanceTaskPlan(blockedOutcomePlan, {
    workItemId: blockedOutcomePlan.workItems[1].id,
    status: 'BLOCKED',
    outcome: 'Required capability is unavailable.',
  });
  assert.equal(blockedOutcomePlan.status, 'BLOCKED', 'A blocked work item must not be masked by another handed-off item.');

  const ambiguousRequest = 'Make it better';
  const ambiguousPlan = createTaskPlan({
    userRequest: ambiguousRequest,
    requirements: analyzeTaskRequirements(ambiguousRequest),
    operatingMode: 'AUTONOMOUS',
  });
  assert.equal(ambiguousPlan.status, 'NEEDS_CLARIFICATION');
  assert.equal(ambiguousPlan.workItems.length, 0);
  assert.equal(ambiguousPlan.subtasks[0].status, 'BLOCKED');

  const unavailablePlan = createTaskPlan({
    userRequest: 'Implement the requested change',
    operatingMode: 'AUTONOMOUS',
    capabilities: { approvalAvailable: false, verificationAvailable: false },
  });
  assert.deepEqual(unavailablePlan.capabilityBlockers, ['APPROVAL_UNAVAILABLE', 'VERIFICATION_UNAVAILABLE']);
  assert.equal(unavailablePlan.subtasks.find((item) => item.id === 'ST-4').status, 'BLOCKED');
  assert.equal(unavailablePlan.subtasks.find((item) => item.id === 'ST-5').status, 'BLOCKED');
  assert.equal(unavailablePlan.workItems[0].status, 'BLOCKED');

  const auditPlan = createTaskPlan({
    userRequest: 'Read-only audit of controller security boundaries',
    operatingMode: 'AUDIT',
    complexity: 'FAST',
  });
  assert.equal(auditPlan.operatingMode, 'AUDIT');
  assert.equal(auditPlan.subtasks.find((s) => s.id === 'ST-3').status, 'SKIPPED');
  assert.equal(auditPlan.subtasks.find((s) => s.id === 'ST-4').status, 'SKIPPED');
  assert.equal(auditPlan.subtasks.find((s) => s.id === 'ST-5').status, 'SKIPPED');

  // SCENARIO 18: AUDIT mode routing & strict read-only preservation
  const auditRouting = routeTaskMode({
    goal: 'Perform a READ-ONLY audit of the codebase',
  });
  assert.equal(auditRouting.mode, OPERATING_MODES.AUDIT);
  assert.equal(auditRouting.canPropose, false);
  assert.equal(auditRouting.canApply, false);
  assert.equal(auditRouting.canMutateGit, false);

  // Execute workflow in AUDIT mode and verify zero proposals applied, zero writes
  const auditWorkflowResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Perform a read-only audit of FormController for defects',
    root: projectModular,
    scope: '.',
    sessionId: 'session-audit-1',
    ownerWebContentsId: ownerId,
    tools: {
      operatingMode: 'AUDIT',
      readFile: async (p) => {
        const full = path.join(projectModular, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async (q) => {
        return {
          results: [{ path: 'modules/personal/controllers/FormController.php', score: 10, line: 1 }],
        };
      },
    },
  });
  assert.equal(auditWorkflowResult.outcome, 'AUDIT_COMPLETED');
  assert.equal(auditWorkflowResult.phase, 'AUDIT');
  assert.equal(auditWorkflowResult.codeApplied, false);
  assert.equal(auditWorkflowResult.readOnlyPreserved, true);
  assert.deepEqual(auditWorkflowResult.filesModified, []);
  assert.ok(auditWorkflowResult.findings.length > 0);
  assert.ok(auditWorkflowResult.taskPlan !== null);

  // SCENARIO 19: Multi-language defect classification
  const jsDefect = classifyDefect({
    filePath: 'src/app.ts',
    symbol: 'debugProbe',
    lines: '42',
    codeSnippet: 'debugger;',
    evidenceType: 'STATIC_INSPECTION_CONFIRMED',
  });
  assert.equal(jsDefect.isConfirmed, true);
  assert.equal(jsDefect.classification, CLASSIFICATION_CONFIRMED);

  const pyDefect = classifyDefect({
    filePath: 'backend/server.py',
    symbol: 'traceProbe',
    lines: '10',
    codeSnippet: 'breakpoint()',
    evidenceType: 'STATIC_INSPECTION_CONFIRMED',
  });
  assert.equal(pyDefect.isConfirmed, true);
  assert.equal(pyDefect.classification, CLASSIFICATION_CONFIRMED);

  const maskedSourceLines = maskNonCodeSource([
    'const url = "https://example.test"; // debugger;',
    '/*',
    'var_dump($_POST);',
    '*/',
    'debugger;',
  ].join('\n'), 'src/handler.js').split(/\r?\n/);
  assert.equal(maskedSourceLines.length, 5, 'Comment masking must preserve source line numbers.');
  assert.doesNotMatch(maskedSourceLines[0], /debugger;/, 'Comment markers inside strings must remain strings.');
  assert.doesNotMatch(maskedSourceLines[2], /var_dump/, 'Block-comment contents must be masked.');
  assert.match(maskedSourceLines[4], /debugger;/, 'Executable source must remain available to the scanner.');
  const nestedRustComment = [
    '/* outer documentation comment',
    '/* nested documentation comment */',
    'debugger;',
    '*/',
    'fn active() { debugger; }',
  ].join('\n');
  const maskedRustComment = maskNonCodeSource(nestedRustComment, 'src/lib.rs');
  const maskedRustLines = maskedRustComment.split(/\r?\n/);
  assert.doesNotMatch(maskedRustLines[2], /debugger;/, 'Nested Rust block-comment content must be masked.');
  assert.equal(maskedRustLines.length, 5, 'Nested comment masking must preserve Rust source lines.');
  assert.match(maskedRustLines[4], /debugger;/, 'Rust code after a nested comment must remain visible.');
  const rustLifetime = maskNonCodeSource("fn check<'a>() { debugger; }", 'src/lib.rs');
  assert.match(rustLifetime, /debugger;/, 'Rust lifetime syntax must not be mistaken for an unterminated character literal.');
  const stringSource = [
    'const single = \'console.trace("inactive single-quoted text")\';',
    'const double = "debugger; // inactive double-quoted text";',
    'const template = `var_dump(); /* inactive template text */`;',
    'const escaped = "escaped quote: \\" console.trace()";',
    'const multiline = `',
    'console.trace("inactive multiline template text");',
    '`;',
    'const active = true; debugger;',
  ].join('\n');
  const maskedStringLines = maskNonCodeSource(stringSource, 'src/strings.js').split(/\r?\n/);
  assert.doesNotMatch(maskedStringLines.slice(0, 7).join('\n'), /console\.trace|debugger;|var_dump/,
    'Debug-looking text inside JS string literals must not be scanned as executable code.');
  assert.match(maskedStringLines[7], /debugger;/, 'Active debug statements after strings must remain visible.');
  assert.match(
    maskNonCodeSource('value = 8 // 2; breakpoint()', 'src/worker.py'),
    /breakpoint\(\)/,
    'Python floor-division syntax must not be treated as a line comment.',
  );
  const maskedPythonSource = maskNonCodeSource([
    '"""',
    'breakpoint()',
    '"""',
    'value = 8 // 2  # debugger;',
    'breakpoint()',
  ].join('\n'), 'src/worker.py').split(/\r?\n/);
  assert.doesNotMatch(maskedPythonSource[1], /breakpoint/, 'Python triple-quoted docstring content must be masked.');
  assert.doesNotMatch(maskedPythonSource[3], /debugger;/, 'Python hash comments must be masked.');
  assert.match(maskedPythonSource[4], /breakpoint\(\)/, 'Executable Python after a docstring must remain visible.');
  assert.doesNotMatch(
    maskNonCodeSource('<?php\n# var_dump($_POST);\n?>', 'src/handler.php'),
    /var_dump/,
    'PHP hash comments must be masked.',
  );
  const incompleteBlockComment = maskNonCodeSource('/* unfinished comment\nbreakpoint();', 'src/worker.js');
  assert.doesNotMatch(incompleteBlockComment, /breakpoint/,
    'An unterminated block comment must be treated conservatively through end of input.');

  // SCENARIO 20: Precedence routing for actionable requests containing "audit"
  const fixAuditRouting = routeTaskMode({
    goal: 'Fix the audit logging bug in PersonalController',
  });
  assert.equal(fixAuditRouting.mode, OPERATING_MODES.AUTONOMOUS);

  const implAuditRouting = routeTaskMode({
    goal: 'Implement an audit service for transactions',
  });
  assert.equal(implAuditRouting.mode, OPERATING_MODES.AUTONOMOUS);

  const testAuditRouting = routeTaskMode({
    goal: 'Add tests for audit events in controller',
  });
  assert.equal(testAuditRouting.mode, OPERATING_MODES.AUTONOMOUS);

  const readOnlyInvestigationRouting = routeTaskMode({
    goal: 'Do not change code; investigate why the retry is failing',
  });
  assert.equal(readOnlyInvestigationRouting.mode, OPERATING_MODES.INVESTIGATE);
  assert.equal(readOnlyInvestigationRouting.canPropose, false);
  assert.equal(readOnlyInvestigationRouting.canApply, false);
  assert.equal(readOnlyInvestigationRouting.canMutateGit, false);

  const readOnlyExplanationRouting = routeTaskMode({
    goal: 'Do not implement a change; explain how the retry policy works',
  });
  assert.equal(readOnlyExplanationRouting.mode, OPERATING_MODES.ASK);
  assert.equal(readOnlyExplanationRouting.canPropose, false);
  assert.equal(readOnlyExplanationRouting.canApply, false);

  const explicitImplementationRouting = routeTaskMode({
    goal: 'Implement retry handling after inspection',
  });
  assert.equal(explicitImplementationRouting.mode, OPERATING_MODES.AUTONOMOUS);

  // SCENARIO 21: Authoritative main-process mutation boundary enforcement in AUDIT mode
  const auditSessionId = 'session-audit-mutation-check';
  createSession(auditSessionId, ownerId);
  const auditTurn = beginConversationTurn({
    root: projectModular,
    request: 'Perform a read-only audit of FormController',
    sessionId: auditSessionId,
    ownerWebContentsId: ownerId,
    operatingMode: 'AUDIT',
  });
  assert.equal(auditTurn.operatingMode, 'AUDIT');

  // Verify createProposal is authoritatively blocked in AUDIT mode
  await assert.rejects(
    async () => {
      await createProposal({
        root: projectModular,
        raw: '--- a/dummy.txt\n+++ b/dummy.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
        sessionId: auditSessionId,
        ownerWebContentsId: ownerId,
        conversationTurnId: auditTurn.turnId,
      });
    },
    /cannot create proposals in read-only AUDIT mode/i
  );

  // SCENARIO 22: Truthful clean audit returns AUDIT_COMPLETED with 0 defects
  const cleanAuditResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Audit CleanController',
    root: projectNode,
    scope: '.',
    sessionId: 'session-audit-clean',
    ownerWebContentsId: ownerId,
    tools: {
      operatingMode: 'AUDIT',
      readFile: async () => {
        return { content: 'export function hello() { return "clean"; }' };
      },
      searchCode: async () => {
        return {
          results: [{ path: 'src/clean.ts', score: 10, line: 1 }],
        };
      },
    },
  });
  assert.equal(cleanAuditResult.outcome, 'AUDIT_COMPLETED');
  assert.equal(cleanAuditResult.phase, 'AUDIT');
  assert.equal(cleanAuditResult.findings.length, 0);
  assert.equal(cleanAuditResult.readOnlyPreserved, true);
  assert.equal(cleanAuditResult.codeApplied, false);
  assert.equal(cleanAuditResult.taskPlan.subtasks.find((s) => s.id === 'ST-6').status, 'COMPLETED');

  // SCENARIO 22B: Investigate mode without inspected evidence must remain explicitly incomplete rather than claiming a no-defect result.
  const noDefectInvestigation = await executeAutonomousCodingWorkflow({
    userRequest: 'investigate missingNonExistentMethodCallInUnreferencedModule that is failing',
    root: projectNode,
    scope: '.',
    sessionId: 'session-investigate-clean',
    ownerWebContentsId: ownerId,
    tools: {
      operatingMode: 'INVESTIGATE',
      readFile: async () => {
        return { content: 'export function hello() { return "clean"; }' };
      },
      searchCode: async () => {
        return { results: [] };
      },
    },
  });
  assert.equal(noDefectInvestigation.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(noDefectInvestigation.phase, 'INVESTIGATE');
  assert.equal(noDefectInvestigation.filesModified.length, 0);
  assert.equal(noDefectInvestigation.codeApplied, false);
  assert.equal(noDefectInvestigation.codeVerified, false);
  assert.match(noDefectInvestigation.message, /incomplete/i);

  const confirmedFindingInvestigation = await executeAutonomousCodingWorkflow({
    userRequest: 'Investigate whether the scheduler leaves a debug probe in production',
    root: projectNode,
    scope: '.',
    sessionId: 'session-investigate-confirmed-finding',
    ownerWebContentsId: ownerId,
    tools: {
      operatingMode: 'INVESTIGATE',
      readFile: async () => ({
        content: 'export function runScheduledJob() {\n  debugger;\n  return true;\n}',
      }),
      searchCode: async () => ({
        results: [{ path: 'src/jobs/scheduledWorker.ts', score: 10, line: 2 }],
      }),
    },
  });
  assert.equal(confirmedFindingInvestigation.outcome, 'INVESTIGATION_COMPLETED');
  assert.equal(confirmedFindingInvestigation.phase, 'INVESTIGATE');
  assert.equal(confirmedFindingInvestigation.findings.length, 1);
  assert.equal(confirmedFindingInvestigation.filesModified.length, 0);
  assert.equal(confirmedFindingInvestigation.codeApplied, false);
  assert.equal(confirmedFindingInvestigation.codeVerified, false);
  assert.equal(confirmedFindingInvestigation.readOnlyPreserved, true);
  assert.match(confirmedFindingInvestigation.message, /no changes were proposed or applied/i);

  // Verify bounded/incomplete search pass in AUDIT mode truthfully returns INVESTIGATION_INCOMPLETE
  const incompleteAuditResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Perform a read-only audit of clean controller for security issues and transaction invariants',
    root: projectNode,
    scope: '.',
    sessionId: 'session-audit-incomplete',
    ownerWebContentsId: ownerId,
    tools: {
      operatingMode: 'AUDIT',
      readFile: async () => {
        return { content: 'export function hello() { return "clean"; }' };
      },
      searchCode: async () => {
        return {
          results: [{ path: 'src/clean.ts', score: 10, line: 1 }],
        };
      },
    },
  });
  assert.equal(incompleteAuditResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(incompleteAuditResult.phase, 'INVESTIGATE');

  // SCENARIO 23: Dynamic Task-Plan progression across execution lifecycle
  const dynamicPlan = createTaskPlan({
    userRequest: 'Fix the debug probe in PersonalController',
    operatingMode: 'AUTONOMOUS',
  });
  advanceTaskPlan(dynamicPlan, { subtaskId: 'ST-1', status: 'IN_PROGRESS' });
  advanceTaskPlan(dynamicPlan, {
    subtaskId: 'ST-1',
    status: 'COMPLETED',
    outcome: 'Requirements and project discovery completed.',
    evidence: {
      types: ['REQUIREMENTS_ANALYSIS', 'PROJECT_DISCOVERY'],
      provenance: 'HOST_OBSERVED',
      requirementCount: 1,
      requestHash: 'request-hash',
    },
  });
  advanceTaskPlan(dynamicPlan, { subtaskId: 'ST-2', status: 'IN_PROGRESS' });
  assert.equal(dynamicPlan.subtasks[1].status, 'IN_PROGRESS');
  advanceTaskPlan(dynamicPlan, {
    subtaskId: 'ST-2',
    status: 'COMPLETED',
    outcome: 'Identified debug probe in FormController.php',
    hypothesisId: 'H1',
    hypothesisStatus: 'SUPPORTED',
    evidence: {
      types: ['SOURCE_INSPECTION'],
      provenance: 'HOST_SOURCE_INSPECTION',
      sourceEvidence: [{ path: 'src/example.ts', sourceHash: 'source-hash', lineRange: [1, 1] }],
      finding: 'die() found on line 42',
    },
  });
  assert.equal(dynamicPlan.subtasks[1].status, 'COMPLETED');
  assert.equal(dynamicPlan.hypotheses[0].status, 'SUPPORTED');
  assert.equal(dynamicPlan.hypotheses[0].evidence.finding, 'die() found on line 42');

  // SCENARIO 24: Language Detection & Classification across Diverse Stacks
  assert.equal(detectSourceLanguage('FormController.php'), 'php');
  assert.equal(detectSourceLanguage('src/app.js'), 'javascript');
  assert.equal(detectSourceLanguage('src/app.tsx'), 'typescript');
  assert.equal(detectSourceLanguage('backend/service.py'), 'python');
  assert.equal(detectSourceLanguage('main.go'), 'go');
  assert.equal(detectSourceLanguage('Worker.java'), 'java');
  assert.equal(detectSourceLanguage('script.xyz', '<?php echo "hi";'), 'php');
  assert.equal(detectSourceLanguage('script.xyz', 'def main():\n    pass'), 'python');
  assert.equal(detectSourceLanguage('unknown.bin', 'random binary string'), 'unknown');

  // SCENARIO 25: Unrelated Logging Statements NOT Classified as Defects
  const validLogSnippet = 'console.log("Server initialized on port 8080");';
  const validLoggingDefect = classifyDefect({
    filePath: 'src/server.ts',
    symbol: 'initServer',
    lines: '15',
    codeSnippet: validLogSnippet,
    evidenceType: 'STATIC_INSPECTION_VALID',
    expected: validLogSnippet,
    observed: validLogSnippet,
  });
  assert.equal(validLoggingDefect.classification, CLASSIFICATION_NOT_A_BUG);
  assert.equal(validLoggingDefect.isConfirmed, false);

  // SCENARIO 26: Language-Safe Patch Abstention when Transaction Ownership Unknown
  const ambiguousPhpPath = path.join(projectModular, 'modules', 'personal', 'controllers', 'AmbiguousTxController.php');
  await fs.writeFile(
    ambiguousPhpPath,
    `<?php
namespace app\\modules\\personal\\controllers;
use yii\\web\\Controller;

class AmbiguousTxController extends Controller {
    public function actionSave() {
        \\Yii::$app->db->beginTransaction(); // Opened without variable assignment
        try {
            return $this->asJson(['status' => 'ok']);
        } catch (\\Exception $e) {
            return $this->asJson(['error' => $e->getMessage()]);
        }
    }
}
`,
    'utf8'
  );

  const ambiguousTxResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix missing rollback in AmbiguousTxController',
    root: projectModular,
    scope: '.',
    sessionId: 'session-ambiguous-tx',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    tools: {
      readFile: async (p) => {
        const full = path.join(projectModular, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async () => {
        return {
          results: [{ path: 'modules/personal/controllers/AmbiguousTxController.php', score: 10, line: 1 }],
        };
      },
    },
  });
  assert.equal(ambiguousTxResult.outcome, 'PLANNING_ABSTAINED');
  assert.equal(ambiguousTxResult.phase, 'PLAN');
  assert.equal(ambiguousTxResult.codeApplied, false);
  assert.ok(/transaction variable assignment/i.test(ambiguousTxResult.reason));
  assert.equal(ambiguousTxResult.taskPlan.subtasks.find((s) => s.id === 'ST-3').status, 'ABSTAINED');

  // SCENARIO 27: Cross-Language Safety (Never Inject PHP Rollback into Python or TypeScript)
  const pyTxPath = path.join(projectPython, 'routes', 'orders.py');
  await fs.writeFile(
    pyTxPath,
    `def process_order(order_id):
    # Simulated transaction without rollback
    try:
        beginTransaction()
        return {"status": "saved"}
    except Exception as e:
        return {"error": str(e)}
`,
    'utf8'
  );

  const pyTxResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix transaction rollback in orders.py',
    root: projectPython,
    scope: '.',
    sessionId: 'session-py-tx-safety',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    tools: {
      readFile: async (p) => {
        const full = path.join(projectPython, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async () => {
        return {
          results: [{ path: 'routes/orders.py', score: 10, line: 1 }],
        };
      },
    },
  });
  assert.equal(pyTxResult.outcome, 'PLANNING_ABSTAINED');
  assert.equal(pyTxResult.phase, 'PLAN');
  assert.equal(pyTxResult.codeApplied, false);
  assert.ok(/Cannot safely synthesize transaction rollback for non-PHP/i.test(pyTxResult.reason));

  // SCENARIO 28: Evidence-Driven Task-Plan Rejects Invalid Statuses and Illegal Transitions
  const testStateMachinePlan = createTaskPlan({
    userRequest: 'Test state machine robustness',
  });
  assert.equal(testStateMachinePlan.planType, 'REQUEST_DRIVEN');

  // Invalid subtask status must throw
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-2', status: 'MAGIC_STATUS' }),
    /Invalid subtask status: MAGIC_STATUS/i
  );

  // Illegal direct jump from PENDING -> COMPLETED must throw
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-3', status: 'COMPLETED', outcome: 'Skipped execution' }),
    /Illegal subtask transition from PENDING to COMPLETED for ST-3/i
  );
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-3', status: 'IN_PROGRESS' }),
    /cannot start before dependency ST-2 is resolved/i
  );

  // SCENARIO 29: Hypothesis Evidence Constraints & Provenance Enforcement
  // CONFIRMED without evidence must throw
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, { hypothesisId: 'H1', hypothesisStatus: 'CONFIRMED' }),
    /cannot become CONFIRMED without supporting evidence/i
  );

  // CONFIRMED with untrusted provenance (model_claim) must throw
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, {
      hypothesisId: 'H1',
      hypothesisStatus: 'CONFIRMED',
      evidence: { provenance: 'model_claim', claim: 'I believe this is fixed' },
    }),
    /cannot become CONFIRMED from untrusted provenance/i
  );

  // CONFIRMED with contradictory evidence must throw
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, {
      hypothesisId: 'H1',
      hypothesisStatus: 'CONFIRMED',
      evidence: { verified: false, contradictory: true },
    }),
    /cannot become CONFIRMED with contradictory or unverified evidence/i
  );

  // SCENARIO 30: ST-5 Verification Subtask Completion Guard
  // Establish the required upstream evidence before progressing the later stages.
  advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-1', status: 'IN_PROGRESS' });
  advanceTaskPlan(testStateMachinePlan, {
    subtaskId: 'ST-1',
    status: 'COMPLETED',
    outcome: 'Requirements and project discovery completed.',
    evidence: {
      types: ['REQUIREMENTS_ANALYSIS', 'PROJECT_DISCOVERY'],
      provenance: 'HOST_OBSERVED',
      requirementCount: 1,
      requestHash: 'request-hash',
    },
  });
  advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-2', status: 'IN_PROGRESS' });
  advanceTaskPlan(testStateMachinePlan, {
    subtaskId: 'ST-2',
    status: 'COMPLETED',
    outcome: 'Source inspected.',
    evidence: {
      types: ['SOURCE_INSPECTION'],
      provenance: 'HOST_SOURCE_INSPECTION',
      sourceEvidence: [{ path: 'src/example.ts', sourceHash: 'source-hash', lineRange: [1, 1] }],
    },
  });
  advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-3', status: 'IN_PROGRESS' });
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-3', status: 'COMPLETED', outcome: 'Diff prepared' }),
    /without structured evidence/i
  );
  advanceTaskPlan(testStateMachinePlan, {
    subtaskId: 'ST-3',
    status: 'COMPLETED',
    outcome: 'Diff prepared',
    evidence: {
      types: ['APPROVED_SCOPE_PROPOSAL'],
      proposalId: 'proposal-bound-1',
      targetFile: 'src/example.ts',
      snapshotHash: 'snapshot-hash',
      provenance: 'HOST_OBSERVED',
    },
  });
  advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-4', status: 'IN_PROGRESS' });
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, {
      subtaskId: 'ST-4',
      status: 'COMPLETED',
      outcome: 'Approved',
      evidence: {
        types: ['EXPLICIT_APPROVAL'],
        proposalId: 'another-proposal',
        approved: true,
        approvedTargets: ['src/example.ts'],
        provenance: 'HOST_OBSERVED',
      },
    }),
    /must bind to the proposal created in ST-3/i
  );
  advanceTaskPlan(testStateMachinePlan, {
    subtaskId: 'ST-4',
    status: 'COMPLETED',
    outcome: 'Approved',
    evidence: {
      types: ['EXPLICIT_APPROVAL'],
      proposalId: 'proposal-bound-1',
      approved: true,
      approvedTargets: ['src/example.ts'],
      provenance: 'HOST_OBSERVED',
    },
  });
  advanceTaskPlan(testStateMachinePlan, { subtaskId: 'ST-5', status: 'IN_PROGRESS' });
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, {
      subtaskId: 'ST-5',
      status: 'COMPLETED',
      outcome: 'Verification passed without evidence',
    }),
    /without structured evidence/i
  );

  // Attempting to complete ST-5 with failing test status must throw
  assert.throws(
    () => advanceTaskPlan(testStateMachinePlan, {
      subtaskId: 'ST-5',
      status: 'COMPLETED',
      outcome: 'Fake success',
      evidence: {
        types: ['VERIFICATION_PASS'],
        status: 'FAILED',
        exitCode: 1,
        isPassing: false,
        executed: false,
        proposalId: 'proposal-bound-1',
        attempts: [{ executed: false, exitCode: 1 }],
        provenance: 'HOST_TEST_RUNNER',
      },
    }),
    /without an executed passing verification result/i
  );

  // Authoritative passing verification transitions successfully
  advanceTaskPlan(testStateMachinePlan, {
    subtaskId: 'ST-5',
    status: 'COMPLETED',
    outcome: 'All tests passed truthfully',
    evidence: {
      types: ['VERIFICATION_PASS'],
      status: 'PASS',
      exitCode: 0,
      isPassing: true,
      executed: true,
      proposalId: 'proposal-bound-1',
      attempts: [{ executed: true, exitCode: 0 }],
      provenance: 'HOST_TEST_RUNNER',
    },
  });
  assert.equal(testStateMachinePlan.subtasks.find((s) => s.id === 'ST-5').status, 'COMPLETED');

  const askLifecyclePlan = createTaskPlan({
    userRequest: 'Explain the configured request entry point',
    requirements: analyzeTaskRequirements('Explain the configured request entry point'),
    operatingMode: 'ASK',
  });
  advanceTaskPlan(askLifecyclePlan, { subtaskId: 'ST-1', status: 'IN_PROGRESS' });
  advanceTaskPlan(askLifecyclePlan, {
    subtaskId: 'ST-1',
    status: 'COMPLETED',
    outcome: 'Requirements and project discovery completed.',
    evidence: {
      types: ['REQUIREMENTS_ANALYSIS', 'PROJECT_DISCOVERY'],
      requirementCount: 1,
      requestHash: 'ask-request-hash',
      provenance: 'HOST_OBSERVED',
    },
  });
  advanceTaskPlan(askLifecyclePlan, { subtaskId: 'ST-2', status: 'IN_PROGRESS' });
  advanceTaskPlan(askLifecyclePlan, {
    subtaskId: 'ST-2',
    status: 'COMPLETED',
    outcome: 'The request was investigated.',
    evidence: {
      types: ['SOURCE_INSPECTION'],
      sourceEvidence: [{ path: 'src/router.ts', sourceHash: 'router-hash', lineRange: [1, 10] }],
      provenance: 'HOST_SOURCE_INSPECTION',
      workItems: [{
        id: 'WI-001',
        evidence: {
          types: ['SOURCE_INSPECTION'],
          objective: askLifecyclePlan.workItems[0].objective,
          sourceEvidence: [{ path: 'src/router.ts', sourceHash: 'router-hash', lineRange: [1, 10] }],
          provenance: 'HOST_SOURCE_INSPECTION',
        },
      }],
    },
  });
  assert.equal(askLifecyclePlan.subtasks.find((item) => item.id === 'ST-2').status, 'COMPLETED');
  assert.equal(
    askLifecyclePlan.workItems[0].status,
    'BLOCKED',
    'Source-inspection evidence must not complete an explanation objective without a trusted item-specific verifier.',
  );
  assert.equal(
    askLifecyclePlan.status,
    'BLOCKED',
    'A plan with unresolved objective coverage must not aggregate to COMPLETED.',
  );

  const cancelledPlan = createTaskPlan({
    userRequest: 'Investigate the request handler',
    requirements: analyzeTaskRequirements('Investigate the request handler'),
    operatingMode: 'ASK',
  });
  advanceTaskPlan(cancelledPlan, { subtaskId: 'ST-1', status: 'IN_PROGRESS' });
  advanceTaskPlan(cancelledPlan, {
    subtaskId: 'ST-1',
    status: 'COMPLETED',
    outcome: 'Requirements and project discovery completed.',
    evidence: {
      types: ['REQUIREMENTS_ANALYSIS', 'PROJECT_DISCOVERY'],
      requirementCount: 1,
      requestHash: 'cancel-request-hash',
      provenance: 'HOST_OBSERVED',
    },
  });
  advanceTaskPlan(cancelledPlan, { subtaskId: 'ST-2', status: 'IN_PROGRESS' });
  advanceTaskPlan(cancelledPlan, { subtaskId: 'ST-2', status: 'CANCELLED', outcome: 'User cancelled.' });
  assert.equal(cancelledPlan.workItems[0].status, 'CANCELLED');
  assert.equal(cancelledPlan.status, 'CANCELLED');
  assert.throws(
    () => advanceTaskPlan(cancelledPlan, { subtaskId: 'ST-2', status: 'IN_PROGRESS' }),
    /Illegal subtask transition from CANCELLED/i
  );

  // SCENARIO 31: Bounded Verification-Failure Recovery with Actionable Repair
  const repairSessionId = 'session-repair-recovery-test';
  createSession(repairSessionId, ownerId);
  let attemptRunCount = 0;
  const repairWorkflowResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix the debug probe in FormController',
    root: projectModular,
    scope: '.',
    sessionId: repairSessionId,
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async (script, attempt) => {
      attemptRunCount += 1;
      if (attemptRunCount === 1) {
        // First check run fails with exit code 1
        return {
          ok: false,
          executed: true,
          exitCode: 1,
          stdout: '',
          stderr: 'AssertionError: probe still exists',
          failure: 'probe still exists',
        };
      }
      // Second run after repair passes
      return {
        ok: true,
        executed: true,
        exitCode: 0,
        stdout: 'Tests passed',
        stderr: '',
      };
    },
    tools: {
      autoRepairEnabled: true,
      maxRepairAttempts: 2,
      readFile: async (p) => {
        const full = path.join(projectModular, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async () => {
        return {
          results: [{ path: 'modules/personal/controllers/FormController.php', score: 10, line: 1 }],
        };
      },
      repairHandler: async ({ targetFile, failure, attempt }) => {
        assert.equal(failure.exitCode, 1);
        assert.ok(failure.stderr.includes('AssertionError'));
        const diskContent = await fs.readFile(path.join(projectModular, targetFile), 'utf8');
        const diskLines = diskContent.split(/\r?\n/);
        if (diskContent.endsWith('\n') && diskLines.at(-1) === '') diskLines.pop();
        const repairedContent = diskContent + '\n// Bounded repair verified\n';
        const repairedLines = repairedContent.split(/\r?\n/);
        if (repairedContent.endsWith('\n') && repairedLines.at(-1) === '') repairedLines.pop();
        return {
          patch: [
            `--- a/${targetFile.replace(/\\/g, '/')}`,
            `+++ b/${targetFile.replace(/\\/g, '/')}`,
            `@@ -1,${diskLines.length} +1,${repairedLines.length} @@`,
            ...diskLines.map((l) => `-${l}`),
            ...repairedLines.map((l) => `+${l}`),
            '',
          ].join('\n'),
        };
      },
    },
  });
  assert.equal(repairWorkflowResult.outcome, 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED');
  assert.equal(repairWorkflowResult.codeVerified, true);
  assert.equal(repairWorkflowResult.verificationStatus, 'PASS');
  assert.equal(repairWorkflowResult.taskPlan.status, 'BLOCKED');
  assert.equal(repairWorkflowResult.taskPlan.workItems[0].status, 'BLOCKED');
  assert.ok(attemptRunCount >= 2, 'Must have attempted repair and re-run verification');

  // SCENARIO 32: Repeated Identical Failure Stops the Loop (NO_PROGRESS)
  await fs.writeFile(
    path.join(projectModular, 'modules', 'personal', 'controllers', 'FormController.php'),
    `<?php
namespace app\\modules\\personal\\controllers;
use yii\\web\\Controller;

class FormController extends Controller {
    public function actionDebugProbe($id) {
        var_dump($_POST);
        die("DEBUG_PROBE_EXIT");
    }
}
`,
    'utf8'
  );
  const noProgressSessionId = 'session-repair-no-progress';
  createSession(noProgressSessionId, ownerId);
  const noProgressWorkflowResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix the debug probe in FormController with repeating failure',
    root: projectModular,
    scope: '.',
    sessionId: noProgressSessionId,
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => {
      return {
        ok: false,
        executed: true,
        exitCode: 1,
        stdout: '',
        stderr: 'SyntaxError: fatal duplicate failure',
        failure: 'fatal duplicate failure',
      };
    },
    tools: {
      autoRepairEnabled: true,
      maxRepairAttempts: 2,
      readFile: async (p) => {
        const full = path.join(projectModular, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async () => {
        return {
          results: [{ path: 'modules/personal/controllers/FormController.php', score: 10, line: 1 }],
        };
      },
      // Repeating identical patch returns null to prevent duplicate loop
      repairHandler: async ({ currentPatch }) => {
        return { patch: currentPatch }; // Identical patch rejected!
      },
    },
  });
  assert.equal(noProgressWorkflowResult.outcome, 'TEST_FAILED');
  assert.equal(noProgressWorkflowResult.codeVerified, false);

  // SCENARIO 33: Scope Expansion Rejection & Cancel Guard
  const scopeExpansionGov = manageRepairLoop({
    approvedTargets: ['modules/personal/controllers/FormController.php'],
    attemptCount: 0,
    maxAttempts: 2,
    autoRepairEnabled: true,
    proposedMutationTargets: [
      'modules/personal/controllers/FormController.php',
      'modules/unapproved/InjectedService.php',
    ],
  });
  assert.equal(scopeExpansionGov.allowRepair, false);
  assert.ok(/Scope expansion detected/i.test(scopeExpansionGov.reason));

  // SCENARIO 34: Generic Bug Investigation - Conditional Assignment Defect Fixed
  const customDefectFile = path.join(projectNode, 'src', 'controllers', 'Calculator.ts');
  await fs.writeFile(
    customDefectFile,
    `export class Calculator {\n    calculate(x: number, y: number) {\n        if (x = y) return 0;\n        return x + y;\n    }\n}\n`,
    'utf8'
  );

  const genericBugResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix conditional assignment defect in Calculator.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-generic-conditional-fix',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({ ok: true, executed: true, exitCode: 0, stdout: 'ok', stderr: '' }),
    tools: {
      readFile: async (p) => {
        const full = path.join(projectNode, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async () => ({
        results: [{ path: 'src/controllers/Calculator.ts', score: 10, line: 3 }],
      }),
    },
  });
  assert.ok(['SUCCESS', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(genericBugResult.outcome));
  assert.equal(genericBugResult.codeApplied, true);
  assert.equal(genericBugResult.codeVerified, true);
  const updatedCalculator = await fs.readFile(customDefectFile, 'utf8');
  assert.ok(updatedCalculator.includes('if (x === y)'));

  // SCENARIO 35: Generic Bug Investigation - Empty Catch Swallowed Exception Repaired
  const emptyCatchFile = path.join(projectNode, 'src', 'controllers', 'DataFetcher.ts');
  await fs.writeFile(
    emptyCatchFile,
    `export class DataFetcher {\n    async fetchData() {\n        try {\n            return await fetch('/api/data');\n        } catch (err) {}\n    }\n}\n`,
    'utf8'
  );

  const emptyCatchResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix swallowed exception in DataFetcher.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-generic-empty-catch-fix',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({ ok: true, executed: true, exitCode: 0, stdout: 'ok', stderr: '' }),
    tools: {
      readFile: async (p) => {
        const full = path.join(projectNode, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async () => ({
        results: [{ path: 'src/controllers/DataFetcher.ts', score: 10, line: 5 }],
      }),
    },
  });
  assert.ok(['SUCCESS', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(emptyCatchResult.outcome));
  assert.equal(emptyCatchResult.codeApplied, true);
  assert.equal(emptyCatchResult.codeVerified, true);
  const updatedDataFetcher = await fs.readFile(emptyCatchFile, 'utf8');
  assert.ok(updatedDataFetcher.includes('console.error(err)'));

  // SCENARIO 36: Dynamic custom patch synthesis hook works for arbitrary bug repair
  const arbitraryFile = path.join(projectPython, 'services', 'AuthValidator.py');
  await fs.writeFile(
    arbitraryFile,
    `def validate_token(token):\n    if not token:\n        return False\n    return token == "secret"\n`,
    'utf8'
  );

  const customSynthResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Update AuthValidator to support Bearer prefix',
    root: projectPython,
    scope: '.',
    sessionId: 'session-custom-synth',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({ ok: true, executed: true, exitCode: 0, stdout: 'ok', stderr: '' }),
    tools: {
      readFile: async (p) => {
        const full = path.join(projectPython, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
      searchCode: async () => ({
        results: [{ path: 'services/AuthValidator.py', score: 10, line: 1 }],
      }),
      findDefects: async () => [{
        symbol: 'validate_token',
        lines: '1-4',
        codeSnippet: 'return token == "secret"',
        controlFlow: 'Missing Bearer prefix validation in auth check',
        expected: 'Validates token with or without Bearer prefix',
        observed: 'Only exact secret match allowed',
        evidenceType: 'STATIC_INSPECTION_CONFIRMED',
      }],
      proposePatch: async ({ originalContent }) => {
        return originalContent.replace('token == "secret"', 'token.removeprefix("Bearer ").strip() == "secret"');
      },
    },
  });
  assert.ok(['SUCCESS', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(customSynthResult.outcome));
  assert.equal(customSynthResult.codeApplied, true);
  assert.equal(customSynthResult.codeVerified, true);
  const updatedAuth = await fs.readFile(arbitraryFile, 'utf8');
  assert.ok(updatedAuth.includes('token.removeprefix("Bearer ").strip() == "secret"'));

  // SCENARIO 37: V1 Intent signal extraction and exact symbol/path grounding
  const complexPrompt = 'Fix NullPointerException in src/services/PaymentProcessor.ts when calling /api/v1/checkout with empty payload';
  const decomposed = analyzeTaskRequirements(complexPrompt);
  assert.equal(decomposed.needsClarification, false);
  assert.deepEqual(decomposed.searchSignals.exactPaths, ['src/services/PaymentProcessor.ts']);
  assert.ok(decomposed.searchSignals.exactSymbols.includes('PaymentProcessor'));
  assert.ok(decomposed.searchSignals.routePaths.includes('/api/v1/checkout'));
  assert.ok(decomposed.searchSignals.errorSignals.includes('NullPointerException'));
  assert.equal(decomposed.domainTerms[0], 'src/services/PaymentProcessor.ts');

  // SCENARIO 38: Grounded search without hallucinating non-existent paths
  const missingContextPrompt = 'Fix issue in NonExistentModule.ts with missing function';
  const missingDecomposed = analyzeTaskRequirements(missingContextPrompt);
  assert.ok(missingDecomposed.domainTerms.includes('NonExistentModule.ts'));

  const searchMissing = await developerFiles.searchCode('NonExistentModule.ts', ownerId, '.');
  assert.equal(searchMissing.results.length, 0); // Must be strictly zero - no guessing or hallucinating files

  // SCENARIO 39: Strict evidence contract & anti-speculation gate
  const v2Defect = classifyDefect({
    filePath: 'src/services/billing.ts',
    symbol: 'chargeCard',
    lines: '14-16',
    codeSnippet: 'debugger;',
    controlFlow: 'Unintended debugger statement in billing execution path',
    expected: 'Clean card charge processing',
    observed: 'debugger;',
    evidenceType: 'STATIC_INSPECTION_CONFIRMED',
  });
  assert.equal(v2Defect.isConfirmed, true);
  assert.equal(v2Defect.classification, CLASSIFICATION_CONFIRMED);
  assert.deepEqual(v2Defect.lineRange, { startLine: 14, endLine: 16 });
  assert.equal(v2Defect.codeEvidence, 'debugger;');
  assert.ok(v2Defect.causalExplanation.length > 0);

  // Anti-speculation gate: reject ungrounded defects
  const uninspectedFileReport = validateEvidenceReport({
    inspectedFiles: ['src/services/auth.ts'],
    claimedDefects: [{
      filePath: 'src/services/uninspected.ts',
      lines: '1',
      codeSnippet: 'const x = null;',
      evidenceType: 'STATIC_INSPECTION_CONFIRMED',
    }],
  });
  assert.equal(uninspectedFileReport.isValid, false);
  assert.match(uninspectedFileReport.rejectionReason, /uninspected file/i);

  const emptyEvidenceReport = validateEvidenceReport({
    inspectedFiles: ['src/services/auth.ts'],
    claimedDefects: [{
      filePath: 'src/services/auth.ts',
      lines: '1',
      codeSnippet: '',
      evidenceType: 'STATIC_INSPECTION_CONFIRMED',
    }],
  });
  assert.equal(emptyEvidenceReport.isValid, false);
  assert.match(emptyEvidenceReport.rejectionReason, /lacks verified code evidence/i);

  const fabricatedSnippetReport = validateEvidenceReport({
    inspectedFiles: [{
      path: 'src/services/auth.ts',
      content: 'export function login() { return true; }',
      lineRange: { startLine: 1, endLine: 1 },
    }],
    claimedDefects: [{
      filePath: 'src/services/auth.ts',
      lines: '1',
      codeSnippet: 'this.nonExistentMethod()',
      evidenceType: 'STATIC_INSPECTION_CONFIRMED',
    }],
  });
  assert.equal(fabricatedSnippetReport.isValid, false);
  assert.match(fabricatedSnippetReport.rejectionReason, /does not match actual disk content/i);

  const outOfRangeReport = validateEvidenceReport({
    inspectedFiles: [{
      path: 'src/services/auth.ts',
      content: 'export function login() { return true; }',
      lineRange: { startLine: 1, endLine: 1 },
    }],
    claimedDefects: [{
      filePath: 'src/services/auth.ts',
      lines: '99',
      lineRange: { startLine: 99, endLine: 99 },
      codeSnippet: 'login()',
      evidenceType: 'STATIC_INSPECTION_CONFIRMED',
    }],
  });
  assert.equal(outOfRangeReport.isValid, false);
  assert.match(outOfRangeReport.rejectionReason, /outside inspected range/i);

  // Grounded defect matches inspected content and range
  const validGroundedReport = validateEvidenceReport({
    inspectedFiles: [{
      path: 'src/services/auth.ts',
      content: 'export function login() { debugger; return true; }',
      lineRange: { startLine: 1, endLine: 1 },
    }],
    claimedDefects: [{
      filePath: 'src/services/auth.ts',
      lines: '1',
      lineRange: { startLine: 1, endLine: 1 },
      codeSnippet: 'debugger;',
      evidenceType: 'STATIC_INSPECTION_CONFIRMED',
    }],
  });
  assert.equal(validGroundedReport.isValid, true);

  // SCENARIO 40: Multi-hop caller-to-callee tracing & error correlation
  const orderControllerContent = `import { calculateTax } from './taxService';
export function checkout(order) {
  return calculateTax(order.amount);
}`;
  const taxServiceContent = `export function calculateTax(amount) {
  debugger;
  return amount * 0.1;
}`;
  const multiHopResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Investigate order calculation failure in src/controllers/orderController.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-multi-hop-trace',
    ownerWebContentsId: ownerId,
    tools: {
      operatingMode: 'INVESTIGATE',
      readFile: async (p) => {
        if (p === 'src/controllers/orderController.ts') {
          return { content: orderControllerContent };
        }
        if (p === 'src/controllers/taxService.ts') {
          return { content: taxServiceContent };
        }
        throw new Error(`File not found: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: 'src/controllers/orderController.ts', score: 20, line: 1 }],
      }),
    },
  });
  assert.equal(multiHopResult.phase, 'INVESTIGATE');
  assert.equal(multiHopResult.outcome, 'INVESTIGATION_COMPLETED');
  assert.equal(multiHopResult.findings.length, 1);
  assert.equal(multiHopResult.findings[0].filePath, 'src/controllers/taxService.ts');
  assert.equal(multiHopResult.findings[0].symbol, 'debug_probe');
  assert.equal(multiHopResult.findings[0].codeEvidence, 'debugger;');
  assert.deepEqual(multiHopResult.findings[0].lineRange, { startLine: 2, endLine: 2 });
  assert.ok(multiHopResult.findings[0].causalExplanation.length > 0);
  assert.equal(multiHopResult.readOnlyPreserved, true);
  assert.equal(multiHopResult.codeApplied, false);

  // SCENARIO 41: Insufficient evidence handling (Anti-Speculation)
  const cleanMathContent = `export function add(a, b) {
  return a + b;
}`;
  const insufficientEvidenceResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Investigate race condition in src/utils/cleanMath.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-clean-anti-speculation',
    ownerWebContentsId: ownerId,
    tools: {
      operatingMode: 'INVESTIGATE',
      readFile: async () => ({
        content: cleanMathContent,
      }),
      searchCode: async () => ({
        results: [{ path: 'src/utils/cleanMath.ts', score: 10, line: 1 }],
      }),
    },
  });
  assert.equal(insufficientEvidenceResult.phase, 'INVESTIGATE');
  assert.ok(['NO_DEFECT_FOUND', 'INVESTIGATION_INCOMPLETE'].includes(insufficientEvidenceResult.outcome));
  assert.equal(insufficientEvidenceResult.findings.length, 0);
  assert.equal(insufficientEvidenceResult.codeApplied, false);

  // SCENARIO 42: Evidence-bound fix proposal contract verification
  const contractTest = validateProposalContract({
    targetFile: 'src/services/billing.ts',
    targetLineRange: { startLine: 14, endLine: 16 },
    rootCauseSummary: 'Unintended debugger statement in billing execution path',
    originalCode: 'debugger;',
    proposedCode: '',
    expectedBehavior: 'Removes debug probe to allow normal billing flow',
  }, {
    inspectedFiles: ['src/services/billing.ts'],
    verifiedFindings: [{ filePath: 'src/services/billing.ts' }],
  });
  assert.equal(contractTest.isValid, true);
  assert.equal(contractTest.targetFile, 'src/services/billing.ts');
  assert.deepEqual(contractTest.targetLineRange, { startLine: 14, endLine: 16 });

  // SCENARIO 43: Scope guard rejects uninspected files, unverified targets, and incomplete contracts
  const uninspectedScopeCheck = validatePatchScope({
    targetFiles: ['src/uninspected.ts'],
    inspectedFiles: ['src/inspected.ts'],
    verifiedFindings: [{ filePath: 'src/inspected.ts' }],
  });
  assert.equal(uninspectedScopeCheck.isValid, false);
  assert.equal(uninspectedScopeCheck.isMinimal, false);
  assert.match(uninspectedScopeCheck.rejectionReason, /uninspected file/i);

  const unverifiedScopeCheck = validatePatchScope({
    targetFiles: ['src/inspected.ts'],
    inspectedFiles: ['src/inspected.ts'],
    verifiedFindings: [{ filePath: 'src/other.ts' }],
  });
  assert.equal(unverifiedScopeCheck.isValid, false);
  assert.match(unverifiedScopeCheck.rejectionReason, /without verified defect/i);

  const incompleteContractCheck = validateProposalContract({
    targetFile: 'src/services/billing.ts',
    targetLineRange: { startLine: 1, endLine: 2 },
    rootCauseSummary: 'Bug',
    originalCode: 'bad()',
    proposedCode: 'good()',
    expectedBehavior: '', // Empty expected behavior
  });
  assert.equal(incompleteContractCheck.isValid, false);
  assert.match(incompleteContractCheck.rejectionReason, /expectedBehavior/i);

  // SCENARIO 44: Pre-approval write lock (Zero unauthorized filesystem mutations)
  const barrierFileRel = 'src/barrierTest.ts';
  const barrierFileAbs = path.join(projectNode, barrierFileRel);
  const initialBarrierContent = 'export function checkAuth(token: string) {\n  debugger;\n  return token.length > 0;\n}\n';
  await fs.writeFile(barrierFileAbs, initialBarrierContent, 'utf8');

  let observedDiskBeforeApproval = null;
  let receivedProposalContract = null;

  const preApprovalResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/barrierTest.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-pre-approval-lock',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async ({ proposalContract }) => {
      // Check disk state right at the approval boundary BEFORE any approval is given
      observedDiskBeforeApproval = await fs.readFile(barrierFileAbs, 'utf8');
      receivedProposalContract = proposalContract;
      return false; // User explicitly rejects approval
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === barrierFileRel || p.endsWith('barrierTest.ts')) {
          return { content: await fs.readFile(barrierFileAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: barrierFileRel, score: 20, line: 2 }],
      }),
    },
  });

  assert.equal(preApprovalResult.phase, 'APPROVE');
  assert.equal(preApprovalResult.outcome, 'APPROVAL_REJECTED');
  assert.equal(preApprovalResult.codeApplied, false);
  assert.deepEqual(preApprovalResult.filesModified, []);

  // 1. Verify proposal contract was generated and structured
  assert.ok(receivedProposalContract !== null);
  assert.equal(receivedProposalContract.targetFile, barrierFileRel);
  assert.equal(receivedProposalContract.originalCode.trim(), 'debugger;');
  assert.equal(receivedProposalContract.proposedCode, '');
  assert.ok(receivedProposalContract.expectedBehavior.length > 0);

  // 2. Verify disk was 100% byte-for-byte untouched at the approval gate
  assert.equal(observedDiskBeforeApproval, initialBarrierContent);

  // 3. Verify disk remains 100% byte-for-byte untouched after rejection
  const finalDiskContent = await fs.readFile(barrierFileAbs, 'utf8');
  assert.equal(finalDiskContent, initialBarrierContent);

    // SCENARIO 45: Scoped Surgical Apply & Preservation (Preserve unrelated work, CRLF line endings, and workspace)
  const surgicalRel = 'src/surgicalApplyTarget.ts';
  const surgicalAbs = path.join(projectNode, surgicalRel);
  // CRLF line endings, unrelated header lines 1-3, defect on lines 4-6, unrelated trailing lines 7-9
  const initialSurgicalContent = 'import { config } from "./config";\r\n// Unrelated work at top\r\nexport function calculate(val: number) {\r\n  debugger;\r\n  return val * 2;\r\n}\r\n// Unrelated work at bottom\r\nexport const VERSION = "1.0.0";\r\n';
  await fs.writeFile(surgicalAbs, initialSurgicalContent, 'utf8');

  // Untracked / dirty workspace files
  const untrackedRel = 'notes/draft.txt';
  const untrackedAbs = path.join(projectNode, untrackedRel);
  await fs.mkdir(path.dirname(untrackedAbs), { recursive: true });
  const initialUntrackedContent = 'Important untracked developer notes\nDo not delete\n';
  await fs.writeFile(untrackedAbs, initialUntrackedContent, 'utf8');

  const dirtyWorkerRel = 'src/worker.ts';
  const dirtyWorkerAbs = path.join(projectNode, dirtyWorkerRel);
  const initialDirtyWorkerContent = 'export function worker() { return "in-flight edits"; }\n';
  await fs.writeFile(dirtyWorkerAbs, initialDirtyWorkerContent, 'utf8');

  const surgicalResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/surgicalApplyTarget.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-surgical-apply-v4',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({ ok: true, status: 'PASS', executed: true, exitCode: 0, stdout: 'ok', stderr: '' }),
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === surgicalRel || p.endsWith('surgicalApplyTarget.ts')) {
          return { content: await fs.readFile(surgicalAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: surgicalRel, score: 30, line: 4 }],
      }),
    },
  });

  assert.equal(surgicalResult.phase, 'AUDIT');
  assert.ok(['SUCCESS', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(surgicalResult.outcome));
  assert.equal(surgicalResult.codeApplied, true);
  assert.deepEqual(surgicalResult.filesModified, [surgicalRel]);

  // Verify disk content of modified file
  const modifiedContent = await fs.readFile(surgicalAbs, 'utf8');
  assert.ok(!modifiedContent.includes('debugger;'));
  assert.ok(modifiedContent.includes('// Unrelated work at top'));
  assert.ok(modifiedContent.includes('// Unrelated work at bottom'));
  assert.ok(modifiedContent.includes('\r\n'), 'Original CRLF line endings must be preserved');

  // Verify untracked and dirty files in workspace are 100% byte-for-byte untouched
  const finalUntracked = await fs.readFile(untrackedAbs, 'utf8');
  assert.equal(finalUntracked, initialUntrackedContent);
  const finalDirtyWorker = await fs.readFile(dirtyWorkerAbs, 'utf8');
  assert.equal(finalDirtyWorker, initialDirtyWorkerContent);

  // SCENARIO 46: Post-Approval Scope Lock (Block unapproved files and hunks outside targetLineRange)
  const lockedProposalContract = {
    targetFile: surgicalRel,
    targetLineRange: { startLine: 4, endLine: 6 },
    rootCauseSummary: 'Remove debugger probe',
    originalCode: '  debugger;\n',
    proposedCode: '',
    expectedBehavior: 'Removes debug statement',
  };

  // 1. Direct contract scope validation: Unapproved files rejected with APPLY_SCOPE_VIOLATION
  const scopeExpansionCheck = validateApplyScope({
    proposalContract: lockedProposalContract,
    mutationTargets: [surgicalRel, 'src/unauthorizedMutation.ts'],
    userApproved: true,
  });
  assert.equal(scopeExpansionCheck.allowed, false);
  assert.equal(scopeExpansionCheck.code, 'APPLY_SCOPE_VIOLATION');
  assert.match(scopeExpansionCheck.rejectionReason, /APPLY_SCOPE_VIOLATION/);
  assert.match(scopeExpansionCheck.rejectionReason, /unauthorizedMutation\.ts/);

  // 2. Unapproved hunk outside targetLineRange rejected with APPLY_SCOPE_VIOLATION
  const outOfRangeHunkCheck = validateApplyScope({
    proposalContract: lockedProposalContract,
    mutationTargets: [surgicalRel],
    userApproved: true,
    patchHunks: [{ oldStart: 95, oldCount: 5 }],
  });
  assert.equal(outOfRangeHunkCheck.allowed, false);
  assert.equal(outOfRangeHunkCheck.code, 'APPLY_SCOPE_VIOLATION');
  assert.match(outOfRangeHunkCheck.rejectionReason, /outside approved line range/i);

  // 3. Unapproved application without user approval rejected
  const unapprovedCheck = validateApplyScope({
    proposalContract: lockedProposalContract,
    mutationTargets: [surgicalRel],
    userApproved: false,
  });
  assert.equal(unapprovedCheck.allowed, false);
  assert.match(unapprovedCheck.rejectionReason, /explicit user approval/i);

  // SCENARIO 47: Pre-Apply Drift Guard & Preservation (Detect external edits and abort safely)
  const driftRel = 'src/driftProtectedTarget.ts';
  const driftAbs = path.join(projectNode, driftRel);
  const initialDriftContent = 'export function processPayment(amount: number) {\n  debugger;\n  return amount > 0;\n}\n';
  await fs.writeFile(driftAbs, initialDriftContent, 'utf8');

  let diskModifiedExternally = false;
  const externalConcurrentEdit = 'export function processPayment(amount: number) {\n  // CONCURRENT USER EDIT: do not overwrite\n  return amount > 0;\n}\n';

  const driftResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/driftProtectedTarget.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-drift-guard-v4',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => {
      // Simulate external concurrent user edit right before approval is processed
      await fs.writeFile(driftAbs, externalConcurrentEdit, 'utf8');
      diskModifiedExternally = true;
      return true;
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === driftRel || p.endsWith('driftProtectedTarget.ts')) {
          return { content: diskModifiedExternally ? externalConcurrentEdit : initialDriftContent };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: driftRel, score: 30, line: 2 }],
      }),
    },
  });

  // Verify apply engine aborted safely with APPLY_FAILED due to STALE_PROPOSAL_DRIFT
  assert.equal(driftResult.phase, 'IMPLEMENT');
  assert.equal(driftResult.outcome, 'APPLY_FAILED');
  assert.equal(driftResult.codeApplied, false);
  assert.equal(driftResult.driftDetected, true);
  assert.match(driftResult.error, /STALE_PROPOSAL_DRIFT/i);

  // Verify external user edit was 100% preserved on disk and NOT overwritten
  const finalDriftDisk = await fs.readFile(driftAbs, 'utf8');
  assert.equal(finalDriftDisk, externalConcurrentEdit);

    // SCENARIO 48: Verified Pass Reporting with Structured VerificationEvidence (V5)
  const passRel = 'src/verifiedPassTarget.ts';
  const passAbs = path.join(projectNode, passRel);
  const initialPassContent = 'export function calculateDiscount(price: number) {\n  debugger;\n  return price * 0.9;\n}\n';
  await fs.writeFile(passAbs, initialPassContent, 'utf8');

  const passWorkflowResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/verifiedPassTarget.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-v5-verified-pass',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({
      ok: true,
      status: 'PASS',
      executed: true,
      exitCode: 0,
      stdout: 'PASS test/verifiedPassTarget.test.ts\nAll 4 tests passed.',
      stderr: '',
    }),
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === passRel || p.endsWith('verifiedPassTarget.ts')) {
          return { content: await fs.readFile(passAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: passRel, score: 30, line: 2 }],
      }),
    },
  });

  assert.equal(passWorkflowResult.codeApplied, true);
  assert.equal(passWorkflowResult.codeVerified, true);
  assert.ok(Array.isArray(passWorkflowResult.verificationEvidence));
  assert.ok(passWorkflowResult.verificationEvidence.length > 0);
  const firstEvidence = passWorkflowResult.verificationEvidence[0];
  assert.equal(firstEvidence.exitCode, 0);
  assert.equal(firstEvidence.status, 'PASSED');
  assert.ok(firstEvidence.stdoutSummary.includes('All 4 tests passed.'));
  assert.equal(firstEvidence.failureDiagnostics, null);

  // SCENARIO 49: Failure Evidence Extraction & Honest Reporting (V5)
  const failRel = 'src/failureTarget.ts';
  const failAbs = path.join(projectNode, failRel);
  const initialFailContent = 'export function checkout(order: any) {\n  debugger;\n  return order.total;\n}\n';
  await fs.writeFile(failAbs, initialFailContent, 'utf8');

  const failWorkflowResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/failureTarget.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-v5-failure-evidence',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({
      ok: false,
      status: 'FAIL',
      executed: true,
      exitCode: 1,
      stdout: 'FAIL test/failureTarget.test.ts\n● checkout › should apply discount\n  AssertionError: expected 90 to equal 100\n    at Object.<anonymous> (test/failureTarget.test.ts:42:15)',
      stderr: 'Test execution failed with non-zero exit code',
      error: 'AssertionError: expected 90 to equal 100',
    }),
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === failRel || p.endsWith('failureTarget.ts')) {
          return { content: await fs.readFile(failAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: failRel, score: 30, line: 2 }],
      }),
    },
  });

  assert.equal(failWorkflowResult.outcome, 'TEST_FAILED');
  assert.equal(failWorkflowResult.codeVerified, false);
  assert.ok(failWorkflowResult.failureDiagnostics !== null);
  assert.ok(
    failWorkflowResult.failureDiagnostics.assertionErrors.some((e) => e.includes('expected 90 to equal 100')),
    'Must capture exact assertion failure message'
  );
  assert.ok(
    failWorkflowResult.failureDiagnostics.failingTests.some((t) => t.includes('checkout › should apply discount')),
    'Must extract failing test suite/name'
  );
  assert.ok(
    failWorkflowResult.failureDiagnostics.stackFrames.some((f) => f.file.includes('failureTarget.test.ts') && f.line === 42),
    'Must extract failing file and line number from stack trace'
  );

  // SCENARIO 50: Ironclad Anti-False-Success Gate (Reject vacuous passes & enforce honest status)
  // 1. Contract rejects claimed PASSED without real execution
  const unexecutedPassCheck = validateEvidenceReport({
    claimedVerification: 'PASSED',
    executionAuditLog: { executed: false, exitCode: 0, attempts: [] },
  });
  assert.equal(unexecutedPassCheck.isValid, false);
  assert.match(unexecutedPassCheck.rejectionReason, /not actually executed/i);

  // 2. Contract rejects claimed PASSED with non-zero exit code
  const nonZeroPassCheck = validateEvidenceReport({
    claimedVerification: 'PASSED',
    executionAuditLog: { executed: true, exitCode: 2, attempts: [{ ok: false, exitCode: 2 }] },
  });
  assert.equal(nonZeroPassCheck.isValid, false);
  assert.match(nonZeroPassCheck.rejectionReason, /non-zero/i);

  // 3. Contract rejects claimed PASSED with zero executed attempts (vacuous pass)
  const zeroAttemptsCheck = validateEvidenceReport({
    claimedVerification: 'PASSED',
    executionAuditLog: { executed: true, exitCode: 0, attempts: [] },
  });
  assert.equal(zeroAttemptsCheck.isValid, false);
  assert.match(zeroAttemptsCheck.rejectionReason, /zero executed verification attempts/i);

  // 4. Contract rejects claimed PASSED when an attempt failed
  const failedAttemptCheck = validateEvidenceReport({
    claimedVerification: 'PASSED',
    executionAuditLog: { executed: true, exitCode: 0, attempts: [{ ok: false, exitCode: 1 }] },
  });
  assert.equal(failedAttemptCheck.isValid, false);
  assert.match(failedAttemptCheck.rejectionReason, /one or more verification attempts failed/i);

  // 5. Workflow integration: Offline/unverified execution reports VERIFICATION_UNAVAILABLE without claiming success
  const unverifiedWorkflowResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/barrierTest.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-v5-unverified-gate',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: null, // No verification runner available
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === 'src/barrierTest.ts') {
          return { content: await fs.readFile(barrierFileAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: 'src/barrierTest.ts', score: 30, line: 2 }],
      }),
    },
  });

  assert.equal(unverifiedWorkflowResult.outcome, 'VERIFICATION_UNAVAILABLE');
  assert.equal(unverifiedWorkflowResult.codeVerified, false);
  assert.equal(unverifiedWorkflowResult.verificationStatus, 'VERIFICATION_UNAVAILABLE');

  // SCENARIO 51: Full E2E Happy Path (V1 -> V6)
  const e2eRel = 'src/e2eTarget.ts';
  const e2eAbs = path.join(projectNode, e2eRel);
  const initialE2EContent = '// E2E target module\r\nexport function processData(input: string) {\r\n  debugger;\r\n  return input.toUpperCase();\r\n}\r\n';
  await fs.writeFile(e2eAbs, initialE2EContent, 'utf8');

  const e2eResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe crash in src/e2eTarget.ts: runtime exit encountered at line 3',
    root: projectNode,
    scope: '.',
    sessionId: 'session-v6-e2e-happy-path',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({
      ok: true,
      status: 'PASS',
      executed: true,
      exitCode: 0,
      stdout: 'PASS test/e2eTarget.test.ts\nprocessData transforms input correctly',
      stderr: '',
    }),
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === e2eRel || p.endsWith('e2eTarget.ts')) {
          return { content: await fs.readFile(e2eAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: e2eRel, score: 35, line: 3 }],
      }),
    },
  });

  assert.ok(['SUCCESS', 'COMPLETED', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(e2eResult.outcome));
  assert.equal(e2eResult.codeApplied, true);
  assert.equal(e2eResult.codeVerified, true);
  assert.deepEqual(e2eResult.filesModified, [e2eRel]);

  // Validate canonical workflowReceipt
  assert.ok(e2eResult.workflowReceipt, 'Must emit canonical workflowReceipt');
  const receipt51Validation = validateWorkflowReceipt(e2eResult.workflowReceipt);
  assert.equal(receipt51Validation.isValid, true, 'Receipt must be valid');
  assert.ok(e2eResult.workflowReceipt.stagesCompleted.includes('APPLY'));
  assert.ok(e2eResult.workflowReceipt.stagesCompleted.includes('VERIFY'));
  assert.equal(e2eResult.workflowReceipt.rootCause.filePath, e2eRel);
  assert.equal(e2eResult.workflowReceipt.approvedProposal.targetFile, e2eRel);
  assert.equal(e2eResult.workflowReceipt.verificationReport.ok, true);
  assert.equal(e2eResult.workflowReceipt.verificationReport.exitCode, 0);
  assert.equal(e2eResult.workflowReceipt.rolledBack, false);

  // Verify disk content: debug probe removed, CRLF preserved
  const e2eModifiedContent = await fs.readFile(e2eAbs, 'utf8');
  assert.ok(!e2eModifiedContent.includes('debugger;'));
  assert.ok(e2eModifiedContent.includes('// E2E target module'));
  assert.ok(e2eModifiedContent.includes('\r\n'), 'CRLF line endings must be preserved');

  // SCENARIO 52: Two-Phase Pause & Resume Approval Flow
  const pauseRel = 'src/pauseResumeTarget.ts';
  const pauseAbs = path.join(projectNode, pauseRel);
  const initialPauseContent = 'export function calculateTax(amount: number) {\n  debugger;\n  return amount * 0.15;\n}\n';
  await fs.writeFile(pauseAbs, initialPauseContent, 'utf8');

  // Phase 1: Call without approval callback -> must pause cleanly at APPROVAL_REQUIRED (0 disk writes)
  const phase1Result = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/pauseResumeTarget.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-v6-pause-resume',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: null, // No approval provided!
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === pauseRel || p.endsWith('pauseResumeTarget.ts')) {
          return { content: await fs.readFile(pauseAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: pauseRel, score: 30, line: 2 }],
      }),
    },
  });

  assert.equal(phase1Result.outcome, 'APPROVAL_REQUIRED');
  assert.equal(phase1Result.phase, 'APPROVE');
  assert.equal(phase1Result.codeApplied, false);
  assert.deepEqual(phase1Result.filesModified, []);
  assert.ok(phase1Result.continuationToken, 'Must provide continuationToken for resumption');
  assert.ok(phase1Result.workflowReceipt, 'Must emit receipt even on pause');
  assert.deepEqual(
    phase1Result.workflowReceipt.stagesCompleted,
    ['UNDERSTAND', 'DISCOVER', 'INVESTIGATE', 'PLAN', 'APPROVE']
  );

  // Verify disk was 100% byte-for-byte untouched during Phase 1
  const diskAfterPhase1 = await fs.readFile(pauseAbs, 'utf8');
  assert.equal(diskAfterPhase1, initialPauseContent);

  // Phase 2: Resume with continuationToken and userApproved: true
  const phase2Result = await executeAutonomousCodingWorkflow({
    continuationToken: phase1Result.continuationToken,
    root: projectNode,
    sessionId: 'session-v6-pause-resume',
    ownerWebContentsId: ownerId,
    userApproved: true,
    runCheck: async () => ({
      ok: true,
      status: 'PASS',
      executed: true,
      exitCode: 0,
      stdout: 'PASS test/pauseResumeTarget.test.ts',
      stderr: '',
    }),
  });

  assert.ok(['SUCCESS', 'COMPLETED', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(phase2Result.outcome));
  assert.equal(phase2Result.codeApplied, true);
  assert.equal(phase2Result.codeVerified, true);
  assert.deepEqual(phase2Result.filesModified, [pauseRel]);
  assert.ok(phase2Result.workflowReceipt);
  assert.equal(validateWorkflowReceipt(phase2Result.workflowReceipt).isValid, true);
  assert.ok(phase2Result.workflowReceipt.stagesCompleted.includes('VERIFY'));

  // Verify disk was modified after Phase 2 approval
  const diskAfterPhase2 = await fs.readFile(pauseAbs, 'utf8');
  assert.ok(!diskAfterPhase2.includes('debugger;'));
  assert.ok(diskAfterPhase2.includes('return amount * 0.15;'));

  // SCENARIO 53: E2E Verification Failure & Atomic Rollback
  const rollbackRel = 'src/rollbackTarget.ts';
  const rollbackAbs = path.join(projectNode, rollbackRel);
  const initialRollbackContent = 'export function calculateTotal(items: any[]) {\n  debugger;\n  return items.length;\n}\n';
  await fs.writeFile(rollbackAbs, initialRollbackContent, 'utf8');

  const untrackedNotesRel = 'notes/userNotes.txt';
  const untrackedNotesAbs = path.join(projectNode, untrackedNotesRel);
  await fs.mkdir(path.dirname(untrackedNotesAbs), { recursive: true });
  const initialUntrackedNotes = 'Critical user notes that must never be rolled back\n';
  await fs.writeFile(untrackedNotesAbs, initialUntrackedNotes, 'utf8');

  const dirtyWorkerRel2 = 'src/unrelatedDirtyWorker.ts';
  const dirtyWorkerAbs2 = path.join(projectNode, dirtyWorkerRel2);
  const initialDirtyWorker2 = 'export const IN_PROGRESS_WORK = 42;\n';
  await fs.writeFile(dirtyWorkerAbs2, initialDirtyWorker2, 'utf8');

  const rollbackResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debug probe in src/rollbackTarget.ts',
    root: projectNode,
    scope: '.',
    sessionId: 'session-v6-verification-rollback',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({
      ok: false,
      status: 'FAIL',
      executed: true,
      exitCode: 1,
      stdout: 'FAIL test/rollbackTarget.test.ts\n● calculateTotal › should return correct count\n  AssertionError: expected 0 to equal 5',
      stderr: 'Test verification failed with non-zero exit code',
      error: 'AssertionError: expected 0 to equal 5',
    }),
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p === rollbackRel || p.endsWith('rollbackTarget.ts')) {
          return { content: await fs.readFile(rollbackAbs, 'utf8') };
        }
        throw new Error(`Unexpected file read: ${p}`);
      },
      searchCode: async () => ({
        results: [{ path: rollbackRel, score: 30, line: 2 }],
      }),
    },
  });

  assert.equal(rollbackResult.outcome, 'TEST_FAILED');
  assert.equal(rollbackResult.rolledBack, true, 'Target file must be recorded as rolled back');
  assert.equal(rollbackResult.codeApplied, false, 'Rollback means no change remains applied');
  assert.equal(rollbackResult.codeVerified, false);
  assert.ok(rollbackResult.failureDiagnostics, 'Must preserve failure diagnostics on rollback');
  assert.ok(rollbackResult.failureDiagnostics.assertionErrors.some((e) => e.includes('expected 0 to equal 5')));

  // Verify disk content of rollbackTarget: byte-for-byte restored to pre-apply content!
  const finalRollbackDisk = await fs.readFile(rollbackAbs, 'utf8');
  assert.equal(finalRollbackDisk, initialRollbackContent, 'Target file must be atomically restored to exact pre-apply bytes');

  // Verify unrelated untracked notes and dirty worker are completely untouched!
  const finalUntrackedNotes = await fs.readFile(untrackedNotesAbs, 'utf8');
  assert.equal(finalUntrackedNotes, initialUntrackedNotes, 'Untracked files must remain untouched');
  const finalDirtyWorker2 = await fs.readFile(dirtyWorkerAbs2, 'utf8');
  assert.equal(finalDirtyWorker2, initialDirtyWorker2, 'Unrelated dirty files must remain untouched');

  // Verify receipt reflects rollback and failures truthfully
  assert.ok(rollbackResult.workflowReceipt);
  assert.equal(rollbackResult.workflowReceipt.rolledBack, true);
  assert.equal(rollbackResult.workflowReceipt.verificationReport.ok, false);
  assert.equal(rollbackResult.workflowReceipt.verificationReport.exitCode, 1);
  assert.equal(validateWorkflowReceipt(rollbackResult.workflowReceipt).isValid, true);

  // SCENARIO 54: Dynamic Symbol + Action Intent Prioritizes Controller Declaration and Slices Enclosing Function Block (V7)
  const v7HinglishRequest = 'admissionOffers me action me kiya buge hai';
  const reqAnalysis = analyzeTaskRequirements(v7HinglishRequest);
  assert.ok(reqAnalysis.searchSignals.structuralIntent.includes('action'), 'Must detect structural intent "action"');
  assert.ok(reqAnalysis.searchSignals.exactSymbols.some((s) => s.toLowerCase().includes('admissionoffers')), 'Must capture admissionOffers');
  assert.ok(reqAnalysis.searchSignals.exactSymbols.includes('actionAdmissionOffers'), 'Must synthesize actionAdmissionOffers convention variant');

  // Verify searchCode scoring prioritizes Controller declaration over View template
  const v7ProjectDir = path.join(testRoot, 'v7-target-project');
  await fs.mkdir(path.join(v7ProjectDir, 'controllers'), { recursive: true });
  await fs.mkdir(path.join(v7ProjectDir, 'views', 'admission-offers'), { recursive: true });

  const controllerRel = 'controllers/DashboardController.php';
  const controllerAbs = path.join(v7ProjectDir, controllerRel);
  const controllerPhpContent = '<?php\nnamespace app\\controllers;\n\nclass DashboardController extends Controller\n{\n    public function actionAdmissionOffers()\n    {\n        $offers = AdmissionOffer::find()->all();\n        if ($offers = null) {\n            return false;\n        }\n        return $this->render(\'index\', [\'offers\' => $offers]);\n    }\n}\n';
  await fs.writeFile(controllerAbs, controllerPhpContent, 'utf8');

  const viewRel = 'views/admission-offers/index.php';
  const viewAbs = path.join(v7ProjectDir, viewRel);
  const viewPhpContent = '<?php\n/* @var $this yii\\web\\View */\n/* @var $offers app\\models\\AdmissionOffer[] */\n?>\n<div class="admission-offers-index">\n    <h1>Admission Offers</h1>\n</div>\n';
  await fs.writeFile(viewAbs, viewPhpContent, 'utf8');

  // Function slicing verification: signature to closing brace bounded
  const slicedBlock = extractEnclosingFunctionBlock(controllerPhpContent, 9);
  assert.equal(slicedBlock.bounded, true);
  assert.ok(slicedBlock.extractedCode.includes('public function actionAdmissionOffers()'));
  assert.ok(slicedBlock.extractedCode.includes('return $this->render('));

  console.log('[TEST] Scenario 54 passed: Dynamic symbol & action intent prioritizes declaration and slices function block.');

  // SCENARIO 55: Token Budget Compaction & 429 Remaining-Quota Retry (V7)
  let retryOccurred = false;
  let callCount = 0;
  const mock429WithRemaining = async (payload) => {
    callCount += 1;
    if (callCount === 1) {
      // First attempt triggers 429 with remaining quota
      const err = new Error('Resource has been exhausted (e.g. check quota). HTTP 429: Rate limit reached for requests... Limit: 8000, Used: 5020, Requested: 3250');
      throw err;
    }
    // Second attempt (retry) receives ultra-compact payload and succeeds!
    retryOccurred = true;
    assert.ok(payload.sourceEvidence.length > 0);
    const totalChars = payload.sourceEvidence.reduce((acc, e) => acc + (e.excerpt?.length || 0), 0);
    assert.ok(totalChars <= 2400, `Compacted retry payload must be small (got ${totalChars} chars)`);
    return {
      findings: [
        {
          findingId: payload.findings[0].findingId,
          decision: 'SUPPORTED',
          relationship: 'Conditional assignment defect confirmed in admission offers action',
          evidenceIds: [payload.sourceEvidence.find((e) => e.path === payload.findings[0].filePath)?.evidenceId || payload.sourceEvidence[0].evidenceId],
          contradictionEvidenceIds: [],
          unresolvedAssumptions: [],
        },
      ],
    };
  };

  const scenario55Result = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix conditional assignment in controllers/DashboardController.php',
    root: v7ProjectDir,
    scope: '.',
    sessionId: 'session-v7-quota-retry',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mock429WithRemaining,
    requestApproval: null, // Pause at approval
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p.includes('DashboardController.php')) {
          return { content: controllerPhpContent };
        }
        return { content: viewPhpContent };
      },
      searchCode: async () => ({
        results: [
          { path: controllerRel, score: 320, line: 9 },
          { path: viewRel, score: 80, line: 1 },
        ],
      }),
    },
  });

  assert.equal(retryOccurred, true, 'Must retry on 429 when remaining quota exists');
  assert.equal(scenario55Result.outcome, 'APPROVAL_REQUIRED');
  assert.equal(scenario55Result.phase, 'APPROVE');
  assert.ok(scenario55Result.findings.length > 0);

  console.log('[TEST] Scenario 55 passed: Token budget compaction and 429 remaining-quota retry verified.');

  // SCENARIO 56: Total Provider Quota Exhaustion Continuity (Local Grounded Diagnosis) (V7)
  const mock429Exhausted = async () => {
    throw new Error('PROVIDER_QUOTA_EXHAUSTED: HTTP 429 Tokens Per Day (TPD) limit exceeded. Limit: 8000, Used: 8000, Requested: 850');
  };

  const scenario56Result = await executeAutonomousCodingWorkflow({
    userRequest: 'Investigate and repair bug in controllers/DashboardController.php',
    root: v7ProjectDir,
    scope: '.',
    sessionId: 'session-v7-quota-exhausted-local',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mock429Exhausted,
    requestApproval: null, // Pause at approval
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p.includes('DashboardController.php')) {
          return { content: controllerPhpContent };
        }
        return { content: viewPhpContent };
      },
      searchCode: async () => ({
        results: [
          { path: controllerRel, score: 320, line: 9 },
        ],
      }),
    },
  });

  // Must not fail with INVESTIGATION_INCOMPLETE or "no authoritative response"
  assert.notEqual(scenario56Result.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(scenario56Result.outcome, 'APPROVAL_REQUIRED');
  assert.ok(scenario56Result.findings.length > 0, 'Must preserve grounded static findings');
  assert.equal(scenario56Result.findings[0].filePath, controllerRel);
  assert.equal(scenario56Result.providerQuotaExhausted, true);
  assert.ok(scenario56Result.proposal, 'Must generate fix proposal from grounded local findings');

  console.log('[TEST] Scenario 56 passed: Total provider quota exhaustion preserves grounded local diagnosis and proposal.');

  // SCENARIO 57: Universal Call-Graph & Cross-File Contract Verification (2nd-Hop Render & Callee Resolution) (V8)
  const v8ProjectDir = path.join(testRoot, 'v8-contract-verification-project');
  const v8ControllersDir = path.join(v8ProjectDir, 'controllers');
  const v8ViewsDir = path.join(v8ProjectDir, 'views', 'admission-offers');
  const v8ModelsDir = path.join(v8ProjectDir, 'models');
  await fs.mkdir(v8ControllersDir, { recursive: true });
  await fs.mkdir(v8ViewsDir, { recursive: true });
  await fs.mkdir(v8ModelsDir, { recursive: true });

  const offerControllerContent = `<?php
namespace app\\controllers;

use yii\\web\\Controller;

class AdmissionOffersController extends Controller
{
    public function actionIndex()
    {
        $offers = AdmissionOffer::find()->all();
        dd($offers);
        return $this->render('index', [
            'admissionOffers' => $offers,
        ]);
    }
}
`;
  const offerViewContent = `<?php
/** @var array $admissionOffers */
?>
<div class="admission-offers-index">
    <h1>Admission Offers</h1>
    <?php foreach ($admissionOffers as $offer): ?>
        <p><?= htmlspecialchars($offer['title']) ?></p>
    <?php endforeach; ?>
</div>
`;
  const offerModelContent = `<?php
namespace app\\models;

class AdmissionOffer
{
    public static function find()
    {
        return new self();
    }
}
`;

  const offerControllerPath = path.join(v8ControllersDir, 'AdmissionOffersController.php');
  const offerViewPath = path.join(v8ViewsDir, 'index.php');
  const offerModelPath = path.join(v8ModelsDir, 'AdmissionOffer.php');
  await fs.writeFile(offerControllerPath, offerControllerContent, 'utf8');
  await fs.writeFile(offerViewPath, offerViewContent, 'utf8');
  await fs.writeFile(offerModelPath, offerModelContent, 'utf8');

  const offerCtrlRel = path.relative(v8ProjectDir, offerControllerPath).replace(/\\/g, '/');
  const offerViewRel = path.relative(v8ProjectDir, offerViewPath).replace(/\\/g, '/');
  const offerModelRel = path.relative(v8ProjectDir, offerModelPath).replace(/\\/g, '/');

  // Verify traceExecutionFlow extracts renderTargets and outboundCallees generically
  const traceOffer = traceExecutionFlow({
    route: offerCtrlRel,
    controllerFile: offerCtrlRel,
    controllerContent: offerControllerContent,
  });
  assert.ok(Array.isArray(traceOffer.layers.renderTargets), 'renderTargets must be an array');
  assert.ok(traceOffer.layers.renderTargets.includes('index'), 'Must generically extract render target "index"');
  assert.ok(Array.isArray(traceOffer.layers.outboundCallees), 'outboundCallees must be an array');
  assert.ok(traceOffer.layers.outboundCallees.some((c) => c.target === 'AdmissionOffer'), 'Must extract outbound callee symbol AdmissionOffer');

  // Run autonomous workflow to verify 2nd-hop bounded read of both Caller and Callee/View
  const scenario57Result = await executeAutonomousCodingWorkflow({
    userRequest: 'AdmissionOffersController me kiya bug hai check karo',
    root: v8ProjectDir,
    scope: '.',
    sessionId: 'session-v8-call-graph-verification',
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: null, // Halt at approval gate
    tools: {
      operatingMode: 'AUTONOMOUS',
      readFile: async (p) => {
        if (p.includes('AdmissionOffersController.php')) return { content: offerControllerContent };
        if (p.includes('index.php')) return { content: offerViewContent };
        if (p.includes('AdmissionOffer.php')) return { content: offerModelContent };
        return { content: '' };
      },
      searchCode: async () => ({
        results: [
          { path: offerCtrlRel, score: 350, line: 8 },
          { path: offerViewRel, score: 90, line: 1 },
          { path: offerModelRel, score: 85, line: 4 },
        ],
      }),
    },
  });

  assert.equal(scenario57Result.outcome, 'APPROVAL_REQUIRED');
  assert.equal(scenario57Result.phase, 'APPROVE');
  // Both Caller and Render Target / Callee must be inspected in inspectedFiles
  const inspectedPaths = scenario57Result.inspectedFiles.map((f) => typeof f === 'string' ? f : f.path);
  assert.ok(inspectedPaths.includes(offerCtrlRel), 'Caller must be present in inspectedFiles');
  assert.ok(inspectedPaths.includes(offerViewRel), '2nd-hop render target view must be resolved and present in inspectedFiles');

  console.log('[TEST] Scenario 57 passed: Universal call-graph & 2nd-hop render-target/callee contract verification verified.');

  // SCENARIO 58: Strict Grounding & Anti-Speculation Gate Enforcement (Zero-Speculation Rule) (V8)
  // Speculative phrasing in defect causal explanation must be rejected
  const speculativeReport = validateEvidenceReport({
    inspectedFiles: [
      { path: offerCtrlRel, content: offerControllerContent, lineRange: { startLine: 1, endLine: 20 } },
      { path: offerViewRel, content: offerViewContent, lineRange: { startLine: 1, endLine: 12 } },
    ],
    claimedDefects: [{
      filePath: offerCtrlRel,
      lines: '11',
      codeSnippet: 'dd($offers);',
      causalExplanation: 'The view probably expects an offerId parameter or another variable from the controller.',
    }],
  });
  assert.equal(speculativeReport.isValid, false, 'Speculative phrasing must be rejected');
  assert.match(speculativeReport.rejectionReason, /speculative phrasing/i);

  // Grounded defect explanation citing actual verified facts must pass
  const groundedReport = validateEvidenceReport({
    inspectedFiles: [
      { path: offerCtrlRel, content: offerControllerContent, lineRange: { startLine: 1, endLine: 20 } },
      { path: offerViewRel, content: offerViewContent, lineRange: { startLine: 1, endLine: 12 } },
    ],
    claimedDefects: [{
      filePath: offerCtrlRel,
      lines: '11',
      codeSnippet: 'dd($offers);',
      causalExplanation: 'Terminating dd() call at line 11 halts execution before the view is rendered.',
    }],
  });
  assert.equal(groundedReport.isValid, true, 'Grounded causal explanation must pass');

  console.log('[TEST] Scenario 58 passed: Strict grounding & anti-speculation gate enforcement verified.');

  // =========================================================================
  // MILESTONE V9: STRUCTURAL PATCH SYNTHESIS & PRE-PLAN DRIFT GUARD
  // =========================================================================

  // SCENARIO 59: Structural Function/Class/Block Scoped Patch Generation & Sibling Preservation (V9)
  const scopedServiceRel = 'services/ScopedPaymentService.js';
  const scopedServiceContent = `class ScopedPaymentService {
  processCharge(amount) {
    debugger;
    return { status: 'paid', amount };
  }

  auditLog(entry) {
    debugger;
    return { status: 'logged', entry };
  }
}
module.exports = ScopedPaymentService;
`;
  await fs.mkdir(path.join(testRoot, 'services'), { recursive: true });
  await fs.writeFile(path.join(testRoot, scopedServiceRel), scopedServiceContent, 'utf8');

  const scenario59SessionId = 'session-v9-structural-scoped-patch';
  createSession(scenario59SessionId, ownerId);

  let scenario59Proposal = null;
  const scenario59Result = await executeAutonomousCodingWorkflow({
    userRequest: 'Remove the debugger statement in processCharge in ScopedPaymentService',
    root: testRoot,
    scope: '.',
    sessionId: scenario59SessionId,
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async ({ proposalContract }) => {
      scenario59Proposal = proposalContract;
      return true; // approve for application test
    },
    runCheck: async () => ({ ok: true, executed: true, exitCode: 0 }),
    tools: {
      searchCode: async () => ({
        results: [{ path: scopedServiceRel, score: 95, line: 3 }],
      }),
      readFile: async (p) => {
        const full = path.join(testRoot, p);
        const content = await fs.readFile(full, 'utf8');
        return { content };
      },
    },
  });

  assert.ok(['SUCCESS', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(scenario59Result.outcome));
  assert.equal(scenario59Result.codeApplied, true);
  assert.equal(scenario59Result.codeVerified, true);
  assert.ok(scenario59Proposal, 'Proposal contract must be captured');
  assert.ok(scenario59Proposal.structuralScope, 'Structural scope must be present in proposalContract');
  assert.equal(scenario59Proposal.structuralScope.startLine, 2);
  assert.equal(scenario59Proposal.structuralScope.endLine, 5);
  assert.equal(scenario59Proposal.structuralScope.name, 'processCharge');
  assert.ok(scenario59Proposal.diffPreview.includes('@@'), 'Diff preview must contain unified diff hunk');

  // Verify on disk that processCharge had debugger removed, but auditLog preserved its debugger
  const diskAfter59 = await fs.readFile(path.join(testRoot, scopedServiceRel), 'utf8');
  assert.ok(!diskAfter59.includes('debugger;\n    return { status: \'paid\', amount };'), 'Target method must have debugger removed');
  assert.ok(diskAfter59.includes('auditLog(entry) {\n    debugger;'), 'Sibling method must preserve its code untouched');

  console.log('[TEST] Scenario 59 passed: Function/class/block scoped patch generation and sibling code preservation verified.');

  // SCENARIO 60: Pre-Plan Drift Guard Rejects Stale Source Snapshot (STALE_PROPOSAL_DRIFT) (V9)
  const driftFileRel = 'services/DriftProtectedService.js';
  const driftInitialContent = `function driftProtectedMethod() {
  debugger;
  return 42;
}
`;
  await fs.writeFile(path.join(testRoot, driftFileRel), driftInitialContent, 'utf8');
  const scenario60SessionId = 'session-v9-stale-drift-guard';
  createSession(scenario60SessionId, ownerId);

  const scenario60Result = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix debugger in driftProtectedMethod in DriftProtectedService',
    root: testRoot,
    scope: '.',
    sessionId: scenario60SessionId,
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    runCheck: async () => ({ ok: true, executed: true }),
    tools: {
      searchCode: async () => ({
        results: [{ path: driftFileRel, score: 90, line: 2 }],
      }),
      readFile: async (p) => {
        // Return initial content during Stage 3 inspection
        const inspectContent = driftInitialContent;
        // Mutate file on disk AFTER inspection to simulate external drift before Stage 4
        await fs.writeFile(path.join(testRoot, driftFileRel), '// EXTERNAL MODIFICATION DRIFT\n' + driftInitialContent, 'utf8');
        return { content: inspectContent };
      },
    },
  });

  assert.equal(scenario60Result.outcome, 'STALE_PROPOSAL_DRIFT');
  assert.equal(scenario60Result.staleSnapshot, true);
  assert.equal(scenario60Result.codeApplied, false);
  assert.equal(scenario60Result.codeVerified, false);
  assert.deepEqual(scenario60Result.filesModified, []);
  assert.match(scenario60Result.reason, /STALE_PROPOSAL_DRIFT/i);

  console.log('[TEST] Scenario 60 passed: Stale source snapshot and pre-plan drift guard rejection verified.');

  // SCENARIO 61: Missing / Ambiguous Code Evidence Refusal (PLANNING_ABSTAINED) (V9)
  // Part A: validateEvidenceReport strictly rejects findings with missing or empty code snippet
  const missingEvidenceReport = validateEvidenceReport({
    inspectedFiles: [{ path: 'services/AmbiguousService.js', content: 'function test() { return 1; }' }],
    claimedDefects: [{
      filePath: 'services/AmbiguousService.js',
      symbol: 'debug_probe',
      lines: '1',
      codeSnippet: '', // EMPTY CODE SNIPPET
    }],
  });
  assert.equal(missingEvidenceReport.isValid, false, 'Missing code evidence snippet must be rejected');
  assert.match(missingEvidenceReport.rejectionReason, /lacks verified code evidence/i);

  // Part B: Stage 4 patch synthesis refuses ambiguous defect in unsupported/ambiguous language (PLANNING_ABSTAINED)
  const ambiguousLangFileRel = 'services/AmbiguousScript.lua';
  const ambiguousLangContent = `function run_action()
  print("evaluating")
  debugger;
end
`;
  await fs.writeFile(path.join(testRoot, ambiguousLangFileRel), ambiguousLangContent, 'utf8');
  const scenario61SessionId = 'session-v9-ambiguous-evidence';
  createSession(scenario61SessionId, ownerId);

  const scenario61Result = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix ambiguous debug probe in AmbiguousScript.lua',
    root: testRoot,
    scope: '.',
    sessionId: scenario61SessionId,
    ownerWebContentsId: ownerId,
    assessFindingRelevance: mockSupportedRelevance,
    requestApproval: async () => true,
    tools: {
      searchCode: async () => ({
        results: [{ path: ambiguousLangFileRel, score: 90, line: 3 }],
      }),
      readFile: async () => ({ content: ambiguousLangContent }),
    },
  });

  assert.equal(scenario61Result.outcome, 'PLANNING_ABSTAINED');
  assert.equal(scenario61Result.codeApplied, false);
  assert.equal(scenario61Result.codeVerified, false);
  assert.deepEqual(scenario61Result.filesModified, []);
  assert.match(scenario61Result.reason, /Cannot safely repair debug probe in unsupported or ambiguous language/i);

  console.log('[TEST] Scenario 61 passed: Refusal/abstention on missing or ambiguous code evidence verified.');

  // SCENARIO 62: Proposal Contract Structural Scope & Source Content Grounding Validation (V9)
  const validProposal = {
    targetFile: scopedServiceRel,
    targetLineRange: { startLine: 3, endLine: 3 },
    structuralScope: { type: 'function', name: 'processCharge', startLine: 2, endLine: 5 },
    rootCauseSummary: 'Terminating debugger statement',
    originalCode: '    debugger;',
    proposedCode: '',
    diffPreview: '@@ -2,4 +2,3 @@\n processCharge(amount) {\n-    debugger;\n     return { status: \'paid\', amount };\n',
    expectedBehavior: 'Removes debugger probe',
  };
  const inspectedContext = [{ path: scopedServiceRel, content: scopedServiceContent }];
  const verifiedFindings = [{ filePath: scopedServiceRel }];

  // 1. Valid proposal passes
  const validResult = validateProposalContract(validProposal, { inspectedFiles: inspectedContext, verifiedFindings });
  assert.equal(validResult.isValid, true, 'Valid proposal contract must pass');

  // 2. Proposal exceeding structuralScope boundary is rejected
  const outOfBoundsProposal = {
    ...validProposal,
    targetLineRange: { startLine: 1, endLine: 8 }, // Exceeds [2-5]
  };
  const outOfBoundsResult = validateProposalContract(outOfBoundsProposal, { inspectedFiles: inspectedContext, verifiedFindings });
  assert.equal(outOfBoundsResult.isValid, false);
  assert.match(outOfBoundsResult.rejectionReason, /exceeds structuralScope boundaries/i);

  // 3. Ungrounded originalCode not present in inspected source is rejected
  const ungroundedProposal = {
    ...validProposal,
    originalCode: 'non_existent_uninspected_statement();',
  };
  const ungroundedResult = validateProposalContract(ungroundedProposal, { inspectedFiles: inspectedContext, verifiedFindings });
  assert.equal(ungroundedResult.isValid, false);
  assert.match(ungroundedResult.rejectionReason, /does not match verified source content/i);

  // 4. Invalid diffPreview without unified diff hunk is rejected
  const invalidDiffProposal = {
    ...validProposal,
    diffPreview: 'not a valid unified diff hunk',
  };
  const invalidDiffResult = validateProposalContract(invalidDiffProposal, { inspectedFiles: inspectedContext, verifiedFindings });
  assert.equal(invalidDiffResult.isValid, false);
  assert.match(invalidDiffResult.rejectionReason, /valid unified diff hunk/i);

  console.log('[TEST] Scenario 62 passed: Proposal contract structural scope & source grounding validation verified.');

  console.log('All 62 Project-Agnostic Coding Investigation Workflow scenarios verified successfully on production interfaces.');
} finally {
  developerFiles.releaseProject(ownerId);
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
