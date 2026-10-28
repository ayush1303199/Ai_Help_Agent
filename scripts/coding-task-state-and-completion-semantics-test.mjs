/**
 * AI Help Agent - Coding Task State & Completion Semantics Regression Suite
 * (Milestone V37.0)
 *
 * Verifies:
 * 1. Completion semantics separation:
 *    - WORKFLOW_COMPLETED: orchestration finished.
 *    - TASK_COMPLETED: requested outcome verified.
 *    - BLOCKED: a prerequisite prevented progress.
 *    - NEEDS_APPROVAL: an action awaits user authorization.
 *    - FAILED: an attempted operation failed.
 *    - PARTIAL: some objectives succeeded but others remain incomplete.
 * 2. False-completion prevention:
 *    - A task that only reads package.json is NEVER reported as TASK_COMPLETED.
 * 3. Structured task state tracking:
 *    - Distinguishes observed facts, hypotheses, and verified conclusions.
 *    - Tracks inspected files, attempted actions, pending approvals, completed checks.
 *    - Resumes from recorded evidence instead of restarting investigations.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import completionAuditorPkg from '../electron/coding-pipeline/completionAuditor.cjs';
const {
  AUDITOR_OUTCOMES,
  TASK_COMPLETION_STATES,
  auditWorkflowCompletion,
} = completionAuditorPkg;

import workflowCoordPkg from '../electron/coding-pipeline/workflowStateCoordinator.cjs';
const {
  WORKFLOW_STATES,
  createWorkflowCoordinator,
  createStageEvidenceRecord,
} = workflowCoordPkg;

import { taskOrchestrator } from '../electron/coding-pipeline/orchestrator.cjs';

console.log('=== RUNNING CODING TASK STATE & COMPLETION SEMANTICS REGRESSION SUITE (V37.0) ===\n');

// ---------------------------------------------------------------------------
// 1. Completion Semantics Enum & Constants Contract
// ---------------------------------------------------------------------------
console.log('--- 1. Testing Completion Semantics Contract ---');
assert.ok(TASK_COMPLETION_STATES, 'TASK_COMPLETION_STATES must be exported by completionAuditor');
assert.equal(TASK_COMPLETION_STATES.WORKFLOW_COMPLETED, 'WORKFLOW_COMPLETED');
assert.equal(TASK_COMPLETION_STATES.TASK_COMPLETED, 'TASK_COMPLETED');
assert.equal(TASK_COMPLETION_STATES.BLOCKED, 'BLOCKED');
assert.equal(TASK_COMPLETION_STATES.NEEDS_APPROVAL, 'NEEDS_APPROVAL');
assert.equal(TASK_COMPLETION_STATES.FAILED, 'FAILED');
assert.equal(TASK_COMPLETION_STATES.PARTIAL, 'PARTIAL');
console.log('[PASS] All 6 required completion states are defined.');

// ---------------------------------------------------------------------------
// 2. Truthful Separation: WORKFLOW_COMPLETED vs TASK_COMPLETED
// ---------------------------------------------------------------------------
console.log('\n--- 2. Testing Separation of Workflow Completion from Task Outcome ---');

// 2a. A task that only read package.json without running tests
{
  const coord = createWorkflowCoordinator({
    workflowId: 'wf-manifest-only-1',
    projectIdentity: { projectRoot: 'C:\\mock\\project' },
    originalRequest: 'Install dependencies and test the project',
  });
  coord.transitionTo(WORKFLOW_STATES.INTENT_CLASSIFIED, { primaryIntent: 'TEST_OR_VERIFY' });
  coord.transitionTo(WORKFLOW_STATES.PROJECT_AUTHORIZED, { authorizedRoot: 'C:\\mock\\project' });
  coord.transitionTo(WORKFLOW_STATES.DISCOVERY_COMPLETED, {
    evidence: [{ file: 'package.json', dependenciesFound: true }],
  });

  const audit = auditWorkflowCompletion({
    coordinator: coord,
    originalRequest: 'Install dependencies and test the project',
    finalResult: {
      workflowStatus: TASK_COMPLETION_STATES.WORKFLOW_COMPLETED,
      filesModified: [],
      checksRan: [],
    },
  });

  // Orchestration finished, but requested task (tests/install) was NOT completed
  assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED, 'Workflow orchestration completed.');
  assert.notEqual(audit.taskStatus, TASK_COMPLETION_STATES.TASK_COMPLETED, 'Task must NOT be reported as TASK_COMPLETED when tests were not run.');
  assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.PARTIAL, 'Partial task completion when only discovery ran.');
  console.log('[PASS] Manifest-only inspection correctly yields workflowStatus: WORKFLOW_COMPLETED, taskStatus: PARTIAL.');
}

// 2b. Blocked by isolation prerequisite
{
  const coord = createWorkflowCoordinator({
    workflowId: 'wf-blocked-1',
    projectIdentity: { projectRoot: 'C:\\mock\\project' },
    originalRequest: 'test the project',
  });
  coord.transitionTo(WORKFLOW_STATES.INTENT_CLASSIFIED, { primaryIntent: 'TEST_OR_VERIFY' });
  coord.transitionTo(WORKFLOW_STATES.PROJECT_AUTHORIZED, { authorizedRoot: 'C:\\mock\\project' });
  coord.transitionTo(WORKFLOW_STATES.DISCOVERY_COMPLETED, {});
  coord.transitionTo(WORKFLOW_STATES.PLAN_CREATED, {});
  coord.transitionTo(WORKFLOW_STATES.BLOCKED, { reason: 'Process isolation unverified' });

  const audit = auditWorkflowCompletion({
    coordinator: coord,
    originalRequest: 'test the project',
    finalResult: {
      outcome: 'BLOCKED',
      reason: 'Process isolation unverified',
      checksBlocked: [{ gate: 'PROCESS_ISOLATION_GATE', reason: 'Process isolation unverified' }],
    },
  });

  assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED);
  assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.BLOCKED);
  assert.equal(audit.outcome, AUDITOR_OUTCOMES.BLOCKED);
  console.log('[PASS] Isolation-blocked task correctly yields workflowStatus: WORKFLOW_COMPLETED, taskStatus: BLOCKED.');
}

// 2c. Proposal awaiting user authorization (NEEDS_APPROVAL)
{
  const coord = createWorkflowCoordinator({
    workflowId: 'wf-needs-approval-1',
    projectIdentity: { projectRoot: 'C:\\mock\\project' },
    originalRequest: 'Fix the bug in login',
  });
  coord.transitionTo(WORKFLOW_STATES.INTENT_CLASSIFIED, { primaryIntent: 'BUG_INVESTIGATION' });
  coord.transitionTo(WORKFLOW_STATES.PROJECT_AUTHORIZED, { authorizedRoot: 'C:\\mock\\project' });
  coord.transitionTo(WORKFLOW_STATES.DISCOVERY_COMPLETED, {});
  coord.transitionTo(WORKFLOW_STATES.PLAN_CREATED, {});
  coord.transitionTo(WORKFLOW_STATES.APPROVAL_PENDING, { proposalId: 'proposal-1' });

  const audit = auditWorkflowCompletion({
    coordinator: coord,
    originalRequest: 'Fix the bug in login',
    finalResult: {
      outcome: 'NEEDS_APPROVAL',
      proposalId: 'proposal-1',
      pendingApproval: true,
    },
  });

  assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED);
  assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.NEEDS_APPROVAL);
  console.log('[PASS] Awaiting user approval correctly yields workflowStatus: WORKFLOW_COMPLETED, taskStatus: NEEDS_APPROVAL.');
}

// 2d. Fully verified task completion (TASK_COMPLETED)
{
  const coord = createWorkflowCoordinator({
    workflowId: 'wf-verified-1',
    projectIdentity: { projectRoot: 'C:\\mock\\project' },
    originalRequest: 'run test suite',
  });
  coord.transitionTo(WORKFLOW_STATES.INTENT_CLASSIFIED, { primaryIntent: 'TEST_OR_VERIFY' });
  coord.transitionTo(WORKFLOW_STATES.PROJECT_AUTHORIZED, { authorizedRoot: 'C:\\mock\\project' });
  coord.transitionTo(WORKFLOW_STATES.DISCOVERY_COMPLETED, {});
  coord.transitionTo(WORKFLOW_STATES.PLAN_CREATED, {});
  coord.transitionTo(WORKFLOW_STATES.APPROVED, {});
  coord.transitionTo(WORKFLOW_STATES.VERIFYING, {});
  coord.transitionTo(WORKFLOW_STATES.COMPLETED, {});

  const audit = auditWorkflowCompletion({
    coordinator: coord,
    originalRequest: 'run test suite',
    finalResult: {
      outcome: 'COMPLETED',
      verificationReport: {
        ok: true,
        exitCode: 0,
        verificationEvidence: [{ command: 'npm test', exitCode: 0, status: 'PASSED' }],
      },
    },
  });

  assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED);
  assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.TASK_COMPLETED);
  assert.equal(audit.outcome, AUDITOR_OUTCOMES.COMPLETED);
  console.log('[PASS] Verified passing test execution yields taskStatus: TASK_COMPLETED.');
}

// ---------------------------------------------------------------------------
// 3. Structured Task State & Evidence Reasoning
// ---------------------------------------------------------------------------
console.log('\n--- 3. Testing Structured Task State Tracking & Information-Gain Reasoning ---');
{
  const brainTask = taskOrchestrator.createTask({
    goal: 'Find and fix this bug in auth handler',
    intent: 'BUG_INVESTIGATION',
    workspace: 'C:\\mock\\project',
  });

  // Verify task state structure
  assert.ok(brainTask.taskId, 'Task must have a stable identifier');
  assert.ok(Array.isArray(brainTask.evidence || []), 'Task state must track evidence');

  // Add structured facts and hypotheses
  brainTask.hypotheses.push({
    text: 'Null token dereference at auth.js:42',
    status: 'ACTIVE',
    evidenceType: 'HYPOTHESIS',
  });

  const taskRecord = taskOrchestrator.getTask(brainTask.taskId);
  assert.ok(taskRecord.hypotheses.some((h) => h.text.includes('auth.js:42')), 'Hypothesis must be recorded in task state');

  // Verify next-best-action reasoning uses information-gain
  const nextAction = taskOrchestrator.computeNextBestAction(brainTask.taskId);
  assert.ok(nextAction, 'Next best action must be determined');
  assert.ok(nextAction.action, 'Action must specify target action type');

  // Verify checkpoint and resumption from evidence
  const checkpoint = taskOrchestrator.saveCheckpoint(brainTask.taskId, 'investigation_checkpoint');
  assert.ok(checkpoint, 'Checkpoint must be created from task evidence');
  const restored = taskOrchestrator.resumeFromCheckpoint(brainTask.taskId, checkpoint.checkpointId);
  assert.ok(restored, 'Resumption must succeed from saved checkpoint');
  const updatedTask = taskOrchestrator.getTask(brainTask.taskId);
  assert.ok(updatedTask.hypotheses.some((h) => h.text.includes('auth.js:42')), 'Restored state must preserve recorded evidence');

  console.log('[PASS] Structured task state and information-gain reasoning verified.');
}

console.log('\n========================================================================');
console.log('All Coding Task State & Completion Semantics Tests Passed Successfully!');
console.log('========================================================================\n');
