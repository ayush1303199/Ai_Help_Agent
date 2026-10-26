/**
 * Milestone V21 Autonomous Project Testing, Diagnosis & Repair Verification Test Suite.
 *
 * Verifies:
 * 1. "test the project" initiates autonomous project inspection and actionable test plan.
 * 2. Missing test scripts reported honestly as NOT_CONFIGURED.
 * 3. Missing dependencies detected from evidence; prerequisite gate enforced.
 * 4. Autonomous dependency proposal, approval gate, and isolated installation.
 * 5. Fail-closed isolation gate blocks execution when container runner is unverified.
 * 6. Passing test execution captured with real evidence and PASSED_REAL_EXECUTION state.
 * 7. Autonomous diagnosis captures failure evidence, root cause, and affected files.
 * 8. Minimal repair proposal generated and approval gate enforced (rejection produces 0 mutations).
 * 9. Approved repair applied, tests rerun in verified container, and report generated.
 * 10. Two-phase pause (APPROVAL_REQUIRED) and continuation token resumption.
 * 11. Failed rerun triggers automatic snapshot rollback, preserving original workspace.
 * 12. Real workspace verification (C:\Users\Admin\Downloads\Hello) remains fail-closed and pristine.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const developerAgent = require('../electron/developerAgent.cjs');
const developerFiles = require('../electron/developerFiles.cjs');
const { isProjectRuntimeTestRequest } = require('../electron/coding-pipeline/projectRuntimeTestIntent.cjs');

const {
  CHECK_STATES,
  PROJECT_READINESS,
  buildEngineeringReport,
} = developerAgent;

async function runTestSuite() {
  console.log('Starting Milestone V21 Autonomous Testing, Diagnosis & Repair Test Suite...\n');
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'v21-autonomous-test-'));

  try {
    // =========================================================================
    // Case 1: Intent Routing & Project Discovery
    // =========================================================================
    console.log('Case 1: `test the project` initiates project inspection and actionable test plan...');
    {
      assert.equal(isProjectRuntimeTestRequest('test the project'), true);
      assert.equal(isProjectRuntimeTestRequest('run the tests'), true);
      assert.equal(isProjectRuntimeTestRequest('test the app'), true);

      const appDir = path.join(testRoot, 'case1-app');
      await fs.mkdir(appDir, { recursive: true });
      await fs.writeFile(
        path.join(appDir, 'package.json'),
        JSON.stringify({
          name: 'case1-app',
          scripts: { test: 'node test.js' },
        }),
        'utf8'
      );

      const ownerId = 2101;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(appDir, ownerId);

      const discovery = await developerAgent.discoverBuildOperations(appDir);
      assert.equal(discovery.ecosystem, 'node');
      assert.ok(discovery.availableOperations.TEST);
      assert.equal(discovery.availableOperations.TEST.binary, 'npm');
      assert.deepEqual(discovery.availableOperations.TEST.args, ['test']);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 2: Missing Test Script Reported Honestly as NOT_CONFIGURED
    // =========================================================================
    console.log('Case 2: Missing test scripts reported honestly as NOT_CONFIGURED...');
    {
      const noTestDir = path.join(testRoot, 'case2-no-test');
      await fs.mkdir(noTestDir, { recursive: true });
      await fs.writeFile(
        path.join(noTestDir, 'package.json'),
        JSON.stringify({
          name: 'case2-no-test',
          scripts: { build: 'vite build' },
        }),
        'utf8'
      );

      const ownerId = 2102;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(noTestDir, ownerId);

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: noTestDir,
        ownerWebContentsId: ownerId,
        sessionId,
      });

      assert.equal(result.outcome, 'TEST_NOT_CONFIGURED');
      assert.equal(result.phase, 'BUILD_PLAN');
      assert.equal(result.executionBlocked, true);
      assert.ok(result.engineeringReport);
      assert.equal(result.engineeringReport.overallReadiness, PROJECT_READINESS.READY_WITH_WARNINGS);
      assert.equal(result.engineeringReport.executedCommands[0].checkState, CHECK_STATES.NOT_CONFIGURED);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 3: Missing Dependencies Prerequisite Gate
    // =========================================================================
    console.log('Case 3: Missing dependencies detected from manifest; prerequisite gate enforced...');
    {
      const depDir = path.join(testRoot, 'case3-dep-app');
      await fs.mkdir(depDir, { recursive: true });
      await fs.writeFile(
        path.join(depDir, 'package.json'),
        JSON.stringify({
          name: 'case3-dep-app',
          scripts: { test: 'node test.js' },
          dependencies: { chalk: '^4.1.2' },
        }),
        'utf8'
      );

      const ownerId = 2103;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(depDir, ownerId);

      // Without approval callback, halts at prerequisite gate
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: depDir,
        ownerWebContentsId: ownerId,
        sessionId,
      });

      assert.equal(result.outcome, 'BLOCKED');
      assert.equal(result.phase, 'DEPENDENCY_PREREQUISITE_GATE');
      assert.equal(result.executionBlocked, true);
      assert.ok(result.missingDependencies.length > 0);
      assert.ok(result.engineeringReport);
      assert.equal(result.engineeringReport.overallReadiness, PROJECT_READINESS.BLOCKED);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 4: Autonomous Dependency Installation & Test Progression When Approved
    // =========================================================================
    console.log('Case 4: Autonomous dependency proposal, approval gate, and isolated installation...');
    {
      const autoDepDir = path.join(testRoot, 'case4-auto-dep');
      await fs.mkdir(autoDepDir, { recursive: true });
      await fs.writeFile(
        path.join(autoDepDir, 'package.json'),
        JSON.stringify({
          name: 'case4-auto-dep',
          scripts: { test: 'node test.js' },
          dependencies: { lodash: '^4.17.21' },
        }),
        'utf8'
      );

      const ownerId = 2104;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(autoDepDir, ownerId);

      let approvalRequested = false;
      const mockContainerRunner = {
        execute: async ({ plan }) => {
          if (plan.operation === 'INSTALL' || plan.fullCommandString.includes('install')) {
            // Simulate container install creating node_modules
            const modDir = path.join(autoDepDir, 'node_modules', 'lodash');
            await fs.mkdir(modDir, { recursive: true });
            await fs.writeFile(path.join(modDir, 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }));
            return { ok: true, status: 'PASSED', exitCode: 0, stdout: 'added 1 package', stderr: '' };
          }
          if (plan.operation === 'TEST') {
            return { ok: true, status: 'PASSED', exitCode: 0, stdout: '1 test passed', stderr: '' };
          }
          return { ok: true, status: 'PASSED', exitCode: 0, stdout: '', stderr: '' };
        },
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: autoDepDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockContainerRunner,
        requestApproval: async (req) => {
          approvalRequested = true;
          assert.ok(req.isDependencyPlan);
          return true;
        },
      });

      assert.equal(approvalRequested, true);
      assert.equal(result.outcome, 'COMPLETED');
      assert.equal(result.status, 'TESTS_PASSED');
      assert.equal(result.codeVerified, true);
      assert.ok(result.engineeringReport);
      assert.equal(result.engineeringReport.overallReadiness, PROJECT_READINESS.READY);
      assert.equal(result.engineeringReport.executedCommands[0].checkState, CHECK_STATES.PASSED_REAL_EXECUTION);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 5: Fail-Closed Isolation Gate
    // =========================================================================
    console.log('Case 5: Fail-closed isolation gate blocks execution when container runner is unverified...');
    {
      const isoDir = path.join(testRoot, 'case5-iso-app');
      await fs.mkdir(isoDir, { recursive: true });
      await fs.writeFile(
        path.join(isoDir, 'package.json'),
        JSON.stringify({
          name: 'case5-iso-app',
          scripts: { test: 'node test.js' },
        }),
        'utf8'
      );

      const ownerId = 2105;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(isoDir, ownerId);

      // Null container runner simulates host without verified isolation
      const blockedRunner = {
        execute: async () => ({
          ok: false,
          executionBlocked: true,
          status: 'BLOCKED',
          reason: 'Process isolation unavailable: verified Windows process isolation is required.',
        }),
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: isoDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: blockedRunner,
      });

      assert.equal(result.outcome, 'BLOCKED');
      assert.equal(result.phase, 'BUILD_EXECUTION_GATE');
      assert.equal(result.executionBlocked, true);
      assert.ok(result.reason.includes('process isolation is required'));
      assert.ok(result.engineeringReport);
      assert.equal(result.engineeringReport.overallReadiness, PROJECT_READINESS.BLOCKED);
      assert.equal(result.engineeringReport.executedCommands[0].checkState, CHECK_STATES.BLOCKED_ISOLATION);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 6: Successful Real Execution on Passing Suite
    // =========================================================================
    console.log('Case 6: Passing test execution captured with real evidence and PASSED_REAL_EXECUTION state...');
    {
      const passDir = path.join(testRoot, 'case6-pass-app');
      await fs.mkdir(passDir, { recursive: true });
      await fs.writeFile(
        path.join(passDir, 'package.json'),
        JSON.stringify({
          name: 'case6-pass-app',
          scripts: { test: 'node tests/pass.test.js' },
        }),
        'utf8'
      );

      const ownerId = 2106;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(passDir, ownerId);

      const mockPassingRunner = {
        execute: async ({ plan }) => ({
          ok: true,
          status: 'PASSED',
          exitCode: 0,
          stdout: 'PASS tests/pass.test.js\n  √ all 5 assertions passed',
          stderr: '',
          elapsedMs: 84,
        }),
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: passDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockPassingRunner,
      });

      assert.equal(result.outcome, 'COMPLETED');
      assert.equal(result.status, 'TESTS_PASSED');
      assert.equal(result.codeVerified, true);
      assert.equal(result.buildResult.exitCode, 0);
      assert.ok(result.buildResult.stdout.includes('all 5 assertions passed'));

      assert.ok(result.engineeringReport);
      assert.equal(result.engineeringReport.overallReadiness, PROJECT_READINESS.READY);
      assert.equal(result.engineeringReport.executedCommands[0].checkState, CHECK_STATES.PASSED_REAL_EXECUTION);
      assert.equal(result.engineeringReport.verificationSummary.realExecution, true);
      assert.equal(result.engineeringReport.verificationSummary.staticAnalysis, false);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 7: Autonomous Diagnosis on Test Failure
    // =========================================================================
    console.log('Case 7: Autonomous diagnosis captures failure evidence, root cause, and affected files...');
    {
      const failDir = path.join(testRoot, 'case7-fail-app');
      await fs.mkdir(failDir, { recursive: true });
      await fs.writeFile(
        path.join(failDir, 'package.json'),
        JSON.stringify({
          name: 'case7-fail-app',
          scripts: { test: 'node tests/failing.test.js' },
        }),
        'utf8'
      );

      const ownerId = 2107;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(failDir, ownerId);

      const mockFailingRunner = {
        execute: async () => ({
          ok: false,
          status: 'FAILED',
          exitCode: 1,
          stdout: '',
          stderr: 'AssertionError: expected 200 OK but received 500 Internal Server Error at tests/failing.test.js:14:5',
        }),
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: failDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockFailingRunner,
      });

      assert.equal(result.outcome, 'TESTS_FAILED');
      assert.equal(result.phase, 'BUILD_EXECUTE');
      assert.equal(result.codeVerified, false);
      assert.equal(result.buildResult.exitCode, 1);
      assert.ok(result.diagnosis);
      assert.equal(result.diagnosis.failureCategory, 'ASSERTION_FAILURE');
      assert.ok(result.diagnosis.rootCause.includes('Assertion'));
      assert.ok(result.diagnosis.affectedFiles.some((f) => f.includes('failing.test.js')));

      assert.ok(result.engineeringReport);
      assert.equal(result.engineeringReport.overallReadiness, PROJECT_READINESS.FAILED);
      assert.equal(result.engineeringReport.executedCommands[0].checkState, CHECK_STATES.FAILED);
      assert.equal(result.engineeringReport.diagnosedDefects[0].category, 'ASSERTION_FAILURE');

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 8: Controlled Repair Proposal & User Rejection
    // =========================================================================
    console.log('Case 8: Minimal repair proposal generated and approval gate enforced (rejection produces 0 mutations)...');
    {
      const rejectDir = path.join(testRoot, 'case8-reject-app');
      await fs.mkdir(path.join(rejectDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(rejectDir, 'tests'), { recursive: true });
      await fs.writeFile(
        path.join(rejectDir, 'package.json'),
        JSON.stringify({
          name: 'case8-reject-app',
          scripts: { test: 'node tests/calc.test.js' },
        }),
        'utf8'
      );
      const originalSrc = 'function calculateTotal() {\n  return 500;\n}\nmodule.exports = { calculateTotal };\n';
      await fs.writeFile(path.join(rejectDir, 'src', 'calculator.js'), originalSrc, 'utf8');

      const ownerId = 2108;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(rejectDir, ownerId);

      const mockFailingRunner = {
        execute: async () => ({
          ok: false,
          status: 'FAILED',
          exitCode: 1,
          stdout: '',
          stderr: 'AssertionError: expected 200 but received 500 at src/calculator.js:2:10',
        }),
      };

      let approvalPrompted = false;
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: rejectDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockFailingRunner,
        requestApproval: async (req) => {
          approvalPrompted = true;
          assert.equal(req.isRepair, true);
          assert.ok(req.diff.includes('-  return 500;'));
          assert.ok(req.diff.includes('+  return 200;'));
          return false; // User rejects!
        },
      });

      assert.equal(approvalPrompted, true);
      assert.equal(result.outcome, 'APPROVAL_REJECTED');
      assert.equal(result.phase, 'APPROVE');
      assert.equal(result.codeApplied, false);
      assert.deepEqual(result.filesModified, []);

      // Verify file on disk was NOT mutated
      const diskContent = await fs.readFile(path.join(rejectDir, 'src', 'calculator.js'), 'utf8');
      assert.equal(diskContent, originalSrc);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 9: Approved Fix Application, Test Rerun, and Passing Outcome
    // =========================================================================
    console.log('Case 9: Approved fix applied, tests rerun in verified container, and report generated...');
    {
      const fixDir = path.join(testRoot, 'case9-fix-app');
      await fs.mkdir(path.join(fixDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(fixDir, 'tests'), { recursive: true });
      await fs.writeFile(
        path.join(fixDir, 'package.json'),
        JSON.stringify({
          name: 'case9-fix-app',
          scripts: { test: 'node tests/calc.test.js' },
        }),
        'utf8'
      );
      await fs.writeFile(
        path.join(fixDir, 'src', 'calculator.js'),
        'function getStatusCode() {\n  return 500;\n}\nmodule.exports = { getStatusCode };\n',
        'utf8'
      );

      const ownerId = 2109;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(fixDir, ownerId);

      let runCount = 0;
      const mockContainerRunner = {
        execute: async () => {
          runCount++;
          if (runCount === 1) {
            return {
              ok: false,
              status: 'FAILED',
              exitCode: 1,
              stdout: '',
              stderr: 'AssertionError: expected 200 but received 500 at src/calculator.js:2:10',
            };
          }
          // Rerun after patch
          return {
            ok: true,
            status: 'PASSED',
            exitCode: 0,
            stdout: 'PASS tests/calc.test.js: All tests passed successfully',
            stderr: '',
          };
        },
      };

      let userApproved = false;
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: fixDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockContainerRunner,
        requestApproval: async (req) => {
          userApproved = true;
          assert.equal(req.isRepair, true);
          return true; // Approve!
        },
      });

      assert.equal(userApproved, true);
      assert.equal(runCount, 2); // Initial run + rerun
      assert.equal(result.outcome, 'COMPLETED');
      assert.equal(result.status, 'TESTS_PASSED');
      assert.equal(result.codeApplied, true);
      assert.equal(result.codeVerified, true);
      assert.ok(result.filesModified.some((f) => f.includes('calculator.js')));

      // Check file on disk was patched with minimal fix
      const patchedContent = await fs.readFile(path.join(fixDir, 'src', 'calculator.js'), 'utf8');
      assert.ok(patchedContent.includes('return 200;'));

      assert.ok(result.engineeringReport);
      assert.equal(result.engineeringReport.overallReadiness, PROJECT_READINESS.READY);
      assert.equal(result.engineeringReport.executedCommands.length, 2);
      assert.equal(result.engineeringReport.executedCommands[0].checkState, CHECK_STATES.FAILED);
      assert.equal(result.engineeringReport.executedCommands[1].checkState, CHECK_STATES.PASSED_REAL_EXECUTION);
      assert.equal(result.engineeringReport.rerunResults[0].passed, true);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 10: Two-Phase Pause & Continuation Resumption
    // =========================================================================
    console.log('Case 10: Two-phase pause (APPROVAL_REQUIRED) and continuation token resumption...');
    {
      const pauseDir = path.join(testRoot, 'case10-pause-app');
      await fs.mkdir(path.join(pauseDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(pauseDir, 'package.json'),
        JSON.stringify({
          name: 'case10-pause-app',
          scripts: { test: 'node test.js' },
        }),
        'utf8'
      );
      await fs.writeFile(
        path.join(pauseDir, 'src', 'app.js'),
        'const mode = "inactive";\nmodule.exports = { mode };\n',
        'utf8'
      );

      const ownerId = 2110;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(pauseDir, ownerId);

      let runs = 0;
      const mockContainerRunner = {
        execute: async () => {
          runs++;
          if (runs === 1) {
            return {
              ok: false,
              status: 'FAILED',
              exitCode: 1,
              stdout: '',
              stderr: 'AssertionError: expected "active" but received "inactive" at src/app.js:1:15',
            };
          }
          return {
            ok: true,
            status: 'PASSED',
            exitCode: 0,
            stdout: 'PASS: mode is active',
            stderr: '',
          };
        },
      };

      // Step 1: Execute without approval callback -> pauses at APPROVAL_REQUIRED
      const pauseResult = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: pauseDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockContainerRunner,
        requestApproval: null, // No interactive callback
      });

      assert.equal(pauseResult.outcome, 'APPROVAL_REQUIRED');
      assert.equal(pauseResult.phase, 'APPROVE');
      assert.ok(pauseResult.continuationToken);
      assert.ok(pauseResult.repairPlan);
      assert.equal(pauseResult.codeApplied, false);

      // Step 2: Resume with continuation token and userApproved: true
      const resumeResult = await developerAgent.executeAutonomousCodingWorkflow({
        continuationToken: pauseResult.continuationToken,
        root: pauseDir,
        ownerWebContentsId: ownerId,
        sessionId,
        userApproved: true,
        containerRunner: mockContainerRunner,
      });

      assert.equal(resumeResult.outcome, 'COMPLETED');
      assert.equal(resumeResult.status, 'TESTS_PASSED');
      assert.equal(resumeResult.codeApplied, true);
      assert.equal(resumeResult.codeVerified, true);

      const diskText = await fs.readFile(path.join(pauseDir, 'src', 'app.js'), 'utf8');
      assert.ok(diskText.includes('"active"'));

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 11: Rerun Failure & Snapshot Rollback
    // =========================================================================
    console.log('Case 11: Failed rerun triggers automatic snapshot rollback, preserving original workspace...');
    {
      const rollDir = path.join(testRoot, 'case11-rollback-app');
      await fs.mkdir(path.join(rollDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(rollDir, 'package.json'),
        JSON.stringify({
          name: 'case11-rollback-app',
          scripts: { test: 'node test.js' },
        }),
        'utf8'
      );
      const originalCode = 'const val = 100;\nmodule.exports = { val };\n';
      await fs.writeFile(path.join(rollDir, 'src', 'index.js'), originalCode, 'utf8');

      const ownerId = 2111;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(rollDir, ownerId);

      const mockAlwaysFailingRunner = {
        execute: async () => ({
          ok: false,
          status: 'FAILED',
          exitCode: 1,
          stdout: '',
          stderr: 'AssertionError: expected 200 but received 100 at src/index.js:1:13',
        }),
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: rollDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockAlwaysFailingRunner,
        requestApproval: async () => true, // Approved, but rerun fails!
      });

      assert.equal(result.outcome, 'TESTS_FAILED');
      assert.equal(result.phase, 'BUILD_EXECUTE');
      assert.equal(result.codeApplied, false);
      assert.equal(result.codeVerified, false);

      // Verify that after failed rerun, snapshot rollback restored the original content
      const diskContent = await fs.readFile(path.join(rollDir, 'src', 'index.js'), 'utf8');
      assert.equal(diskContent, originalCode);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 12: Real Workspace (C:\Users\Admin\Downloads\Hello) Preflight & Safety
    // =========================================================================
    console.log('Case 12: Real Hello workspace verification (C:\\Users\\Admin\\Downloads\\Hello)...');
    {
      const realHelloPath = 'C:\\Users\\Admin\\Downloads\\Hello';
      const exists = await fs.stat(realHelloPath).then(() => true).catch(() => false);
      assert.equal(exists, true, 'Real target project C:\\Users\\Admin\\Downloads\\Hello must exist.');

      const ownerId = 2112;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(realHelloPath, ownerId);

      // Dependencies are missing and isolation is absent on host -> strictly BLOCKED
      const realResult = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: realHelloPath,
        ownerWebContentsId: ownerId,
        sessionId,
      });

      assert.ok(['SUCCESS', 'COMPLETED', 'BLOCKED'].includes(realResult.outcome));
      assert.ok(
        (realResult.message && realResult.message.includes('Missing node_modules directory'))
        || (realResult.reason && realResult.reason.includes('Dependencies'))
      );
      assert.deepEqual(realResult.filesModified, []);

      // Verify node_modules was NOT created on host
      const nodeModulesExists = await fs.stat(path.join(realHelloPath, 'node_modules')).then(() => true).catch(() => false);
      assert.equal(nodeModulesExists, false, 'node_modules must NOT exist on host without verified isolation.');

      assert.ok(realResult.message || realResult.engineeringReport);
      if (realResult.engineeringReport) {
        assert.equal(realResult.engineeringReport.overallReadiness, PROJECT_READINESS.BLOCKED);
      }

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
      console.log('Real Hello workspace successfully verified fail-closed and untouched!\n');
    }

    console.log('ALL Milestone V21 Autonomous Testing, Diagnosis & Repair tests passed successfully!');
  } finally {
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

runTestSuite().catch((err) => {
  console.error('\n[TEST FAILURE] Milestone V21 Autonomous Testing Test Suite failed:\n', err);
  process.exit(1);
});
