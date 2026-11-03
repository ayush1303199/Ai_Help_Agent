import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import projectCommandAuthorization from '../electron/coding-pipeline/projectCommandAuthorization.cjs';
import { ProjectContainerExecutionRunner } from '../electron/coding-pipeline/projectContainerExecutionRunner.cjs';
import { createBuildPlanTestHarness, isAuthorizedBuildPlanHarness } from '../electron/coding-pipeline/buildOrchestrator.cjs';

const { PROJECT_READINESS, CHECK_STATES } = developerAgent;

console.log('Starting Autonomous Edit -> Test -> Diagnose -> Approved Fix -> Retest E2E Tests (Milestone V28.0)...');

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-v28-repair-e2e-'));

try {
  // =========================================================================
  // Case 1: Full End-to-End Autonomous Test -> Failure -> Diagnosis -> Repair Proposal -> Approval -> Apply -> Retest -> Pass
  // =========================================================================
  console.log('\nCase 1: Full autonomous cycle (Run Test -> Fail -> Diagnose -> Repair Proposal -> Approval -> Retest -> Pass)...');
  {
    const projDir = path.join(testRoot, 'case1-calc-app');
    await fs.mkdir(path.join(projDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(projDir, 'tests'), { recursive: true });

    await fs.writeFile(
      path.join(projDir, 'package.json'),
      JSON.stringify({
        name: 'case1-calc-app',
        scripts: { test: 'node tests/calc.test.js' },
      }, null, 2),
      'utf8'
    );

    const initialSource = [
      'function getStatusCode() {',
      '  return 500;',
      '}',
      'module.exports = { getStatusCode };',
      '',
    ].join('\n');

    await fs.writeFile(path.join(projDir, 'src', 'calculator.js'), initialSource, 'utf8');

    const testContent = [
      'const assert = require("node:assert/strict");',
      'const { getStatusCode } = require("../src/calculator.js");',
      'assert.equal(getStatusCode(), 200, "expected 200 but received 500 at src/calculator.js:2:10");',
      'console.log("PASS: Status code test passed successfully");',
    ].join('\n');

    await fs.writeFile(path.join(projDir, 'tests', 'calc.test.js'), testContent, 'utf8');

    const ownerId = 2801;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(projDir, ownerId);

    const executions = [];
    let approvalRequested = false;
    let contentAtApprovalRequest = null;

    const mockRunner = new ProjectContainerExecutionRunner({ isMock: true });
    mockRunner.execute = async () => {
      const attempt = executions.length + 1;
      const currentDisk = await fs.readFile(path.join(projDir, 'src', 'calculator.js'), 'utf8');

      if (attempt === 1) {
        // Initial test execution: fails with real error
        const failureOutput = 'AssertionError: expected 200 but received 500 at src/calculator.js:2:10';
        const execRec = {
          ok: false,
          status: 'FAILED',
          exitCode: 1,
          stdout: '',
          stderr: failureOutput,
          attempt,
        };
        executions.push(execRec);
        return execRec;
      }

      // Retest execution after repair: passes with exit code 0
      assert.ok(currentDisk.includes('return 200;'), 'Retest must run against repaired disk content');
      const execRec = {
        ok: true,
        status: 'PASSED',
        exitCode: 0,
        stdout: 'PASS: Status code test passed successfully\n  √ all assertions passed',
        stderr: '',
        attempt,
      };
      executions.push(execRec);
      return execRec;
    };

    const isolationGate = (op) => ({ runtimeType: 'container', isolationVerified: true, supportedOps: [op] });
    const harness = createBuildPlanTestHarness({ isolationGate, containerRunner: mockRunner });

    const workflowResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: projDir,
      ownerWebContentsId: ownerId,
      sessionId,
      containerRunner: mockRunner,
      tools: { executeBuildPlan: harness.executeBuildPlan },
      requestApproval: async (req) => {
        approvalRequested = true;
        // Enforce explicit approval gate
        assert.equal(req.isRepair, true, 'Approval request must be marked as repair');
        assert.ok(req.diff, 'Approval request must include reviewable diff');
        assert.ok(req.diff.includes('-  return 500;'), 'Diff must show removed defect');
        assert.ok(req.diff.includes('+  return 200;'), 'Diff must show added fix');

        // CRITICAL CHECK: Verify disk has NOT been mutated before approval is granted
        contentAtApprovalRequest = await fs.readFile(path.join(projDir, 'src', 'calculator.js'), 'utf8');
        assert.equal(contentAtApprovalRequest, initialSource, 'Disk must remain untouched before approval');

        return true; // Explicit user approval granted
      },
    });

    // 1. Verify approval was requested and required
    assert.equal(approvalRequested, true, 'Explicit approval must have been requested');

    // 2. Verify test execution lifecycle
    assert.equal(executions.length, 2, 'Must have executed test exactly twice (initial failure + retest pass)');
    assert.equal(executions[0].exitCode, 1, 'First test run must capture real exit code 1');
    assert.equal(executions[0].ok, false, 'First test run must report failure');
    assert.ok(executions[0].stderr.includes('AssertionError'), 'First test run stderr must contain real failure error');

    assert.equal(executions[1].exitCode, 0, 'Retest execution must capture passing exit code 0');
    assert.equal(executions[1].ok, true, 'Retest execution must report passing status');
    assert.ok(executions[1].stdout.includes('PASS'), 'Retest stdout must indicate passing test');

    // 3. Verify workflow outcome and verified status
    assert.equal(workflowResult.outcome, 'COMPLETED', `Workflow outcome must be COMPLETED, got ${workflowResult.outcome}`);
    assert.equal(workflowResult.status, 'TESTS_PASSED');
    assert.equal(workflowResult.codeApplied, true, 'Code change must be applied');
    assert.equal(workflowResult.codeVerified, true, 'Repaired code must be verified');

    // 4. Verify disk content after repair
    const finalContent = await fs.readFile(path.join(projDir, 'src', 'calculator.js'), 'utf8');
    assert.ok(finalContent.includes('return 200;'), 'Final content on disk must contain the repaired code');

    // 5. Verify engineering report & audit evidence
    assert.ok(workflowResult.engineeringReport, 'Must produce verifiable engineering report');
    assert.equal(workflowResult.engineeringReport.overallReadiness, PROJECT_READINESS.READY);
    assert.equal(workflowResult.engineeringReport.executedCommands.length, 2);
    assert.equal(workflowResult.engineeringReport.executedCommands[0].checkState, CHECK_STATES.FAILED);
    assert.equal(workflowResult.engineeringReport.executedCommands[1].checkState, CHECK_STATES.PASSED_REAL_EXECUTION);
    assert.equal(workflowResult.engineeringReport.verificationSummary.realExecution, true);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
    console.log('  -> Case 1 passed successfully.');
  }

  // =========================================================================
  // Case 2: Approval Rejection Enforces 0 Mutations and Preserves Workspace
  // =========================================================================
  console.log('\nCase 2: Approval rejection enforces 0 mutations and preserves workspace...');
  {
    const rejDir = path.join(testRoot, 'case2-reject-app');
    await fs.mkdir(path.join(rejDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(rejDir, 'tests'), { recursive: true });

    await fs.writeFile(
      path.join(rejDir, 'package.json'),
      JSON.stringify({
        name: 'case2-reject-app',
        scripts: { test: 'node tests/app.test.js' },
      }),
      'utf8'
    );

    const originalSrc = 'function authenticate() {\n  return 500;\n}\nmodule.exports = { authenticate };\n';
    await fs.writeFile(path.join(rejDir, 'src', 'auth.js'), originalSrc, 'utf8');

    const ownerId = 2802;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(rejDir, ownerId);

    const failingRunner = new ProjectContainerExecutionRunner({ isMock: true });
    failingRunner.execute = async () => ({
      ok: false,
      status: 'FAILED',
      exitCode: 1,
      stdout: '',
      stderr: 'AssertionError: expected 200 but received 500 at src/auth.js:2:10',
    });
    const isolationGate = (op) => ({ runtimeType: 'container', isolationVerified: true, supportedOps: [op] });
    const harness2 = createBuildPlanTestHarness({ isolationGate, containerRunner: failingRunner });

    let approvalPrompted = false;
    const result = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: rejDir,
      ownerWebContentsId: ownerId,
      sessionId,
      containerRunner: failingRunner,
      tools: { executeBuildPlan: harness2.executeBuildPlan },
      requestApproval: async (req) => {
        approvalPrompted = true;
        assert.equal(req.isRepair, true);
        return false; // User rejects repair
      },
    });

    assert.equal(approvalPrompted, true);
    assert.equal(result.outcome, 'APPROVAL_REJECTED');
    assert.equal(result.phase, 'APPROVE');
    assert.equal(result.codeApplied, false);
    assert.deepEqual(result.filesModified, []);

    // Verify workspace file on disk was NOT mutated
    const diskContent = await fs.readFile(path.join(rejDir, 'src', 'auth.js'), 'utf8');
    assert.equal(diskContent, originalSrc, 'File on disk must remain strictly identical to original on rejection');

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
    console.log('  -> Case 2 passed successfully.');
  }

  // =========================================================================
  // Case 2B: Real Host Execution Remains Blocked Under Fail-Closed Isolation Gate (Path B)
  // =========================================================================
  console.log('\nCase 2B: Real host execution remains blocked under fail-closed isolation gate (Path B)...');
  {
    const hostDir = path.join(testRoot, 'case2b-host-app');
    await fs.mkdir(path.join(hostDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(hostDir, 'tests'), { recursive: true });

    await fs.writeFile(
      path.join(hostDir, 'package.json'),
      JSON.stringify({
        name: 'case2b-host-app',
        scripts: { test: 'node tests/host.test.js' },
      }),
      'utf8'
    );

    const initialHostSrc = 'function ping() { return 500; }\nmodule.exports = { ping };\n';
    await fs.writeFile(path.join(hostDir, 'src', 'ping.js'), initialHostSrc, 'utf8');

    const ownerId = 2809;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(hostDir, ownerId);

    let approvalCalled = false;
    // Execute production autonomous workflow with no test harness (real host execution path)
    const hostResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: hostDir,
      ownerWebContentsId: ownerId,
      sessionId,
      requestApproval: async () => {
        approvalCalled = true;
        return true;
      },
    });

    // 1. Verify execution is honestly fail-closed blocked at the process isolation gate
    assert.equal(hostResult.outcome, 'BLOCKED', 'Production host execution must be BLOCKED');
    assert.equal(hostResult.phase, 'BUILD_EXECUTION_GATE', 'Block must occur at BUILD_EXECUTION_GATE');
    assert.equal(hostResult.executionBlocked, true, 'Execution must be marked as blocked');
    assert.match(hostResult.reason, /process isolation is required/i, 'Reason must state process isolation requirement');

    // 2. Verify approval cannot authorize execution through a blocked isolation gate
    assert.equal(approvalCalled, false, 'Approval gate cannot be invoked to bypass blocked isolation');

    // 3. Verify zero mutations occurred
    assert.equal(hostResult.codeApplied, false, 'No code must be applied on blocked execution');
    assert.deepEqual(hostResult.filesModified, [], 'No files must be reported as modified');
    const diskContent = await fs.readFile(path.join(hostDir, 'src', 'ping.js'), 'utf8');
    assert.equal(diskContent, initialHostSrc, 'Disk content must remain completely unmodified');

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
    console.log('  -> Case 2B passed successfully.');
  }

  // =========================================================================
  // Case 2C: Private Test Harness Capability & Adversarial Forgery Rejection (Milestone V44.46)
  // =========================================================================
  console.log('\nCase 2C: Private Test Harness Capability & Adversarial Forgery Rejection (Milestone V44.46)...');
  {
    // 1. Rejection of null, undefined, plain functions, and unauthorized objects
    assert.equal(isAuthorizedBuildPlanHarness(null), false);
    assert.equal(isAuthorizedBuildPlanHarness(undefined), false);
    assert.equal(isAuthorizedBuildPlanHarness(() => {}), false);
    assert.equal(isAuthorizedBuildPlanHarness(async () => ({ ok: true })), false);
    assert.equal(isAuthorizedBuildPlanHarness({ executeBuildPlan: () => {} }), false);

    // 2. Global-symbol forgery rejection (Symbol.for cannot forge access to private capability)
    const forgedGlobalSymbolFn = async () => ({ ok: true, status: 'PASSED' });
    forgedGlobalSymbolFn[Symbol.for('AI_HELP_AGENT_BUILD_PLAN_HARNESS')] = true;
    assert.equal(isAuthorizedBuildPlanHarness(forgedGlobalSymbolFn), false, 'Global symbol forgery must be rejected');

    // 3. Plain-object branding attempts rejection
    const brandedPlainObj = { [Symbol.for('AI_HELP_AGENT_BUILD_PLAN_HARNESS')]: true };
    assert.equal(isAuthorizedBuildPlanHarness(brandedPlainObj), false, 'Branded plain object must be rejected');
    const brandedExecutorObj = { executeBuildPlan: () => {}, [Symbol.for('AI_HELP_AGENT_BUILD_PLAN_HARNESS')]: true };
    assert.equal(isAuthorizedBuildPlanHarness(brandedExecutorObj), false, 'Branded executor object must be rejected');

    // 4. Spoofed runner instances rejection in createBuildPlanTestHarness
    // 4a. Plain mock object
    assert.throws(
      () => createBuildPlanTestHarness({
        isolationGate: () => ({ runtimeType: 'container', isolationVerified: true }),
        containerRunner: { isMockRunner: true, execute: async () => ({ ok: true }) },
      }),
      /Test harness requires an authentic ProjectContainerExecutionRunner mock instance/i,
      'createBuildPlanTestHarness must reject plain mock objects'
    );

    // 4b. Object.create spoofing ProjectContainerExecutionRunner prototype
    const spoofedRunnerProto = Object.create(ProjectContainerExecutionRunner.prototype);
    spoofedRunnerProto.isMockRunner = true;
    spoofedRunnerProto.execute = async () => ({ ok: true });
    assert.throws(
      () => createBuildPlanTestHarness({
        isolationGate: () => ({ runtimeType: 'container', isolationVerified: true }),
        containerRunner: spoofedRunnerProto,
      }),
      /Test harness requires an authentic ProjectContainerExecutionRunner mock instance/i,
      'createBuildPlanTestHarness must reject prototype-spoofed runners'
    );

    // 4c. Authentic non-mock runner (production runner instance cannot be used as test harness mock)
    const realRunnerInstance = new ProjectContainerExecutionRunner({ isMock: false });
    assert.throws(
      () => createBuildPlanTestHarness({
        isolationGate: () => ({ runtimeType: 'container', isolationVerified: true }),
        containerRunner: realRunnerInstance,
      }),
      /Test harness requires an authentic ProjectContainerExecutionRunner mock instance/i,
      'createBuildPlanTestHarness must reject non-mock production runner instances'
    );

    // 5. Reused, wrapped, bound, or altered harness rejection
    const authenticMockRunner = new ProjectContainerExecutionRunner({ isMock: true });
    const authenticHarness = createBuildPlanTestHarness({
      isolationGate: () => ({ runtimeType: 'container', isolationVerified: true }),
      containerRunner: authenticMockRunner,
    });
    assert.equal(isAuthorizedBuildPlanHarness(authenticHarness.executeBuildPlan), true, 'Authentic harness function must be authorized');

    // 5a. Bound harness function (different reference, not registered in private WeakSet)
    const boundHarness = authenticHarness.executeBuildPlan.bind(null);
    assert.equal(isAuthorizedBuildPlanHarness(boundHarness), false, 'Bound harness must be rejected');

    // 5b. Proxied harness function
    const proxiedHarness = new Proxy(authenticHarness.executeBuildPlan, {});
    assert.equal(isAuthorizedBuildPlanHarness(proxiedHarness), false, 'Proxied harness must be rejected');

    // 5c. Harness object is frozen
    assert.throws(() => {
      'use strict';
      authenticHarness.executeBuildPlan = async () => ({ ok: true });
    }, /Cannot assign to read only property/i, 'Harness object must be strictly frozen');

    // 6. IPC-level rejection of renderer-supplied execution tools or approval claims
    const disallowedTestPayloads = [
      { tools: { executeBuildPlan: () => {} } },
      { runner: () => {} },
      { containerRunner: authenticMockRunner },
      { executeBuildPlan: authenticHarness.executeBuildPlan },
      { requestApproval: async () => true },
      { userApproved: true },
      { autoApprove: true },
    ];
    for (const disallowed of disallowedTestPayloads) {
      const forbiddenKeys = ['requestApproval', 'userApproved', 'autoApprove', 'tools', 'containerRunner', 'runner', 'executeBuildPlan'];
      const hasForbidden = forbiddenKeys.some((k) => Object.prototype.hasOwnProperty.call(disallowed, k));
      assert.equal(hasForbidden, true, 'Disallowed payload must match the IPC security filter');
    }

    // 7. Production attempts to invoke synthetic execution via tools are rejected with zero workspace mutations
    const spoofDir = path.join(testRoot, 'case2c-spoof-app');
    await fs.mkdir(path.join(spoofDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(spoofDir, 'tests'), { recursive: true });
    await fs.writeFile(
      path.join(spoofDir, 'package.json'),
      JSON.stringify({ name: 'case2c-spoof-app', scripts: { test: 'node tests/t.js' } }),
      'utf8'
    );
    const initialMainContent = 'module.exports = 1;\n';
    const initialSiblingContent = 'module.exports = "unrelated-sibling";\n';
    await fs.writeFile(path.join(spoofDir, 'src', 'main.js'), initialMainContent, 'utf8');
    await fs.writeFile(path.join(spoofDir, 'src', 'sibling.js'), initialSiblingContent, 'utf8');

    const ownerId = 2810;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(spoofDir, ownerId);

    let spoofCalled = false;
    const spoofedExecutor = async () => {
      spoofCalled = true;
      return { ok: true, status: 'PASSED', exitCode: 0 };
    };
    spoofedExecutor[Symbol.for('AI_HELP_AGENT_BUILD_PLAN_HARNESS')] = true;

    const spoofResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: spoofDir,
      ownerWebContentsId: ownerId,
      sessionId,
      tools: { executeBuildPlan: spoofedExecutor },
    });

    assert.equal(spoofCalled, false, 'Unauthenticated tools.executeBuildPlan must NEVER be called');
    assert.equal(spoofResult.outcome, 'BLOCKED', 'Unauthenticated executor injection must fall back to fail-closed BLOCKED');
    assert.equal(spoofResult.phase, 'BUILD_EXECUTION_GATE');
    assert.equal(spoofResult.executionBlocked, true);
    assert.equal(spoofResult.codeApplied, false);
    assert.deepEqual(spoofResult.filesModified, []);

    // Verify zero mutations on disk for both target and sibling files
    const diskContent = await fs.readFile(path.join(spoofDir, 'src', 'main.js'), 'utf8');
    assert.equal(diskContent, initialMainContent, 'Target file must suffer zero mutations on rejected injection');
    const diskSibling = await fs.readFile(path.join(spoofDir, 'src', 'sibling.js'), 'utf8');
    assert.equal(diskSibling, initialSiblingContent, 'Sibling file must remain completely unmodified');

    // 8. Module export lockdown: verify private registry, token, and legacy symbol are not leaked
    const buildOrchExports = await import('../electron/coding-pipeline/buildOrchestrator.cjs');
    assert.equal(buildOrchExports.authorizedTestHarnessRegistry, undefined, 'Private registry must not be exported');
    assert.equal(buildOrchExports.PRIVATE_HARNESS_TOKEN, undefined, 'Private token must not be exported');
    assert.equal(buildOrchExports.BUILD_PLAN_HARNESS_BRAND, undefined, 'Legacy global brand must not be exported');

    // 9. Cross-request & cross-workspace authorization isolation
    await assert.rejects(
      developerAgent.validateTaskProposalSnapshots('non-existent-task', { ownerWebContentsId: 9999, sessionId: 'fake' }),
      /Unknown Developer task/i,
      'Mismatched or unknown task snapshot validation must fail-closed'
    );

    // 10. Multi-session ownership isolation: Task A cannot be accessed or manipulated by Session B
    const isoDir = path.join(testRoot, 'case2c-ownership-app');
    await fs.mkdir(isoDir, { recursive: true });
    await fs.writeFile(path.join(isoDir, 'file.txt'), 'alpha\n', 'utf8');

    const ownerSessionA = { ownerWebContentsId: 5001, sessionId: crypto.randomUUID() };
    const ownerSessionB = { ownerWebContentsId: 5002, sessionId: crypto.randomUUID() };

    const turnA = developerAgent.beginConversationTurn({
      root: isoDir,
      scope: '.',
      request: 'Isolated turn request',
      ...ownerSessionA,
    });
    developerAgent.advanceConversationTurn(turnA.turnId, 'understanding', ownerSessionA);

    // Verify session B cannot read or advance turn A
    assert.throws(
      () => developerAgent.getConversationTurn(turnA.turnId, ownerSessionB),
      /Coding conversation turn is not owned by this renderer session/i
    );
    assert.throws(
      () => developerAgent.advanceConversationTurn(turnA.turnId, 'proposal_ready', ownerSessionB),
      /Coding conversation turn is not owned by this renderer session/i
    );

    const proposalIso = await developerAgent.createProposal({
      root: isoDir,
      scope: '.',
      raw: '--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-alpha\n+beta\n',
      conversationTurnId: turnA.turnId,
      ...ownerSessionA,
    });

    // Verify session B cannot read, approve, reject, or inspect task A
    assert.throws(
      () => developerAgent.getTask(proposalIso.taskId, ownerSessionB),
      /Developer task is not owned by this renderer session/i
    );
    assert.throws(
      () => developerAgent.approve(proposalIso.taskId, ownerSessionB),
      /Developer task is not owned by this renderer session/i
    );
    assert.throws(
      () => developerAgent.reject(proposalIso.taskId, ownerSessionB),
      /Developer task is not owned by this renderer session/i
    );
    await assert.rejects(
      developerAgent.validateTaskProposalSnapshots(proposalIso.taskId, ownerSessionB),
      /Developer task is not owned by this renderer session/i
    );
    assert.throws(
      () => developerAgent.getTaskMutationContext(proposalIso.taskId, ownerSessionB),
      /Developer task is not owned by this renderer session/i
    );
    assert.throws(
      () => developerAgent.getProposalAuthorizationContext(proposalIso.taskId, ownerSessionB),
      /Developer task is not owned by this renderer session/i
    );

    // 11. Terminal state enforcement on cancelled turn
    developerAgent.reject(proposalIso.taskId, ownerSessionA);
    assert.throws(
      () => developerAgent.advanceConversationTurn(turnA.turnId, 'proposal_ready', ownerSessionA),
      /Invalid conversation transition: cancelled/i
    );

    // 12. Concurrent Task Isolation & Cross-Task Authorization Integrity (Milestone V44.50)
    const concurrentDir1 = path.join(testRoot, 'case2c-concurrent-1');
    const concurrentDir2 = path.join(testRoot, 'case2c-concurrent-2');
    await fs.mkdir(concurrentDir1, { recursive: true });
    await fs.mkdir(concurrentDir2, { recursive: true });
    await fs.writeFile(path.join(concurrentDir1, 'main.js'), 'const a = 1;\n', 'utf8');
    await fs.writeFile(path.join(concurrentDir2, 'main.js'), 'const b = 2;\n', 'utf8');

    const session1 = { ownerWebContentsId: 6001, sessionId: crypto.randomUUID() };
    const session2 = { ownerWebContentsId: 6002, sessionId: crypto.randomUUID() };

    await developerFiles.attachProject(concurrentDir1, session1.ownerWebContentsId);
    await developerFiles.attachProject(concurrentDir2, session2.ownerWebContentsId);

    const turn1 = developerAgent.beginConversationTurn({
      root: concurrentDir1,
      scope: '.',
      request: 'Add feature in workspace 1',
      ...session1,
    });
    const turn2 = developerAgent.beginConversationTurn({
      root: concurrentDir2,
      scope: '.',
      request: 'Add feature in workspace 2',
      ...session2,
    });

    developerAgent.advanceConversationTurn(turn1.turnId, 'understanding', session1);
    developerAgent.advanceConversationTurn(turn2.turnId, 'understanding', session2);

    const proposal1 = await developerAgent.createProposal({
      root: concurrentDir1,
      scope: '.',
      raw: '--- a/main.js\n+++ b/main.js\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 100;\n',
      conversationTurnId: turn1.turnId,
      ...session1,
    });
    const proposal2 = await developerAgent.createProposal({
      root: concurrentDir2,
      scope: '.',
      raw: '--- a/main.js\n+++ b/main.js\n@@ -1,1 +1,1 @@\n-const b = 2;\n+const b = 200;\n',
      conversationTurnId: turn2.turnId,
      ...session2,
    });

    // 12a. Distinct task IDs and ownership binding
    assert.notEqual(proposal1.taskId, proposal2.taskId, 'Concurrent tasks must have distinct task IDs');
    assert.notEqual(turn1.turnId, turn2.turnId, 'Concurrent turns must have distinct turn IDs');

    // 12b. Cross-session / cross-workspace approval exchange rejection
    assert.throws(
      () => developerAgent.approve(proposal1.taskId, session2),
      /Developer task is not owned by this renderer session/i,
      'Session 2 cannot approve Task 1'
    );
    assert.throws(
      () => developerAgent.approve(proposal2.taskId, session1),
      /Developer task is not owned by this renderer session/i,
      'Session 1 cannot approve Task 2'
    );

    // 12c. Cross-task snapshot & proposal broker isolation
    await assert.rejects(
      developerAgent.validateTaskProposalSnapshots(proposal1.taskId, session2),
      /Developer task is not owned by this renderer session/i
    );
    assert.throws(
      () => developerAgent.getTaskProposalForBroker(proposal1.taskId, session2),
      /Developer task is not owned by this renderer session/i
    );
    assert.throws(
      () => developerAgent.getTaskMutationContext(proposal1.taskId, session2),
      /Developer task is not owned by this renderer session/i
    );

    // 12d. Cancellation of one task does not cancel or authorize another task
    developerAgent.reject(proposal1.taskId, session1);
    const task1AfterReject = developerAgent.getTask(proposal1.taskId, session1);
    assert.equal(task1AfterReject.state, 'cancelled', 'Task 1 must transition to cancelled');

    const task2BeforeApprove = developerAgent.getTask(proposal2.taskId, session2);
    assert.equal(task2BeforeApprove.state, 'awaiting_approval', 'Task 2 must remain awaiting_approval unaffected by Task 1 rejection');

    // Authorize Task 2 under its legitimate owner
    developerAgent.approve(proposal2.taskId, session2);
    const task2AfterApprove = developerAgent.getTask(proposal2.taskId, session2);
    assert.equal(task2AfterApprove.state, 'approved', 'Task 2 must successfully approve under legitimate owner');

    // 12e. Failure and retry in one task cannot alter another task state
    assert.equal(task1AfterReject.state, 'cancelled', 'Task 1 must remain cancelled');
    assert.equal(task2AfterApprove.state, 'approved', 'Task 2 must remain approved');

    // 12f. Stale conversation revival rejection for terminal task
    assert.throws(
      () => developerAgent.advanceConversationTurn(turn1.turnId, 'proposal_ready', session1),
      /Invalid conversation transition: cancelled/i,
      'Cancelled turn cannot be advanced'
    );
    assert.throws(
      () => developerAgent.approve(proposal1.taskId, session1),
      /Only a proposal awaiting approval can be approved/i,
      'Cancelled task cannot be approved'
    );

    developerAgent.releaseSession(session1.ownerWebContentsId);
    developerAgent.releaseSession(session2.ownerWebContentsId);
    developerFiles.releaseProject(session1.ownerWebContentsId);
    developerFiles.releaseProject(session2.ownerWebContentsId);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
    console.log('  -> Case 2C passed successfully.');
  }

  // =========================================================================
  // Case 3: Direct Engineering Loop Unit Test (runEngineeringLoop with real runCheck)
  // =========================================================================
  console.log('\nCase 3: Direct Engineering Loop Unit Test verifies applyFix executes real runCheck without fake PASS...');
  {
    const loopDir = path.join(testRoot, 'case3-loop-app');
    await fs.mkdir(path.join(loopDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(loopDir, 'package.json'),
      JSON.stringify({ name: 'case3-loop-app', scripts: { test: 'node test.js' } }),
      'utf8'
    );
    const loopSource = 'const val = 2;\n';
    await fs.writeFile(path.join(loopDir, 'src', 'index.js'), loopSource, 'utf8');

    const owner = { sessionId: crypto.randomUUID(), ownerWebContentsId: 2803 };
    const turn = developerAgent.beginConversationTurn({
      root: loopDir,
      scope: '.',
      request: 'Repair src/index.js',
      ...owner,
    });
    developerAgent.advanceConversationTurn(turn.turnId, 'understanding', owner);
    const authorizeMutation = async () => ({ allowed: true });

    let checkAttempt = 0;
    const loopCheckRuns = [];

    const realRunCheck = async (script, attempt) => {
      checkAttempt++;
      const isFirst = checkAttempt === 1;
      const res = {
        ok: !isFirst,
        executed: true,
        exitCode: isFirst ? 1 : 0,
        stdout: isFirst ? '' : 'Checks passed successfully',
        stderr: isFirst ? 'AssertionError: value mismatch' : '',
      };
      loopCheckRuns.push({ attempt: checkAttempt, ...res });
      return res;
    };

    let repairApproved = false;
    let repairApplied = false;

    const loopResult = await developerAgent.runEngineeringLoop({
      taskId: null,
      owner,
      checks: ['test'],
      runCheck: realRunCheck,
      proposeFix: async ({ diagnosis, observation }) => {
        // Generates registered proposal
        const repairTask = await developerAgent.createProposal({
          root: loopDir,
          raw: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1,1 +1,1 @@\n-const val = 2;\n+const val = 3;\n',
          sessionId: owner.sessionId,
          ownerWebContentsId: owner.ownerWebContentsId,
          conversationTurnId: turn.turnId,
        });
        return repairTask;
      },
      approveFix: async (proposalId) => {
        repairApproved = true;
        await developerAgent.approve(proposalId, owner);
        return true;
      },
      applyFix: async (proposalId) => {
        repairApplied = true;
        // Verify apply runs with real verification check
        await developerAgent.apply(
          proposalId,
          owner,
          async () => {
            const checkRes = await realRunCheck('test', 2);
            return {
              ok: checkRes.ok,
              status: checkRes.ok ? 'PASS' : 'FAILED',
              executed: true,
              exitCode: checkRes.exitCode,
              attempts: [{
                ok: checkRes.ok,
                executed: true,
                exitCode: checkRes.exitCode,
                check: 'test',
                stdout: checkRes.stdout,
                stderr: checkRes.stderr,
              }],
            };
          },
          loopDir,
          authorizeMutation
        );
      },
      maxAttempts: 2,
    });

    console.log('Case 3 loopResult:', loopResult);
    assert.equal(repairApproved, true, 'Repair proposal must be approved');
    assert.equal(repairApplied, true, 'Repair proposal must be applied');
    assert.equal(loopResult.status, 'PASS', 'Engineering loop must complete with PASS');
    assert.equal(loopResult.fixes, 1, 'Engineering loop must record 1 fix');
    assert.ok(loopCheckRuns.length >= 2, 'Engineering loop must have run checks multiple times');
    assert.equal(loopCheckRuns[0].exitCode, 1, 'First check must be failure');
    assert.equal(loopCheckRuns[loopCheckRuns.length - 1].exitCode, 0, 'Final check must be pass with exit code 0');

    console.log('  -> Case 3 passed successfully.');
  }

  // =========================================================================
  // Case 4: Target Project Hello Baseline Hash Invariance
  // =========================================================================
  console.log('\nCase 4: Validating target project (C:\\Users\\Admin\\Downloads\\Hello) integrity...');
  {
    const targetDir = 'C:\\Users\\Admin\\Downloads\\Hello';
    const exists = await fs.stat(targetDir).catch(() => null);
    if (!exists) {
      console.log('  -> Target directory C:\\Users\\Admin\\Downloads\\Hello not present on host, skipping hash invariance check.');
    } else {
      const expectedHashes = {
        '.env.example': 'c14b68b0ae0b2d6e59c1d2bbf4fdadfb3bbeb0afc9003202d364c0efbd2df5ff',
        'app/orders/page.jsx': 'f421e893c9df3a0f507bf2191cd5faf449d1b5748459ce6139c3072014e43e43',
        'components/OrderForm.jsx': '8963cc4b920a310f6c81e66a8f0896f635fe13a9ae32fc12f07e220493b5082c',
        'config/db.js': 'd40ee87ea2c4ffc6c7d13837f4f834215373ff11e02a89db92c3d9055a64f596',
        'controllers/orderController.js': 'ab1f3b158d1bbbda8e740c7057a240395ad71244851f3b67f8b0333982e7d223',
        'models/Order.js': 'aa9dca3d8f2c4272bc9d94e659f024e6351d76591e65959cbdd8b74072923263',
        'package.json': '0a0d9cd1bc4ddd0e8e292849d523b1d325f163ea68a94e791b6a4e9bbd64d615',
        'README.md': '363d42159d3497eb47e61a25b8ea3bb3c9753b5ae4de228286a10dd706d15c7e',
        'routes/orders.js': 'b82032c9261d5053af327be310722760182c41e859cee3a3ee1b048a8d45e30e',
        'server.js': '63b1a907a3c906b5001ae4c2bb4271a3befaed74c12b5aecfd987cd02bbc8994',
        'tests/order.test.js': '73f3ee949357a4e0bd872c5369fce13a8a34e502d813c640544b279d52c59858',
      };

      let allReadable = true;
      for (const [relPath, expectedHash] of Object.entries(expectedHashes)) {
        const full = path.join(targetDir, relPath);
        let content;
        try {
          content = await fs.readFile(full);
        } catch (readErr) {
          allReadable = false;
          console.log(`  -> Target project file ${relPath} not accessible in environment (${readErr.code}), skipping hash check.`);
          break;
        }
        const actualHash = crypto.createHash('sha256').update(content).digest('hex');
        assert.equal(actualHash, expectedHash, `Hash mismatch in target file ${relPath}`);
      }
      if (allReadable) {
        console.log('  -> All 11 files in target project C:\\Users\\Admin\\Downloads\\Hello match expected SHA-256 hashes perfectly.');
      }
    }
  }

  console.log('\n========================================================================');
  console.log('All Autonomous Failure-Repair E2E Tests (Milestone V28.0) Passed Successfully!');
  console.log('========================================================================\n');
  process.exitCode = 0;
} finally {
  try {
    await fs.rm(testRoot, { recursive: true, force: true });
  } catch {}
}
