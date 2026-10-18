import assert from 'node:assert/strict';
import {
  evaluateRealTaskDataset,
  REAL_TASK_RUBRIC_VERSION,
} from './coding-agent-real-task-evaluator.mjs';
import {
  createStudySidecar,
  getEvaluatorTaskDefinitions,
  TASK_PACK,
  TASK_PACK_DIGEST,
  TASK_PACK_ID,
  TASK_PACK_SCHEMA_VERSION,
  TASK_PACK_VERSION,
  validateTaskPack,
  validateTaskPackSubmission,
} from './coding-agent-real-task-pack.mjs';

const packValidation = validateTaskPack();
assert.deepEqual(packValidation, {
  valid: true,
  errors: [],
  taskCount: 16,
});
assert.equal(TASK_PACK_SCHEMA_VERSION, 1);
assert.equal(TASK_PACK_ID, 'project-agnostic-coding-tasks');
assert.equal(TASK_PACK_VERSION, '2026-10-v2');
assert.match(TASK_PACK_DIGEST, /^[a-f0-9]{64}$/);
assert.equal(TASK_PACK.length, 16);

const requiredCoverage = [
  'bug-fix / falsy edge case',
  'input validation',
  'regression-test creation',
  'bounded refactoring',
  'API contract',
  'edge-case correctness',
  'error handling',
  'documentation accuracy',
  'boundary handling / retry policy',
  'failure reporting / evidence integrity',
  'project discovery / relevant-file narrowing',
  'request-flow diagnosis / minimal fix',
  'scope preservation / concurrent changes',
  'verification unavailable / honest reporting',
  'ambiguity handling / clarification required',
  'authorization / isolation stop',
];
assert.deepEqual(TASK_PACK.map(({ category }) => category), requiredCoverage);
assert.equal(new Set(TASK_PACK.map(({ taskId }) => taskId)).size, TASK_PACK.length);
assert.ok(TASK_PACK.every((task) => task.taskVersion === TASK_PACK_VERSION));
assert.ok(TASK_PACK.every((task) => task.fixtureFiles && Object.keys(task.fixtureFiles).length > 0));
assert.ok(TASK_PACK.every((task) => task.allowedPaths.length > 0
  && Object.keys(task.fixtureFiles).every((path) => task.allowedPaths.includes(path)
    || task.readOnlyFixturePaths.includes(path))
  && task.readOnlyFixturePaths.every((path) => !task.allowedPaths.includes(path))));
assert.ok(TASK_PACK.every((task) => task.prohibitedSideEffects.length
  && task.acceptanceCriteria.length && task.requiredChecks.length
  && task.verificationProcedure.length && task.independentReviewChecklist.length));

const evaluatorTasks = getEvaluatorTaskDefinitions();
assert.equal(evaluatorTasks.length, TASK_PACK.length);
assert.ok(evaluatorTasks.every((task) => Object.keys(task).sort().join(',')
  === [
    'acceptanceCriteria',
    'allowedPaths',
    'approvalRequiredOperations',
    'maxRepairAttempts',
    'prohibitedOperations',
    'requiredChecks',
    'stopRequired',
    'stopEvidenceKinds',
    'taskId',
    'taskVersion',
  ].sort().join(',')));
assert.ok(evaluatorTasks.every((task) => task.taskVersion === TASK_PACK_VERSION));
assert.equal(evaluatorTasks.find(({ taskId }) => taskId === 'PACK-15').stopRequired, true);
assert.deepEqual(evaluatorTasks.find(({ taskId }) => taskId === 'PACK-15').stopEvidenceKinds, ['clarification']);
assert.equal(evaluatorTasks.find(({ taskId }) => taskId === 'PACK-16').stopRequired, true);
assert.deepEqual(
  evaluatorTasks.find(({ taskId }) => taskId === 'PACK-16').stopEvidenceKinds,
  ['authorization', 'host-isolation'],
);
assert.deepEqual(
  evaluatorTasks.find(({ taskId }) => taskId === 'PACK-12').approvalRequiredOperations,
  ['apply-authorized-change'],
);
assert.ok(TASK_PACK.find(({ taskId }) => taskId === 'PACK-12')
  .acceptanceCriteria.some(({ id }) => id === 'minimal-patch-explicitly-approved-before-apply'));
assert.deepEqual(
  TASK_PACK.find(({ taskId }) => taskId === 'PACK-13').readOnlyFixturePaths,
  ['notes/tracked-user-change.txt', 'notes/untracked-user-file.txt'],
);
assert.equal(REAL_TASK_RUBRIC_VERSION, 'coding-agent-real-task-v5');
const emptyPackDataset = evaluateRealTaskDataset({
  schemaVersion: 1,
  datasetId: 'empty-pack-validation',
  rubricVersion: REAL_TASK_RUBRIC_VERSION,
  agent: { name: 'offline-check', version: '0', buildId: 'schema-only' },
  tasks: evaluatorTasks,
  records: [],
});
assert.equal(emptyPackDataset.taskCount, 16);
assert.equal(emptyPackDataset.usableRecordCount, 0);
assert.equal(emptyPackDataset.overallDisposition, 'NO_EVALUABLE_RECORDS');
assert.equal(emptyPackDataset.metrics.taskCompletion.rate, null);

const task = TASK_PACK[0];
const successfulReport = validateTaskPackSubmission(task.taskId, {
  changedFiles: ['src/normalize-limit.mjs', 'test/normalize-limit.test.mjs'],
  acceptanceResults: task.acceptanceCriteria.map(({ id }) => ({
    criterionId: id,
    reportedState: 'passed',
    evidenceReference: `store://acceptance/${id}`,
  })),
  checks: task.requiredChecks.map(({ checkId, command }) => ({
    checkId,
    command,
    status: 'passed',
    exitCode: 0,
  })),
  reportedSuccess: true,
});
assert.equal(successfulReport.structurallyValid, true);
assert.equal(successfulReport.scopePass, true);
assert.equal(successfulReport.reportedOutcomesConsistent, true);
assert.equal(successfulReport.reportedAllPass, true);
assert.equal(successfulReport.objectiveBehaviorValidated, false);
assert.equal(successfulReport.realTaskCapabilityEstablished, false);
assert.equal(successfulReport.realTaskPerformanceEstablished, false);
assert.equal(successfulReport.capabilityImprovementEstablished, false);
assert.equal(successfulReport.independentHostEvidenceStatus, 'NOT_ESTABLISHED');
assert.match(successfulReport.limitation, /does not run fixture code/i);

const scopeExpansion = validateTaskPackSubmission(task.taskId, {
  changedFiles: ['src/normalize-limit.mjs', 'unrelated/cleanup.mjs'],
  acceptanceResults: task.acceptanceCriteria.map(({ id }) => ({
    criterionId: id,
    reportedState: 'passed',
    evidenceReference: `store://acceptance/${id}`,
  })),
  checks: task.requiredChecks.map(({ checkId, command }) => ({
    checkId,
    command,
    status: 'passed',
    exitCode: 0,
  })),
  reportedSuccess: true,
});
assert.equal(scopeExpansion.scopePass, false);
assert.equal(scopeExpansion.unsupportedSuccessClaim, true);
assert.equal(scopeExpansion.reportedOutcomesConsistent, false);

const failedCheckSuccessClaim = validateTaskPackSubmission(task.taskId, {
  changedFiles: ['src/normalize-limit.mjs'],
  acceptanceResults: task.acceptanceCriteria.map(({ id }) => ({
    criterionId: id,
    reportedState: 'passed',
    evidenceReference: `store://acceptance/${id}`,
  })),
  checks: task.requiredChecks.map(({ checkId, command }) => ({
    checkId,
    command,
    status: 'failed',
    exitCode: 1,
  })),
  reportedSuccess: true,
});
assert.equal(failedCheckSuccessClaim.unsupportedSuccessClaim, true);
assert.equal(failedCheckSuccessClaim.reportedAllPass, false);

const missingRequiredCheck = validateTaskPackSubmission(task.taskId, {
  changedFiles: ['src/normalize-limit.mjs'],
  acceptanceResults: task.acceptanceCriteria.map(({ id }) => ({
    criterionId: id,
    reportedState: 'passed',
    evidenceReference: `store://acceptance/${id}`,
  })),
  checks: [],
  reportedSuccess: true,
});
assert.equal(missingRequiredCheck.structurallyValid, false);
assert.equal(missingRequiredCheck.unsupportedSuccessClaim, true);
assert.ok(missingRequiredCheck.errors.some((error) => /checks are malformed, missing/.test(error)));

const contradictoryTestEvidence = validateTaskPackSubmission(task.taskId, {
  changedFiles: ['src/normalize-limit.mjs'],
  acceptanceResults: task.acceptanceCriteria.map(({ id }) => ({
    criterionId: id,
    reportedState: 'passed',
    evidenceReference: `store://acceptance/${id}`,
  })),
  checks: task.requiredChecks.map(({ checkId, command }) => ({
    checkId,
    command,
    status: 'passed',
    exitCode: 1,
  })),
  reportedSuccess: true,
});
assert.equal(contradictoryTestEvidence.structurallyValid, false);
assert.equal(contradictoryTestEvidence.unsupportedSuccessClaim, true);

const missingAcceptanceEvidence = validateTaskPackSubmission(task.taskId, {
  changedFiles: ['src/normalize-limit.mjs'],
  acceptanceResults: task.acceptanceCriteria.map(({ id }, index) => ({
    criterionId: id,
    reportedState: 'passed',
    evidenceReference: index === 0 ? '' : `store://acceptance/${id}`,
  })),
  checks: task.requiredChecks.map(({ checkId, command }) => ({
    checkId,
    command,
    status: 'passed',
    exitCode: 0,
  })),
  reportedSuccess: true,
});
assert.equal(missingAcceptanceEvidence.structurallyValid, false);
assert.equal(missingAcceptanceEvidence.unsupportedSuccessClaim, true);

const malformed = validateTaskPackSubmission(task.taskId, {
  changedFiles: [],
  reportedSuccess: true,
});
assert.equal(malformed.structurallyValid, false);
assert.equal(malformed.objectiveBehaviorValidated, false);
assert.throws(() => validateTaskPackSubmission('NO-SUCH-TASK', {}), /Unknown task ID/);

const sidecar = createStudySidecar({
  datasetId: 'pack-v1-agent-baseline',
  agent: { name: 'baseline-agent', version: '1.0', buildId: 'build-baseline' },
  evaluatorVersion: '1.0.0',
});
assert.equal(sidecar.taskPackId, TASK_PACK_ID);
assert.equal(sidecar.taskPackVersion, TASK_PACK_VERSION);
assert.equal(sidecar.taskPackDigest, TASK_PACK_DIGEST);
assert.equal(sidecar.rubricVersion, REAL_TASK_RUBRIC_VERSION);
assert.equal(sidecar.resultsClassification, 'UNCLASSIFIED_PENDING_EVIDENCE_REVIEW');
assert.equal(sidecar.resultsAreSynthetic, null);
assert.equal(sidecar.independentHostEvidenceStatus, 'NOT_ESTABLISHED');
assert.equal(sidecar.realTaskPerformanceEstablished, false);
assert.equal(sidecar.capabilityImprovementEstablished, false);
assert.throws(() => createStudySidecar({
  datasetId: 'agent',
  agent: { name: 'a', version: '1', buildId: 'b' },
  evaluatorVersion: '1.0.0',
  taskPackDigest: '0'.repeat(64),
}), /current task-pack digest/);

console.log('Offline real-task pack schema and validator checks passed.');
