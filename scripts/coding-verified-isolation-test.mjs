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

const { createProjectContainerExecutionRunner } = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');

const { discoverIsolationRuntimes } = require('../electron/coding-pipeline/isolationRuntimeDiscovery.cjs');

const { inspectDockerHost } = require('../electron/coding-pipeline/dockerProviderAdapter.cjs');

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

    // Verify isolation candidate contract shape (migrated from coding-v25-runtime-discovery-test)

    const candidates = discoverIsolationRuntimes(process.cwd());

    assert.ok(Array.isArray(candidates), 'Candidates must be an array');

    for (const c of candidates) {

      assert.equal(typeof c.providerId, 'string');

      assert.equal(typeof c.runtimeType, 'string');

      assert.ok('available' in c);

      assert.ok('healthCheck' in c);

      assert.ok('isolationVerified' in c);

      assert.ok(Array.isArray(c.supportedOps));

      assert.equal(typeof c.evidenceSource, 'string');

      assert.equal(typeof c.timestamp, 'string');

    }

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

    let targetExists = false;

    try {

      const st = await fs.stat(targetRoot);

      targetExists = st.isDirectory();

    } catch {}

    if (targetExists) {

      const ownerId = 102;

      await developerFiles.attachProject(targetRoot, ownerId);

      // 4a: "test the project" request on Hello fixture

      const testResult = await executeAutonomousCodingWorkflow({

        userRequest: 'test the project',

        ownerWebContentsId: ownerId,

        sessionId: crypto.randomUUID(),

        root: targetRoot,

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

      assert.match(testResult.executionVerificationReceipt.message, /(?:Missing node_modules directory.*react, react-dom|Module & dependency check)/i);

      assert.match(testResult.executionVerificationReceipt.message, /Actual project test commands: NOT RUN on host/i);

      // 4b: Dependency install request on Hello fixture

      const installResult = await executeAutonomousCodingWorkflow({

        userRequest: 'install dependencies',

        ownerWebContentsId: ownerId,

        sessionId: crypto.randomUUID(),

        root: targetRoot,

      });

      const hasNodeModules = await fs.stat(path.join(targetRoot, 'node_modules')).then(() => true).catch(() => false);
      if (hasNodeModules) {
        assert.equal(installResult.outcome, 'COMPLETED');
        assert.equal(installResult.phase, 'DEPENDENCY_CHECK');
      } else {
        assert.equal(installResult.outcome, 'BLOCKED');
        assert.equal(installResult.phase, 'DEPENDENCY_INSTALL_GATE');
        assert.equal(installResult.executionBlocked, true);
        assert.match(installResult.reason, /verified Windows process isolation is required/i);
      }

    } else {

      console.log('   (Skipped: C:\\Users\\Admin\\Downloads\\Hello not present on host)');

    }

  }

  // -------------------------------------------------------------------------

  // 5. Container Runner Bounded Execution & Fail-Closed Gate

  // -------------------------------------------------------------------------

  console.log('5. Testing Container Runner bounded execution and fail-closed gate...');

  {

    const fixtureDir = await makeTempDir('fixture-runner-');

    await fs.writeFile(

      path.join(fixtureDir, 'package.json'),

      JSON.stringify({

        name: 'runner-fixture',

        version: '1.0.0',

        scripts: {

          test: 'node -e "console.log(\'CONTAINER_COMMAND_SUCCESS\'); process.exit(0);"',

        },

      }, null, 2),

      'utf8'

    );

    const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS || '';

    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = [prevRoots, fixtureDir].filter(Boolean).join(';');

    const ownerId = 3801;

    const sessionId = crypto.randomUUID();

    await developerFiles.attachProject(fixtureDir, ownerId);

    inspectDockerHost();

    const candidates = discoverIsolationRuntimes(fixtureDir);

    const dockerCandidate = candidates.find((c) => c.providerId === 'docker' && c.available && c.isolationVerified);

    const plan = await createBuildPlan({

      projectRoot: fixtureDir,

      operation: BUILD_OPERATIONS.TEST,

    });

    const runner = createProjectContainerExecutionRunner();

    if (dockerCandidate && dockerCandidate.available && dockerCandidate.isolationVerified) {

      const selectedRuntime = requireProjectProcessIsolation(

        `Build operation ${plan.operation} (${plan.fullCommandString || plan.binary})`

      );

      assert.ok(selectedRuntime, 'Isolation gate must return verified runtime');

      const execResult = await runner.execute({

        plan,

        ownerWebContentsId: ownerId,

        sessionId,

        runtime: selectedRuntime,

      });

      assert.equal(execResult.ok, true, 'Container command execution must succeed when verified runtime is available');

      assert.equal(execResult.exitCode, 0);

      assert.ok(execResult.stdout.includes('CONTAINER_COMMAND_SUCCESS'));

    }

    // Fail-closed gate when isolation evidence is missing

    const unverifiedResult = await runner.execute({

      plan,

      ownerWebContentsId: ownerId,

      sessionId,

      runtime: null,

    });

    assert.equal(unverifiedResult.ok, false);

    assert.equal(unverifiedResult.status, 'BLOCKED');

    assert.equal(unverifiedResult.executionBlocked, true);

    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;

    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});

  }

  // -------------------------------------------------------------------------

  // 6. Sandbox Hardening & Security Gate Regressions (V40.1)

  // -------------------------------------------------------------------------

  console.log('6. Testing Sandbox Hardening & Security Gate Regressions...');

  {

    const fixtureDir = await makeTempDir('fixture-hardening-');

    await fs.writeFile(

      path.join(fixtureDir, 'package.json'),

      JSON.stringify({ name: 'hardening-fixture', version: '1.0.0' }, null, 2),

      'utf8'

    );

    const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS || '';

    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = [prevRoots, fixtureDir].filter(Boolean).join(';');

    const ownerId = 4010;

    const sessionId = crypto.randomUUID();

    await developerFiles.attachProject(fixtureDir, ownerId);

    // 6a: Discovery of runtime without verified isolation attestation fails closed

    const prevBackend = process.env.AI_HELP_AGENT_TEST_BACKEND_URL;

    process.env.AI_HELP_AGENT_TEST_BACKEND_URL = 'http://127.0.0.1:9999';

    const discovered = discoverIsolationRuntimes(fixtureDir);

    const remote = discovered.find(c => c.providerId === 'remote_backend');

    if (remote) {

      assert.equal(remote.isolationVerified, false, 'Discovered remote runtime must not claim verified isolation without attestation.');

    }

    delete process.env.AI_HELP_AGENT_TEST_BACKEND_URL;

    if (prevBackend) process.env.AI_HELP_AGENT_TEST_BACKEND_URL = prevBackend;

    // 6b: Shell injection in command safety validation

    const shellInjectionPlan = {

      projectRoot: fixtureDir,

      binary: 'node',

      args: ['test; echo hacked'],

      planDigest: 'digest-1234',

    };

    const safetyResult = await executeInVerifiedSandbox({

      plan: shellInjectionPlan,

      ownerWebContentsId: ownerId,

      sessionId,

    });

    assert.equal(safetyResult.ok, false);

    assert.equal(safetyResult.gate, 'COMMAND_SAFETY_GATE');

    assert.equal(safetyResult.executionBlocked, true);

    assert.match(safetyResult.reason, /shell metacharacters/i);

    // 6c: Unauthorized escaping projectRoot (path traversal)

    const escapingPlan = {

      projectRoot: path.join(fixtureDir, '..', 'unauthorized-escape'),

      binary: 'node',

      args: ['-e', 'process.exit(0)'],

      planDigest: 'digest-1234',

    };

    const escapeResult = await executeInVerifiedSandbox({

      plan: escapingPlan,

      ownerWebContentsId: ownerId,

      sessionId,

    });

    assert.equal(escapeResult.ok, false);

    assert.equal(escapeResult.gate, 'AUTHORIZATION_GATE');

    assert.equal(escapeResult.executionBlocked, true);

    assert.match(escapeResult.reason, /authorization failed/i);

    // 6d: Missing / altered planDigest rejection

    const noDigestPlan = {

      projectRoot: fixtureDir,

      binary: 'node',

      args: ['-e', 'process.exit(0)'],

      planDigest: null,

    };

    const noDigestResult = await executeInVerifiedSandbox({

      plan: noDigestPlan,

      ownerWebContentsId: ownerId,

      sessionId,

    });

    assert.equal(noDigestResult.ok, false);

    assert.equal(noDigestResult.gate, 'APPROVAL_DIGEST_GATE');

    assert.equal(noDigestResult.executionBlocked, true);

    // 6e: Cancellation before execution

    const cancelController = new AbortController();

    cancelController.abort();

    const cancelledResult = await executeInVerifiedSandbox({

      plan: {

        projectRoot: fixtureDir,

        binary: 'node',

        args: ['-e', 'process.exit(0)'],

        planDigest: 'digest-valid-5678',

      },

      ownerWebContentsId: ownerId,

      sessionId,

      signal: cancelController.signal,

    });

    assert.equal(cancelledResult.ok, false);

    assert.equal(cancelledResult.status, 'CANCELLED');

    // 6f: Untrusted / simulated provenance rejection

    for (const badProvenance of ['mock', 'fixture', 'synthetic', 'simulated', 'guest-writable', 'untrusted-caller-input']) {

      const forgedProof = verifyIsolationEvidence({ provenance: badProvenance, sandbox: true });

      assert.equal(forgedProof.isVerified, false, `Provenance ${badProvenance} must be rejected.`);

      assert.equal(forgedProof.status, 'BLOCKED');

      assert.equal(forgedProof.gate, 'PROCESS_ISOLATION_GATE');

      assert.match(forgedProof.reason, /simulated or untrusted|rejected as proof/i);

    }

    // 6g: Missing, empty, or non-object isolation evidence rejection

    for (const badEvidence of [null, undefined, '', 123, [], {}]) {

      const missingProof = verifyIsolationEvidence(badEvidence);

      assert.equal(missingProof.isVerified, false);

      assert.equal(missingProof.status, 'BLOCKED');

      assert.equal(missingProof.gate, 'PROCESS_ISOLATION_GATE');

    }

    // 6h: Expired evidence rejection via executionEvidenceContract

    const { validateExecutionEvidenceManifest } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');

    const expiredManifest = {

      runId: 'run-1',

      providerId: 'container-provider',

      providerConfigRevision: 'rev-1',

      approvedSnapshotDigest: 'snap-1',

      approvedManifestDigest: 'man-1',

      verificationPlanDigest: 'plan-1',

      workerIdentity: 'worker-1',

      evidenceTimestamp: new Date(Date.now() - 10000).toISOString(),

      evidenceExpiry: new Date(Date.now() - 5000).toISOString(),

      provenance: 'provider-attested',

      trustClass: 'PROVIDER_ATTESTED',

    };

    const expiredValidation = validateExecutionEvidenceManifest(expiredManifest);

    assert.equal(expiredValidation.state, 'BLOCKED');

    assert.equal(expiredValidation.reasonCode, 'EVIDENCE_EXPIRED');

    // 6i: Unverified isolation fails closed without host execution fallback

    const fallbackTestPlan = {

      projectRoot: fixtureDir,

      binary: 'node',

      args: ['-e', 'process.exit(0)'],

      planDigest: 'digest-valid-5678',

    };

    const blockedExecution = await executeInVerifiedSandbox({

      plan: fallbackTestPlan,

      ownerWebContentsId: ownerId,

      sessionId,

      isolationEvidence: null,

    });

    assert.equal(blockedExecution.ok, false);

    assert.equal(blockedExecution.status, 'BLOCKED');

    assert.equal(blockedExecution.gate, 'PROCESS_ISOLATION_GATE');

    assert.equal(blockedExecution.executionBlocked, true);

    assert.match(blockedExecution.reason, /(?:verified process isolation is required|manifest is missing or malformed)/i);



    // 6j: Host WSL accessibility alone does not grant per-workload isolation proof

    for (const wslClaim of [

      { hostWslAccessible: true },

      { wslInstalled: true, defaultDistro: 'Ubuntu' },

      { hostMandatoryLevel: 'High', wslStatus: 'OK' },

    ]) {

      const wslEvidenceCheck = verifyIsolationEvidence(wslClaim);

      assert.equal(wslEvidenceCheck.isVerified, false, 'Host WSL access must not be accepted as isolation evidence without attested broker.');

      assert.equal(wslEvidenceCheck.status, 'BLOCKED');

      assert.equal(wslEvidenceCheck.gate, 'PROCESS_ISOLATION_GATE');

    }



    // 6k: An unverified WSL distribution remains fail-closed at the execution gate

    assert.throws(

      () => requireProjectProcessIsolation(

        'WSL unverified execution check',

        {

          runId: 'wsl-unverified-run',

          providerId: 'wsl-distro',

          providerConfigRevision: 'v2',

          approvedSnapshotDigest: 'd'.repeat(64),

          approvedManifestDigest: 'e'.repeat(64),

          verificationPlanDigest: 'f'.repeat(64),

          workerIdentity: 'wsl-ubuntu-worker',

          evidenceTimestamp: new Date().toISOString(),

          evidenceExpiry: new Date(Date.now() + 60_000).toISOString(),

          provenance: 'untrusted-caller-input',

          trustClass: 'UNTRUSTED',

        },

      ),

      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED'

        && err.executionBlocked === true

        && err.executionStatus === 'BLOCKED',

    );



    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;

    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});

  }

  // -------------------------------------------------------------------------

  // 7. Windows Sandbox Provider Adapter Configuration, Capabilities & Lifecycle (V41)

  // -------------------------------------------------------------------------

  console.log('7. Testing Windows Sandbox Provider Adapter Configuration, Capabilities & Lifecycle...');

  {

    const windowsSandboxProvider = require('../electron/coding-pipeline/windowsSandboxProviderAdapter.cjs');

    const providerAdapterContract = require('../electron/coding-pipeline/providerAdapterContract.cjs');

    const {

      DISABLED_REASON,

      buildWindowsSandboxConfiguration,

      createWindowsSandboxHostLifecycle,

      createWindowsSandboxProviderAdapter,

    } = windowsSandboxProvider;

    // 7a: WSB XML configuration generation and constraints

    const fixtureDir = await makeTempDir('wsb-adapter-test-');

    const controlDir = path.join(fixtureDir, 'control');

    const outputDir = path.join(fixtureDir, 'output');

    await fs.mkdir(controlDir);

    await fs.mkdir(outputDir);

    await fs.writeFile(path.join(controlDir, 'synthetic-probe.txt'), 'synthetic\n', 'utf8');

    try {

      const configuration = await buildWindowsSandboxConfiguration({

        temporaryRoot: fixtureDir,

        controlDirectory: controlDir,

        outputDirectory: outputDir,

      });

      assert.match(configuration, /<Networking>Disable<\/Networking>/);

      assert.match(configuration, /<MemoryInMB>1024<\/MemoryInMB>/);

      assert.match(configuration, /<VGpu>Disable<\/VGpu>/);

      assert.match(configuration, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);

      assert.match(configuration, /<PrinterRedirection>Disable<\/PrinterRedirection>/);

      assert.match(configuration, /<AudioInput>Disable<\/AudioInput>/);

      assert.match(configuration, /<VideoInput>Disable<\/VideoInput>/);

      assert.match(configuration, /<ProtectedClient>Enable<\/ProtectedClient>/);

      assert.match(configuration, /<ReadOnly>true<\/ReadOnly>/);

      assert.match(configuration, /<ReadOnly>false<\/ReadOnly>/);

      assert.equal((configuration.match(/<MappedFolder>/g) || []).length, 2);

      assert.ok(!configuration.includes(path.resolve(process.cwd())));

      await assert.rejects(

        buildWindowsSandboxConfiguration({ temporaryRoot: fixtureDir, controlDirectory: controlDir, outputDirectory: outputDir, xml: '<Configuration />' }),

        /unsupported options.*xml/i,

      );

      await assert.rejects(

        buildWindowsSandboxConfiguration({ temporaryRoot: fixtureDir, controlDirectory: controlDir, outputDirectory: outputDir, projectRoot: process.cwd() }),

        /unsupported options.*projectRoot/i,

      );

      await assert.rejects(

        buildWindowsSandboxConfiguration({ temporaryRoot: fixtureDir, controlDirectory: controlDir, outputDirectory: path.join(fixtureDir, '..', 'outside') }),

        /direct child/i,

      );

      await assert.rejects(

        buildWindowsSandboxConfiguration({ temporaryRoot: fixtureDir, controlDirectory: controlDir, outputDirectory: outputDir, memoryInMB: 64 }),

        /memory must be an integer/i,

      );

    } finally {

      await fs.rm(fixtureDir, { recursive: true, force: true });

    }

    // 7b: Adapter capabilities and untrusted claims

    const adapter = createWindowsSandboxProviderAdapter();

    assert.equal(adapter.getProviderId(), 'windows-sandbox');

    assert.equal(adapter.getCapabilities().configured, false);

    assert.equal(adapter.getCapabilities().runtimeAvailable, false);

    assert.equal(adapter.getCapabilities().independentlyVerified, false);

    assert.match(adapter.getCapabilities().disabledReason, /handle release/i);

    assert.equal(adapter.getCapabilities().capabilityStates.osEnforcedProcessIsolation, 'BLOCKED');

    for (const capability of providerAdapterContract.ISOLATION_CAPABILITIES.filter(c => c !== 'osEnforcedProcessIsolation')) {

      assert.equal(adapter.getCapabilities().capabilityStates[capability], 'NOT_ESTABLISHED');

    }

    assert.equal(adapter.prepareRunEvidence({ runId: 'test-run' }).evidenceState.state, 'BLOCKED');

    const allSupportedClaims = Object.fromEntries(

      providerAdapterContract.ISOLATION_CAPABILITIES.map((name) => [name, 'SUPPORTED']),

    );

    const untrustedCapabilityAdapter = providerAdapterContract.createProviderAdapter({

      getProviderId: () => 'untrusted-capability-claims',

      getConfigRevision: () => 'fixture',

      getCapabilities: () => ({ capabilityStates: allSupportedClaims }),

    });

    assert.ok(Object.values(untrustedCapabilityAdapter.getCapabilities().capabilityStates)

      .every((state) => state === 'NOT_ESTABLISHED'));

    assert.throws(

      () => providerAdapterContract.createCapabilityStateMap({ osEnforcedProcessIsolation: 'VERIFIED' }),

      /Invalid state/,

    );

    // 7c: Forged guest result classification

    const forgedGuestResult = adapter.collectHostObservedResult({

      guestOutputs: ['guest says successful'],

      guestCleanupReports: [{ resourceDeleted: true, cleanupVerified: true }],

      guestFiles: [{ name: 'cleanup.json', resourceDeleted: true }],

    });

    assert.equal(forgedGuestResult.classification, 'BLOCKED');

    assert.deepEqual(forgedGuestResult.envelope.appVerifiedFacts, {});

    assert.deepEqual(forgedGuestResult.envelope.acceptedEvidence, {});

    assert.equal(forgedGuestResult.envelope.untrustedWorkerClaims.length, 3);

    assert.notEqual(forgedGuestResult.evaluation.state, 'EXECUTION_AUTHORIZED');

    // 7d: Host lifecycle clean shutdown observation

    const safeRoot = await makeTempDir('wsb-lifecycle-test-');

    let removed = false;

    let observedRunId;

    const lifecycle = createWindowsSandboxHostLifecycle({

      createTemporaryRoot: async () => safeRoot,

      observeShutdown: async ({ process, runId }) => {

        observedRunId = runId;

        return {

          source: 'host-process-inspection',

          runId,

          launcherPid: process.pid,

          launcherTerminated: true,

          sandboxClientsRemaining: 0,

          ownedSandboxProcessCount: 0,

          sandboxResourceAbsent: true,

          sandboxHandlesReleased: true,

        };

      },

      removeTemporaryRoot: async (temporaryRoot) => {

        assert.equal(temporaryRoot, safeRoot);

        await fs.rm(temporaryRoot, { recursive: true, force: false });

        removed = true;

      },

      verifyTemporaryRootRemoved: async (temporaryRoot) => {

        try {

          await fs.lstat(temporaryRoot);

          return false;

        } catch (error) {

          if (error.code === 'ENOENT') return true;

          throw error;

        }

      },

    });

    const resource = await lifecycle.createResource({ runId: 'host-observed-run' });

    lifecycle.markLaunchStarting(resource);

    lifecycle.markLauncherStarted(resource, { pid: 742 });

    const cleanup = await lifecycle.cleanup(resource);

    assert.equal(observedRunId, 'host-observed-run');

    assert.equal(removed, true);

    assert.equal(cleanup.launcherTerminated, true);

    assert.equal(cleanup.sandboxClientsRemaining, 0);

    assert.equal(cleanup.sandboxHandlesReleased, true);

    assert.equal(cleanup.stagingDirectoryDeleted, true);

    assert.equal(cleanup.cleanupVerified, true);

    assert.equal(cleanup.resourceDeleted, true);

    // 7e: Unreleased handles quarantine & lease retention

    const uncertainRoot = await makeTempDir('wsb-quarantine-test-');

    let uncertainRemovalAttempted = false;

    const uncertainLifecycle = createWindowsSandboxHostLifecycle({

      createTemporaryRoot: async () => uncertainRoot,

      observeShutdown: async ({ process, runId }) => ({

        source: 'host-process-inspection',

        runId,

        launcherPid: process.pid,

        launcherTerminated: true,

        sandboxClientsRemaining: 0,

        ownedSandboxProcessCount: 0,

        sandboxResourceAbsent: true,

        sandboxHandlesReleased: false,

      }),

      removeTemporaryRoot: async () => {

        uncertainRemovalAttempted = true;

        await fs.rm(uncertainRoot, { recursive: true, force: false });

      },

      verifyTemporaryRootRemoved: async () => true,

    });

    const uncertainResource = await uncertainLifecycle.createResource({ runId: 'uncertain-run' });

    uncertainLifecycle.markLaunchStarting(uncertainResource);

    uncertainLifecycle.markLauncherStarted(uncertainResource, { pid: 743 });

    await assert.rejects(uncertainLifecycle.cleanup(uncertainResource), /handle release/i);

    assert.equal(uncertainRemovalAttempted, false);

    assert.equal(uncertainLifecycle.getStatus(uncertainResource).quarantined, true);

    assert.equal(uncertainLifecycle.getStatus(uncertainResource).leaseActive, true);

    await assert.rejects(uncertainLifecycle.createResource({ runId: 'blocked-next-run' }), /still active or quarantined/i);

    await fs.rm(uncertainRoot, { recursive: true, force: true });

  }

  // -------------------------------------------------------------------------

  // 8. Windows Sandbox Authorization, Process Containment & Gate Coverage (V41)

  // -------------------------------------------------------------------------

  console.log('8. Testing Windows Sandbox Authorization, Process Containment & Gate Coverage...');

  {

    const childProcess = require('node:child_process');

    const originalSpawn = childProcess.spawn;

    const spawnAttempts = [];

    childProcess.spawn = (...args) => {

      spawnAttempts.push(args);

      throw new Error('Unexpected subprocess attempt in fail-closed fixture.');

    };

    const sandboxRunner = require('../electron/coding-pipeline/windowsSandboxRunner.cjs');

    const projectIsolation = require('../electron/coding-pipeline/projectProcessIsolation.cjs');

    const providerAdapterContract = require('../electron/coding-pipeline/providerAdapterContract.cjs');

    const { DevServerManager } = require('../electron/coding-pipeline/environment.cjs');

    const developerFilesSource = await fs.readFile(

      path.join(process.cwd(), 'electron/developerFiles.cjs'),

      'utf8',

    );

    const environmentSource = await fs.readFile(

      path.join(process.cwd(), 'electron/coding-pipeline/environment.cjs'),

      'utf8',

    );

    const sandboxRunnerSource = await fs.readFile(

      path.join(process.cwd(), 'electron/coding-pipeline/windowsSandboxRunner.cjs'),

      'utf8',

    );

    const mainSource = await fs.readFile(

      path.join(process.cwd(), 'electron/main.cjs'),

      'utf8',

    );

    const projectIsolationSource = await fs.readFile(

      path.join(process.cwd(), 'electron/coding-pipeline/projectProcessIsolation.cjs'),

      'utf8',

    );

    try {

      // 8a: Untrusted authorization objects rejected

      const untrustedAuthorizations = [

        undefined,

        null,

        'renderer-supplied-value',

        Object.freeze({ authorized: true, verified: true, capabilityStates: { osEnforcedProcessIsolation: 'SUPPORTED' } }),

        Object.freeze({

          state: 'approved',

          approved: true,

          projectRoot: 'C:\synthetic-project',

          scope: '.',

          verificationAttempt: 1,

        }),

      ];

      for (const authorization of untrustedAuthorizations) {

        await assert.rejects(

          sandboxRunner.runWindowsSandboxCommand({

            projectRoot: 'C:\synthetic-project',

            executable: 'npm.cmd',

            args: ['run', 'test'],

            authorization,

          }),

          /Windows Sandbox project command authorization is unavailable/,

        );

      }

      // 8b: Forged capability claims rejected

      const forgedCapabilityClaims = {

        independentlyVerified: true,

        humanApproved: true,

        syntheticValidationPassed: true,

        executionAuthorized: true,

        identityIsolation: true,

        credentialIsolation: true,

        egressControl: true,

        resourceLimits: true,

        runtimeCap: true,

        outputCap: true,

        cancellation: true,

        cleanupEvidence: true,

        capabilityStates: Object.fromEntries(

          providerAdapterContract.ISOLATION_CAPABILITIES.map((name) => [name, 'SUPPORTED']),

        ),

      };

      assert.throws(

        () => projectIsolation.requireProjectProcessIsolation(

          'Forged authorization regression test',

          {

            runId: 'forged-run',

            providerId: 'windows-sandbox',

            providerConfigRevision: 'current',

            approvedSnapshotDigest: 'a'.repeat(64),

            approvedManifestDigest: 'b'.repeat(64),

            verificationPlanDigest: 'c'.repeat(64),

            workerIdentity: 'forged-worker',

            evidenceTimestamp: new Date().toISOString(),

            evidenceExpiry: new Date(Date.now() + 60_000).toISOString(),

            provenance: 'INDEPENDENTLY_OBSERVED',

            trustClass: 'INDEPENDENTLY_OBSERVED',

          },

          { runId: 'forged-run' },

          forgedCapabilityClaims,

        ),

        (error) => error.code === 'PROJECT_EXECUTION_BLOCKED'

          && error.executionBlocked === true

          && error.executionStatus === 'BLOCKED',

      );

      // 8c: DevServerManager blocks execution

      await assert.rejects(

        new DevServerManager().startDevServer('fixture-task', 'C:\synthetic-project'),

        (error) => error.code === 'PROJECT_EXECUTION_BLOCKED' && error.executionBlocked === true,

      );

      // 8d: Source containment and gate checks

      const runVerification = developerFilesSource.indexOf('async function runVerification(');

      const outerGate = developerFilesSource.indexOf("requireProjectProcessIsolation('Project verification')", runVerification);

      const workspaceCall = developerFilesSource.indexOf('runVerificationInWorkspace(', runVerification);

      assert.ok(runVerification >= 0 && outerGate > runVerification && workspaceCall > outerGate);

      const workspaceStart = developerFilesSource.indexOf('async function runVerificationInWorkspace(');

      const workspaceEnd = developerFilesSource.indexOf('async function getVerificationScripts(', workspaceStart);

      const workspaceSource = developerFilesSource.slice(workspaceStart, workspaceEnd);

      for (const spawnNeedle of [

        'spawn(process.env.ComSpec',

        'spawn(phpCommand.executable',

        'spawn(commandSpec.executable',

        "spawn(executable, ['run', script]",

        "spawn('git', args",

      ]) {

        const spawnIndex = workspaceSource.indexOf(spawnNeedle);

        assert.ok(spawnIndex >= 0, `Expected execution route ${spawnNeedle}.`);

        assert.ok(

          workspaceSource.lastIndexOf('requireProjectProcessIsolation(', spawnIndex) >= 0,

          `Missing shared gate before ${spawnNeedle}.`,

        );

      }

      const gitInspectionStart = developerFilesSource.indexOf('async function runGit(');

      const gitInspectionEnd = developerFilesSource.indexOf('const detectProjectType', gitInspectionStart);

      const gitInspectionSource = developerFilesSource.slice(gitInspectionStart, gitInspectionEnd);

      const gitGate = gitInspectionSource.indexOf("requireProjectProcessIsolation('Project Git inspection')");

      const gitSpawn = gitInspectionSource.indexOf("spawn('git'");

      assert.ok(gitGate >= 0 && gitSpawn > gitGate);

      const changedPhpStart = developerFilesSource.indexOf('async function findChangedPhpFiles(');

      const changedPhpEnd = developerFilesSource.indexOf('async function ', changedPhpStart + 1);

      const changedPhpSource = developerFilesSource.slice(changedPhpStart, changedPhpEnd);

      const changedPhpGate = changedPhpSource.indexOf("requireProjectProcessIsolation('PHP changed-file inspection')");

      const changedPhpSpawn = changedPhpSource.indexOf("spawn('git'");

      assert.ok(changedPhpGate >= 0 && changedPhpSpawn > changedPhpGate);

      const toolHandler = mainSource.indexOf("ipcMain.handle('developer:tool'");

      const directVerificationHandler = mainSource.indexOf("ipcMain.handle('developer:run-verification'");

      const proposalApplyHandler = mainSource.indexOf("ipcMain.handle('developer:proposal-apply'");

      const devServerHandler = mainSource.indexOf("ipcMain.handle('developer:dev-server-manage'");

      assert.ok(toolHandler >= 0

        && mainSource.indexOf('terminalRunner.runCheck(script, event.sender.id)', toolHandler) > toolHandler);

      assert.ok(directVerificationHandler >= 0

        && mainSource.indexOf('terminalRunner.runCheck(script, event.sender.id)', directVerificationHandler) > directVerificationHandler);

      assert.ok(proposalApplyHandler >= 0

        && mainSource.indexOf('runCheck: (script) => terminalRunner.runCheck', proposalApplyHandler) > proposalApplyHandler);

      assert.ok(devServerHandler >= 0

        && mainSource.indexOf('developerAgent.manageDevServer', devServerHandler) > devServerHandler);

      const sandboxEntry = sandboxRunnerSource.indexOf('async function runWindowsSandboxCommand(');

      const sandboxAuthorization = sandboxRunnerSource.indexOf('projectCommandAuthorizations.has(authorization)', sandboxEntry);

      const sandboxGate = sandboxRunnerSource.indexOf("requireProjectProcessIsolation('Windows Sandbox project command')", sandboxEntry);

      const sandboxSpawn = sandboxRunnerSource.indexOf('spawn(SANDBOX_EXECUTABLE', sandboxEntry);

      assert.ok(sandboxEntry >= 0

        && sandboxAuthorization > sandboxEntry

        && sandboxGate > sandboxAuthorization

        && sandboxSpawn > sandboxGate);

      assert.match(

        projectIsolationSource,

        /process\.platform === 'win32' \|\| !status\.available \|\| !status\.verified/,

      );

      assert.equal(spawnAttempts.length, 0, 'Zero subprocesses must be spawned during fail-closed security evaluation.');

    } finally {

      childProcess.spawn = originalSpawn;

    }

  }

  // -------------------------------------------------------------------------

  // 9. Windows Sandbox Cleanup Report Schema, Evaluation & Guest Attestation (V41)

  // -------------------------------------------------------------------------

  console.log('9. Testing Windows Sandbox Cleanup Report Schema, Evaluation & Guest Attestation...');

  {

    const sandboxRunner = require('../electron/coding-pipeline/windowsSandboxRunner.cjs');

    const evidenceContract = require('../electron/coding-pipeline/executionEvidenceContract.cjs');

    const { parseSandboxCleanupOutcome } = sandboxRunner;

    const runId = 'synthetic-run-9e418e';

    const validOutcome = {

      version: 1,

      runId,

      complete: true,

      accountCleanup: 'succeeded',

      shutdownCommand: 'succeeded',

    };

    assert.deepEqual(parseSandboxCleanupOutcome(JSON.stringify(validOutcome), runId), validOutcome);

    assert.deepEqual(parseSandboxCleanupOutcome(JSON.stringify({

      ...validOutcome,

      accountCleanup: 'failed',

      shutdownCommand: 'failed',

    }), runId), {

      ...validOutcome,

      accountCleanup: 'failed',

      shutdownCommand: 'failed',

    });

    for (const key of Object.keys(validOutcome)) {

      const missingProperty = { ...validOutcome };

      delete missingProperty[key];

      assert.equal(parseSandboxCleanupOutcome(JSON.stringify(missingProperty), runId), null, `missing ${key}`);

    }

    assert.equal(parseSandboxCleanupOutcome(JSON.stringify({ ...validOutcome, extra: true }), runId), null);

    assert.equal(parseSandboxCleanupOutcome(JSON.stringify(validOutcome), 'different-run'), null);

    assert.equal(parseSandboxCleanupOutcome('null', runId), null);

    assert.equal(parseSandboxCleanupOutcome('[]', runId), null);

    for (const [key, value] of [

      ['version', 1.5],

      ['version', '1'],

      ['complete', false],

      ['accountCleanup', 'unknown'],

      ['shutdownCommand', null],

    ]) {

      assert.equal(

        parseSandboxCleanupOutcome(JSON.stringify({ ...validOutcome, [key]: value }), runId),

        null,

        `invalid ${key}=${String(value)}`,

      );

    }

    assert.throws(() => parseSandboxCleanupOutcome('{malformed', runId), SyntaxError);

    // Guest cleanup failure evaluation

    const projectResult = {

      exitCode: 0,

      timedOut: false,

      cancelled: false,

      stderr: '',

      runId,

      executionResultAuthenticated: false,

      hostLifecycleObservation: null,

      cleanupOutcome: {

        ...validOutcome,

        accountCleanup: 'failed',

        shutdownCommand: 'failed',

      },

    };

    const evaluatedResult = developerFiles.applyWindowsCleanupOutcome(projectResult);

    assert.equal(evaluatedResult.ok, false);

    assert.equal(evaluatedResult.exitCode, 0);

    assert.match(evaluatedResult.cleanupError, /Guest account cleanup failed/);

    assert.match(evaluatedResult.cleanupError, /Guest shutdown command failed/);

    // Guest claims without host observation fail closed

    const guestClaimsOnly = developerFiles.applyWindowsCleanupOutcome({

      runId,

      exitCode: 0,

      timedOut: false,

      cancelled: false,

      stderr: '',

      executionResultAuthenticated: true,

      cleanupOutcome: validOutcome,

    });

    assert.equal(guestClaimsOnly.ok, false);

    assert.match(guestClaimsOnly.cleanupError, /Host-observed Windows Sandbox termination/i);

    // Host cleanup observed but guest result channel writable fails closed

    const hostCleanupButNoAuth = developerFiles.applyWindowsCleanupOutcome({

      runId,

      exitCode: 0,

      timedOut: false,

      cancelled: false,

      stderr: '',

      executionResultAuthenticated: true,

      hostLifecycleObservation: {

        runId,

        launcherTerminated: true,

        sandboxClientsRemaining: 0,

        stagingDirectoryRemoved: true,

        cleanupVerified: true,

        resourceDeleted: true,

      },

      cleanupOutcome: validOutcome,

    });

    assert.equal(hostCleanupButNoAuth.ok, false);

    assert.match(hostCleanupButNoAuth.cleanupError, /guest result channel is writable by the guest/i);

    // Untrusted guest result envelope

    const guestOnlyEnvelope = evidenceContract.createResultEnvelope({

      untrustedWorkerClaims: [JSON.stringify(validOutcome)],

      providerObservedState: {

        hostLifecycleObservation: {

          runId,

          launcherTerminated: true,

          sandboxClientsRemaining: 0,

          stagingDirectoryRemoved: true,

        },

      },

    });

    const guestOnlyDecision = evidenceContract.evaluateResultEnvelope(guestOnlyEnvelope);

    assert.equal(guestOnlyDecision.state, 'UNCERTAIN');

    assert.equal(guestOnlyDecision.reasonCode, 'UNTRUSTED_WORKER_OUTPUT');

  }

  // -------------------------------------------------------------------------

  // 10. Windows Sandbox Failure Propagation, Aggregate Errors & Audit Logging (V41)

  // -------------------------------------------------------------------------

  console.log('10. Testing Windows Sandbox Failure Propagation, Aggregate Errors & Audit Logging...');

  {

    const sandboxRunner = require('../electron/coding-pipeline/windowsSandboxRunner.cjs');

    // 10a: Aggregate error combining run failure and cleanup failure

    const runFailure = new Error('synthetic command failure');

    const cleanupFailure = new Error('synthetic cleanup failure');

    const combinedFailure = sandboxRunner.combineSandboxRunAndCleanupFailures(runFailure, cleanupFailure);

    assert.ok(combinedFailure instanceof AggregateError);

    assert.deepEqual(combinedFailure.errors, [runFailure, cleanupFailure]);

    assert.equal(combinedFailure.isolationFailure, true);

    assert.match(combinedFailure.message, /synthetic command failure/);

    assert.match(combinedFailure.message, /synthetic cleanup failure/);

    const runnerSource = await fs.readFile(

      path.join(process.cwd(), 'electron/coding-pipeline/windowsSandboxRunner.cjs'),

      'utf8',

    );

    assert.match(runnerSource, /runFailed = true;[\s\S]*?runFailure = error;/);

    assert.match(runnerSource, /if \(runFailed\) \{\s*throw combineSandboxRunAndCleanupFailures\(runFailure, error\);/);

    assert.match(runnerSource, /if \(runFailed\) throw runFailure;/);

    // 10b: Audit propagation on cleanup failure

    const tempAuditRoot = await makeTempDir('wsb-failure-audit-');

    const projRoot = path.join(tempAuditRoot, 'project');

    const auditDir = path.join(tempAuditRoot, 'audit');

    await fs.mkdir(projRoot);

    const rootKey = crypto.createHash('sha256').update(path.resolve(projRoot)).digest('hex');

    const auditFile = path.join(auditDir, `${rootKey}.jsonl`);

    try {

      developerFiles.configureAuditDirectory(auditDir);

      const testCleanupFailure = Object.assign(new Error('Synthetic lifecycle cleanup failure.'), {

        isolationFailure: true,

      });

      let propagatedFailure;

      try {

        await developerFiles.auditAndPropagateWindowsSandboxFailure(

          projRoot,

          'test',

          testCleanupFailure,

        );

      } catch (error) {

        propagatedFailure = error;

      }

      assert.ok(propagatedFailure instanceof Error);

      assert.equal(propagatedFailure.cause, testCleanupFailure);

      assert.match(propagatedFailure.message, /Windows Sandbox verification failed closed/);

      const auditLines = (await fs.readFile(auditFile, 'utf8')).trim().split(/\r?\n/);

      assert.equal(auditLines.length, 1);

      assert.match(auditLines[0], /tool=run_command/);

      assert.match(auditLines[0], /target="test"/);

      assert.match(auditLines[0], /result=failure:cleanup/);

      // Inaccessible audit directory produces AggregateError

      const blockedAuditPath = path.join(tempAuditRoot, 'not-a-directory');

      await fs.writeFile(blockedAuditPath, 'fixture');

      developerFiles.configureAuditDirectory(blockedAuditPath);

      const secondCleanupFailure = Object.assign(new Error('Second synthetic cleanup failure.'), {

        isolationFailure: true,

      });

      let secondCombinedFailure;

      try {

        await developerFiles.auditAndPropagateWindowsSandboxFailure(

          projRoot,

          'test',

          secondCleanupFailure,

        );

      } catch (error) {

        secondCombinedFailure = error;

      }

      assert.ok(secondCombinedFailure instanceof AggregateError);

      assert.equal(secondCombinedFailure.errors[0], secondCleanupFailure);

      assert.ok(secondCombinedFailure.errors[1] instanceof Error);

      assert.match(secondCombinedFailure.message, /Second synthetic cleanup failure/);

      assert.match(secondCombinedFailure.message, /failure audit could not be recorded/);

    } finally {

      developerFiles.configureAuditDirectory(null);

      await fs.rm(tempAuditRoot, { recursive: true, force: true });

    }

  }


  // -------------------------------------------------------------------------
  // 11. WSL Provider Feasibility, Capability Descriptors & Fail-Closed Gate (V44)
  // -------------------------------------------------------------------------
  console.log('11. Testing WSL Provider Feasibility, Capability Descriptors & Fail-Closed Gate...');
  {
    const { WslIsolationProvider, createWslIsolationProvider } = require('../electron/developerAgent.cjs');
    assert.equal(typeof WslIsolationProvider, 'function', 'WslIsolationProvider constructor must be exported');
    assert.equal(typeof createWslIsolationProvider, 'function', 'createWslIsolationProvider factory must be exported');

    const provider = createWslIsolationProvider();
    assert.equal(provider.providerId, 'wsl-isolation-provider');
    assert.deepEqual(provider.supportedPlatforms, ['win32']);

    const caps = await provider.discoverCapabilities();
    assert.equal(caps.providerId, 'wsl-isolation-provider');
    // Security Invariant: Default WSL is NOT ready / verified isolation
    assert.equal(caps.isReady, false, 'WSL isolation provider must fail-closed with isReady = false');
    assert.equal(caps.capabilityVerificationStatus, process.platform === 'win32' ? 'BLOCKED' : 'UNSUPPORTED');
    assert.equal(caps.filesystemCapabilities.restrictedBindMounts, false, 'Default WSL mounts /mnt/c and lacks restricted bind mounts');
    assert.equal(caps.filesystemCapabilities.ephemeralCopyOnWrite, false, 'Default WSL distros persist state in ext4.vhdx');
    assert.equal(caps.filesystemCapabilities.secureErasureOnExit, false, 'Default WSL lacks automated secure erasure');
    assert.equal(caps.networkCapabilities.defaultDenyAll, false, 'Default WSL has open outbound NAT networking');
    assert.equal(caps.networkCapabilities.egressFiltering, false, 'Default WSL lacks guest egress filtering');
    assert.equal(caps.processCapabilities.credentialIsolation, false, 'Default WSL shares host user and PATH interop');
    assert.equal(caps.processCapabilities.userNamespaceRemapping, false, 'Default WSL runs as default distro user');
    assert.ok(Array.isArray(caps.unverifiedRequirements), 'unverifiedRequirements must be an array');
    assert.ok(caps.unverifiedRequirements.length >= 6, 'Must list all 6 unverified isolation requirements');
    assert.ok(caps.unverifiedRequirements.some(r => r.includes('network egress')), 'Must note unverified network egress denial');
    assert.ok(caps.unverifiedRequirements.some(r => r.includes('/mnt/c')), 'Must note unverified /mnt/c mount restriction');
    assert.ok(caps.unverifiedRequirements.some(r => r.includes('worker identity')), 'Must note unverified worker identity binding');
    assert.ok(caps.unverifiedRequirements.some(r => r.includes('cleanup')), 'Must note unverified process cleanup attestation');

    // 11b: Runtime discovery includes WSL candidate on win32 marked unverified and registered in defaultRegistry
    if (process.platform === 'win32') {
      const runtimes = discoverIsolationRuntimes(process.cwd());
      const wslCandidate = runtimes.find(r => r.providerId === 'wsl');
      assert.ok(wslCandidate, 'WSL runtime candidate must be discovered on Windows');
      assert.equal(wslCandidate.isolationVerified, false, 'WSL candidate isolation must NOT be verified by discovery alone');
      assert.match(wslCandidate.limitations, /WSL unverified/);

      const { defaultRegistry } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');
      const registeredWsl = defaultRegistry.getProvider('wsl-isolation-provider');
      assert.ok(registeredWsl, 'WSL provider must be registered in defaultRegistry');
      assert.equal(registeredWsl.isReady, false, 'Registered WSL provider must fail closed (isReady: false)');
      assert.equal(registeredWsl.capabilityVerificationStatus, 'BLOCKED');
      const aliasWsl = defaultRegistry.getProvider('wsl');
      assert.strictEqual(aliasWsl, registeredWsl, 'Alias "wsl" must resolve to canonical WSL provider descriptor');
      const wslEntries = defaultRegistry.getAllProviders().filter(p => p.providerId === 'wsl-isolation-provider');
      assert.equal(wslEntries.length, 1, 'Registry must not contain duplicate WSL provider registrations');
    }

    // 11c: Evidence verification rejects forged booleans, missing bindings, and wrong provider
    const nullRes = provider.verifyEvidence(null);
    assert.equal(nullRes.verified, false);
    assert.equal(nullRes.status, 'BLOCKED');

    const forgedRes1 = provider.verifyEvidence({ sandbox: true });
    assert.equal(forgedRes1.verified, false);
    assert.match(forgedRes1.reason, /Caller-supplied Boolean flag/);

    const forgedRes2 = provider.verifyEvidence({ isolationVerified: true });
    assert.equal(forgedRes2.verified, false);
    assert.match(forgedRes2.reason, /Caller-supplied Boolean flag/);

    const forgedRes3 = provider.verifyEvidence({ hostWslAccessible: true });
    assert.equal(forgedRes3.verified, false);
    assert.match(forgedRes3.reason, /Caller-supplied Boolean flag/);

    const wrongProvRes = provider.verifyEvidence({ providerId: 'other-provider' });
    assert.equal(wrongProvRes.verified, false);
    assert.match(wrongProvRes.reason, /expected "wsl-isolation-provider"/);

    // 11d: Mandatory attestations required
    const partialEvidence = {
      providerId: 'wsl-isolation-provider',
      workerIdentity: 'unprivileged-wsl-worker',
      // missing networkDenyAttested, hostMountsStripped, ephemeralWorkspaceCleaned, approvedSnapshotDigest, verificationPlanDigest
    };
    const missingAttestRes = provider.verifyEvidence(partialEvidence);
    assert.equal(missingAttestRes.verified, false);
    assert.match(missingAttestRes.reason, /missing mandatory security attestation: networkDenyAttested/);

    // 11e: Expired evidence rejected
    const expiredEvidence = {
      providerId: 'wsl-isolation-provider',
      workerIdentity: 'unprivileged-wsl-worker',
      networkDenyAttested: true,
      hostMountsStripped: true,
      ephemeralWorkspaceCleaned: true,
      approvedSnapshotDigest: 'sha256-approved-snap',
      verificationPlanDigest: 'sha256-plan-digest',
      evidenceExpiry: new Date(Date.now() - 60000).toISOString(),
    };
    const expiredRes = provider.verifyEvidence(expiredEvidence);
    assert.equal(expiredRes.verified, false);
    assert.match(expiredRes.reason, /expired/);

    // 11f: Valid attested evidence accepted
    const validEvidence = {
      ...expiredEvidence,
      evidenceExpiry: new Date(Date.now() + 60000).toISOString(),
    };
    const validRes = provider.verifyEvidence(validEvidence);
    assert.equal(validRes.verified, true);
    assert.equal(validRes.evidenceVerified, true);
    assert.equal(validRes.status, 'CAPABILITY_VERIFIED');
    assert.equal(validRes.schemaValid, true);
    assert.equal(validRes.digestMatched, true);
    assert.equal(validRes.osIsolationVerified, false, 'Schema validity must not be mistaken for OS-level isolation');
    assert.equal(validRes.executionAuthorized, false, 'Schema-valid evidence must not authorize live execution');
    assert.equal(validRes.liveExecutionBlocked, true);

    // Invariant checks on failure returns
    assert.equal(nullRes.schemaValid, false);
    assert.equal(nullRes.osIsolationVerified, false);
    assert.equal(nullRes.executionAuthorized, false);
    assert.equal(nullRes.liveExecutionBlocked, true);

    // 11h: Readiness evaluation remains blocked
    const readiness = await provider.evaluateReadiness();
    assert.equal(readiness.isReady, false);
    assert.equal(readiness.status, process.platform === 'win32' ? 'BLOCKED' : 'UNSUPPORTED');
    assert.ok(readiness.blockingReasons.length > 0);

    // 11i: Untrusted provenance & trustClass rejected
    const untrustedSourceRes = provider.verifyEvidence({
      ...validEvidence,
      provenance: 'untrusted-caller-input',
    });
    assert.equal(untrustedSourceRes.verified, false);
    assert.match(untrustedSourceRes.reason, /simulated or untrusted/);

    const untrustedClassRes = provider.verifyEvidence({
      ...validEvidence,
      trustClass: 'UNTRUSTED',
    });
    assert.equal(untrustedClassRes.verified, false);
    assert.match(untrustedClassRes.reason, /trustClass is UNTRUSTED/);

    // 11j: Approval digest binding mismatch rejected
    const mismatchedDigestRes = provider.verifyEvidence(validEvidence, {
      approvedSnapshotDigest: 'different-snapshot-digest',
    });
    assert.equal(mismatchedDigestRes.verified, false);
    assert.equal(mismatchedDigestRes.schemaValid, true);
    assert.equal(mismatchedDigestRes.digestMatched, false);
    assert.equal(mismatchedDigestRes.executionAuthorized, false);
    assert.equal(mismatchedDigestRes.liveExecutionBlocked, true);
    assert.match(mismatchedDigestRes.reason, /does not match requested policy digest/);

    const mismatchedManifestRes = provider.verifyEvidence(validEvidence, {
      approvedManifestDigest: 'different-manifest-digest',
    });
    assert.equal(mismatchedManifestRes.verified, false);
    assert.match(mismatchedManifestRes.reason, /approvedManifestDigest does not match requested policy digest/);

    const mismatchedPlanRes = provider.verifyEvidence(validEvidence, {
      verificationPlanDigest: 'different-plan-digest',
    });
    assert.equal(mismatchedPlanRes.verified, false);
    assert.match(mismatchedPlanRes.reason, /verificationPlanDigest does not match requested policy digest/);

    const mismatchedRunRes = provider.verifyEvidence({ ...validEvidence, runId: 'run-1' }, {
      runId: 'run-2',
    });
    assert.equal(mismatchedRunRes.verified, false);
    assert.match(mismatchedRunRes.reason, /runId does not match requested policy runId/);

    const mismatchedWorkerRes = provider.verifyEvidence(validEvidence, {
      workerIdentity: 'different-worker',
    });
    assert.equal(mismatchedWorkerRes.verified, false);
    assert.match(mismatchedWorkerRes.reason, /workerIdentity does not match requested policy workerIdentity/);

    // 11k: Post-dated evidence timestamp rejected
    const futureDatedRes = provider.verifyEvidence({
      ...validEvidence,
      evidenceTimestamp: new Date(Date.now() + 120_000).toISOString(),
    });
    assert.equal(futureDatedRes.verified, false);
    assert.match(futureDatedRes.reason, /post-dated beyond allowable clock skew/);

    // 11l: Direct provider execution fails closed
    await assert.rejects(
      async () => { await provider.execute(); },
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && err.executionBlocked === true,
      'provider.execute() must reject with PROJECT_EXECUTION_BLOCKED'
    );

    // 11m: verifyIsolationCapabilities rejects WSL provider even with attested schema
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const capVerifyRes = verifyIsolationCapabilities({
      providerDescriptor: caps,
      evidence: validEvidence,
    });
    assert.equal(capVerifyRes.ready, false);
    assert.equal(capVerifyRes.status, 'BLOCKED');
    assert.ok(capVerifyRes.blockingReasons.length > 0);

    // 11n: requireProjectProcessIsolation fails closed with unverified WSL
    const { requireProjectProcessIsolation } = require('../electron/coding-pipeline/projectProcessIsolation.cjs');
    assert.throws(
      () => { requireProjectProcessIsolation('test', validEvidence); },
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && err.executionBlocked === true,
      'requireProjectProcessIsolation must fail-closed on unverified WSL runtime'
    );

    // 11g: Fail-closed gate with unverified WSL - NO host execution fallback
    const tempProj = await makeTempDir('wsl-gate-test-');
    try {
      await fs.writeFile(path.join(tempProj, 'package.json'), JSON.stringify({ name: 'wsl-test' }));
      const ownerId = 202;
      await developerFiles.attachProject(tempProj, ownerId);
      const plan = {
        projectRoot: tempProj,
        binary: 'echo',
        args: ['unverified-wsl-should-never-run'],
        planDigest: 'a'.repeat(64),
      };
      // Forged boolean flag fails closed
      const gateResult = await executeInVerifiedSandbox({
        plan,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        isolationEvidence: {
          providerId: 'wsl-isolation-provider',
          sandbox: true,
        },
      });
      assert.equal(gateResult.ok, false);
      assert.equal(gateResult.status, 'BLOCKED');
      assert.equal(gateResult.gate, 'PROCESS_ISOLATION_GATE');
      assert.match(gateResult.reason, /Caller-supplied Boolean flag/);

      // Schema-valid and digest-matched evidence STILL fails closed (cannot authorize OS execution)
      const validGateResult = await executeInVerifiedSandbox({
        plan,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        isolationEvidence: validEvidence,
      });
      assert.equal(validGateResult.ok, false);
      assert.equal(validGateResult.status, 'BLOCKED');
      assert.equal(validGateResult.gate, 'PROCESS_ISOLATION_GATE');
      assert.equal(validGateResult.executionBlocked, true);
    } finally {
      await fs.rm(tempProj, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 12. "Run Project" Intent Routing and Execution-Gate Honesty Regressions
  // -------------------------------------------------------------------------
  console.log('12. Testing "Run Project" intent routing and execution-gate honesty...');
  {
    const { classifyTaskIntent, INTENT_CATEGORIES } = require('../electron/coding-pipeline/genericIntentClassifier.cjs');
    const { isProjectRuntimeTestRequest } = require('../electron/coding-pipeline/projectRuntimeTestIntent.cjs');

    const executionQueries = [
      { request: 'run the project', expectedOp: BUILD_OPERATIONS.START, expectedCmd: 'npm start' },
      { request: 'start this application', expectedOp: BUILD_OPERATIONS.START, expectedCmd: 'npm start' },
      { request: 'launch the attached workspace', expectedOp: BUILD_OPERATIONS.START, expectedCmd: 'npm start' },
      { request: 'build and test this project', expectedOp: BUILD_OPERATIONS.TEST, expectedCmd: 'npm test' },
    ];

    for (const item of executionQueries) {
      const intent = classifyTaskIntent({ request: item.request });
      assert.equal(intent.actionable, true, `Request "${item.request}" must be recognized as an actionable task.`);
      assert.notEqual(intent.primaryIntent, INTENT_CATEGORIES.EXPLAIN_OR_ASK, `Request "${item.request}" must not route to generic Q&A.`);
      assert.equal(isProjectRuntimeTestRequest(item.request), true, `Request "${item.request}" must match project workflow patterns.`);
    }

    // Negative Intent Regression: Ensure non-execution queries are not falsely classified as RUN_OR_LAUNCH
    const negativeQueries = [
      { request: 'Explain how to run a project', expectedIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK, actionable: false },
      { request: 'What does this project do?', expectedIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK, actionable: false },
      { request: 'How does developerAgent implement rollback?', expectedIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK, actionable: false },
      { request: 'Can you explain how routes work?', expectedIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK, actionable: false },
      { request: 'Explain the difference between build and start.', expectedIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK, actionable: false },
      { request: 'Investigate why the database connection is failing.', expectedIntent: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG, actionable: true },
      { request: 'Refactor the authentication module.', expectedIntent: INTENT_CATEGORIES.REFACTOR, actionable: true },
      { request: 'Add a new endpoint for user profile.', expectedIntent: INTENT_CATEGORIES.BUILD_OR_SCAFFOLD, actionable: true },
    ];
    for (const neg of negativeQueries) {
      const negIntent = classifyTaskIntent({ request: neg.request });
      assert.notEqual(negIntent.primaryIntent, INTENT_CATEGORIES.RUN_OR_LAUNCH, `Non-execution query "${neg.request}" must not be classified as RUN_OR_LAUNCH.`);
      assert.equal(negIntent.primaryIntent, neg.expectedIntent, `Query "${neg.request}" should have primary intent ${neg.expectedIntent}`);
      assert.equal(negIntent.actionable, neg.actionable, `Query "${neg.request}" actionable flag should be ${neg.actionable}`);
    }

    // Project Manifest Grounding: Confirm commands are derived from actual package.json, not assumed
    const noStartProjDir = await makeTempDir('no-start-script-test-');
    try {
      await fs.writeFile(path.join(noStartProjDir, 'package.json'), JSON.stringify({
        name: 'no-start-app',
        version: '1.0.0',
        scripts: { test: 'node --test' },
      }));
      const ownerId = 304;
      await developerFiles.attachProject(noStartProjDir, ownerId);
      const noStartResult = await executeAutonomousCodingWorkflow({
        userRequest: 'run the project',
        root: noStartProjDir,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        onProgress: () => {},
      });
      assert.equal(noStartResult.outcome, 'NOT_CONFIGURED', 'Must report NOT_CONFIGURED when no start script exists.');
      assert.notEqual(noStartResult.outcome, 'STARTED', 'Must never report STARTED when startup command is not configured.');
      assert.notEqual(noStartResult.outcome, 'COMPLETED', 'Must never report COMPLETED when startup command is not configured.');
      assert.equal(noStartResult.phase, 'BUILD_PLAN');
      assert.match(noStartResult.reason, /Operation "START" is not declared or configured/);
      assert.equal(noStartResult.buildPlan?.configured, false);
      assert.ok(!noStartResult.buildPlan?.fullCommandString, 'Must never fabricate a startup command when not configured.');
      assert.equal(noStartResult.codeApplied, false);
      assert.equal(noStartResult.codeVerified, false);
      assert.equal(noStartResult.filesModified.length, 0);
      const noStartCmd = noStartResult.engineeringReport?.executedCommands?.[0];
      assert.ok(noStartCmd, 'Must produce a structured command record for unconfigured startup.');
      assert.equal(noStartCmd.status, 'NOT_CONFIGURED');
      assert.equal(noStartCmd.environment, 'NOT_RUN');
      assert.equal(noStartCmd.exitCode, null, 'No command was executed; exitCode must be null.');
    } finally {
      await fs.rm(noStartProjDir, { recursive: true, force: true });
    }

    // Custom Script Discovery: Confirm discovery of "serve" script when "start" is absent
    const serveProjDir = await makeTempDir('serve-script-test-');
    try {
      await fs.writeFile(path.join(serveProjDir, 'package.json'), JSON.stringify({
        name: 'serve-script-app',
        version: '1.0.0',
        scripts: { serve: 'node app.js' },
      }));
      await fs.writeFile(path.join(serveProjDir, 'app.js'), 'console.log("Serving");\n');
      const ownerId = 305;
      await developerFiles.attachProject(serveProjDir, ownerId);
      const serveResult = await executeAutonomousCodingWorkflow({
        userRequest: 'start this application',
        root: serveProjDir,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        onProgress: () => {},
      });
      assert.equal(serveResult.outcome, 'BLOCKED', 'Must fail closed at execution gate.');
      assert.equal(serveResult.phase, 'BUILD_EXECUTION_GATE');
      assert.equal(serveResult.buildPlan?.operation, BUILD_OPERATIONS.START);
      assert.equal(serveResult.buildPlan?.fullCommandString, 'npm run serve', 'Must discover "npm run serve" from package.json rather than assuming npm start.');
    } finally {
      await fs.rm(serveProjDir, { recursive: true, force: true });
    }

    const testProjectDir = await makeTempDir('run-project-intent-test-');
    try {
      await fs.writeFile(path.join(testProjectDir, 'package.json'), JSON.stringify({
        name: 'test-execution-intent-app',
        version: '1.0.0',
        scripts: {
          build: 'node build.js',
          start: 'node server.js',
          test: 'node --test',
        },
      }));
      await fs.writeFile(path.join(testProjectDir, 'server.js'), 'console.log("Ready");\n');

      const ownerId = 303;
      await developerFiles.attachProject(testProjectDir, ownerId);

      for (const item of executionQueries) {
        const result = await executeAutonomousCodingWorkflow({
          userRequest: item.request,
          root: testProjectDir,
          ownerWebContentsId: ownerId,
          sessionId: crypto.randomUUID(),
          onProgress: () => {},
        });

        assert.equal(result.outcome, 'BLOCKED', `Execution intent "${item.request}" must fail closed when isolation is unverified.`);
        assert.notEqual(result.outcome, 'STARTED', `Execution intent "${item.request}" must never report STARTED when blocked by isolation.`);
        assert.notEqual(result.outcome, 'COMPLETED', `Execution intent "${item.request}" must never report COMPLETED when blocked by isolation.`);
        assert.equal(result.phase, 'BUILD_EXECUTION_GATE', `Must enter BUILD_EXECUTION_GATE instead of manual Q&A.`);
        assert.equal(result.executionBlocked, true, 'executionBlocked flag must be true.');
        assert.equal(result.codeVerified, false, 'Blocked workflow must never report codeVerified as true.');
        assert.equal(result.codeApplied, false, 'Blocked workflow must never report codeApplied as true.');
        assert.equal(result.buildPlan?.operation, item.expectedOp, `Expected operation ${item.expectedOp} for "${item.request}".`);
        assert.equal(result.buildPlan?.fullCommandString, item.expectedCmd, `Expected command ${item.expectedCmd} for "${item.request}".`);

        // Verify that the proposed command is clearly distinguished from an executed command
        const executedCommand = result.engineeringReport?.executedCommands?.[0];
        assert.ok(executedCommand, 'Engineering report must record the proposed command record.');
        assert.equal(executedCommand.command, item.expectedCmd);
        assert.equal(executedCommand.environment, 'UNISOLATED_BLOCKED', 'Proposed command environment must be marked UNISOLATED_BLOCKED.');
        assert.equal(executedCommand.exitCode, null, 'No host process may be executed (exitCode must be null).');
        assert.equal(executedCommand.status, 'BLOCKED');
        assert.equal(executedCommand.checkState, 'BLOCKED_ISOLATION');
        assert.equal(result.filesModified.length, 0, 'No files may be modified for read-only run/test plan.');
      }

      // Distinct operation semantics: build, test, and run retain distinct operation types
      const distinctOps = [
        { req: 'build the project', expectedOp: BUILD_OPERATIONS.BUILD, expectedCmd: 'npm run build' },
        { req: 'run the tests', expectedOp: BUILD_OPERATIONS.TEST, expectedCmd: 'npm test' },
        { req: 'run the project', expectedOp: BUILD_OPERATIONS.START, expectedCmd: 'npm start' },
      ];
      for (const opItem of distinctOps) {
        const opResult = await executeAutonomousCodingWorkflow({
          userRequest: opItem.req,
          root: testProjectDir,
          ownerWebContentsId: ownerId,
          sessionId: crypto.randomUUID(),
          onProgress: () => {},
        });
        assert.equal(opResult.buildPlan?.operation, opItem.expectedOp, `Distinct operation for "${opItem.req}" must be ${opItem.expectedOp}`);
        assert.equal(opResult.buildPlan?.fullCommandString, opItem.expectedCmd);
        assert.equal(opResult.outcome, 'BLOCKED');
        assert.equal(opResult.phase, 'BUILD_EXECUTION_GATE');
      }

      // Broker Boundary & Contract Consistency:
      // Even if a broker or IPC caller dispatches a session with connected transport,
      // execution remains BLOCKED by PROCESS_ISOLATION_GATE, preserving identical contract structure.
      const simulatedBrokerSession = `broker-session-${crypto.randomUUID().slice(0, 8)}`;
      const brokerResult = await executeAutonomousCodingWorkflow({
        userRequest: 'run the project',
        root: testProjectDir,
        ownerWebContentsId: ownerId,
        sessionId: simulatedBrokerSession,
        onProgress: () => {},
      });
      assert.equal(brokerResult.outcome, 'BLOCKED', 'Broker connected session must remain BLOCKED while isolation gate is closed.');
      assert.notEqual(brokerResult.outcome, 'STARTED', 'Broker session must never report STARTED without verified isolation.');
      assert.notEqual(brokerResult.outcome, 'COMPLETED', 'Broker session must never report COMPLETED without verified isolation.');
      assert.equal(brokerResult.executionBlocked, true);
      assert.equal(brokerResult.engineeringReport?.executedCommands?.[0]?.exitCode, null);
      assert.equal(brokerResult.engineeringReport?.executedCommands?.[0]?.status, 'BLOCKED');
      assert.equal(brokerResult.engineeringReport?.executedCommands?.[0]?.checkState, 'BLOCKED_ISOLATION');
      // Contract shape validation:
      assert.ok('outcome' in brokerResult);
      assert.ok('phase' in brokerResult);
      assert.ok('buildPlan' in brokerResult);
      assert.ok('engineeringReport' in brokerResult);
      assert.ok('executionBlocked' in brokerResult);
      assert.ok('workflowReceipt' in brokerResult);
    } finally {
      await fs.rm(testProjectDir, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 13. STARTED Outcome Runtime Evidence Correction & Trust Boundary Hardening (Milestone V44.16)
  // [SYNTHETIC TEST] Contract behavior verified via isolated mock runner; does NOT attest live host execution.
  // -------------------------------------------------------------------------
  console.log('13. Testing rejection of untrusted/synthetic runtime evidence (Milestone V44.16)...');
  {
    const { evaluateApplicationRuntimeEvidence } = require('../electron/developerAgent.cjs');
    const { projectProcessIsolationStatus } = require('../electron/coding-pipeline/projectProcessIsolation.cjs');

    // Case 1: Plain object with all supervisor fields populated
    // [SYNTHETIC TEST] Plain objects must not be accepted as trusted supervisor evidence
    const plainObjectEvidence = {
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 48120,
      supervisor: {
        isAlive: true,
        pid: 48120,
        processIdentity: 'supervised-worker-app-1',
        expectedProcessIdentity: 'supervised-worker-app-1',
        expectedPid: 48120,
      },
    };
    const plainObjResult = evaluateApplicationRuntimeEvidence(plainObjectEvidence);
    assert.equal(plainObjResult.started, false, 'Plain object with supervisor fields must NOT produce started=true without verified supervisor.');
    assert.match(plainObjResult.reason, /Untrusted runtime evidence rejected|no independently verified host process supervisor/i);

    // Case 2: Matching PID and process identity strings
    // [SYNTHETIC TEST] Matching strings and field presence alone must NOT grant supervisor trust
    const matchingStringsEvidence = {
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 12345,
      supervisor: {
        isAlive: true,
        pid: 12345,
        processIdentity: 'match-proc-id',
        expectedProcessIdentity: 'match-proc-id',
        expectedPid: 12345,
      },
    };
    const matchingStringsResult = evaluateApplicationRuntimeEvidence(matchingStringsEvidence);
    assert.equal(matchingStringsResult.started, false, 'Matching PID and identity strings must NOT grant supervisor trust.');
    assert.match(matchingStringsResult.reason, /Untrusted runtime evidence rejected/i);

    // Case 3: Fabricated isAlive: true
    // [SYNTHETIC TEST] Fabricated isAlive flag must not bypass supervisor trust boundary
    const fabricatedAliveEvidence = {
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 54321,
      supervisor: { isAlive: true, pid: 54321 },
    };
    const fabricatedAliveResult = evaluateApplicationRuntimeEvidence(fabricatedAliveEvidence);
    assert.equal(fabricatedAliveResult.started, false, 'Fabricated isAlive: true must NOT produce started=true.');
    assert.match(fabricatedAliveResult.reason, /Untrusted runtime evidence rejected/i);

    // Case 4: Replayed evidence from previous execution
    // [SYNTHETIC TEST] Replayed evidence without verified active supervisor is rejected
    const replayedEvidence = {
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 48120,
      supervisor: {
        isAlive: true,
        pid: 48120,
        replayedNonce: 'prior-exec-nonce-999',
      },
    };
    const replayedResult = evaluateApplicationRuntimeEvidence(replayedEvidence);
    assert.equal(replayedResult.started, false, 'Replayed evidence must NOT produce started=true.');
    assert.match(replayedResult.reason, /Untrusted runtime evidence rejected/i);

    // Case 5: Evidence supplied by an injected/mock runner
    // [SYNTHETIC TEST] Injected runner claims must fail closed
    const mockRunnerClaim = {
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 7777,
      isMockRunner: true,
      supervisor: { isAlive: true, pid: 7777, source: 'mock' },
    };
    const mockRunnerResult = evaluateApplicationRuntimeEvidence(mockRunnerClaim);
    assert.equal(mockRunnerResult.started, false, 'Injected mock runner claims must NOT produce started=true.');
    assert.match(mockRunnerResult.reason, /Untrusted runtime evidence rejected/i);

    // Case 6: Missing supervisor evidence
    // [SYNTHETIC TEST] Missing supervisor evidence must fail closed
    const missingSupervisorResult = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 48120,
      supervisor: null,
    });
    assert.equal(missingSupervisorResult.started, false, 'Missing supervisor evidence must fail closed.');
    assert.match(missingSupervisorResult.reason, /Supervisor evidence is missing/i);

    // Process termination tests: premature exit with code 0 or error code
    const exitZeroResult = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: 0,
      isAlive: false,
      stdout: 'App initialized and stopped immediately',
      stderr: '',
    });
    assert.equal(exitZeroResult.started, false, 'Process that exits immediately with code 0 must NOT produce started=true.');
    assert.match(exitZeroResult.reason, /exited immediately with code 0/i);

    const exitNonZeroResult = evaluateApplicationRuntimeEvidence({
      ok: false,
      exitCode: 1,
      isAlive: false,
      stdout: '',
      stderr: 'Error: Port 3000 in use',
    });
    assert.equal(exitNonZeroResult.started, false, 'Process with non-zero exit code must NOT produce started=true.');
    assert.match(exitNonZeroResult.reason, /exited with code 1/i);

    // Case 7: Isolation gate blocks execution
    // Verified via executeAutonomousCodingWorkflow: unverified isolation gate strictly blocks before execution
    const testProjDir = await makeTempDir('runtime-evidence-test-');
    try {
      await fs.writeFile(path.join(testProjDir, 'package.json'), JSON.stringify({
        name: 'runtime-evidence-app',
        version: '1.0.0',
        scripts: { start: 'node server.js' },
      }));
      await fs.writeFile(path.join(testProjDir, 'server.js'), 'console.log("ready");\n');
      const ownerId = 308;
      await developerFiles.attachProject(testProjDir, ownerId);

      const blockedResult = await executeAutonomousCodingWorkflow({
        userRequest: 'run the project',
        root: testProjDir,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        onProgress: () => {},
      });
      assert.equal(blockedResult.outcome, 'BLOCKED', 'Execution gate must block unisolated execution.');
      assert.notEqual(blockedResult.outcome, 'STARTED', 'Blocked execution must never report STARTED.');
      assert.notEqual(blockedResult.outcome, 'COMPLETED', 'Blocked execution must never report COMPLETED.');
      assert.equal(blockedResult.executionBlocked, true);
      assert.equal(blockedResult.engineeringReport?.executedCommands?.[0]?.exitCode, null);
    } finally {
      await fs.rm(testProjDir, { recursive: true, force: true });
    }

    // Case 8: No production supervisor available
    // Confirms system isolation status verified flag is false and rejects runtime claims
    const currentStatus = projectProcessIsolationStatus();
    assert.equal(currentStatus.verified, false, 'Production supervisor isolation must be unverified.');
    const unverifiedSupervisorResult = evaluateApplicationRuntimeEvidence({
      ok: true,
      pid: 9999,
      supervisor: { isAlive: true, pid: 9999 },
    });
    assert.equal(unverifiedSupervisorResult.started, false, 'Must reject evidence when no production supervisor is available.');
    assert.match(unverifiedSupervisorResult.reason, /no independently verified host process supervisor/i);

    // -------------------------------------------------------------------------
    // V44.18: Decouple Process Isolation Verification from Runtime Supervisor Trust
    // [SYNTHETIC TEST] Contract behavior verified via isolated mock runner; does NOT attest live host execution.
    // -------------------------------------------------------------------------
    const { projectProcessSupervisorStatus } = require('../electron/coding-pipeline/projectProcessIsolation.cjs');

    // Confirm that the independent supervisor contract is unavailable/unverified by default
    const currentSupervisorStatus = projectProcessSupervisorStatus();
    assert.equal(currentSupervisorStatus.available, false, 'Runtime supervisor must be unavailable in production.');
    assert.equal(currentSupervisorStatus.verified, false, 'Runtime supervisor must be unverified in production.');

    // 1. Isolation unverified, supervisor unverified
    const decCase1 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61001,
      supervisor: { isAlive: true, pid: 61001 },
    }, { isolationStatus: { verified: false, available: false } });
    assert.equal(decCase1.started, false, 'Case 1: Isolation unverified + supervisor unverified must NOT produce started=true.');
    assert.match(decCase1.reason, /operating system process isolation is unverified|no independently verified host process supervisor/i);

    // 2. Isolation verified, supervisor unavailable
    const decCase2 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61002,
      supervisor: { isAlive: true, pid: 61002 },
    }, { isolationStatus: { verified: true, available: true } });
    assert.equal(decCase2.started, false, 'Case 2: Isolation verified + supervisor unavailable must NOT produce started=true.');
    assert.match(decCase2.reason, /process isolation verification does not authenticate application runtime supervision|no independently verified host process supervisor/i);
    assert.equal(decCase2.isolationVerified, true);
    assert.equal(decCase2.supervisorVerified, false);

    // 3. Isolation verified, fabricated supervisor object
    const decCase3 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61003,
      supervisor: {
        isAlive: true,
        pid: 61003,
        name: 'FabricatedSupervisorDaemon',
        trusted: true,
        attestation: 'fake-signature',
      },
    }, { isolationStatus: { verified: true, available: true } });
    assert.equal(decCase3.started, false, 'Case 3: Isolation verified + fabricated supervisor object must NOT produce started=true.');
    assert.match(decCase3.reason, /process isolation verification does not authenticate application runtime supervision|no independently verified host process supervisor/i);

    // 4. Isolation verified, fabricated PID and matching identity strings
    const decCase4 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61004,
      supervisor: {
        isAlive: true,
        pid: 61004,
        expectedPid: 61004,
        processIdentity: 'identical-proc-uuid-999',
        expectedProcessIdentity: 'identical-proc-uuid-999',
      },
    }, { isolationStatus: { verified: true, available: true } });
    assert.equal(decCase4.started, false, 'Case 4: Isolation verified + matching identity strings must NOT produce started=true.');
    assert.match(decCase4.reason, /process isolation verification does not authenticate application runtime supervision|no independently verified host process supervisor/i);

    // 5. Isolation verified, injected/mock runner claims
    const decCase5 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61005,
      isMockRunner: true,
      supervisor: {
        isAlive: true,
        pid: 61005,
        source: 'mock',
      },
    }, { isolationStatus: { verified: true, available: true } });
    assert.equal(decCase5.started, false, 'Case 5: Isolation verified + mock runner claims must NOT produce started=true.');
    assert.match(decCase5.reason, /process isolation verification does not authenticate application runtime supervision|mock or replayed supervisor evidence/i);

    // 6. Isolation verified, replayed supervisor evidence
    const decCase6 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61006,
      supervisor: {
        isAlive: true,
        pid: 61006,
        replayedNonce: 'prior-nonce-777',
      },
    }, { isolationStatus: { verified: true, available: true } });
    assert.equal(decCase6.started, false, 'Case 6: Isolation verified + replayed evidence must NOT produce started=true.');
    assert.match(decCase6.reason, /process isolation verification does not authenticate application runtime supervision|mock or replayed supervisor evidence/i);

    // 7. Supervisor evidence supplied without an independently trusted producer
    const decCase7 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61007,
      supervisor: {
        isAlive: true,
        pid: 61007,
        producer: 'untrusted-runner-guest-payload',
      },
      supervisorStatus: {
        available: true,
        verified: true, // Caller/runner attempting to supply supervisorStatus directly
      },
    }, { isolationStatus: { verified: true, available: true } });
    assert.equal(decCase7.started, false, 'Case 7: Runner-supplied supervisorStatus must NOT bypass independent contract.');
    assert.match(decCase7.reason, /process isolation verification does not authenticate application runtime supervision|no independently verified host process supervisor/i);
    assert.equal(decCase7.supervisorVerified, false);

    // 8. Both conditions unavailable
    const decCase8 = evaluateApplicationRuntimeEvidence({
      ok: true,
      exitCode: null,
      isAlive: true,
      pid: 61008,
      supervisor: { isAlive: true, pid: 61008 },
    }, { isolationStatus: { verified: false, available: false } });
    assert.equal(decCase8.started, false, 'Case 8: Both conditions unavailable must NOT produce started=true.');
    assert.match(decCase8.reason, /operating system process isolation is unverified|no independently verified host process supervisor/i);

    // Startup script is not configured
    const noScriptDir = await makeTempDir('no-script-test-');
    try {
      await fs.writeFile(path.join(noScriptDir, 'package.json'), JSON.stringify({
        name: 'no-script-app',
        version: '1.0.0',
        scripts: {},
      }));
      const ownerId = 309;
      await developerFiles.attachProject(noScriptDir, ownerId);

      const noScriptResult = await executeAutonomousCodingWorkflow({
        userRequest: 'run the project',
        root: noScriptDir,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        onProgress: () => {},
      });
      assert.equal(noScriptResult.outcome, 'NOT_CONFIGURED', 'Missing startup script must return NOT_CONFIGURED.');
      assert.notEqual(noScriptResult.outcome, 'STARTED', 'Unconfigured script must never report STARTED.');
      assert.notEqual(noScriptResult.outcome, 'COMPLETED', 'Unconfigured script must never report COMPLETED.');
      assert.equal(noScriptResult.executionBlocked, true);
      assert.equal(noScriptResult.buildPlan?.configured, false);
      assert.ok(!noScriptResult.buildPlan?.fullCommandString, 'Must not fabricate a startup command.');
    } finally {
      await fs.rm(noScriptDir, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 14. Testing Docker Root Filesystem Hardening & Guaranteed Cleanup (Milestone V44.23)
  // -------------------------------------------------------------------------
  console.log('14. Testing Docker Root Filesystem Hardening & Guaranteed Cleanup (Milestone V44.23)...');
  {
    const { DEFAULT_TMPFS_CONFIG, validateContainerRunArgs, ProjectContainerExecutionRunner } = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');
    assert.equal(DEFAULT_TMPFS_CONFIG, '/tmp:rw,noexec,nosuid,nodev,size=64m');
    assert.throws(() => validateContainerRunArgs(['run']), /missing required --read-only/);
    assert.throws(() => validateContainerRunArgs(['run', '--read-only']), /missing required --tmpfs/);
    assert.equal(validateContainerRunArgs(['run', '--read-only', '--tmpfs', DEFAULT_TMPFS_CONFIG]), true);

    // Verify runner produces isolation evidence reflecting readOnlyRoot and bounded tmpfs
    const mockRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: (bin, args) => {
        if (args && args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: 'PASS', stderr: '' };
      },
      isMock: true,
    });
    const tempRoot = await makeTempDir('v44-23-iso-');
    await fs.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'iso-test', scripts: { test: 'node -e "process.exit(0)"' } }));
    const ownerId = 4423;
    await developerFiles.attachProject(tempRoot, ownerId);
    const plan = await createBuildPlan({ projectRoot: tempRoot, operation: BUILD_OPERATIONS.TEST });
    const res = await mockRunner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(res.ok, true);
    assert.equal(res.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.equal(res.isolationEvidence.readOnlyRoot, true);
    assert.equal(res.isolationEvidence.tmpfsMount, DEFAULT_TMPFS_CONFIG);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 15. Testing Asynchronous Docker Execution & Real In-Flight Cancellation (Milestone V44.24)
  // -------------------------------------------------------------------------
  console.log('15. Testing Asynchronous Docker Execution & Real In-Flight Cancellation (Milestone V44.24)...');
  {
    const { runDockerCliAsync } = require('../electron/coding-pipeline/dockerProviderAdapter.cjs');
    const { ProjectContainerExecutionRunner } = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');

    assert.equal(typeof runDockerCliAsync, 'function', 'runDockerCliAsync must be exported');

    // Pre-launch cancellation
    const ctrl = new AbortController();
    ctrl.abort();
    const abortRes = await runDockerCliAsync('docker', ['run', 'alpine'], { signal: ctrl.signal });
    assert.equal(abortRes.cancelled, true);
    assert.equal(abortRes.signal, 'SIGTERM');
    assert.match(abortRes.error, /cancelled by caller before process launch/i);

    // Runner default uses runDockerCliAsync
    const runner = new ProjectContainerExecutionRunner();
    assert.equal(runner.dockerCli, runDockerCliAsync);
    assert.equal(runner.isMockRunner, false);

    // Fail-closed gate preservation: runner without verified runtime blocks execution
    const tempRoot = await makeTempDir('v44-24-gate-');
    await fs.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gate-test', scripts: { test: 'node -e "process.exit(0)"' } }));
    const ownerId = 4425;
    await developerFiles.attachProject(tempRoot, ownerId);
    const plan = await createBuildPlan({ projectRoot: tempRoot, operation: BUILD_OPERATIONS.TEST });

    const blockedRes = await runner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(blockedRes.ok, false);
    assert.equal(blockedRes.status, 'BLOCKED');
    assert.equal(blockedRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(blockedRes.executionBlocked, true);

    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 16. Testing Trustworthy Docker Capability Discovery & Provenance (Milestone V44.25)
  // -------------------------------------------------------------------------
  console.log('16. Testing Trustworthy Docker Capability Discovery & Provenance (Milestone V44.25)...');
  {
    const { discoverDocker } = require('../electron/coding-pipeline/isolationRuntimeDiscovery.cjs');
    const { ContainerProvider } = require('../electron/coding-pipeline/providers/containerProvider.cjs');
    const { defaultRegistry } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');
    const { ProjectContainerExecutionRunner, DEFAULT_TMPFS_CONFIG, validateContainerRunArgs } = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');
    const { projectProcessSupervisorStatus, projectProcessIsolationStatus } = require('../electron/coding-pipeline/projectProcessIsolation.cjs');

    // 16.1: Docker CLI available but daemon unavailable
    const cliOnlyMock = (cmd) => {
      if (cmd.includes('--version')) return { succeeded: true, exitCode: 0, stdout: 'Docker version 28.3.2, build 5335920', stderr: '' };
      return { succeeded: false, exitCode: 1, stdout: '', stderr: 'error during connect: daemon not running' };
    };
    const cliOnlyCandidate = discoverDocker({ commandRunner: cliOnlyMock });
    assert.equal(cliOnlyCandidate.available, true, 'CLI availability must be true when docker --version succeeds');
    assert.equal(cliOnlyCandidate.healthCheck.succeeded, false, 'Daemon probe must be false when daemon not responding');
    assert.equal(cliOnlyCandidate.isolationVerified, false, 'Isolation must NOT be verified when daemon is down');
    const regCliOnly = defaultRegistry.getProvider('docker');
    assert.equal(regCliOnly.isReady, false, 'Provider must not be ready when daemon unavailable');
    assert.equal(regCliOnly.capabilityVerificationStatus, 'BLOCKED');

    // 16.2: Docker daemon available and hello-world successful -> isolationVerified MUST STILL BE FALSE
    const daemonOkMock = (cmd) => {
      if (cmd.includes('--version')) return { succeeded: true, exitCode: 0, stdout: 'Docker version 28.3.2, build 5335920', stderr: '' };
      if (cmd.includes('hello-world')) return { succeeded: true, exitCode: 0, stdout: 'Hello from Docker!', stderr: '' };
      return { succeeded: true, exitCode: 0, stdout: '', stderr: '' };
    };
    const daemonOkCandidate = discoverDocker({ commandRunner: daemonOkMock });
    assert.equal(daemonOkCandidate.available, true);
    assert.equal(daemonOkCandidate.healthCheck.succeeded, true, 'hello-world probe succeeded');
    assert.equal(daemonOkCandidate.isolationVerified, false, 'hello-world success must NEVER verify security isolation');
    const regDaemonOk = defaultRegistry.getProvider('docker');
    assert.equal(regDaemonOk.isReady, false, 'Docker must not be marked isReady: true merely because hello-world succeeded');
    assert.equal(regDaemonOk.capabilityVerificationStatus, 'BLOCKED');
    assert.ok(regDaemonOk.blockingReasons.some(r => r.includes('availability probe does not establish runtime security verification')));

    // 16.3: Successful probe does not verify unrelated security capabilities
    assert.equal(daemonOkCandidate.capabilities.readOnlyRootfs.verificationState, 'NOT_VERIFIED');
    assert.equal(daemonOkCandidate.capabilities.egressFiltering.verificationState, 'NOT_VERIFIED');
    assert.equal(daemonOkCandidate.capabilities.resourceLimits.verificationState, 'NOT_VERIFIED');
    assert.equal(daemonOkCandidate.capabilities.filesystemIsolation.verificationState, 'NOT_VERIFIED');
    assert.equal(daemonOkCandidate.capabilities.containerCleanup.verificationState, 'NOT_VERIFIED');
    assert.equal(daemonOkCandidate.capabilities.runtimeSupervisor.verificationState, 'NOT_VERIFIED');

    assert.equal(regDaemonOk.filesystemCapabilities.readOnlyRoot, false);
    assert.equal(regDaemonOk.networkCapabilities.egressFiltering, false);
    assert.equal(regDaemonOk.resourceLimits.memoryCapSupported, false);
    assert.equal(regDaemonOk.resourceLimits.cpuThrottlingSupported, false);
    assert.equal(regDaemonOk.processCapabilities.independentProcessTree, false);

    // 16.4: Configured --read-only is configuration evidence, not runtime enforcement
    const tempDir = await makeTempDir('v44-25-audit-');
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'audit-test', scripts: { test: 'node -e "process.exit(0)"' } }));
    const ownerId = 4426;
    await developerFiles.attachProject(tempDir, ownerId);
    const plan = await createBuildPlan({ projectRoot: tempDir, operation: BUILD_OPERATIONS.TEST });

    const mockRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: (bin, args) => {
        if (args && args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: 'test-pass', stderr: '' };
      },
      isMock: true,
    });
    const runResult = await mockRunner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(runResult.ok, true);
    assert.equal(runResult.isolationEvidence.readOnlyRoot, true, 'Configuration evidence preserved');
    assert.equal(runResult.isolationEvidence.capabilityEvidence.readOnlyRootfs.configured, true);
    assert.equal(runResult.isolationEvidence.capabilityEvidence.readOnlyRootfs.runtimeEnforcement, 'NOT_VERIFIED');
    assert.equal(runResult.isolationEvidence.capabilityEvidence.readOnlyRootfs.verificationMethod, 'CLI_FLAG_CONFIGURATION');

    // 16.5: --network=bridge does not imply egress filtering
    assert.equal(runResult.isolationEvidence.capabilityEvidence.networkMode.egressFiltering, 'NOT_VERIFIED');
    assert.match(runResult.isolationEvidence.capabilityEvidence.networkMode.limitation, /egress/i);

    // 16.6: CPU, memory, and PID arguments do not prove cgroup enforcement
    assert.equal(runResult.isolationEvidence.capabilityEvidence.resourceLimits.cgroupEnforcement, 'NOT_VERIFIED');
    assert.match(runResult.isolationEvidence.capabilityEvidence.resourceLimits.limitation, /cgroup/i);

    // 16.7: Synthetic evidence cannot establish production verification
    const containerProvider = new ContainerProvider();
    const syntheticEvidence = {
      providerId: 'container-isolation-provider',
      provenance: 'synthetic-test',
      isMock: true,
      trustClass: 'UNTRUSTED',
      daemonCertSha256: 'a'.repeat(64),
      containerAttestationDigest: 'b'.repeat(64),
    };
    const synthRes = containerProvider.verifyEvidence(syntheticEvidence);
    assert.equal(synthRes.verified, false);
    assert.equal(synthRes.status, 'BLOCKED');
    assert.match(synthRes.reason, /synthetic or mock container evidence cannot establish production runtime verification/i);

    // 16.8: Missing runtime evidence remains NOT_VERIFIED
    const missingEvRes = containerProvider.verifyEvidence({});
    assert.equal(missingEvRes.verified, false);
    assert.equal(missingEvRes.status, 'BLOCKED');
    assert.match(missingEvRes.reason, /lacks verified daemon certificate or attestation digest/i);

    // 16.9: Existing V44.23 rootfs/tmpfs argument checks remain intact
    assert.throws(() => validateContainerRunArgs(['run']), /missing required --read-only/);
    assert.throws(() => validateContainerRunArgs(['run', '--read-only']), /missing required --tmpfs/);
    assert.equal(validateContainerRunArgs(['run', '--read-only', '--tmpfs', DEFAULT_TMPFS_CONFIG]), true);

    // 16.10: Existing V44.24 asynchronous cancellation and cleanup behavior remains intact
    const preAbortCtrl = new AbortController();
    preAbortCtrl.abort();
    const { runDockerCliAsync } = require('../electron/coding-pipeline/dockerProviderAdapter.cjs');
    const abortCliRes = await runDockerCliAsync('docker', ['run', 'alpine'], { signal: preAbortCtrl.signal });
    assert.equal(abortCliRes.cancelled, true);
    assert.equal(abortCliRes.signal, 'SIGTERM');

    // 16.11: Existing fail-closed isolation and supervisor gates remain intact
    const isoStatus = projectProcessIsolationStatus();
    assert.equal(isoStatus.available, false);
    assert.equal(isoStatus.verified, false);
    const supStatus = projectProcessSupervisorStatus();
    assert.equal(supStatus.available, false);
    assert.equal(supStatus.verified, false);

    await fs.rm(tempDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 17. Testing End-to-End Isolation Capability Enforcement (Milestone V44.26)
  // -------------------------------------------------------------------------
  console.log('17. Testing End-to-End Isolation Capability Enforcement (Milestone V44.26)...');
  {
    const { ProjectContainerExecutionRunner } = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');
    const { ContainerProvider } = require('../electron/coding-pipeline/providers/containerProvider.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');
    const { requireProjectProcessIsolation } = require('../electron/coding-pipeline/projectProcessIsolation.cjs');

    // 17.1: Docker available but isolation unverified -> fail-closed execution gate with zero host execution
    assert.throws(
      () => requireProjectProcessIsolation('test', 'c:/dummy'),
      (err) => {
        assert.equal(err.code, 'PROJECT_EXECUTION_BLOCKED');
        assert.equal(err.executionBlocked, true);
        assert.equal(err.executionStatus, 'BLOCKED');
        return true;
      }
    );

    // 17.2: executeWithRuntime called directly with isolationVerified: false returns PROCESS_ISOLATION_GATE
    const unverifiedRuntime = {
      providerId: 'docker',
      runtimeType: 'container',
      isolationVerified: false,
      supportedOps: ['test'],
      isReady: false,
      capabilityVerificationStatus: 'BLOCKED',
    };
    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });
    const execWithRuntimeRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: unverifiedRuntime,
    });
    assert.equal(execWithRuntimeRes.ok, false);
    assert.equal(execWithRuntimeRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(execWithRuntimeRes.reason, /isolation is unverified/i);

    // 17.3: ProjectContainerExecutionRunner.execute() called directly with unverified runtime -> returns BLOCKED
    const execDirectRes = await realRunner.execute({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: unverifiedRuntime,
    });
    assert.equal(execDirectRes.ok, false);
    assert.equal(execDirectRes.status, 'BLOCKED');
    assert.equal(execDirectRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(execDirectRes.executionBlocked, true);
    assert.match(execDirectRes.reason, /isolation attestation has not been established/i);

    // 17.4: Non-mock runner rejects untrusted/synthetic evidence sources
    for (const src of ['synthetic', 'mock', 'untrusted-caller-input', 'simulated']) {
      const synthRes = await realRunner.execute({
        plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
        ownerWebContentsId: 9999,
        sessionId: 'sess-1',
        runtime: {
          providerId: 'docker',
          runtimeType: 'container',
          isolationVerified: true,
          supportedOps: ['test'],
          evidenceSource: src,
        },
      });
      assert.equal(synthRes.ok, false);
      assert.equal(synthRes.status, 'BLOCKED');
      assert.equal(synthRes.gate, 'PROCESS_ISOLATION_GATE');
      assert.match(synthRes.reason, /synthetic test evidence rejected/i);
    }

    // 17.5-17.10: Specific capability policies verified fail-closed
    const baseDescriptor = {
      providerId: 'test-container-provider',
      supportedPlatforms: [process.platform],
      isReady: false,
      capabilityVerificationStatus: PROVIDER_STATUSES.UNKNOWN,
      filesystemCapabilities: { readOnlyRoot: false, restrictedBindMounts: false },
      networkCapabilities: { egressFiltering: false },
      resourceLimits: { memoryCapSupported: false, cpuThrottlingSupported: false, timeoutEnforcementSupported: true },
      processCapabilities: { hostObservedTermination: false, runtimeSupervisorVerified: false },
    };

    // 17.5: requireReadOnlyRootfs
    const resReadOnly = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      requestedPolicy: { requireReadOnlyRootfs: true },
    });
    assert.ok(resReadOnly.missingCapabilities.includes('read_only_rootfs'));
    assert.equal(resReadOnly.ready, false);

    // 17.6: requireEgressFiltering
    const resEgress = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      requestedPolicy: { requireEgressFiltering: true },
    });
    assert.ok(resEgress.missingCapabilities.includes('egress_filtering'));
    assert.equal(resEgress.ready, false);

    // 17.7: requireCgroupLimits
    const resCgroups = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      requestedPolicy: { requireCgroupLimits: true },
    });
    assert.ok(resCgroups.missingCapabilities.includes('cgroup_resource_limits'));
    assert.equal(resCgroups.ready, false);

    // 17.8: requireFilesystemIsolation
    const resFsIso = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      requestedPolicy: { requireFilesystemIsolation: true },
    });
    assert.ok(resFsIso.missingCapabilities.includes('restricted_bind_mounts'));
    assert.equal(resFsIso.ready, false);

    // 17.9: requireCleanupAttestation
    const resCleanup = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      requestedPolicy: { requireCleanupAttestation: true },
    });
    assert.ok(resCleanup.missingCapabilities.includes('cleanup_attestation'));
    assert.equal(resCleanup.ready, false);

    // 17.10: requireRuntimeSupervisor
    const resSupervisor = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      requestedPolicy: { requireRuntimeSupervisor: true },
    });
    assert.ok(resSupervisor.missingCapabilities.includes('runtime_supervisor'));
    assert.equal(resSupervisor.ready, false);

    // 17.11: Caller-supplied verified: true rejected fail-closed
    const callerSuppliedRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { verified: true },
    });
    assert.equal(callerSuppliedRes.ready, false);
    assert.equal(callerSuppliedRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.match(callerSuppliedRes.reason, /caller-supplied boolean flag/i);

    const containerProvider = new ContainerProvider();
    const cpRes = containerProvider.verifyEvidence({ verified: true });
    assert.equal(cpRes.verified, false);
    assert.equal(cpRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.match(cpRes.reason, /caller-supplied boolean flag/i);
  }

  // -------------------------------------------------------------------------
  // 18. Testing Adversarial Isolation Gate Bypass & Protections (Milestone V44.27)
  // -------------------------------------------------------------------------
  console.log('18. Testing Adversarial Isolation Gate Bypass & Protections (Milestone V44.27)...');
  {
    const { ProjectContainerExecutionRunner } = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');
    const { ContainerProvider } = require('../electron/coding-pipeline/providers/containerProvider.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES, IsolationProviderRegistry } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');
    const { discoverIsolationRuntimes } = require('../electron/coding-pipeline/isolationRuntimeDiscovery.cjs');

    discoverIsolationRuntimes();

    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });

    // 18.A: Direct execution bypass attempts fail-closed
    // 18.A.1: Unregistered provider
    const unregRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: { providerId: 'non-existent-prov', supportedOps: ['test'], isolationVerified: true },
    });
    assert.equal(unregRes.ok, false);
    assert.equal(unregRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(unregRes.reason, /not registered/i);

    // 18.A.2: Registered but not ready provider
    const notReadyRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: { providerId: 'docker', supportedOps: ['test'], isolationVerified: true },
    });
    assert.equal(notReadyRes.ok, false);
    assert.equal(notReadyRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(notReadyRes.reason, /not ready or not verified/i);

    // 18.B: Forged evidence rejection
    const baseDescriptor = {
      providerId: 'docker',
      supportedPlatforms: [process.platform],
      isReady: false,
      capabilityVerificationStatus: PROVIDER_STATUSES.UNKNOWN,
      filesystemCapabilities: { readOnlyRoot: true, restrictedBindMounts: true },
      networkCapabilities: { egressFiltering: true },
      resourceLimits: { memoryCapSupported: true, cpuThrottlingSupported: true, timeoutEnforcementSupported: true },
      processCapabilities: { hostObservedTermination: true, runtimeSupervisorVerified: true },
    };

    const forgedIndep = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { independentlyVerified: true },
    });
    assert.equal(forgedIndep.ready, false);
    assert.equal(forgedIndep.status, PROVIDER_STATUSES.BLOCKED);
    assert.match(forgedIndep.reason, /caller-supplied boolean flag/i);

    const cp = new ContainerProvider();
    assert.equal(cp.verifyEvidence({ independentlyVerified: true }).verified, false);

    // 18.C: Stale, future-dated, and context-mismatched evidence rejection
    const futureRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { evidenceTimestamp: new Date(Date.now() + 1000000).toISOString() },
    });
    assert.equal(futureRes.ready, false);
    assert.match(futureRes.reason, /future-dated/i);

    const staleRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { evidenceTimestamp: new Date(Date.now() - 600000).toISOString() },
      context: { maxEvidenceAgeMs: 300000 },
    });
    assert.equal(staleRes.ready, false);
    assert.match(staleRes.reason, /stale/i);

    const mismatchRootRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { projectRoot: 'c:/other/project' },
      context: { projectRoot: 'c:/intended/project' },
    });
    assert.equal(mismatchRootRes.ready, false);
    assert.match(mismatchRootRes.reason, /project root mismatch/i);

    const mismatchSessRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { sessionId: 'sess-a' },
      context: { sessionId: 'sess-b' },
    });
    assert.equal(mismatchSessRes.ready, false);
    assert.match(mismatchSessRes.reason, /session binding mismatch/i);

    const mismatchNonceRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { nonce: 'nonce-a' },
      context: { nonce: 'nonce-b' },
    });
    assert.equal(mismatchNonceRes.ready, false);
    assert.match(mismatchNonceRes.reason, /nonce mismatch/i);

    // 18.D: Provider descriptor mutation & deep freezing
    const testRegistry = new IsolationProviderRegistry();
    const desc = testRegistry.registerProvider({
      providerId: 'test-prov',
      capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
    });
    assert.equal(desc.capabilityVerificationStatus, PROVIDER_STATUSES.BLOCKED);
    assert.equal(desc.isReady, false);
    assert.ok(Object.isFrozen(desc));
    assert.ok(Object.isFrozen(desc.availability));
    assert.ok(Object.isFrozen(desc.blockingReasons));
    assert.ok(Object.isFrozen(desc.supportedPlatforms));

    // 18.E: Policy conflict & strictness
    const conflictRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      requestedPolicy: { requireEgressFiltering: true },
      policy: { requireEgressFiltering: false },
    });
    assert.equal(conflictRes.ready, false);
    assert.equal(conflictRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.match(conflictRes.reason, /conflicting policy specifications/i);

    // 18.G: Cleanup failures & absence verification
    const failingQueryRunner = new ProjectContainerExecutionRunner({
      dockerCli: () => ({ status: 1, error: 'Daemon connection reset', stdout: '', stderr: 'error' }),
      isMock: false,
    });
    const cleanupQueryFail = await failingQueryRunner._verifyCleanup('test-label');
    assert.equal(cleanupQueryFail.cleaned, false);
    assert.equal(cleanupQueryFail.status, 'CLEANUP_FAILED');

    let callCount = 0;
    const failingConfirmRunner = new ProjectContainerExecutionRunner({
      dockerCli: (bin, args) => {
        callCount++;
        if (args[0] === 'ps' && callCount === 1) return { status: 0, stdout: 'cont-1', stderr: '' };
        if (args[0] === 'rm') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'ps' && callCount === 3) return { status: 1, error: 'Network error', stdout: '', stderr: 'err' };
        return { status: 0, stdout: '', stderr: '' };
      },
      isMock: false,
    });
    const cleanupConfirmFail = await failingConfirmRunner._verifyCleanup('test-label');
    assert.equal(cleanupConfirmFail.cleaned, false);
    assert.equal(cleanupConfirmFail.status, 'CLEANUP_FAILED');

    const missingLabelRes = await realRunner._verifyCleanup('');
    assert.equal(missingLabelRes.cleaned, false);
    assert.equal(missingLabelRes.status, 'CLEANUP_FAILED');
  }

  // -------------------------------------------------------------------------
  // 19. Cryptographic Evidence Schema & Signature Verification Contract (Milestone V44.29)
  // -------------------------------------------------------------------------
  console.log('19. Testing Cryptographic Evidence Schema & Signature Verification Contract (Milestone V44.29)...');
  {
    const evidenceContract = require('../electron/coding-pipeline/executionEvidenceContract.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');
    const {
      CURRENT_ATTESTATION_SCHEMA_VERSION,
      SUPPORTED_SIGNATURE_ALGORITHMS,
      canonicalizeJson,
      createAttestationPayload,
      signAttestationPayload,
      verifyAttestationSignature,
      validateExecutionEvidenceManifest,
    } = evidenceContract;

    const baseDescriptor = {
      providerId: 'docker-container-provider',
      supportedPlatforms: ['win32', 'linux', 'darwin'],
      isReady: true,
      processCapabilities: { independentProcessTree: true, credentialIsolation: true },
      networkCapabilities: { defaultDenyAll: true },
      filesystemCapabilities: { ephemeralCopyOnWrite: true },
      resourceLimits: { timeoutEnforcementSupported: true },
    };

    // 19.A: RFC 8785 Canonicalization determinism
    const objA = { b: 2, a: 1, c: { y: 'test', x: true } };
    const objB = { c: { x: true, y: 'test' }, a: 1, b: 2 };
    assert.equal(canonicalizeJson(objA), canonicalizeJson(objB));
    assert.equal(canonicalizeJson(objA), '{"a":1,"b":2,"c":{"x":true,"y":"test"}}');
    assert.equal(canonicalizeJson(0), '0');
    assert.equal(canonicalizeJson(-0), '0');
    assert.throws(() => canonicalizeJson(Infinity), /non-finite/i);

    // 19.B: Multi-algorithm support (ed25519, es256, rsa-pss-sha256)
    const keyPairs = {
      ed25519: crypto.generateKeyPairSync('ed25519'),
      es256: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
      'rsa-pss-sha256': crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }),
    };

    const trustStore = {
      keys: new Map(),
      getPublicKey(issuerId, keyId) {
        return this.keys.get(`${issuerId}:${keyId}`) || null;
      },
    };

    for (const [algo, kp] of Object.entries(keyPairs)) {
      const pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' });
      trustStore.keys.set(`test-issuer:${algo}-key`, pubPem);

      const payload = createAttestationPayload({
        issuerId: 'test-issuer',
        keyId: `${algo}-key`,
        algorithm: algo,
      });

      const signed = signAttestationPayload({
        payload,
        privateKey: kp.privateKey,
        algorithm: algo,
        keyId: `${algo}-key`,
        issuerId: 'test-issuer',
      });

      const result = verifyAttestationSignature({
        attestation: signed,
        trustStore,
        expectedContext: { runId: payload.runId, sessionId: payload.sessionId },
      });

      assert.equal(result.state, 'AUTHENTICATED');
      assert.equal(result.valid, true);
      assert.equal(result.reasonCode, 'SIGNATURE_VERIFIED');
    }

    // 19.C: Unsigned / missing trust root fails closed
    const edKeyPair = keyPairs.ed25519;
    const edPayload = createAttestationPayload({ issuerId: 'test-issuer', keyId: 'ed-key', algorithm: 'ed25519' });
    const edSigned = signAttestationPayload({
      payload: edPayload,
      privateKey: edKeyPair.privateKey,
      algorithm: 'ed25519',
      keyId: 'ed-key',
      issuerId: 'test-issuer',
    });

    // Empty trust store -> TRUST_ROOT_NOT_ESTABLISHED
    const emptyTrustRes = verifyAttestationSignature({
      attestation: edSigned,
      trustStore: {},
    });
    assert.equal(emptyTrustRes.state, 'BLOCKED');
    assert.equal(emptyTrustRes.reasonCode, 'TRUST_ROOT_NOT_ESTABLISHED');

    // Envelope / payload issuer mismatch -> ISSUER_ID_MISMATCH
    const mismatchedIssuerSigned = { ...edSigned, issuerId: 'mismatched-authority' };
    const mismatchedIssuerRes = verifyAttestationSignature({
      attestation: mismatchedIssuerSigned,
      trustStore,
    });
    assert.equal(mismatchedIssuerRes.state, 'BLOCKED');
    assert.equal(mismatchedIssuerRes.reasonCode, 'ISSUER_ID_MISMATCH');

    // Unknown issuer in payload and envelope -> TRUST_ROOT_NOT_ESTABLISHED
    const unknownIssuerPayload = createAttestationPayload({ issuerId: 'unknown-authority', keyId: 'ed-key', algorithm: 'ed25519' });
    const unknownIssuerSigned = signAttestationPayload({
      payload: unknownIssuerPayload,
      privateKey: edKeyPair.privateKey,
      algorithm: 'ed25519',
      keyId: 'ed-key',
      issuerId: 'unknown-authority',
    });
    const unknownIssuerRes = verifyAttestationSignature({
      attestation: unknownIssuerSigned,
      trustStore,
    });
    assert.equal(unknownIssuerRes.state, 'BLOCKED');
    assert.equal(unknownIssuerRes.reasonCode, 'TRUST_ROOT_NOT_ESTABLISHED');

    // 19.D: Self-signed / caller-supplied key rejection
    const selfSignedRes = verifyAttestationSignature({
      attestation: {
        ...edSigned,
        publicKey: edKeyPair.publicKey.export({ type: 'spki', format: 'pem' }),
      },
      trustStore,
    });
    assert.equal(selfSignedRes.state, 'BLOCKED');
    assert.equal(selfSignedRes.reasonCode, 'SELF_SIGNED_KEY_REJECTED');

    // 19.E: Payload tampering detection
    const tamperedPayload = { ...edSigned.payload, runId: 'tampered-run-id' };
    const tamperedRes = verifyAttestationSignature({
      attestation: { ...edSigned, payload: tamperedPayload },
      trustStore: { getPublicKey: () => edKeyPair.publicKey },
    });
    assert.equal(tamperedRes.state, 'BLOCKED');
    assert.equal(tamperedRes.reasonCode, 'SIGNATURE_VERIFICATION_FAILED');

    // 19.F: Unsupported algorithm
    const unsupportedAlgoRes = verifyAttestationSignature({
      attestation: { ...edSigned, algorithm: 'none' },
      trustStore,
    });
    assert.equal(unsupportedAlgoRes.state, 'BLOCKED');
    assert.equal(unsupportedAlgoRes.reasonCode, 'UNSUPPORTED_ALGORITHM');

    // 19.G: Malformed public key
    const malformedKeyRes = verifyAttestationSignature({
      attestation: edSigned,
      trustStore: { getPublicKey: () => '--- NOT A VALID PEM ---' },
    });
    assert.equal(malformedKeyRes.state, 'BLOCKED');
    assert.equal(malformedKeyRes.reasonCode, 'MALFORMED_PUBLIC_KEY');

    // 19.H: Malformed signature
    const malformedSigRes = verifyAttestationSignature({
      attestation: { ...edSigned, signature: 'not_a_hex_signature' },
      trustStore: { getPublicKey: () => edKeyPair.publicKey },
    });
    assert.equal(malformedSigRes.state, 'BLOCKED');
    assert.equal(malformedSigRes.reasonCode, 'MALFORMED_SIGNATURE');

    // 19.I: Context bindings mismatch (runId, sessionId, nonce, policyDigest, etc.)
    const mismatchRes = verifyAttestationSignature({
      attestation: edSigned,
      trustStore: { getPublicKey: () => edKeyPair.publicKey },
      expectedContext: { runId: 'different-run-id' },
    });
    assert.equal(mismatchRes.state, 'BLOCKED');
    assert.equal(mismatchRes.reasonCode, 'CONTEXT_BINDING_MISMATCH');

    // 19.J: Expiration & future dating
    const expiredPayload = createAttestationPayload({
      issuerId: 'test-issuer',
      keyId: 'ed-key',
      algorithm: 'ed25519',
      issuedAt: new Date(Date.now() - 100000).toISOString(),
      expiresAt: new Date(Date.now() - 50000).toISOString(),
    });
    const expiredSigned = signAttestationPayload({
      payload: expiredPayload,
      privateKey: edKeyPair.privateKey,
      keyId: 'ed-key',
      issuerId: 'test-issuer',
    });
    const expiredRes = verifyAttestationSignature({
      attestation: expiredSigned,
      trustStore: { getPublicKey: () => edKeyPair.publicKey },
    });
    assert.equal(expiredRes.state, 'BLOCKED');
    assert.equal(expiredRes.reasonCode, 'EVIDENCE_EXPIRED');

    const futurePayload = createAttestationPayload({
      issuerId: 'test-issuer',
      keyId: 'ed-key',
      algorithm: 'ed25519',
      issuedAt: new Date(Date.now() + 200000).toISOString(),
      expiresAt: new Date(Date.now() + 500000).toISOString(),
    });
    const futureSigned = signAttestationPayload({
      payload: futurePayload,
      privateKey: edKeyPair.privateKey,
      keyId: 'ed-key',
      issuerId: 'test-issuer',
    });
    const futureRes = verifyAttestationSignature({
      attestation: futureSigned,
      trustStore: { getPublicKey: () => edKeyPair.publicKey },
    });
    assert.equal(futureRes.state, 'BLOCKED');
    assert.equal(futureRes.reasonCode, 'EVIDENCE_FUTURE_DATED');

    // 19.K: Replay protection via consumed nonces
    const consumedNonces = new Set();
    const replayPayload = createAttestationPayload({
      issuerId: 'test-issuer',
      keyId: 'ed-key',
      algorithm: 'ed25519',
    });
    const replaySigned = signAttestationPayload({
      payload: replayPayload,
      privateKey: edKeyPair.privateKey,
      keyId: 'ed-key',
      issuerId: 'test-issuer',
    });
    const firstUse = verifyAttestationSignature({
      attestation: replaySigned,
      trustStore: { getPublicKey: () => edKeyPair.publicKey },
      expectedContext: { consumedNonces },
    });
    assert.equal(firstUse.state, 'AUTHENTICATED');
    const secondUse = verifyAttestationSignature({
      attestation: replaySigned,
      trustStore: { getPublicKey: () => edKeyPair.publicKey },
      expectedContext: { consumedNonces },
    });
    assert.equal(secondUse.state, 'BLOCKED');
    assert.equal(secondUse.reasonCode, 'NONCE_REPLAYED');

    // 19.L: Capability Verifier gate integration
    // When signed attestation is passed, verifier validates signature against trustStore.
    // In production (no trustStore), verifyIsolationCapabilities returns BLOCKED with TRUST_ROOT_NOT_ESTABLISHED.
    const verifierProdRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { attestation: edSigned },
      context: { runId: edPayload.runId },
    });
    assert.equal(verifierProdRes.ready, false);
    assert.equal(verifierProdRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(verifierProdRes.reasonCode, 'TRUST_ROOT_NOT_ESTABLISHED');

    // Even with a valid signature from test trustStore, real provider execution gate remains BLOCKED
    const realContainerDesc = await new ContainerProvider().discoverCapabilities();
    const verifierTestRes = verifyIsolationCapabilities({
      providerDescriptor: realContainerDesc,
      evidence: { attestation: edSigned },
      context: {
        runId: edPayload.runId,
        trustStore: { getPublicKey: () => edKeyPair.publicKey },
      },
    });
    assert.equal(verifierTestRes.ready, false);
    assert.equal(verifierTestRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.ok(verifierTestRes.blockingReasons.length > 0);
  }

  // -------------------------------------------------------------------------
  // 20. Out-of-Process Evidence Issuer Boundary & Service Contract (Milestone V44.30)
  // -------------------------------------------------------------------------
  console.log('20. Testing Out-of-Process Evidence Issuer Boundary & Service Contract (Milestone V44.30)...');
  {
    const {
      ISSUER_SERVICE_STATES,
      ISSUER_TRUST_DOMAINS,
      EVIDENCE_FACT_ORIGINS,
      evaluateIssuerServiceBoundary,
      collectEvidenceFacts,
      validateIssuerRequest,
      issueAttestation,
      authorizeExecution,
      verifyAttestationSignature,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');

    const randomDigest = () => crypto.randomBytes(32).toString('hex');

    const baseDescriptor = {
      providerId: 'docker-container-provider',
      supportedPlatforms: ['win32', 'linux', 'darwin'],
      isReady: true,
      processCapabilities: { independentProcessTree: true, credentialIsolation: true },
      networkCapabilities: { defaultDenyAll: true },
      filesystemCapabilities: { ephemeralCopyOnWrite: true },
      resourceLimits: { timeoutEnforcementSupported: true },
    };

    // Helper: Valid synthetic issuer service descriptor
    const validSyntheticService = {
      serviceId: 'synthetic-test-issuer',
      isSyntheticTestService: true,
      hasIndependentOsIdentity: true,
      hasIsolatedIpcChannel: true,
      hasProtectedKeyStorage: true,
      isAuthenticated: true,
      isAvailable: true,
      domain: ISSUER_TRUST_DOMAINS.ISOLATED_HOST_SERVICE,
    };

    // 20.A: Ordinary child process is rejected as NOT_A_SECURITY_BOUNDARY
    const childProcessCheck = evaluateIssuerServiceBoundary({
      serviceId: 'spawned-child-service',
      isOrdinaryChildProcess: true,
      runsInUserDesktopSession: true,
    });
    assert.equal(childProcessCheck.state, ISSUER_SERVICE_STATES.NOT_TRUSTED);
    assert.equal(childProcessCheck.isTrustedBoundary, false);
    assert.equal(childProcessCheck.reasonCode, 'NOT_A_SECURITY_BOUNDARY');

    // 20.B: Renderer or Provider impersonating issuer domain is rejected
    const rendererDomainCheck = evaluateIssuerServiceBoundary({
      serviceId: 'renderer-fake-service',
      domain: ISSUER_TRUST_DOMAINS.ELECTRON_RENDERER,
      hasIndependentOsIdentity: true,
      hasIsolatedIpcChannel: true,
      hasProtectedKeyStorage: true,
    });
    assert.equal(rendererDomainCheck.state, ISSUER_SERVICE_STATES.NOT_TRUSTED);
    assert.equal(rendererDomainCheck.reasonCode, 'DOMAIN_CANNOT_ISSUE');

    const providerDomainCheck = evaluateIssuerServiceBoundary({
      serviceId: 'provider-fake-service',
      domain: ISSUER_TRUST_DOMAINS.PROVIDER_ADAPTER,
      hasIndependentOsIdentity: true,
      hasIsolatedIpcChannel: true,
      hasProtectedKeyStorage: true,
    });
    assert.equal(providerDomainCheck.state, ISSUER_SERVICE_STATES.NOT_TRUSTED);
    assert.equal(providerDomainCheck.reasonCode, 'DOMAIN_CANNOT_ISSUE');

    // 20.C: Missing OS security boundary (no independent OS identity/IPC/storage)
    const missingBoundaryCheck = evaluateIssuerServiceBoundary({
      serviceId: 'unprotected-service',
      hasIndependentOsIdentity: false,
      hasIsolatedIpcChannel: false,
      hasProtectedKeyStorage: false,
    });
    assert.equal(missingBoundaryCheck.state, ISSUER_SERVICE_STATES.NOT_TRUSTED);
    assert.equal(missingBoundaryCheck.reasonCode, 'OS_BOUNDARY_INSUFFICIENT');

    // 20.D: Service availability & crash failure semantics
    const unavailCheck = evaluateIssuerServiceBoundary({
      ...validSyntheticService,
      isAvailable: false,
    });
    assert.equal(unavailCheck.state, ISSUER_SERVICE_STATES.UNAVAILABLE);
    assert.equal(unavailCheck.reasonCode, 'ISSUER_UNAVAILABLE');

    const crashCheck = evaluateIssuerServiceBoundary({
      ...validSyntheticService,
      isCrashed: true,
    });
    assert.equal(crashCheck.state, ISSUER_SERVICE_STATES.UNAVAILABLE);
    assert.equal(crashCheck.reasonCode, 'SERVICE_CRASHED');

    // 20.E: Revoked service
    const revokedCheck = evaluateIssuerServiceBoundary({
      ...validSyntheticService,
      isRevoked: true,
    });
    assert.equal(revokedCheck.state, ISSUER_SERVICE_STATES.REVOKED);
    assert.equal(revokedCheck.reasonCode, 'ISSUER_REVOKED');

    // 20.F: Production service reports INDEPENDENT_ISSUER_NOT_IMPLEMENTED
    const prodServiceCheck = evaluateIssuerServiceBoundary({
      serviceId: 'production-host-issuer',
      isProductionService: true,
      isSyntheticTestService: false,
      hasIndependentOsIdentity: true,
      hasIsolatedIpcChannel: true,
      hasProtectedKeyStorage: true,
      isAuthenticated: true,
      isAvailable: true,
    });
    assert.equal(prodServiceCheck.state, ISSUER_SERVICE_STATES.NOT_CONFIGURED);
    assert.equal(prodServiceCheck.reasonCode, 'INDEPENDENT_ISSUER_NOT_IMPLEMENTED');

    // 20.G: Request validation: Renderer requesting issuance directly is rejected
    const validRequest = {
      requestId: crypto.randomUUID(),
      requestTimestamp: new Date().toISOString(),
      nonce: crypto.randomUUID(),
      sessionId: 'sess-test-1',
      runId: 'run-test-1',
      grantId: crypto.randomUUID(),
      projectIdentityDigest: randomDigest(),
      policyDigest: randomDigest(),
      verificationPlanDigest: randomDigest(),
      providerId: 'docker-container-provider',
      runtimeId: 'docker-runc',
      requestedCapabilities: ['processIsolation', 'networkDeny'],
      claimsToVerify: {},
      callerAuthorization: {
        sourceDomain: ISSUER_TRUST_DOMAINS.ELECTRON_MAIN,
        isAuthorized: true,
      },
    };

    const rendererRequestCheck = validateIssuerRequest({
      request: {
        ...validRequest,
        requestId: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        callerAuthorization: { sourceDomain: ISSUER_TRUST_DOMAINS.ELECTRON_RENDERER, isAuthorized: true },
      },
      serviceDescriptor: validSyntheticService,
    });
    assert.equal(rendererRequestCheck.state, 'BLOCKED');
    assert.equal(rendererRequestCheck.reasonCode, 'UNTRUSTED_CALLER_DOMAIN');

    // 20.H: Request validation: Unauthenticated request
    const unauthRequestCheck = validateIssuerRequest({
      request: {
        ...validRequest,
        requestId: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        callerAuthorization: { sourceDomain: ISSUER_TRUST_DOMAINS.ELECTRON_MAIN, isAuthorized: false },
      },
      serviceDescriptor: validSyntheticService,
    });
    assert.equal(unauthRequestCheck.state, 'BLOCKED');
    assert.equal(unauthRequestCheck.reasonCode, 'UNAUTHORIZED_REQUEST');

    // 20.I: Request validation: Caller-forged credentials rejected
    const forgedIssuerCheck = validateIssuerRequest({
      request: { ...validRequest, requestId: crypto.randomUUID(), nonce: crypto.randomUUID(), issuerId: 'attacker-issuer' },
      serviceDescriptor: validSyntheticService,
    });
    assert.equal(forgedIssuerCheck.state, 'BLOCKED');
    assert.equal(forgedIssuerCheck.reasonCode, 'CALLER_FORGED_ISSUER_IDENTITY');

    const forgedSigCheck = validateIssuerRequest({
      request: { ...validRequest, requestId: crypto.randomUUID(), nonce: crypto.randomUUID(), signature: 'forged' },
      serviceDescriptor: validSyntheticService,
    });
    assert.equal(forgedSigCheck.state, 'BLOCKED');
    assert.equal(forgedSigCheck.reasonCode, 'CALLER_FORGED_SIGNATURE');

    const forgedPubkeyCheck = validateIssuerRequest({
      request: { ...validRequest, requestId: crypto.randomUUID(), nonce: crypto.randomUUID(), publicKey: 'forged-pubkey' },
      serviceDescriptor: validSyntheticService,
    });
    assert.equal(forgedPubkeyCheck.state, 'BLOCKED');
    assert.equal(forgedPubkeyCheck.reasonCode, 'SELF_SIGNED_KEY_REJECTED');

    // 20.J: Replay protection on request and nonce
    const activeNonces = new Set();
    const req1 = { ...validRequest, requestId: crypto.randomUUID(), nonce: crypto.randomUUID() };
    const res1 = validateIssuerRequest({ request: req1, serviceDescriptor: validSyntheticService, activeNonces });
    assert.equal(res1.state, 'VALID');
    assert.equal(res1.reasonCode, 'REQUEST_VALIDATED');

    const replayRes = validateIssuerRequest({ request: req1, serviceDescriptor: validSyntheticService, activeNonces });
    assert.equal(replayRes.state, 'BLOCKED');
    assert.equal(replayRes.reasonCode, 'REPLAY_DETECTED');

    // 20.K: Context binding substitution rejection
    const contextSubReq = { ...validRequest, requestId: crypto.randomUUID(), nonce: crypto.randomUUID(), runId: 'substituted-run' };
    const contextSubRes = validateIssuerRequest({
      request: contextSubReq,
      serviceDescriptor: validSyntheticService,
      expectedContext: { runId: 'original-run' },
    });
    assert.equal(contextSubRes.state, 'BLOCKED');
    assert.equal(contextSubRes.reasonCode, 'CONTEXT_BINDING_MISMATCH');

    // 20.L: Evidence collection and fact origins separation
    const facts = collectEvidenceFacts({
      callerClaims: { processIsolation: true },
      providerClaims: { networkDeny: true },
      hostObservations: { processIsolation: true },
      kernelObservations: { networkDeny: true },
    });
    assert.equal(facts.length, 4);
    assert.equal(facts[0].origin, EVIDENCE_FACT_ORIGINS.CALLER_CONFIGURATION);
    assert.equal(facts[1].origin, EVIDENCE_FACT_ORIGINS.PROVIDER_REPORTED);
    assert.equal(facts[2].origin, EVIDENCE_FACT_ORIGINS.HOST_OBSERVED);
    assert.equal(facts[3].origin, EVIDENCE_FACT_ORIGINS.KERNEL_ENFORCED);

    // 20.M: Issuance fails closed on unverified runtime claims (caller claims only)
    const validReqForIssuance = { ...validRequest, requestId: crypto.randomUUID(), nonce: crypto.randomUUID() };
    const validatedOutcome = validateIssuerRequest({
      request: validReqForIssuance,
      serviceDescriptor: validSyntheticService,
    });
    assert.equal(validatedOutcome.state, 'VALID');

    const callerOnlyFacts = [
      { fact: 'processIsolation', value: true, origin: EVIDENCE_FACT_ORIGINS.CALLER_CONFIGURATION },
      { fact: 'networkDeny', value: true, origin: EVIDENCE_FACT_ORIGINS.PROVIDER_REPORTED },
    ];
    const unverifiedIssuance = issueAttestation({
      validatedRequestResult: validatedOutcome,
      observedFacts: callerOnlyFacts,
      serviceDescriptor: validSyntheticService,
    });
    assert.equal(unverifiedIssuance.status, 'ISSUANCE_FAILED');
    assert.equal(unverifiedIssuance.errorCode, 'UNVERIFIED_RUNTIME_FACTS');

    // 20.N: Synthetic issuance with host-observed facts and test signing key succeeds
    const testKeyPair = crypto.generateKeyPairSync('ed25519');
    const verifiedFacts = [
      { fact: 'processIsolation', value: true, origin: EVIDENCE_FACT_ORIGINS.HOST_OBSERVED },
      { fact: 'networkDeny', value: true, origin: EVIDENCE_FACT_ORIGINS.KERNEL_ENFORCED },
    ];
    const issuanceOutcome = issueAttestation({
      validatedRequestResult: validatedOutcome,
      observedFacts: verifiedFacts,
      serviceDescriptor: validSyntheticService,
      signingKeyContext: {
        privateKey: testKeyPair.privateKey,
        keyId: 'test-key-1',
        algorithm: 'ed25519',
      },
    });
    assert.equal(issuanceOutcome.status, 'ISSUED');
    assert.ok(issuanceOutcome.attestationEnvelope);

    // 20.O: Final execution authorization gate remains BLOCKED with zero fallback
    const trustStore = {
      getPublicKey: (issuer, key) => (key === 'test-key-1' ? testKeyPair.publicKey : null),
    };
    const attestationVerificationResult = verifyAttestationSignature({
      attestation: issuanceOutcome.attestationEnvelope,
      trustStore,
      expectedContext: {
        runId: validReqForIssuance.runId,
        sessionId: validReqForIssuance.sessionId,
      },
    });
    assert.equal(attestationVerificationResult.valid, true);

    const authResult = authorizeExecution({
      attestationVerificationResult,
      serviceDescriptor: validSyntheticService,
      providerDescriptor: baseDescriptor,
      osEnforcementEvidence: { kernelEnforced: false }, // Not verified on Windows
    });
    assert.equal(authResult.state, 'BLOCKED');
    assert.equal(authResult.reasonCode, 'OS_ENFORCEMENT_NOT_VERIFIED');

    // 20.P: Caller-supplied issuerService in evidence rejected by verifier
    const callerSuppliedIssuerRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { issuerService: validSyntheticService },
    });
    assert.equal(callerSuppliedIssuerRes.ready, false);
    assert.equal(callerSuppliedIssuerRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(callerSuppliedIssuerRes.reasonCode, 'CALLER_FORGED_ISSUER_SERVICE');
  }

  // -------------------------------------------------------------------------
  // 21. [V44.31] Docker Host Observation & Daemon Trust Boundary
  // -------------------------------------------------------------------------
  console.log('21. [V44.31] Testing Docker host observation, daemon trust boundary & kernel enforcement separation...');
  {
    const {
      DOCKER_DAEMON_TRUST_STATES,
      DOCKER_OBSERVATION_STATES,
      evaluateDockerDaemonTrust,
      bindDockerObservationEvidence,
      evaluateDockerObservation,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { validateDockerEndpointPolicy } = require('../electron/coding-pipeline/dockerProviderAdapter.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');

    const baseDescriptor = {
      providerId: 'docker',
      supportedPlatforms: ['win32', 'linux', 'darwin'],
      isReady: true,
      capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      availability: { isRunning: true },
      capabilities: {},
    };

    const validObservation = {
      daemonId: 'daemon-uuid-1',
      endpoint: 'npipe:////./pipe/docker_engine',
      containerId: 'container-64hex-abc',
      containerCreationIdentity: 'creation-digest-1',
      executionId: 'exec-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      grantId: 'grant-1',
      policyDigest: 'policy-digest-1',
      planDigest: 'plan-digest-1',
      observationTimestamp: new Date().toISOString(),
      nonce: crypto.randomUUID(),
      networkMode: 'none',
      configuredReadOnly: true,
      daemonReportedReadOnly: true,
      memoryLimitBytes: 536870912,
      mounts: [],
    };

    // 21.A: Unauthenticated Docker endpoint (TCP endpoint without TLS)
    const tcpPolicyCheck = validateDockerEndpointPolicy({
      contextName: 'default',
      endpoint: 'tcp://127.0.0.1:2375',
      environment: {},
      platform: 'win32',
    });
    assert.equal(tcpPolicyCheck.valid, false);
    assert.equal(tcpPolicyCheck.reasonCode, 'DOCKER_TCP_ENDPOINT_UNAUTHENTICATED');

    const tcpTrust = evaluateDockerDaemonTrust({
      endpoint: 'tcp://127.0.0.1:2375',
      endpointCert: { tlsEnabled: false },
    });
    assert.equal(tcpTrust.isTrusted, false);
    assert.equal(tcpTrust.trustState, DOCKER_DAEMON_TRUST_STATES.TLS_UNVERIFIED);
    assert.equal(tcpTrust.reasonCode, 'TLS_UNVERIFIED');

    // 21.B: Endpoint substitution rejected
    const subTrust = evaluateDockerDaemonTrust({
      endpoint: 'npipe:////./pipe/docker_engine',
      callerOverrides: { hasOverride: true, DOCKER_HOST: 'tcp://evil.remote:2375' },
    });
    assert.equal(subTrust.isTrusted, false);
    assert.equal(subTrust.trustState, DOCKER_DAEMON_TRUST_STATES.ENDPOINT_UNTRUSTED);
    assert.equal(subTrust.reasonCode, 'ENDPOINT_SUBSTITUTION_REJECTED');

    // 21.C: Untrusted daemon certificate on TCP endpoint
    const uncertTrust = evaluateDockerDaemonTrust({
      endpoint: 'tcp://127.0.0.1:2376',
      endpointCert: { tlsEnabled: true, cert: 'self-signed-cert' },
      trustStore: { verifyCertificate: () => false },
    });
    assert.equal(uncertTrust.isTrusted, false);
    assert.equal(uncertTrust.trustState, DOCKER_DAEMON_TRUST_STATES.CERTIFICATE_UNTRUSTED);
    assert.equal(uncertTrust.reasonCode, 'CERTIFICATE_UNTRUSTED');

    // 21.D: Caller-supplied daemon trust rejected
    const forgedDaemonRes = verifyIsolationCapabilities({
      providerDescriptor: baseDescriptor,
      evidence: { daemonTrust: 'VERIFIED' },
    });
    assert.equal(forgedDaemonRes.ready, false);
    assert.equal(forgedDaemonRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(forgedDaemonRes.reasonCode, 'CALLER_FORGED_DAEMON_TRUST');

    // 21.E: Forged container identity in observation binding rejected
    const forgedContainerObs = {
      ...validObservation,
      nonce: crypto.randomUUID(),
      containerId: 'attacker-container-id',
    };
    const forgedContainerRes = bindDockerObservationEvidence({
      observation: forgedContainerObs,
      expectedBindings: { containerId: 'container-64hex-abc' },
    });
    assert.equal(forgedContainerRes.valid, false);
    assert.equal(forgedContainerRes.reasonCode, 'FORGED_CONTAINER_IDENTITY');

    // 21.F: Configuration mistaken for enforcement alone does not prove kernel enforcement
    const configOnlyObs = {
      ...validObservation,
      nonce: crypto.randomUUID(),
      configuredReadOnly: true,
      daemonReportedReadOnly: false,
    };
    const configOnlyEval = evaluateDockerObservation({
      observation: configOnlyObs,
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
      mountEvidence: { kernelEnforcedReadOnly: false },
    });
    assert.equal(configOnlyEval.readOnlyRootfs, DOCKER_OBSERVATION_STATES.NOT_CONFIGURED);
    assert.notEqual(configOnlyEval.readOnlyRootfs, DOCKER_OBSERVATION_STATES.KERNEL_ENFORCED);

    // 21.G: Daemon-reported state mistaken for kernel state
    const daemonInspectEval = evaluateDockerObservation({
      observation: { ...validObservation, nonce: crypto.randomUUID() },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
      mountEvidence: null,
    });
    assert.equal(daemonInspectEval.readOnlyRootfs, DOCKER_OBSERVATION_STATES.DAEMON_REPORTED);
    assert.equal(daemonInspectEval.kernelEnforcement, 'NOT_VERIFIED');

    // 21.H: Missing cgroup controllers fails closed
    const cgroupMissingEval = evaluateDockerObservation({
      observation: { ...validObservation, nonce: crypto.randomUUID() },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
      cgroupEvidence: { cgroupControllersMissing: true },
    });
    assert.equal(cgroupMissingEval.state, DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED);
    assert.equal(cgroupMissingEval.reasonCode, 'CGROUP_CONTROLLERS_MISSING');
    assert.equal(cgroupMissingEval.gateStatus, 'BLOCKED');

    // 21.I: Conflicting cgroup observations (memory.max mismatch)
    const cgroupConflictEval = evaluateDockerObservation({
      observation: { ...validObservation, nonce: crypto.randomUUID(), memoryLimitBytes: 536870912 },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
      cgroupEvidence: { effectiveMemoryMax: 1073741824, controllersAvailable: true },
    });
    assert.equal(cgroupConflictEval.state, DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED);
    assert.equal(cgroupConflictEval.reasonCode, 'CGROUP_OBSERVATION_CONFLICT');

    // 21.J: Network bridge mode mistaken for verified egress filtering fails closed
    const bridgeEval = evaluateDockerObservation({
      observation: { ...validObservation, nonce: crypto.randomUUID(), networkMode: 'bridge' },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(bridgeEval.state, DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED);
    assert.equal(bridgeEval.reasonCode, 'NETWORK_EGRESS_UNVERIFIED');

    // 21.K: Cleanup query failure does not confirm removal
    const cleanupQueryFailEval = evaluateDockerObservation({
      observation: { ...validObservation, nonce: crypto.randomUUID() },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
      cleanupEvidence: { queryFailed: true },
    });
    assert.equal(cleanupQueryFailEval.state, DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED);
    assert.equal(cleanupQueryFailEval.reasonCode, 'CLEANUP_QUERY_FAILED');

    // 21.L: Container absence reported by daemon without process termination proof (orphan detected)
    const orphanEval = evaluateDockerObservation({
      observation: { ...validObservation, nonce: crypto.randomUUID() },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
      cleanupEvidence: { daemonAbsenceConfirmed: true, hostProcessesRemaining: 2 },
    });
    assert.equal(orphanEval.state, DOCKER_OBSERVATION_STATES.VERIFICATION_FAILED);
    assert.equal(orphanEval.reasonCode, 'ORPHAN_PROCESS_DETECTED');

    // 21.M: Stale observation rejected
    const staleObs = {
      ...validObservation,
      nonce: crypto.randomUUID(),
      observationTimestamp: new Date(Date.now() - 120000).toISOString(),
    };
    const staleRes = bindDockerObservationEvidence({
      observation: staleObs,
      maxObservationAgeMs: 60000,
    });
    assert.equal(staleRes.valid, false);
    assert.equal(staleRes.reasonCode, 'OBSERVATION_STALE');

    // 21.N: Cross-project evidence substitution rejected
    const crossProjObs = {
      ...validObservation,
      nonce: crypto.randomUUID(),
      projectId: 'other-project-id',
    };
    const crossProjRes = bindDockerObservationEvidence({
      observation: crossProjObs,
      expectedBindings: { projectId: 'proj-1' },
    });
    assert.equal(crossProjRes.valid, false);
    assert.equal(crossProjRes.reasonCode, 'CROSS_PROJECT_EVIDENCE_SUBSTITUTION');

    // 21.O: Caller-forged INDEPENDENTLY_VERIFIED rejected
    const forgedVerifiedObs = {
      ...validObservation,
      nonce: crypto.randomUUID(),
      independentlyVerified: true,
    };
    const forgedVerifiedRes = bindDockerObservationEvidence({
      observation: forgedVerifiedObs,
    });
    assert.equal(forgedVerifiedRes.valid, false);
    assert.equal(forgedVerifiedRes.reasonCode, 'CALLER_FORGED_OBSERVATION_STATE');

    // 21.P: Missing observation fails closed
    const missingObsEval = evaluateDockerObservation({ observation: null });
    assert.equal(missingObsEval.state, DOCKER_OBSERVATION_STATES.NOT_CONFIGURED);
    assert.equal(missingObsEval.gateStatus, 'BLOCKED');

    // 21.Q: Overall evaluation in production reports DOCKER_DAEMON_TRUST NOT_ESTABLISHED and gate BLOCKED
    const prodEval = evaluateDockerObservation({
      observation: { ...validObservation, nonce: crypto.randomUUID() },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(prodEval.daemonTrust, DOCKER_DAEMON_TRUST_STATES.NOT_ESTABLISHED);
    assert.equal(prodEval.kernelEnforcement, 'NOT_VERIFIED');
    assert.equal(prodEval.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(prodEval.gateStatus, 'BLOCKED');
    assert.equal(prodEval.isVerified, false);
  }

  // -------------------------------------------------------------------------
  // 22. [V44.32] Host Kernel Enforcement Observer — Cgroups & Read-Only Filesystem
  // -------------------------------------------------------------------------
  console.log('22. [V44.32] Testing host kernel enforcement observer, cgroups v2 & read-only mount telemetry...');
  {
    const {
      KERNEL_OBSERVATION_STATES,
      validateCgroupV2Enforcement,
      validateReadOnlyMountEnforcement,
      evaluateHostKernelEnforcement,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');

    const baseDescriptor = {
      providerId: 'docker',
      supportedPlatforms: ['win32', 'linux', 'darwin'],
      isReady: true,
      capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      availability: { isRunning: true },
      capabilities: {},
    };

    const validCgroupObservation = {
      cgroupVersion: 2,
      isCgroupV2: true,
      cgroupPath: '/sys/fs/cgroup/docker/container-abc-123/',
      controllers: ['cpu', 'memory', 'pids'],
      cpuMax: '50000 100000',
      memoryMax: '536870912',
      pidsMax: '64',
    };

    const validMountObservation = {
      mountNamespaceId: 'mnt:[4026532456]',
      mounts: [
        { destination: '/', target: '/', flags: ['ro', 'nodev', 'noexec'], readOnly: true },
        { destination: '/workspace', target: '/workspace', flags: ['ro'], readOnly: true, isBindMount: true },
        { destination: '/tmp', target: '/tmp', flags: ['rw', 'noexec', 'nosuid', 'nodev'], readOnly: false },
      ],
    };

    const validKernelObservation = {
      evidenceSource: 'host_kernel_telemetry',
      verificationMethod: 'CGROUP_V2_AND_MOUNTINFO_PROBE',
      containerId: 'container-abc-123',
      cgroupPath: '/sys/fs/cgroup/docker/container-abc-123/',
      mountNamespaceId: 'mnt:[4026532456]',
      projectId: 'proj-1',
      executionId: 'exec-1',
      policyDigest: 'policy-digest-1',
      verificationPlanDigest: 'plan-digest-1',
      observationTimestamp: new Date().toISOString(),
      nonce: crypto.randomUUID(),
      verificationState: 'HOST_OBSERVED',
      observerAuthentication: 'AUTHENTICATED',
      hasIndependentSecurityPrincipal: true,
      cgroupObservation: validCgroupObservation,
      mountObservation: validMountObservation,
    };

    // 22.1: Missing cgroup v2 hierarchy
    const v1Res = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, cgroupVersion: 1, isCgroupV2: false },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(v1Res.valid, false);
    assert.equal(v1Res.reasonCode, 'CGROUP_V2_HIERARCHY_MISSING');

    // 22.2: Missing CPU controller
    const noCpuRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, controllers: ['memory', 'pids'] },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(noCpuRes.valid, false);
    assert.equal(noCpuRes.reasonCode, 'CPU_CONTROLLER_MISSING');

    // 22.3: Missing memory controller
    const noMemRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, controllers: ['cpu', 'pids'] },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(noMemRes.valid, false);
    assert.equal(noMemRes.reasonCode, 'MEMORY_CONTROLLER_MISSING');

    // 22.4: Missing PID controller
    const noPidsRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, controllers: ['cpu', 'memory'] },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(noPidsRes.valid, false);
    assert.equal(noPidsRes.reasonCode, 'PIDS_CONTROLLER_MISSING');

    // 22.5: Unlimited CPU quota when policy requires limits
    const unlimCpuRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, cpuMax: 'max 100000' },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(unlimCpuRes.valid, false);
    assert.equal(unlimCpuRes.reasonCode, 'UNEXPECTED_UNLIMITED_CPU');

    // 22.6: Unlimited memory limit when policy requires limits
    const unlimMemRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, memoryMax: 'max' },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(unlimMemRes.valid, false);
    assert.equal(unlimMemRes.reasonCode, 'UNEXPECTED_UNLIMITED_MEMORY');

    // 22.7: Unlimited PID limit when policy requires limits
    const unlimPidsRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, pidsMax: 'max' },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(unlimPidsRes.valid, false);
    assert.equal(unlimPidsRes.reasonCode, 'UNEXPECTED_UNLIMITED_PIDS');

    // 22.8: Malformed cgroup values (CPU, memory, PID)
    const malformedCpuRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, cpuMax: 'invalid-cpu-format' },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(malformedCpuRes.valid, false);
    assert.equal(malformedCpuRes.reasonCode, 'CPU_MAX_MALFORMED');

    const malformedMemRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, memoryMax: 'not-a-number' },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(malformedMemRes.valid, false);
    assert.equal(malformedMemRes.reasonCode, 'MEMORY_MAX_MALFORMED');

    const malformedPidsRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, pidsMax: '-10' },
      expectedPolicy: { requireResourceLimits: true },
    });
    assert.equal(malformedPidsRes.valid, false);
    assert.equal(malformedPidsRes.reasonCode, 'PIDS_MAX_MALFORMED');

    // 22.9: Wrong container cgroup identity
    const wrongCgroupRes = validateCgroupV2Enforcement({
      cgroupObservation: { ...validCgroupObservation, cgroupPath: '/sys/fs/cgroup/docker/different-container-id/' },
      expectedContainerId: 'container-abc-123',
    });
    assert.equal(wrongCgroupRes.valid, false);
    assert.equal(wrongCgroupRes.reasonCode, 'CGROUP_PATH_MISMATCH');

    // 22.10: Stale observation rejected
    const staleObsRes = evaluateHostKernelEnforcement({
      kernelObservation: {
        ...validKernelObservation,
        nonce: crypto.randomUUID(),
        observationTimestamp: new Date(Date.now() - 120000).toISOString(),
      },
      maxObservationAgeMs: 60000,
    });
    assert.equal(staleObsRes.valid, false);
    assert.equal(staleObsRes.reasonCode, 'STALE_OBSERVATION');

    // 22.11: Cross-project observation substitution rejected
    const crossProjRes = evaluateHostKernelEnforcement({
      kernelObservation: {
        ...validKernelObservation,
        nonce: crypto.randomUUID(),
        projectId: 'attacker-project-id',
      },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(crossProjRes.valid, false);
    assert.equal(crossProjRes.reasonCode, 'CROSS_PROJECT_OBSERVATION_SUBSTITUTION');

    // 22.12: Daemon/host observation conflict
    const daemonConflictRes = evaluateHostKernelEnforcement({
      kernelObservation: { ...validKernelObservation, nonce: crypto.randomUUID() },
      daemonInspect: {
        HostConfig: {
          Memory: 1073741824,
          ReadonlyRootfs: true,
        },
      },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(daemonConflictRes.valid, false);
    assert.equal(daemonConflictRes.reasonCode, 'DAEMON_HOST_OBSERVATION_CONFLICT');

    // 22.13: Caller-forged kernel enforcement rejected
    const forgedKernelObs = {
      ...validKernelObservation,
      nonce: crypto.randomUUID(),
      kernelEnforced: true,
    };
    const forgedKernelRes = evaluateHostKernelEnforcement({
      kernelObservation: forgedKernelObs,
    });
    assert.equal(forgedKernelRes.valid, false);
    assert.equal(forgedKernelRes.reasonCode, 'CALLER_FORGED_KERNEL_ENFORCEMENT');

    // 22.14: Writable root filesystem rejected
    const writableRootRes = validateReadOnlyMountEnforcement({
      mountObservation: {
        mountNamespaceId: 'mnt:[4026532456]',
        mounts: [
          { destination: '/', target: '/', flags: ['rw'], readOnly: false },
        ],
      },
    });
    assert.equal(writableRootRes.valid, false);
    assert.equal(writableRootRes.reasonCode, 'WRITABLE_ROOT_FILESYSTEM');

    // 22.15: Writable bind mount rejected
    const writableBindRes = validateReadOnlyMountEnforcement({
      mountObservation: {
        mountNamespaceId: 'mnt:[4026532456]',
        mounts: [
          { destination: '/', target: '/', flags: ['ro'], readOnly: true },
          { destination: '/src', target: '/src', flags: ['rw'], readOnly: false, isBindMount: true },
        ],
      },
    });
    assert.equal(writableBindRes.valid, false);
    assert.equal(writableBindRes.reasonCode, 'WRITABLE_BIND_MOUNT_DETECTED');

    // 22.16: Unexpected writable volume rejected
    const writableVolRes = validateReadOnlyMountEnforcement({
      mountObservation: {
        mountNamespaceId: 'mnt:[4026532456]',
        mounts: [
          { destination: '/', target: '/', flags: ['ro'], readOnly: true },
          { destination: '/data', target: '/data', flags: ['rw'], readOnly: false, isVolume: true },
        ],
      },
    });
    assert.equal(writableVolRes.valid, false);
    assert.equal(writableVolRes.reasonCode, 'WRITABLE_VOLUME_DETECTED');

    // 22.17: Mount namespace mismatch rejected
    const nsMismatchRes = validateReadOnlyMountEnforcement({
      mountObservation: {
        mountNamespaceId: 'mnt:[9999999999]',
        mounts: [
          { destination: '/', target: '/', flags: ['ro'], readOnly: true },
        ],
      },
      expectedMountNamespaceId: 'mnt:[4026532456]',
    });
    assert.equal(nsMismatchRes.valid, false);
    assert.equal(nsMismatchRes.reasonCode, 'MOUNT_NAMESPACE_MISMATCH');

    // 22.18: Missing independent observer authentication fails closed
    const unauthObserverRes = evaluateHostKernelEnforcement({
      kernelObservation: {
        ...validKernelObservation,
        nonce: crypto.randomUUID(),
        observerAuthentication: 'UNAUTHENTICATED',
        hasIndependentSecurityPrincipal: false,
      },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(unauthObserverRes.valid, false);
    assert.equal(unauthObserverRes.reasonCode, 'INDEPENDENT_OBSERVER_NOT_AUTHENTICATED');
    assert.equal(unauthObserverRes.kernelEnforcement, 'NOT_VERIFIED');
    assert.equal(unauthObserverRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(unauthObserverRes.gateStatus, 'BLOCKED');
  }

  // -------------------------------------------------------------------------
  // 23. Authenticated Host Observer — Trust Boundary & Evidence Collection (V44.33)
  // -------------------------------------------------------------------------
  console.log('23. Testing Authenticated Host Observer Trust Boundary & Evidence Collection (V44.33)...');
  {
    const {
      OBSERVER_IDENTITY_SOURCES,
      OBSERVER_AUTHENTICATION_STATES,
      OBSERVER_CONTEXT_BINDING_FIELDS,
      authenticateObserver,
      validateObservationContext,
      verifyObservationFreshness,
      evaluateHostKernelEnforcement,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');

    const validObserverDescriptor = {
      observerId: 'obs-system-daemon-1',
      identitySource: OBSERVER_IDENTITY_SOURCES.INDEPENDENT_AUTHENTICATED_OBSERVER,
      executablePath: '/usr/libexec/ai-help-agent/observer-daemon',
      pid: 9999,
      parentPid: 1,
      isAlive: true,
      lastHeartbeat: new Date().toISOString(),
    };

    const validPeerCredentials = {
      authenticated: true,
      peerPid: 9999,
      peerUid: 0,
      protocol: 'SO_PEERCRED',
    };

    const validIpcChannel = {
      channelType: 'unix_domain_socket',
      restrictedAcl: true,
    };

    // 23.1: Caller-forged observer identity rejected
    for (const forgedFlag of ['observerAuthenticated', 'authenticated', 'independentlyVerified', 'kernelEnforced']) {
      const res = authenticateObserver({
        observerDescriptor: {
          ...validObserverDescriptor,
          [forgedFlag]: true,
        },
        peerCredentials: validPeerCredentials,
        ipcChannel: validIpcChannel,
        isSyntheticTest: true,
      });
      assert.equal(res.isAuthenticated, false);
      assert.equal(res.state, OBSERVER_AUTHENTICATION_STATES.CALLER_FORGED);
      assert.equal(res.reasonCode, 'CALLER_FORGED_OBSERVER_IDENTITY');
    }

    // 23.2: Caller-forged kernel enforcement rejected in evaluateHostKernelEnforcement
    const forgedKernelRes = evaluateHostKernelEnforcement({
      kernelObservation: {
        evidenceSource: 'host_kernel_telemetry',
        verificationMethod: 'CGROUP_V2_AND_MOUNTINFO_PROBE',
        containerId: 'container-abc-123',
        cgroupPath: '/sys/fs/cgroup/docker/container-abc-123/',
        mountNamespaceId: 'mnt:[4026532456]',
        projectId: 'proj-1',
        executionId: 'exec-1',
        policyDigest: 'policy-digest-1',
        verificationPlanDigest: 'plan-digest-1',
        observationTimestamp: new Date().toISOString(),
        nonce: crypto.randomUUID(),
        verificationState: 'HOST_OBSERVED',
        observerAuthenticated: true,
      },
    });
    assert.equal(forgedKernelRes.valid, false);
    assert.equal(forgedKernelRes.reasonCode, 'CALLER_FORGED_KERNEL_ENFORCEMENT');

    // 23.3: Unauthenticated IPC peer rejected
    const unauthPeerRes = authenticateObserver({
      observerDescriptor: validObserverDescriptor,
      peerCredentials: { authenticated: false, peerPid: 9999 },
      ipcChannel: validIpcChannel,
      isSyntheticTest: true,
    });
    assert.equal(unauthPeerRes.isAuthenticated, false);
    assert.equal(unauthPeerRes.state, OBSERVER_AUTHENTICATION_STATES.PEER_UNAUTHENTICATED);
    assert.equal(unauthPeerRes.reasonCode, 'IPC_PEER_UNAUTHENTICATED');

    // 23.4: Invalid observer process identity (same process as runner) rejected
    const sameProcRes = authenticateObserver({
      observerDescriptor: {
        ...validObserverDescriptor,
        pid: process.pid,
      },
      peerCredentials: { authenticated: true, peerPid: process.pid },
      ipcChannel: validIpcChannel,
      processContext: { currentPid: process.pid },
      isSyntheticTest: true,
    });
    assert.equal(sameProcRes.isAuthenticated, false);
    assert.equal(sameProcRes.reasonCode, 'IN_PROCESS_OBSERVER_REJECTED');

    // 23.5: Wrong parent-child relationship (child process of runner) rejected
    const childProcRes = authenticateObserver({
      observerDescriptor: {
        ...validObserverDescriptor,
        parentPid: process.pid,
      },
      peerCredentials: validPeerCredentials,
      ipcChannel: validIpcChannel,
      processContext: { currentPid: process.pid },
      isSyntheticTest: true,
    });
    assert.equal(childProcRes.isAuthenticated, false);
    assert.equal(childProcRes.reasonCode, 'CHILD_PROCESS_OBSERVER_REJECTED');

    // 23.6: Cross-project evidence reuse rejected
    const validObsContext = {
      projectId: 'proj-1',
      projectRoot: process.cwd(),
      sessionId: 'sess-1',
      executionId: 'exec-1',
      containerId: 'container-abc-123',
      cgroupPath: '/sys/fs/cgroup/docker/container-abc-123/',
      mountNamespaceId: 'mnt:[4026532456]',
      grantId: 'grant-1',
      policyDigest: 'a'.repeat(64),
      verificationPlanDigest: 'b'.repeat(64),
      observedAt: new Date().toISOString(),
      observerNonce: crypto.randomUUID(),
    };

    const crossProjectRes = validateObservationContext({
      observation: {
        ...validObsContext,
        projectId: 'attacker-project-id',
      },
      expectedBindings: {
        projectId: 'proj-1',
        projectRoot: process.cwd(),
        sessionId: 'sess-1',
      },
    });
    assert.equal(crossProjectRes.valid, false);
    assert.equal(crossProjectRes.reasonCode, 'CROSS_PROJECT_EVIDENCE_REUSE');

    // 23.7: Cross-session evidence reuse rejected
    const crossSessionRes = validateObservationContext({
      observation: {
        ...validObsContext,
        sessionId: 'old-session-id',
      },
      expectedBindings: {
        projectId: 'proj-1',
        projectRoot: process.cwd(),
        sessionId: 'sess-1',
      },
    });
    assert.equal(crossSessionRes.valid, false);
    assert.equal(crossSessionRes.reasonCode, 'CROSS_SESSION_EVIDENCE_REUSE');

    // 23.8: Stale observation rejected
    const staleFreshRes = verifyObservationFreshness({
      observedAt: new Date(Date.now() - 120000).toISOString(),
      maxObservationAgeMs: 60000,
      nonce: crypto.randomUUID(),
    });
    assert.equal(staleFreshRes.fresh, false);
    assert.equal(staleFreshRes.reasonCode, 'OBSERVATION_STALE');

    // 23.9: Future timestamp rejected
    const futureFreshRes = verifyObservationFreshness({
      observedAt: new Date(Date.now() + 60000).toISOString(),
      maxObservationAgeMs: 60000,
      nonce: crypto.randomUUID(),
    });
    assert.equal(futureFreshRes.fresh, false);
    assert.equal(futureFreshRes.reasonCode, 'OBSERVATION_FUTURE_DATED');

    // 23.10: Replayed nonce rejected
    const nonceSet = new Set();
    const testNonce = crypto.randomUUID();
    const nonceRes1 = verifyObservationFreshness({
      observedAt: new Date().toISOString(),
      nonce: testNonce,
      activeNonces: nonceSet,
    });
    assert.equal(nonceRes1.fresh, true);
    const nonceRes2 = verifyObservationFreshness({
      observedAt: new Date().toISOString(),
      nonce: testNonce,
      activeNonces: nonceSet,
    });
    assert.equal(nonceRes2.fresh, false);
    assert.equal(nonceRes2.reasonCode, 'REPLAY_DETECTED');

    // 23.11: Missing context binding rejected
    for (const field of OBSERVER_CONTEXT_BINDING_FIELDS) {
      const incompleteObs = { ...validObsContext };
      delete incompleteObs[field];
      const missingFieldRes = validateObservationContext({
        observation: incompleteObs,
        expectedBindings: { projectId: 'proj-1' },
      });
      assert.equal(missingFieldRes.valid, false);
      assert.equal(missingFieldRes.reasonCode, 'MISSING_CONTEXT_BINDING_FIELD');
    }

    // 23.12: Conflicting daemon and host observations rejected in evaluateHostKernelEnforcement
    const conflictRes = evaluateHostKernelEnforcement({
      kernelObservation: {
        evidenceSource: 'host_kernel_telemetry',
        verificationMethod: 'CGROUP_V2_AND_MOUNTINFO_PROBE',
        containerId: 'container-abc-123',
        cgroupPath: '/sys/fs/cgroup/docker/container-abc-123/',
        mountNamespaceId: 'mnt:[4026532456]',
        projectId: 'proj-1',
        executionId: 'exec-1',
        policyDigest: 'policy-digest-1',
        verificationPlanDigest: 'plan-digest-1',
        observationTimestamp: new Date().toISOString(),
        nonce: crypto.randomUUID(),
        verificationState: 'HOST_OBSERVED',
        cgroupObservation: {
          cgroupVersion: 2,
          isCgroupV2: true,
          cgroupPath: '/sys/fs/cgroup/docker/container-abc-123/',
          controllers: ['cpu', 'memory', 'pids'],
          cpuMax: '50000 100000',
          memoryMax: '536870912',
          pidsMax: '64',
        },
        mountObservation: {
          mountNamespaceId: 'mnt:[4026532456]',
          mounts: [{ destination: '/', target: '/', flags: ['ro'], readOnly: true }],
        },
      },
      daemonInspect: {
        HostConfig: {
          Memory: 1073741824,
          ReadonlyRootfs: true,
        },
      },
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(conflictRes.valid, false);
    assert.equal(conflictRes.reasonCode, 'DAEMON_HOST_OBSERVATION_CONFLICT');

    // 23.13: Observer termination / stale heartbeat rejected
    const termRes = authenticateObserver({
      observerDescriptor: {
        ...validObserverDescriptor,
        isAlive: false,
        terminated: true,
      },
      peerCredentials: validPeerCredentials,
      ipcChannel: validIpcChannel,
      isSyntheticTest: true,
    });
    assert.equal(termRes.isAuthenticated, false);
    assert.equal(termRes.reasonCode, 'OBSERVER_PROCESS_TERMINATED');

    const staleHbRes = authenticateObserver({
      observerDescriptor: {
        ...validObserverDescriptor,
        lastHeartbeat: new Date(Date.now() - 30000).toISOString(),
        maxHeartbeatAgeMs: 5000,
      },
      peerCredentials: validPeerCredentials,
      ipcChannel: validIpcChannel,
      isSyntheticTest: true,
    });
    assert.equal(staleHbRes.isAuthenticated, false);
    assert.equal(staleHbRes.reasonCode, 'OBSERVER_HEARTBEAT_STALE');

    // 23.14: Observer descriptor missing / unavailable
    const missingDescRes = authenticateObserver({
      observerDescriptor: null,
      isSyntheticTest: true,
    });
    assert.equal(missingDescRes.isAuthenticated, false);
    assert.equal(missingDescRes.reasonCode, 'OBSERVER_DESCRIPTOR_MISSING');

    // 23.15: Valid synthetic evidence without authenticated identity fails closed in production
    const prodRes = authenticateObserver({
      observerDescriptor: validObserverDescriptor,
      peerCredentials: validPeerCredentials,
      ipcChannel: validIpcChannel,
      isSyntheticTest: false,
    });
    assert.equal(prodRes.isAuthenticated, false);
    assert.equal(prodRes.state, OBSERVER_AUTHENTICATION_STATES.NOT_IMPLEMENTED);
    assert.equal(prodRes.reasonCode, 'INDEPENDENT_OBSERVER_NOT_IMPLEMENTED');

    // 23.16: Insecure IPC channel access control rejected
    const insecureIpcRes = authenticateObserver({
      observerDescriptor: validObserverDescriptor,
      peerCredentials: validPeerCredentials,
      ipcChannel: { channelType: 'unix_domain_socket', restrictedAcl: false },
      isSyntheticTest: true,
    });
    assert.equal(insecureIpcRes.isAuthenticated, false);
    assert.equal(insecureIpcRes.reasonCode, 'INSECURE_IPC_CHANNEL');

    // 23.17: Untrusted observer executable path rejected
    const untrustedPathRes = authenticateObserver({
      observerDescriptor: {
        ...validObserverDescriptor,
        executablePath: 'C:\\Users\\Admin\\AppData\\Local\\Temp\\observer.exe',
      },
      peerCredentials: validPeerCredentials,
      ipcChannel: validIpcChannel,
      isSyntheticTest: true,
    });
    assert.equal(untrustedPathRes.isAuthenticated, false);
    assert.equal(untrustedPathRes.reasonCode, 'UNTRUSTED_OBSERVER_EXECUTABLE_PATH');

    // 23.18: Electron renderer or main process identity domain rejected
    for (const invalidDomain of [OBSERVER_IDENTITY_SOURCES.ELECTRON_RENDERER, OBSERVER_IDENTITY_SOURCES.ELECTRON_MAIN, OBSERVER_IDENTITY_SOURCES.CHILD_PROCESS]) {
      const domainRes = authenticateObserver({
        observerDescriptor: {
          ...validObserverDescriptor,
          identitySource: invalidDomain,
        },
        peerCredentials: validPeerCredentials,
        ipcChannel: validIpcChannel,
        isSyntheticTest: true,
      });
      assert.equal(domainRes.isAuthenticated, false);
      assert.equal(domainRes.state, OBSERVER_AUTHENTICATION_STATES.UNTRUSTED_PROCESS_DOMAIN);
  }
  }

  // -------------------------------------------------------------------------
  // 24. Windows OS-Authenticated Observer IPC — Implementation & Verification (V44.34)
  // -------------------------------------------------------------------------
  console.log('24. Testing Windows OS-Authenticated Observer IPC (V44.34)...');
  {
    const {
      WINDOWS_IPC_SECURITY_STATES,
      OBSERVER_IDENTITY_SOURCES,
      OBSERVER_AUTHENTICATION_STATES,
      validateWindowsNamedPipeSecurity,
      validateWindowsProcessPeerIdentity,
      authenticateObserver,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');

    const validPipePath = '\\\\.\\pipe\\ai-help-agent-observer-1';
    const validSecurityDescriptor = {
      sddl: 'D:(A;;GA;;;SY)(A;;GA;;;BA)',
      restrictedDacl: true,
      nullDacl: false,
      terminalSessionId: 1,
    };

    const validPeerProcess = {
      pid: 8888,
      handleValid: true,
      processExited: false,
      processCreationTimeUtc: '2026-11-01T07:00:00.000Z',
      executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
      tokenUserSid: 'S-1-5-18',
      identitySource: OBSERVER_IDENTITY_SOURCES.INDEPENDENT_AUTHENTICATED_OBSERVER,
    };

    // 24.1: Unauthorized named pipe path (relative or outside \\.\pipe\)
    const invalidPathRes = validateWindowsNamedPipeSecurity({
      pipePath: 'C:\\temp\\observer.sock',
      securityDescriptor: validSecurityDescriptor,
      isSyntheticTest: true,
    });
    assert.equal(invalidPathRes.valid, false);
    assert.equal(invalidPathRes.reasonCode, 'INVALID_PIPE_PATH');

    // 24.2: Insecure pipe security descriptor (NULL DACL / Everyone access) rejected
    const nullDaclRes = validateWindowsNamedPipeSecurity({
      pipePath: validPipePath,
      securityDescriptor: { nullDacl: true, dacl: null },
      isSyntheticTest: true,
    });
    assert.equal(nullDaclRes.valid, false);
    assert.equal(nullDaclRes.reasonCode, 'NULL_DACL_REJECTED');

    const everyoneDaclRes = validateWindowsNamedPipeSecurity({
      pipePath: validPipePath,
      securityDescriptor: { sddl: 'D:(A;;GA;;;WD)', restrictedDacl: false },
      isSyntheticTest: true,
    });
    assert.equal(everyoneDaclRes.valid, false);
    assert.equal(everyoneDaclRes.reasonCode, 'EVERYONE_ACCESS_REJECTED');

    // 24.3: Invalid client PID (PID <= 4 or non-integer) rejected
    for (const badPid of [0, 4, -1, 3.14, 'not-a-pid']) {
      const badPidRes = validateWindowsProcessPeerIdentity({
        peerProcessDescriptor: { ...validPeerProcess, pid: badPid },
        isSyntheticTest: true,
      });
      assert.equal(badPidRes.valid, false);
      assert.equal(badPidRes.reasonCode, 'INVALID_CLIENT_PID');
    }

    // 24.4: PID reuse / creation timestamp mismatch rejected
    const pidReuseRes = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: {
        ...validPeerProcess,
        processCreationTimeUtc: '2026-11-01T07:15:00.000Z',
      },
      expectedContext: {
        processCreationTimeUtc: '2026-11-01T07:00:00.000Z',
      },
      isSyntheticTest: true,
    });
    assert.equal(pidReuseRes.valid, false);
    assert.equal(pidReuseRes.state, WINDOWS_IPC_SECURITY_STATES.PID_REUSE_DETECTED);
    assert.equal(pidReuseRes.reasonCode, 'PID_REUSE_DETECTED');

    // 24.5: Invalid or closed process handle rejected
    const closedHandleRes = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: {
        ...validPeerProcess,
        handleValid: false,
      },
      isSyntheticTest: true,
    });
    assert.equal(closedHandleRes.valid, false);
    assert.equal(closedHandleRes.reasonCode, 'INVALID_PROCESS_HANDLE');

    // 24.6: Untrusted executable identity path rejected
    const badExecRes = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: {
        ...validPeerProcess,
        executablePath: 'C:\\Users\\Admin\\AppData\\Local\\Temp\\attacker.exe',
      },
      isSyntheticTest: true,
    });
    assert.equal(badExecRes.valid, false);
    assert.equal(badExecRes.reasonCode, 'UNTRUSTED_OBSERVER_EXECUTABLE_PATH');

    // 24.7: Wrong OS security principal (unauthorized user SID instead of SYSTEM or service) rejected
    const wrongSidRes = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: {
        ...validPeerProcess,
        tokenUserSid: 'S-1-5-21-123456789-123456789-1001',
      },
      expectedPrincipalSid: 'S-1-5-18',
      isSyntheticTest: true,
    });
    assert.equal(wrongSidRes.valid, false);
    assert.equal(wrongSidRes.state, WINDOWS_IPC_SECURITY_STATES.SECURITY_PRINCIPAL_MISMATCH);
    assert.equal(wrongSidRes.reasonCode, 'SECURITY_PRINCIPAL_MISMATCH');

    // 24.8: Cross-session connection rejected (Terminal Services session ID mismatch)
    const crossSessionPipeRes = validateWindowsNamedPipeSecurity({
      pipePath: validPipePath,
      securityDescriptor: { ...validSecurityDescriptor, terminalSessionId: 0 },
      clientContext: { terminalSessionId: 1 },
      isSyntheticTest: true,
    });
    assert.equal(crossSessionPipeRes.valid, false);
    assert.equal(crossSessionPipeRes.state, WINDOWS_IPC_SECURITY_STATES.CROSS_SESSION_REJECTED);
    assert.equal(crossSessionPipeRes.reasonCode, 'CROSS_SESSION_ACCESS_REJECTED');

    // 24.9: Stale observer process rejected in authenticateObserver
    const staleProcRes = authenticateObserver({
      observerDescriptor: {
        observerId: 'obs-win-1',
        identitySource: OBSERVER_IDENTITY_SOURCES.INDEPENDENT_AUTHENTICATED_OBSERVER,
        executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
        pid: 8888,
        lastHeartbeat: new Date(Date.now() - 45000).toISOString(),
        maxHeartbeatAgeMs: 10000,
      },
      peerCredentials: { authenticated: true, peerPid: 8888 },
      isSyntheticTest: true,
    });
    assert.equal(staleProcRes.isAuthenticated, false);
    assert.equal(staleProcRes.reasonCode, 'OBSERVER_HEARTBEAT_STALE');

    // 24.10: Observer process termination detected
    const terminatedProcRes = authenticateObserver({
      observerDescriptor: {
        observerId: 'obs-win-1',
        identitySource: OBSERVER_IDENTITY_SOURCES.INDEPENDENT_AUTHENTICATED_OBSERVER,
        executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
        pid: 8888,
        isAlive: false,
        terminated: true,
      },
      peerCredentials: { authenticated: true, peerPid: 8888 },
      isSyntheticTest: true,
    });
    assert.equal(terminatedProcRes.isAuthenticated, false);
    assert.equal(terminatedProcRes.reasonCode, 'OBSERVER_PROCESS_TERMINATED');

    // 24.11: Caller-forged authentication result rejected
    for (const forgedFlag of ['windowsPipeVerified', 'osProcessIdentityVerified', 'ipcClientAuthenticated']) {
      const forgedRes = authenticateObserver({
        observerDescriptor: {
          observerId: 'obs-win-1',
          identitySource: OBSERVER_IDENTITY_SOURCES.INDEPENDENT_AUTHENTICATED_OBSERVER,
          executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
          pid: 8888,
          [forgedFlag]: true,
        },
        peerCredentials: { authenticated: true, peerPid: 8888 },
        isSyntheticTest: true,
      });
      assert.equal(forgedRes.isAuthenticated, false);
      assert.equal(forgedRes.state, OBSERVER_AUTHENTICATION_STATES.CALLER_FORGED);
      assert.equal(forgedRes.reasonCode, 'CALLER_FORGED_OBSERVER_IDENTITY');
    }

    // 24.12: Renderer pretending to be observer rejected
    const rendererProcRes = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: {
        ...validPeerProcess,
        identitySource: OBSERVER_IDENTITY_SOURCES.ELECTRON_RENDERER,
      },
      isSyntheticTest: true,
    });
    assert.equal(rendererProcRes.valid, false);
    assert.equal(rendererProcRes.reasonCode, 'UNTRUSTED_PROCESS_DOMAIN');

    // 24.13: Ordinary child process pretending to be independent observer rejected
    const childProcWinRes = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: {
        ...validPeerProcess,
        identitySource: OBSERVER_IDENTITY_SOURCES.CHILD_PROCESS,
      },
      isSyntheticTest: true,
    });
    assert.equal(childProcWinRes.valid, false);
    assert.equal(childProcWinRes.reasonCode, 'UNTRUSTED_PROCESS_DOMAIN');

    // 24.14: Pure Node.js production IPC peer authentication fails closed as NOT_IMPLEMENTED
    const prodPipeRes = validateWindowsNamedPipeSecurity({
      pipePath: validPipePath,
      securityDescriptor: validSecurityDescriptor,
      isSyntheticTest: false,
    });
    assert.equal(prodPipeRes.valid, false);
    assert.equal(prodPipeRes.state, WINDOWS_IPC_SECURITY_STATES.NOT_IMPLEMENTED);
    assert.equal(prodPipeRes.reasonCode, 'WINDOWS_NATIVE_IPC_AUTH_NOT_IMPLEMENTED');

    const prodPeerRes = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: validPeerProcess,
      isSyntheticTest: false,
    });
    assert.equal(prodPeerRes.valid, false);
    assert.equal(prodPeerRes.state, WINDOWS_IPC_SECURITY_STATES.NOT_VERIFIED);
    assert.equal(prodPeerRes.reasonCode, 'OS_PROCESS_IDENTITY_NOT_VERIFIED');

    // 24.15: Valid synthetic IPC descriptor without real OS authentication fails closed in production
    const prodAuthRes = authenticateObserver({
      observerDescriptor: {
        observerId: 'obs-win-1',
        identitySource: OBSERVER_IDENTITY_SOURCES.INDEPENDENT_AUTHENTICATED_OBSERVER,
        executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
        pid: 8888,
        windowsNamedPipe: {
          pipePath: validPipePath,
          securityDescriptor: validSecurityDescriptor,
        },
        windowsProcessPeer: validPeerProcess,
      },
      peerCredentials: { authenticated: true, peerPid: 8888 },
      isSyntheticTest: false,
    });
    assert.equal(prodAuthRes.isAuthenticated, false);
    assert.equal(prodAuthRes.state, OBSERVER_AUTHENTICATION_STATES.NOT_IMPLEMENTED);
    assert.equal(prodAuthRes.reasonCode, 'WINDOWS_NATIVE_IPC_AUTH_NOT_IMPLEMENTED');
  }

  // -------------------------------------------------------------------------
  // 25. [V44.61] Testing Windows Sandbox Native Supervisor Contract & Execution Blocker Isolation Invariants
  // -------------------------------------------------------------------------
  console.log('25. Testing Windows Sandbox Native Supervisor Contract & Execution Blocker Isolation Invariants...');
  {
    const {
      executeWithSupervisor,
      createWindowsSandboxProviderAdapter,
    } = require('../electron/coding-pipeline/windowsSandboxProviderAdapter.cjs');
    const {
      assertTrustedSupervisorInterface,
      assertAuthenticatedSupervisor,
      authenticateSupervisor,
    } = require('../electron/coding-pipeline/providerAdapterContract.cjs');

    const makeMockSupervisor = (overrides = {}) => ({
      observerDescriptor: {
        identitySource: 'independent_authenticated_observer',
        pid: 999998,
        parentPid: 1,
        executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
        windowsNamedPipe: {
          pipePath: '\\\\.\\pipe\\ai-help-agent-supervisor-contract-test',
          securityDescriptor: {
            sddl: 'D:(A;;GA;;;SY)(A;;GA;;;BA)',
            restrictedDacl: true,
            nullDacl: false,
          },
        },
        windowsProcessPeer: {
          pid: 999998,
          handleValid: true,
          processExited: false,
          processCreationTimeUtc: '2026-11-01T07:00:00.000Z',
          executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
          tokenUserSid: 'S-1-5-18',
          identitySource: 'independent_authenticated_observer',
        },
        ...overrides.descriptor,
      },
      issueExecutionGrant: async (req) => ({ granted: true, runId: req.runId, workspaceRoot: req.workspaceRoot, approvedSnapshotDigest: req.approvedSnapshotDigest, ...overrides.grant }),
      consumeExecutionGrant: async (grant) => ({ consumed: true, grantId: 'grant-1', ...overrides.consume }),
      allocateWorker: async (req) => ({ workerId: 'worker-wsb-1', pid: 1234, ...overrides.worker }),
      observeWorkerReadiness: async () => ({ ready: true }),
      observeEffectiveIsolation: async () => ({ effectiveIsolationVerified: true, ...overrides.isolation }),
      executeApprovedOperation: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false, ...overrides.exec }),
      enforceDeadlineAndCancellation: async () => new Promise(() => {}),
      collectHostEvidence: async () => ({ evidenceCollected: true, source: 'native-supervisor' }),
      terminateWorker: async () => ({ terminated: true, exitCode: 0, ...overrides.termination }),
      verifyWorkerTerminationAndResourceRelease: async () => ({ released: true, ...overrides.release }),
      persistLifecycleState: async () => ({ persisted: true }),
      quarantineResource: async () => ({ quarantined: true }),
      resolveQuarantine: async () => ({ resolved: true }),
      ...overrides.methods,
    });

    // 25.1: Non-object or incomplete supervisor rejected by interface assertion
    assert.throws(() => assertTrustedSupervisorInterface(null), /must be an object/);
    assert.throws(() => assertTrustedSupervisorInterface({}), /missing required operation/);
    assert.throws(() => createWindowsSandboxProviderAdapter({ supervisor: {}, isSyntheticTest: true }), /missing required operation/);

    const validSup = makeMockSupervisor();
    const adapterWithSup = createWindowsSandboxProviderAdapter({ supervisor: validSup, isSyntheticTest: true });
    assert.equal(typeof adapterWithSup.executeWithSupervisor, 'function');

    // Missing supervisor on adapter fails-closed
    const adapterWithoutSup = createWindowsSandboxProviderAdapter();
    assert.throws(
      () => adapterWithoutSup.executeWithSupervisor({}),
      /No trusted supervisor configured/,
    );

    // 25.2: Missing mandatory run request parameters rejected
    const baseReq = {
      runId: 'run-v44-61-1',
      workspaceRoot: process.cwd(),
      approvedSnapshotDigest: 'sha256-snap-abc',
      planDigest: 'sha256-plan-123',
      taskId: 'task-101',
      sessionId: 'session-202',
      command: { binary: 'npm.cmd', args: ['test'] },
      isSyntheticTest: true,
    };

    await assert.rejects(() => executeWithSupervisor({ ...baseReq, runId: '', supervisor: validSup }), /runId is required/);
    await assert.rejects(() => executeWithSupervisor({ ...baseReq, workspaceRoot: null, supervisor: validSup }), /workspaceRoot is required/);
    await assert.rejects(() => executeWithSupervisor({ ...baseReq, approvedSnapshotDigest: '', supervisor: validSup }), /approvedSnapshotDigest is required/);
    await assert.rejects(() => executeWithSupervisor({ ...baseReq, command: null, supervisor: validSup }), /command is required/);

    // 25.3: Approval rejection by supervisor halts fail-closed
    const rejectingSup = makeMockSupervisor({ grant: { granted: false, rejected: true, reason: 'Security policy denied execution' } });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: rejectingSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && err.executionBlocked === true && /grant rejected/i.test(err.message),
    );

    // 25.4: Workspace identity and snapshot digest mismatches rejected
    const mismatchedSnapSup = makeMockSupervisor({ grant: { approvedSnapshotDigest: 'sha256-tampered-snap' } });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: mismatchedSnapSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && /snapshot digest/i.test(err.message),
    );

    const mismatchedRootSup = makeMockSupervisor({ grant: { workspaceRoot: 'C:\\rogue\\path' } });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: mismatchedRootSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && /workspaceRoot/i.test(err.message),
    );

    const mismatchedPlanSup = makeMockSupervisor({ grant: { planDigest: 'sha256-forged-plan' } });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: mismatchedPlanSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && /planDigest mismatch/i.test(err.message),
    );

    const mismatchedTaskSup = makeMockSupervisor({ grant: { taskId: 'task-rogue-999' } });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: mismatchedTaskSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && /taskId mismatch/i.test(err.message),
    );

    const mismatchedSessionSup = makeMockSupervisor({ grant: { sessionId: 'session-attacker' } });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: mismatchedSessionSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && /sessionId mismatch/i.test(err.message),
    );

    // 25.5: Single-use grant consumption failure (replay attack defense)
    const replayedGrantSup = makeMockSupervisor({ consume: { consumed: false } });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: replayedGrantSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && /single-use execution grant/i.test(err.message),
    );

    // 25.6: Effective isolation observation failure halts and terminates worker
    let unverifiedTerminated = false;
    let unverifiedReleaseChecked = false;
    const unverifiedIsolationSup = makeMockSupervisor({
      isolation: { effectiveIsolationVerified: false, reason: 'Egress firewall rule not active' },
      methods: {
        terminateWorker: async () => { unverifiedTerminated = true; return { terminated: true }; },
        verifyWorkerTerminationAndResourceRelease: async () => { unverifiedReleaseChecked = true; return { released: true }; },
      },
    });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: unverifiedIsolationSup }),
      (err) => err.code === 'PROJECT_EXECUTION_BLOCKED' && /Effective OS isolation verification failed/i.test(err.message),
    );
    assert.equal(unverifiedTerminated, true, 'Worker must be terminated when effective isolation is unverified');
    assert.equal(unverifiedReleaseChecked, true, 'Resource release must be verified when effective isolation fails');

    // 25.7: Worker termination failure quarantined and propagated
    let quarantinedOnTermFail = false;
    const termFailSup = makeMockSupervisor({
      methods: {
        terminateWorker: async () => { throw new Error('Failed to terminate child processes in sandbox VM'); },
        quarantineResource: async () => { quarantinedOnTermFail = true; return { quarantined: true }; },
      },
    });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: termFailSup }),
      (err) => err.code === 'WORKER_TERMINATION_FAILED' && err.isolationFailure === true,
    );
    assert.equal(quarantinedOnTermFail, true, 'Resource must be quarantined when worker termination fails');

    // 25.8: Cleanup / resource release failure quarantined and propagated
    let quarantinedOnReleaseFail = false;
    const releaseFailSup = makeMockSupervisor({
      release: { released: false, reason: 'File handles still held by container client' },
      methods: { quarantineResource: async () => { quarantinedOnReleaseFail = true; return { quarantined: true }; } },
    });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: releaseFailSup }),
      (err) => err.code === 'RESOURCE_RELEASE_FAILED' && err.isolationFailure === true,
    );
    assert.equal(quarantinedOnReleaseFail, true, 'Resource must be quarantined when resource release fails');

    // 25.9: Execution error does not trigger host fallback and cleans up worker
    let cleanupOnExecErr = false;
    const execErrSup = makeMockSupervisor({
      methods: {
        executeApprovedOperation: async () => { throw new Error('Command failed inside guest'); },
        terminateWorker: async () => { cleanupOnExecErr = true; return { terminated: true }; },
      },
    });
    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: execErrSup }),
      (err) => err.message === 'Command failed inside guest' && Boolean(err.hostEvidence) && Boolean(err.terminationResult) && Boolean(err.releaseVerification),
    );
    assert.equal(cleanupOnExecErr, true, 'Worker must be terminated when guest execution errors');

    // 25.10: Cancellation propagation
    const cancelSup = makeMockSupervisor({
      methods: {
        executeApprovedOperation: async () => new Promise(() => {}),
        enforceDeadlineAndCancellation: async () => ({ exitCode: 130, stdout: '', stderr: 'Cancelled by user', timedOut: false, cancelled: true }),
      },
    });
    const cancelRes = await executeWithSupervisor({ ...baseReq, supervisor: cancelSup, isCancelled: () => true });
    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.ok, false);

    // 25.11: Post-validation supervisor method tampering immunity
    let tamperedMethodCalled = false;
    const tamperSup = makeMockSupervisor();
    const originalIssue = tamperSup.issueExecutionGrant;
    tamperSup.issueExecutionGrant = async (req) => {
      tamperSup.observeEffectiveIsolation = async () => {
        tamperedMethodCalled = true;
        return { effectiveIsolationVerified: true };
      };
      return originalIssue(req);
    };
    await executeWithSupervisor({ ...baseReq, supervisor: tamperSup });
    assert.equal(tamperedMethodCalled, false, 'Tampered supervisor method must never be invoked after validation');

    // 25.12: Command authorization registration rejects forged or arbitrary tokens
    const { registerProjectCommandAuthorization } = require('../electron/coding-pipeline/windowsSandboxRunner.cjs');
    const {
      mintProjectCommandAuthorization,
      cancelCommandAuthorization,
    } = require('../electron/coding-pipeline/projectCommandAuthorization.cjs');
    const developerFiles = require('../electron/developerFiles.cjs');

    assert.equal(registerProjectCommandAuthorization(null), false, 'Null token must be rejected');
    assert.equal(registerProjectCommandAuthorization({}), false, 'Arbitrary empty object must be rejected');
    assert.equal(registerProjectCommandAuthorization({ fake: true, authId: 'forged' }), false, 'Forged object must be rejected');

    const authOwnerId = 4462;
    await developerFiles.attachProject(process.cwd(), authOwnerId);

    const legitToken = await mintProjectCommandAuthorization({
      projectRoot: process.cwd(),
      ownerWebContentsId: authOwnerId,
      sessionId: 'session-202',
      planDigest: 'sha256-plan-123',
      command: 'npm test',
      providerId: 'windows-sandbox',
    });
    assert.equal(registerProjectCommandAuthorization(legitToken), true, 'Legitimate minted token must be accepted');

    cancelCommandAuthorization(legitToken);
    assert.equal(registerProjectCommandAuthorization(legitToken), false, 'Cancelled token must be rejected');

    // 25.13: Guest-generated evidence alone cannot authorize execution
    const hostObservedResult = adapterWithSup.collectHostObservedResult({
      guestOutputs: ['Everything passed perfectly in guest'],
      guestCleanupReports: [{ complete: true }],
      guestFiles: ['guest-result.json'],
    });
    assert.equal(hostObservedResult.classification, 'BLOCKED', 'Guest-generated evidence alone must be BLOCKED');

    // 25.14: Supervisor Identity Authentication Invariants (V44.63)
    // 25.14a: Supervisor missing OS identity descriptor rejected
    const noDescSup = makeMockSupervisor();
    delete noDescSup.observerDescriptor;
    assert.throws(
      () => createWindowsSandboxProviderAdapter({ supervisor: noDescSup, isSyntheticTest: true }),
      (err) => err.code === 'SUPERVISOR_AUTHENTICATION_FAILED' && err.authReasonCode === 'DESCRIPTOR_MISSING',
    );

    // 25.14b: Caller-supplied authentication flags rejected as forged
    const forgedSup = makeMockSupervisor();
    forgedSup.authenticated = true;
    assert.throws(
      () => createWindowsSandboxProviderAdapter({ supervisor: forgedSup, isSyntheticTest: true }),
      (err) => err.code === 'SUPERVISOR_AUTHENTICATION_FAILED' && err.authReasonCode === 'CALLER_FORGED_SUPERVISOR_IDENTITY',
    );

    // 25.14c: In-process supervisor rejected (must reside in independent process domain)
    const inProcSup = makeMockSupervisor({
      descriptor: {
        pid: process.pid,
        windowsProcessPeer: {
          pid: process.pid,
          handleValid: true,
          processExited: false,
          processCreationTimeUtc: '2026-11-01T07:00:00.000Z',
          executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\observer.exe',
          tokenUserSid: 'S-1-5-18',
        },
      },
    });
    assert.throws(
      () => createWindowsSandboxProviderAdapter({ supervisor: inProcSup, isSyntheticTest: true }),
      (err) => err.code === 'SUPERVISOR_AUTHENTICATION_FAILED' && err.authReasonCode === 'IN_PROCESS_OBSERVER_REJECTED',
    );

    // 25.14d: Insecure named pipe (NULL DACL) rejected
    const nullDaclSup = makeMockSupervisor({
      descriptor: {
        windowsNamedPipe: {
          pipePath: '\\\\.\\pipe\\test-pipe',
          securityDescriptor: { nullDacl: true, dacl: null },
        },
      },
    });
    assert.throws(
      () => createWindowsSandboxProviderAdapter({ supervisor: nullDaclSup, isSyntheticTest: true }),
      (err) => err.code === 'SUPERVISOR_AUTHENTICATION_FAILED' && err.authReasonCode === 'NULL_DACL_REJECTED',
    );

    // 25.14e: Production gate enforcement: without verified OS supervisor daemon, authentication fails closed
    assert.throws(
      () => createWindowsSandboxProviderAdapter({ supervisor: validSup, isSyntheticTest: false }),
      (err) => Boolean(err.code === 'SUPERVISOR_AUTHENTICATION_FAILED' && (err.authReasonCode === 'INDEPENDENT_OBSERVER_NOT_IMPLEMENTED' || err.authReasonCode === 'IPC_PEER_UNAUTHENTICATED')),
    );

    await assert.rejects(
      () => executeWithSupervisor({ ...baseReq, supervisor: validSup, isSyntheticTest: false }),
      (err) => Boolean(err.code === 'PROJECT_EXECUTION_BLOCKED' && (err.authReasonCode === 'INDEPENDENT_OBSERVER_NOT_IMPLEMENTED' || err.authReasonCode === 'IPC_PEER_UNAUTHENTICATED')),
    );

    // 25.15: Successful supervised execution with host-observed cleanup under synthetic test contract
    const successRes = await executeWithSupervisor({ ...baseReq, supervisor: validSup });
    assert.equal(successRes.ok, true);
    assert.equal(successRes.exitCode, 0);
    assert.equal(successRes.stdout, 'ok');
    assert.equal(successRes.hostEvidence.source, 'native-supervisor');
    assert.equal(successRes.releaseVerification.released, true);
  }

  // -------------------------------------------------------------------------
  // 26. [V44.66] Native Supervisor Security Hardening & Real Isolation Verification
  // -------------------------------------------------------------------------
  console.log('26. Testing Native Supervisor Security Hardening & Real Isolation Verification (V44.66)...');
  {
    const { spawn, spawnSync } = require('node:child_process');
    const {
      NATIVE_SUPERVISOR_EXECUTABLE,
      createNativeSupervisorClient,
      createWindowsSandboxProviderAdapter,
      executeWithSupervisor,
      queryNativeSupervisorStatus,
      sendNativeSupervisorRequest,
    } = require('../electron/coding-pipeline/windowsSandboxProviderAdapter.cjs');

    // =========================================================================
    // 26.A: SYNTHETIC_TEST - In-process mock & offline CI harness contract
    // =========================================================================
    console.log('  26.A: Testing SYNTHETIC_TEST contract...');
    {
      const mockSup = {
        observerDescriptor: {
          identitySource: 'independent_authenticated_observer',
          pid: 999990,
          parentPid: 1,
          executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\mock-supervisor.exe',
          windowsNamedPipe: {
            pipePath: '\\\\.\\pipe\\ai-help-agent-supervisor-synthetic-test',
            securityDescriptor: {
              sddl: 'D:(A;;GA;;;SY)(A;;GA;;;BA)',
              restrictedDacl: true,
              nullDacl: false,
            },
          },
          windowsProcessPeer: {
            pid: 999990,
            handleValid: true,
            processExited: false,
            processCreationTimeUtc: '2026-11-01T07:00:00.000Z',
            executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\mock-supervisor.exe',
            tokenUserSid: 'S-1-5-18',
            identitySource: 'independent_authenticated_observer',
          },
        },
        issueExecutionGrant: async (req) => ({
          granted: true,
          runId: req.runId,
          workspaceRoot: req.workspaceRoot,
          approvedSnapshotDigest: req.approvedSnapshotDigest,
          grantId: 'mock-grant-1',
        }),
        consumeExecutionGrant: async () => ({ consumed: true, grantId: 'mock-grant-1' }),
        allocateWorker: async () => ({ workerId: 'mock-worker-1', pid: 5678 }),
        observeWorkerReadiness: async () => ({ ready: true }),
        observeEffectiveIsolation: async () => ({ effectiveIsolationVerified: true }),
        executeApprovedOperation: async () => ({ exitCode: 0, stdout: 'mock synthetic execution', stderr: '' }),
        enforceDeadlineAndCancellation: async ({ timeoutMs }) => new Promise((_, reject) => {
          if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            setTimeout(() => {
              const err = new Error('Execution deadline exceeded.');
              err.timedOut = true;
              reject(err);
            }, timeoutMs);
          }
        }),
        collectHostEvidence: async () => ({ evidenceCollected: true, source: 'native-supervisor' }),
        terminateWorker: async () => ({ terminated: true, exitCode: 0 }),
        verifyWorkerTerminationAndResourceRelease: async () => ({ released: true }),
        persistLifecycleState: async () => ({ persisted: true }),
        quarantineResource: async () => ({ quarantined: true }),
        resolveQuarantine: async () => ({ resolved: true }),
      };

      // 26.A.1: Synthetic adapter creation
      const syntheticAdapter = createWindowsSandboxProviderAdapter({
        supervisor: mockSup,
        isSyntheticTest: true,
      });
      assert.ok(syntheticAdapter, 'Synthetic provider adapter must initialize successfully.');

      // 26.A.2: Supervised execution under synthetic test boundary
      const syntheticRun = await executeWithSupervisor({
        runId: 'synthetic-run-1',
        workspaceRoot: 'C:\\test\\workspace',
        approvedSnapshotDigest: 'a'.repeat(64),
        planDigest: 'b'.repeat(64),
        taskId: 'synthetic-task-1',
        sessionId: 'synthetic-session-1',
        command: { executable: 'cmd.exe', args: ['/c', 'echo', 'synthetic'] },
        supervisor: mockSup,
        isSyntheticTest: true,
      });
      assert.equal(syntheticRun.ok, true);
      assert.equal(syntheticRun.stdout, 'mock synthetic execution');

      // 26.A.3: Deadline expiration enforcement
      const slowSup = {
        ...mockSup,
        executeApprovedOperation: async () => new Promise((resolve) => setTimeout(resolve, 500)),
      };
      await assert.rejects(
        () => executeWithSupervisor({
          runId: 'synthetic-timeout-run',
          workspaceRoot: 'C:\\test\\workspace',
          approvedSnapshotDigest: 'a'.repeat(64),
          planDigest: 'b'.repeat(64),
          taskId: 'synthetic-task-timeout',
          sessionId: 'synthetic-session-timeout',
          command: { executable: 'cmd.exe', args: ['/c', 'pause'] },
          supervisor: slowSup,
          timeoutMs: 20,
          isSyntheticTest: true,
        }),
        (err) => err.timedOut === true,
      );
    }

    // =========================================================================
    // 26.B: LOCAL_NATIVE_IPC_TEST - Live compiled native binary, pipe IPC, Job Object containment
    // =========================================================================
    console.log('  26.B: Testing LOCAL_NATIVE_IPC_TEST contract...');
    {
      // 26.B.1: Native supervisor executable verification on disk
      const initialStatus = await queryNativeSupervisorStatus();
      assert.equal(initialStatus.binaryPresent, true, 'Native supervisor executable must exist on disk.');
      assert.equal(typeof initialStatus.executablePath, 'string');
      assert.equal(initialStatus.running, false);
      assert.equal(initialStatus.status, 'IMPLEMENTED_NOT_INSTALLED');
      assert.equal(initialStatus.reasonCode, 'SERVICE_PIPE_NOT_FOUND');

      // 26.B.2: Spawn native supervisor in interactive/console mode
      const supervisorProcess = spawn(NATIVE_SUPERVISOR_EXECUTABLE, ['--console'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        let activeStatus = null;
        for (let attempt = 0; attempt < 25; attempt++) {
          activeStatus = await queryNativeSupervisorStatus();
          if (activeStatus.running) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        assert.equal(activeStatus.running, true, 'Native supervisor must be running and listening on pipe.');
        assert.equal(activeStatus.isAlive, true);
        assert.ok(activeStatus.pid > 0, 'Supervisor must report a valid OS process PID.');
        assert.equal(activeStatus.runningMode, 'INTERACTIVE_CONSOLE_DIAGNOSTIC');

        const nativeClient = createNativeSupervisorClient({
          pid: activeStatus.pid,
          tokenUserSid: activeStatus.tokenUserSid,
          isSyntheticTest: true,
        });

        // 26.B.3: PING / PONG verification
        const pingResp = await sendNativeSupervisorRequest({ operation: 'PING' });
        assert.equal(pingResp.ok, true);
        assert.equal(pingResp.status, 'PONG');
        assert.ok(pingResp.pid > 0);

        // 26.B.4: Grant Issuance & Replay Rejection
        const grant = await nativeClient.issueExecutionGrant({
          runId: 'v44-66-grant-run',
          workspaceRoot: 'C:\\test\\workspace',
          approvedSnapshotDigest: 'a'.repeat(64),
          planDigest: 'b'.repeat(64),
          taskId: 'v44-66-task-1',
          sessionId: 'v44-66-session-1',
        });
        assert.equal(grant.granted, true);
        assert.ok(grant.grantId);

        const firstConsume = await nativeClient.consumeExecutionGrant(grant);
        assert.equal(firstConsume.ok, true);
        assert.equal(firstConsume.consumed, true);

        const replayConsume = await nativeClient.consumeExecutionGrant(grant);
        assert.equal(replayConsume.consumed, false, 'Replaying a consumed grant must be strictly rejected.');
        assert.equal(replayConsume.reasonCode, 'GRANT_ALREADY_CONSUMED');

        // 26.B.5: Unknown Grant Rejection
        const unknownConsume = await nativeClient.consumeExecutionGrant({ grantId: 'grant-unissued-bogus-999' });
        assert.equal(unknownConsume.consumed, false);
        assert.equal(unknownConsume.reasonCode, 'UNKNOWN_EXECUTION_GRANT');

        // 26.B.6: Grant Parameter Tampering Rejection
        const tamperGrant = await nativeClient.issueExecutionGrant({
          runId: 'v44-66-tamper-run',
          workspaceRoot: 'C:\\test\\workspace',
          approvedSnapshotDigest: 'c'.repeat(64),
          planDigest: 'd'.repeat(64),
          taskId: 'v44-66-task-tamper',
          sessionId: 'v44-66-session-tamper',
        });
        assert.equal(tamperGrant.granted, true);

        // Tampered runId
        const badRunConsume = await nativeClient.consumeExecutionGrant({
          ...tamperGrant,
          runId: 'v44-66-forged-runId',
        });
        assert.equal(badRunConsume.consumed, false);
        assert.equal(badRunConsume.reasonCode, 'RUN_ID_MISMATCH');

        // Tampered workspaceRoot
        const badWsConsume = await nativeClient.consumeExecutionGrant({
          ...tamperGrant,
          workspaceRoot: 'C:\\rogue\\workspace',
        });
        assert.equal(badWsConsume.consumed, false);
        assert.equal(badWsConsume.reasonCode, 'WORKSPACE_ROOT_MISMATCH');

        // Tampered snapshot digest
        const badSnapConsume = await nativeClient.consumeExecutionGrant({
          ...tamperGrant,
          approvedSnapshotDigest: '0'.repeat(64),
        });
        assert.equal(badSnapConsume.consumed, false);
        assert.equal(badSnapConsume.reasonCode, 'SNAPSHOT_DIGEST_MISMATCH');

        // 26.B.7: Expired Grant Rejection (TTL expiration)
        const expGrant = await nativeClient.issueExecutionGrant({
          runId: 'v44-66-expired-run',
          workspaceRoot: 'C:\\test\\workspace',
          approvedSnapshotDigest: 'e'.repeat(64),
          planDigest: 'f'.repeat(64),
          taskId: 'v44-66-task-exp',
          sessionId: 'v44-66-session-exp',
          ttlSeconds: 1,
        });
        assert.equal(expGrant.granted, true);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const expConsume = await nativeClient.consumeExecutionGrant(expGrant);
        assert.equal(expConsume.consumed, false);
        assert.equal(expConsume.reasonCode, 'GRANT_EXPIRED');

        // 26.B.8: Worker Allocation & Job Object Containment
        const workerAlloc = await sendNativeSupervisorRequest({
          operation: 'ALLOCATE_WORKER',
          runId: 'v44-66-worker-run',
          workspaceRoot: 'C:\\test\\workspace',
        });
        assert.equal(workerAlloc.allocated, true);
        assert.ok(workerAlloc.workerId);
        assert.equal(workerAlloc.containment, 'Windows_Job_Object');

        // 26.B.9: Supervised Execution with Job Object Containment & Resource Release
        const runRequest = {
          runId: 'v44-66-run-native-job',
          workspaceRoot: 'C:\\test\\workspace',
          approvedSnapshotDigest: 'f'.repeat(64),
          planDigest: 'e'.repeat(64),
          taskId: 'v44-66-task-2',
          sessionId: 'v44-66-session-2',
          command: { executable: 'cmd.exe', args: ['/c', 'echo', 'supervised-containment'] },
          supervisor: nativeClient,
          isSyntheticTest: true,
        };

        const execResult = await executeWithSupervisor(runRequest);
        assert.equal(execResult.ok, true);
        assert.equal(execResult.exitCode, 0);
        assert.ok(execResult.stdout.includes('Execution verified under native supervisor containment'));
        assert.equal(execResult.hostEvidence.source, 'native-supervisor');
        assert.equal(execResult.releaseVerification.released, true);
        assert.equal(execResult.releaseVerification.activeProcessesRemaining, 0);
        assert.equal(execResult.releaseVerification.jobClosed, true);

        // 26.B.10: Uncontained Worker Execution Rejection
        const uncontainedExec = await sendNativeSupervisorRequest({
          operation: 'EXECUTE_APPROVED_OPERATION',
          workerId: 'worker-uncontained-bogus',
          command: { executable: 'cmd.exe', args: ['/c', 'echo', 'uncontained'] },
        });
        assert.equal(uncontainedExec.ok, false);
        assert.equal(uncontainedExec.error, 'WORKER_NOT_CONTAINED');

        // 26.B.11: Authenticated clean shutdown via IPC
        const shutdownResp = await sendNativeSupervisorRequest({ operation: 'SHUTDOWN' });
        assert.equal(shutdownResp.ok, true);
        assert.equal(shutdownResp.status, 'STOPPING');
      } finally {
        try {
          supervisorProcess.kill();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // 26.B.12: Verify post-shutdown fail-closed state
      const postStatus = await queryNativeSupervisorStatus();
      assert.equal(postStatus.running, false);
      assert.equal(postStatus.status, 'IMPLEMENTED_NOT_INSTALLED');
      assert.equal(postStatus.reasonCode, 'SERVICE_PIPE_NOT_FOUND');
    }

    // =========================================================================
    // 26.C: REAL_WINDOWS_SERVICE_TEST - Windows Service SCM check & install-info
    // =========================================================================
    console.log('  26.C: Testing REAL_WINDOWS_SERVICE_TEST contract...');
    {
      // 26.C.1: SCM query reports service is not installed in un-elevated environment
      const scmStatus = await queryNativeSupervisorStatus();
      assert.equal(scmStatus.serviceInstalled, false, 'Service must not be registered in SCM without elevation.');
      assert.equal(scmStatus.serviceState, 'NOT_INSTALLED');

      // 26.C.2: Console execution is strictly NEVER reported as installed Windows Service
      assert.notEqual(scmStatus.runningMode, 'WINDOWS_SERVICE');

      // 26.C.3: Test --install-info CLI switch output
      const installInfoRes = spawnSync(NATIVE_SUPERVISOR_EXECUTABLE, ['--install-info'], {
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8',
      });
      assert.equal(installInfoRes.status, 0, '--install-info must return exit code 0.');
      assert.ok(installInfoRes.stdout.includes('sc.exe create AiHelpAgentSupervisor'));
      assert.ok(installInfoRes.stdout.includes('NT AUTHORITY\\SYSTEM'));
      assert.ok(installInfoRes.stdout.includes('sc.exe start AiHelpAgentSupervisor'));
      assert.ok(installInfoRes.stdout.includes('sc.exe delete AiHelpAgentSupervisor'));
    }

    // =========================================================================
    // 26.D: REAL_OS_ISOLATION_TEST - Production gate fail-closed behavior
    // =========================================================================
    console.log('  26.D: Testing REAL_OS_ISOLATION_TEST contract...');
    {
      // 26.D.1: Production execution gate remains strictly BLOCKED when daemon is uninstalled/unauthenticated
      const uninstalledSup = createNativeSupervisorClient({ pid: 999991 });
      assert.throws(
        () => createWindowsSandboxProviderAdapter({ supervisor: uninstalledSup, isSyntheticTest: false }),
        (err) => err.code === 'SUPERVISOR_AUTHENTICATION_FAILED',
      );

      // 26.D.2: When evaluating real OS isolation (isSyntheticTest: false), hypervisor VM boundary check fails closed
      const supervisorProcess = spawn(NATIVE_SUPERVISOR_EXECUTABLE, ['--console'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        let activeStatus = null;
        for (let attempt = 0; attempt < 25; attempt++) {
          activeStatus = await queryNativeSupervisorStatus();
          if (activeStatus.running) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(activeStatus.running, true);

        const workerAlloc = await sendNativeSupervisorRequest({
          operation: 'ALLOCATE_WORKER',
          runId: 'v44-66-worker-real-1',
          workspaceRoot: 'C:\\test\\workspace',
        });
        assert.equal(workerAlloc.allocated, true);
        assert.ok(workerAlloc.workerId);

        const isolationObservation = await sendNativeSupervisorRequest({
          operation: 'OBSERVE_EFFECTIVE_ISOLATION',
          workerId: workerAlloc.workerId,
          isSyntheticTest: false,
        });

        // 26.D.3: Real OS boundary verification MUST fail
        assert.equal(isolationObservation.effectiveIsolationVerified, false);
        assert.equal(isolationObservation.processIsolationGate, 'BLOCKED');
        assert.equal(isolationObservation.vmBoundaryEnforced, false);
        assert.equal(isolationObservation.jobObjectContainmentEnforced, true);
        assert.equal(isolationObservation.hostFilesystemIsolation, 'UNENFORCED_BY_JOB_OBJECT');
        assert.equal(isolationObservation.networkEgressIsolation, 'UNENFORCED_BY_JOB_OBJECT');
        assert.equal(isolationObservation.reasonCode, 'MISSING_HYPERVISOR_VM_BOUNDARY');
        assert.ok(Array.isArray(isolationObservation.missingBoundaries));
        assert.ok(isolationObservation.missingBoundaries.includes('HYPERVISOR_VM_BOUNDARY'));
        assert.ok(isolationObservation.missingBoundaries.includes('HOST_FILESYSTEM_WRITE_PROTECTION'));
        assert.ok(isolationObservation.missingBoundaries.includes('NETWORK_EGRESS_FIREWALL_RESTRICTION'));

        // 26.D.4: Supervised execution fails closed and refuses to execute unisolated workloads on host
        const realRunRequest = {
          runId: 'v44-66-run-real-gate',
          workspaceRoot: 'C:\\test\\workspace',
          approvedSnapshotDigest: 'f'.repeat(64),
          planDigest: 'e'.repeat(64),
          taskId: 'v44-66-task-real',
          sessionId: 'v44-66-session-real',
          command: { executable: 'cmd.exe', args: ['/c', 'echo', 'should-never-run'] },
          supervisor: createNativeSupervisorClient({
            pid: activeStatus.pid,
            tokenUserSid: activeStatus.tokenUserSid,
            isSyntheticTest: false,
          }),
          isSyntheticTest: false,
        };

        await assert.rejects(
          () => executeWithSupervisor(realRunRequest),
          (err) => {
            assert.equal(err.code, 'PROJECT_EXECUTION_BLOCKED');
            assert.equal(err.executionBlocked, true);
            return true;
          },
        );

        await sendNativeSupervisorRequest({ operation: 'SHUTDOWN' });
      } finally {
        try {
          supervisorProcess.kill();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  console.log('All CODING AGENT V3 — Verified Isolated Project Execution tests passed successfully!');

}

runVerifiedIsolationTests().catch((err) => {

  console.error('V3 Isolation Test Suite failed:', err);

  process.exit(1);

});
