import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  BUILD_OPERATIONS,
  BUILD_OUTCOMES,
  createBuildPlan,
  executeBuildPlan,
  executeAutonomousCodingWorkflow,
} = require('../electron/developerAgent.cjs');

const {
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
} = require('../electron/coding-pipeline/projectProcessIsolation.cjs');

const {
  discoverEnvironmentCapabilities,
  verifyIsolationEvidence,
  executeInVerifiedSandbox,
} = require('../electron/coding-pipeline/sandboxExecutionAdapter.cjs');

const {
  WindowsSandboxProvider,
} = require('../electron/coding-pipeline/providers/windowsSandboxProvider.cjs');

const {
  ContainerProvider,
} = require('../electron/coding-pipeline/providers/containerProvider.cjs');

const developerFiles = require('../electron/developerFiles.cjs');

async function makeTempDir(prefix = 'v3-isolation-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runVerifiedIsolationTests() {
  console.log('Starting CODING AGENT V3 — Verified Isolated Project Execution tests...');

  // -------------------------------------------------------------------------
  // 1. Process Isolation Status and Rejection of Forged Evidence
  // -------------------------------------------------------------------------
  console.log('1. Testing process isolation status and forged evidence rejection...');
  {
    const status = projectProcessIsolationStatus();
    assert.equal(status.available, false, 'Windows process isolation must not be claimed available without verified backend.');
    assert.equal(status.verified, false, 'Windows process isolation must not be claimed verified without verified backend.');
    assert.equal(status.capabilityStates.osEnforcedProcessIsolation, 'BLOCKED');

    // Reject caller-supplied arbitrary boolean flags
    const callerSuppliedProof = verifyIsolationEvidence({ sandbox: true });
    assert.equal(callerSuppliedProof.isVerified, false);
    assert.equal(callerSuppliedProof.status, 'BLOCKED');
    assert.equal(callerSuppliedProof.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(callerSuppliedProof.reason, /rejected as proof of isolation/i);

    const callerVerifiedFlag = verifyIsolationEvidence({ isolationVerified: true });
    assert.equal(callerVerifiedFlag.isVerified, false);
    assert.equal(callerVerifiedFlag.status, 'BLOCKED');

    // Environment capabilities report
    const envCaps = discoverEnvironmentCapabilities();
    assert.equal(envCaps.available, false);
    assert.equal(envCaps.verified, false);
    assert.equal(envCaps.status, 'BLOCKED');
    assert.equal(envCaps.gate, 'PROCESS_ISOLATION_GATE');
  }

  // -------------------------------------------------------------------------
  // 2. Windows Sandbox & Container Provider Capability Inspection
  // -------------------------------------------------------------------------
  console.log('2. Testing Windows Sandbox and Container Provider discovery...');
  {
    const wsbProvider = new WindowsSandboxProvider();
    const wsbCaps = await wsbProvider.discoverCapabilities();
    assert.equal(wsbCaps.isReady, false, 'Windows Sandbox provider must fail-closed (isReady: false).');
    assert.equal(wsbCaps.capabilityVerificationStatus, 'BLOCKED');
    assert.ok(wsbCaps.unverifiedRequirements.includes('Windows Sandbox host-observed termination daemon attestation'));

    const containerProvider = new ContainerProvider();
    const containerCaps = await containerProvider.discoverCapabilities();
    assert.equal(containerProvider.providerId, 'container-isolation-provider');
    assert.equal(containerCaps.isReady, false, 'Container provider must fail-closed (isReady: false).');
    assert.equal(containerCaps.availability.isInstalled, false, 'Docker daemon is not installed on this host.');
  }

  // -------------------------------------------------------------------------
  // 3. Fail-Closed Execution Gate for Project Tests (Zero Host Execution)
  // -------------------------------------------------------------------------
  console.log('3. Testing fail-closed execution gate with zero host execution...');
  {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'isolated-test-fixture',
      scripts: { test: 'node -e "throw new Error(\'HOST EXECUTION MUST NOT OCCUR\')"' },
    }));

    const ownerId = 101;
    await developerFiles.attachProject(dir, ownerId);

    const plan = await createBuildPlan({
      projectRoot: dir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });
    assert.equal(plan.status, 'READY');
    assert.equal(plan.prerequisites.satisfied, true);

    const execResult = await executeBuildPlan({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(execResult.ok, false);
    assert.equal(execResult.status, BUILD_OUTCOMES.BLOCKED);
    assert.equal(execResult.executionBlocked, true);
    assert.equal(execResult.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(execResult.reason, /verified Windows process isolation is required/i);

    // Test executeInVerifiedSandbox fails closed without verified supervisor runner
    const sandboxExecResult = await executeInVerifiedSandbox({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });
    assert.equal(sandboxExecResult.ok, false);
    assert.equal(sandboxExecResult.status, 'BLOCKED');
    assert.equal(sandboxExecResult.gate, 'PROCESS_ISOLATION_GATE');

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 4. Live Acceptance Target (C:\Users\Admin\Downloads\Hello)
  // -------------------------------------------------------------------------
  console.log('4. Testing live attached project C:\\Users\\Admin\\Downloads\\Hello...');
  {
    const targetRoot = 'C:\\Users\\Admin\\Downloads\\Hello';
    const ownerId = 102;
    await developerFiles.attachProject(targetRoot, ownerId);

    // 4a: "test the project" request on Hello fixture
    const testResult = await executeAutonomousCodingWorkflow({
      userRequest: 'test the project',
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      root: targetRoot,
      userApproved: true,
    });

    // Validates that testResult explicitly differentiates evidence categories
    // and truthful fail-closed isolation status for actual host commands
    assert.ok(testResult.executionVerificationReceipt, 'Execution verification receipt must be provided.');
    const cats = testResult.executionVerificationReceipt.evidenceCategories;
    assert.ok(cats, 'Evidence categories distinction must be present.');
    assert.equal(cats.sourceAndStaticAnalysis.status, 'PASSED');
    assert.equal(cats.syntheticAndInProcessProbes.status, 'PASSED');
    assert.equal(cats.actualProjectTestCommands.status, 'NOT_RUN', 'Host npm test must NOT be executed.');
    assert.match(cats.actualProjectTestCommands.reason, /OS process isolation is not verified/i);
    assert.equal(cats.actualBuildResults.status, 'NOT_RUN');
    assert.equal(cats.actualApplicationRuntime.status, 'IN_PROCESS_VM_ONLY');
    assert.ok(cats.checksBlockedOrNotExecuted.some((c) => c.check === 'npm test' && c.reason.includes('OS process isolation')));
    assert.ok(cats.checksBlockedOrNotExecuted.some((c) => c.check === 'npm install' && c.reason.includes('OS process isolation')));

    // Audit must accurately detect missing node_modules on disk
    assert.match(testResult.executionVerificationReceipt.message, /Missing node_modules directory.*react, react-dom/i);
    assert.match(testResult.executionVerificationReceipt.message, /Actual project test commands: NOT RUN on host/i);

    // 4b: Dependency install request on Hello fixture
    const installResult = await executeAutonomousCodingWorkflow({
      userRequest: 'install dependencies',
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      root: targetRoot,
      userApproved: true,
    });

    assert.equal(installResult.outcome, 'BLOCKED');
    assert.equal(installResult.phase, 'DEPENDENCY_INSTALL_GATE');
    assert.equal(installResult.executionBlocked, true);
    assert.match(installResult.reason, /verified Windows process isolation is required/i);
  }

  console.log('All CODING AGENT V3 — Verified Isolated Project Execution tests passed successfully!');
}

runVerifiedIsolationTests().catch((err) => {
  console.error('V3 Isolation Test Suite failed:', err);
  process.exit(1);
});
