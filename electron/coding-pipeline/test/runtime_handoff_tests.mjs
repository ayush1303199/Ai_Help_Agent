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
  executeBuildPlan,
  createBuildPlanTestHarness,
} = require('../buildOrchestrator.cjs');
const {
  ProjectContainerExecutionRunner,
  createProjectContainerExecutionRunner,
} = require('../projectContainerExecutionRunner.cjs');
const {
  defaultRegistry,
} = require('../isolationProviderRegistry.cjs');
const {
  registerMockDockerProvider,
  unregisterMockDockerProvider,
} = require('./mockDockerProvider.cjs');
const developerFiles = require('../../developerFiles.cjs');

(async () => {
  console.log('Starting V26.4 Test-Seam Unreachability and Evidence Integrity Audit Tests...');

  // Setup isolated test workspace
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-prod-test-'));
  await fs.writeFile(
    path.join(tempDir, 'package.json'),
    JSON.stringify({ name: 'handoff-test-app', scripts: { build: 'node -e "console.log(1)"' } })
  );

  const ownerId = 9988;
  await developerFiles.attachProject(tempDir, ownerId);

  const basePlan = {
    projectRoot: tempDir,
    binary: 'node',
    args: ['-e', 'console.log("test")'],
    operation: BUILD_OPERATIONS.BUILD,
    ecosystem: 'node',
    planDigest: 'a'.repeat(64),
    fullCommandString: 'node -e "console.log(\\"test\\")"',
    prerequisites: { satisfied: true, missingDependencies: [] },
  };

  const makePlan = (overrides = {}) => ({ ...basePlan, ...overrides });

  try {
    // =======================================================================
    // PART 1: Test-Seam Unreachability from Ordinary Production Code
    // =======================================================================

    // 1. Production executeBuildPlan strictly enforces authoritative isolation
    console.log('Test 1: Production executeBuildPlan enforces authoritative gate fail-closed...');
    let adapterCallsTest1 = 0;
    const runnerTest1 = createProjectContainerExecutionRunner({
      dockerCli: () => {
        adapterCallsTest1++;
        return { status: 0, stdout: '', stderr: '' };
      },
      isMock: true,
    });

    const res1 = await executeBuildPlan({
      plan: makePlan(),
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runnerTest1,
    });

    assert.equal(res1.ok, false, 'Production call must fail-closed on Windows');
    assert.equal(res1.status, BUILD_OUTCOMES.BLOCKED);
    assert.equal(res1.executionBlocked, true);
    assert.equal(res1.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(adapterCallsTest1, 0, 'Adapter must never be called on blocked path');
    console.log('  -> Test 1 Passed: Authoritative isolation enforced; adapter not invoked.');

    // 2. Global Symbol.for cannot activate test behavior in executeBuildPlan
    console.log('Test 2: Global Symbol.for and conventional names cannot activate test behavior...');
    let fakeGateInvoked = false;
    const fakeBypassGate = () => {
      fakeGateInvoked = true;
      return {
        providerId: 'docker',
        runtimeType: 'container',
        available: true,
        isolationVerified: true,
        supportedOps: [BUILD_OPERATIONS.BUILD],
      };
    };

    const globalSymbol = Symbol.for('coding-pipeline:test-isolation-gate');
    const res2 = await executeBuildPlan({
      plan: makePlan(),
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runnerTest1,
      isolationGate: fakeBypassGate,
      [globalSymbol]: fakeBypassGate,
    });

    assert.equal(res2.ok, false);
    assert.equal(res2.status, BUILD_OUTCOMES.BLOCKED);
    assert.equal(res2.executionBlocked, true);
    assert.equal(res2.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(fakeGateInvoked, false, 'Injected gate must never be called by production executeBuildPlan');
    assert.equal(adapterCallsTest1, 0);
    console.log('  -> Test 2 Passed: Injected gate and global Symbol ignored by executeBuildPlan.');

    // 3. Plain object with spoofed { isMockRunner: true } is rejected by test harness
    console.log('Test 3: Plain object spoofing isMockRunner is rejected by test harness...');
    const spoofedRunner = {
      isMockRunner: true,
      execute: async () => ({ ok: true, status: 'PASSED' }),
    };

    assert.throws(
      () => {
        createBuildPlanTestHarness({
          isolationGate: () => ({ providerId: 'docker' }),
          containerRunner: spoofedRunner,
        });
      },
      /authentic ProjectContainerExecutionRunner mock instance/,
      'Harness must reject ordinary objects attempting to spoof isMockRunner'
    );
    console.log('  -> Test 3 Passed: Plain object mock spoofing rejected with type verification.');

    // 4. Non-mock ProjectContainerExecutionRunner is rejected by test harness
    console.log('Test 4: Non-mock authentic runner is rejected by test harness...');
    const realRunner = createProjectContainerExecutionRunner({ isMock: false });
    assert.equal(realRunner.isMockRunner, false);

    assert.throws(
      () => {
        createBuildPlanTestHarness({
          isolationGate: () => ({ providerId: 'docker' }),
          containerRunner: realRunner,
        });
      },
      /authentic ProjectContainerExecutionRunner mock instance/,
      'Harness must reject non-mock container runners'
    );
    console.log('  -> Test 4 Passed: Non-mock container runner rejected by test harness.');

    // 5. Caller-supplied plan.runtime and plan.selectedRuntime are ignored
    console.log('Test 5: Caller-supplied plan.runtime / selectedRuntime cannot bypass gate...');
    const maliciousPlan = makePlan({
      runtime: { providerId: 'docker', isolationVerified: true, untrustedClaim: true },
      selectedRuntime: { providerId: 'docker', isolationVerified: true, untrustedClaim: true },
    });

    const res5 = await executeBuildPlan({
      plan: maliciousPlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runnerTest1,
    });

    assert.equal(res5.ok, false);
    assert.equal(res5.status, BUILD_OUTCOMES.BLOCKED);
    assert.equal(res5.executionBlocked, true);
    assert.equal(res5.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(adapterCallsTest1, 0);
    console.log('  -> Test 5 Passed: Caller-supplied runtime claims ignored fail-closed.');

    // =======================================================================
    // PART 2: Isolation Evidence Freshness & Authoritative Validation
    // =======================================================================

    // 6. Stale authoritative verificationTimestamp in registry is rejected
    console.log('Test 6: Stale authoritative verificationTimestamp in registry fails closed...');
    registerMockDockerProvider({
      verificationTimestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min old in registry
    });

    let adapterCallsFreshness = 0;
    const freshnessMockRunner = createProjectContainerExecutionRunner({
      dockerCli: () => {
        adapterCallsFreshness++;
        return { status: 0, stdout: '', stderr: '' };
      },
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: true,
    });

    const harnessStaleRegistry = createBuildPlanTestHarness({
      isolationGate: () => Object.freeze({
        providerId: 'docker',
        runtimeType: 'container',
        available: true,
        isolationVerified: true,
        supportedOps: [BUILD_OPERATIONS.BUILD],
        evidenceSource: 'synthetic-test-seam',
        timestamp: new Date().toISOString(), // Caller attempts to supply a fresh timestamp!
      }),
      containerRunner: freshnessMockRunner,
    });

    const res6 = await harnessStaleRegistry.executeBuildPlan({
      plan: makePlan(),
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res6.ok, false);
    assert.equal(res6.gate, 'PROCESS_ISOLATION_GATE');
    assert.ok(res6.reason.includes('expired or has invalid timestamp'));
    assert.equal(adapterCallsFreshness, 0, 'Adapter must not be called when registry evidence is stale');
    console.log('  -> Test 6 Passed: Stale registry evidence rejected despite fresh caller timestamp.');

    // 7. Stale caller timestamp fails closed
    console.log('Test 7: Stale caller timestamp fails closed...');
    registerMockDockerProvider({
      verificationTimestamp: new Date().toISOString(), // fresh in registry
    });

    const harnessStaleCaller = createBuildPlanTestHarness({
      isolationGate: () => Object.freeze({
        providerId: 'docker',
        runtimeType: 'container',
        available: true,
        isolationVerified: true,
        supportedOps: [BUILD_OPERATIONS.BUILD],
        evidenceSource: 'synthetic-test-seam',
        timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min old caller timestamp
      }),
      containerRunner: freshnessMockRunner,
    });

    const res7 = await harnessStaleCaller.executeBuildPlan({
      plan: makePlan(),
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res7.ok, false);
    assert.equal(res7.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(adapterCallsFreshness, 0);
    console.log('  -> Test 7 Passed: Stale caller timestamp rejected fail-closed.');

    // 8. Unverified runtime (isolationVerified = false) fails closed
    console.log('Test 8: Unverified runtime (isolationVerified = false) fails closed...');
    const harnessUnverified = createBuildPlanTestHarness({
      isolationGate: () => Object.freeze({
        providerId: 'docker',
        runtimeType: 'container',
        available: true,
        isolationVerified: false,
        supportedOps: [BUILD_OPERATIONS.BUILD],
        evidenceSource: 'synthetic-test-seam',
        timestamp: new Date().toISOString(),
      }),
      containerRunner: freshnessMockRunner,
    });

    const res8 = await harnessUnverified.executeBuildPlan({
      plan: makePlan(),
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res8.ok, false);
    assert.equal(res8.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(adapterCallsFreshness, 0);
    console.log('  -> Test 8 Passed: isolationVerified: false rejected fail-closed.');

    // 9. Unsupported operation fails closed
    console.log('Test 9: Unsupported operation fails closed...');
    const harnessUnsupportedOp = createBuildPlanTestHarness({
      isolationGate: () => Object.freeze({
        providerId: 'docker',
        runtimeType: 'container',
        available: true,
        isolationVerified: true,
        supportedOps: ['LINT'], // Only LINT, but plan is BUILD
        evidenceSource: 'synthetic-test-seam',
        timestamp: new Date().toISOString(),
      }),
      containerRunner: freshnessMockRunner,
    });

    const res9 = await harnessUnsupportedOp.executeBuildPlan({
      plan: makePlan({ operation: BUILD_OPERATIONS.BUILD }),
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res9.ok, false);
    assert.equal(res9.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(adapterCallsFreshness, 0);
    console.log('  -> Test 9 Passed: Unsupported operation rejected fail-closed.');

    // =======================================================================
    // PART 3: Synthetic Test-Harness Handoff Contract Proof
    // =======================================================================

    console.log('Test 10: Synthetic test harness verifies handoff contract & identity...');
    registerMockDockerProvider({
      verificationTimestamp: new Date().toISOString(),
    });

    const eventTrace = [];
    const validSyntheticRuntime = Object.freeze({
      providerId: 'docker',
      runtimeType: 'container',
      available: true,
      isolationVerified: true,
      supportedOps: [BUILD_OPERATIONS.BUILD, BUILD_OPERATIONS.TEST],
      evidenceSource: 'synthetic-test-seam',
      timestamp: new Date().toISOString(),
    });

    const harnessGate = (op) => {
      eventTrace.push({ step: 'GATE_INVOKED', op, runtime: validSyntheticRuntime });
      return validSyntheticRuntime;
    };

    let factoryCalls = 0;
    let adapterCallsHandoff = 0;
    let receivedRuntimeInRunner = null;

    const runnerFactory = () => {
      factoryCalls++;
      eventTrace.push({ step: 'FACTORY_INVOKED', count: factoryCalls });
      const runner = createProjectContainerExecutionRunner({
        dockerCli: (cmd, args) => {
          if (Array.isArray(args) && args[0] === 'ps') {
            return { status: 0, stdout: '', stderr: '' };
          }
          adapterCallsHandoff++;
          eventTrace.push({ step: 'ADAPTER_INVOKED', cmd, args });
          return { status: 0, stdout: 'build ok\n', stderr: '' };
        },
        runtimeDetector: () => ({ daemonAvailable: true }),
        isMock: true,
      });

      const originalExecute = runner.execute.bind(runner);
      runner.execute = async (opts) => {
        receivedRuntimeInRunner = opts.runtime;
        eventTrace.push({ step: 'RUNNER_INVOKED', runtime: opts.runtime });
        return await originalExecute(opts);
      };

      return runner;
    };

    const activeRunner = runnerFactory();
    const testHarness = createBuildPlanTestHarness({
      isolationGate: harnessGate,
      containerRunner: activeRunner,
    });

    const res10 = await testHarness.executeBuildPlan({
      plan: makePlan(),
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(res10.ok, true, 'Synthetic test harness path must succeed');
    assert.equal(factoryCalls, 1, 'Runner factory must be invoked once');
    assert.equal(adapterCallsHandoff, 1, 'Adapter must be invoked exactly once');

    // Strict event sequence
    const traceSteps = eventTrace.map((e) => e.step);
    assert.deepEqual(
      traceSteps,
      ['FACTORY_INVOKED', 'GATE_INVOKED', 'RUNNER_INVOKED', 'ADAPTER_INVOKED'],
      'Events must occur in strict factory -> gate -> runner -> adapter order'
    );

    // Strict runtime identity
    assert.strictEqual(
      receivedRuntimeInRunner,
      validSyntheticRuntime,
      'Runner must receive strictly identical runtime object returned by gate'
    );
    console.log('  -> Test 10 Passed: Synthetic test harness proved contract handoff and strict identity.');

    // =======================================================================
    // PART 4: Mock Provider Registry Restoration Audit
    // =======================================================================

    console.log('Test 11: Testing repeated registration and clean restoration...');
    // Initial state before Test 11
    unregisterMockDockerProvider();
    const preTest11Provider = defaultRegistry.getProvider('docker');

    // Repeated registration
    registerMockDockerProvider({ version: 'mock-first' });
    registerMockDockerProvider({ version: 'mock-second' });
    assert.equal(defaultRegistry.getProvider('docker').version, 'mock-second');

    // Restoration
    unregisterMockDockerProvider();
    const postTest11Provider = defaultRegistry.getProvider('docker');
    assert.strictEqual(
      postTest11Provider,
      preTest11Provider,
      'Registry must restore exact pre-test descriptor even after repeated registrations'
    );

    // Repeated unregistration is safe no-op
    unregisterMockDockerProvider();
    unregisterMockDockerProvider();
    assert.strictEqual(defaultRegistry.getProvider('docker'), preTest11Provider);
    console.log('  -> Test 11 Passed: Repeated registration and unregistration properly restored.');

    console.log('Test 12: Testing restoration guarantee on thrown test exception...');
    const preExceptionProvider = defaultRegistry.getProvider('docker');
    try {
      registerMockDockerProvider({ version: 'mock-throw' });
      assert.equal(defaultRegistry.getProvider('docker').version, 'mock-throw');
      throw new Error('Simulated test failure');
    } catch {
      // Expected simulation
    } finally {
      unregisterMockDockerProvider();
    }
    const postExceptionProvider = defaultRegistry.getProvider('docker');
    assert.strictEqual(
      postExceptionProvider,
      preExceptionProvider,
      'Registry must restore exact state even after an exception in test body'
    );
    console.log('  -> Test 12 Passed: Restoration guaranteed across thrown exceptions.');

    // =======================================================================
    // PART 5: Production Gates & Safety Invariants Audit
    // =======================================================================

    // 13. Project Authorization Gate: unauthorized project fails closed
    console.log('Test 13: Project authorization gate blocks unauthorized execution...');
    let adapterCallsAuth = 0;
    const runnerAuth = createProjectContainerExecutionRunner({
      dockerCli: () => {
        adapterCallsAuth++;
        return { status: 0, stdout: '', stderr: '' };
      },
      isMock: true,
    });

    const unauthorizedPlan = makePlan({ projectRoot: path.join(os.tmpdir(), 'unauthorized-project-root') });
    const res13 = await executeBuildPlan({
      plan: unauthorizedPlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runnerAuth,
    });
    assert.equal(res13.ok, false);
    assert.equal(res13.status, BUILD_OUTCOMES.BLOCKED);
    assert.ok(res13.error.includes('Project authorization failed'));
    assert.equal(adapterCallsAuth, 0, 'Adapter must never be called on authorization failure');
    console.log('  -> Test 13 Passed: Unauthorized project blocked before adapter invocation.');

    // 14. Command Safety Gate: dangerous shell characters fail closed
    console.log('Test 14: Command safety gate blocks unsafe command chaining...');
    let adapterCallsSafety = 0;
    const runnerSafety = createProjectContainerExecutionRunner({
      dockerCli: () => {
        adapterCallsSafety++;
        return { status: 0, stdout: '', stderr: '' };
      },
      isMock: true,
    });

    const unsafePlan = makePlan({
      binary: 'node',
      args: ['-e', 'console.log("hello"); rm -rf /'],
      fullCommandString: 'node -e "console.log(\\"hello\\"); rm -rf /"',
    });
    const res14 = await executeBuildPlan({
      plan: unsafePlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runnerSafety,
    });
    assert.equal(res14.ok, false);
    assert.equal(res14.status, BUILD_OUTCOMES.BLOCKED);
    assert.ok(res14.error.includes('Command safety violation'));
    assert.equal(adapterCallsSafety, 0, 'Adapter must never be called on command safety violation');
    console.log('  -> Test 14 Passed: Dangerous command metacharacters blocked before adapter invocation.');

    // 15. Dependency Prerequisites Gate: missing prerequisites fail closed
    console.log('Test 15: Dependency prerequisites gate blocks execution when unmet...');
    let adapterCallsPrereq = 0;
    const runnerPrereq = createProjectContainerExecutionRunner({
      dockerCli: () => {
        adapterCallsPrereq++;
        return { status: 0, stdout: '', stderr: '' };
      },
      isMock: true,
    });

    const unmetPrereqPlan = makePlan({
      prerequisites: {
        satisfied: false,
        missingDependencies: [{ name: 'missing-pkg', manager: 'npm' }],
        reason: 'Dependencies must be installed first',
      },
    });
    const res15 = await executeBuildPlan({
      plan: unmetPrereqPlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runnerPrereq,
    });
    assert.equal(res15.ok, false);
    assert.equal(res15.status, BUILD_OUTCOMES.BLOCKED);
    assert.equal(res15.gate, 'DEPENDENCY_PREREQUISITE_GATE');
    assert.equal(adapterCallsPrereq, 0, 'Adapter must never be called when prerequisites are missing');
    console.log('  -> Test 15 Passed: Missing prerequisites blocked before adapter invocation.');

    console.log('All V26.5 Production Isolation Boundary Audit Tests Passed!');
  } finally {
    unregisterMockDockerProvider();
    if (typeof developerFiles.clearProject === 'function') {
      developerFiles.clearProject(ownerId);
    }
    await fs.rm(tempDir, { recursive: true, force: true });

    // Assert final registry cleanup
    const leftoverDocker = defaultRegistry.getProvider('docker');
    assert(
      !leftoverDocker || leftoverDocker.evidenceSource !== 'synthetic-test',
      'Registry cleanup failed: mockDockerProvider lingered in defaultRegistry'
    );
  }
})().catch((err) => {
  console.error('V26.4 Audit Test Failed:', err);
  process.exit(1);
});
