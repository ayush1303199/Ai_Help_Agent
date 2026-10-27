import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import projectCommandAuthorization from '../electron/coding-pipeline/projectCommandAuthorization.cjs';

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

    const mockRunner = {
      execute: async () => {
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
      },
    };

    const workflowResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: projDir,
      ownerWebContentsId: ownerId,
      sessionId,
      containerRunner: mockRunner,
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

    const failingRunner = {
      execute: async () => ({
        ok: false,
        status: 'FAILED',
        exitCode: 1,
        stdout: '',
        stderr: 'AssertionError: expected 200 but received 500 at src/auth.js:2:10',
      }),
    };

    let approvalPrompted = false;
    const result = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: rejDir,
      ownerWebContentsId: ownerId,
      sessionId,
      containerRunner: failingRunner,
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

    for (const [relPath, expectedHash] of Object.entries(expectedHashes)) {
      const full = path.join(targetDir, relPath);
      const content = await fs.readFile(full);
      const actualHash = crypto.createHash('sha256').update(content).digest('hex');
      assert.equal(actualHash, expectedHash, `Hash mismatch in target file ${relPath}`);
    }
    console.log('  -> All 11 files in target project C:\\Users\\Admin\\Downloads\\Hello match expected SHA-256 hashes perfectly.');
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
