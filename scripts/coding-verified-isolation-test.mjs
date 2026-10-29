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

      assert.equal(installResult.outcome, 'BLOCKED');

      assert.equal(installResult.phase, 'DEPENDENCY_INSTALL_GATE');

      assert.equal(installResult.executionBlocked, true);

      assert.match(installResult.reason, /verified Windows process isolation is required/i);

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

  console.log('All CODING AGENT V3 — Verified Isolated Project Execution tests passed successfully!');

}

runVerifiedIsolationTests().catch((err) => {

  console.error('V3 Isolation Test Suite failed:', err);

  process.exit(1);

});
