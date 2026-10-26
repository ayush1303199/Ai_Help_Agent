import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const developerAgent = require('../electron/developerAgent.cjs');
const developerFiles = require('../electron/developerFiles.cjs');
const { isProjectRuntimeTestRequest } = require('../electron/coding-pipeline/projectRuntimeTestIntent.cjs');
const {
  PACKAGE_MANAGERS,
  discoverDependencies,
  createDependencyPlan,
  verifyInstalledDependencies,
} = require('../electron/coding-pipeline/dependencyManager.cjs');
const {
  BUILD_OPERATIONS,
  BUILD_OUTCOMES,
  discoverBuildOperations,
  createBuildPlan,
} = require('../electron/coding-pipeline/buildOrchestrator.cjs');

console.log('Starting Milestone V18 Project Workflow Verification Test Suite...');

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-v18-test-'));

try {
  // =========================================================================
  // Case 10: Informational questions remain explanatory
  // =========================================================================
  console.log('Case 10: Informational questions receive explanatory answers without triggering execution...');
  {
    assert.equal(isProjectRuntimeTestRequest('Explain how dependencies are installed in this project'), false);
    assert.equal(isProjectRuntimeTestRequest('What does npm test do?'), false);
    assert.equal(isProjectRuntimeTestRequest('Can you explain the project architecture?'), false);

    const infoProjectDir = path.join(testRoot, 'info-project');
    await fs.mkdir(infoProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(infoProjectDir, 'package.json'),
      JSON.stringify({ name: 'info-app', scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8'
    );

    const ownerId = 1810;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(infoProjectDir, ownerId);

    const explainResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'Explain how dependencies and tests are configured in this project',
      root: infoProjectDir,
      ownerWebContentsId: ownerId,
      sessionId,
    });

    assert.equal(explainResult.outcome, 'COMPLETED');
    assert.equal(explainResult.phase, 'EXPLAIN');
    assert.equal(explainResult.filesModified.length, 0);
    assert.equal(explainResult.codeApplied, false);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 9: Missing test scripts reported honestly as TEST_NOT_CONFIGURED
  // =========================================================================
  console.log('Case 9: Missing test scripts reported honestly as TEST_NOT_CONFIGURED...');
  {
    const noTestDir = path.join(testRoot, 'no-test-project');
    await fs.mkdir(noTestDir, { recursive: true });
    await fs.writeFile(
      path.join(noTestDir, 'package.json'),
      JSON.stringify({ name: 'no-test-app', scripts: { start: 'node index.js' } }),
      'utf8'
    );

    const ownerId = 1809;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(noTestDir, ownerId);

    const noTestResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: noTestDir,
      ownerWebContentsId: ownerId,
      sessionId,
    });

    assert.equal(noTestResult.outcome, 'TEST_NOT_CONFIGURED');
    assert.equal(noTestResult.phase, 'BUILD_PLAN');
    assert.equal(noTestResult.codeApplied, false);
    assert.ok(noTestResult.reason.includes('not declared or configured'));

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 1: `test the project` initiates project inspection and actionable test plan
  // =========================================================================
  console.log('Case 1: `test the project` initiates project inspection and actionable test plan...');
  {
    assert.equal(isProjectRuntimeTestRequest('test the project'), true);
    assert.equal(isProjectRuntimeTestRequest('run the tests'), true);

    const testAppDir = path.join(testRoot, 'test-app');
    await fs.mkdir(testAppDir, { recursive: true });
    await fs.writeFile(
      path.join(testAppDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        scripts: { test: 'node test.js' },
        dependencies: { chalk: '^4.1.2' },
      }),
      'utf8'
    );

    const ownerId = 1801;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(testAppDir, ownerId);

    // Dependencies are missing initially -> prerequisite gate blocks with structured advice
    const testResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: testAppDir,
      ownerWebContentsId: ownerId,
      sessionId,
    });

    assert.equal(testResult.outcome, 'BLOCKED');
    assert.equal(testResult.phase, 'DEPENDENCY_PREREQUISITE_GATE');
    assert.equal(testResult.executionBlocked, true);
    assert.ok(testResult.missingDependencies.length > 0);
    assert.ok(testResult.reason.includes('Dependencies (chalk) must be installed and verified'));

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 2: `install the dependencies` generates dependency install proposal
  // =========================================================================
  console.log('Case 2: `install the dependencies` generates dependency install proposal and enforces approval...');
  {
    assert.equal(isProjectRuntimeTestRequest('install the dependencies'), false);
    assert.equal(isProjectRuntimeTestRequest('install node_modules'), false);
    assert.equal(isProjectRuntimeTestRequest('install dependencies and run tests'), true);

    const depAppDir = path.join(testRoot, 'dep-app');
    await fs.mkdir(depAppDir, { recursive: true });
    await fs.writeFile(
      path.join(depAppDir, 'package.json'),
      JSON.stringify({
        name: 'dep-app',
        dependencies: { lodash: '^4.17.21' },
      }),
      'utf8'
    );

    const ownerId = 1802;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(depAppDir, ownerId);

    // A. Without pre-approval -> returns APPROVAL_REQUIRED with continuation
    let approvalRequested = false;
    const proposalResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install the dependencies',
      root: depAppDir,
      ownerWebContentsId: ownerId,
      sessionId,
      requestApproval: async (payload) => {
        approvalRequested = true;
        assert.ok(payload.taskId);
        assert.ok(payload.proposal);
        assert.ok(payload.diff.includes('Dependency Installation Plan'));
        return null; // Awaiting user decision
      },
    });

    assert.equal(approvalRequested, true);
    assert.equal(proposalResult.outcome, 'APPROVAL_REQUIRED');
    assert.equal(proposalResult.phase, 'APPROVE');
    assert.ok(proposalResult.continuationToken);
    assert.equal(proposalResult.filesModified.length, 0);
    assert.equal(proposalResult.codeApplied, false);

    // =======================================================================
    // Case 4: User rejection produces 0 mutations
    // =======================================================================
    console.log('Case 4: User rejection produces 0 project mutations...');
    const rejectResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install the dependencies',
      root: depAppDir,
      ownerWebContentsId: ownerId,
      sessionId,
      continuationToken: proposalResult.continuationToken,
      userApproved: false,
    });

    assert.equal(rejectResult.outcome, 'APPROVAL_REJECTED');
    assert.equal(rejectResult.phase, 'APPROVE');
    assert.equal(rejectResult.filesModified.length, 0);
    assert.equal(rejectResult.codeApplied, false);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 5: Missing isolation blocks execution fail-closed
  // =========================================================================
  console.log('Case 5: Missing isolation blocks execution fail-closed without host fallback...');
  {
    const isoDir = path.join(testRoot, 'iso-app');
    await fs.mkdir(isoDir, { recursive: true });
    await fs.writeFile(
      path.join(isoDir, 'package.json'),
      JSON.stringify({
        name: 'iso-app',
        dependencies: { express: '^4.18.2' },
      }),
      'utf8'
    );

    const ownerId = 1805;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(isoDir, ownerId);

    const isoResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install dependencies',
      root: isoDir,
      ownerWebContentsId: ownerId,
      sessionId,
      userApproved: true,
      containerRunner: null, // Host process isolation unverified on Windows
    });

    assert.equal(isoResult.outcome, 'BLOCKED');
    assert.equal(isoResult.phase, 'DEPENDENCY_INSTALL_GATE');
    assert.equal(isoResult.executionBlocked, true);
    assert.equal(isoResult.filesModified.length, 0);
    assert.equal(isoResult.codeApplied, false);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 3: `install dependencies and run tests` combined workflow
  // =========================================================================
  console.log('Case 3: `install dependencies and run tests` creates ordered combined plan...');
  {
    assert.equal(isProjectRuntimeTestRequest('install dependencies and run tests'), true);

    const combinedDir = path.join(testRoot, 'combined-app');
    await fs.mkdir(combinedDir, { recursive: true });
    await fs.writeFile(
      path.join(combinedDir, 'package.json'),
      JSON.stringify({
        name: 'combined-app',
        scripts: { test: 'node -e "process.exit(0)"' },
        dependencies: { mime: '^3.0.0' },
      }),
      'utf8'
    );

    const ownerId = 1803;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(combinedDir, ownerId);

    let combinedApprovalRequested = false;
    const combinedProposal = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install dependencies and run tests',
      root: combinedDir,
      ownerWebContentsId: ownerId,
      sessionId,
      requestApproval: async (payload) => {
        combinedApprovalRequested = true;
        assert.ok(payload.diff.includes('Dependency Installation Plan'));
        return null;
      },
    });

    assert.equal(combinedApprovalRequested, true);
    assert.equal(combinedProposal.outcome, 'APPROVAL_REQUIRED');
    assert.ok(combinedProposal.continuationToken);
    assert.ok(combinedProposal.taskPlan.buildPlan);
    assert.equal(combinedProposal.taskPlan.buildPlan.operation, BUILD_OPERATIONS.TEST);

    // Rejection on combined workflow preserves 0 mutations
    const combinedReject = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install dependencies and run tests',
      root: combinedDir,
      ownerWebContentsId: ownerId,
      sessionId,
      continuationToken: combinedProposal.continuationToken,
      userApproved: false,
    });
    assert.equal(combinedReject.outcome, 'APPROVAL_REJECTED');
    assert.equal(combinedReject.filesModified.length, 0);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 6 & 7: Verified Isolation execution, installation, verification, & test reporting
  // =========================================================================
  console.log('Case 6 & 7: Verified isolation execution, real installation verification, and exit code reporting...');
  {
    const e2eDir = path.join(testRoot, 'e2e-app');
    await fs.mkdir(e2eDir, { recursive: true });
    await fs.writeFile(
      path.join(e2eDir, 'package.json'),
      JSON.stringify({
        name: 'e2e-app',
        scripts: { test: 'node tests/sample.test.js' },
        dependencies: { debug: '^4.3.4' },
      }),
      'utf8'
    );

    const ownerId = 1806;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(e2eDir, ownerId);

    // Mock an isolated container runner that simulates container execution
    const mockContainerRunner = {
      execute: async ({ plan }) => {
        if (plan.command === 'npm' || plan.packageManager || plan.networkRequired) {
          // Simulate container writing installed package to container volume / disk
          await fs.mkdir(path.join(e2eDir, 'node_modules', 'debug'), { recursive: true });
          await fs.writeFile(
            path.join(e2eDir, 'node_modules', 'debug', 'package.json'),
            JSON.stringify({ name: 'debug', version: '4.3.4' }),
            'utf8'
          );
          const verification = await verifyInstalledDependencies(e2eDir);
          return {
            ok: true,
            status: 'SUCCESS',
            exitCode: 0,
            stdout: 'added 1 package in 100ms',
            stderr: '',
            dependencyVerification: verification,
          };
        }
        if (plan.operation === BUILD_OPERATIONS.TEST) {
          return {
            ok: true,
            status: 'SUCCESS',
            exitCode: 0,
            stdout: 'TAP version 13\n# ok 1 - sample test passes\n1..1',
            stderr: '',
          };
        }
        return { ok: true, exitCode: 0 };
      },
    };

    const combinedSuccess = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install dependencies and run tests',
      root: e2eDir,
      ownerWebContentsId: ownerId,
      sessionId,
      userApproved: true,
      containerRunner: mockContainerRunner,
    });

    assert.equal(combinedSuccess.outcome, 'COMPLETED');
    assert.equal(combinedSuccess.phase, 'BUILD_VERIFICATION');
    assert.equal(combinedSuccess.status, 'TESTS_PASSED');
    assert.equal(combinedSuccess.codeVerified, true);
    assert.equal(combinedSuccess.buildResult.exitCode, 0);
    assert.ok(combinedSuccess.buildResult.stdout.includes('sample test passes'));

    // Verify dependencies actually exist on disk now
    const diskVerification = await verifyInstalledDependencies(e2eDir);
    assert.equal(diskVerification.isFullyInstalled, true);
    assert.equal(diskVerification.missingCount, 0);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 8: Failed test execution triggers investigation diagnosis
  // =========================================================================
  console.log('Case 8: Failed test execution triggers failure diagnosis...');
  {
    const failDir = path.join(testRoot, 'fail-app');
    await fs.mkdir(failDir, { recursive: true });
    await fs.writeFile(
      path.join(failDir, 'package.json'),
      JSON.stringify({
        name: 'fail-app',
        scripts: { test: 'node tests/failing.test.js' },
      }),
      'utf8'
    );

    const ownerId = 1808;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(failDir, ownerId);

    const mockFailingContainerRunner = {
      execute: async ({ plan }) => {
        return {
          ok: false,
          status: 'FAILED',
          exitCode: 1,
          stdout: '',
          stderr: 'AssertionError: expected 200 OK but received 500 Internal Server Error at tests/failing.test.js:14:5',
        };
      },
    };

    const testFailResult = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: failDir,
      ownerWebContentsId: ownerId,
      sessionId,
      containerRunner: mockFailingContainerRunner,
    });

    assert.equal(testFailResult.outcome, 'TESTS_FAILED');
    assert.equal(testFailResult.phase, 'BUILD_EXECUTE');
    assert.equal(testFailResult.codeVerified, false);
    assert.equal(testFailResult.buildResult.exitCode, 1);
    assert.ok(testFailResult.diagnosis);
    assert.ok(testFailResult.buildResult.stderr.includes('AssertionError'));

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
  }

  // =========================================================================
  // Case 11: Real Hello workspace verification
  // =========================================================================
  console.log('Case 11: Real Hello workspace verification (C:\\Users\\Admin\\Downloads\\Hello)...');
  const helloRoot = 'C:\\Users\\Admin\\Downloads\\Hello';
  const helloExists = await fs.stat(helloRoot).then(() => true).catch(() => false);
  if (helloExists) {
    const ownerId = 1811;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(helloRoot, ownerId);

    // 11a. Hello has package.json with react, react-dom and missing node_modules
    const helloDepReport = await discoverDependencies(helloRoot);
    assert.equal(Boolean(helloDepReport.primaryReport?.hasManifest), true);
    assert.equal(helloDepReport.needsInstallation, true);
    assert.ok(helloDepReport.missingDependencies.some((d) => d.name === 'react'));

    // 11b. `test the project` on Hello identifies missing dependencies in workspace audit or prerequisite gate
    const helloTestBlock = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      root: helloRoot,
      ownerWebContentsId: ownerId,
      sessionId,
    });
    assert.ok(['SUCCESS', 'COMPLETED', 'BLOCKED'].includes(helloTestBlock.outcome));
    assert.ok(
      (helloTestBlock.message && helloTestBlock.message.includes('Missing node_modules directory'))
      || (helloTestBlock.reason && helloTestBlock.reason.includes('Dependencies'))
    );

    // 11c. `install the dependencies` on Hello generates reproducible plan proposal
    const helloInstallPlan = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install the dependencies',
      root: helloRoot,
      ownerWebContentsId: ownerId,
      sessionId,
      requestApproval: async (payload) => {
        assert.ok(payload.diff.includes('react'));
        assert.ok(payload.diff.includes('react-dom'));
        return null;
      },
    });
    assert.equal(helloInstallPlan.outcome, 'APPROVAL_REQUIRED');
    assert.ok(helloInstallPlan.continuationToken);

    // 11d. `install dependencies and run tests` on Hello generates combined proposal
    const helloCombinedPlan = await developerAgent.executeAutonomousCodingWorkflow({
      userRequest: 'install dependencies and run tests',
      root: helloRoot,
      ownerWebContentsId: ownerId,
      sessionId,
      requestApproval: async (payload) => {
        assert.ok(payload.diff.includes('Dependency Installation Plan'));
        return null;
      },
    });
    assert.equal(helloCombinedPlan.outcome, 'APPROVAL_REQUIRED');
    assert.ok(helloCombinedPlan.continuationToken);

    developerAgent.releaseSession(ownerId);
    developerFiles.releaseProject(ownerId);
    console.log('Real Hello workspace successfully verified!');
  }

  console.log('ALL Milestone V18 Project Workflow Verification tests passed successfully!');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
