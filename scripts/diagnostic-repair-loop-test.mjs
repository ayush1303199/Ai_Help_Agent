import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  DIAGNOSTIC_STATUSES,
  FAILURE_CATEGORIES,
  VERIFICATION_TIERS,
  redactSensitiveData,
  extractDiagnosticDetails,
  diagnoseFailure,
  MAX_REPAIR_ATTEMPTS,
  REPAIR_PLAN_STATUSES,
  createDiffPreview,
  createRepairPlan,
  executeRepairCycle,
  executeAutonomousCodingWorkflow,
} = require('../electron/developerAgent.cjs');

const developerFiles = require('../electron/developerFiles.cjs');

async function makeTempDir(prefix = 'v4-repair-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runTests() {
  console.log('Starting Evidence-Based Self-Diagnosis & Safe Repair Loop regression tests (V4)...');

  // -------------------------------------------------------------------------
  // Test 1: Secret redaction in diagnostics
  // -------------------------------------------------------------------------
  console.log('Testing secret redaction from diagnostics and logs...');
  {
    const sensitiveStderr = `
      Error: Failed request.
      Authorization: Bearer my-secret-jwt-token-12345
      Database password: password="super-secret-password"
      API_KEY: token=ghp_123456789012345678901234567890123456
      Slack: xoxb-1234567890-123456789012-abcdef123456
    `;
    const redacted = redactSensitiveData(sensitiveStderr);
    assert.doesNotMatch(redacted, /my-secret-jwt-token-12345/);
    assert.doesNotMatch(redacted, /super-secret-password/);
    assert.doesNotMatch(redacted, /ghp_123456789012345678901234567890123456/);
    assert.doesNotMatch(redacted, /xoxb-1234567890-123456789012-abcdef123456/);
    assert.match(redacted, /\[redacted/i);
  }

  // -------------------------------------------------------------------------
  // Test 2: Confirmed diagnosis from clear compiler / syntax error
  // -------------------------------------------------------------------------
  console.log('Testing confirmed diagnosis from observable compiler/syntax error...');
  {
    const evidence = {
      status: 'FAILED',
      exitCode: 1,
      stderr: 'src/calculator.ts:42:15 - error TS2322: Type "string" is not assignable to type "number".',
      stdout: '',
    };
    const diagnosis = diagnoseFailure(evidence, { projectRoot: '/test/repo' });
    assert.equal(diagnosis.status, DIAGNOSTIC_STATUSES.CONFIRMED);
    assert.equal(diagnosis.failureCategory, FAILURE_CATEGORIES.TYPE_ERROR);
    assert.equal(diagnosis.confidence, 'HIGH');
    assert.equal(diagnosis.primaryLocation?.file, 'src/calculator.ts');
    assert.equal(diagnosis.primaryLocation?.line, 42);
    assert.deepEqual(diagnosis.affectedFiles, ['src/calculator.ts']);
  }

  // -------------------------------------------------------------------------
  // Test 3: Uncertain diagnosis when evidence is incomplete
  // -------------------------------------------------------------------------
  console.log('Testing uncertain diagnosis when output is incomplete or empty...');
  {
    const emptyEvidence = {
      status: 'FAILED',
      exitCode: 137,
      stderr: '',
      stdout: '',
    };
    const emptyDiagnosis = diagnoseFailure(emptyEvidence);
    assert.equal(emptyDiagnosis.status, DIAGNOSTIC_STATUSES.INSUFFICIENT_EVIDENCE);
    assert.equal(emptyDiagnosis.confidence, 'LOW');
    assert.ok(emptyDiagnosis.limitations.length > 0);

    // Output with error but no stack frames
    const vagueEvidence = {
      status: 'FAILED',
      exitCode: 1,
      stderr: 'Build process failed unexpectedly.',
      stdout: '',
    };
    const vagueDiagnosis = diagnoseFailure(vagueEvidence);
    assert.equal(vagueDiagnosis.status, DIAGNOSTIC_STATUSES.LIKELY);
    assert.equal(vagueDiagnosis.confidence, 'LOW');
    assert.equal(vagueDiagnosis.primaryLocation, null);
  }

  // -------------------------------------------------------------------------
  // Test 4: Assertion failure indicates observation site without premature confirmation
  // -------------------------------------------------------------------------
  console.log('Testing assertion failure calibration (site is evidence, not confirmed root cause)...');
  {
    const assertionEvidence = {
      status: 'FAILED',
      exitCode: 1,
      stderr: `
        AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
        + actual - expected
        + 404
        - 200
        at file:///app/tests/auth.test.ts:35:12
      `,
    };
    const diagnosis = diagnoseFailure(assertionEvidence);
    assert.equal(diagnosis.status, DIAGNOSTIC_STATUSES.LIKELY);
    assert.equal(diagnosis.failureCategory, FAILURE_CATEGORIES.ASSERTION_FAILURE);
    assert.equal(diagnosis.confidence, 'MEDIUM');
    assert.ok(/assertion site indicates where the failure was observed/i.test(diagnosis.rootCause));
    assert.ok(diagnosis.proposedChecks.length > 0);
  }

  // -------------------------------------------------------------------------
  // Test 5: Process isolation gate blocks diagnosis safely
  // -------------------------------------------------------------------------
  console.log('Testing process isolation gate failure diagnosis...');
  {
    const gateEvidence = {
      status: 'BLOCKED',
      gate: 'PROCESS_ISOLATION_GATE',
      reason: 'Build execution is blocked: verified Windows process isolation is required.',
      executionBlocked: true,
    };
    const diagnosis = diagnoseFailure(gateEvidence);
    assert.equal(diagnosis.status, DIAGNOSTIC_STATUSES.BLOCKED);
    assert.equal(diagnosis.failureCategory, FAILURE_CATEGORIES.PROCESS_ISOLATION_BLOCKED);
    assert.equal(diagnosis.confidence, 'HIGH');
    assert.ok(diagnosis.limitations.some((l) => l.includes('sandbox')));
  }

  // -------------------------------------------------------------------------
  // Test 6: Missing dependency diagnosis
  // -------------------------------------------------------------------------
  console.log('Testing missing dependency diagnosis...');
  {
    const depEvidence = {
      status: 'BLOCKED',
      gate: 'DEPENDENCY_PREREQUISITE_GATE',
      missingDependencies: [{ name: 'express' }, { name: 'cors' }],
    };
    const diagnosis = diagnoseFailure(depEvidence);
    assert.equal(diagnosis.status, DIAGNOSTIC_STATUSES.CONFIRMED);
    assert.equal(diagnosis.failureCategory, FAILURE_CATEGORIES.MISSING_DEPENDENCY);
    assert.ok(diagnosis.rootCause.includes('express'));
    assert.ok(diagnosis.rootCause.includes('cors'));
  }

  // -------------------------------------------------------------------------
  // Test 7: Minimal repair plan creation and scope containment
  // -------------------------------------------------------------------------
  console.log('Testing minimal repair planning and scope containment...');
  {
    const dir = await makeTempDir();
    const targetFile = 'src/math.ts';
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, targetFile), 'export function add(a: number, b: string) {\n  return a + b;\n}\n');

    const diagnosis = {
      diagnosisId: 'diag-math-1',
      status: DIAGNOSTIC_STATUSES.CONFIRMED,
      failureCategory: FAILURE_CATEGORIES.TYPE_ERROR,
      rootCause: 'Type error: b should be number',
      affectedFiles: [targetFile],
      primaryLocation: { file: targetFile, line: 1 },
      attemptNumber: 1,
    };

    const plan = await createRepairPlan({
      diagnosis,
      projectRoot: dir,
      customPatchGenerator: async ({ originalContent }) => ({
        replacementContent: originalContent.replace('b: string', 'b: number'),
        rationale: 'Correct parameter type from string to number',
      }),
    });

    assert.equal(plan.status, REPAIR_PLAN_STATUSES.READY);
    assert.equal(plan.affectedFiles.length, 1);
    assert.equal(plan.affectedFiles[0], targetFile);
    assert.ok(plan.planDigest && plan.planDigest.length === 64);
    assert.ok(plan.fileChanges[0].diffPreview.includes('-export function add(a: number, b: string)'));
    assert.ok(plan.fileChanges[0].diffPreview.includes('+export function add(a: number, b: number)'));
    assert.ok(plan.rollbackInfo.snapshots[targetFile]);

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 8: Loop detection - rejection of duplicate ineffective patch
  // -------------------------------------------------------------------------
  console.log('Testing loop detection (rejecting repeated identical patch)...');
  {
    const dir = await makeTempDir();
    const targetFile = 'src/bug.ts';
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, targetFile), 'const x = 1;\n');

    const diagnosis = {
      diagnosisId: 'diag-bug-1',
      status: DIAGNOSTIC_STATUSES.CONFIRMED,
      failureCategory: FAILURE_CATEGORIES.SYNTAX_ERROR,
      rootCause: 'Missing semicolon or syntax error',
      affectedFiles: [targetFile],
      primaryLocation: { file: targetFile, line: 1 },
      attemptNumber: 2,
    };

    const firstPlan = await createRepairPlan({
      diagnosis,
      projectRoot: dir,
      customPatchGenerator: async ({ originalContent }) => ({
        replacementContent: originalContent + 'const y = 2;\n',
      }),
    });
    assert.equal(firstPlan.status, REPAIR_PLAN_STATUSES.READY);

    // Second attempt produces same patch -> must ABSTAIN to prevent loop
    const secondPlan = await createRepairPlan({
      diagnosis,
      projectRoot: dir,
      previousPlans: [firstPlan],
      customPatchGenerator: async ({ originalContent }) => ({
        replacementContent: originalContent + 'const y = 2;\n',
      }),
    });
    assert.equal(secondPlan.status, REPAIR_PLAN_STATUSES.ABSTAINED);
    assert.ok(secondPlan.reason.includes('Identical repair patch was already attempted'));

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 9: Strict maximum 3 repair attempts termination
  // -------------------------------------------------------------------------
  console.log('Testing termination at maximum 3 repair attempts...');
  {
    const dir = await makeTempDir();
    const diagnosis = {
      diagnosisId: 'diag-limit-1',
      status: DIAGNOSTIC_STATUSES.CONFIRMED,
      failureCategory: FAILURE_CATEGORIES.TYPE_ERROR,
      rootCause: 'Persistent defect',
      affectedFiles: ['src/index.ts'],
      attemptNumber: 4, // 4 > MAX_REPAIR_ATTEMPTS (3)
    };

    const plan = await createRepairPlan({
      diagnosis,
      projectRoot: dir,
    });
    assert.equal(plan.status, REPAIR_PLAN_STATUSES.UNRESOLVABLE);
    assert.ok(plan.reason.includes(`Maximum repair attempts (${MAX_REPAIR_ATTEMPTS}) reached`));

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 10: Approval required before mutation & denied approval causes no mutation
  // -------------------------------------------------------------------------
  console.log('Testing approval gate enforcement and denial with zero file mutation...');
  {
    const dir = await makeTempDir();
    const targetFile = 'src/service.ts';
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    const initialCode = 'export const service = "v1";\n';
    await fs.writeFile(path.join(dir, targetFile), initialCode);

    const ownerId = 101;
    await developerFiles.attachProject(dir, ownerId);

    const diagnosis = {
      diagnosisId: 'diag-service-1',
      status: DIAGNOSTIC_STATUSES.CONFIRMED,
      failureCategory: FAILURE_CATEGORIES.SYNTAX_ERROR,
      rootCause: 'Upgrade service',
      affectedFiles: [targetFile],
      primaryLocation: { file: targetFile, line: 1 },
      attemptNumber: 1,
    };

    const plan = await createRepairPlan({
      diagnosis,
      projectRoot: dir,
      customPatchGenerator: async () => ({
        replacementContent: 'export const service = "v2";\n',
      }),
    });

    // 10a. User denies approval -> zero file mutation
    const deniedResult = await executeRepairCycle({
      repairPlan: plan,
      projectRoot: dir,
      ownerWebContentsId: ownerId,
      approve: async () => false, // User denies
    });
    assert.equal(deniedResult.ok, false);
    assert.equal(deniedResult.outcome, 'APPROVAL_REQUIRED');
    assert.equal(deniedResult.codeApplied, false);

    // Check disk content is unchanged
    const diskContentAfterDeny = await fs.readFile(path.join(dir, targetFile), 'utf8');
    assert.equal(diskContentAfterDeny, initialCode);

    // 10b. Pre-apply drift detection (if disk changed behind our back)
    await fs.writeFile(path.join(dir, targetFile), 'export const service = "modified-by-external";\n');
    const driftResult = await executeRepairCycle({
      repairPlan: plan,
      projectRoot: dir,
      ownerWebContentsId: ownerId,
      approve: async () => true, // User approves, but file drifted
    });
    assert.equal(driftResult.ok, false);
    assert.equal(driftResult.outcome, 'DRIFT_DETECTED');
    assert.equal(driftResult.codeApplied, false);

    developerFiles.releaseProject(ownerId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 11: Controlled repair lifecycle with verified checks vs process isolation gate
  // -------------------------------------------------------------------------
  console.log('Testing repair execution under unverified process isolation (fail closed)...');
  {
    const dir = await makeTempDir();
    const targetFile = 'src/helper.ts';
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    const originalHelper = 'export function help() { return false; }\n';
    await fs.writeFile(path.join(dir, targetFile), originalHelper);

    const ownerId = 102;
    await developerFiles.attachProject(dir, ownerId);

    const diagnosis = {
      diagnosisId: 'diag-helper-1',
      status: DIAGNOSTIC_STATUSES.CONFIRMED,
      failureCategory: FAILURE_CATEGORIES.SYNTAX_ERROR,
      rootCause: 'Fix help return value',
      affectedFiles: [targetFile],
      primaryLocation: { file: targetFile, line: 1 },
      attemptNumber: 1,
    };

    const plan = await createRepairPlan({
      diagnosis,
      projectRoot: dir,
      customPatchGenerator: async () => ({
        replacementContent: 'export function help() { return true; }\n',
      }),
    });

    // Execute with approval under unverified Windows process isolation:
    // Patch applies, but verification execution blocks at PROCESS_ISOLATION_GATE
    const cycleResult = await executeRepairCycle({
      repairPlan: plan,
      projectRoot: dir,
      ownerWebContentsId: ownerId,
      approve: async () => true,
    });

    assert.equal(cycleResult.ok, false);
    assert.equal(cycleResult.outcome, 'BLOCKED');
    assert.equal(cycleResult.codeApplied, true);
    assert.equal(cycleResult.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(cycleResult.verificationTier, VERIFICATION_TIERS.PATCH_APPLIED);

    // Verify file on disk received the approved patch
    const updatedHelper = await fs.readFile(path.join(dir, targetFile), 'utf8');
    assert.equal(updatedHelper, 'export function help() { return true; }\n');

    developerFiles.releaseProject(ownerId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 12: Autonomous coding workflow integration with diagnosis
  // -------------------------------------------------------------------------
  console.log('Testing autonomous coding workflow integration with diagnostic engine...');
  {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'v4-workflow-app',
      scripts: { build: 'vite build' },
    }));

    const ownerId = 103;
    await developerFiles.attachProject(dir, ownerId);

    // Build request that blocks at PROCESS_ISOLATION_GATE
    const result = await executeAutonomousCodingWorkflow({
      userRequest: 'Please run the build.',
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      root: dir,
    });

    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(result.phase, 'BUILD_EXECUTION_GATE');
    assert.ok(result.diagnosis, 'Result should carry structured diagnosis');
    assert.equal(result.diagnosis.status, DIAGNOSTIC_STATUSES.BLOCKED);
    assert.equal(result.diagnosis.failureCategory, FAILURE_CATEGORIES.PROCESS_ISOLATION_BLOCKED);
    assert.equal(result.diagnosis.confidence, 'HIGH');

    developerFiles.releaseProject(ownerId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log('All Evidence-Based Self-Diagnosis & Safe Repair Loop regression tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
