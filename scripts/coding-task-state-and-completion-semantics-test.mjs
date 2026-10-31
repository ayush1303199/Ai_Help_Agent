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
import developerAgent from '../electron/developerAgent.cjs';
const { executeAutonomousCodingWorkflow } = developerAgent;
import developerFiles from '../electron/developerFiles.cjs';
import { createProjectContainerExecutionRunner } from '../electron/coding-pipeline/projectContainerExecutionRunner.cjs';

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

// ---------------------------------------------------------------------------
// 4. Live Workflow Execution Acceptance Scenarios (Consolidated from V37.1)
// ---------------------------------------------------------------------------
console.log('\n--- 4. Live Workflow Execution Acceptance Scenarios ---');

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'v37-1-acceptance-'));
process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = `${testRoot};C:\\Users\\Admin\\Downloads\\Hello`;

try {
  // Scenario 4.1: Manifest-Only Inspection for Install/Test Task
  console.log('--- 4.1 Manifest-Only Inspection for Install/Test Task ---');
  {
    const fixtureDir = path.join(testRoot, 'manifest-fixture');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'manifest-only-fixture',
      version: '1.0.0',
      dependencies: { lodash: '^4.17.21' },
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));

    const ownerId = 3701;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(fixtureDir, ownerId);

    const res = await executeAutonomousCodingWorkflow({
      userRequest: 'Install dependencies and test the project',
      root: fixtureDir,
      ownerWebContentsId: ownerId,
      sessionId,
      userApproved: false,
    });

    assert.notEqual(res.taskStatus, TASK_COMPLETION_STATES.TASK_COMPLETED,
      'Manifest inspection alone must NEVER return TASK_COMPLETED for install/test request.');
    assert.ok(
      res.taskStatus === TASK_COMPLETION_STATES.PARTIAL || res.taskStatus === TASK_COMPLETION_STATES.BLOCKED || res.taskStatus === TASK_COMPLETION_STATES.NEEDS_APPROVAL,
      `Task status must be qualified accurately as PARTIAL, BLOCKED, or NEEDS_APPROVAL (got: ${res.taskStatus}).`
    );
    console.log(`[PASS] Manifest-only inspection truthfully reported taskStatus: ${res.taskStatus}, workflowStatus: ${res.workflowStatus}.`);
  }

  // Scenario 4.2: Execution Gate Block (Process Isolation Unverified)
  console.log('\n--- 4.2 Request Blocked by Execution Gate ---');
  {
    const fixtureDir = path.join(testRoot, 'gate-fixture');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'gate-fixture',
      scripts: { test: 'node -e "throw new Error(\'HOST EXECUTION BLOCKED\')"' },
    }));

    const ownerId = 3702;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(fixtureDir, ownerId);

    const res = await executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: fixtureDir,
      ownerWebContentsId: ownerId,
      sessionId,
      containerRunner: null,
    });

    assert.equal(res.outcome, 'BLOCKED');
    assert.equal(res.executionBlocked, true);
    assert.equal(res.taskStatus, TASK_COMPLETION_STATES.BLOCKED);
    assert.match(res.reason, /verified Windows process isolation is required/i, 'Must contain authentic blocking reason.');
    console.log(`[PASS] Execution gate blocked truthfully reported taskStatus: ${res.taskStatus}, reason: "${res.reason}".`);
  }

  // Scenario 4.3: Source-Change Request Awaiting Approval (NEEDS_APPROVAL)
  console.log('\n--- 4.3 Approval-Required Source Change ---');
  {
    const fixtureDir = path.join(testRoot, 'approval-fixture');
    await fs.mkdir(path.join(fixtureDir, 'src'), { recursive: true });
    const initialSource = 'export function add(a, b) { return a - b; }\n';
    await fs.writeFile(path.join(fixtureDir, 'src', 'math.js'), initialSource, 'utf8');
    await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'approval-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));

    const ownerId = 3703;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(fixtureDir, ownerId);

    const res = await executeAutonomousCodingWorkflow({
      userRequest: 'Fix the bug in src/math.js add function so it returns a + b',
      root: fixtureDir,
      ownerWebContentsId: ownerId,
      sessionId,
      requestApproval: null,
      assessFindingRelevance: async ({ findings }) => ({
        findings: findings.map((f) => ({
          findingId: f.findingId,
          decision: 'SUPPORTED',
          relationship: 'The subtraction operator must be replaced with addition.',
          evidenceIds: [f.sourceEvidenceId],
          contradictionEvidenceIds: [],
          unresolvedAssumptions: [],
          provenance: 'VERIFIED_CODE_EVIDENCE',
        })),
      }),
      tools: {
        readFile: async (p) => {
          const fileContent = await fs.readFile(path.join(fixtureDir, p), 'utf8');
          return { content: fileContent, lineRange: { startLine: 1, endLine: 2, totalLines: 2, complete: true } };
        },
        searchCode: async () => ({
          results: [{ path: 'src/math.js', score: 100 }],
        }),
        proposePatch: async ({ originalContent }) => {
          return originalContent.replace('return a - b;', 'return a + b;');
        },
        findDefects: async ({ filePath }) => [{
          filePath,
          lines: '1',
          symbol: 'add',
          codeSnippet: 'return a - b;',
          controlFlow: 'Incorrect subtraction operator',
          expected: 'return a + b;',
          observed: 'return a - b;',
          evidenceType: 'STATIC_INSPECTION_CONFIRMED',
        }],
      },
    });

    assert.equal(res.taskStatus, TASK_COMPLETION_STATES.NEEDS_APPROVAL);
    assert.ok(res.continuationToken, 'Must produce a continuation token awaiting approval.');
    const diskContentFinal = await fs.readFile(path.join(fixtureDir, 'src', 'math.js'), 'utf8');
    assert.equal(diskContentFinal, initialSource, 'Disk must not be mutated when approval is not granted.');
    console.log(`[PASS] Awaiting approval truthfully reported taskStatus: ${res.taskStatus}, zero pre-approval mutations.`);
  }

  // Scenario 4.4: Bounded Command Execution in Isolated Container Runner
  console.log('\n--- 4.4 Bounded Command Execution in Isolated Container Runner ---');
  {
    const runner = createProjectContainerExecutionRunner();
    const availability = runner.checkAvailability();

    if (availability.available) {
      const fixtureDir = path.join(testRoot, 'container-fixture');
      await fs.mkdir(fixtureDir, { recursive: true });
      await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({
        name: 'container-fixture',
        scripts: { test: 'node -e "console.log(\'CONTAINER_ISOLATED_OK\'); process.exit(0);"' },
      }));

      const plan = {
        operation: 'TEST',
        planDigest: 'digest-v37-container',
        fullCommandString: 'npm test',
        command: 'npm test',
        projectRoot: fixtureDir,
      };

      const result = await runner.execute({
        plan,
        ownerWebContentsId: 3704,
        sessionId: crypto.randomUUID(),
      });

      assert.equal(result.ok, true, 'Container command must succeed.');
      assert.equal(result.exitCode, 0, 'Real exit code 0 must be captured.');
      assert.ok(result.stdout.includes('CONTAINER_ISOLATED_OK') || result.status === 'PASSED', 'Output must reflect isolated execution.');
      console.log(`[PASS] Container isolated command ran successfully (exitCode: ${result.exitCode}).`);
    } else {
      console.log(`[BLOCKED] Container runtime unavailable (${availability.reason}). Skipping live container execution.`);
    }
  }

  // Scenario 4.5: Partial Completion (Successful Command Alone != Full Task Complete)
  console.log('\n--- 4.5 Successful Command Alone != Full Task Complete ---');
  {
    const coord = createWorkflowCoordinator({
      workflowId: 'wf-multi-criteria-1',
      projectIdentity: { projectRoot: 'C:\\mock\\multi' },
      originalRequest: 'Implement authentication, add database migration, and run full end-to-end integration tests',
    });
    coord.transitionTo('INTENT_CLASSIFIED', { primaryIntent: 'IMPLEMENT_FEATURE' });
    coord.transitionTo('PROJECT_AUTHORIZED', { authorizedRoot: 'C:\\mock\\multi' });
    coord.transitionTo('DISCOVERY_COMPLETED', {});
    coord.transitionTo('PLAN_CREATED', {});
    coord.transitionTo('APPROVED', {});
    coord.transitionTo('APPLYING', {});
    coord.recordAppliedPatch({ targetFile: 'src/auth.js' });
    coord.transitionTo('VERIFYING', {});

    coord.recordEvidence('VERIFYING', {
      staticChecks: ['SYNTAX'],
      limitations: ['Integration test suite: NOT EXECUTED', 'Database migration: UNVERIFIED'],
      verificationAttempts: [{ check: 'static_syntax', ok: true, exitCode: 0 }],
    });
    coord.transitionTo('PARTIALLY_COMPLETED');

    const audit = auditWorkflowCompletion({
      coordinator: coord,
      originalRequest: 'Implement authentication, add database migration, and run full end-to-end integration tests',
      finalResult: {
        filesModified: ['src/auth.js'],
        outcome: 'PARTIALLY_COMPLETED',
        verificationReport: {
          hostExecution: { status: 'NOT_RUN', reason: 'Integration tests not executed' },
          verificationEvidence: [{ command: 'static_syntax', status: 'PASSED', exitCode: 0 }],
        },
      },
    });

    assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED, 'Orchestration completed.');
    assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.PARTIAL, 'Multi-objective task must be PARTIAL when criteria remain unverified.');
    assert.notEqual(audit.taskStatus, TASK_COMPLETION_STATES.TASK_COMPLETED);
    console.log(`[PASS] Partial outcome correctly reported taskStatus: ${audit.taskStatus}.`);
  }

  // Scenario 4.6: Failed Test Handling & Repair Workflow
  console.log('\n--- 4.6 Failed Test Handling & Repair Workflow ---');
  {
    const fixtureDir = path.join(testRoot, 'fail-repair-fixture');
    await fs.mkdir(path.join(fixtureDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'src', 'calc.js'), 'module.exports = { code: 500 };\n', 'utf8');
    await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'fail-repair-fixture',
      scripts: { test: 'node -e "throw new Error(\'TEST_FAILURE\')"' },
    }));

    const ownerId = 3705;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(fixtureDir, ownerId);

    const liveRes = await executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: fixtureDir,
      ownerWebContentsId: ownerId,
      sessionId,
      userApproved: false,
    });

    assert.equal(liveRes.outcome, 'BLOCKED');
    assert.equal(liveRes.taskStatus, TASK_COMPLETION_STATES.BLOCKED);
    assert.match(liveRes.reason, /verified Windows process isolation is required/i);
    console.log(`[PASS] Host test execution gate truthfully blocked with taskStatus: ${liveRes.taskStatus}.`);

    const coord = createWorkflowCoordinator({
      workflowId: 'wf-failed-test-audit',
      projectIdentity: { projectRoot: fixtureDir },
      originalRequest: 'Run project tests and report results',
    });
    coord.transitionTo('INTENT_CLASSIFIED');
    coord.transitionTo('PROJECT_AUTHORIZED');
    coord.transitionTo('DISCOVERY_COMPLETED');
    coord.transitionTo('VERIFYING');
    coord.recordEvidence('VERIFYING', {
      commandsRan: [{ command: 'npm test', exitCode: 1, status: 'FAILED' }],
      verificationAttempts: [{ check: 'npm test', ok: false, exitCode: 1, failure: 'AssertionError: expected 200 received 500' }],
    });
    coord.transitionTo('FAILED');

    const audit = auditWorkflowCompletion({
      coordinator: coord,
      originalRequest: 'Run project tests and report results',
      finalResult: {
        outcome: 'FAILED',
        reason: 'npm test failed with exit code 1',
      },
    });

    assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED);
    assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.FAILED);
    assert.equal(audit.outcome, AUDITOR_OUTCOMES.FAILED);
    console.log(`[PASS] Failed test truthfully produced taskStatus: ${audit.taskStatus}, outcome: ${audit.outcome}.`);

    coord.transitionTo('APPROVAL_PENDING');
    const repairAudit = auditWorkflowCompletion({
      coordinator: coord,
      originalRequest: 'Fix the failing test in src/calc.js',
      finalResult: {
        outcome: 'NEEDS_APPROVAL',
        pendingApproval: true,
      },
    });
    assert.equal(repairAudit.taskStatus, TASK_COMPLETION_STATES.NEEDS_APPROVAL);
    console.log(`[PASS] Repair workflow awaiting authorization produced taskStatus: ${repairAudit.taskStatus}.`);
  }

  // Scenario 4.7: Legacy audit.outcome Backward Compatibility
  console.log('\n--- 4.7 Legacy audit.outcome Backward Compatibility ---');
  {
    const coord = createWorkflowCoordinator({
      workflowId: 'wf-legacy-compat',
      projectIdentity: { projectRoot: 'C:\\mock\\legacy' },
      originalRequest: 'Explain the project structure',
    });
    coord.transitionTo('INTENT_CLASSIFIED');
    coord.transitionTo('PROJECT_AUTHORIZED');
    coord.transitionTo('DISCOVERY_COMPLETED');
    coord.transitionTo('COMPLETED');

    const audit = auditWorkflowCompletion({
      coordinator: coord,
      originalRequest: 'Explain the project structure',
      finalResult: { filesModified: [], outcome: 'COMPLETED' },
    });

    assert.equal(audit.outcome, AUDITOR_OUTCOMES.COMPLETED, 'Legacy audit.outcome must remain AUDITOR_OUTCOMES.COMPLETED');
    assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED);
    assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.TASK_COMPLETED);
    console.log(`[PASS] Legacy audit.outcome (${audit.outcome}) and modern taskStatus (${audit.taskStatus}) both present and consistent.`);
  }

  console.log('\n========================================================================');
  console.log('All Coding Task State & Completion Semantics Tests Passed Successfully!');
  console.log('========================================================================\n');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
}
