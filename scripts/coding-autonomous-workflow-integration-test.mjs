import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-workflow-e2e-test-'));
const ownerWebContentsId = 73001;
const sessionId = developerAgent.createSession(ownerWebContentsId);

try {
  // Set up synthetic test fixture project
  const projectDir = path.join(testRoot, 'modular-app');
  await fs.mkdir(path.join(projectDir, 'modules', 'personal', 'controllers'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'modules', 'personal', 'models'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'modules', 'academic', 'controllers'), { recursive: true });

  await fs.writeFile(
    path.join(projectDir, 'composer.json'),
    JSON.stringify({ name: 'test/modular-app', type: 'project' }),
    'utf8'
  );
  await fs.writeFile(
    path.join(projectDir, 'yii'),
    '#!/usr/bin/env php\n<?php exit(0);',
    'utf8'
  );

  const initialFormController = `<?php
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
            return $this->asJson(['error' => $e->getMessage()]);
        }
        return $this->render('update', ['model' => $model]);
    }

    public function actionDebugProbe($id) {
        var_dump($_POST);
        die("DEBUG_PROBE_EXIT");
    }
}
`;

  await fs.writeFile(
    path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'),
    initialFormController,
    'utf8'
  );

  await fs.writeFile(
    path.join(projectDir, 'modules', 'personal', 'models', 'CandidatePersonalDetails.php'),
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

  const initialAcademic = `<?php
namespace app\\modules\\academic\\controllers;
use yii\\web\\Controller;
// Unrelated work that must remain untouched
class UpdateAcademicController extends Controller {}
`;

  await fs.writeFile(
    path.join(projectDir, 'modules', 'academic', 'controllers', 'UpdateAcademicController.php'),
    initialAcademic,
    'utf8'
  );

  // Set project discovery root
  const originalRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);

  // TEST 1: Clarification Path (Vague Request)
  const progressEvents1 = [];
  const vagueResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'make the personal details page faster and better',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    onProgress: (p) => progressEvents1.push(p),
  });

  assert.equal(vagueResult.outcome, 'CLARIFICATION_REQUIRED');
  assert.equal(vagueResult.phase, 'UNDERSTAND');
  assert.equal(vagueResult.filesModified.length, 0);
  assert.match(vagueResult.clarificationPrompt, /ambiguous/i);
  // Ensure files remained completely untouched
  const afterVagueContent = await fs.readFile(
    path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'),
    'utf8'
  );
  assert.equal(afterVagueContent, initialFormController);

  const cleanDir = path.join(testRoot, 'clean-app');
  await fs.mkdir(path.join(cleanDir, 'modules', 'account', 'models'), { recursive: true });
  await fs.writeFile(
    path.join(cleanDir, 'composer.json'),
    JSON.stringify({ name: 'test/clean-app', type: 'project' }),
    'utf8'
  );
  await fs.writeFile(
    path.join(cleanDir, 'modules', 'account', 'models', 'AccountDetails.php'),
    `<?php
namespace app\\modules\\account\\models;
class AccountDetails {
    public function rules() {
        return [['id', 'required']];
    }
}
`,
    'utf8'
  );

  // TEST 2: Investigation-Only / No Defect Found
  await developerFiles.discoverProjectByName('clean-app', ownerWebContentsId);
  const progressEvents2 = [];
  const noDefectResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'inspect AccountDetails validation rules',
    root: cleanDir,
    sessionId,
    ownerWebContentsId,
    onProgress: (p) => progressEvents2.push(p),
  });

  assert.equal(noDefectResult.outcome, 'NO_DEFECT_FOUND');
  assert.equal(noDefectResult.phase, 'INVESTIGATE');
  assert.equal(noDefectResult.filesModified.length, 0);

  // TEST 3: Failed searches produce a bounded, concrete continuation without repeating queries.
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);
  const failedSearchQueries = [];
  const failedSearchResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'investigate the personal controller issue',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      searchCode: async (query) => {
        failedSearchQueries.push(query);
        if (failedSearchQueries.length === 1) {
          return {
            results: [{
              path: 'modules/personal/models/CandidatePersonalDetails.php',
              line: 3,
              score: 17,
              matchType: 'definition',
            }],
          };
        }
        throw new Error('Controlled fixture search failure');
      },
    },
  });
  assert.equal(failedSearchResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(failedSearchResult.codeApplied, false);
  assert.equal(failedSearchResult.codeVerified, false);
  assert.equal(failedSearchResult.continuation.status, 'READY_TO_RESUME');
  assert.equal(failedSearchResult.continuation.nextStep.tool, 'list_directory');
  assert.equal(new Set(failedSearchQueries).size, failedSearchQueries.length);
  const savedSearch = failedSearchResult.continuation.searchesCompleted[0];
  assert.equal(savedSearch.query, failedSearchQueries[0]);
  assert.equal(savedSearch.status, 'COMPLETED');
  assert.equal(savedSearch.resultCount, 1);
  assert.deepEqual(savedSearch.candidates[0], {
    path: 'modules/personal/models/CandidatePersonalDetails.php',
    line: 3,
    score: 17,
    matchType: 'definition',
  });
  assert.ok(failedSearchResult.continuation.searchesCompleted
    .some((search) => search.status === 'FAILED' && search.reason.includes('Controlled fixture search failure')));
  assert.match(failedSearchResult.message, /no root cause or absence-of-defect claim is supported/i);

  // TEST 4: An unreadable relevant source stays incomplete and cannot produce a proposal.
  const unreadablePath = 'modules/personal/controllers/FormController.php';
  const unreadableResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'inspect personal controller update action failure',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      searchCode: async () => ({ results: [{ path: unreadablePath, score: 100 }] }),
      readFile: async () => { throw new Error('Controlled fixture source-read failure'); },
    },
  });
  assert.equal(unreadableResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(unreadableResult.readFailures[0].path, unreadablePath);
  assert.equal(unreadableResult.continuation.nextStep.tool, 'read_file');
  assert.equal(unreadableResult.continuation.nextStep.path, unreadablePath);
  assert.deepEqual(unreadableResult.findings, []);
  assert.deepEqual(unreadableResult.filesModified, []);
  assert.equal(Object.hasOwn(unreadableResult, 'taskId'), false);

  // TEST 5: Search-budget exhaustion reports the next distinct request term for resumption.
  const boundedSearchQueries = [];
  const boundedSearchResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'trace profile routing behavior for alpha beta gamma delta epsilon zeta eta theta iota',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      searchCode: async (query) => {
        boundedSearchQueries.push(query);
        return { results: [] };
      },
    },
  });
  assert.equal(boundedSearchResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(boundedSearchResult.continuation.status, 'READY_TO_RESUME');
  assert.equal(boundedSearchQueries.length, 5);
  assert.equal(new Set(boundedSearchQueries).size, boundedSearchQueries.length);
  assert.equal(boundedSearchResult.continuation.searchesCompleted.length, 5);
  assert.equal(boundedSearchResult.continuation.nextStep.tool, 'search_code');
  assert.ok(!boundedSearchQueries.includes(boundedSearchResult.continuation.nextStep.query));
  assert.equal(Object.hasOwn(boundedSearchResult, 'taskId'), false);

  // TEST 6: Unavailable verification cannot become successful application or verified success.
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);
  const unavailableResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    requestApproval: async () => true,
  });
  assert.equal(unavailableResult.outcome, 'VERIFICATION_UNAVAILABLE');
  assert.equal(unavailableResult.verificationStatus, 'VERIFICATION_UNAVAILABLE');
  assert.equal(unavailableResult.codeApplied, false);
  assert.equal(unavailableResult.codeVerified, false);
  assert.deepEqual(unavailableResult.filesModified, []);
  assert.equal(
    await fs.readFile(path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'), 'utf8'),
    initialFormController,
    'Unavailable verification must not leave an applied patch behind.',
  );

  // TEST 7: A failing runner remains a failure and the patch is rolled back.
  const failingResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    runCheck: async () => ({
      ok: false,
      status: 'FAILED',
      executed: true,
      exitCode: 1,
      stderr: 'fixture test failure',
    }),
    requestApproval: async () => true,
  });
  assert.equal(failingResult.outcome, 'TEST_FAILED');
  assert.equal(failingResult.codeApplied, false);
  assert.equal(failingResult.codeVerified, false);
  assert.deepEqual(failingResult.filesModified, []);
  assert.equal(
    await fs.readFile(path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'), 'utf8'),
    initialFormController,
  );

  // TEST 8: Cancellation during apply is reported as cancellation and rolled back.
  const cancelledResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    requestApproval: async () => true,
    tools: {
      authorizeMutation: async ({ taskId }) => {
        developerAgent.cancelTask(taskId, { sessionId, ownerWebContentsId });
        return { allowed: true };
      },
    },
  });
  assert.equal(cancelledResult.outcome, 'CANCELLED');
  assert.equal(cancelledResult.verificationStatus, 'CANCELLED');
  assert.equal(cancelledResult.codeApplied, false);
  assert.equal(cancelledResult.codeVerified, false);
  assert.deepEqual(cancelledResult.filesModified, []);
  assert.equal(
    await fs.readFile(path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'), 'utf8'),
    initialFormController,
  );

  // TEST 9: A passing runner verifies the approved patch and preserves scoped apply behavior.
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);
  const progressEvents3 = [];
  const fixResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    autoRepairEnabled: false,
    runCheck: async () => ({
      ok: true,
      status: 'PASS',
      executed: true,
      exitCode: 0,
      stdout: 'fixture checks passed',
    }),
    onProgress: (p) => progressEvents3.push(p),
    requestApproval: async ({ proposal }) => {
      assert.ok(proposal.taskId);
      assert.equal(proposal.files.length, 1);
      assert.equal(proposal.files[0].path, 'modules/personal/controllers/FormController.php');
      return true;
    },
  });

  assert.equal(fixResult.outcome, 'SUCCESS', JSON.stringify(fixResult));
  assert.equal(fixResult.phase, 'AUDIT');
  assert.deepEqual(fixResult.filesModified, ['modules/personal/controllers/FormController.php']);
  assert.equal(fixResult.verificationStatus, 'PASS');
  assert.equal(fixResult.codeApplied, true);
  assert.equal(fixResult.codeVerified, true);

  // Verify the file was actually patched
  const patchedContent = await fs.readFile(
    path.join(projectDir, 'modules/personal/controllers/FormController.php'),
    'utf8'
  );
  assert.ok(!patchedContent.includes('die('), 'die() must be removed by patch');
  assert.ok(!patchedContent.includes('var_dump('), 'var_dump() must be removed by patch');

  // Verify unrelated academic controller remains 100% untouched
  const academicContent = await fs.readFile(
    path.join(projectDir, 'modules', 'academic', 'controllers', 'UpdateAcademicController.php'),
    'utf8'
  );
  assert.equal(academicContent, initialAcademic);

  // TEST 10: Attempted Scope Expansion Rejected by Approval Gate
  const unapprovedGate = developerAgent.enforceApprovalGate({
    originalProposalTargets: ['modules/personal/controllers/FormController.php'],
    attemptedMutationTargets: [
      'modules/personal/controllers/FormController.php',
      'modules/academic/controllers/UpdateAcademicController.php', // Unapproved extra file!
    ],
    userApproved: true,
  });
  assert.equal(unapprovedGate.allowed, false);
  assert.match(unapprovedGate.rejectionReason, /scope expansion/i);

  // TEST 11: Failed Test Diagnosis and Bounded Repair Governance
  const repairGovDisabled = developerAgent.manageRepairLoop({
    approvedTargets: ['modules/personal/controllers/FormController.php'],
    attemptCount: 0,
    maxAttempts: 2,
    autoRepairEnabled: false,
    lastVerificationResult: { status: 'FAILED' },
    proposedMutationTargets: ['modules/personal/controllers/FormController.php'],
  });
  assert.equal(repairGovDisabled.allowRepair, false);
  assert.match(repairGovDisabled.reason, /disabled by default/i);

  const repairGovBounded = developerAgent.manageRepairLoop({
    approvedTargets: ['modules/personal/controllers/FormController.php'],
    attemptCount: 2,
    maxAttempts: 2,
    autoRepairEnabled: true,
    lastVerificationResult: { status: 'FAILED' },
    proposedMutationTargets: ['modules/personal/controllers/FormController.php'],
  });
  assert.equal(repairGovBounded.allowRepair, false);
  assert.match(repairGovBounded.reason, /Maximum repair attempts/i);

  // TEST 12: Forged Verification Records Rejected
  const forgedReport = developerAgent.validateEvidenceReport({
    userGoal: 'run test suite',
    claimedVerification: 'PASSED',
    executionAuditLog: null,
  });
  assert.equal(forgedReport.isValid, false);
  assert.equal(forgedReport.verificationAccepted, false);
  assert.match(forgedReport.rejectionReason, /authoritative/i);

  const nonZeroPassReport = developerAgent.validateEvidenceReport({
    userGoal: 'run test suite',
    claimedVerification: 'PASSED',
    executionAuditLog: { exitCode: 1, output: 'FAILURES' },
  });
  assert.equal(nonZeroPassReport.isValid, false);
  assert.equal(nonZeroPassReport.verificationAccepted, false);

  console.log('Production End-to-End Autonomous Coding Workflow integration verified successfully.');
} finally {
  developerAgent.releaseSession(ownerWebContentsId);
  developerFiles.releaseProject(ownerWebContentsId);
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
