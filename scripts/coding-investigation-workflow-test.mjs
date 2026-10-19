import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import { buildRepositoryMap } from '../electron/developerIndex.cjs';
import { detectProject } from '../electron/coding-pipeline/detect/projectDetector.cjs';
import { maskNonCodeSource } from '../electron/coding-pipeline/investigationWorkflowContract.cjs';
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
  enforceApprovalGate,
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

  console.log('All 33 Project-Agnostic Coding Investigation Workflow scenarios verified successfully on production interfaces.');
} finally {
  developerFiles.releaseProject(ownerId);
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
