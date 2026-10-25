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
  validateCommandSafety,
  discoverBuildOperations,
  checkBuildPrerequisites,
  createBuildPlan,
  executeBuildPlan,
  executeAutonomousCodingWorkflow,
  INTENT_CATEGORIES,
} = require('../electron/developerAgent.cjs');

const developerFiles = require('../electron/developerFiles.cjs');

async function makeTempDir(prefix = 'build-orchestrator-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runTests() {
  console.log('Starting Generic Build Orchestration & V2 Integration regression tests...');

  // -------------------------------------------------------------------------
  // Test 1: Command safety validation
  // -------------------------------------------------------------------------
  console.log('Testing command safety and shell injection prevention...');
  {
    assert.equal(validateCommandSafety('npm', ['run', 'build']).valid, true);
    assert.equal(validateCommandSafety('cargo', ['test']).valid, true);

    // Shell metacharacters rejection
    assert.equal(validateCommandSafety('npm; rm -rf /', ['run']).valid, false);
    assert.equal(validateCommandSafety('npm', ['run', 'build && echo hacked']).valid, false);
    assert.equal(validateCommandSafety('npm', ['run', 'build | cat']).valid, false);
    assert.equal(validateCommandSafety('npm', ['run', '`calc`']).valid, false);
    assert.equal(validateCommandSafety('npm', ['run', '$HOME']).valid, false);
    assert.equal(validateCommandSafety('npm', ['run', 'build > out.txt']).valid, false);
    assert.equal(validateCommandSafety('', ['run']).valid, false);
    assert.equal(validateCommandSafety('npm', 'run build').valid, false, 'String args should be rejected');
  }

  // -------------------------------------------------------------------------
  // Test 2: Node.js discovery & package managers
  // -------------------------------------------------------------------------
  console.log('Testing Node.js build and script discovery...');
  {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'node-app',
      scripts: {
        build: 'vite build',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'vitest run',
        'test:smoke': 'vitest run smoke',
      },
    }, null, 2));

    const discovery = await discoverBuildOperations(dir);
    assert.equal(discovery.ecosystem, 'node');
    assert.equal(discovery.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'npm');
    assert.deepEqual(discovery.availableOperations[BUILD_OPERATIONS.BUILD].args, ['run', 'build']);
    assert.deepEqual(discovery.availableOperations[BUILD_OPERATIONS.TYPECHECK].args, ['run', 'typecheck']);
    assert.deepEqual(discovery.availableOperations[BUILD_OPERATIONS.LINT].args, ['run', 'lint']);
    assert.deepEqual(discovery.availableOperations[BUILD_OPERATIONS.TEST].args, ['test']);
    assert.deepEqual(discovery.availableOperations[BUILD_OPERATIONS.SMOKE_TEST].args, ['run', 'test:smoke']);

    // Test pnpm lock detection
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4');
    const pnpmDiscovery = await discoverBuildOperations(dir);
    assert.equal(pnpmDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'pnpm');

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 3: Wrapper preference for Java (Gradle and Maven)
  // -------------------------------------------------------------------------
  console.log('Testing Java Gradle and Maven wrapper tool preference...');
  {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'build.gradle'), 'apply plugin: "java"');

    // Without wrapper: defaults to gradle
    const gradleFallback = await discoverBuildOperations(dir);
    assert.equal(gradleFallback.ecosystem, 'java_gradle');
    assert.equal(gradleFallback.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'gradle');

    // With gradlew wrapper: uses wrapper
    const isWindows = process.platform === 'win32';
    const wrapperName = isWindows ? 'gradlew.bat' : 'gradlew';
    await fs.writeFile(path.join(dir, wrapperName), '#!/bin/sh\n');
    const gradleWrapper = await discoverBuildOperations(dir);
    assert.ok(gradleWrapper.availableOperations[BUILD_OPERATIONS.BUILD].binary.includes('gradlew'));

    await fs.rm(dir, { recursive: true, force: true });

    // Maven wrapper
    const mvnDir = await makeTempDir();
    await fs.writeFile(path.join(mvnDir, 'pom.xml'), '<project></project>');
    const mvnFallback = await discoverBuildOperations(mvnDir);
    assert.equal(mvnFallback.ecosystem, 'java_maven');
    assert.equal(mvnFallback.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'mvn');

    const mvnWrapperName = isWindows ? 'mvnw.cmd' : 'mvnw';
    await fs.writeFile(path.join(mvnDir, mvnWrapperName), '#!/bin/sh\n');
    const mvnWrapper = await discoverBuildOperations(mvnDir);
    assert.ok(mvnWrapper.availableOperations[BUILD_OPERATIONS.BUILD].binary.includes('mvnw'));

    await fs.rm(mvnDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 4: Rust, Go, Python, PHP, Make ecosystems
  // -------------------------------------------------------------------------
  console.log('Testing Rust, Go, Python, PHP, and Make build discovery...');
  {
    // Rust
    const rustDir = await makeTempDir();
    await fs.writeFile(path.join(rustDir, 'Cargo.toml'), '[package]\nname = "test-crate"');
    const rustDiscovery = await discoverBuildOperations(rustDir);
    assert.equal(rustDiscovery.ecosystem, 'rust');
    assert.equal(rustDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'cargo');
    assert.deepEqual(rustDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].args, ['build']);
    assert.deepEqual(rustDiscovery.availableOperations[BUILD_OPERATIONS.TYPECHECK].args, ['check']);
    assert.deepEqual(rustDiscovery.availableOperations[BUILD_OPERATIONS.TEST].args, ['test']);
    assert.deepEqual(rustDiscovery.availableOperations[BUILD_OPERATIONS.LINT].args, ['clippy']);
    await fs.rm(rustDir, { recursive: true, force: true });

    // Go
    const goDir = await makeTempDir();
    await fs.writeFile(path.join(goDir, 'go.mod'), 'module example.com/app\ngo 1.20');
    const goDiscovery = await discoverBuildOperations(goDir);
    assert.equal(goDiscovery.ecosystem, 'go');
    assert.equal(goDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'go');
    assert.deepEqual(goDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].args, ['build', './...']);
    assert.deepEqual(goDiscovery.availableOperations[BUILD_OPERATIONS.TEST].args, ['test', './...']);
    await fs.rm(goDir, { recursive: true, force: true });

    // Python
    const pyDir = await makeTempDir();
    await fs.writeFile(path.join(pyDir, 'pyproject.toml'), '[tool.pytest.ini_options]\n[tool.mypy]\n[tool.ruff]');
    const pyDiscovery = await discoverBuildOperations(pyDir);
    assert.equal(pyDiscovery.ecosystem, 'python');
    assert.ok(pyDiscovery.availableOperations[BUILD_OPERATIONS.TEST]);
    assert.ok(pyDiscovery.availableOperations[BUILD_OPERATIONS.TYPECHECK]);
    assert.ok(pyDiscovery.availableOperations[BUILD_OPERATIONS.LINT]);
    await fs.rm(pyDir, { recursive: true, force: true });

    // PHP Composer
    const phpDir = await makeTempDir();
    await fs.writeFile(path.join(phpDir, 'composer.json'), JSON.stringify({
      scripts: {
        build: 'composer compile',
        test: 'phpunit',
        lint: 'phpstan analyse',
      },
    }));
    const phpDiscovery = await discoverBuildOperations(phpDir);
    assert.equal(phpDiscovery.ecosystem, 'php');
    assert.equal(phpDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'composer');
    await fs.rm(phpDir, { recursive: true, force: true });

    // Makefile
    const makeDir = await makeTempDir();
    await fs.writeFile(path.join(makeDir, 'Makefile'), 'all:\n\techo "all"\nbuild:\n\techo "building"\ntest:\n\techo "testing"');
    const makeDiscovery = await discoverBuildOperations(makeDir);
    assert.equal(makeDiscovery.ecosystem, 'make');
    assert.equal(makeDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].binary, 'make');
    assert.deepEqual(makeDiscovery.availableOperations[BUILD_OPERATIONS.BUILD].args, ['build']);
    assert.deepEqual(makeDiscovery.availableOperations[BUILD_OPERATIONS.TEST].args, ['test']);
    await fs.rm(makeDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 5: NOT_CONFIGURED and UNSUPPORTED handling (no invention)
  // -------------------------------------------------------------------------
  console.log('Testing NOT_CONFIGURED and UNSUPPORTED handling...');
  {
    // Empty directory -> UNSUPPORTED
    const emptyDir = await makeTempDir();
    const unsupportedPlan = await createBuildPlan({ projectRoot: emptyDir, operation: BUILD_OPERATIONS.BUILD });
    assert.equal(unsupportedPlan.status, BUILD_OUTCOMES.UNSUPPORTED);
    assert.equal(unsupportedPlan.configured, false);
    await fs.rm(emptyDir, { recursive: true, force: true });

    // Manifest without requested script -> NOT_CONFIGURED
    const nodeDir = await makeTempDir();
    await fs.writeFile(path.join(nodeDir, 'package.json'), JSON.stringify({
      name: 'no-lint-app',
      scripts: { test: 'vitest' },
    }));
    const notConfiguredPlan = await createBuildPlan({ projectRoot: nodeDir, operation: BUILD_OPERATIONS.LINT });
    assert.equal(notConfiguredPlan.status, BUILD_OUTCOMES.NOT_CONFIGURED);
    assert.equal(notConfiguredPlan.configured, false);
    assert.ok(notConfiguredPlan.reason.includes('not declared or configured'));
    await fs.rm(nodeDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 6: V2 Dependency Prerequisites check integration
  // -------------------------------------------------------------------------
  console.log('Testing build prerequisite integration with V2 dependency discovery...');
  {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'dep-test-app',
      scripts: { build: 'vite build' },
      dependencies: { lodash: '^4.17.21' },
    }));

    // With missing dependencies:
    const prereqResult = await checkBuildPrerequisites({ projectRoot: dir });
    assert.equal(prereqResult.prerequisitesSatisfied, false);
    assert.ok(prereqResult.missingDependencies.length > 0);

    const plan = await createBuildPlan({ projectRoot: dir, operation: BUILD_OPERATIONS.BUILD });
    assert.equal(plan.status, 'PREREQUISITES_MISSING');
    assert.equal(plan.prerequisites.satisfied, false);

    // Attempting execution fails closed at DEPENDENCY_PREREQUISITE_GATE
    const ownerId = 42;
    await developerFiles.attachProject(dir, ownerId);
    const execResult = await executeBuildPlan({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });
    assert.equal(execResult.ok, false);
    assert.equal(execResult.status, BUILD_OUTCOMES.BLOCKED);
    assert.equal(execResult.gate, 'DEPENDENCY_PREREQUISITE_GATE');
    assert.ok(execResult.reason.includes('missing dependencies'));

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 7: Safe execution boundary and process isolation gate
  // -------------------------------------------------------------------------
  console.log('Testing safe execution gate and unverified process isolation block...');
  {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'isolated-app',
      scripts: { build: 'vite build' },
    }));

    const ownerId = 43;
    await developerFiles.attachProject(dir, ownerId);

    const plan = await createBuildPlan({
      projectRoot: dir,
      operation: BUILD_OPERATIONS.BUILD,
      dependencyReport: { needsInstallation: false, findings: [] },
    });
    assert.equal(plan.status, 'READY');
    assert.equal(plan.prerequisites.satisfied, true);
    assert.ok(typeof plan.planDigest === 'string' && plan.planDigest.length === 64);

    // Execute under unverified Windows process isolation -> BLOCKED at PROCESS_ISOLATION_GATE
    const execResult = await executeBuildPlan({
      plan,
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
    });
    assert.equal(execResult.ok, false);
    assert.equal(execResult.status, BUILD_OUTCOMES.BLOCKED);
    assert.equal(execResult.executionBlocked, true);
    assert.equal(execResult.gate, 'PROCESS_ISOLATION_GATE');
    assert.ok(execResult.reason.includes('process isolation is required'));

    await fs.rm(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Test 8: Autonomous coding workflow integration
  // -------------------------------------------------------------------------
  console.log('Testing executeAutonomousCodingWorkflow with build orchestration...');
  {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workflow-app',
      scripts: {
        build: 'vite build',
        test: 'vitest run',
      },
      dependencies: { express: '^4.18.2' },
    }));

    const ownerId = 44;
    const sessionId = crypto.randomUUID();
    await developerFiles.attachProject(dir, ownerId);

    // 8a. Build request on project with missing dependencies
    const resultMissingDeps = await executeAutonomousCodingWorkflow({
      userRequest: 'Please build the project and check for compile errors.',
      ownerWebContentsId: ownerId,
      sessionId,
      root: dir,
    });
    assert.equal(resultMissingDeps.outcome, 'BLOCKED');
    assert.equal(resultMissingDeps.phase, 'DEPENDENCY_PREREQUISITE_GATE');
    assert.ok(resultMissingDeps.missingDependencies.length > 0);
    assert.equal(resultMissingDeps.codeApplied, false);

    // 8b. Build request when dependencies are mocked as satisfied
    // Install the dummy node_modules
    await fs.mkdir(path.join(dir, 'node_modules', 'express'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'express', 'package.json'), JSON.stringify({
      name: 'express',
      version: '4.18.2',
    }));

    const resultIsolated = await executeAutonomousCodingWorkflow({
      userRequest: 'Please run the build.',
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      root: dir,
    });
    assert.equal(resultIsolated.outcome, 'BLOCKED');
    assert.equal(resultIsolated.phase, 'BUILD_EXECUTION_GATE');
    assert.equal(resultIsolated.executionBlocked, true);

    // 8c. Read-only explanation request does NOT trigger build execution
    const resultExplain = await executeAutonomousCodingWorkflow({
      userRequest: 'Explain how the build script is configured in this project.',
      ownerWebContentsId: ownerId,
      sessionId: crypto.randomUUID(),
      root: dir,
    });
    assert.equal(resultExplain.outcome, 'COMPLETED');
    assert.equal(resultExplain.phase, 'EXPLAIN');
    assert.equal(resultExplain.executionBlocked, undefined);

    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log('All Generic Build Orchestration & V2 Integration regression tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
