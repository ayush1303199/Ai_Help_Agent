import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  issueHostFileObservation,
  verifyWorkItemEvidence,
} from '../electron/coding-pipeline/workItemVerificationContract.cjs';
import {
  advanceTaskPlan,
  invalidateCompletedWorkItems,
} from '../electron/coding-pipeline/investigationWorkflowContract.cjs';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'work-item-verifier-'));
const content = 'host-observed approved state\n';
const sha256 = createHash('sha256').update(content).digest('hex');
const context = {
  sessionId: 'session-verifier-test',
  projectRoot: tempRoot,
  proposalId: 'proposal-verifier-test',
  scope: '.',
  attemptId: 'attempt-1',
  completedEvidence: [
    'APPROVED_SCOPE_PROPOSAL',
    'EXPLICIT_APPROVAL',
    'VERIFICATION_PASS',
    'PRESERVATION_AUDIT',
  ],
};
const makePlan = (criteria = true) => ({
  schemaVersion: 2,
  goal: 'Check a user-authorized file result.',
  status: 'HANDED_OFF',
  workItems: [{
    id: 'WI-001',
    objective: 'The approved file has the specified content.',
    status: 'DELEGATED',
    dependsOn: [],
    requiredEvidence: [
      'APPROVED_SCOPE_PROPOSAL',
      'EXPLICIT_APPROVAL',
      'VERIFICATION_PASS',
      'PRESERVATION_AUDIT',
    ],
    ...(criteria ? {
      verificationCriteria: [{
        id: 'expected-file-state',
        type: 'FILE_SHA256',
        path: 'src/result.txt',
        sha256,
      }],
    } : {}),
  }],
});

try {
  await fs.mkdir(path.join(tempRoot, 'src'));
  await fs.writeFile(path.join(tempRoot, 'src', 'result.txt'), content);
  const plan = makePlan();
  const item = plan.workItems[0];
  const actual = await fs.readFile(path.join(tempRoot, 'src', 'result.txt'));
  const observation = issueHostFileObservation({
    plan,
    item,
    context,
    criterion: item.verificationCriteria[0],
    observed: {
      path: 'src/result.txt',
      sha256: createHash('sha256').update(actual).digest('hex'),
      exists: true,
    },
  });
  assert.ok(observation, 'The internal host observer should issue evidence for a read file state.');
  const satisfied = verifyWorkItemEvidence({
    plan,
    itemId: item.id,
    context,
    evidence: [observation],
    verificationPassed: true,
    dependenciesSatisfied: true,
  });
  assert.equal(satisfied.status, 'SATISFIED');
  assert.deepEqual(satisfied.criteriaChecked, ['expected-file-state']);

  advanceTaskPlan(plan, { workItemId: item.id, status: 'IN_PROGRESS' });
  advanceTaskPlan(plan, {
    workItemId: item.id,
    status: 'COMPLETED',
    evidence: satisfied,
  });
  assert.equal(item.status, 'COMPLETED');
  assert.equal(plan.status, 'COMPLETED');
  invalidateCompletedWorkItems(plan, 'Test rollback invalidation.');
  assert.equal(item.status, 'BLOCKED');
  assert.equal(item.evidence, undefined, 'Rollback must remove completion evidence.');
  assert.equal(item.verificationResult, undefined, 'Rollback must remove the verifier result.');

  assert.equal(verifyWorkItemEvidence({
    plan: makePlan(),
    itemId: 'WI-001',
    context,
    evidence: [{ ...observation }],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INVALID_EVIDENCE', 'A copied worker/model claim is not a host-issued observation.');

  assert.equal(verifyWorkItemEvidence({
    plan: makePlan(false),
    itemId: 'WI-001',
    context,
    evidence: [],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INCONCLUSIVE', 'General passing verification without item criteria is insufficient.');

  const twoItemPlan = {
    ...makePlan(),
    status: 'HANDED_OFF',
    workItems: [
      { ...makePlan().workItems[0] },
      {
        ...makePlan().workItems[0],
        id: 'WI-002',
        objective: 'A different sibling objective.',
        dependsOn: ['WI-001'],
        verificationCriteria: [{
          id: 'sibling-file-state',
          type: 'FILE_SHA256',
          path: 'src/result.txt',
          sha256,
        }],
      },
    ],
  };
  const firstItem = twoItemPlan.workItems[0];
  firstItem.status = 'COMPLETED';
  const firstItemEvidence = issueHostFileObservation({
    plan: twoItemPlan,
    item: firstItem,
    context,
    criterion: firstItem.verificationCriteria[0],
    observed: { path: 'src/result.txt', sha256, exists: true },
  });
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-002',
    context,
    evidence: [firstItemEvidence],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INVALID_EVIDENCE', 'Evidence for one item cannot satisfy a sibling item.');
  assert.equal(verifyWorkItemEvidence({
    plan: { ...twoItemPlan, goal: 'different plan' },
    itemId: 'WI-001',
    context,
    evidence: [firstItemEvidence],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INVALID_EVIDENCE', 'Evidence is bound to the exact plan.');
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-001',
    context: { ...context, projectRoot: `${tempRoot}-other` },
    evidence: [firstItemEvidence],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INVALID_EVIDENCE', 'Evidence is bound to the exact project.');
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-001',
    context: { ...context, proposalId: 'another-proposal' },
    evidence: [firstItemEvidence],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INVALID_EVIDENCE', 'Evidence is bound to the exact approved proposal.');
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-001',
    context: { ...context, scope: 'src' },
    evidence: [firstItemEvidence],
    verificationPassed: true,
  }).status, 'INVALID_EVIDENCE', 'Evidence is bound to the authorized scope.');
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-001',
    context: { ...context, attemptId: 'attempt-2' },
    evidence: [firstItemEvidence],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INVALID_EVIDENCE', 'Evidence from a previous attempt is stale for a newer attempt.');
  const originalNow = Date.now;
  try {
    const issuedAtNow = issueHostFileObservation({
      plan: twoItemPlan,
      item: twoItemPlan.workItems[0],
      context,
      criterion: twoItemPlan.workItems[0].verificationCriteria[0],
      observed: { path: 'src/result.txt', sha256, exists: true },
    });
    Date.now = () => originalNow() + 120_000;
    assert.equal(verifyWorkItemEvidence({
      plan: twoItemPlan,
      itemId: 'WI-001',
      context,
      evidence: [issuedAtNow],
      verificationPassed: true,
    }).status, 'INVALID_EVIDENCE', 'Evidence older than the freshness window must be rejected.');
  } finally {
    Date.now = originalNow;
  }
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-001',
    context,
    evidence: [],
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INCONCLUSIVE', 'Missing criterion evidence is inconclusive.');
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-001',
    context,
    evidence: [firstItemEvidence],
    verificationPassed: false,
    dependenciesSatisfied: true,
  }).status, 'NOT_SATISFIED', 'A failed verification cannot satisfy a criterion.');
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-001',
    context,
    evidence: [firstItemEvidence],
    verificationPassed: true,
    dependenciesSatisfied: true,
    rolledBack: true,
  }).status, 'INVALID_EVIDENCE', 'Rollback invalidates evidence about the reverted state.');
  firstItem.status = 'DELEGATED';
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'WI-002',
    context,
    evidence: [],
    verificationPassed: true,
    dependenciesSatisfied: false,
  }).status, 'NOT_SATISFIED', 'Unresolved dependencies prevent completion.');
  assert.equal(verifyWorkItemEvidence({
    plan: twoItemPlan,
    itemId: 'missing',
    context,
    evidence: null,
    verificationPassed: true,
    dependenciesSatisfied: true,
  }).status, 'INVALID_EVIDENCE', 'Malformed evidence fails safely.');
  const malformedCriteriaPlan = makePlan();
  malformedCriteriaPlan.workItems[0].verificationCriteria = [{ id: 'bad', type: 'WORKER_CLAIM' }];
  assert.equal(verifyWorkItemEvidence({
    plan: malformedCriteriaPlan,
    itemId: 'WI-001',
    context,
    evidence: [],
    verificationPassed: true,
  }).status, 'INVALID_EVIDENCE', 'Malformed criterion definitions fail closed.');

  const unresolvedPlan = makePlan();
  unresolvedPlan.workItems.push({
    id: 'WI-002',
    objective: 'Unresolved sibling objective.',
    status: 'DELEGATED',
    dependsOn: ['WI-001'],
    requiredEvidence: [],
  });
  const unresolvedEvidence = issueHostFileObservation({
    plan: unresolvedPlan,
    item: unresolvedPlan.workItems[0],
    context,
    criterion: unresolvedPlan.workItems[0].verificationCriteria[0],
    observed: { path: 'src/result.txt', sha256, exists: true },
  });
  const unresolvedResult = verifyWorkItemEvidence({
    plan: unresolvedPlan,
    itemId: 'WI-001',
    context,
    evidence: [unresolvedEvidence],
    verificationPassed: true,
    dependenciesSatisfied: true,
  });
  advanceTaskPlan(unresolvedPlan, { workItemId: 'WI-001', status: 'IN_PROGRESS' });
  advanceTaskPlan(unresolvedPlan, {
    workItemId: 'WI-001',
    status: 'COMPLETED',
    evidence: unresolvedResult,
  });
  assert.equal(unresolvedPlan.workItems[1].status, 'DELEGATED');
  assert.equal(unresolvedPlan.status, 'HANDED_OFF', 'An unresolved sibling prevents parent-plan completion.');

  const unapprovedPlan = makePlan();
  assert.throws(
    () => advanceTaskPlan(unapprovedPlan, {
      workItemId: 'WI-001',
      status: 'COMPLETED',
      evidence: satisfied,
    }),
    /Illegal work item transition/,
    'A valid verification result cannot bypass the in-progress lifecycle transition.',
  );
  const forgedPlan = makePlan();
  advanceTaskPlan(forgedPlan, { workItemId: 'WI-001', status: 'IN_PROGRESS' });
  assert.throws(
    () => advanceTaskPlan(forgedPlan, {
      workItemId: 'WI-001',
      status: 'COMPLETED',
      evidence: { status: 'SATISFIED', itemId: 'WI-001' },
    }),
    /trusted, item-bound host verification result/,
    'A forged success object cannot complete an item.',
  );
  console.log('Work-item host verification contract tests passed.');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
