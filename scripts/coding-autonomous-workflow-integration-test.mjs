import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-workflow-e2e-test-'));
const ownerWebContentsId = 73001;
const sessionId = developerAgent.createSession(ownerWebContentsId);
const mockRelevance = (decide = () => 'SUPPORTED', overrides = () => ({})) => async ({ findings }) => ({
  findings: findings.map((finding, index) => ({
    findingId: finding.findingId,
    decision: decide(finding, index),
    relationship: 'Mocked fixture assessment cites inspected source evidence for this scenario.',
    evidenceIds: [finding.sourceEvidenceId],
    contradictionEvidenceIds: [],
    unresolvedAssumptions: [],
    provenance: 'TEST_FIXTURE',
    ...overrides(finding, index),
  })),
});

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
    tools: { operatingMode: 'INVESTIGATE' },
    onProgress: (p) => progressEvents2.push(p),
  });

  assert.equal(noDefectResult.outcome, 'NO_DEFECT_FOUND');
  assert.equal(noDefectResult.phase, 'INVESTIGATE');
  assert.equal(noDefectResult.filesModified.length, 0);

  // A commented-out debug probe is not executable source and must not become a finding.
  const commentedProbeDir = path.join(testRoot, 'commented-probe-app');
  const commentedProbePath = 'src/handlers/ReportHandler.js';
  const commentedProbeSource = [
    'export function reportStatus() {',
    '  // Previous diagnostic: console.trace("report status");',
    '  return "ready";',
    '}',
    '',
  ].join('\n');
  await fs.mkdir(path.join(commentedProbeDir, 'src', 'handlers'), { recursive: true });
  await fs.writeFile(path.join(commentedProbeDir, 'package.json'), JSON.stringify({ name: 'commented-probe-app' }), 'utf8');
  await fs.writeFile(path.join(commentedProbeDir, commentedProbePath), commentedProbeSource, 'utf8');
  await developerFiles.discoverProjectByName('commented-probe-app', ownerWebContentsId);
  const commentedProbeResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Investigate whether ReportHandler has active debug tracing',
    root: commentedProbeDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => ({
        results: [{ path: commentedProbePath, score: 30, line: 2, matchType: 'content' }],
      }),
      readFile: async () => ({ content: commentedProbeSource }),
    },
  });
  assert.deepEqual(
    commentedProbeResult.findings,
    [],
    'Commented-out tracing must not be reported as an active defect.',
  );
  assert.equal(commentedProbeResult.codeApplied, false);
  assert.equal(commentedProbeResult.codeVerified, false);

  const stringLiteralDir = path.join(testRoot, 'string-literal-app');
  const stringLiteralPath = 'src/status.js';
  const stringLiteralSource = [
    'export function status() {',
    '  const single = \'console.trace("example")\';',
    '  const double = "debugger; // example";',
    '  const template = `var_dump(); /* example */`;',
    '  return `${single}${double}${template}`;',
    '}',
    '',
  ].join('\n');
  await fs.mkdir(path.join(stringLiteralDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(stringLiteralDir, 'package.json'), JSON.stringify({ name: 'string-literal-app' }), 'utf8');
  await fs.writeFile(path.join(stringLiteralDir, stringLiteralPath), stringLiteralSource, 'utf8');
  await developerFiles.discoverProjectByName('string-literal-app', ownerWebContentsId);
  const stringLiteralResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Investigate whether status contains an active debug statement',
    root: stringLiteralDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => ({
        results: [{ path: stringLiteralPath, score: 30, line: 2, matchType: 'content' }],
      }),
      readFile: async () => ({ content: stringLiteralSource }),
    },
  });
  assert.deepEqual(
    stringLiteralResult.findings,
    [],
    'Debug-like text in JavaScript string literals must not be reported as active statements.',
  );

  const pythonFloorDivisionDir = path.join(testRoot, 'python-floor-division-app');
  const pythonFloorDivisionPath = 'src/worker.py';
  const pythonFloorDivisionSource = 'def calculate(value):\n    half = value // 2; breakpoint()\n    return half\n';
  await fs.mkdir(path.join(pythonFloorDivisionDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(pythonFloorDivisionDir, 'pyproject.toml'), '[project]\nname = "python-floor-division-app"\n', 'utf8');
  await fs.writeFile(path.join(pythonFloorDivisionDir, pythonFloorDivisionPath), pythonFloorDivisionSource, 'utf8');
  await developerFiles.discoverProjectByName('python-floor-division-app', ownerWebContentsId);
  const pythonFloorDivisionResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Investigate whether the Python worker has an active breakpoint',
    root: pythonFloorDivisionDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => ({
        results: [{ path: pythonFloorDivisionPath, score: 30, line: 2, matchType: 'content' }],
      }),
      readFile: async () => ({ content: pythonFloorDivisionSource }),
    },
  });
  assert.ok(
    pythonFloorDivisionResult.findings.some((finding) => finding.symbol === 'debug_probe'),
    'Python floor division must not hide an active breakpoint later on the same line.',
  );

  const nestedCommentDir = path.join(testRoot, 'nested-comment-app');
  const nestedCommentPath = 'src/lib.rs';
  const nestedCommentSource = [
    '/* outer documentation comment',
    '/* nested documentation comment */',
    'debugger;',
    '*/',
    'pub fn status() -> bool { true }',
  ].join('\n');
  await fs.mkdir(path.join(nestedCommentDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(nestedCommentDir, 'Cargo.toml'), '[package]\nname = "nested-comment-app"\nversion = "0.1.0"\n', 'utf8');
  await fs.writeFile(path.join(nestedCommentDir, nestedCommentPath), nestedCommentSource, 'utf8');
  await developerFiles.discoverProjectByName('nested-comment-app', ownerWebContentsId);
  const nestedCommentResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Investigate whether the Rust library has active debug statements',
    root: nestedCommentDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => ({
        results: [{ path: nestedCommentPath, score: 30, line: 3, matchType: 'content' }],
      }),
      readFile: async () => ({ content: nestedCommentSource }),
    },
  });
  assert.deepEqual(
    nestedCommentResult.findings,
    [],
    'Debug-like code inside nested Rust documentation comments must not be reported as a finding.',
  );
  assert.equal(nestedCommentResult.codeApplied, false);
  assert.equal(nestedCommentResult.codeVerified, false);

  // TEST 2B: A confirmed but unrelated finding cannot replace an implementation objective.
  const unrelatedFindingRequest = 'Add debug diagnostics for retry delivery attempts in the distributed worker after timeout recovery and preserve request metadata across handoff boundaries';
  let unrelatedProposalRequested = false;
  const unrelatedSearchQueries = [];
  let originalSourceEvidenceId = null;
  const unrelatedFindingResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: unrelatedFindingRequest,
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: async (assessment) => {
      originalSourceEvidenceId = assessment.sourceEvidence.find(
        (item) => item.path === 'modules/personal/controllers/FormController.php',
      )?.evidenceId;
      return mockRelevance(() => 'UNRELATED')(assessment);
    },
    requestApproval: async () => {
      unrelatedProposalRequested = true;
      return false;
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      searchCode: async (query) => {
        unrelatedSearchQueries.push(query);
        return {
          results: [{
            path: 'modules/personal/controllers/FormController.php',
            score: 20,
            line: 1,
          }],
        };
      },
      readFile: async () => ({
        content: '<?php\nfunction showDelivery($event) {\n    var_dump($event);\n}\n',
      }),
    },
  });
  assert.equal(unrelatedFindingResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(unrelatedFindingResult.taskState.status, 'INCOMPLETE');
  assert.equal(unrelatedFindingResult.taskState.objective.request, unrelatedFindingRequest);
  assert.equal(unrelatedFindingResult.taskPlan.subtasks.find((subtask) => subtask.id === 'ST-2').status, 'BLOCKED');
  assert.equal(unrelatedFindingResult.codeApplied, false);
  assert.equal(unrelatedFindingResult.codeVerified, false);
  assert.deepEqual(unrelatedFindingResult.filesModified, []);
  assert.equal(unrelatedProposalRequested, false, 'An unrelated repair must not reach the approval prompt.');
  assert.equal(unrelatedFindingResult.findings[0].symbol, 'debug_probe');
  assert.equal(unrelatedFindingResult.taskState.evidence.findings[0].symbol, 'debug_probe');
  assert.equal(unrelatedFindingResult.taskState.evidence.objectiveAssessments[0].decision, 'UNRELATED');
  assert.ok(unrelatedFindingResult.taskState.unresolvedQuestions.includes(unrelatedFindingResult.reason));
  assert.ok(unrelatedFindingResult.taskState.nextAction);
  assert.equal(unrelatedFindingResult.continuation.taskState.objective.request, unrelatedFindingRequest);
  assert.equal(
    unrelatedFindingResult.continuation.taskState.evidence.objectiveAssessments[0].evidenceIds[0],
    unrelatedFindingResult.taskState.evidence.objectiveAssessments[0].evidenceIds[0],
  );
  assert.match(unrelatedFindingResult.reason, /configured provider assessed/i);

  const resumedUnrelatedQueries = [];
  const resumedEvidencePaths = [];
  let resumedSourceEvidenceId = null;
  const resumedUnrelatedResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: unrelatedFindingRequest,
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    continuationToken: unrelatedFindingResult.continuation.token,
    assessFindingRelevance: async (assessment) => {
      assert.equal(assessment.objective.request, unrelatedFindingRequest);
      resumedEvidencePaths.push(...assessment.sourceEvidence.map((item) => item.path));
      resumedSourceEvidenceId = assessment.sourceEvidence.find(
        (item) => item.path === 'modules/personal/controllers/FormController.php',
      )?.evidenceId;
      return mockRelevance(() => 'UNRELATED')(assessment);
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      searchCode: async (query) => {
        resumedUnrelatedQueries.push(query);
        return resumedUnrelatedQueries.length === 1
          ? { results: [{ path: 'modules/personal/workers/DeliveryWorker.php', score: 18, line: 1 }] }
          : { results: [] };
      },
      readFile: async () => ({ content: '<?php\nclass DeliveryWorker { public function dispatch($job) { return true; } }\n' }),
    },
  });
  assert.ok(resumedUnrelatedQueries.length > 0);
  assert.equal(resumedUnrelatedQueries.some((query) => unrelatedSearchQueries.includes(query)), false);
  assert.equal(resumedUnrelatedResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(resumedUnrelatedResult.taskState.objective.request, unrelatedFindingRequest);
  assert.ok(resumedUnrelatedResult.inspectedFiles.includes('modules/personal/workers/DeliveryWorker.php'));
  assert.ok(resumedEvidencePaths.includes('modules/personal/controllers/FormController.php'));
  assert.ok(resumedEvidencePaths.includes('modules/personal/workers/DeliveryWorker.php'));
  assert.equal(resumedSourceEvidenceId, originalSourceEvidenceId);
  const resumedObjectiveAssessments = resumedUnrelatedResult.taskState.evidence.objectiveAssessments;
  assert.equal(
    new Set(resumedObjectiveAssessments.map((item) => item.findingId)).size,
    resumedObjectiveAssessments.length,
    'Continuation should refresh assessments for each finding instead of duplicating stale decisions.',
  );

  // TEST 2C: An implementation request is not complete merely because no known defect pattern matched.
  const implementationRequest = 'Add configurable retry handling to the delivery worker';
  const unsupportedImplementationResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: implementationRequest,
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'AUTONOMOUS',
      searchCode: async () => ({
        results: [{ path: 'modules/personal/models/CandidatePersonalDetails.php', score: 20, line: 1 }],
      }),
      readFile: async () => ({
        content: 'class DeliveryWorker { public function dispatch($event) { return true; } }',
      }),
    },
  });
  assert.equal(unsupportedImplementationResult.outcome, 'IMPLEMENTATION_REQUIRED');
  assert.equal(unsupportedImplementationResult.taskState.status, 'INCOMPLETE');
  assert.equal(unsupportedImplementationResult.taskState.objective.request, implementationRequest);
  assert.equal(unsupportedImplementationResult.taskState.phase, 'PLAN');
  assert.equal(unsupportedImplementationResult.taskPlan.subtasks.find((subtask) => subtask.id === 'ST-3').status, 'BLOCKED');
  assert.equal(unsupportedImplementationResult.codeApplied, false);
  assert.equal(unsupportedImplementationResult.codeVerified, false);
  assert.equal(unsupportedImplementationResult.filesModified.length, 0);
  assert.ok(unsupportedImplementationResult.taskState.evidence.inspectedFiles.length > 0);
  assert.match(unsupportedImplementationResult.reason, /standard Coding Agent proposal flow/i);

  // TEST 2C2: Composite implementation work is decomposed and handed off, never partially repaired.
  const compositeImplementationRequest = [
    'Implement:',
    '- Persist settings.',
    '- Add API.',
    '- Add tests.',
  ].join('\n');
  let compositeApprovalRequested = false;
  const compositeResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: compositeImplementationRequest,
    root: cleanDir,
    sessionId,
    ownerWebContentsId,
    requestApproval: async () => {
      compositeApprovalRequested = true;
      return true;
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      searchCode: async () => ({
        results: [{ path: 'modules/account/models/AccountDetails.php', score: 20, line: 1 }],
      }),
      readFile: async () => ({
        content: 'class AccountDetails { public function rules() { return []; } }',
      }),
    },
  });
  assert.equal(compositeResult.outcome, 'IMPLEMENTATION_REQUIRED');
  assert.equal(compositeResult.taskPlan.workItems.length, 3);
  assert.ok(compositeResult.taskPlan.workItems.every((item) => item.status === 'DELEGATED'));
  assert.equal(compositeResult.taskPlan.status, 'HANDED_OFF');
  assert.equal(compositeApprovalRequested, false, 'The single-defect repair path must not approve a partial composite change.');
  assert.equal(compositeResult.codeApplied, false);
  assert.deepEqual(compositeResult.filesModified, []);

  // TEST 2D: A provider-cited source relationship can use different terminology than the request.
  let paraphrasedProposal = null;
  const paraphrasedObjective = 'Remove development-only output that terminates the profile-update response';
  const paraphrasedResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: paraphrasedObjective,
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: async (assessment) => {
      assert.equal(assessment.objective.request, paraphrasedObjective);
      assert.ok(assessment.sourceEvidence.some((item) => item.excerpt.includes('var_dump')));
      return mockRelevance(() => 'SUPPORTED')(assessment);
    },
    requestApproval: async ({ proposal, diff }) => {
      paraphrasedProposal = { proposal, diff };
      return false;
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      searchCode: async () => ({
        results: [{ path: 'modules/personal/controllers/FormController.php', score: 25, line: 20 }],
      }),
      readFile: async () => ({ content: initialFormController }),
    },
  });
  assert.ok(paraphrasedProposal, 'Cited, semantically relevant evidence should reach the normal approval boundary.');
  assert.match(paraphrasedProposal.diff, /var_dump|die/);
  assert.equal(paraphrasedResult.codeApplied, false, 'Declined approval must not apply the proposed patch.');

  // TEST 2E: Superficial coexistence in one file must not pull an unrelated finding into the patch.
  let mixedProposal = null;
  let mixedDecisions = [];
  const mixedAssessment = mockRelevance((finding) => (
    finding.symbol === 'debug_probe' ? 'UNRELATED' : 'SUPPORTED'
  ));
  const mixedResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Ensure failed record updates release the database transaction',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: async (assessment) => {
      const response = await mixedAssessment(assessment);
      mixedDecisions = response.findings.map((item) => item.decision);
      return response;
    },
    requestApproval: async ({ diff }) => {
      mixedProposal = diff;
      return false;
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      searchCode: async () => ({
        results: [{ path: 'modules/personal/controllers/FormController.php', score: 25, line: 8 }],
      }),
      readFile: async () => ({ content: initialFormController }),
    },
  });
  assert.ok(mixedProposal);
  assert.match(mixedProposal, /rollBack/, 'The relevant transaction finding should be proposed.');
  assert.match(mixedProposal, /var_dump/, 'The unrelated debug finding must remain untouched.');
  assert.match(mixedProposal, /die\(/, 'The unrelated termination finding must remain untouched.');
  assert.equal(mixedDecisions.includes('SUPPORTED'), true);
  assert.equal(mixedDecisions.includes('UNRELATED'), true);
  assert.equal(mixedResult.codeApplied, false);

  // TEST 2F: Ambiguous, contradicted, and malformed assessments cannot cross the approval boundary.
  const runUnresolvedAssessment = async (assessment, objective) => {
    let approvalCalled = false;
    const result = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: objective,
      root: projectDir,
      sessionId,
      ownerWebContentsId,
      assessFindingRelevance: assessment,
      requestApproval: async () => {
        approvalCalled = true;
        return true;
      },
      tools: {
        operatingMode: 'AUTONOMOUS',
        searchCode: async () => ({
          results: [{ path: 'modules/personal/controllers/FormController.php', score: 25, line: 8 }],
        }),
        readFile: async () => ({ content: initialFormController }),
      },
    });
    assert.equal(approvalCalled, false);
    assert.equal(result.codeApplied, false);
    assert.equal(result.codeVerified, false);
    assert.equal(result.taskState.status, 'INCOMPLETE');
    return result;
  };
  const uncertainResult = await runUnresolvedAssessment(
    mockRelevance(() => 'INSUFFICIENT'),
    'Ensure failed account updates release their resources',
  );
  assert.equal(uncertainResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(uncertainResult.taskState.evidence.objectiveAssessments[0].decision, 'INSUFFICIENT');

  const contradictedResult = await runUnresolvedAssessment(
    mockRelevance(
      () => 'CONTRADICTED',
      (finding) => ({ contradictionEvidenceIds: [finding.sourceEvidenceId] }),
    ),
    'Ensure failed account updates release their resources',
  );
  assert.equal(contradictedResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(contradictedResult.taskState.evidence.objectiveAssessments[0].decision, 'CONTRADICTED');

  const malformedCitationResult = await runUnresolvedAssessment(
    mockRelevance(
      () => 'SUPPORTED',
      () => ({ evidenceIds: ['not-a-supplied-source-reference'] }),
    ),
    'Remove development-only output from account updates',
  );
  assert.equal(malformedCitationResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.match(malformedCitationResult.reason, /malformed or cited unknown evidence/i);

  const malformedSchemaResult = await runUnresolvedAssessment(
    mockRelevance(
      () => 'SUPPORTED',
      () => ({ unresolvedAssumptions: null }),
    ),
    'Remove development-only output from account updates',
  );
  assert.equal(malformedSchemaResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.match(malformedSchemaResult.reason, /malformed or cited unknown evidence/i);

  const unresolvedAssumptionResult = await runUnresolvedAssessment(
    mockRelevance(
      () => 'SUPPORTED',
      () => ({ unresolvedAssumptions: ['The caller may not execute this handler.'] }),
    ),
    'Remove development-only output from account updates',
  );
  assert.equal(unresolvedAssumptionResult.outcome, 'INVESTIGATION_INCOMPLETE');

  // TEST 2G: A supported finding without a safe transformation abstains instead of proposing.
  const unsupportedSourcePath = 'modules/personal/data/instructions.txt';
  await fs.mkdir(path.dirname(path.join(projectDir, unsupportedSourcePath)), { recursive: true });
  await fs.writeFile(path.join(projectDir, unsupportedSourcePath), 'debugger;\n', 'utf8');
  let unsupportedSourceApprovalRequested = false;
  const unsupportedSourceResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Remove the development pause from the account instruction artifact',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: mockRelevance(),
    requestApproval: async () => {
      unsupportedSourceApprovalRequested = true;
      return true;
    },
    tools: {
      operatingMode: 'AUTONOMOUS',
      searchCode: async () => ({ results: [{ path: unsupportedSourcePath, score: 25, line: 1 }] }),
      readFile: async () => ({ content: 'debugger;\n' }),
    },
  });
  assert.equal(unsupportedSourceResult.outcome, 'PLANNING_ABSTAINED');
  assert.equal(unsupportedSourceApprovalRequested, false);
  assert.equal(unsupportedSourceResult.codeApplied, false);
  assert.equal(unsupportedSourceResult.codeVerified, false);

  // TEST 3: Exhausted search failures remain explicitly incomplete and cannot be resumed.
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
  assert.equal(failedSearchResult.continuation.status, 'NEEDS_NARROWER_REQUEST');
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
  assert.equal(
    failedSearchResult.continuation.searchesCompleted.find((search) => search.status === 'FAILED').attempts,
    1,
    'Deterministic failures must not be blindly retried.'
  );
  assert.match(failedSearchResult.message, /no root cause or absence-of-defect claim is supported/i);

  // TEST 3B: A definite transient resource-lock rejection gets one bounded retry.
  const retryableSearchQueries = [];
  let transientSearchFailures = 0;
  const retryableSearchResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'investigate delivery retry handling',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async (query) => {
        retryableSearchQueries.push(query);
        if (transientSearchFailures === 0) {
          transientSearchFailures += 1;
          const error = new Error('Project search index is busy.');
          error.code = 'EBUSY';
          throw error;
        }
        if (retryableSearchQueries.length === 2) {
          return { results: [{ path: 'src/workers/retry-handler.ts', score: 20, line: 1 }] };
        }
        return { results: [] };
      },
      readFile: async (_path, range) => range
        ? {
            content: 'export function retryDelivery(attempt) {',
            lineRange: { startLine: 1, endLine: 1, totalLines: 3, complete: false },
          }
        : {
            content: 'export function retryDelivery(attempt) {\n  return attempt < 3;\n}',
            lineRange: { startLine: 1, endLine: 3, totalLines: 3, complete: true },
          },
    },
  });
  assert.equal(retryableSearchQueries[0], retryableSearchQueries[1], 'Only the failed query may be retried.');
  assert.equal(new Set(retryableSearchQueries.slice(1)).size, retryableSearchQueries.length - 1);
  assert.equal(retryableSearchResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(retryableSearchResult.taskState.status, 'INCOMPLETE');
  assert.equal(retryableSearchResult.taskState.objective.request, 'investigate delivery retry handling');
  assert.equal(retryableSearchResult.taskState.recoveries.length, 1);
  assert.equal(retryableSearchResult.taskState.recoveries[0].status, 'RECOVERED');
  assert.equal(retryableSearchResult.taskState.recoveries[0].objectiveStatus, 'IN_PROGRESS');
  assert.equal(retryableSearchResult.taskState.evidence.inspectionEvidence[0].lineRange.complete, false);
  assert.equal(retryableSearchResult.continuation.taskState.objective.request, 'investigate delivery retry handling');
  assert.equal(retryableSearchResult.continuation.taskState.recoveries[0].status, 'RECOVERED');
  assert.deepEqual(retryableSearchResult.inspectedFiles, ['src/workers/retry-handler.ts']);
  assert.equal(retryableSearchResult.codeApplied, false);
  assert.equal(retryableSearchResult.codeVerified, false);

  const resumedRetryInvestigation = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'investigate delivery retry handling',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    continuationToken: retryableSearchResult.continuation.token,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => {
        throw new Error('Previously completed searches must not be repeated.');
      },
      readFile: async () => ({
        content: 'export function retryDelivery(attempt) {\n  return attempt < 3;\n}\n',
        lineRange: { startLine: 1, endLine: 4, totalLines: 4, complete: true },
      }),
    },
  });
  assert.equal(resumedRetryInvestigation.outcome, 'NO_DEFECT_FOUND');
  assert.equal(resumedRetryInvestigation.taskState.status, 'INCOMPLETE');
  assert.equal(resumedRetryInvestigation.taskPlan.status, 'BLOCKED');
  assert.equal(resumedRetryInvestigation.taskPlan.workItems[0].status, 'BLOCKED');
  assert.equal(resumedRetryInvestigation.taskState.objective.request, 'investigate delivery retry handling');
  assert.equal(resumedRetryInvestigation.taskState.recoveries[0].status, 'RECOVERED');
  assert.ok(resumedRetryInvestigation.taskState.evidence.inspectionEvidence.some((entry) => (
    entry.path === 'src/workers/retry-handler.ts' && entry.lineRange.complete
  )));

  // TEST 3C: Exhausting the bounded retry leaves the user's investigation incomplete.
  const exhaustedRecoveryResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'investigate cache invalidation failure',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => {
        const error = new Error('Project search index remains busy.');
        error.code = 'EBUSY';
        throw error;
      },
    },
  });
  assert.equal(exhaustedRecoveryResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(exhaustedRecoveryResult.taskState.status, 'INCOMPLETE');
  assert.equal(exhaustedRecoveryResult.taskState.objective.request, 'investigate cache invalidation failure');
  assert.ok(exhaustedRecoveryResult.taskState.recoveries.length > 0);
  assert.ok(exhaustedRecoveryResult.taskState.recoveries.every((event) => (
    event.status === 'FAILED' && event.objectiveStatus === 'IN_PROGRESS' && event.attempts === 2
  )));
  assert.equal(exhaustedRecoveryResult.codeApplied, false);

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

  // TEST 5: Search-budget exhaustion is resumable without repeating completed queries.
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
  assert.equal(boundedSearchQueries.length, 6);
  assert.equal(new Set(boundedSearchQueries).size, boundedSearchQueries.length);
  assert.equal(boundedSearchResult.continuation.searchesCompleted.length, 6);
  assert.equal(boundedSearchResult.continuation.nextStep.tool, 'search_code');
  assert.equal(
    boundedSearchResult.continuation.goal,
    'trace profile routing behavior for alpha beta gamma delta epsilon zeta eta theta iota'
  );
  assert.equal(boundedSearchResult.continuation.nextAction.tool, 'search_code');
  assert.equal(boundedSearchResult.continuation.unresolvedQuestions.length, 1);
  assert.equal(boundedSearchResult.continuation.inspectionEvidence.length, 0);
  assert.ok(!boundedSearchQueries.includes(boundedSearchResult.continuation.nextStep.query));
  assert.equal(Object.hasOwn(boundedSearchResult, 'taskId'), false);
  await assert.rejects(
    () => developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'change the request while resuming',
      root: projectDir,
      sessionId,
      ownerWebContentsId,
      continuationToken: boundedSearchResult.continuation.token,
      tools: { searchCode: async () => ({ results: [] }) },
    }),
    /does not match this request, project, or renderer session/i,
  );
  let resumedSearchResult = boundedSearchResult;
  while (resumedSearchResult.continuation.status === 'READY_TO_RESUME') {
    resumedSearchResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'trace profile routing behavior for alpha beta gamma delta epsilon zeta eta theta iota',
      root: projectDir,
      sessionId,
      ownerWebContentsId,
      continuationToken: resumedSearchResult.continuation.token,
      tools: {
        searchCode: async (query) => {
          boundedSearchQueries.push(query);
          return { results: [] };
        },
      },
    });
  }
  assert.equal(resumedSearchResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(resumedSearchResult.continuation.status, 'NEEDS_NARROWER_REQUEST');
  assert.equal(boundedSearchQueries.length, new Set(boundedSearchQueries).size);
  assert.equal(resumedSearchResult.continuation.searchesCompleted.length, boundedSearchQueries.length);
  assert.equal(resumedSearchResult.outcome, 'INVESTIGATION_INCOMPLETE', 'Exhausting searches without source evidence must not claim a clean result.');
  assert.match(resumedSearchResult.message, /no root cause or absence-of-defect claim/i);

  // TEST 5B: Progressive evidence, targeted large-file reads, missing content retry, and continuation preservation.
  const evidenceRequest = 'investigate application delivery state';
  const evidenceSearchCalls = [];
  const evidenceReadCalls = [];
  const largeEvidencePath = 'src/workflows/dispatch/decision-flow.ts';
  const evidenceSources = new Map([
    [largeEvidencePath, Array.from({ length: 12000 }, (_, index) => (
      index === 79 ? 'export async function submitDecision(payload) { return recordDecision(payload); }' : `// synthetic line ${index + 1}`
    )).join('\n')],
    ['services/decisions/record.ts', 'export function recordDecision(value) { return value; }'],
    ['docs/legacy/old-flow.md', 'This unrelated document describes an archived workflow.'],
  ]);
  const evidenceSearchResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: evidenceRequest,
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async (query) => {
        evidenceSearchCalls.push(query);
        if (evidenceSearchCalls.length === 1) return { results: [] };
        if (evidenceSearchCalls.length === 2) {
          return {
            results: [
              { path: 'docs/legacy/old-flow.md', line: 1, score: 1, matchType: 'content' },
              { path: 'services/decisions/record.ts', line: 1, score: 50, matchType: 'definition' },
              { path: largeEvidencePath, line: 80, score: 100, matchType: 'content' },
            ],
          };
        }
        return { results: [] };
      },
      readFile: async (filePath, range) => {
        evidenceReadCalls.push({ path: filePath, range });
        const source = evidenceSources.get(filePath);
        assert.equal(typeof source, 'string', `Unexpected synthetic read path: ${filePath}`);
        if (range) {
          const lines = source.split(/\r?\n/);
          const endLine = Math.min(range.endLine, lines.length);
          return {
            path: filePath,
            content: lines.slice(range.startLine - 1, endLine).join('\n'),
            lineRange: {
              startLine: range.startLine,
              endLine,
              totalLines: lines.length,
              complete: range.startLine === 1 && endLine === lines.length,
            },
          };
        }
        const totalLines = source.split(/\r?\n/).length;
        return {
          path: filePath,
          content: source,
          lineRange: { startLine: 1, endLine: totalLines, totalLines, complete: true },
        };
      },
    },
  });
  assert.equal(evidenceSearchCalls[0], 'application');
  assert.deepEqual(
    evidenceSearchResult.continuation.searchesCompleted[0].candidates,
    [],
    'An initial zero-result search must remain recorded as zero results.'
  );
  assert.equal(evidenceSearchResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.deepEqual(evidenceSearchResult.findings, [], 'Search matches alone must not establish a defect.');
  assert.equal(evidenceSearchResult.codeApplied, false);
  assert.equal(evidenceSearchResult.codeVerified, false);
  assert.equal(evidenceSearchResult.continuation.goal, evidenceRequest);
  assert.equal(evidenceSearchResult.continuation.nextAction.tool, 'read_file');
  assert.equal(evidenceSearchResult.continuation.inspectionEvidence[0].path, largeEvidencePath);
  assert.equal(evidenceSearchResult.continuation.inspectionEvidence[0].lineRange.complete, false);
  assert.equal(evidenceSearchResult.continuation.inspectionEvidence[0].executionFlow.action, 'submitDecision');
  assert.equal(evidenceSearchResult.continuation.inspectionEvidence[0].executionFlow.traceComplete, false);
  assert.equal(evidenceSearchResult.continuation.unresolvedQuestions.length, 1);
  assert.equal(evidenceSearchResult.continuation.nextAction.path, largeEvidencePath);
  assert.deepEqual(evidenceReadCalls.slice(0, 3).map((call) => call.path), [
    largeEvidencePath,
    'services/decisions/record.ts',
    'docs/legacy/old-flow.md',
  ], 'Evidence-ranked results must be inspected before unrelated lower-scored files.');
  assert.deepEqual(evidenceReadCalls[0].range, { startLine: 60, endLine: 100 });

  const completedEvidenceResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: evidenceRequest,
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    continuationToken: evidenceSearchResult.continuation.token,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => ({ results: [] }),
      readFile: async (filePath, range) => {
        evidenceReadCalls.push({ path: filePath, range });
        const source = evidenceSources.get(filePath);
        const totalLines = source.split(/\r?\n/).length;
        return {
          path: filePath,
          content: source,
          lineRange: { startLine: 1, endLine: totalLines, totalLines, complete: true },
        };
      },
    },
  });
  assert.equal(completedEvidenceResult.outcome, 'NO_DEFECT_FOUND');
  assert.deepEqual(completedEvidenceResult.inspectedFiles, [
    largeEvidencePath,
    'services/decisions/record.ts',
    'docs/legacy/old-flow.md',
  ]);
  assert.ok(
    completedEvidenceResult.inspectionEvidence.some((entry) => (
      entry.path === largeEvidencePath && entry.lineRange.complete && entry.executionFlow.action === 'submitDecision'
    )),
    'The resumed report must retain the goal-linked action and full-source evidence.'
  );
  assert.equal(evidenceReadCalls[3].range, undefined, 'The resume should fetch the complete source after targeted inspection.');

  // A skipped/malformed source result is not evidence; retry it through the continuation before concluding.
  let malformedReadAttempts = 0;
  const malformedReadRanges = [];
  const malformedSourceResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'investigate cyclone',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => ({ results: [{ path: 'src/custom/cyclone.ts', line: 4, score: 10 }] }),
      readFile: async (filePath, range) => {
        malformedReadAttempts += 1;
        malformedReadRanges.push(range);
        return malformedReadAttempts === 1
          ? { path: filePath, skipped: true }
          : { path: filePath, content: 'export function calmWeather() { return true; }' };
      },
    },
  });
  assert.equal(malformedSourceResult.outcome, 'INVESTIGATION_INCOMPLETE');
  assert.equal(malformedSourceResult.inspectedFiles.length, 0);
  assert.equal(malformedSourceResult.continuation.nextAction.tool, 'read_file');
  assert.ok(malformedSourceResult.readFailures[0].reason.includes('no text content'));
  const retriedSourceResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'investigate cyclone',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    continuationToken: malformedSourceResult.continuation.token,
    tools: {
      operatingMode: 'INVESTIGATE',
      searchCode: async () => ({ results: [] }),
      readFile: async (filePath, range) => {
        malformedReadAttempts += 1;
        malformedReadRanges.push(range);
        return { path: filePath, content: 'export function calmWeather() { return true; }' };
      },
    },
  });
  assert.equal(malformedReadAttempts, 2);
  assert.deepEqual(malformedReadRanges[0], { startLine: 1, endLine: 24 });
  assert.equal(malformedReadRanges[1], undefined);
  assert.equal(retriedSourceResult.outcome, 'NO_DEFECT_FOUND');
  assert.deepEqual(retriedSourceResult.inspectedFiles, ['src/custom/cyclone.ts']);

  let cancellationRequested = false;
  const cancelledInvestigation = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'inspect the personal controller update failure',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    isCancelled: () => cancellationRequested,
    requestApproval: async () => {
      assert.fail('A cancelled investigation must not request or apply a proposal.');
    },
    tools: {
      searchCode: async () => {
        cancellationRequested = true;
        return { results: [{ path: 'modules/personal/controllers/FormController.php', score: 100 }] };
      },
    },
  });
  assert.equal(cancelledInvestigation.outcome, 'CANCELLED');
  assert.equal(cancelledInvestigation.codeApplied, false);
  assert.equal(cancelledInvestigation.codeVerified, false);
  assert.deepEqual(cancelledInvestigation.filesModified, []);
  assert.equal(
    await fs.readFile(path.join(projectDir, 'modules/personal/controllers/FormController.php'), 'utf8'),
    initialFormController,
  );

  // Reproduction: cancellation while a repair approval is resolving must prevent repair writes.
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);
  let cancellationDuringRepairApproval = false;
  let repairMutationAfterCancellation = false;
  const cancelledRepairResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: mockRelevance(),
    autoRepairEnabled: true,
    maxRepairAttempts: 2,
    runCheck: async () => ({
      ok: false,
      status: 'CODE_FAILURE',
      executed: true,
      exitCode: 1,
      stderr: 'synthetic verification failure',
    }),
    requestApproval: async ({ taskId, isRepair }) => {
      if (isRepair) {
        cancellationDuringRepairApproval = true;
        return true;
      }
      return true;
    },
    isCancelled: () => cancellationDuringRepairApproval,
    tools: {
      authorizeMutation: async ({ rollback }) => {
        if (cancellationDuringRepairApproval && !rollback) repairMutationAfterCancellation = true;
        return { allowed: true };
      },
      autoRepairEnabled: true,
      maxRepairAttempts: 2,
      repairHandler: async ({ targetFile }) => {
        const diskContent = await fs.readFile(path.join(projectDir, targetFile), 'utf8');
        const beforeLines = diskContent.split(/\r?\n/);
        if (diskContent.endsWith('\n') && beforeLines.at(-1) === '') beforeLines.pop();
        const repairedContent = `${diskContent}// bounded repair fixture\n`;
        const afterLines = repairedContent.split(/\r?\n/);
        if (repairedContent.endsWith('\n') && afterLines.at(-1) === '') afterLines.pop();
        return {
          patch: [
            `--- a/${targetFile}`,
            `+++ b/${targetFile}`,
            `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
            ...beforeLines.map((line) => `-${line}`),
            ...afterLines.map((line) => `+${line}`),
            '',
          ].join('\n'),
        };
      },
    },
  });
  assert.equal(cancelledRepairResult.outcome, 'CANCELLED');
  assert.equal(repairMutationAfterCancellation, false, 'Repair must not mutate after cancellation was requested.');
  assert.equal(
    await fs.readFile(path.join(projectDir, 'modules/personal/controllers/FormController.php'), 'utf8'),
    initialFormController,
    `Cancellation must leave the fixture at its pre-workflow content: ${JSON.stringify({
      result: cancelledRepairResult,
      taskError: developerAgent.getTaskForTest(cancelledRepairResult.taskId)?.error,
    })}`,
  );

  // TEST 6: Unavailable verification cannot become successful application or verified success.
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);
  const unavailableResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: mockRelevance(),
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

  // Synthetic gate result: blocked verification must remain blocked and must not claim execution.
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);
  const blockedVerificationResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: mockRelevance(),
    runCheck: async () => ({
      ok: false,
      status: 'BLOCKED',
      executionBlocked: true,
      evidenceState: 'NOT_ESTABLISHED',
      executed: false,
      exitCode: null,
      reason: 'Synthetic fixture: host execution gate did not authorize verification.',
    }),
    requestApproval: async () => true,
  });
  assert.equal(blockedVerificationResult.outcome, 'VERIFICATION_BLOCKED');
  assert.equal(blockedVerificationResult.phase, 'VERIFY');
  assert.equal(blockedVerificationResult.verificationStatus, 'BLOCKED');
  assert.equal(
    blockedVerificationResult.taskPlan.subtasks.find((subtask) => subtask.id === 'ST-5').status,
    'BLOCKED',
  );
  assert.equal(blockedVerificationResult.codeApplied, false);
  assert.equal(blockedVerificationResult.codeVerified, false);
  assert.deepEqual(blockedVerificationResult.filesModified, []);
  assert.equal(
    developerAgent.getTaskForTest(blockedVerificationResult.taskId).verification.executed,
    false,
    'A blocked synthetic gate result must not be reported as executed verification.',
  );
  assert.equal(
    await fs.readFile(path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'), 'utf8'),
    initialFormController,
    'A blocked verification must restore the pre-apply snapshot.',
  );

  // Synthetic rollback authorization failure must not be reported as restored.
  await developerFiles.discoverProjectByName('modular-app', ownerWebContentsId);
  const rollbackFailureResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: mockRelevance(),
    runCheck: async () => ({
      ok: false,
      status: 'BLOCKED',
      executionBlocked: true,
      evidenceState: 'NOT_ESTABLISHED',
      executed: false,
      exitCode: null,
      reason: 'Synthetic fixture: host execution gate did not authorize verification.',
    }),
    requestApproval: async () => true,
    tools: {
      authorizeMutation: async ({ rollback }) => rollback
        ? { allowed: false, reason: 'Synthetic fixture: rollback authorization denied.' }
        : { allowed: true },
    },
  });
  assert.equal(rollbackFailureResult.outcome, 'VERIFICATION_BLOCKED');
  assert.equal(rollbackFailureResult.rollbackFailed, true);
  assert.equal(rollbackFailureResult.codeApplied, true);
  assert.deepEqual(rollbackFailureResult.filesModified, ['modules/personal/controllers/FormController.php']);
  assert.notEqual(
    await fs.readFile(path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'), 'utf8'),
    initialFormController,
    'A denied rollback must leave the synthetic applied patch visible for recovery.',
  );
  await fs.writeFile(
    path.join(projectDir, 'modules', 'personal', 'controllers', 'FormController.php'),
    initialFormController,
    'utf8',
  );

  // TEST 7: A failing runner remains a failure and the patch is rolled back.
  const failingResult = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'fix unhandled die and debugProbe in personal controller',
    root: projectDir,
    sessionId,
    ownerWebContentsId,
    assessFindingRelevance: mockRelevance(),
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
    assessFindingRelevance: mockRelevance(),
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
    assessFindingRelevance: mockRelevance(),
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

  assert.equal(fixResult.outcome, 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED', JSON.stringify(fixResult));
  assert.equal(fixResult.phase, 'AUDIT');
  assert.equal(fixResult.taskPlan.status, 'BLOCKED');
  assert.equal(fixResult.taskPlan.workItems[0].status, 'BLOCKED');
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

  const largeFilePath = path.join(projectDir, 'modules', 'personal', 'controllers', 'LargeProfileController.php');
  const largeFileContent = `<?php\nclass LargeProfileController {}\n${'// retained source context\n'.repeat(24000)}`;
  await fs.writeFile(largeFilePath, largeFileContent, 'utf8');
  const largeFileSearch = await developerFiles.searchCode('LargeProfileController', ownerWebContentsId, '.');
  assert.ok(largeFileSearch.results.some((result) => result.path.endsWith('LargeProfileController.php')));
  const largeFileRead = await developerFiles.readFile('modules/personal/controllers/LargeProfileController.php', ownerWebContentsId);
  assert.equal(largeFileRead.content, largeFileContent);
  const largeFileRegion = await developerFiles.readFile(
    'modules/personal/controllers/LargeProfileController.php',
    ownerWebContentsId,
    { startLine: 12000, endLine: 12005 }
  );
  assert.equal(largeFileRegion.content.split(/\r?\n/).length, 6);
  assert.deepEqual(largeFileRegion.lineRange, {
    startLine: 12000,
    endLine: 12005,
    totalLines: 24003,
    complete: false,
  });

  const mixedSymbolPath = path.join(projectDir, 'src', 'mixed-symbols.py');
  await fs.mkdir(path.dirname(mixedSymbolPath), { recursive: true });
  await fs.writeFile(
    mixedSymbolPath,
    '"""Example text:\ndef requested_operation():\n    pass\n"""\ndef requested_operation():\n    return True\n',
    'utf8'
  );
  const mixedSymbolSearch = await developerFiles.searchCode('requested_operation', ownerWebContentsId, '.');
  const mixedSymbolMatches = mixedSymbolSearch.results.filter((result) => result.path.endsWith('mixed-symbols.py'));
  assert.ok(mixedSymbolMatches.some((result) => result.line === 2 && result.matchType === 'content'));
  assert.ok(mixedSymbolMatches.some((result) => result.line === 5 && result.matchType === 'definition'));

  console.log('Production End-to-End Autonomous Coding Workflow integration verified successfully.');
} finally {
  developerAgent.releaseSession(ownerWebContentsId);
  developerFiles.releaseProject(ownerWebContentsId);
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
