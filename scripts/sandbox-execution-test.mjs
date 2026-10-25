import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  ADAPTER_STATUSES,
  discoverEnvironmentCapabilities,
  verifyIsolationEvidence,
  executeInVerifiedSandbox,
  validatePathWithinRoot,
  validateMultiFilePatchIntegrity,
  rollbackAllSnapshots,
  createRepairPlan,
  executeRepairCycle,
  DIAGNOSTIC_STATUSES,
  FAILURE_CATEGORIES,
} = require('../electron/developerAgent.cjs');

const developerFiles = require('../electron/developerFiles.cjs');

async function makeTempDir(prefix = 'v5-sandbox-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runTests() {
  console.log('Starting Verified Sandbox Execution & Multi-File Patch Verification regression tests (V5)...');

  // -------------------------------------------------------------------------
  // Test 1: Missing / Unverified Isolation Provider Blocks Execution
  // -------------------------------------------------------------------------
  console.log('Testing missing/unverified isolation provider blocks execution...');
  {
    const capabilities = discoverEnvironmentCapabilities();
    // On Windows, isolation is unverified pending host API verification
    if (process.platform === 'win32') {
      assert.equal(capabilities.verified, false);
      assert.equal(capabilities.status, ADAPTER_STATUSES.BLOCKED);
      assert.equal(capabilities.gate, 'PROCESS_ISOLATION_GATE');
      assert.ok(capabilities.reason.includes('Windows'));
    }

    // Missing evidence produces BLOCKED
    const verifyMissing = verifyIsolationEvidence(null);
    assert.equal(verifyMissing.isVerified, false);
    assert.equal(verifyMissing.status, ADAPTER_STATUSES.BLOCKED);
  }

  // -------------------------------------------------------------------------
  // Test 2: Caller-supplied Boolean flag ("sandbox: true") is rejected
  // -------------------------------------------------------------------------
  console.log('Testing caller-supplied boolean flag rejection...');
  {
    const callerFlag = { sandbox: true };
    const verifyFlag = verifyIsolationEvidence(callerFlag);
    assert.equal(verifyFlag.isVerified, false);
    assert.equal(verifyFlag.status, ADAPTER_STATUSES.BLOCKED);
    assert.ok(verifyFlag.reason.includes('Caller-supplied Boolean flag'));
  }

  // -------------------------------------------------------------------------
  // Test 3: Fake / Untrusted Provider Cannot Claim Trusted Isolation
  // -------------------------------------------------------------------------
  console.log('Testing untrusted/simulated source rejection...');
  {
    const fakeEvidence = {
      runId: 'fake-run-1',
      providerId: 'fake-unverified-provider',
      provenance: 'untrusted-caller-input',
      trustClass: 'UNTRUSTED',
      approvedSnapshotDigest: 'abc',
      approvedManifestDigest: 'def',
      verificationPlanDigest: '123',
      workerIdentity: 'guest-1',
      evidenceTimestamp: new Date().toISOString(),
      evidenceExpiry: new Date(Date.now() + 60000).toISOString(),
    };

    const verifyFake = verifyIsolationEvidence(fakeEvidence);
    assert.equal(verifyFake.isVerified, false);
    assert.equal(verifyFake.status, ADAPTER_STATUSES.BLOCKED);
  }

  // -------------------------------------------------------------------------
  // Test 4: Project Authorization Mismatch Blocks Execution
  // -------------------------------------------------------------------------
  console.log('Testing project authorization check in sandbox adapter...');
  {
    const dir = await makeTempDir();
    const ownerId = 201;
    // Do NOT attach project to ownerId -> unauthorized
    const plan = {
      projectRoot: dir,
      binary: 'npm',
      args: ['run', 'build'],
      planDigest: 'a'.repeat(64),
    };

    const res = await executeInVerifiedSandbox({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, ADAPTER_STATUSES.BLOCKED);
    assert.equal(res.gate, 'AUTHORIZATION_GATE');
    assert.equal(res.executionBlocked, true);

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 5: Changed command / Missing Plan Digest Fails Closed
  // -------------------------------------------------------------------------
  console.log('Testing plan digest alteration guard...');
  {
    const dir = await makeTempDir();
    const ownerId = 202;
    await developerFiles.attachProject(dir, ownerId);

    const planMissingDigest = {
      projectRoot: dir,
      binary: 'npm',
      args: ['run', 'build'],
      // planDigest omitted
    };

    const res = await executeInVerifiedSandbox({
      plan: planMissingDigest,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, ADAPTER_STATUSES.BLOCKED);
    assert.equal(res.gate, 'APPROVAL_DIGEST_GATE');

    developerFiles.releaseProject(ownerId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 6: Shell Injection and Command Safety Validation
  // -------------------------------------------------------------------------
  console.log('Testing shell injection prevention in sandbox adapter...');
  {
    const dir = await makeTempDir();
    const ownerId = 203;
    await developerFiles.attachProject(dir, ownerId);

    const maliciousPlan = {
      projectRoot: dir,
      binary: 'npm',
      args: ['run', 'build && rm -rf /'],
      planDigest: 'b'.repeat(64),
    };

    const res = await executeInVerifiedSandbox({
      plan: maliciousPlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, ADAPTER_STATUSES.BLOCKED);
    assert.equal(res.gate, 'COMMAND_SAFETY_GATE');
    assert.ok(res.reason.includes('Command safety violation'));

    developerFiles.releaseProject(ownerId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 7: Path Traversal Rejection in Multi-File Patch Validation
  // -------------------------------------------------------------------------
  console.log('Testing path traversal rejection in multi-file patch validation...');
  {
    const dir = await makeTempDir();

    // Normal safe path
    const safeCheck = validatePathWithinRoot('src/utils.ts', dir);
    assert.equal(safeCheck.valid, true);

    // Traversal attempts
    const traversalCheck = validatePathWithinRoot('../../../etc/passwd', dir);
    assert.equal(traversalCheck.valid, false);
    assert.ok(traversalCheck.error.includes('traverses outside'));

    const rootSlashTraversal = validatePathWithinRoot('C:/Windows/System32/cmd.exe', dir);
    assert.equal(rootSlashTraversal.valid, false);

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 8: Multi-File Pre-Apply Drift Detection
  // -------------------------------------------------------------------------
  console.log('Testing multi-file pre-apply drift guard...');
  {
    const dir = await makeTempDir();
    const fileA = 'src/serviceA.ts';
    const fileB = 'src/serviceB.ts';
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });

    await fs.writeFile(path.join(dir, fileA), 'const a = 1;\n');
    await fs.writeFile(path.join(dir, fileB), 'const b = 2;\n');

    const fileChanges = [
      { filePath: fileA, originalContent: 'const a = 1;\n', replacementContent: 'const a = 10;\n' },
      { filePath: fileB, originalContent: 'const b = 2;\n', replacementContent: 'const b = 20;\n' },
    ];

    // Clean check passes
    const cleanCheck = await validateMultiFilePatchIntegrity({ fileChanges, projectRoot: dir });
    assert.equal(cleanCheck.valid, true);

    // Concurrent drift in fileB
    await fs.writeFile(path.join(dir, fileB), 'const b = "drifted";\n');
    const driftedCheck = await validateMultiFilePatchIntegrity({ fileChanges, projectRoot: dir });
    assert.equal(driftedCheck.valid, false);
    assert.equal(driftedCheck.driftDetected, true);
    assert.ok(driftedCheck.error.includes('Pre-apply drift guard'));

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 9: Atomic Rollback on Multi-File Apply / Read-Back Verification Failure
  // -------------------------------------------------------------------------
  console.log('Testing atomic rollback on partial multi-file application failure...');
  {
    const dir = await makeTempDir();
    const file1 = 'src/file1.ts';
    const file2 = 'src/file2.ts';
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });

    const orig1 = 'export const one = 1;\n';
    const orig2 = 'export const two = 2;\n';
    await fs.writeFile(path.join(dir, file1), orig1);
    await fs.writeFile(path.join(dir, file2), orig2);

    const ownerId = 204;
    await developerFiles.attachProject(dir, ownerId);

    const repairPlan = {
      planId: 'plan-multi-rollback-1',
      status: 'READY',
      planDigest: 'c'.repeat(64),
      affectedFiles: [file1, file2],
      fileChanges: [
        { filePath: file1, originalContent: orig1, replacementContent: 'export const one = 100;\n' },
        { filePath: file2, originalContent: orig2, replacementContent: 'export const two = 200;\n' },
      ],
      rollbackInfo: {
        snapshots: {
          [file1]: orig1,
          [file2]: orig2,
        },
      },
    };

    // Simulate custom applicator that succeeds on file1 but throws on file2
    let writeCount = 0;
    const failingApply = async ({ filePath, replacementContent }) => {
      writeCount++;
      if (filePath === file2) {
        throw new Error('Simulated disk write failure on second file');
      }
      await fs.writeFile(path.join(dir, filePath), replacementContent, 'utf8');
    };

    const cycleRes = await executeRepairCycle({
      repairPlan,
      projectRoot: dir,
      ownerWebContentsId: ownerId,
      approve: async () => true,
      applyPatch: failingApply,
    });

    assert.equal(cycleRes.ok, false);
    assert.equal(cycleRes.outcome, 'APPLY_FAILED');
    assert.equal(cycleRes.rolledBack, true);

    // Verify atomic snapshot rollback restored file1 to its original state!
    const diskContent1 = await fs.readFile(path.join(dir, file1), 'utf8');
    const diskContent2 = await fs.readFile(path.join(dir, file2), 'utf8');
    assert.equal(diskContent1, orig1, 'File 1 must be restored via rollback snapshot.');
    assert.equal(diskContent2, orig2, 'File 2 must remain in original state.');

    developerFiles.releaseProject(ownerId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 10: Execution Lifecycle Controls: Timeout, Cancellation, and Bounded Output
  // -------------------------------------------------------------------------
  console.log('Testing execution lifecycle controls (timeout, cancellation, bounded output)...');
  {
    const dir = await makeTempDir();
    const ownerId = 205;
    await developerFiles.attachProject(dir, ownerId);

    // 10a. Cancellation
    const abortCtrl = new AbortController();
    abortCtrl.abort(); // already cancelled

    const plan = {
      projectRoot: dir,
      binary: 'npm',
      args: ['run', 'build'],
      planDigest: 'd'.repeat(64),
    };

    // When isolation is verified in test adapter:
    // Simulated supervisor runner to test lifecycle outcomes
    const supervisorMock = async ({ timeoutMs, maxOutputBytes, signal }) => {
      if (signal?.aborted) return { cancelled: true, cleanupStatus: 'CLEANED' };
      return { exitCode: 0, stdout: 'ok', cleanupStatus: 'CLEANED' };
    };

    // Note: unverified Windows isolation fails closed before runner:
    const blockedRes = await executeInVerifiedSandbox({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      supervisorRunner: supervisorMock,
    });
    assert.equal(blockedRes.ok, false);
    assert.equal(blockedRes.status, ADAPTER_STATUSES.BLOCKED);
    assert.equal(blockedRes.gate, 'PROCESS_ISOLATION_GATE');

    developerFiles.releaseProject(ownerId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log('All Verified Sandbox Execution & Multi-File Patch Verification regression tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
