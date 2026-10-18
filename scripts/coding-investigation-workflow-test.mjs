import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import { buildRepositoryMap } from '../electron/developerIndex.cjs';
import { detectProject } from '../electron/coding-pipeline/detect/projectDetector.cjs';

const {
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_LIKELY,
  CLASSIFICATION_UNVERIFIED,
  CLASSIFICATION_NOT_A_BUG,
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
} = developerAgent;

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-investigation-test-'));
const ownerId = 72001;

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

  console.log('All 15 Project-Agnostic Coding Investigation Workflow scenarios verified successfully on production interfaces.');
} finally {
  developerFiles.releaseProject(ownerId);
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
