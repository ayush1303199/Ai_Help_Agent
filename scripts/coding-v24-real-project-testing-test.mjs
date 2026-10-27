/**
 * Milestone V24 Real Project Testing & Execution Readiness Test Suite.
 *
 * Verifies:
 * 1. Missing dependencies: halts at prerequisite gate; dependencies listed from evidence.
 * 2. Missing test scripts: reported honestly as NOT_CONFIGURED under ACTUAL_PROJECT_TEST.
 * 3. Test command failure: captured with non-zero exit code, stderr diagnostics, and ACTUAL_PROJECT_TEST category.
 * 4. Build command failure: captured with non-zero exit code and ACTUAL_BUILD category.
 * 5. Isolation unavailable: fail-closed BLOCKED_ISOLATION; no host fallback execution.
 * 6. Synthetic tests passing while actual tests remain unexecuted: honest evidence distinction.
 * 7. Actual tests passing: captured with real exit code 0 and container isolation evidence.
 * 8. Application startup failure: ACTUAL_APPLICATION_RUNTIME failure captured and cleaned up.
 * 9. Honest final status reporting across all 6 test execution categories.
 *
 * All mocked tests are explicitly labeled as: [CONTROLLED_FIXTURE_MOCK]
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

const {
  TEST_EXECUTION_CATEGORIES,
  TEST_EXECUTION_STATUSES,
  EVIDENCE_SOURCES,
  validateTestExecutionRecord,
  createTestExecutionRecord,
  evaluateProjectTestReadiness,
  buildEngineeringReport,
  BUILD_OPERATIONS,
  CHECK_STATES,
  PROJECT_READINESS,
} = developerAgent;

async function runTestSuite() {
  console.log('Starting Milestone V24 Real Project Testing & Execution Readiness Test Suite...\n');
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'v24-testing-readiness-'));

  try {
    // =========================================================================
    // Case 1: Missing Dependencies Prerequisite Gate
    // =========================================================================
    console.log('Case 1: Missing dependencies detected from manifest; prerequisite gate enforced...');
    {
      const caseDir = path.join(testRoot, 'case1-missing-deps');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'package.json'),
        JSON.stringify({
          name: 'case1-missing-deps',
          scripts: { test: 'node test.js' },
          dependencies: { express: '^4.18.2', redis: '^4.6.7' },
        }),
        'utf8'
      );

      const ownerId = 2401;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(caseDir, ownerId);

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: caseDir,
        ownerWebContentsId: ownerId,
        sessionId,
      });

      assert.equal(result.outcome, 'BLOCKED');
      assert.equal(result.phase, 'DEPENDENCY_PREREQUISITE_GATE');
      assert.equal(result.executionBlocked, true);
      assert.ok(result.missingDependencies.length >= 2);
      assert.ok(result.reason.includes('express'));

      const readiness = evaluateProjectTestReadiness({
        projectRoot: caseDir,
        buildDiscovery: await developerAgent.discoverBuildOperations(caseDir),
        dependencyReport: await developerAgent.discoverDependencies(caseDir),
        isolationStatus: { available: false, verified: false, reason: 'Docker daemon offline' },
      });
      assert.equal(readiness.overallStatus, 'PREREQUISITES_MISSING');
      assert.equal(readiness.dependencies.satisfied, false);
      assert.equal(readiness.operations.TEST.category, TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST);
      assert.equal(readiness.operations.TEST.status, TEST_EXECUTION_STATUSES.PREREQUISITES_MISSING);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 2: Missing Test Scripts
    // =========================================================================
    console.log('Case 2: Missing test scripts reported honestly as NOT_CONFIGURED...');
    {
      const caseDir = path.join(testRoot, 'case2-no-test-script');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'package.json'),
        JSON.stringify({
          name: 'case2-no-test-script',
          scripts: { build: 'tsc --build' },
        }),
        'utf8'
      );

      const ownerId = 2402;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(caseDir, ownerId);

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: caseDir,
        ownerWebContentsId: ownerId,
        sessionId,
      });

      assert.equal(result.outcome, 'TEST_NOT_CONFIGURED');
      assert.equal(result.phase, 'BUILD_PLAN');
      assert.equal(result.executionBlocked, true);

      assert.ok(result.engineeringReport);
      const testClassification = result.engineeringReport.verificationSummary.testClassifications.find(
        (c) => c.category === TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST
      );
      assert.ok(testClassification, 'Expected ACTUAL_PROJECT_TEST classification record');
      assert.equal(testClassification.status, TEST_EXECUTION_STATUSES.NOT_CONFIGURED);
      assert.equal(testClassification.evidenceSource, EVIDENCE_SOURCES.MANIFEST_DISCOVERY);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 3: Test Command Failure
    // =========================================================================
    console.log('Case 3: Test command failure captured with exit code and diagnostics [CONTROLLED_FIXTURE_MOCK]...');
    {
      const caseDir = path.join(testRoot, 'case3-test-failure');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'package.json'),
        JSON.stringify({
          name: 'case3-test-failure',
          scripts: { test: 'jest' },
        }),
        'utf8'
      );

      const ownerId = 2403;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(caseDir, ownerId);

      const mockFailingRunner = {
        execute: async () => ({
          ok: false,
          status: 'FAILED',
          exitCode: 2,
          stdout: 'FAIL test/suite.spec.js\n  ✕ 3 of 10 tests failed',
          stderr: 'AssertionError: expected status 200 but received 404',
          elapsedMs: 250,
        }),
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: caseDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockFailingRunner,
      });

      assert.equal(result.outcome, 'TESTS_FAILED');
      assert.ok(result.diagnosis);
      assert.equal(result.codeVerified, false);

      const record = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST,
        status: TEST_EXECUTION_STATUSES.FAILED,
        evidenceSource: EVIDENCE_SOURCES.CONTAINER_EXECUTION,
        command: 'npm test',
        exitCode: 2,
        stderrSummary: 'AssertionError: expected status 200 but received 404',
      });
      assert.equal(record.status, 'FAILED');
      assert.equal(record.exitCode, 2);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 4: Build Command Failure
    // =========================================================================
    console.log('Case 4: Build command failure captured with exit code [CONTROLLED_FIXTURE_MOCK]...');
    {
      const caseDir = path.join(testRoot, 'case4-build-failure');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'package.json'),
        JSON.stringify({
          name: 'case4-build-failure',
          scripts: { build: 'vite build' },
        }),
        'utf8'
      );

      const ownerId = 2404;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(caseDir, ownerId);

      const mockFailingBuildRunner = {
        execute: async ({ plan }) => {
          assert.equal(plan.operation, 'BUILD');
          return {
            ok: false,
            status: 'FAILED',
            exitCode: 1,
            stdout: 'vite v5.0.0 building for production...',
            stderr: 'RollupError: Could not resolve entry module "src/main.ts"',
            elapsedMs: 400,
          };
        },
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'build the project',
        root: caseDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockFailingBuildRunner,
      });

      assert.equal(result.outcome, 'FAILED');
      assert.equal(result.phase, 'BUILD_EXECUTE');
      assert.equal(result.buildResult.exitCode, 1);
      assert.ok(result.buildResult.stderr.includes('RollupError'));

      // Validate integrity: ACTUAL_BUILD cannot be PASSED if build failed
      assert.throws(() => {
        validateTestExecutionRecord({
          category: TEST_EXECUTION_CATEGORIES.ACTUAL_BUILD,
          status: TEST_EXECUTION_STATUSES.PASSED,
          evidenceSource: EVIDENCE_SOURCES.STATIC_INSPECTION,
          exitCode: 1,
        });
      }, /Integrity violation/);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 5: Isolation Unavailable (Fail-Closed)
    // =========================================================================
    console.log('Case 5: Isolation unavailable enforces BLOCKED_ISOLATION without host fallback...');
    {
      const caseDir = path.join(testRoot, 'case5-isolation-unavailable');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'package.json'),
        JSON.stringify({
          name: 'case5-isolation-unavailable',
          scripts: { test: 'node test.js' },
        }),
        'utf8'
      );

      const ownerId = 2405;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(caseDir, ownerId);

      const blockedContainerRunner = {
        execute: async () => ({
          ok: false,
          executionBlocked: true,
          status: 'BLOCKED',
          reason: 'Container provider daemon is unavailable: verified Windows process isolation is required.',
        }),
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: caseDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: blockedContainerRunner,
      });

      assert.equal(result.outcome, 'BLOCKED');
      assert.equal(result.phase, 'BUILD_EXECUTION_GATE');
      assert.equal(result.executionBlocked, true);
      assert.ok(result.reason.includes('isolation is required'));

      const testClassification = result.engineeringReport.verificationSummary.testClassifications.find(
        (c) => c.category === TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST
      );
      assert.ok(testClassification);
      assert.equal(testClassification.status, TEST_EXECUTION_STATUSES.BLOCKED_ISOLATION);
      assert.equal(testClassification.evidenceSource, EVIDENCE_SOURCES.ISOLATION_GATE);
      assert.equal(testClassification.exitCode, null);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 6: Synthetic Tests Passing while Actual Tests Remain Unexecuted
    // =========================================================================
    console.log('Case 6: Synthetic tests passing while actual tests remain unexecuted; honest distinction...');
    {
      // Simulate synthetic test pass
      const syntheticRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.SYNTHETIC_TEST,
        status: TEST_EXECUTION_STATUSES.PASSED,
        evidenceSource: EVIDENCE_SOURCES.SYNTHETIC_HARNESS,
        command: null,
        exitCode: 0,
        details: { passedCases: 9, totalCases: 9 },
      });

      // Actual test not run
      const actualTestRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST,
        status: TEST_EXECUTION_STATUSES.NOT_RUN,
        evidenceSource: EVIDENCE_SOURCES.MANIFEST_DISCOVERY,
        command: 'npm test',
        exitCode: null,
        stderrSummary: 'Actual project test was not executed in isolated container.',
      });

      // Actual build not run
      const actualBuildRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.ACTUAL_BUILD,
        status: TEST_EXECUTION_STATUSES.NOT_RUN,
        evidenceSource: EVIDENCE_SOURCES.MANIFEST_DISCOVERY,
        command: 'npm run build',
        exitCode: null,
      });

      const report = buildEngineeringReport({
        projectRoot: path.join(testRoot, 'case6-synthetic'),
        testClassifications: [syntheticRecord, actualTestRecord, actualBuildRecord],
        overallOutcome: 'COMPLETED',
      });

      assert.equal(report.verificationSummary.syntheticTests, true);
      assert.equal(report.verificationSummary.actualProjectTests, true);
      assert.equal(report.verificationSummary.actualBuilds, true);

      // Verify that actual tests are NOT reported as real execution
      assert.equal(report.verificationSummary.realExecution, false);

      // Verify classification level logic
      const evidenceLevel = developerAgent.classifyVerificationEvidenceLevel({
        isPassing: true,
        testOutcome: { status: 'PASS', attempts: [{ check: 'synthetic_modular', synthetic: true }] },
        finalEvidence: [{ executed: true, exitCode: 0, provenance: 'SYNTHETIC' }],
        hermeticVerification: { passed: 9, total: 9 },
        hostExecution: { status: 'SKIPPED_ISOLATION_UNAVAILABLE' },
      });

      // Must be PASSED_SYNTHETIC_TESTS, NEVER PASSED_REAL_EXECUTION
      assert.equal(evidenceLevel, developerAgent.VERIFICATION_EVIDENCE_LEVELS.PASSED_SYNTHETIC_TESTS);
      assert.notEqual(evidenceLevel, developerAgent.VERIFICATION_EVIDENCE_LEVELS.PASSED_REAL_EXECUTION);
    }

    // =========================================================================
    // Case 7: Actual Tests Passing with Captured Exit Code
    // =========================================================================
    console.log('Case 7: Actual tests passing captured with exit code 0 and container isolation [CONTROLLED_FIXTURE_MOCK]...');
    {
      const caseDir = path.join(testRoot, 'case7-pass-app');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'package.json'),
        JSON.stringify({
          name: 'case7-pass-app',
          scripts: { test: 'node tests/suite.js' },
        }),
        'utf8'
      );

      const ownerId = 2407;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(caseDir, ownerId);

      const mockPassingRunner = {
        execute: async ({ plan }) => {
          assert.equal(plan.operation, 'TEST');
          return {
            ok: true,
            status: 'PASSED',
            exitCode: 0,
            stdout: 'PASS tests/suite.js\n  12 tests passed (45ms)',
            stderr: '',
            elapsedMs: 65,
          };
        },
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: caseDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockPassingRunner,
      });

      assert.equal(result.outcome, 'COMPLETED');
      assert.equal(result.status, 'TESTS_PASSED');
      assert.equal(result.codeVerified, true);
      assert.equal(result.buildResult.exitCode, 0);
      assert.ok(result.buildResult.stdout.includes('12 tests passed'));

      const testRecord = result.engineeringReport.verificationSummary.testClassifications.find(
        (c) => c.category === TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST
      );
      assert.ok(testRecord);
      assert.equal(testRecord.status, TEST_EXECUTION_STATUSES.PASSED);
      assert.equal(testRecord.evidenceSource, EVIDENCE_SOURCES.CONTAINER_EXECUTION);
      assert.equal(testRecord.exitCode, 0);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 8: Application Startup Failure
    // =========================================================================
    console.log('Case 8: Application startup failure captured and cleaned up [CONTROLLED_FIXTURE_MOCK]...');
    {
      const caseDir = path.join(testRoot, 'case8-startup-fail');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'package.json'),
        JSON.stringify({
          name: 'case8-startup-fail',
          scripts: { start: 'node server.js' },
        }),
        'utf8'
      );

      const ownerId = 2408;
      const sessionId = crypto.randomUUID();
      await developerFiles.attachProject(caseDir, ownerId);

      let cleanedUp = false;
      const mockCrashingStartupRunner = {
        execute: async ({ plan, isApplicationRuntime }) => {
          assert.equal(plan.operation, 'START');
          assert.equal(isApplicationRuntime, true);
          // Simulate container startup crash and guaranteed cleanup
          cleanedUp = true;
          return {
            ok: false,
            status: 'FAILED',
            exitCode: 1,
            stdout: 'Starting application server...\n',
            stderr: 'Error: EADDRINUSE: Address already in use :::3000\n    at Server.setupListenHandle',
            elapsedMs: 120,
            cleanedUp: true,
          };
        },
      };

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'start the app',
        root: caseDir,
        ownerWebContentsId: ownerId,
        sessionId,
        containerRunner: mockCrashingStartupRunner,
      });

      assert.equal(cleanedUp, true, 'Expected container runner cleanup');
      assert.equal(result.outcome, 'FAILED');
      assert.equal(result.phase, 'APPLICATION_STARTUP_FAILED');
      assert.equal(result.buildResult.exitCode, 1);
      assert.ok(result.buildResult.stderr.includes('EADDRINUSE'));

      const startupRecord = result.testClassifications.find(
        (c) => c.category === TEST_EXECUTION_CATEGORIES.ACTUAL_APPLICATION_RUNTIME
      );
      assert.ok(startupRecord);
      assert.equal(startupRecord.status, TEST_EXECUTION_STATUSES.FAILED);
      assert.equal(startupRecord.evidenceSource, EVIDENCE_SOURCES.CONTAINER_EXECUTION);
      assert.equal(startupRecord.exitCode, 1);

      developerAgent.releaseSession(ownerId);
      developerFiles.releaseProject(ownerId);
    }

    // =========================================================================
    // Case 9: Honest Final Status Reporting Across All 6 Categories
    // =========================================================================
    console.log('Case 9: Honest final status reporting across all 6 test execution categories...');
    {
      const staticRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.STATIC_ANALYSIS,
        status: TEST_EXECUTION_STATUSES.PASSED,
        evidenceSource: EVIDENCE_SOURCES.AST_ANALYSIS,
        details: 'AST data-flow syntax verification passed',
      });

      const syntheticRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.SYNTHETIC_TEST,
        status: TEST_EXECUTION_STATUSES.PASSED,
        evidenceSource: EVIDENCE_SOURCES.SYNTHETIC_HARNESS,
        details: 'Mock harness contract check passed',
      });

      const inProcessRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.IN_PROCESS_RUNTIME_TEST,
        status: TEST_EXECUTION_STATUSES.PASSED,
        evidenceSource: EVIDENCE_SOURCES.IN_PROCESS_LOOPBACK,
        details: 'In-process HTTP loopback endpoint probe passed',
      });

      const actualTestRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST,
        status: TEST_EXECUTION_STATUSES.BLOCKED_ISOLATION,
        evidenceSource: EVIDENCE_SOURCES.ISOLATION_GATE,
        command: 'npm test',
        exitCode: null,
        stderrSummary: 'Process isolation unavailable',
      });

      const actualBuildRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.ACTUAL_BUILD,
        status: TEST_EXECUTION_STATUSES.NOT_RUN,
        evidenceSource: EVIDENCE_SOURCES.MANIFEST_DISCOVERY,
        command: 'npm run build',
        exitCode: null,
      });

      const actualAppRecord = createTestExecutionRecord({
        category: TEST_EXECUTION_CATEGORIES.ACTUAL_APPLICATION_RUNTIME,
        status: TEST_EXECUTION_STATUSES.NOT_RUN,
        evidenceSource: EVIDENCE_SOURCES.MANIFEST_DISCOVERY,
        command: 'npm start',
        exitCode: null,
      });

      const allRecords = [
        staticRecord,
        syntheticRecord,
        inProcessRecord,
        actualTestRecord,
        actualBuildRecord,
        actualAppRecord,
      ];

      // Verify all 6 records pass strict schema validation
      for (const r of allRecords) {
        assert.equal(validateTestExecutionRecord(r), true);
      }

      const report = buildEngineeringReport({
        projectRoot: path.join(testRoot, 'case9-honest'),
        testClassifications: allRecords,
        overallOutcome: 'BLOCKED',
        blockers: ['Host command execution blocked by unverified process isolation.'],
      });

      assert.ok(report.markdownSummary.includes('### 4b. Test Execution Classification (V24 Standard)'));
      assert.ok(report.markdownSummary.includes('**[STATIC_ANALYSIS]** PASSED'));
      assert.ok(report.markdownSummary.includes('**[SYNTHETIC_TEST]** PASSED'));
      assert.ok(report.markdownSummary.includes('**[IN_PROCESS_RUNTIME_TEST]** PASSED'));
      assert.ok(report.markdownSummary.includes('**[ACTUAL_PROJECT_TEST]** BLOCKED_ISOLATION'));
      assert.ok(report.markdownSummary.includes('**[ACTUAL_BUILD]** NOT_RUN'));
      assert.ok(report.markdownSummary.includes('**[ACTUAL_APPLICATION_RUNTIME]** NOT_RUN'));

      assert.equal(report.verificationSummary.staticAnalysis, true);
      assert.equal(report.verificationSummary.syntheticTests, true);
      assert.equal(report.verificationSummary.inProcessTests, true);
      assert.equal(report.verificationSummary.actualProjectTests, true);
      assert.equal(report.verificationSummary.actualBuilds, true);
      assert.equal(report.verificationSummary.actualApplicationRuntime, true);

      // Real execution must be false because no real container execution occurred
      assert.equal(report.verificationSummary.realExecution, false);
      assert.equal(report.overallReadiness, PROJECT_READINESS.BLOCKED);
    }

    console.log('\nAll Milestone V24 Regression Tests Passed Successfully (9/9).');
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  }
}

runTestSuite().catch((err) => {
  console.error('\nV24 Test Suite Failure:', err);
  process.exit(1);
});
