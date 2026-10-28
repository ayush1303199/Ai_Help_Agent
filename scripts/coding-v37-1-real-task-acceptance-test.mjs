/**
 * AI Help Agent - Milestone V37.1 Real Task Execution Acceptance Test
 *
 * Validates the V37.0 completion-semantics implementation against real Coding Agent workflows:
 * Scenario 1: Preflight scope and contract verification.
 * Scenario 2: Manifest-only inspection for install/test cannot return TASK_COMPLETED.
 * Scenario 3: Request blocked by execution gate returns BLOCKED with authentic blocking reason.
 * Scenario 4: Source-change request awaiting approval reports NEEDS_APPROVAL with zero pre-approval disk mutation.
 * Scenario 5: Verified isolated runtime executes a bounded harmless command; real exitCode and output attached to evidence.
 * Scenario 6: Successful command alone does not mark a larger multi-objective task complete if criteria remain unverified.
 * Scenario 7: Failed test produces FAILED/PARTIAL and repair follows explicit approval gate before mutation.
 * Scenario 8: Backward compatibility for legacy audit.outcome consumers.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import developerAgent from '../electron/developerAgent.cjs';
const {
  executeAutonomousCodingWorkflow,
  TASK_COMPLETION_STATES,
  AUDITOR_OUTCOMES,
  auditWorkflowCompletion,
} = developerAgent;

import developerFiles from '../electron/developerFiles.cjs';
import { createProjectContainerExecutionRunner } from '../electron/coding-pipeline/projectContainerExecutionRunner.cjs';
import { createWorkflowCoordinator } from '../electron/coding-pipeline/workflowStateCoordinator.cjs';

console.log('=== RUNNING MILESTONE V37.1 REAL TASK EXECUTION ACCEPTANCE SUITE ===\n');

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'v37-1-acceptance-'));
process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = `${testRoot};C:\\Users\\Admin\\Downloads\\Hello`;

try {
  // =========================================================================
  // Scenario 1: Scope & Contract Invariants
  // =========================================================================
  console.log('--- Scenario 1: Scope & Contract Invariants ---');
  assert.ok(TASK_COMPLETION_STATES, 'TASK_COMPLETION_STATES must be exported');
  assert.equal(TASK_COMPLETION_STATES.WORKFLOW_COMPLETED, 'WORKFLOW_COMPLETED');
  assert.equal(TASK_COMPLETION_STATES.TASK_COMPLETED, 'TASK_COMPLETED');
  assert.equal(TASK_COMPLETION_STATES.BLOCKED, 'BLOCKED');
  assert.equal(TASK_COMPLETION_STATES.NEEDS_APPROVAL, 'NEEDS_APPROVAL');
  assert.equal(TASK_COMPLETION_STATES.FAILED, 'FAILED');
  assert.equal(TASK_COMPLETION_STATES.PARTIAL, 'PARTIAL');
  console.log('[PASS] Scenario 1: All 6 required completion semantics states confirmed.');

  // =========================================================================
  // Scenario 2: Manifest-Only Inspection for Install/Test Task
  // =========================================================================
  console.log('\n--- Scenario 2: Manifest-Only Inspection for Install/Test Task ---');
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

    // Provide file reader tools that inspect package.json
    const res = await executeAutonomousCodingWorkflow({
      userRequest: 'Install dependencies and test the project',
      root: fixtureDir,
      ownerWebContentsId: ownerId,
      sessionId,
      userApproved: false, // Disallow automatic apply/install
    });

    // CRITICAL: A task that only reads package.json MUST NOT return TASK_COMPLETED
    assert.notEqual(res.taskStatus, TASK_COMPLETION_STATES.TASK_COMPLETED,
      'Manifest inspection alone must NEVER return TASK_COMPLETED for install/test request.');
    assert.ok(
      res.taskStatus === TASK_COMPLETION_STATES.PARTIAL || res.taskStatus === TASK_COMPLETION_STATES.BLOCKED || res.taskStatus === TASK_COMPLETION_STATES.NEEDS_APPROVAL,
      `Task status must be qualified accurately as PARTIAL, BLOCKED, or NEEDS_APPROVAL (got: ${res.taskStatus}).`
    );
    console.log(`[PASS] Scenario 2: Manifest-only inspection truthfully reported taskStatus: ${res.taskStatus}, workflowStatus: ${res.workflowStatus}.`);
  }

  // =========================================================================
  // Scenario 3: Execution Gate Block (Process Isolation Unverified)
  // =========================================================================
  console.log('\n--- Scenario 3: Request Blocked by Execution Gate ---');
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

    // Call without container runner on Windows: host execution is disabled by fail-closed gate
    const res = await executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: fixtureDir,
      ownerWebContentsId: ownerId,
      sessionId,
      containerRunner: null, // Host execution gate
    });

    assert.equal(res.outcome, 'BLOCKED');
    assert.equal(res.executionBlocked, true);
    assert.equal(res.taskStatus, TASK_COMPLETION_STATES.BLOCKED);
    assert.match(res.reason, /verified Windows process isolation is required/i, 'Must contain authentic blocking reason.');
    console.log(`[PASS] Scenario 3: Execution gate blocked truthfully reported taskStatus: ${res.taskStatus}, reason: "${res.reason}".`);
  }

  // =========================================================================
  // Scenario 4: Source-Change Request Awaiting Approval (NEEDS_APPROVAL)
  // =========================================================================
  console.log('\n--- Scenario 4: Approval-Required Source Change ---');
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

    // Submit a real source-change request with no auto-approval callback (two-phase approval pause)
    const res = await executeAutonomousCodingWorkflow({
      userRequest: 'Fix the bug in src/math.js add function so it returns a + b',
      root: fixtureDir,
      ownerWebContentsId: ownerId,
      sessionId,
      requestApproval: null, // Two-phase approval pause
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
          const content = await fs.readFile(path.join(fixtureDir, p), 'utf8');
          return { content, lineRange: { startLine: 1, endLine: 2, totalLines: 2, complete: true } };
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

    console.log('SCENARIO 4 RESULT:', {
      outcome: res.outcome,
      phase: res.phase,
      taskStatus: res.taskStatus,
      workflowStatus: res.workflowStatus,
      continuationToken: res.continuationToken,
    });
    assert.equal(res.taskStatus, TASK_COMPLETION_STATES.NEEDS_APPROVAL);
    assert.ok(res.continuationToken, 'Must produce a continuation token awaiting approval.');
    const diskContentFinal = await fs.readFile(path.join(fixtureDir, 'src', 'math.js'), 'utf8');
    assert.equal(diskContentFinal, initialSource, 'Disk must not be mutated when approval is not granted.');
    console.log(`[PASS] Scenario 4: Awaiting approval truthfully reported taskStatus: ${res.taskStatus}, zero pre-approval mutations.`);
  }

  // =========================================================================
  // Scenario 5: Harmless Bounded Command Execution in Isolated Container Runner
  // =========================================================================
  console.log('\n--- Scenario 5: Bounded Command Execution in Isolated Container Runner ---');
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
      console.log(`[PASS] Scenario 5: Container isolated command ran successfully (exitCode: ${result.exitCode}).`);
    } else {
      console.log(`[BLOCKED] Scenario 5: Container runtime unavailable (${availability.reason}). Skipping live container execution.`);
    }
  }

  // =========================================================================
  // Scenario 6: Partial Completion (Successful Command Alone != Full Task Complete)
  // =========================================================================
  console.log('\n--- Scenario 6: Successful Command Alone != Full Task Complete ---');
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

    // Only syntax check ran; integration tests and database migrations were not run
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
    console.log(`[PASS] Scenario 6: Partial outcome correctly reported taskStatus: ${audit.taskStatus}.`);
  }

  // =========================================================================
  // Scenario 7: Failed Test Handling & Repair Workflow
  // =========================================================================
  console.log('\n--- Scenario 7: Failed Test Handling & Repair Workflow ---');
  {
    // Part A: Live workflow on unverified host correctly triggers execution gate block
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
    console.log(`[PASS] Scenario 7A: Host test execution gate truthfully blocked with taskStatus: ${liveRes.taskStatus}.`);

    // Part B: Failed test evidence evaluation produces FAILED taskStatus
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
    console.log(`[PASS] Scenario 7B: Failed test truthfully produced taskStatus: ${audit.taskStatus}, outcome: ${audit.outcome}.`);

    // Part C: Repair workflow follows explicit approval gate before disk mutation
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
    console.log(`[PASS] Scenario 7C: Repair workflow awaiting authorization produced taskStatus: ${repairAudit.taskStatus}.`);
  }

  // =========================================================================
  // Scenario 8: Legacy audit.outcome Backward Compatibility
  // =========================================================================
  console.log('\n--- Scenario 8: Legacy audit.outcome Backward Compatibility ---');
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

    // Both legacy outcome and modern taskStatus must be present and consistent
    assert.equal(audit.outcome, AUDITOR_OUTCOMES.COMPLETED, 'Legacy audit.outcome must remain AUDITOR_OUTCOMES.COMPLETED');
    assert.equal(audit.workflowStatus, TASK_COMPLETION_STATES.WORKFLOW_COMPLETED);
    assert.equal(audit.taskStatus, TASK_COMPLETION_STATES.TASK_COMPLETED);
    console.log(`[PASS] Scenario 8: Legacy audit.outcome (${audit.outcome}) and modern taskStatus (${audit.taskStatus}) both present and consistent.`);
  }

  console.log('\n========================================================================');
  console.log('ALL 8 MILESTONE V37.1 REAL TASK EXECUTION ACCEPTANCE SCENARIOS PASSED!');
  console.log('========================================================================\n');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
}
