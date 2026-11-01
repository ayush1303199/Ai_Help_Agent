import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  ProjectContainerExecutionRunner,
  createProjectContainerExecutionRunner,
  STAGING_STRATEGIES,
  NETWORK_POLICIES,
  DEFAULT_PROJECT_IMAGES,
  APPROVED_BASE_IMAGES,
  DEFAULT_TMPFS_CONFIG,
  validateContainerRunArgs,
} = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');

const {
  runDockerCliAsync,
} = require('../electron/coding-pipeline/dockerProviderAdapter.cjs');

const {
  BUILD_OPERATIONS,
  BUILD_OUTCOMES,
  createBuildPlan,
  executeBuildPlan,
} = require('../electron/coding-pipeline/buildOrchestrator.cjs');

const {
  DEPENDENCY_STATUSES,
  createDependencyPlan,
  executeDependencyPlan,
} = require('../electron/coding-pipeline/dependencyManager.cjs');

const {
  verifyIsolationEvidence,
} = require('../electron/coding-pipeline/sandboxExecutionAdapter.cjs');

const developerFiles = require('../electron/developerFiles.cjs');

async function makeTempDir(prefix = 'v7-container-audit-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function getArgs(callArgs) {
  return Array.isArray(callArgs[0]) ? callArgs[0] : (Array.isArray(callArgs[1]) ? callArgs[1] : []);
}

async function runContainerRunnerTests() {
  console.log('Starting CODING AGENT V7 — Container Runner Security & Integration Audit tests...');

  // -------------------------------------------------------------------------
  // 1. [REAL_HOST_CONTAINER_CHECK] Host Runtime Availability Check
  // -------------------------------------------------------------------------
  console.log('1. [REAL_HOST] Testing host runtime availability check (honest fail-closed)...');
  {
    const hostRunner = createProjectContainerExecutionRunner();
    const availability = hostRunner.checkAvailability();
    assert.equal(typeof availability.available, 'boolean');
    assert.equal(availability.available, false, 'Docker daemon must not be claimed available on unverified Windows host.');
    assert.match(availability.reason, /Docker daemon is not running or unverified/i);

    // If executed directly when host is unavailable, must fail closed immediately
    const fakePlan = {
      planId: 'plan-unavail-test',
      planDigest: crypto.randomUUID(),
      projectRoot: os.tmpdir(),
      binary: 'npm',
      args: ['test'],
      fullCommandString: 'npm test',
    };
    const execResult = await hostRunner.execute({
      plan: fakePlan,
      ownerWebContentsId: 999,
      sessionId: crypto.randomUUID(),
    });
    assert.equal(execResult.ok, false);
    assert.equal(execResult.status, 'BLOCKED');
    assert.equal(execResult.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(execResult.executionBlocked, true);
    assert.match(execResult.reason, /Docker daemon is not running or unverified/i);
  }

  // -------------------------------------------------------------------------
  // 2. [MOCKED_DOCKER_CLI] Launch Policy Gates
  // -------------------------------------------------------------------------
  console.log('2. [MOCK] Testing launch policy gates (Authorization, Command Safety, Network)...');
  {
    const authorizedDir = await makeTempDir('v7-auth-dir-');
    const unauthorizedDir = await makeTempDir('v7-unauth-dir-');
    const ownerId = 302;
    await developerFiles.attachProject(authorizedDir, ownerId);

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true, engineVersion: '24.0.5' }),
      dockerCli: () => ({ status: 0, stdout: '', stderr: '' }),
      isMock: true,
    });

    // 2a. Rejection of unauthorized project root
    const unauthPlan = {
      planId: 'p-unauth',
      planDigest: 'digest-1',
      projectRoot: unauthorizedDir,
      binary: 'npm',
      args: ['test'],
    };
    const unauthPolicy = await runner.validateLaunchPolicy({
      plan: unauthPlan,
      ownerWebContentsId: ownerId,
      image: 'node:20-alpine',
    });
    assert.equal(unauthPolicy.valid, false);
    assert.equal(unauthPolicy.gate, 'AUTHORIZATION_GATE');
    assert.match(unauthPolicy.reason, /Project authorization (?:failed|rejected)/i);

    // 2b. Rejection of command injection / shell metacharacters
    const injectionPlan = {
      planId: 'p-inject',
      planDigest: 'digest-2',
      projectRoot: authorizedDir,
      binary: 'npm',
      args: ['test', ';', 'rm', '-rf', '/'],
    };
    const injectPolicy = await runner.validateLaunchPolicy({
      plan: injectionPlan,
      ownerWebContentsId: ownerId,
      image: 'node:20-alpine',
    });
    assert.equal(injectPolicy.valid, false);
    assert.equal(injectPolicy.gate, 'COMMAND_SAFETY_GATE');
    assert.match(injectPolicy.reason, /disallowed shell metacharacters|unsafe metacharacter/i);

    // 2c. Network Policy Gate: Egress forbidden for non-dependency operations
    const validPlan = {
      planId: 'p-valid',
      planDigest: 'digest-3',
      projectRoot: authorizedDir,
      binary: 'npm',
      args: ['test'],
      operation: 'TEST',
    };
    const egressOnTestPolicy = await runner.validateLaunchPolicy({
      plan: validPlan,
      ownerWebContentsId: ownerId,
      image: 'node:20-alpine',
      networkMode: NETWORK_POLICIES.ALLOW_PACKAGE_EGRESS,
    });
    assert.equal(egressOnTestPolicy.valid, false);
    assert.equal(egressOnTestPolicy.gate, 'NETWORK_POLICY_GATE');
    assert.match(egressOnTestPolicy.reason, /Network access.*strictly forbidden for non-dependency/i);
  }

  // -------------------------------------------------------------------------
  // 3. [MOCKED_DOCKER_CLI] Approval Integrity & Plan Digest Mismatch Gate
  // -------------------------------------------------------------------------
  console.log('3. [MOCK] Testing approval integrity & plan digest mismatch detection...');
  {
    const authorizedDir = await makeTempDir('v7-digest-dir-');
    await fs.writeFile(path.join(authorizedDir, 'package.json'), JSON.stringify({
      name: 'digest-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const ownerId = 303;
    await developerFiles.attachProject(authorizedDir, ownerId);

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true }),
      dockerCli: () => ({ status: 0, stdout: '', stderr: '' }),
      isMock: true,
    });

    const legitimatePlan = await createBuildPlan({
      projectRoot: authorizedDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    // Valid plan digest passes validation
    const validPolicy = await runner.validateLaunchPolicy({
      plan: legitimatePlan,
      ownerWebContentsId: ownerId,
      image: 'node:20-alpine',
    });
    assert.equal(validPolicy.valid, true);

    // Adversarially tampered plan where args were modified after digest creation
    const tamperedPlan = {
      ...legitimatePlan,
      args: ['test', '--malicious-extra-arg'],
    };
    const tamperedPolicy = await runner.validateLaunchPolicy({
      plan: tamperedPlan,
      ownerWebContentsId: ownerId,
      image: 'node:20-alpine',
    });
    assert.equal(tamperedPolicy.valid, false);
    assert.equal(tamperedPolicy.gate, 'APPROVAL_DIGEST_GATE');
    assert.match(tamperedPolicy.reason, /Plan digest mismatch/i);
  }

  // -------------------------------------------------------------------------
  // 4. [MOCKED_DOCKER_CLI] Container Image Allowlist & Provenance Gate
  // -------------------------------------------------------------------------
  console.log('4. [MOCK] Testing container image allowlist and provenance enforcement...');
  {
    const authorizedDir = await makeTempDir('v7-image-dir-');
    await fs.writeFile(path.join(authorizedDir, 'package.json'), JSON.stringify({
      name: 'image-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const ownerId = 304;
    await developerFiles.attachProject(authorizedDir, ownerId);

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true }),
      dockerCli: () => ({ status: 0, stdout: '', stderr: '' }),
      isMock: true,
    });

    const plan = await createBuildPlan({
      projectRoot: authorizedDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    // 4a. Approved official image passes
    const approvedResult = await runner.validateLaunchPolicy({
      plan,
      ownerWebContentsId: ownerId,
      image: 'node:20-alpine',
    });
    assert.equal(approvedResult.valid, true);

    // 4b. Verified immutable digest passes
    const immutableDigestResult = await runner.validateLaunchPolicy({
      plan,
      ownerWebContentsId: ownerId,
      image: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    assert.equal(immutableDigestResult.valid, true);

    // 4c. Arbitrary / unapproved image rejected
    const unapprovedResult = await runner.validateLaunchPolicy({
      plan,
      ownerWebContentsId: ownerId,
      image: 'evilcorp/backdoor:latest',
    });
    assert.equal(unapprovedResult.valid, false);
    assert.equal(unapprovedResult.gate, 'IMAGE_POLICY_GATE');
    assert.match(unapprovedResult.reason, /approved base images or immutable digests/i);
  }

  // -------------------------------------------------------------------------
  // 5. [MOCKED_DOCKER_CLI] Workspace Staging & Symlink Escape Prevention
  // -------------------------------------------------------------------------
  console.log('5. [MOCK] Testing workspace staging and symlink escape prevention...');
  {
    const authorizedDir = await makeTempDir('v7-symlink-src-');
    const outsideSecretDir = await makeTempDir('v7-outside-secret-');
    const secretFile = path.join(outsideSecretDir, 'host_secret.key');
    await fs.writeFile(secretFile, 'SUPER_SECRET_HOST_KEY');

    // Create a regular file and a symlink pointing outside the workspace boundary
    await fs.writeFile(path.join(authorizedDir, 'index.js'), 'console.log("hello");');
    await fs.writeFile(path.join(authorizedDir, '.env'), 'SECRET_TOKEN=12345'); // Sensitive file
    await fs.writeFile(path.join(authorizedDir, 'package.json'), JSON.stringify({ name: 'symlink-fixture' }));

    // Create symlink pointing outside project boundary
    const symlinkPath = path.join(authorizedDir, 'escaped_link');
    try {
      await fs.symlink(secretFile, symlinkPath, 'file');
    } catch {
      // Symlink creation on Windows without Developer Mode might require admin; if skipped, note it
    }

    const runner = new ProjectContainerExecutionRunner();
    const stagingDir = await makeTempDir('v7-staging-dest-');
    await runner._copyWorkspaceToStaging(authorizedDir, stagingDir);

    // 5a. Regular file must be copied
    const copiedIndex = await fs.readFile(path.join(stagingDir, 'index.js'), 'utf8');
    assert.equal(copiedIndex, 'console.log("hello");');

    // 5b. Sensitive file (.env) must NOT be copied into container staging
    const envExists = await fs.stat(path.join(stagingDir, '.env')).then(() => true).catch(() => false);
    assert.equal(envExists, false, '.env file must be excluded from container staging.');

    // 5c. Escaping symlink must NOT expose host secret
    const escapedExists = await fs.stat(path.join(stagingDir, 'escaped_link')).then(() => true).catch(() => false);
    assert.equal(escapedExists, false, 'Symlink escaping project root must not be copied into container staging.');

    await fs.rm(stagingDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 6. [MOCKED_DOCKER_CLI] Verified Container Execution & Command Line Arguments
  // -------------------------------------------------------------------------
  console.log('6. [MOCK] Testing verified container execution and parameters enforcement...');
  {
    const projectDir = await makeTempDir('v7-exec-test-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'container-exec-fixture',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));

    const ownerId = 306;
    await developerFiles.attachProject(projectDir, ownerId);

    const executedCommands = [];
    const mockDockerCli = (...callArgs) => {
      const args = getArgs(callArgs);
      executedCommands.push({ args });
      if (args[0] === 'ps') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return {
        status: 0,
        stdout: 'Test suite passed: 5 passed, 0 failed\n',
        stderr: '',
      };
    };

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true, engineVersion: '24.0.5' }),
      dockerCli: mockDockerCli,
      isMock: true,
    });

    const plan = await createBuildPlan({
      projectRoot: projectDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    const result = await runner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      networkMode: NETWORK_POLICIES.NONE,
      stagingStrategy: STAGING_STRATEGIES.COPY_ON_WRITE,
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'PASSED');
    assert.match(result.stdout, /Test suite passed/);
    assert.ok(result.isolationEvidence, 'Must produce verifiable isolation evidence.');

    // Inspect Docker CLI command line arguments passed to run
    const runInvocation = executedCommands.find((c) => c.args[0] === 'run');
    assert.ok(runInvocation, 'docker run must be invoked');
    const runArgs = runInvocation.args;

    assert.ok(runArgs.includes('--rm'), 'Must include --rm for ephemeral container destruction');
    assert.ok(runArgs.includes('--security-opt=no-new-privileges'), 'Must drop privilege escalation');
    assert.ok(runArgs.includes('--cap-drop=ALL'), 'Must drop all Linux capabilities');
    assert.ok(runArgs.includes('--network=none'), 'Must enforce isolated network=none for tests');
    assert.ok(runArgs.includes('--memory=512m'), 'Must enforce bounded memory');
    assert.ok(runArgs.includes('--cpus=1.0'), 'Must enforce bounded CPU');
    assert.ok(runArgs.includes('--pids-limit=64'), 'Must enforce process limit');
    assert.ok(runArgs.includes('--workdir=/workspace'), 'Must set isolated workdir');
    assert.ok(runArgs.includes('--read-only'), 'Must enforce read-only root filesystem');
    assert.ok(runArgs.includes('--tmpfs'), 'Must configure tmpfs');
    const tmpfsIdx = runArgs.indexOf('--tmpfs');
    assert.equal(runArgs[tmpfsIdx + 1], DEFAULT_TMPFS_CONFIG, 'Must configure bounded /tmp storage');
    assert.ok(runArgs.some((a) => a.startsWith('--label=ai-help-agent-execution-id=')), 'Must tag container with execution ID');
  }

  // -------------------------------------------------------------------------
  // 7. [MOCKED_DOCKER_CLI] Safe Non-Zero Exit Code Capture
  // -------------------------------------------------------------------------
  console.log('7. [MOCK] Testing safe non-zero exit code capture and output redaction...');
  {
    const projectDir = await makeTempDir('v7-failure-test-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'failing-test',
      scripts: { test: 'node -e "process.exit(1)"' },
    }));
    const ownerId = 307;
    await developerFiles.attachProject(projectDir, ownerId);

    const mockDockerCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      return {
        status: 1,
        stdout: 'FAIL src/index.test.js\n  AssertionError: expected true to be false',
        stderr: 'npm ERR! Test failed. See above for more details.\n',
      };
    };

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true }),
      dockerCli: mockDockerCli,
      isMock: true,
    });

    const plan = await createBuildPlan({
      projectRoot: projectDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    const result = await runner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.status, 'FAILED');
    assert.match(result.stdout, /AssertionError/);
    assert.match(result.stderr, /npm ERR!/);
    assert.ok(result.isolationEvidence, 'Failure in container must still yield authentic isolation evidence.');
    assert.equal(result.isolationEvidence.executionExitCode, 1);
  }

  // -------------------------------------------------------------------------
  // 8. [MOCKED_DOCKER_CLI] Cancellation via AbortSignal
  // -------------------------------------------------------------------------
  console.log('8. [MOCK] Testing command cancellation via AbortSignal...');
  {
    const projectDir = await makeTempDir('v7-cancel-test-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'hang-test',
      scripts: { test: 'node -e "setInterval(() => {}, 1000)"' },
    }));
    const ownerId = 308;
    await developerFiles.attachProject(projectDir, ownerId);

    const mockDockerCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      const err = new Error('Process aborted');
      err.name = 'AbortError';
      throw err;
    };

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true }),
      dockerCli: mockDockerCli,
      isMock: true,
    });

    const plan = await createBuildPlan({
      projectRoot: projectDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    const abortController = new AbortController();
    abortController.abort(); // already aborted

    const result = await runner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      signal: abortController.signal,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'CANCELLED');
    assert.match(result.reason, /aborted|cancelled/i);
  }

  // -------------------------------------------------------------------------
  // 9. [MOCKED_DOCKER_CLI] Cleanup Failure Reporting
  // -------------------------------------------------------------------------
  console.log('9. [MOCK] Testing cleanup failure detection and reporting...');
  {
    const projectDir = await makeTempDir('v7-cleanup-fail-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'cleanup-fail-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const ownerId = 309;
    await developerFiles.attachProject(projectDir, ownerId);

    // Mock CLI where `docker ps` always shows a lingering container that cannot be removed
    const mockDockerCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') {
        return { status: 0, stdout: 'stuck-container-id-12345\n', stderr: '' };
      }
      if (args[0] === 'rm') {
        return { status: 1, stdout: '', stderr: 'Error response from daemon: removal of container is already in progress' };
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    };

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true }),
      dockerCli: mockDockerCli,
      isMock: true,
    });

    const plan = await createBuildPlan({
      projectRoot: projectDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    const result = await runner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(result.ok, false, 'Run with failed cleanup must NOT be reported as successful.');
    assert.equal(result.status, 'CLEANUP_FAILED');
    assert.equal(result.cleanupFailed, true);
    assert.match(result.reason, /cleanup verification failed/i);
  }

  // -------------------------------------------------------------------------
  // 10. [MOCKED_DOCKER_CLI] Copy-on-Write Workspace Synchronization
  // -------------------------------------------------------------------------
  console.log('10. [MOCK] Testing copy-on-write workspace sync-back on success...');
  {
    const projectDir = await makeTempDir('v7-cow-test-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'cow-install-fixture',
      dependencies: { lodash: '^4.17.21' },
    }));
    const ownerId = 310;
    await developerFiles.attachProject(projectDir, ownerId);

    let stagedWorkspaceMounted = null;
    const mockDockerCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'run') {
        const vIdx = args.indexOf('-v');
        const vArg = vIdx >= 0 ? args[vIdx + 1] : args.find((a) => a.startsWith('-v') || a.includes(':/workspace'));
        if (vArg) {
          stagedWorkspaceMounted = vArg.replace(/^-v\s*/, '').split(':/workspace')[0];
          const nodeModulesDir = path.join(stagedWorkspaceMounted, 'node_modules', 'lodash');
          const nodeFs = require('node:fs');
          nodeFs.mkdirSync(nodeModulesDir, { recursive: true });
          nodeFs.writeFileSync(path.join(nodeModulesDir, 'package.json'), '{"name":"lodash"}');
        }
        return { status: 0, stdout: 'added 1 package in 1s\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true }),
      dockerCli: mockDockerCli,
      isMock: true,
    });

    const depPlan = createDependencyPlan({
      projectRoot: projectDir,
      dependencyReport: {
        needsInstallation: true,
        findings: [{ dependency: 'lodash' }],
      },
    });

    const installResult = await executeDependencyPlan({
      plan: depPlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runner,
    });

    assert.equal(installResult.ok, true);
    assert.equal(installResult.exitCode, 0);

    const installedFile = path.join(projectDir, 'node_modules', 'lodash', 'package.json');
    const content = await fs.readFile(installedFile, 'utf8');
    assert.equal(JSON.parse(content).name, 'lodash');
  }

  // -------------------------------------------------------------------------
  // 11. [MOCKED_DOCKER_CLI] Never Sync Back Artifacts on Failed Operation
  // -------------------------------------------------------------------------
  console.log('11. [MOCK] Testing zero artifact sync-back on failed operation...');
  {
    const projectDir = await makeTempDir('v7-failed-sync-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'failed-install-fixture',
      dependencies: { badpkg: '^1.0.0' },
    }));
    const ownerId = 311;
    await developerFiles.attachProject(projectDir, ownerId);

    const mockDockerCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'run') {
        const vIdx = args.indexOf('-v');
        const vArg = vIdx >= 0 ? args[vIdx + 1] : args.find((a) => a.startsWith('-v') || a.includes(':/workspace'));
        if (vArg) {
          const stagedMounted = vArg.replace(/^-v\s*/, '').split(':/workspace')[0];
          const nodeModulesDir = path.join(stagedMounted, 'node_modules', 'badpkg');
          const nodeFs = require('node:fs');
          nodeFs.mkdirSync(nodeModulesDir, { recursive: true });
          nodeFs.writeFileSync(path.join(nodeModulesDir, 'package.json'), '{"name":"badpkg"}');
        }
        return { status: 1, stdout: '', stderr: 'npm ERR! 404 Not Found\n' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true, clientAvailable: true }),
      dockerCli: mockDockerCli,
      isMock: true,
    });

    const depPlan = createDependencyPlan({
      projectRoot: projectDir,
      dependencyReport: {
        needsInstallation: true,
        findings: [{ dependency: 'badpkg' }],
      },
    });

    const installResult = await executeDependencyPlan({
      plan: depPlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      containerRunner: runner,
    });

    assert.equal(installResult.ok, false);
    assert.equal(installResult.exitCode, 1);

    // Verify badpkg was NOT synced back to host project root
    const badPkgExists = await fs.stat(path.join(projectDir, 'node_modules', 'badpkg')).then(() => true).catch(() => false);
    assert.equal(badPkgExists, false, 'Artifacts must never be synced back to project after a failed command.');
  }

  // -------------------------------------------------------------------------
  // 12. [ISOLATION_VERIFIER_SPEC] Mock Evidence Provenance Distinction
  // -------------------------------------------------------------------------
  console.log('12. [SPEC] Testing evidence provenance distinction between mock & real...');
  {
    const runner = new ProjectContainerExecutionRunner({ isMock: true });
    assert.equal(runner.isMockRunner, true);

    const forgedClaims = [
      { sandbox: true },
      { isolated: true },
      { provenance: 'mock_container_supervisor', trustClass: 'UNTRUSTED' },
    ];

    for (const claim of forgedClaims) {
      const verified = verifyIsolationEvidence(claim);
      assert.equal(verified.isVerified, false, 'Mocked or forged evidence must be rejected by isolation verifier.');
    }
  }

  // -------------------------------------------------------------------------
  // 13. [REAL_HOST_CONTAINER_CHECK] Live Project C:\Users\Admin\Downloads\Hello
  // -------------------------------------------------------------------------
  console.log('13. [REAL_HOST] Validating live project C:\\Users\\Admin\\Downloads\\Hello...');
  {
    const helloRoot = 'C:\\Users\\Admin\\Downloads\\Hello';
    const helloExists = await fs.stat(helloRoot).then(() => true).catch(() => false);
    if (helloExists) {
      const ownerId = 313;
      await developerFiles.attachProject(helloRoot, ownerId);

      const hostRunner = createProjectContainerExecutionRunner();
      assert.equal(hostRunner.checkAvailability().available, false);

      // 13a. Missing dependencies block at DEPENDENCY_PREREQUISITE_GATE
      const buildPlanWithMissingDeps = await createBuildPlan({
        projectRoot: helloRoot,
        operation: BUILD_OPERATIONS.TEST,
        dependencyReport: {
          needsInstallation: true,
          findings: [{ dependency: 'react' }, { dependency: 'react-dom' }],
        },
      });

      const missingDepResult = await executeBuildPlan({
        plan: buildPlanWithMissingDeps,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        containerRunner: hostRunner,
      });

      assert.equal(missingDepResult.ok, false);
      assert.equal(missingDepResult.executionBlocked, true);
      assert.equal(missingDepResult.gate, 'DEPENDENCY_PREREQUISITE_GATE');

      // 13b. Satisfied prerequisites block honestly at PROCESS_ISOLATION_GATE
      const readyBuildPlan = await createBuildPlan({
        projectRoot: helloRoot,
        operation: BUILD_OPERATIONS.TEST,
        dependencyReport: {
          needsInstallation: false,
          findings: [],
        },
      });

      const execResult = await executeBuildPlan({
        plan: readyBuildPlan,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        containerRunner: hostRunner,
      });

      assert.equal(execResult.ok, false);
      assert.equal(execResult.executionBlocked, true);
      assert.equal(execResult.outcome, BUILD_OUTCOMES.BLOCKED);
      assert.equal(execResult.gate, 'PROCESS_ISOLATION_GATE');
      assert.match(execResult.reason, /verified Windows process isolation is required/i);
    } else {
      console.log('Target C:\\Users\\Admin\\Downloads\\Hello not found on disk, skipping live check.');
    }
  }

  // -------------------------------------------------------------------------
  // 14. [MOCKED_DOCKER_CLI] Docker Rootfs Hardening & Guaranteed Cleanup (Milestone V44.23)
  // -------------------------------------------------------------------------
  console.log('14. [V44.23] Testing read-only rootfs, bounded tmpfs, and guaranteed cleanup on every outcome...');
  {
    const projectDir = await makeTempDir('v44-23-test-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'v44-23-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const ownerId = 423;
    await developerFiles.attachProject(projectDir, ownerId);

    const plan = await createBuildPlan({
      projectRoot: projectDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    // 14a. Argument validation
    assert.throws(() => validateContainerRunArgs(['run', '--rm']), /missing required --read-only/);
    assert.throws(() => validateContainerRunArgs(['run', '--rm', '--read-only']), /missing required --tmpfs/);
    assert.throws(() => validateContainerRunArgs(['run', '--rm', '--read-only', '--tmpfs', '/tmp:rw']), /Invalid --tmpfs configuration/);
    assert.equal(validateContainerRunArgs(['run', '--rm', '--read-only', '--tmpfs', DEFAULT_TMPFS_CONFIG]), true);

    // 14b. Cleanup guaranteed on success
    let cleanupCalls = 0;
    const mockSuccessCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') {
        cleanupCalls++;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const successRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockSuccessCli,
      isMock: true,
    });
    const successRes = await successRunner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(successRes.ok, true);
    assert.equal(successRes.status, 'PASSED');
    assert.equal(successRes.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.ok(cleanupCalls >= 1, 'Cleanup must be called on success');
    assert.equal(successRes.isolationEvidence.readOnlyRoot, true);
    assert.equal(successRes.isolationEvidence.tmpfsMount, DEFAULT_TMPFS_CONFIG);

    // 14c. Cleanup guaranteed on non-zero exit
    cleanupCalls = 0;
    const mockFailCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') {
        cleanupCalls++;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 2, stdout: '', stderr: 'test error' };
    };
    const failRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockFailCli,
      isMock: true,
    });
    const failRes = await failRunner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.status, 'FAILED');
    assert.equal(failRes.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.ok(cleanupCalls >= 1, 'Cleanup must be called on non-zero exit');

    // 14d. Cleanup guaranteed on timeout
    cleanupCalls = 0;
    const mockTimeoutCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') {
        cleanupCalls++;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: null, timedOut: true, stdout: '', stderr: 'timed out' };
    };
    const timeoutRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockTimeoutCli,
      isMock: true,
    });
    const timeoutRes = await timeoutRunner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(timeoutRes.ok, false);
    assert.equal(timeoutRes.status, 'TIMED_OUT');
    assert.equal(timeoutRes.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.ok(cleanupCalls >= 1, 'Cleanup must be called on timeout');

    // 14e. Cleanup guaranteed on unexpected thrown exception
    cleanupCalls = 0;
    const mockThrowCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') {
        cleanupCalls++;
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error('Unexpected container execution failure');
    };
    const throwRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockThrowCli,
      isMock: true,
    });
    const throwRes = await throwRunner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(throwRes.ok, false);
    assert.equal(throwRes.status, 'FAILED');
    assert.equal(throwRes.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.equal(throwRes.originalError, 'Unexpected container execution failure');
    assert.ok(cleanupCalls >= 1, 'Cleanup must run in catch/finally on unexpected exception');

    // 14f. Truthful reporting when cleanup fails after an exception
    const mockDoubleFailCli = (...callArgs) => {
      const args = getArgs(callArgs);
      if (args[0] === 'ps') {
        return { status: 0, stdout: 'lingering-cid\n', stderr: '' };
      }
      if (args[0] === 'rm') {
        return { status: 1, stdout: '', stderr: 'rm failure' };
      }
      throw new Error('Primary execution exploded');
    };
    const doubleFailRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockDoubleFailCli,
      isMock: true,
    });
    const doubleFailRes = await doubleFailRunner.execute({ plan, ownerWebContentsId: ownerId, sessionId: crypto.randomUUID() });
    assert.equal(doubleFailRes.ok, false);
    assert.equal(doubleFailRes.status, 'CLEANUP_FAILED');
    assert.equal(doubleFailRes.cleanupFailed, true);
    assert.equal(doubleFailRes.originalError, 'Primary execution exploded');
    assert.match(doubleFailRes.reason, /Primary execution exploded/);
    assert.match(doubleFailRes.reason, /container cleanup verification failed/);

    await fs.rm(projectDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 15. [V44.24] Testing Asynchronous Docker Execution & Real In-Flight Cancellation
  // -------------------------------------------------------------------------
  console.log('15. [V44.24] Testing asynchronous Docker execution, real in-flight cancellation, and process lifecycle...');
  {
    const projectDir = await makeTempDir('v44-24-async-test-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'async-cancel-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const ownerId = 4424;
    await developerFiles.attachProject(projectDir, ownerId);
    const plan = await createBuildPlan({
      projectRoot: projectDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    // 15a. Default constructor configures runDockerCliAsync
    const defaultRunner = new ProjectContainerExecutionRunner();
    assert.equal(defaultRunner.dockerCli, runDockerCliAsync, 'Default dockerCli must be runDockerCliAsync');
    assert.equal(defaultRunner.isMockRunner, false, 'Default runner must not be classified as mock runner');

    // 15b. Direct runDockerCliAsync pre-launch cancellation
    const preAbortController = new AbortController();
    preAbortController.abort();
    const preAbortRes = await runDockerCliAsync('docker', ['run', 'alpine'], { signal: preAbortController.signal });
    assert.equal(preAbortRes.cancelled, true);
    assert.equal(preAbortRes.status, null);
    assert.equal(preAbortRes.signal, 'SIGTERM');
    assert.match(preAbortRes.error, /cancelled by caller before process launch/i);

    // 15c. Duplicate abort calls do not throw or produce unhandled errors
    preAbortController.abort();
    preAbortController.abort();

    // 15d. Real in-flight cancellation on container runner
    let inFlightCleanupCalls = 0;
    let inFlightProcessCancelled = false;
    const abortController = new AbortController();

    const mockInFlightCli = async (bin, args, timeoutMs, opts = {}) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs[0] === 'ps') {
        inFlightCleanupCalls++;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (callArgs[0] === 'run') {
        const sig = opts.signal;
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({ status: 0, stdout: 'completed normally', stderr: '' });
          }, 5000);

          if (sig) {
            sig.addEventListener('abort', () => {
              clearTimeout(timer);
              inFlightProcessCancelled = true;
              resolve({
                status: null,
                signal: 'SIGTERM',
                timedOut: false,
                cancelled: true,
                error: 'ABORT_ERR: Docker CLI execution was cancelled by caller.',
                stdout: '',
                stderr: '',
              });
            }, { once: true });
          }
        });
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const inFlightRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockInFlightCli,
      isMock: true,
    });

    // Trigger execution and abort mid-flight
    const executePromise = inFlightRunner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      signal: abortController.signal,
    });

    // Abort after 20ms while in-flight
    await new Promise((r) => setTimeout(r, 20));
    abortController.abort();

    const cancelResult = await executePromise;
    assert.equal(cancelResult.ok, false);
    assert.equal(cancelResult.status, 'CANCELLED');
    assert.equal(cancelResult.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.equal(inFlightProcessCancelled, true, 'Active in-flight child execution must receive abort');
    assert.ok(inFlightCleanupCalls >= 1, 'Cleanup verification must be triggered after cancellation');
    assert.match(cancelResult.reason, /cancelled by caller/i);

    // 15e. In-flight cancellation with failed container cleanup
    const abortController2 = new AbortController();
    const mockCancelCleanupFailCli = async (bin, args, timeoutMs, opts = {}) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs[0] === 'ps') {
        return { status: 0, stdout: 'stuck-container-xyz\n', stderr: '' };
      }
      if (callArgs[0] === 'rm') {
        return { status: 1, stdout: '', stderr: 'rm failure: container busy' };
      }
      if (callArgs[0] === 'run') {
        return new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () => {
            resolve({
              status: null,
              signal: 'SIGTERM',
              timedOut: false,
              cancelled: true,
              error: 'ABORT_ERR: Cancelled by caller.',
              stdout: '',
              stderr: '',
            });
          }, { once: true });
        });
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const cancelFailRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockCancelCleanupFailCli,
      isMock: true,
    });

    const executePromise2 = cancelFailRunner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      signal: abortController2.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    abortController2.abort();

    const cancelFailResult = await executePromise2;
    assert.equal(cancelFailResult.ok, false);
    assert.equal(cancelFailResult.status, 'CLEANUP_FAILED');
    assert.equal(cancelFailResult.cleanupFailed, true);
    assert.match(cancelFailResult.reason, /cancelled by caller/i);
    assert.match(cancelFailResult.reason, /container cleanup verification failed/i);

    // 15f. Asynchronous timeout handling and process termination
    let timeoutCleanupCalled = false;
    const mockTimeoutCli = async (bin, args, timeoutMs, opts = {}) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs[0] === 'ps') {
        timeoutCleanupCalled = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (callArgs[0] === 'run') {
        return {
          status: null,
          signal: 'SIGKILL',
          timedOut: true,
          cancelled: false,
          error: 'ETIMEDOUT: Docker CLI execution timed out.',
          stdout: '',
          stderr: 'Execution timed out',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const timeoutRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockTimeoutCli,
      isMock: true,
    });

    const timeoutResult = await timeoutRunner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.status, 'TIMED_OUT');
    assert.equal(timeoutResult.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.ok(timeoutCleanupCalled, 'Cleanup verification must be triggered after timeout');

    // 15g. Asynchronous non-zero exit code capture
    const mockNonZeroCli = async (bin, args) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (callArgs[0] === 'run') {
        return {
          status: 42,
          signal: null,
          timedOut: false,
          cancelled: false,
          error: null,
          stdout: 'Standard output before error',
          stderr: 'Process failed with exit code 42',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const nonZeroRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockNonZeroCli,
      isMock: true,
    });

    const nonZeroResult = await nonZeroRunner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });
    assert.equal(nonZeroResult.ok, false);
    assert.equal(nonZeroResult.status, 'FAILED');
    assert.equal(nonZeroResult.exitCode, 42);
    assert.equal(nonZeroResult.cleanupStatus, 'HOST_VERIFIED_CLEANED');
    assert.match(nonZeroResult.stderr, /exit code 42/);

    // 15h. Asynchronous spawn error handling
    const mockSpawnErrorCli = async (bin, args) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      return {
        status: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        error: 'SPAWN_ERROR: ENOENT: spawn docker ENOENT',
        stdout: '',
        stderr: 'spawn docker ENOENT',
      };
    };

    const spawnErrorRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: mockSpawnErrorCli,
      isMock: true,
    });

    const spawnErrorResult = await spawnErrorRunner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });
    assert.equal(spawnErrorResult.ok, false);
    assert.equal(spawnErrorResult.status, 'FAILED');
    assert.match(spawnErrorResult.reason, /ENOENT/i);
    assert.equal(spawnErrorResult.cleanupStatus, 'HOST_VERIFIED_CLEANED');

    await fs.rm(projectDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 16. [V44.25] Testing Truthful Docker Capability Discovery & Configuration vs Runtime Evidence
  // -------------------------------------------------------------------------
  console.log('16. [V44.25] Testing truthful Docker capability discovery and configuration vs runtime evidence...');
  {
    const projectDir = await makeTempDir('v44-25-runner-test-');
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'v44-25-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const ownerId = 4427;
    await developerFiles.attachProject(projectDir, ownerId);
    const plan = await createBuildPlan({
      projectRoot: projectDir,
      operation: BUILD_OPERATIONS.TEST,
      dependencyReport: { needsInstallation: false, findings: [] },
    });

    const mockRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: (bin, args) => {
        if (args && args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: 'pass', stderr: '' };
      },
      isMock: true,
    });

    const execRes = await mockRunner.execute({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });

    assert.equal(execRes.ok, true);
    assert.equal(execRes.isolationEvidence.readOnlyRoot, true, 'Configuration --read-only must be recorded');
    assert.equal(execRes.isolationEvidence.tmpfsMount, DEFAULT_TMPFS_CONFIG, 'Configuration --tmpfs must be recorded');

    // Capability provenance
    const capEvidence = execRes.isolationEvidence.capabilityEvidence;
    assert.ok(capEvidence, 'isolationEvidence must contain structured capabilityEvidence');
    assert.equal(capEvidence.readOnlyRootfs.configured, true);
    assert.equal(capEvidence.readOnlyRootfs.runtimeEnforcement, 'NOT_VERIFIED');
    assert.equal(capEvidence.readOnlyRootfs.verificationMethod, 'CLI_FLAG_CONFIGURATION');
    assert.equal(capEvidence.networkMode.egressFiltering, 'NOT_VERIFIED');
    assert.equal(capEvidence.resourceLimits.cgroupEnforcement, 'NOT_VERIFIED');
    assert.equal(capEvidence.temporaryStorage.runtimeEnforcement, 'NOT_VERIFIED');

    await fs.rm(projectDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 17. [V44.26] Testing End-to-End Isolation Capability Enforcement and Execution Gate Blocking
  // -------------------------------------------------------------------------
  console.log('17. [V44.26] Testing end-to-end isolation capability enforcement and execution gate blocking...');
  {
    const { ContainerProvider } = require('../electron/coding-pipeline/providers/containerProvider.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');

    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });

    const unverifiedRuntime = {
      providerId: 'docker',
      runtimeType: 'container',
      isolationVerified: false,
      supportedOps: ['test'],
      isReady: false,
      capabilityVerificationStatus: 'BLOCKED',
    };

    // 17.1: executeWithRuntime blocks unverified runtime fail-closed
    const execWithRuntimeRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: unverifiedRuntime,
    });
    assert.equal(execWithRuntimeRes.ok, false);
    assert.equal(execWithRuntimeRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(execWithRuntimeRes.reason, /isolation is unverified/i);

    // 17.2: Direct execute blocks unverified runtime fail-closed
    const execDirectRes = await realRunner.execute({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: unverifiedRuntime,
    });
    assert.equal(execDirectRes.ok, false);
    assert.equal(execDirectRes.status, 'BLOCKED');
    assert.equal(execDirectRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(execDirectRes.reason, /isolation attestation has not been established/i);

    // 17.3: Untrusted provenance sources blocked fail-closed on non-mock runner
    for (const src of ['synthetic', 'mock', 'untrusted-caller-input', 'simulated']) {
      const res = await realRunner.execute({
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
      assert.equal(res.ok, false);
      assert.equal(res.status, 'BLOCKED');
      assert.equal(res.gate, 'PROCESS_ISOLATION_GATE');
      assert.match(res.reason, /synthetic test evidence rejected/i);
    }

    // 17.4: Verification policies require genuine capabilities and reject forged flags
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

    assert.ok(verifyIsolationCapabilities({ providerDescriptor: baseDescriptor, requestedPolicy: { requireReadOnlyRootfs: true } }).missingCapabilities.includes('read_only_rootfs'));
    assert.ok(verifyIsolationCapabilities({ providerDescriptor: baseDescriptor, requestedPolicy: { requireEgressFiltering: true } }).missingCapabilities.includes('egress_filtering'));
    assert.ok(verifyIsolationCapabilities({ providerDescriptor: baseDescriptor, requestedPolicy: { requireCgroupLimits: true } }).missingCapabilities.includes('cgroup_resource_limits'));
    assert.ok(verifyIsolationCapabilities({ providerDescriptor: baseDescriptor, requestedPolicy: { requireFilesystemIsolation: true } }).missingCapabilities.includes('restricted_bind_mounts'));
    assert.ok(verifyIsolationCapabilities({ providerDescriptor: baseDescriptor, requestedPolicy: { requireCleanupAttestation: true } }).missingCapabilities.includes('cleanup_attestation'));
    assert.ok(verifyIsolationCapabilities({ providerDescriptor: baseDescriptor, requestedPolicy: { requireRuntimeSupervisor: true } }).missingCapabilities.includes('runtime_supervisor'));

    const callerSuppliedRes = verifyIsolationCapabilities({ providerDescriptor: baseDescriptor, evidence: { verified: true } });
    assert.equal(callerSuppliedRes.ready, false);
    assert.equal(callerSuppliedRes.status, PROVIDER_STATUSES.BLOCKED);

    const cp = new ContainerProvider();
    assert.equal(cp.verifyEvidence({ verified: true }).verified, false);
  }

  // -------------------------------------------------------------------------
  // 18. [V44.27] Testing Adversarial Bypass Rejection, False-Cleanup Prevention & In-Flight Cancellation
  // -------------------------------------------------------------------------
  console.log('18. [V44.27] Testing adversarial bypass rejection, false-cleanup prevention & in-flight cancellation...');
  {
    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });

    // 18.1: executeWithRuntime blocks unregistered provider fail-closed
    const unregRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: { providerId: 'unregistered', supportedOps: ['test'], isolationVerified: true },
    });
    assert.equal(unregRes.ok, false);
    assert.equal(unregRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(unregRes.reason, /not registered/i);

    // 18.2: executeWithRuntime blocks untrusted provenance and forged flags
    const forgeRuntimeRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: { providerId: 'docker', supportedOps: ['test'], isolationVerified: true, evidenceSource: 'synthetic' },
    });
    assert.equal(forgeRuntimeRes.ok, false);
    assert.equal(forgeRuntimeRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(forgeRuntimeRes.reason, /synthetic or untrusted runtime evidence rejected/i);

    // 18.3: Cleanup query failure must never report false cleanup success
    const failRunner = new ProjectContainerExecutionRunner({
      dockerCli: () => ({ status: 1, error: 'CLI failed', stdout: '', stderr: 'err' }),
      isMock: false,
    });
    const clRes = await failRunner._verifyCleanup('test-label');
    assert.equal(clRes.cleaned, false);
    assert.equal(clRes.status, 'CLEANUP_FAILED');
    assert.match(clRes.error, /err|failed to query container status/i);

    // 18.4: Empty or invalid cleanup label fails closed
    const emptyLabel = await realRunner._verifyCleanup('   ');
    assert.equal(emptyLabel.cleaned, false);
    assert.equal(emptyLabel.status, 'CLEANUP_FAILED');
  }

  // -------------------------------------------------------------------------
  // 19. [V44.29] Cryptographic Attestation Verification & Tamper Detection
  // -------------------------------------------------------------------------
  console.log('19. [V44.29] Testing cryptographic attestation verification & tamper detection...');
  {
    const {
      createAttestationPayload,
      signAttestationPayload,
      verifyAttestationSignature,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const trustStore = {
      getPublicKey: (issuer, key) => (issuer === 'auth-1' && key === 'key-1' ? pubPem : null),
    };

    const payload = createAttestationPayload({
      issuerId: 'auth-1',
      keyId: 'key-1',
      algorithm: 'ed25519',
    });
    const signed = signAttestationPayload({
      payload,
      privateKey,
      keyId: 'key-1',
      issuerId: 'auth-1',
    });

    // 19.1: Valid signature with trust store succeeds
    const okRes = verifyAttestationSignature({ attestation: signed, trustStore });
    assert.equal(okRes.valid, true);
    assert.equal(okRes.state, 'AUTHENTICATED');

    // 19.2: Tampered payload fails verification
    const badPayload = { ...signed.payload, nonce: crypto.randomUUID() };
    const badRes = verifyAttestationSignature({ attestation: { ...signed, payload: badPayload }, trustStore });
    assert.equal(badRes.state, 'BLOCKED');
    assert.equal(badRes.reasonCode, 'SIGNATURE_VERIFICATION_FAILED');

    // 19.3: Self-supplied public key is rejected
    const selfRes = verifyAttestationSignature({ attestation: { ...signed, publicKey: pubPem }, trustStore });
    assert.equal(selfRes.state, 'BLOCKED');
    assert.equal(selfRes.reasonCode, 'SELF_SIGNED_KEY_REJECTED');

    // 19.4: Container runner rejects unauthenticated attestation
    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });
    const unauthExecRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: {
        providerId: 'docker',
        supportedOps: ['test'],
        attestation: { ...signed, signature: 'bad_sig' },
      },
    });
    assert.equal(unauthExecRes.ok, false);
    assert.equal(unauthExecRes.gate, 'PROCESS_ISOLATION_GATE');
  }

  // -------------------------------------------------------------------------
  // 20. [V44.30] Out-of-Process Issuer Service Contract & Boundary Rejection
  // -------------------------------------------------------------------------
  console.log('20. [V44.30] Testing out-of-process issuer service contract & boundary rejection...');
  {
    const {
      ISSUER_SERVICE_STATES,
      ISSUER_TRUST_DOMAINS,
      evaluateIssuerServiceBoundary,
      validateIssuerRequest,
      issueAttestation,
      authorizeExecution,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');

    // 20.1: Ordinary child process or in-session process is rejected as boundary
    const childRes = evaluateIssuerServiceBoundary({
      serviceId: 'docker-helper-child',
      isOrdinaryChildProcess: true,
      runsInUserDesktopSession: true,
    });
    assert.equal(childRes.isTrustedBoundary, false);
    assert.equal(childRes.reasonCode, 'NOT_A_SECURITY_BOUNDARY');

    // 20.2: Provider adapter claiming to be issuer is rejected
    const provRes = evaluateIssuerServiceBoundary({
      serviceId: 'docker-provider',
      domain: ISSUER_TRUST_DOMAINS.PROVIDER_ADAPTER,
      hasIndependentOsIdentity: true,
      hasIsolatedIpcChannel: true,
      hasProtectedKeyStorage: true,
    });
    assert.equal(provRes.isTrustedBoundary, false);
    assert.equal(provRes.reasonCode, 'DOMAIN_CANNOT_ISSUE');

    // 20.3: Container runner rejects caller-supplied issuer service descriptor
    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });
    const fakeIssuerExecRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: {
        providerId: 'docker',
        supportedOps: ['test'],
        issuerService: { serviceId: 'forged-service', isTrusted: true },
      },
    });
    assert.equal(fakeIssuerExecRes.ok, false);
    assert.equal(fakeIssuerExecRes.gate, 'PROCESS_ISOLATION_GATE');

    // 20.4: Production authorization remains unconditionally BLOCKED
    const authDecision = authorizeExecution({
      attestationVerificationResult: { state: 'AUTHENTICATED' },
      serviceDescriptor: { isProductionService: true },
      providerDescriptor: { providerId: 'docker' },
      osEnforcementEvidence: { kernelEnforced: false },
    });
    assert.equal(authDecision.state, 'BLOCKED');
    assert.equal(authDecision.reasonCode, 'ISSUER_TRUST_BOUNDARY_NOT_ESTABLISHED');
  }

  // -------------------------------------------------------------------------
  // 21. [V44.31] Docker Runtime Observation, Daemon Trust Boundary & Runner Gates
  // -------------------------------------------------------------------------
  console.log('21. [V44.31] Testing Docker runtime observation, daemon trust boundary & runner enforcement gates...');
  {
    const {
      DOCKER_DAEMON_TRUST_STATES,
      DOCKER_OBSERVATION_STATES,
      evaluateDockerDaemonTrust,
      evaluateDockerObservation,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');

    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });

    // 21.1: Runner rejects caller-supplied daemonTrust: 'VERIFIED' or kernelEnforced: true
    const forgedTrustRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: {
        providerId: 'docker',
        supportedOps: ['test'],
        daemonTrust: 'VERIFIED',
      },
    });
    assert.equal(forgedTrustRes.ok, false);
    assert.equal(forgedTrustRes.gate, 'PROCESS_ISOLATION_GATE');

    const forgedKernelRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: {
        providerId: 'docker',
        supportedOps: ['test'],
        kernelEnforced: true,
      },
    });
    assert.equal(forgedKernelRes.ok, false);
    assert.equal(forgedKernelRes.gate, 'PROCESS_ISOLATION_GATE');

    // 21.2: Runner rejects Docker observation with bridge networking or unverified egress
    const bridgeObsResult = verifyIsolationCapabilities({
      providerDescriptor: {
        providerId: 'docker',
        supportedPlatforms: ['win32', 'linux', 'darwin'],
        isReady: true,
        capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      },
      evidence: {
        dockerObservation: {
          daemonId: 'daemon-uuid-1',
          endpoint: 'npipe:////./pipe/docker_engine',
          containerId: 'container-abc',
          containerCreationIdentity: 'creation-1',
          executionId: 'exec-1',
          projectId: 'proj-1',
          sessionId: 'sess-1',
          grantId: 'grant-1',
          policyDigest: 'policy-1',
          planDigest: 'plan-1',
          observationTimestamp: new Date().toISOString(),
          nonce: crypto.randomUUID(),
          networkMode: 'bridge',
          mounts: [],
        },
      },
      context: { projectId: 'proj-1', executionId: 'exec-1', sessionId: 'sess-1', containerId: 'container-abc' },
    });
    assert.equal(bridgeObsResult.ready, false);
    assert.equal(bridgeObsResult.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(bridgeObsResult.reasonCode, 'NETWORK_EGRESS_UNVERIFIED');

    // 21.3: Runner rejects Docker observation with conflicting cgroups or missing controllers
    const cgroupConflictResult = verifyIsolationCapabilities({
      providerDescriptor: {
        providerId: 'docker',
        supportedPlatforms: ['win32', 'linux', 'darwin'],
        isReady: true,
        capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      },
      evidence: {
        dockerObservation: {
          daemonId: 'daemon-uuid-1',
          endpoint: 'npipe:////./pipe/docker_engine',
          containerId: 'container-abc',
          containerCreationIdentity: 'creation-1',
          executionId: 'exec-1',
          projectId: 'proj-1',
          sessionId: 'sess-1',
          grantId: 'grant-1',
          policyDigest: 'policy-1',
          planDigest: 'plan-1',
          observationTimestamp: new Date().toISOString(),
          nonce: crypto.randomUUID(),
          networkMode: 'none',
          memoryLimitBytes: 536870912,
          mounts: [],
        },
        cgroupEvidence: { effectiveMemoryMax: 1073741824, controllersAvailable: true },
      },
      context: { projectId: 'proj-1', executionId: 'exec-1', sessionId: 'sess-1', containerId: 'container-abc' },
    });
    assert.equal(cgroupConflictResult.ready, false);
    assert.equal(cgroupConflictResult.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(cgroupConflictResult.reasonCode, 'CGROUP_OBSERVATION_CONFLICT');

    // 21.4: Runner execution authorization fails closed with zero host execution fallback when daemon trust is NOT_ESTABLISHED
    const unverifiedObservation = {
      daemonId: 'daemon-uuid-1',
      endpoint: 'npipe:////./pipe/docker_engine',
      containerId: 'container-abc',
      containerCreationIdentity: 'creation-1',
      executionId: 'exec-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      grantId: 'grant-1',
      policyDigest: 'policy-1',
      planDigest: 'plan-1',
      observationTimestamp: new Date().toISOString(),
      nonce: crypto.randomUUID(),
      networkMode: 'none',
      mounts: [],
    };
    const evalOutcome = evaluateDockerObservation({
      observation: unverifiedObservation,
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(evalOutcome.daemonTrust, DOCKER_DAEMON_TRUST_STATES.NOT_ESTABLISHED);
    assert.equal(evalOutcome.kernelEnforcement, 'NOT_VERIFIED');
    assert.equal(evalOutcome.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(evalOutcome.gateStatus, 'BLOCKED');
  }

  // -------------------------------------------------------------------------
  // 22. [V44.32] Host Kernel Enforcement Observer — Cgroups & Mount Gates
  // -------------------------------------------------------------------------
  console.log('22. [V44.32] Testing host kernel enforcement observer, cgroups v2 & mount gates in container runner...');
  {
    const {
      KERNEL_OBSERVATION_STATES,
      evaluateHostKernelEnforcement,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');

    const realRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      isMock: false,
    });

    // 22.1: Runner rejects caller-supplied kernelEnforced or cgroupEnforced flags
    const fakeKernelExecRes = await realRunner.executeWithRuntime({
      plan: { operation: 'test', projectRoot: 'c:/dummy', planDigest: 'digest1' },
      ownerWebContentsId: 9999,
      sessionId: 'sess-1',
      runtime: {
        providerId: 'docker',
        supportedOps: ['test'],
        kernelEnforced: true,
      },
    });
    assert.equal(fakeKernelExecRes.ok, false);
    assert.equal(fakeKernelExecRes.gate, 'PROCESS_ISOLATION_GATE');

    // 22.2: Verifier blocks execution if cgroup v2 observation is missing controllers
    const badCgroupRes = verifyIsolationCapabilities({
      providerDescriptor: {
        providerId: 'docker',
        supportedPlatforms: ['win32', 'linux', 'darwin'],
        isReady: true,
        capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      },
      evidence: {
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
          observerAuthentication: 'AUTHENTICATED',
          hasIndependentSecurityPrincipal: true,
          cgroupObservation: {
            cgroupVersion: 2,
            isCgroupV2: true,
            cgroupPath: '/sys/fs/cgroup/docker/container-abc-123/',
            controllers: ['cpu'],
            cpuMax: '50000 100000',
            memoryMax: '536870912',
            pidsMax: '64',
          },
          mountObservation: {
            mountNamespaceId: 'mnt:[4026532456]',
            mounts: [{ destination: '/', target: '/', flags: ['ro'], readOnly: true }],
          },
        },
      },
      context: { projectId: 'proj-1', executionId: 'exec-1', sessionId: 'sess-1', containerId: 'container-abc-123' },
    });
    assert.equal(badCgroupRes.ready, false);
    assert.equal(badCgroupRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(badCgroupRes.reasonCode, 'MEMORY_CONTROLLER_MISSING');

    // 22.3: Verifier blocks execution if root filesystem is not mounted read-only
    const writableMountRes = verifyIsolationCapabilities({
      providerDescriptor: {
        providerId: 'docker',
        supportedPlatforms: ['win32', 'linux', 'darwin'],
        isReady: true,
        capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      },
      evidence: {
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
          observerAuthentication: 'AUTHENTICATED',
          hasIndependentSecurityPrincipal: true,
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
            mounts: [{ destination: '/', target: '/', flags: ['rw'], readOnly: false }],
          },
        },
      },
      context: { projectId: 'proj-1', executionId: 'exec-1', sessionId: 'sess-1', containerId: 'container-abc-123' },
    });
    assert.equal(writableMountRes.ready, false);
    assert.equal(writableMountRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(writableMountRes.reasonCode, 'WRITABLE_ROOT_FILESYSTEM');

    // 22.4: Production evaluation fails closed without an authenticated independent observer
    const unauthHostRes = evaluateHostKernelEnforcement({
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
        observerAuthentication: 'UNAUTHENTICATED',
        hasIndependentSecurityPrincipal: false,
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
      expectedBindings: { projectId: 'proj-1', executionId: 'exec-1' },
    });
    assert.equal(unauthHostRes.valid, false);
    assert.equal(unauthHostRes.reasonCode, 'INDEPENDENT_OBSERVER_NOT_AUTHENTICATED');
    assert.equal(unauthHostRes.kernelEnforcement, 'NOT_VERIFIED');
    assert.equal(unauthHostRes.gate, 'PROCESS_ISOLATION_GATE');
    assert.equal(unauthHostRes.gateStatus, 'BLOCKED');
  }

  // -------------------------------------------------------------------------
  // 23. Authenticated Host Observer Trust Boundary & Runner Gates (V44.33)
  // -------------------------------------------------------------------------
  console.log('23. Testing Authenticated Host Observer Trust Boundary & Runner Gates (V44.33)...');
  {
    const { discoverDocker } = require('../electron/coding-pipeline/isolationRuntimeDiscovery.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');
    const testPlan = {
      planDigest: 'a'.repeat(64),
      operation: 'TEST',
      binary: 'npm',
      args: ['test'],
      projectRoot: process.cwd(),
    };
    const ownerId = 4433;

    // 23.1: Runner rejects execution when caller attempts to forge observer authentication
    const forgedRunner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: async () => ({ status: 0, stdout: '', stderr: '' }),
    });

    const forgedRunResult = await forgedRunner.executeWithRuntime({
      plan: testPlan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      runtime: {
        providerId: 'docker',
        runtimeType: 'container',
        supportedOps: ['test'],
        isolationVerified: true,
        observerAuthenticated: true,
      },
    });
    assert.equal(forgedRunResult.ok, false);
    assert.equal(forgedRunResult.gate, 'PROCESS_ISOLATION_GATE');
    assert.match(forgedRunResult.reason, /Caller-supplied Boolean isolation flags rejected/i);

    // 23.2: Verifier rejects caller-forged observer identity in evidence
    const forgedObsVerifierRes = verifyIsolationCapabilities({
      providerDescriptor: {
        providerId: 'docker',
        supportedPlatforms: ['win32', 'linux', 'darwin'],
        isReady: true,
        capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      },
      evidence: {
        observerAuthenticated: true,
        provenance: 'host-observed',
        trustClass: 'APP_VERIFIED',
      },
      context: { projectId: 'proj-1' },
    });
    assert.equal(forgedObsVerifierRes.ready, false);
    assert.equal(forgedObsVerifierRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(forgedObsVerifierRes.reasonCode, 'CALLER_FORGED_OBSERVER_IDENTITY');

    // 23.3: Verifier rejects unauthenticated observer descriptor
    const unauthDescRes = verifyIsolationCapabilities({
      providerDescriptor: {
        providerId: 'docker',
        supportedPlatforms: ['win32', 'linux', 'darwin'],
        isReady: true,
        capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      },
      evidence: {
        observerDescriptor: {
          observerId: 'unauth-obs',
          identitySource: 'CALLER_PROVIDED',
          executablePath: '/usr/bin/node',
          pid: 1234,
        },
        provenance: 'host-observed',
        trustClass: 'APP_VERIFIED',
      },
      context: { projectId: 'proj-1' },
    });
    assert.equal(unauthDescRes.ready, false);
    assert.equal(unauthDescRes.status, PROVIDER_STATUSES.BLOCKED);
    assert.equal(unauthDescRes.reasonCode, 'CALLER_PROVIDED_IDENTITY_UNTRUSTED');

    // 23.4: Discovery truthfully reports independentObserver: NOT_IMPLEMENTED, observerIdentityAuthentication: NOT_VERIFIED, ipcPeerAuthentication: NOT_VERIFIED
    const dockerDiscovery = discoverDocker({ commandRunner: () => ({ succeeded: true, exitCode: 0, stdout: 'Docker version 27.0.0', stderr: '' }) });
    assert.equal(dockerDiscovery.independentObserver, 'NOT_IMPLEMENTED');
    assert.equal(dockerDiscovery.observerIdentityAuthentication, 'NOT_VERIFIED');
    assert.equal(dockerDiscovery.ipcPeerAuthentication, 'NOT_VERIFIED');
    assert.equal(dockerDiscovery.capabilityVerificationStatus, PROVIDER_STATUSES.BLOCKED);

    const containerProvider = new (require('../electron/coding-pipeline/providers/containerProvider.cjs').ContainerProvider)();
    const containerCaps = await containerProvider.discoverCapabilities();
    assert.equal(containerCaps.independentObserver, 'NOT_IMPLEMENTED');
    assert.equal(containerCaps.observerIdentityAuthentication, 'NOT_VERIFIED');
    assert.equal(containerCaps.ipcPeerAuthentication, 'NOT_VERIFIED');
    assert.equal(containerCaps.capabilityVerificationStatus, PROVIDER_STATUSES.BLOCKED);
  }

  // -------------------------------------------------------------------------
  // 24. [V44.34] Windows OS-Authenticated Observer IPC & Peer Identity Audit
  // -------------------------------------------------------------------------
  console.log('24. [V44.34] Testing Windows OS-authenticated observer IPC & peer identity...');
  {
    const {
      WINDOWS_IPC_SECURITY_STATES,
      WINDOWS_TRUSTED_SECURITY_PRINCIPALS,
      validateWindowsNamedPipeSecurity,
      validateWindowsProcessPeerIdentity,
      authenticateObserver,
    } = require('../electron/coding-pipeline/executionEvidenceContract.cjs');
    const { verifyIsolationCapabilities } = require('../electron/coding-pipeline/isolationCapabilityVerifier.cjs');
    const { ProjectContainerExecutionRunner } = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');
    const { discoverDocker } = require('../electron/coding-pipeline/isolationRuntimeDiscovery.cjs');
    const { PROVIDER_STATUSES } = require('../electron/coding-pipeline/isolationProviderRegistry.cjs');

    const testPlan = {
      operation: 'test',
      command: 'npm',
      args: ['test'],
      projectRoot: process.cwd(),
    };
    const ownerId = 4434;

    // 24.1: Runner rejects execution when caller attempts to forge windowsPipeVerified or osProcessIdentityVerified
    const runner = new ProjectContainerExecutionRunner({
      runtimeDetector: () => ({ daemonAvailable: true }),
      dockerCli: async () => ({ status: 0, stdout: '', stderr: '' }),
    });

    for (const forgedFlag of ['windowsPipeVerified', 'osProcessIdentityVerified']) {
      const forgedRun = await runner.executeWithRuntime({
        plan: testPlan,
        ownerWebContentsId: ownerId,
        sessionId: crypto.randomUUID(),
        runtime: {
          providerId: 'docker',
          runtimeType: 'container',
          supportedOps: ['test'],
          isolationVerified: true,
          [forgedFlag]: true,
        },
      });
      assert.equal(forgedRun.ok, false);
      assert.equal(forgedRun.gate, 'PROCESS_ISOLATION_GATE');
      assert.match(forgedRun.reason, /Caller-supplied Boolean isolation flags rejected/i);
    }

    // 24.2: Verifier rejects caller-forged Windows pipe security booleans in evidence
    for (const forgedFlag of ['windowsPipeVerified', 'osProcessIdentityVerified']) {
      const forgedVerifierRes = verifyIsolationCapabilities({
        providerDescriptor: {
          providerId: 'docker',
          supportedPlatforms: ['win32', 'linux', 'darwin'],
          isReady: true,
          capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
        },
        evidence: {
          [forgedFlag]: true,
          provenance: 'host-observed',
          trustClass: 'APP_VERIFIED',
        },
        context: { projectId: 'proj-1' },
      });
      assert.equal(forgedVerifierRes.ready, false);
      assert.equal(forgedVerifierRes.status, PROVIDER_STATUSES.BLOCKED);
      assert.equal(forgedVerifierRes.reasonCode, 'CALLER_FORGED_OBSERVER_IDENTITY');
    }

    // 24.3: Discovery truthfully reports windowsNamedPipeSecurity: NOT_VERIFIED, ipcClientAuthentication: NOT_VERIFIED, osProcessIdentity: NOT_VERIFIED
    const dockerDiscovery = discoverDocker({ commandRunner: () => ({ succeeded: true, exitCode: 0, stdout: 'Docker version 27.0.0', stderr: '' }) });
    assert.equal(dockerDiscovery.windowsNamedPipeSecurity, 'NOT_VERIFIED');
    assert.equal(dockerDiscovery.ipcClientAuthentication, 'NOT_VERIFIED');
    assert.equal(dockerDiscovery.osProcessIdentity, 'NOT_VERIFIED');
    assert.equal(dockerDiscovery.capabilityVerificationStatus, PROVIDER_STATUSES.BLOCKED);

    const containerProvider = new (require('../electron/coding-pipeline/providers/containerProvider.cjs').ContainerProvider)();
    const containerCaps = await containerProvider.discoverCapabilities();
    assert.equal(containerCaps.windowsNamedPipeSecurity, 'NOT_VERIFIED');
    assert.equal(containerCaps.ipcClientAuthentication, 'NOT_VERIFIED');
    assert.equal(containerCaps.osProcessIdentity, 'NOT_VERIFIED');
    assert.equal(containerCaps.capabilityVerificationStatus, PROVIDER_STATUSES.BLOCKED);

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
    };

    // 24.4: In production mode (isSyntheticTest: false), Windows named pipe security fails closed to NOT_IMPLEMENTED
    const prodPipe = validateWindowsNamedPipeSecurity({
      pipePath: validPipePath,
      securityDescriptor: validSecurityDescriptor,
      isSyntheticTest: false,
    });
    assert.equal(prodPipe.valid, false);
    assert.equal(prodPipe.state, WINDOWS_IPC_SECURITY_STATES.NOT_IMPLEMENTED);
    assert.equal(prodPipe.reasonCode, 'WINDOWS_NATIVE_IPC_AUTH_NOT_IMPLEMENTED');

    // 24.5: In production mode (isSyntheticTest: false), OS process peer identity fails closed to NOT_VERIFIED
    const prodPeer = validateWindowsProcessPeerIdentity({
      peerProcessDescriptor: validPeerProcess,
      isSyntheticTest: false,
    });
    assert.equal(prodPeer.valid, false);
    assert.equal(prodPeer.state, WINDOWS_IPC_SECURITY_STATES.NOT_VERIFIED);
    assert.equal(prodPeer.reasonCode, 'OS_PROCESS_IDENTITY_NOT_VERIFIED');
  }

  console.log('All CODING AGENT V7 — Container Runner Security & Integration Audit tests passed successfully!');
}

runContainerRunnerTests().catch((err) => {
  console.error('V7 Security Audit Test Suite failed:', err);
  process.exit(1);
});
