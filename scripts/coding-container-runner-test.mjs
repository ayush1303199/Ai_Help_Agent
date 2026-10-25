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
} = require('../electron/coding-pipeline/projectContainerExecutionRunner.cjs');

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

  console.log('All CODING AGENT V7 — Container Runner Security & Integration Audit tests passed successfully!');
}

runContainerRunnerTests().catch((err) => {
  console.error('V7 Security Audit Test Suite failed:', err);
  process.exit(1);
});
