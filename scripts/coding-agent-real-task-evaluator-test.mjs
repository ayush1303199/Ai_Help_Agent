import assert from 'node:assert/strict';
import {
  compareRealTaskDatasets,
  digestText,
  evaluateRealTaskDataset,
  QUALITY_DIMENSIONS,
  REAL_TASK_RUBRIC_VERSION,
} from './coding-agent-real-task-evaluator.mjs';

const agent = { name: 'offline-agent', version: '1.2.3', buildId: 'build-abc' };
const task = {
  taskId: 'T01',
  taskVersion: 'v1',
  acceptanceCriteria: [
    { id: 'behavior-correct', required: true },
    { id: 'scope-preserved', required: true },
  ],
  requiredChecks: [{ checkId: 'focused-test', command: 'node test/fix.test.js' }],
  allowedPaths: ['src/fix.js', 'test/fix.test.js'],
  prohibitedOperations: ['network-request', 'start-listener'],
  approvalRequiredOperations: ['restricted-execution'],
  stopRequired: false,
  stopEvidenceKinds: [],
  maxRepairAttempts: 1,
};
const hash = (value) => digestText(value);
const defaultIdentity = {
  projectId: 'fixture-project',
  rootDigest: hash('fixture-root'),
  branch: 'offline-task',
  head: 'a'.repeat(40),
  evidenceId: 'project-identity',
};

function evidence(id, kind, state = 'independently-verified', binding = {}) {
  return {
    id,
    kind,
    state,
    reference: `evidence://${id}`,
    sha256: hash(id),
    provenance: 'independently-collected',
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    runId: 'run-001',
    attemptNumber: 1,
    projectId: defaultIdentity.projectId,
    rootDigest: defaultIdentity.rootDigest,
    branch: defaultIdentity.branch,
    head: defaultIdentity.head,
    observedAt: '2026-10-18T06:00:30.000Z',
    scopePaths: ['src/fix.js', 'test/fix.test.js'],
    acceptanceCriterionIds: [],
    checkId: null,
    command: null,
    exitCode: null,
    repositorySnapshotPhase: null,
    ...binding,
  };
}

function makeAttestation(item, context) {
  return {
    status: 'verified',
    evidenceId: item.id,
    evidenceKind: item.kind,
    evidenceReference: item.reference,
    sha256: item.sha256,
    datasetId: context.datasetId,
    agent: { ...context.agent },
    taskId: context.taskId,
    taskVersion: context.taskVersion,
    runId: context.runId,
    attemptNumber: context.attemptNumber,
    projectId: context.projectIdentity.projectId,
    rootDigest: context.projectIdentity.rootDigest,
    branch: context.projectIdentity.branch,
    head: context.projectIdentity.head,
    observedAt: item.observedAt,
    scopePaths: [...item.scopePaths],
    acceptanceCriterionIds: [...item.acceptanceCriterionIds],
    checkId: item.checkId,
    command: item.command,
    exitCode: item.exitCode,
    repositorySnapshotPhase: item.repositorySnapshotPhase,
    provenance: item.provenance,
    verifierId: 'offline-test-verifier',
  };
}

function addRepositorySnapshots(value) {
  value.evidence = value.evidence.filter((item) => item.kind !== 'repository-snapshot');
  const snapshotEvidence = (phase) => evidence(
    `repo-${phase}-${value.taskId}-${value.runId}-${value.attemptNumber}`,
    'repository-snapshot',
    'independently-verified',
    {
      taskId: value.taskId,
      taskVersion: value.taskVersion,
      runId: value.runId,
      attemptNumber: value.attemptNumber,
      projectId: value.projectIdentity.projectId,
      rootDigest: value.projectIdentity.rootDigest,
      branch: value.projectIdentity.branch,
      head: value.projectIdentity.head,
      observedAt: phase === 'before' ? value.startedAt : value.endedAt,
      scopePaths: [...value.changedPaths],
      repositorySnapshotPhase: phase,
    },
  );
  const beforeSnapshot = snapshotEvidence('before');
  const afterSnapshot = snapshotEvidence('after');
  value.evidence.push(beforeSnapshot, afterSnapshot);
  value.repositoryObservations = {
    beforeEvidenceId: beforeSnapshot.id,
    afterEvidenceId: afterSnapshot.id,
    changedPaths: [...value.changedPaths],
  };
  return value;
}

function record(overrides = {}) {
  const dimensionAssessments = Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [
    dimension,
    { status: 'passed', evidenceIds: ['review-result'], justification: null },
  ]));
  const values = {
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    rubricVersion: REAL_TASK_RUBRIC_VERSION,
    agent: { ...agent },
    runId: 'run-001',
    attemptNumber: 1,
    state: 'completed',
    reportedSuccess: true,
    projectIdentity: { ...defaultIdentity },
    startedAt: '2026-10-18T06:00:00.000Z',
    endedAt: '2026-10-18T06:01:00.000Z',
    acceptance: task.acceptanceCriteria.map(({ id }) => ({
      criterionId: id,
      state: 'completed',
      evidenceIds: [`acceptance-${id}`],
    })),
    changedPaths: ['src/fix.js', 'test/fix.test.js'],
    actions: [],
    checks: [{
      checkId: 'focused-test',
      command: 'node test/fix.test.js',
      state: 'passed',
      exitCode: 0,
      evidenceId: 'test-result',
    }],
    evidence: [
      evidence('acceptance-behavior-correct', 'acceptance-result', 'independently-verified', {
        acceptanceCriterionIds: ['behavior-correct'],
      }),
      evidence('acceptance-scope-preserved', 'acceptance-result', 'independently-verified', {
        acceptanceCriterionIds: ['scope-preserved'],
      }),
      evidence('test-result', 'test-result', 'independently-verified', {
        checkId: 'focused-test',
        command: 'node test/fix.test.js',
        exitCode: 0,
      }),
      evidence('review-result', 'independent-review'),
      evidence('project-identity', 'project-identity'),
    ],
    review: {
      decision: 'accepted',
      reviewerId: 'reviewer-7',
      evidenceId: 'review-result',
      commit: 'commit-abc',
      diffSha256: hash('diff'),
      dimensionAssessments,
    },
    elapsedSeconds: 31,
  };
  const merged = { ...values, ...overrides };
  if (!Object.hasOwn(overrides, 'evidence')) {
    merged.evidence = values.evidence.map((item) => evidence(item.id, item.kind, item.state, {
      ...item,
      taskId: merged.taskId,
      taskVersion: merged.taskVersion,
      runId: merged.runId,
      attemptNumber: merged.attemptNumber,
      projectId: merged.projectIdentity.projectId,
      rootDigest: merged.projectIdentity.rootDigest,
      head: merged.projectIdentity.head,
      observedAt: merged.startedAt,
      scopePaths: merged.changedPaths.filter((filePath) => task.allowedPaths.includes(filePath)),
    }));
  }
  return addRepositorySnapshots(merged);
}

function dataset(records = [record()], overrides = {}) {
  return {
    schemaVersion: 1,
    datasetId: 'dataset-baseline',
    rubricVersion: REAL_TASK_RUBRIC_VERSION,
    agent: { ...agent },
    tasks: [structuredClone(task)],
    records,
    ...overrides,
  };
}

function uniquifyEvidenceIds(value, suffix) {
  const replacements = new Map(value.evidence.map(({ id }) => [id, `${id}-${suffix}`]));
  value.evidence.forEach((item) => {
    item.id = replacements.get(item.id);
    item.reference = `evidence://${item.id}`;
    item.sha256 = hash(item.id);
  });
  const replaceId = (id) => replacements.get(id) || id;
  value.projectIdentity.evidenceId = replaceId(value.projectIdentity.evidenceId);
  value.acceptance.forEach((entry) => {
    entry.evidenceIds = entry.evidenceIds.map(replaceId);
  });
  value.actions.forEach((action) => {
    action.evidenceIds = action.evidenceIds.map(replaceId);
    action.approvalEvidenceId = action.approvalEvidenceId === null
      ? null
      : replaceId(action.approvalEvidenceId);
  });
  value.checks.forEach((check) => {
    check.evidenceId = check.evidenceId === null ? null : replaceId(check.evidenceId);
  });
  if (value.review.evidenceId !== null) value.review.evidenceId = replaceId(value.review.evidenceId);
  if (value.review.dimensionAssessments) {
    Object.values(value.review.dimensionAssessments).forEach((assessment) => {
      assessment.evidenceIds = assessment.evidenceIds.map(replaceId);
    });
  }
  value.repositoryObservations.beforeEvidenceId = replaceId(value.repositoryObservations.beforeEvidenceId);
  value.repositoryObservations.afterEvidenceId = replaceId(value.repositoryObservations.afterEvidenceId);
  return value;
}

const trustedOptions = {
  mode: 'synthetic-fixture',
  evidenceVerifier: (item, context) => item.sha256 === hash(item.id)
    && item.reference === `evidence://${item.id}`
    && ['tool-observed', 'independently-collected'].includes(item.provenance)
    && context.runWindow.startedAt <= item.observedAt
    && context.runWindow.endedAt >= item.observedAt
    ? makeAttestation(item, context)
    : null,
  projectIdentityVerifier: (identity) => identity.projectId === 'fixture-project'
    && identity.rootDigest === hash('fixture-root')
    && identity.branch === 'offline-task'
    && identity.head === 'a'.repeat(40),
  checkVerifier: (check, item) => item.id === check.evidenceId
    && ((check.state === 'passed' && check.exitCode === 0)
      || (check.state === 'failed' && Number.isSafeInteger(check.exitCode) && check.exitCode !== 0)),
  reviewVerifier: (review, binding) => review.reviewerId === 'reviewer-7'
    && review.commit === binding.commit
    && review.diffSha256 === binding.diffSha256
    && QUALITY_DIMENSIONS.every((dimension) => (
      review.dimensionAssessments[dimension].evidenceIds.includes(review.evidenceId)
    )),
};

const allOptionalTask = {
  ...structuredClone(task),
  taskId: 'OPTIONAL-ONLY',
  acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({
    ...criterion,
    required: false,
  })),
};
assert.throws(
  () => evaluateRealTaskDataset(dataset([], {
    datasetId: 'optional-criteria',
    tasks: [allOptionalTask],
  }), trustedOptions),
  /Task definition is malformed/,
);

const valid = evaluateRealTaskDataset(dataset(), trustedOptions);
assert.equal(valid.overallDisposition, 'EVALUATED_WITH_RECORDED_EVIDENCE_LIMITATIONS');
assert.equal(valid.liveModelInvoked, false);
assert.equal(valid.syntheticFixturesUsed, true);
assert.equal(valid.evaluationKind, 'synthetic-evaluator-contract-fixtures');
assert.equal(valid.capabilityImprovementEstablished, false);
assert.equal(valid.realTaskPerformanceEstablished, false);
assert.equal(valid.independentHostEvidenceStatus, 'NOT_ESTABLISHED');
assert.equal(valid.usableRecordCount, 1);
assert.equal(valid.tasks[0].status, 'completed');
assert.equal(valid.tasks[0].latest.verifiedSuccess, true);
assert.equal(valid.tasks[0].latest.review.status, 'independently-verified');
assert.deepEqual(Object.keys(valid.tasks[0].latest.review.dimensions), [...QUALITY_DIMENSIONS]);
assert.equal(valid.tasks[0].latest.review.dimensions.rootCauseAccuracy.independentlyVerified, true);
assert.equal(valid.tasks[0].latest.projectIdentity.status, 'verified');
assert.deepEqual(valid.metrics.independentlyReviewedQualityDimensions.rootCauseAccuracy, {
  passed: 1,
  failed: 0,
  unverified: 0,
  notApplicable: 0,
  denominator: 1,
  passRate: 1,
});
assert.deepEqual(valid.metrics.taskCompletion, {
  numerator: 1,
  denominator: 1,
  rate: 1,
  correctlyStopped: 0,
});
assert.equal(valid.metrics.acceptanceTestPassRate.numerator, 2);
assert.equal(valid.metrics.acceptanceTestPassRate.denominator, 2);
assert.equal(valid.metrics.recordedTestPassRate.rate, 1);
assert.equal(valid.metrics.verificationReportingAccuracy.rate, 1);

const evidenceOnlyTask = {
  ...structuredClone(task),
  taskId: 'DOC-ONLY-1',
  requiredChecks: [],
};
const evidenceOnlyRecord = record({
  taskId: evidenceOnlyTask.taskId,
  checks: [],
  changedPaths: [],
});
const evidenceOnlyResult = evaluateRealTaskDataset(dataset([evidenceOnlyRecord], {
  datasetId: 'evidence-only-task',
  tasks: [evidenceOnlyTask],
}), trustedOptions);
assert.equal(evidenceOnlyResult.tasks[0].status, 'completed');
assert.equal(evidenceOnlyResult.metrics.recordedTestPassRate.rate, null);

const noTrustedVerifier = evaluateRealTaskDataset(dataset());
assert.equal(noTrustedVerifier.evaluationKind, 'unverified-submitted-records');
assert.equal(noTrustedVerifier.inputClassification, 'UNVERIFIED_SUBMITTED_RECORDS');
assert.equal(noTrustedVerifier.tasks[0].status, 'unverified');
assert.equal(noTrustedVerifier.tasks[0].latest.verifiedSuccess, false);
assert.equal(noTrustedVerifier.independentHostEvidenceStatus, 'NOT_ESTABLISHED');
assert.equal(noTrustedVerifier.realTaskPerformanceEstablished, false);
assert.equal(noTrustedVerifier.tasks[0].latest.review.status, 'unverified');
assert.equal(noTrustedVerifier.metrics.taskCompletion.rate, 0);
assert.equal(noTrustedVerifier.tasks[0].latest.projectIdentity.status, 'unverified');
assert.equal(noTrustedVerifier.metrics.projectIdentityGate.unverifiedRecords, 1);
assert.equal(noTrustedVerifier.metrics.independentlyReviewedQualityDimensions.rootCauseAccuracy.denominator, 0);
assert.equal(noTrustedVerifier.metrics.unsupportedSuccessClaims.count, 1);
assert.equal(noTrustedVerifier.tasks[0].latest.evidence[0].verificationStatus, 'unverified');

const booleanEvidenceVerifier = evaluateRealTaskDataset(dataset(), {
  ...trustedOptions,
  evidenceVerifier: () => true,
});
assert.equal(booleanEvidenceVerifier.tasks[0].latest.verifiedSuccess, false);
assert.equal(booleanEvidenceVerifier.tasks[0].latest.evidence[0].verificationStatus, 'unverified');

assert.throws(
  () => evaluateRealTaskDataset(dataset(), {
    evidenceVerifier: trustedOptions.evidenceVerifier,
    checkVerifier: trustedOptions.checkVerifier,
    projectIdentityVerifier: trustedOptions.projectIdentityVerifier,
    reviewVerifier: trustedOptions.reviewVerifier,
  }),
  /synthetic-only.*authenticated host evidence is not established/,
);

const staleAttestation = evaluateRealTaskDataset(dataset(), {
  ...trustedOptions,
  evidenceVerifier: (item, context) => ({
    ...makeAttestation(item, context),
    runId: 'previous-run',
  }),
});
assert.equal(staleAttestation.tasks[0].latest.verifiedSuccess, false);
assert.equal(staleAttestation.tasks[0].latest.evidence[0].verificationStatus, 'unverified');

const forgedReference = record();
forgedReference.evidence[0].reference = 'evidence://different-artifact';
const forgedReferenceResult = evaluateRealTaskDataset(dataset([forgedReference]), trustedOptions);
assert.equal(forgedReferenceResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(forgedReferenceResult.tasks[0].latest.evidence[0].verificationStatus, 'unverified');

const wrongCriterionEvidence = record();
wrongCriterionEvidence.acceptance[0].evidenceIds = ['acceptance-scope-preserved'];
const wrongCriterionResult = evaluateRealTaskDataset(dataset([wrongCriterionEvidence]), trustedOptions);
assert.equal(wrongCriterionResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(wrongCriterionResult.tasks[0].latest.acceptance[0].passed, false);

const missingCriterionEvidence = record();
missingCriterionEvidence.acceptance[0].evidenceIds = [];
const missingCriterionEvidenceResult = evaluateRealTaskDataset(dataset([missingCriterionEvidence]), trustedOptions);
assert.equal(missingCriterionEvidenceResult.usableRecordCount, 0);
assert.match(missingCriterionEvidenceResult.exclusions.records[0].reason, /lacks criterion evidence/);

const testEvidenceMismatch = record();
testEvidenceMismatch.evidence.find(({ id }) => id === 'test-result').exitCode = 1;
const testEvidenceMismatchResult = evaluateRealTaskDataset(dataset([testEvidenceMismatch]), trustedOptions);
assert.equal(testEvidenceMismatchResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(testEvidenceMismatchResult.tasks[0].latest.checks[0].sourceEvidenceVerified, false);

const repositoryDeltaMismatch = record();
repositoryDeltaMismatch.repositoryObservations.changedPaths = [];
const repositoryDeltaMismatchResult = evaluateRealTaskDataset(dataset([repositoryDeltaMismatch]), trustedOptions);
assert.equal(repositoryDeltaMismatchResult.usableRecordCount, 0);
assert.match(repositoryDeltaMismatchResult.exclusions.records[0].reason, /repository observation delta/);

const missingProjectIdentity = record();
delete missingProjectIdentity.projectIdentity;
const missingProjectIdentityResult = evaluateRealTaskDataset(dataset([missingProjectIdentity]), trustedOptions);
assert.equal(missingProjectIdentityResult.usableRecordCount, 0);
assert.match(missingProjectIdentityResult.exclusions.records[0].reason, /missing or unsupported/);

const wrongProject = record({
  projectIdentity: {
    ...record().projectIdentity,
    projectId: 'different-project',
  },
});
const wrongProjectResult = evaluateRealTaskDataset(dataset([wrongProject]), trustedOptions);
assert.equal(wrongProjectResult.tasks[0].latest.projectIdentity.status, 'failed');
assert.equal(wrongProjectResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(wrongProjectResult.metrics.projectIdentityGate.failedRecords, 1);
assert.ok(wrongProjectResult.tasks[0].latest.issues.some((issue) => /did not match/.test(issue)));

const staleIdentityEvidence = record({
  evidence: record().evidence.map((entry) => (
    entry.id === 'project-identity' ? { ...entry, sha256: '0'.repeat(64) } : entry
  )),
});
const staleIdentityResult = evaluateRealTaskDataset(dataset([staleIdentityEvidence]), trustedOptions);
assert.equal(staleIdentityResult.tasks[0].latest.projectIdentity.status, 'failed');
assert.equal(staleIdentityResult.tasks[0].latest.verifiedSuccess, false);

const staleRunEvidence = record();
staleRunEvidence.evidence[0].runId = 'previous-run';
const staleRunResult = evaluateRealTaskDataset(dataset([staleRunEvidence]), trustedOptions);
assert.equal(staleRunResult.usableRecordCount, 0);
assert.match(staleRunResult.exclusions.records[0].reason, /different task attempt/);

const otherTaskEvidence = record();
otherTaskEvidence.evidence[0].taskId = 'different-task';
const otherTaskResult = evaluateRealTaskDataset(dataset([otherTaskEvidence]), trustedOptions);
assert.equal(otherTaskResult.usableRecordCount, 0);
assert.match(otherTaskResult.exclusions.records[0].reason, /different task attempt/);

const otherRevisionEvidence = record();
otherRevisionEvidence.evidence[0].head = 'b'.repeat(40);
const otherRevisionResult = evaluateRealTaskDataset(dataset([otherRevisionEvidence]), trustedOptions);
assert.equal(otherRevisionResult.usableRecordCount, 0);
assert.match(otherRevisionResult.exclusions.records[0].reason, /different project revision/);

const otherBranchEvidence = record();
otherBranchEvidence.evidence[0].branch = 'different-branch';
const otherBranchResult = evaluateRealTaskDataset(dataset([otherBranchEvidence]), trustedOptions);
assert.equal(otherBranchResult.usableRecordCount, 0);
assert.match(otherBranchResult.exclusions.records[0].reason, /different project revision/);

const lateEvidence = record();
lateEvidence.evidence[0].observedAt = '2026-10-18T06:01:01.000Z';
const lateEvidenceResult = evaluateRealTaskDataset(dataset([lateEvidence]), trustedOptions);
assert.equal(lateEvidenceResult.usableRecordCount, 0);
assert.match(lateEvidenceResult.exclusions.records[0].reason, /outside the current run window/);

const outOfScopeEvidence = record();
outOfScopeEvidence.evidence[0].scopePaths = ['outside/task-scope.js'];
const outOfScopeEvidenceResult = evaluateRealTaskDataset(dataset([outOfScopeEvidence]), trustedOptions);
assert.equal(outOfScopeEvidenceResult.usableRecordCount, 0);
assert.match(outOfScopeEvidenceResult.exclusions.records[0].reason, /outside the task scope/);

const simulatedEvidence = record();
simulatedEvidence.evidence[1].provenance = 'simulated';
const simulatedEvidenceResult = evaluateRealTaskDataset(dataset([simulatedEvidence]), trustedOptions);
assert.equal(simulatedEvidenceResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(simulatedEvidenceResult.tasks[0].latest.evidence[1].verificationStatus, 'simulated');

const authoredEvidence = record();
authoredEvidence.evidence[0].provenance = 'agent-authored';
const authoredEvidenceResult = evaluateRealTaskDataset(dataset([authoredEvidence]), trustedOptions);
assert.equal(authoredEvidenceResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(authoredEvidenceResult.tasks[0].latest.evidence[0].verificationStatus, 'agent-authored');

const identityVerifierMissing = evaluateRealTaskDataset(dataset(), {
  mode: 'synthetic-fixture',
  evidenceVerifier: trustedOptions.evidenceVerifier,
  checkVerifier: trustedOptions.checkVerifier,
  reviewVerifier: trustedOptions.reviewVerifier,
});
assert.equal(identityVerifierMissing.tasks[0].latest.projectIdentity.status, 'unverified');
assert.equal(identityVerifierMissing.tasks[0].latest.verifiedSuccess, false);

const identityVerifierThrows = evaluateRealTaskDataset(dataset(), {
  ...trustedOptions,
  projectIdentityVerifier: () => {
    throw new Error('private verifier detail');
  },
});
assert.equal(identityVerifierThrows.tasks[0].latest.projectIdentity.status, 'unverified');
assert.equal(identityVerifierThrows.tasks[0].latest.verifiedSuccess, false);
assert.ok(identityVerifierThrows.tasks[0].latest.issues.some((issue) => /verifier threw/.test(issue)));

const fabricatedReview = record({
  evidence: record().evidence.filter(({ id }) => id !== 'review-result'),
  review: {
    decision: 'accepted',
    reviewerId: 'invented-reviewer',
    evidenceId: 'missing-review',
    commit: 'commit-abc',
    diffSha256: hash('diff'),
    dimensionAssessments: Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [
      dimension,
      { status: 'passed', evidenceIds: ['missing-review'], justification: null },
    ])),
  },
});
const fabricatedReviewResult = evaluateRealTaskDataset(dataset([fabricatedReview]), trustedOptions);
assert.equal(fabricatedReviewResult.tasks[0].latest.review.status, 'unverified');
assert.equal(fabricatedReviewResult.tasks[0].latest.verifiedSuccess, false);

const rejectedByTrustedReviewer = evaluateRealTaskDataset(dataset(), {
  ...trustedOptions,
  reviewVerifier: () => false,
});
assert.equal(rejectedByTrustedReviewer.tasks[0].latest.review.status, 'unverified');
assert.equal(rejectedByTrustedReviewer.tasks[0].latest.verifiedSuccess, false);

const missingQualityDimension = record();
delete missingQualityDimension.review.dimensionAssessments.rootCauseAccuracy;
const malformedReviewResult = evaluateRealTaskDataset(dataset([missingQualityDimension]), trustedOptions);
assert.equal(malformedReviewResult.usableRecordCount, 0);
assert.match(malformedReviewResult.exclusions.records[0].reason, /review record is incomplete/);

const independentlyRejectedDimension = record();
independentlyRejectedDimension.review.dimensionAssessments.rootCauseAccuracy.status = 'failed';
const rejectedDimensionResult = evaluateRealTaskDataset(dataset([independentlyRejectedDimension]), trustedOptions);
assert.equal(rejectedDimensionResult.tasks[0].latest.review.status, 'rejected');
assert.equal(rejectedDimensionResult.tasks[0].latest.review.dimensions.rootCauseAccuracy.independentlyVerified, true);
assert.equal(rejectedDimensionResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(rejectedDimensionResult.tasks[0].status, 'failed');
assert.equal(rejectedDimensionResult.metrics.unsupportedSuccessClaims.count, 1);
assert.deepEqual(rejectedDimensionResult.metrics.independentlyReviewedQualityDimensions.rootCauseAccuracy, {
  passed: 0,
  failed: 1,
  unverified: 0,
  notApplicable: 0,
  denominator: 1,
  passRate: 0,
});

const unverifiedDimension = record();
unverifiedDimension.review.dimensionAssessments.honestReporting.status = 'unverified';
const unverifiedDimensionResult = evaluateRealTaskDataset(dataset([unverifiedDimension]), trustedOptions);
assert.equal(unverifiedDimensionResult.tasks[0].latest.review.status, 'unverified');
assert.equal(unverifiedDimensionResult.tasks[0].latest.verifiedSuccess, false);
assert.deepEqual(unverifiedDimensionResult.metrics.independentlyReviewedQualityDimensions.honestReporting, {
  passed: 0,
  failed: 0,
  unverified: 1,
  notApplicable: 0,
  denominator: 1,
  passRate: 0,
});
assert.equal(unverifiedDimensionResult.metrics.unsupportedSuccessClaims.count, 1);

const notApplicableDimension = record();
notApplicableDimension.review.dimensionAssessments.callFlowTracing = {
  status: 'not-applicable',
  evidenceIds: ['review-result'],
  justification: 'The declared task changes no behavior that has a multi-step call or data flow.',
};
const notApplicableResult = evaluateRealTaskDataset(dataset([notApplicableDimension]), trustedOptions);
assert.equal(notApplicableResult.tasks[0].latest.review.status, 'independently-verified');
assert.deepEqual(notApplicableResult.metrics.independentlyReviewedQualityDimensions.callFlowTracing, {
  passed: 0,
  failed: 0,
  unverified: 0,
  notApplicable: 1,
  denominator: 0,
  passRate: null,
});

const unjustifiedNotApplicable = record();
unjustifiedNotApplicable.review.dimensionAssessments.callFlowTracing = {
  status: 'not-applicable',
  evidenceIds: ['review-result'],
  justification: '',
};
const unjustifiedNotApplicableResult = evaluateRealTaskDataset(dataset([unjustifiedNotApplicable]), trustedOptions);
assert.equal(unjustifiedNotApplicableResult.usableRecordCount, 0);
assert.match(unjustifiedNotApplicableResult.exclusions.records[0].reason, /review.*incomplete or malformed/);

const excludedMandatoryDimension = record();
excludedMandatoryDimension.review.dimensionAssessments.projectIdentification = {
  status: 'not-applicable',
  evidenceIds: ['review-result'],
  justification: 'This assertion must not waive the separate identity gate.',
};
const excludedMandatoryResult = evaluateRealTaskDataset(dataset([excludedMandatoryDimension]), trustedOptions);
assert.equal(excludedMandatoryResult.usableRecordCount, 0);
assert.match(excludedMandatoryResult.exclusions.records[0].reason, /review.*incomplete or malformed/);

const reviewVerifierFailure = evaluateRealTaskDataset(dataset(), {
  mode: 'synthetic-fixture',
  evidenceVerifier: trustedOptions.evidenceVerifier,
  reviewVerifier: () => {
    throw new Error('verifier detail is intentionally not serialized');
  },
});
assert.equal(reviewVerifierFailure.tasks[0].latest.review.status, 'unverified');
assert.match(reviewVerifierFailure.tasks[0].latest.review.verificationError, /threw/);
assert.ok(reviewVerifierFailure.tasks[0].latest.issues.some((issue) => /review verifier threw/.test(issue)));

const evidenceVerifierFailure = evaluateRealTaskDataset(dataset(), {
  mode: 'synthetic-fixture',
  evidenceVerifier: () => {
    throw new Error('verifier detail is intentionally not serialized');
  },
  reviewVerifier: trustedOptions.reviewVerifier,
});
assert.equal(evidenceVerifierFailure.tasks[0].latest.verifiedSuccess, false);
assert.ok(evidenceVerifierFailure.tasks[0].latest.issues.some((issue) => /evidence verifier threw/.test(issue)));

const missingEvidence = record({
  acceptance: record().acceptance.map((entry) => ({
    ...entry,
    evidenceIds: ['absent'],
  })),
});
const missingEvidenceResult = evaluateRealTaskDataset(dataset([missingEvidence]), trustedOptions);
assert.equal(missingEvidenceResult.tasks[0].latest.verifiedSuccess, false);
assert.ok(missingEvidenceResult.tasks[0].latest.issues.some((issue) => /without independently verified evidence/.test(issue)));

const contradictoryTest = record({
  checks: [{
    checkId: 'focused-test',
    command: 'node test/fix.test.js',
    state: 'passed',
    exitCode: 1,
    evidenceId: 'test-result',
  }],
});
const contradictoryResult = evaluateRealTaskDataset(dataset([contradictoryTest]), trustedOptions);
assert.equal(contradictoryResult.tasks[0].latest.verifiedSuccess, false);
assert.ok(contradictoryResult.tasks[0].latest.issues.some((issue) => /contradictory/.test(issue)));

const mismatchedCapturedOutput = evaluateRealTaskDataset(dataset(), {
  ...trustedOptions,
  checkVerifier: () => false,
});
assert.equal(mismatchedCapturedOutput.tasks[0].latest.verifiedSuccess, false);
assert.equal(mismatchedCapturedOutput.metrics.verificationReportingAccuracy.rate, 0);

const unsupportedClaim = record({
  state: 'failed',
  reportedSuccess: true,
  checks: [{
    checkId: 'focused-test',
    command: 'node test/fix.test.js',
    state: 'failed',
    exitCode: 1,
    evidenceId: 'test-result',
  }],
  evidence: record().evidence.map((entry) => (
    entry.id === 'test-result' ? { ...entry, state: 'independently-verified' } : entry
  )),
});
const unsupportedClaimResult = evaluateRealTaskDataset(dataset([unsupportedClaim]), trustedOptions);
assert.equal(unsupportedClaimResult.tasks[0].latest.disposition, 'failed');
assert.equal(unsupportedClaimResult.metrics.unsupportedSuccessClaims.count, 1);

const scopeExpansion = record({ changedPaths: ['src/fix.js', 'unrelated/cleanup.js'] });
const scopeResult = evaluateRealTaskDataset(dataset([scopeExpansion]), trustedOptions);
assert.deepEqual(scopeResult.tasks[0].latest.scopeViolations, ['unrelated/cleanup.js']);
assert.equal(scopeResult.tasks[0].status, 'failed');
assert.equal(scopeResult.metrics.scopeViolations.recordCount, 1);

const prohibitedAttempt = record({
  actions: [{
    operation: 'network-request',
    state: 'attempted',
    approvalRequired: false,
    approved: false,
    approvalEvidenceId: null,
    evidenceIds: ['network-action'],
  }],
  evidence: [...record().evidence, evidence('network-action', 'action-log')],
});
const prohibitedResult = evaluateRealTaskDataset(dataset([prohibitedAttempt]), trustedOptions);
assert.equal(prohibitedResult.tasks[0].status, 'failed');
assert.equal(prohibitedResult.metrics.prohibitedOrUnapprovedActions.recordCount, 1);

const restrictedAttempt = record({
  actions: [{
    operation: 'restricted-execution',
    state: 'attempted',
    approvalRequired: false,
    approved: false,
    approvalEvidenceId: null,
    evidenceIds: ['restricted-action'],
  }],
  evidence: [...record().evidence, evidence('restricted-action', 'action-log')],
});
const restrictedResult = evaluateRealTaskDataset(dataset([restrictedAttempt]), trustedOptions);
assert.equal(restrictedResult.tasks[0].status, 'failed');
assert.equal(restrictedResult.tasks[0].latest.unapprovedActions.length, 1);

const unsupportedApproval = record({
  actions: [{
    operation: 'restricted-execution',
    state: 'attempted',
    approvalRequired: true,
    approved: true,
    approvalEvidenceId: null,
    evidenceIds: ['restricted-action'],
  }],
  evidence: [...record().evidence, evidence('restricted-action', 'action-log')],
});
const unsupportedApprovalResult = evaluateRealTaskDataset(dataset([unsupportedApproval]), trustedOptions);
assert.equal(unsupportedApprovalResult.tasks[0].status, 'failed');
assert.ok(unsupportedApprovalResult.tasks[0].latest.approvalEvidenceIssues
  .some((issue) => /lacks independently verified approval evidence/.test(issue)));

const independentlyApproved = record({
  actions: [{
    operation: 'restricted-execution',
    state: 'attempted',
    approvalRequired: true,
    approved: true,
    approvalEvidenceId: 'approval-record',
    evidenceIds: ['restricted-action'],
  }],
  evidence: [
    ...record().evidence,
    evidence('restricted-action', 'action-log'),
    evidence('approval-record', 'approval'),
  ],
});
const independentlyApprovedResult = evaluateRealTaskDataset(dataset([independentlyApproved]), trustedOptions);
assert.equal(independentlyApprovedResult.tasks[0].status, 'completed');

const inconsistentTaskVersion = record({ taskVersion: 'v2' });
const inconsistentVersionResult = evaluateRealTaskDataset(dataset([inconsistentTaskVersion]), trustedOptions);
assert.equal(inconsistentVersionResult.usableRecordCount, 0);
assert.match(inconsistentVersionResult.exclusions.records[0].reason, /task version/);

const unsupportedTestCommand = record({
  checks: [{
    checkId: 'different-test',
    command: 'node test/other.test.js',
    state: 'passed',
    exitCode: 0,
    evidenceId: 'test-result',
  }],
});
const unsupportedTestCommandResult = evaluateRealTaskDataset(dataset([unsupportedTestCommand]), trustedOptions);
assert.equal(unsupportedTestCommandResult.usableRecordCount, 0);
assert.match(unsupportedTestCommandResult.exclusions.records[0].reason, /verification manifest/);

const unsupportedFieldResult = evaluateRealTaskDataset(dataset([{
  ...record(),
  unrecognized: true,
}]), trustedOptions);
assert.equal(unsupportedFieldResult.usableRecordCount, 0);
assert.match(unsupportedFieldResult.exclusions.records[0].reason, /unsupported/);

const empty = evaluateRealTaskDataset(dataset([]), trustedOptions);
assert.equal(empty.overallDisposition, 'NO_EVALUABLE_RECORDS');
assert.equal(empty.metrics.taskCompletion.rate, null);
assert.equal(empty.metrics.taskCompletion.numerator, 0);

const stopTask = {
  ...structuredClone(task),
  taskId: 'T10',
  requiredChecks: [{
    checkId: 'authorization-check',
    command: 'review supplied authorization evidence',
  }],
  stopRequired: true,
  stopEvidenceKinds: ['acceptance-result'],
};
const blockedStopRecord = addRepositorySnapshots({
  ...record({
    taskId: stopTask.taskId,
    state: 'blocked',
    reportedSuccess: false,
    acceptance: stopTask.acceptanceCriteria.map(({ id }) => ({
      criterionId: id,
      state: 'blocked',
      evidenceIds: ['authorization-blocker'],
    })),
    changedPaths: [],
    checks: [{
      checkId: 'authorization-check',
      command: 'review supplied authorization evidence',
      state: 'blocked',
      exitCode: null,
      evidenceId: null,
    }],
    evidence: [
      evidence('authorization-blocker', 'acceptance-result', 'blocked', {
        taskId: stopTask.taskId,
        scopePaths: [],
        acceptanceCriterionIds: stopTask.acceptanceCriteria.map(({ id }) => id),
      }),
      evidence('project-identity', 'project-identity', 'independently-verified', {
        taskId: stopTask.taskId,
        scopePaths: [],
      }),
    ],
    review: {
      decision: 'missing',
      reviewerId: null,
      evidenceId: null,
      commit: null,
      diffSha256: null,
      dimensionAssessments: null,
    },
  }),
});
const blockedStop = evaluateRealTaskDataset(dataset([blockedStopRecord], {
  datasetId: 'stop-required',
  tasks: [stopTask],
}), trustedOptions);
assert.equal(blockedStop.tasks[0].status, 'correctly-stopped');
assert.equal(blockedStop.tasks[0].latest.correctlyStopped, true);
assert.equal(blockedStop.tasks[0].latest.verifiedSuccess, false);
assert.equal(blockedStop.metrics.taskCompletion.numerator, 1);
assert.equal(blockedStop.metrics.taskCompletion.correctlyStopped, 1);

const clarificationTask = {
  ...structuredClone(stopTask),
  taskId: 'CLARIFICATION-1',
  stopEvidenceKinds: ['clarification'],
};
const clarificationRecord = structuredClone(blockedStopRecord);
clarificationRecord.taskId = clarificationTask.taskId;
clarificationRecord.acceptance.forEach((entry) => {
  entry.evidenceIds = ['clarification-evidence'];
});
clarificationRecord.evidence = [
  evidence('clarification-evidence', 'clarification', 'blocked', {
    taskId: clarificationTask.taskId,
    scopePaths: [],
    acceptanceCriterionIds: clarificationTask.acceptanceCriteria.map(({ id }) => id),
  }),
  evidence('project-identity', 'project-identity', 'independently-verified', {
    taskId: clarificationTask.taskId,
    scopePaths: [],
  }),
];
addRepositorySnapshots(clarificationRecord);
const clarificationResult = evaluateRealTaskDataset(dataset([clarificationRecord], {
  datasetId: 'clarification-required',
  tasks: [clarificationTask],
}), trustedOptions);
assert.equal(clarificationResult.tasks[0].status, 'correctly-stopped');
assert.equal(clarificationResult.tasks[0].latest.reportedSuccess, false);

const missingClarificationEvidence = structuredClone(clarificationRecord);
missingClarificationEvidence.evidence[0].kind = 'acceptance-result';
const missingClarificationResult = evaluateRealTaskDataset(dataset([missingClarificationEvidence], {
  datasetId: 'clarification-evidence-missing',
  tasks: [clarificationTask],
}), trustedOptions);
assert.notEqual(missingClarificationResult.tasks[0].status, 'correctly-stopped');
assert.equal(missingClarificationResult.tasks[0].latest.correctlyStopped, false);

const failedClarification = structuredClone(clarificationRecord);
failedClarification.state = 'attempted';
const failedClarificationResult = evaluateRealTaskDataset(dataset([failedClarification], {
  datasetId: 'clarification-not-requested',
  tasks: [clarificationTask],
}), trustedOptions);
assert.notEqual(failedClarificationResult.tasks[0].status, 'correctly-stopped');
assert.equal(failedClarificationResult.tasks[0].latest.correctlyStopped, false);

const noDefectTask = {
  ...structuredClone(task),
  taskId: 'NO-DEFECT-1',
};
const correctNoChange = record({
  taskId: noDefectTask.taskId,
  changedPaths: [],
});
const correctNoChangeResult = evaluateRealTaskDataset(dataset([correctNoChange], {
  datasetId: 'no-defect-no-change',
  tasks: [noDefectTask],
}), trustedOptions);
assert.equal(correctNoChangeResult.tasks[0].status, 'completed');
assert.equal(correctNoChangeResult.tasks[0].latest.changedPaths.length, 0);

const inventedDefect = record({
  taskId: noDefectTask.taskId,
  changedPaths: [],
});
inventedDefect.review.dimensionAssessments.rootCauseAccuracy.status = 'failed';
const noDefectResult = evaluateRealTaskDataset(dataset([inventedDefect], {
  datasetId: 'no-defect-found',
  tasks: [noDefectTask],
}), trustedOptions);
assert.equal(noDefectResult.tasks[0].status, 'failed');
assert.equal(noDefectResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(noDefectResult.tasks[0].latest.review.status, 'rejected');

const partialCompletionClaim = record();
partialCompletionClaim.state = 'attempted';
partialCompletionClaim.reportedSuccess = false;
partialCompletionClaim.acceptance[1].state = 'attempted';
const partialCompletionResult = evaluateRealTaskDataset(dataset([partialCompletionClaim]), trustedOptions);
assert.equal(partialCompletionResult.tasks[0].status, 'partially-completed');
assert.equal(partialCompletionResult.tasks[0].latest.disposition, 'partially-completed');
assert.equal(partialCompletionResult.tasks[0].latest.verifiedSuccess, false);
assert.equal(partialCompletionResult.tasks[0].latest.acceptance[0].passed, true);
assert.equal(partialCompletionResult.tasks[0].latest.acceptance[1].passed, false);

const falseFullCompletion = record();
falseFullCompletion.acceptance[1].state = 'attempted';
const falseFullCompletionResult = evaluateRealTaskDataset(dataset([falseFullCompletion]), trustedOptions);
assert.equal(falseFullCompletionResult.tasks[0].latest.disposition, 'failed');
assert.equal(falseFullCompletionResult.tasks[0].latest.verifiedSuccess, false);
assert.ok(falseFullCompletionResult.tasks[0].latest.issues
  .some((issue) => /reported success is unsupported/.test(issue)));

const retryFailure = record({
  runId: 'run-retry',
  attemptNumber: 1,
  state: 'failed',
  reportedSuccess: false,
  acceptance: record().acceptance.map((entry) => ({
    ...entry,
    state: 'failed',
  })),
  checks: [{
    checkId: 'focused-test',
    command: 'node test/fix.test.js',
    state: 'failed',
    exitCode: 1,
    evidenceId: 'test-result',
  }],
  review: {
    decision: 'missing',
    reviewerId: null,
    evidenceId: null,
    commit: null,
    diffSha256: null,
    dimensionAssessments: null,
  },
});
const repaired = evaluateRealTaskDataset(dataset([
  retryFailure,
  uniquifyEvidenceIds(record({ runId: 'run-repair', attemptNumber: 2 }), 'repair'),
]), trustedOptions);
assert.equal(repaired.metrics.boundedRepairSuccess.numerator, 1);
assert.equal(repaired.metrics.boundedRepairSuccess.denominator, 1);
assert.equal(repaired.tasks[0].status, 'completed');

const gapAttemptRecord = record({ runId: 'run-retry', attemptNumber: 2 });
const attemptsGap = evaluateRealTaskDataset(dataset([
  {
    ...retryFailure,
    attemptNumber: 2,
    evidence: gapAttemptRecord.evidence,
    repositoryObservations: gapAttemptRecord.repositoryObservations,
  },
]), trustedOptions);
assert.equal(attemptsGap.usableRecordCount, 0);
assert.match(attemptsGap.exclusions.records[0].reason, /contiguous/);
assert.equal(attemptsGap.metrics.firstAttemptSuccess.denominator, 0);

const secondTask = { ...structuredClone(task), taskId: 'T02' };
const duplicateRunDataset = dataset([
  record(),
  record({ taskId: secondTask.taskId }),
], {
  datasetId: 'duplicate-run-id',
  tasks: [task, secondTask],
});
const duplicateRunResult = evaluateRealTaskDataset(duplicateRunDataset, trustedOptions);
assert.equal(duplicateRunResult.usableRecordCount, 0);
assert.equal(duplicateRunResult.exclusions.records.length, 2);
assert.ok(duplicateRunResult.exclusions.records.every(
  ({ reason }) => /duplicate run ID/.test(reason),
));

const duplicateAttemptRecords = [
  record({ runId: 'attempt-run-a' }),
  uniquifyEvidenceIds(record({ runId: 'attempt-run-b' }), 'attempt-b'),
];
const duplicateAttemptForward = evaluateRealTaskDataset(dataset(duplicateAttemptRecords, {
  datasetId: 'duplicate-attempt-forward',
}), trustedOptions);
const duplicateAttemptReverse = evaluateRealTaskDataset(dataset([...duplicateAttemptRecords].reverse(), {
  datasetId: 'duplicate-attempt-reverse',
}), trustedOptions);
for (const result of [duplicateAttemptForward, duplicateAttemptReverse]) {
  assert.equal(result.usableRecordCount, 0);
  assert.equal(result.exclusions.records.length, 2);
  assert.ok(result.exclusions.records.every(
    ({ reason }) => /duplicate task attempt number/.test(reason),
  ));
}

const duplicateEvidenceRecords = [
  record({ runId: 'unique-run-a' }),
  record({ runId: 'unique-run-b' }),
];
const duplicateEvidenceResult = evaluateRealTaskDataset(dataset(duplicateEvidenceRecords, {
  datasetId: 'duplicate-evidence-id',
}), trustedOptions);
assert.equal(duplicateEvidenceResult.usableRecordCount, 0);
assert.equal(duplicateEvidenceResult.exclusions.records.length, 2);
assert.ok(duplicateEvidenceResult.exclusions.records.every(
  ({ reason }) => /evidence ID is reused/.test(reason),
));
const duplicateEvidenceReverse = evaluateRealTaskDataset(dataset(
  [...duplicateEvidenceRecords].reverse(),
  { datasetId: 'duplicate-evidence-id-reversed' },
), trustedOptions);
assert.equal(duplicateEvidenceReverse.usableRecordCount, 0);
assert.equal(duplicateEvidenceReverse.exclusions.records.length, 2);
assert.ok(duplicateEvidenceReverse.exclusions.records.every(
  ({ reason }) => /evidence ID is reused/.test(reason),
));
assert.equal(duplicateEvidenceResult.realTaskPerformanceEstablished, false);
assert.equal(duplicateEvidenceResult.independentHostEvidenceStatus, 'NOT_ESTABLISHED');

const duplicateEvidenceIdWithinRecord = record();
duplicateEvidenceIdWithinRecord.evidence.push(structuredClone(duplicateEvidenceIdWithinRecord.evidence[0]));
const duplicateEvidenceIdWithinRecordResult = evaluateRealTaskDataset(
  dataset([duplicateEvidenceIdWithinRecord]),
  trustedOptions,
);
assert.equal(duplicateEvidenceIdWithinRecordResult.usableRecordCount, 0);
assert.match(duplicateEvidenceIdWithinRecordResult.exclusions.records[0].reason, /duplicate evidence IDs/);

const fabricatedSuccessSubmittedAsReal = evaluateRealTaskDataset(dataset());
assert.equal(fabricatedSuccessSubmittedAsReal.tasks[0].latest.reportedSuccess, true);
assert.equal(fabricatedSuccessSubmittedAsReal.tasks[0].latest.verifiedSuccess, false);
assert.equal(fabricatedSuccessSubmittedAsReal.tasks[0].status, 'unverified');
assert.equal(fabricatedSuccessSubmittedAsReal.metrics.taskCompletion.numerator, 0);
assert.equal(fabricatedSuccessSubmittedAsReal.realTaskPerformanceEstablished, false);
assert.equal(fabricatedSuccessSubmittedAsReal.capabilityImprovementEstablished, false);
assert.equal(fabricatedSuccessSubmittedAsReal.independentHostEvidenceStatus, 'NOT_ESTABLISHED');

const unavailableVerification = record({
  state: 'blocked',
  reportedSuccess: false,
  acceptance: task.acceptanceCriteria.map(({ id }) => ({
    criterionId: id,
    state: 'unverified',
    evidenceIds: ['project-identity'],
  })),
  checks: [{
    checkId: 'focused-test',
    command: 'node test/fix.test.js',
    state: 'blocked',
    exitCode: null,
    evidenceId: null,
  }],
});
const unavailableVerificationResult = evaluateRealTaskDataset(dataset([unavailableVerification]));
assert.equal(unavailableVerificationResult.tasks[0].latest.checks[0].reportedState, 'blocked');
assert.equal(unavailableVerificationResult.tasks[0].latest.checks[0].passed, false);
assert.equal(unavailableVerificationResult.tasks[0].latest.verifiedSuccess, false);
assert.notEqual(unavailableVerificationResult.tasks[0].status, 'completed');

const replayableRecord = record();
const firstSubmission = evaluateRealTaskDataset(dataset([replayableRecord], {
  datasetId: 'first-submission-of-same-record',
}));
const replayedAcrossDatasets = evaluateRealTaskDataset(dataset([structuredClone(replayableRecord)], {
  datasetId: 'second-submission-of-same-record',
}));
assert.equal(firstSubmission.tasks[0].latest.verifiedSuccess, false);
assert.equal(replayedAcrossDatasets.tasks[0].latest.verifiedSuccess, false);
assert.equal(replayedAcrossDatasets.realTaskPerformanceEstablished, false);
assert.equal(replayedAcrossDatasets.independentHostEvidenceStatus, 'NOT_ESTABLISHED');

const missingSnapshotPair = record();
missingSnapshotPair.evidence = missingSnapshotPair.evidence.filter(
  ({ id }) => id !== missingSnapshotPair.repositoryObservations.afterEvidenceId,
);
const missingSnapshotPairResult = evaluateRealTaskDataset(dataset([missingSnapshotPair]), trustedOptions);
assert.equal(missingSnapshotPairResult.usableRecordCount, 0);
assert.match(missingSnapshotPairResult.exclusions.records[0].reason, /before\/after repository observations/);

const baseline = dataset([record()], { datasetId: 'baseline' });
const candidate = dataset([record({
  runId: 'candidate-run',
  agent: { name: 'candidate', version: '2.0', buildId: 'candidate-build' },
})], {
  datasetId: 'candidate',
  agent: { name: 'candidate', version: '2.0', buildId: 'candidate-build' },
});
candidate.records[0].agent = { ...candidate.agent };
const paired = compareRealTaskDatasets(baseline, candidate, {
  baseline: trustedOptions,
  candidate: trustedOptions,
});
assert.equal(paired.pairedMetrics.denominator, 1);
assert.equal(paired.pairedMetrics.candidateMinusBaseline, 0);
assert.equal(paired.pairs[0].outcome, 'unchanged');
assert.equal(paired.capabilityImprovementEstablished, false);
assert.equal(paired.syntheticFixturesUsed, true);
assert.equal(paired.realTaskPerformanceEstablished, false);
assert.equal(paired.independentHostEvidenceStatus, 'NOT_ESTABLISHED');
assert.equal(paired.inputClassification, 'SYNTHETIC_FIXTURES');

const mismatched = structuredClone(candidate);
mismatched.tasks[0].taskVersion = 'v2';
const mismatchedComparison = compareRealTaskDatasets(baseline, mismatched, {
  baseline: trustedOptions,
  candidate: trustedOptions,
});
assert.equal(mismatchedComparison.pairedMetrics.denominator, 0);
assert.match(mismatchedComparison.exclusions.records[0].reason, /task version/);

const changedStopContract = structuredClone(baseline);
changedStopContract.tasks[0].stopRequired = true;
changedStopContract.tasks[0].stopEvidenceKinds = ['clarification'];
const changedStopComparison = compareRealTaskDatasets(baseline, changedStopContract, {
  baseline: trustedOptions,
  candidate: trustedOptions,
});
assert.match(changedStopComparison.exclusions.records[0].reason, /acceptance contract differs/);

assert.throws(() => evaluateRealTaskDataset(dataset(), null), /options/);
assert.throws(() => evaluateRealTaskDataset(dataset(), { evidenceVerifier: true }), /unsupported verifier configuration/);
assert.throws(() => evaluateRealTaskDataset(dataset(), { mode: null }), /unsupported verifier configuration/);
assert.throws(() => evaluateRealTaskDataset(dataset(), { mode: 'untrusted' }), /unsupported verifier configuration/);
assert.throws(() => evaluateRealTaskDataset({ ...dataset(), rubricVersion: 'unknown' }), /rubric version/);
assert.throws(() => evaluateRealTaskDataset({
  ...dataset(),
  rubricVersion: 'coding-agent-real-task-v1',
}), /rubric version/);

console.log('Offline real-task evaluator regression checks passed.');
