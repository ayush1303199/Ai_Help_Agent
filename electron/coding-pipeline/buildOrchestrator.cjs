'use strict';

/**
 * Modular Build Orchestrator for AI Coding Agent (Milestone V3).
 *
 * Discovers declared build, typecheck, lint, test, and smoke-test scripts
 * across Node.js, PHP, Python, Go, Rust, Java (Gradle/Maven), and Make-based projects.
 *
 * Enforces command safety, strictly rejects shell metacharacters and string chaining,
 * connects to V2 dependency prerequisites, validates authorization and process isolation,
 * and captures execution diagnostics with bounded outputs.
 *
 * ZERO hardcoded application packages, endpoints, or invented commands.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyProjectAuthorization } = require('./projectDiscovery.cjs');
const { requireProjectProcessIsolation } = require('./projectProcessIsolation.cjs');
const { discoverDependencies } = require('./dependencyManager.cjs');

const BUILD_OPERATIONS = Object.freeze({
  BUILD: 'BUILD',
  TYPECHECK: 'TYPECHECK',
  LINT: 'LINT',
  TEST: 'TEST',
  SMOKE_TEST: 'SMOKE_TEST',
  START: 'START',
});

const BUILD_OUTCOMES = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  UNSUPPORTED: 'UNSUPPORTED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
});

const UNSAFE_SHELL_CHARS_REGEX = /[;&|`$><\r\n]/;

/**
 * Validates that a binary and arguments array are structurally safe from shell injection.
 * @param {string} binary
 * @param {string[]} args
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCommandSafety(binary, args = []) {
  if (typeof binary !== 'string' || !binary.trim()) {
    return { valid: false, error: 'Command binary must be a non-empty string.' };
  }
  if (UNSAFE_SHELL_CHARS_REGEX.test(binary)) {
    return { valid: false, error: `Command binary contains disallowed shell metacharacters: "${binary}"` };
  }
  if (!Array.isArray(args)) {
    return { valid: false, error: 'Command arguments must be an array of strings, not a shell string.' };
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      return { valid: false, error: `Command argument at index ${i} is not a string.` };
    }
    if (UNSAFE_SHELL_CHARS_REGEX.test(arg)) {
      return { valid: false, error: `Command argument at index ${i} contains disallowed shell metacharacters: "${arg}"` };
    }
  }
  return { valid: true };
}

/**
 * Helper to check if a file exists on disk.
 */
async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Discovers declared build operations for a given project directory.
 * @param {string} projectRoot
 * @returns {Promise<Object>} Catalog of discovered operations and ecosystem details.
 */
async function discoverBuildOperations(projectRoot) {
  const operations = {};
  const detectedManifests = [];
  let detectedEcosystem = null;

  // 1. Node.js
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (await fileExists(packageJsonPath)) {
    detectedManifests.push('package.json');
    detectedEcosystem = 'node';

    // Detect package manager
    let pm = 'npm';
    if (await fileExists(path.join(projectRoot, 'pnpm-lock.yaml'))) {
      pm = 'pnpm';
    } else if (await fileExists(path.join(projectRoot, 'yarn.lock'))) {
      pm = 'yarn';
    } else if (await fileExists(path.join(projectRoot, 'bun.lockb')) || await fileExists(path.join(projectRoot, 'bun.lock'))) {
      pm = 'bun';
    }

    try {
      const rawPkg = await fs.readFile(packageJsonPath, 'utf8');
      const pkg = JSON.parse(rawPkg);
      const scripts = pkg.scripts || {};

      // Helper to find matching script
      const findScript = (candidates) => candidates.find(c => Boolean(scripts[c]));

      // BUILD
      const buildScript = findScript(['build', 'compile', 'bundle', 'prepare']);
      if (buildScript) {
        operations[BUILD_OPERATIONS.BUILD] = {
          operation: BUILD_OPERATIONS.BUILD,
          binary: pm,
          args: pm === 'npm' ? ['run', buildScript] : ['run', buildScript],
          scriptName: buildScript,
          toolchain: `node:${pm}`,
          evidencePath: 'package.json',
        };
      }

      // TYPECHECK
      const typecheckScript = findScript(['typecheck', 'type-check', 'check-types', 'tsc', 'lint:types']);
      if (typecheckScript) {
        operations[BUILD_OPERATIONS.TYPECHECK] = {
          operation: BUILD_OPERATIONS.TYPECHECK,
          binary: pm,
          args: ['run', typecheckScript],
          scriptName: typecheckScript,
          toolchain: `node:${pm}`,
          evidencePath: 'package.json',
        };
      }

      // LINT
      const lintScript = findScript(['lint', 'check', 'eslint', 'biome:check', 'standard']);
      if (lintScript) {
        operations[BUILD_OPERATIONS.LINT] = {
          operation: BUILD_OPERATIONS.LINT,
          binary: pm,
          args: ['run', lintScript],
          scriptName: lintScript,
          toolchain: `node:${pm}`,
          evidencePath: 'package.json',
        };
      }

      // TEST
      const testScript = findScript(['test', 'test:unit', 'test:ci', 'jest', 'vitest', 'mocha']);
      if (testScript) {
        operations[BUILD_OPERATIONS.TEST] = {
          operation: BUILD_OPERATIONS.TEST,
          binary: pm,
          args: pm === 'npm' && testScript === 'test' ? ['test'] : ['run', testScript],
          scriptName: testScript,
          toolchain: `node:${pm}`,
          evidencePath: 'package.json',
        };
      }

      // SMOKE_TEST
      const smokeScript = findScript(['test:smoke', 'smoke', 'smoke-test', 'test:e2e:smoke', 'e2e:smoke']);
      if (smokeScript) {
        operations[BUILD_OPERATIONS.SMOKE_TEST] = {
          operation: BUILD_OPERATIONS.SMOKE_TEST,
          binary: pm,
          args: ['run', smokeScript],
          scriptName: smokeScript,
          toolchain: `node:${pm}`,
          evidencePath: 'package.json',
        };
      }
      // START / APPLICATION_RUNTIME
      const startScript = findScript(['start', 'start:dev', 'serve', 'dev']);
      if (startScript) {
        operations[BUILD_OPERATIONS.START] = {
          operation: BUILD_OPERATIONS.START,
          binary: pm,
          args: pm === 'npm' && startScript === 'start' ? ['start'] : ['run', startScript],
          scriptName: startScript,
          toolchain: `node:${pm}`,
          evidencePath: 'package.json',
        };
      }
    } catch {
      // JSON parse error or unreadable
    }
  }

  // 2. PHP (Composer)
  const composerPath = path.join(projectRoot, 'composer.json');
  if (await fileExists(composerPath)) {
    detectedManifests.push('composer.json');
    if (!detectedEcosystem) detectedEcosystem = 'php';

    try {
      const rawComposer = await fs.readFile(composerPath, 'utf8');
      const composerData = JSON.parse(rawComposer);
      const scripts = composerData.scripts || {};

      const findScript = (candidates) => candidates.find(c => Boolean(scripts[c]));

      const buildScript = findScript(['build', 'compile']);
      if (buildScript && !operations[BUILD_OPERATIONS.BUILD]) {
        operations[BUILD_OPERATIONS.BUILD] = {
          operation: BUILD_OPERATIONS.BUILD,
          binary: 'composer',
          args: ['run-script', buildScript],
          scriptName: buildScript,
          toolchain: 'php:composer',
          evidencePath: 'composer.json',
        };
      }

      const testScript = findScript(['test', 'phpunit', 'pest']);
      if (testScript && !operations[BUILD_OPERATIONS.TEST]) {
        operations[BUILD_OPERATIONS.TEST] = {
          operation: BUILD_OPERATIONS.TEST,
          binary: 'composer',
          args: ['run-script', testScript],
          scriptName: testScript,
          toolchain: 'php:composer',
          evidencePath: 'composer.json',
        };
      }

      const lintScript = findScript(['lint', 'phpcs', 'phpstan', 'psalm', 'check']);
      if (lintScript && !operations[BUILD_OPERATIONS.LINT]) {
        operations[BUILD_OPERATIONS.LINT] = {
          operation: BUILD_OPERATIONS.LINT,
          binary: 'composer',
          args: ['run-script', lintScript],
          scriptName: lintScript,
          toolchain: 'php:composer',
          evidencePath: 'composer.json',
        };
      }
    } catch {
      // ignore
    }
  }

  // 3. Rust (Cargo)
  const cargoPath = path.join(projectRoot, 'Cargo.toml');
  if (await fileExists(cargoPath)) {
    detectedManifests.push('Cargo.toml');
    if (!detectedEcosystem) detectedEcosystem = 'rust';

    if (!operations[BUILD_OPERATIONS.BUILD]) {
      operations[BUILD_OPERATIONS.BUILD] = {
        operation: BUILD_OPERATIONS.BUILD,
        binary: 'cargo',
        args: ['build'],
        toolchain: 'rust:cargo',
        evidencePath: 'Cargo.toml',
      };
    }
    if (!operations[BUILD_OPERATIONS.TYPECHECK]) {
      operations[BUILD_OPERATIONS.TYPECHECK] = {
        operation: BUILD_OPERATIONS.TYPECHECK,
        binary: 'cargo',
        args: ['check'],
        toolchain: 'rust:cargo',
        evidencePath: 'Cargo.toml',
      };
    }
    if (!operations[BUILD_OPERATIONS.LINT]) {
      operations[BUILD_OPERATIONS.LINT] = {
        operation: BUILD_OPERATIONS.LINT,
        binary: 'cargo',
        args: ['clippy'],
        toolchain: 'rust:cargo',
        evidencePath: 'Cargo.toml',
      };
    }
    if (!operations[BUILD_OPERATIONS.TEST]) {
      operations[BUILD_OPERATIONS.TEST] = {
        operation: BUILD_OPERATIONS.TEST,
        binary: 'cargo',
        args: ['test'],
        toolchain: 'rust:cargo',
        evidencePath: 'Cargo.toml',
      };
    }
    if (!operations[BUILD_OPERATIONS.START]) {
      operations[BUILD_OPERATIONS.START] = {
        operation: BUILD_OPERATIONS.START,
        binary: 'cargo',
        args: ['run'],
        toolchain: 'rust:cargo',
        evidencePath: 'Cargo.toml',
      };
    }
  }

  // 4. Go (go.mod)
  const goModPath = path.join(projectRoot, 'go.mod');
  if (await fileExists(goModPath)) {
    detectedManifests.push('go.mod');
    if (!detectedEcosystem) detectedEcosystem = 'go';

    if (!operations[BUILD_OPERATIONS.BUILD]) {
      operations[BUILD_OPERATIONS.BUILD] = {
        operation: BUILD_OPERATIONS.BUILD,
        binary: 'go',
        args: ['build', './...'],
        toolchain: 'go:go',
        evidencePath: 'go.mod',
      };
    }
    if (!operations[BUILD_OPERATIONS.START]) {
      operations[BUILD_OPERATIONS.START] = {
        operation: BUILD_OPERATIONS.START,
        binary: 'go',
        args: ['run', '.'],
        toolchain: 'go:go',
        evidencePath: 'go.mod',
      };
    }
    if (!operations[BUILD_OPERATIONS.TEST]) {
      operations[BUILD_OPERATIONS.TEST] = {
        operation: BUILD_OPERATIONS.TEST,
        binary: 'go',
        args: ['test', './...'],
        toolchain: 'go:go',
        evidencePath: 'go.mod',
      };
    }
    if (!operations[BUILD_OPERATIONS.TYPECHECK]) {
      operations[BUILD_OPERATIONS.TYPECHECK] = {
        operation: BUILD_OPERATIONS.TYPECHECK,
        binary: 'go',
        args: ['vet', './...'],
        toolchain: 'go:go',
        evidencePath: 'go.mod',
      };
    }
  }

  // 5. Python (pyproject.toml, setup.py, requirements.txt, pytest)
  const pyprojectPath = path.join(projectRoot, 'pyproject.toml');
  const setupPyPath = path.join(projectRoot, 'setup.py');
  const reqsPath = path.join(projectRoot, 'requirements.txt');
  const hasPyproject = await fileExists(pyprojectPath);
  const hasSetupPy = await fileExists(setupPyPath);
  const hasReqs = await fileExists(reqsPath);

  if (hasPyproject || hasSetupPy || hasReqs) {
    if (hasPyproject) detectedManifests.push('pyproject.toml');
    if (hasSetupPy) detectedManifests.push('setup.py');
    if (hasReqs) detectedManifests.push('requirements.txt');
    if (!detectedEcosystem) detectedEcosystem = 'python';

    let isPoetry = false;
    let isPipenv = false;
    if (await fileExists(path.join(projectRoot, 'poetry.lock'))) isPoetry = true;
    if (await fileExists(path.join(projectRoot, 'Pipfile'))) isPipenv = true;

    // Check pyproject content for tools
    let pyprojectText = '';
    if (hasPyproject) {
      try {
        pyprojectText = await fs.readFile(pyprojectPath, 'utf8');
      } catch {
        // ignore
      }
    }

    const hasPytestConfig = pyprojectText.includes('[tool.pytest') || await fileExists(path.join(projectRoot, 'pytest.ini'));
    const hasMypyConfig = pyprojectText.includes('[tool.mypy]') || await fileExists(path.join(projectRoot, 'mypy.ini'));
    const hasRuffConfig = pyprojectText.includes('[tool.ruff');

    const prefix = isPoetry ? ['poetry', 'run'] : (isPipenv ? ['pipenv', 'run'] : ['python', '-m']);
    const mainBin = prefix[0];
    const baseArgs = prefix.slice(1);

    if (hasSetupPy && !operations[BUILD_OPERATIONS.BUILD]) {
      operations[BUILD_OPERATIONS.BUILD] = {
        operation: BUILD_OPERATIONS.BUILD,
        binary: 'python',
        args: ['setup.py', 'build'],
        toolchain: 'python',
        evidencePath: 'setup.py',
      };
    } else if (hasPyproject && pyprojectText.includes('[build-system]') && !operations[BUILD_OPERATIONS.BUILD]) {
      operations[BUILD_OPERATIONS.BUILD] = {
        operation: BUILD_OPERATIONS.BUILD,
        binary: mainBin,
        args: [...baseArgs, 'build'],
        toolchain: 'python',
        evidencePath: 'pyproject.toml',
      };
    }

    if ((hasPytestConfig || await fileExists(path.join(projectRoot, 'tests'))) && !operations[BUILD_OPERATIONS.TEST]) {
      operations[BUILD_OPERATIONS.TEST] = {
        operation: BUILD_OPERATIONS.TEST,
        binary: mainBin,
        args: [...baseArgs, 'pytest'],
        toolchain: isPoetry ? 'python:poetry' : 'python',
        evidencePath: hasPyproject ? 'pyproject.toml' : 'requirements.txt',
      };
    }

    if (hasMypyConfig && !operations[BUILD_OPERATIONS.TYPECHECK]) {
      operations[BUILD_OPERATIONS.TYPECHECK] = {
        operation: BUILD_OPERATIONS.TYPECHECK,
        binary: mainBin,
        args: [...baseArgs, 'mypy', '.'],
        toolchain: 'python',
        evidencePath: hasPyproject ? 'pyproject.toml' : 'mypy.ini',
      };
    }

    if (hasRuffConfig && !operations[BUILD_OPERATIONS.LINT]) {
      operations[BUILD_OPERATIONS.LINT] = {
        operation: BUILD_OPERATIONS.LINT,
        binary: mainBin,
        args: [...baseArgs, 'ruff', 'check', '.'],
        toolchain: 'python',
        evidencePath: 'pyproject.toml',
      };
    }
  }

  // 6. Java (Gradle)
  const gradlePath = path.join(projectRoot, 'build.gradle');
  const gradleKtsPath = path.join(projectRoot, 'build.gradle.kts');
  const hasGradle = await fileExists(gradlePath) || await fileExists(gradleKtsPath);

  if (hasGradle) {
    detectedManifests.push(await fileExists(gradlePath) ? 'build.gradle' : 'build.gradle.kts');
    if (!detectedEcosystem) detectedEcosystem = 'java_gradle';

    // Wrapper tool preference
    let gradleBin = 'gradle';
    const isWindows = process.platform === 'win32';
    const gradlewWrapper = isWindows ? 'gradlew.bat' : './gradlew';
    if (await fileExists(path.join(projectRoot, isWindows ? 'gradlew.bat' : 'gradlew'))) {
      gradleBin = gradlewWrapper;
    }

    if (!operations[BUILD_OPERATIONS.BUILD]) {
      operations[BUILD_OPERATIONS.BUILD] = {
        operation: BUILD_OPERATIONS.BUILD,
        binary: gradleBin,
        args: ['build'],
        toolchain: gradleBin.includes('gradlew') ? 'java:gradle-wrapper' : 'java:gradle',
        evidencePath: detectedManifests[detectedManifests.length - 1],
      };
    }
    if (!operations[BUILD_OPERATIONS.TYPECHECK]) {
      operations[BUILD_OPERATIONS.TYPECHECK] = {
        operation: BUILD_OPERATIONS.TYPECHECK,
        binary: gradleBin,
        args: ['compileJava'],
        toolchain: gradleBin.includes('gradlew') ? 'java:gradle-wrapper' : 'java:gradle',
        evidencePath: detectedManifests[detectedManifests.length - 1],
      };
    }
    if (!operations[BUILD_OPERATIONS.TEST]) {
      operations[BUILD_OPERATIONS.TEST] = {
        operation: BUILD_OPERATIONS.TEST,
        binary: gradleBin,
        args: ['test'],
        toolchain: gradleBin.includes('gradlew') ? 'java:gradle-wrapper' : 'java:gradle',
        evidencePath: detectedManifests[detectedManifests.length - 1],
      };
    }
    if (!operations[BUILD_OPERATIONS.LINT]) {
      operations[BUILD_OPERATIONS.LINT] = {
        operation: BUILD_OPERATIONS.LINT,
        binary: gradleBin,
        args: ['check'],
        toolchain: gradleBin.includes('gradlew') ? 'java:gradle-wrapper' : 'java:gradle',
        evidencePath: detectedManifests[detectedManifests.length - 1],
      };
    }
  }

  // 7. Java (Maven)
  const pomPath = path.join(projectRoot, 'pom.xml');
  if (await fileExists(pomPath)) {
    detectedManifests.push('pom.xml');
    if (!detectedEcosystem) detectedEcosystem = 'java_maven';

    // Wrapper tool preference
    let mvnBin = 'mvn';
    const isWindows = process.platform === 'win32';
    const mvnwWrapper = isWindows ? 'mvnw.cmd' : './mvnw';
    if (await fileExists(path.join(projectRoot, isWindows ? 'mvnw.cmd' : 'mvnw'))) {
      mvnBin = mvnwWrapper;
    }

    if (!operations[BUILD_OPERATIONS.BUILD]) {
      operations[BUILD_OPERATIONS.BUILD] = {
        operation: BUILD_OPERATIONS.BUILD,
        binary: mvnBin,
        args: ['compile'],
        toolchain: mvnBin.includes('mvnw') ? 'java:maven-wrapper' : 'java:maven',
        evidencePath: 'pom.xml',
      };
    }
    if (!operations[BUILD_OPERATIONS.TYPECHECK]) {
      operations[BUILD_OPERATIONS.TYPECHECK] = {
        operation: BUILD_OPERATIONS.TYPECHECK,
        binary: mvnBin,
        args: ['compile'],
        toolchain: mvnBin.includes('mvnw') ? 'java:maven-wrapper' : 'java:maven',
        evidencePath: 'pom.xml',
      };
    }
    if (!operations[BUILD_OPERATIONS.TEST]) {
      operations[BUILD_OPERATIONS.TEST] = {
        operation: BUILD_OPERATIONS.TEST,
        binary: mvnBin,
        args: ['test'],
        toolchain: mvnBin.includes('mvnw') ? 'java:maven-wrapper' : 'java:maven',
        evidencePath: 'pom.xml',
      };
    }
  }

  // 8. Make
  const makefilePath = path.join(projectRoot, 'Makefile');
  const makefileLowerPath = path.join(projectRoot, 'makefile');
  const gnuMakePath = path.join(projectRoot, 'GNUMakefile');
  const actualMakePath = (await fileExists(makefilePath) && makefilePath)
    || (await fileExists(makefileLowerPath) && makefileLowerPath)
    || (await fileExists(gnuMakePath) && gnuMakePath);

  if (actualMakePath) {
    const makeBasename = path.basename(actualMakePath);
    detectedManifests.push(makeBasename);
    if (!detectedEcosystem) detectedEcosystem = 'make';

    try {
      const makeContent = await fs.readFile(actualMakePath, 'utf8');
      const targetMatches = [...makeContent.matchAll(/^([a-zA-Z0-9_-]+)\s*:/gm)].map(m => m[1]);

      if ((targetMatches.includes('build') || targetMatches.includes('all')) && !operations[BUILD_OPERATIONS.BUILD]) {
        operations[BUILD_OPERATIONS.BUILD] = {
          operation: BUILD_OPERATIONS.BUILD,
          binary: 'make',
          args: [targetMatches.includes('build') ? 'build' : 'all'],
          toolchain: 'make',
          evidencePath: makeBasename,
        };
      }
      if ((targetMatches.includes('test') || targetMatches.includes('check')) && !operations[BUILD_OPERATIONS.TEST]) {
        operations[BUILD_OPERATIONS.TEST] = {
          operation: BUILD_OPERATIONS.TEST,
          binary: 'make',
          args: [targetMatches.includes('test') ? 'test' : 'check'],
          toolchain: 'make',
          evidencePath: makeBasename,
        };
      }
      if (targetMatches.includes('lint') && !operations[BUILD_OPERATIONS.LINT]) {
        operations[BUILD_OPERATIONS.LINT] = {
          operation: BUILD_OPERATIONS.LINT,
          binary: 'make',
          args: ['lint'],
          toolchain: 'make',
          evidencePath: makeBasename,
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    ecosystem: detectedEcosystem,
    detectedManifests,
    availableOperations: operations,
  };
}

/**
 * Checks build prerequisites using V2 dependency discovery evidence.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {Object} [options.dependencyReport]
 * @returns {Promise<Object>}
 */
async function checkBuildPrerequisites({ projectRoot, dependencyReport = null } = {}) {
  const report = dependencyReport || await discoverDependencies(projectRoot);

  if (report.needsInstallation) {
    const missing = report.missingDependencies
      || (report.findings || []).filter(f => f.status === 'MISSING' || f.status === 'VERSION_MISMATCH')
      || (report.reports || []).flatMap(r => r.missingDependencies || []);
    const ecosystemName = report.ecosystem || report.reports?.[0]?.ecosystem || 'unknown';
    return {
      prerequisitesSatisfied: false,
      missingDependencies: missing,
      reason: `Project has unresolved or missing dependencies in ecosystem "${ecosystemName}". Dependencies must be installed and verified before build execution.`,
      dependencyReport: report,
    };
  }

  return {
    prerequisitesSatisfied: true,
    missingDependencies: [],
    dependencyReport: report,
  };
}

/**
 * Creates an immutable, structured build execution plan.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string} options.operation - One of BUILD_OPERATIONS
 * @param {Object} [options.discoveryResult]
 * @param {Object} [options.dependencyReport]
 * @param {string[]} [options.customArgs]
 * @returns {Promise<Object>} Structured build plan or error outcome.
 */
async function createBuildPlan({
  projectRoot,
  operation = BUILD_OPERATIONS.BUILD,
  discoveryResult = null,
  dependencyReport = null,
  customArgs = null,
} = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('projectRoot is required.');
  }

  const validOp = Object.values(BUILD_OPERATIONS).includes(operation);
  if (!validOp) {
    throw new Error(`Invalid build operation: "${operation}". Expected one of: ${Object.values(BUILD_OPERATIONS).join(', ')}`);
  }

  // 1. Discover operations if not provided
  const discovery = discoveryResult || await discoverBuildOperations(projectRoot);

  if (!discovery.ecosystem && discovery.detectedManifests.length === 0) {
    return {
      status: BUILD_OUTCOMES.UNSUPPORTED,
      configured: false,
      operation,
      projectRoot,
      reason: `No supported project manifests or toolchains detected in "${projectRoot}".`,
    };
  }

  const configuredOp = discovery.availableOperations[operation];
  if (!configuredOp) {
    return {
      status: BUILD_OUTCOMES.NOT_CONFIGURED,
      configured: false,
      operation,
      projectRoot,
      ecosystem: discovery.ecosystem,
      detectedManifests: discovery.detectedManifests,
      reason: `Operation "${operation}" is not declared or configured in project manifest(s) (${discovery.detectedManifests.join(', ') || 'none'}).`,
    };
  }

  // 2. Validate safety of binary and arguments
  const args = customArgs || configuredOp.args || [];
  const safety = validateCommandSafety(configuredOp.binary, args);
  if (!safety.valid) {
    throw new Error(`Command safety check failed: ${safety.error}`);
  }

  // 3. Connect V2 Dependency Prerequisites
  const prerequisites = await checkBuildPrerequisites({ projectRoot, dependencyReport });

  // 4. Calculate deterministic SHA-256 plan digest
  const digestPayload = JSON.stringify({
    projectRoot: path.resolve(projectRoot),
    operation,
    binary: configuredOp.binary,
    args,
    toolchain: configuredOp.toolchain,
    prerequisitesSatisfied: prerequisites.prerequisitesSatisfied,
  });
  const planDigest = crypto.createHash('sha256').update(digestPayload).digest('hex');

  return {
    planId: crypto.randomUUID(),
    status: prerequisites.prerequisitesSatisfied ? 'READY' : 'PREREQUISITES_MISSING',
    configured: true,
    projectRoot: path.resolve(projectRoot),
    operation,
    toolchain: configuredOp.toolchain,
    binary: configuredOp.binary,
    args,
    fullCommandString: `${configuredOp.binary} ${args.join(' ')}`.trim(),
    planDigest,
    evidencePath: configuredOp.evidencePath,
    scriptName: configuredOp.scriptName,
    prerequisites: {
      satisfied: prerequisites.prerequisitesSatisfied,
      missingDependencies: prerequisites.missingDependencies,
      reason: prerequisites.reason || null,
    },
    timeoutMs: 60000,
    maxOutputBytes: 1024 * 1024,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Executes a verified build plan within safe boundaries.
 * Fails closed if Windows process isolation is unverified or prerequisites are missing.
 *
 * @param {Object} options
 * @param {Object} options.plan
 * @param {number} options.ownerWebContentsId
 * @param {string} options.sessionId
 * @param {Function} [options.runner] - Optional runner adapter for verified environments/tests.
 * @returns {Promise<Object>}
 */
async function executeBuildPlan({
  plan,
  ownerWebContentsId,
  sessionId,
  runner = null,
  containerRunner = null,
} = {}) {
  if (!plan || !ownerWebContentsId || !sessionId) {
    throw new Error('plan, ownerWebContentsId, and sessionId are required.');
  }

  // 1. Revalidate project authorization
  const auth = await verifyProjectAuthorization(plan.projectRoot, ownerWebContentsId);
  if (!auth.isAuthorized) {
    return {
      ok: false,
      status: BUILD_OUTCOMES.BLOCKED,
      executionBlocked: true,
      error: `Project authorization failed: ${auth.reason}`,
      planDigest: plan.planDigest,
      operation: plan.operation,
    };
  }

  // 2. Validate command safety
  const safety = validateCommandSafety(plan.binary, plan.args);
  if (!safety.valid) {
    return {
      ok: false,
      status: BUILD_OUTCOMES.BLOCKED,
      executionBlocked: true,
      error: `Command safety violation: ${safety.error}`,
      planDigest: plan.planDigest,
      operation: plan.operation,
    };
  }

  // 3. Enforce V2 Dependency Prerequisites
  if (plan.prerequisites && !plan.prerequisites.satisfied) {
    return {
      ok: false,
      status: BUILD_OUTCOMES.BLOCKED,
      executionBlocked: true,
      gate: 'DEPENDENCY_PREREQUISITE_GATE',
      reason: plan.prerequisites.reason || 'Build execution blocked: missing dependencies must be installed and verified first.',
      missingDependencies: plan.prerequisites.missingDependencies,
      planDigest: plan.planDigest,
      operation: plan.operation,
    };
  }

  // 4. If containerRunner is provided, execute inside verified container boundary
  if (containerRunner && typeof containerRunner.execute === 'function') {
    const runResult = await containerRunner.execute({
      plan,
      ownerWebContentsId,
      sessionId,
      isApplicationRuntime: plan.operation === BUILD_OPERATIONS.START,
      probeEndpoints: plan.probeEndpoints || ['/'],
    });
    if (!runResult.ok && runResult.executionBlocked) {
      return {
        ...runResult,
        outcome: BUILD_OUTCOMES.BLOCKED,
        reason: runResult.reason && runResult.reason.includes('verified Windows process isolation is required')
          ? runResult.reason
          : `Build execution is blocked: verified Windows process isolation is required before executing project build/test binaries (${runResult.reason || 'unverified container isolation'}).`,
        artifacts: [],
        verificationEvidence: null,
      };
    }
    return runResult;
  }

  // 5. Enforce verified operating-system process isolation boundary
  try {
    requireProjectProcessIsolation(`Build operation ${plan.operation} (${plan.fullCommandString})`);
  } catch (gateErr) {
    return {
      ok: false,
      status: BUILD_OUTCOMES.BLOCKED,
      executionBlocked: true,
      gate: 'PROCESS_ISOLATION_GATE',
      error: gateErr.message,
      planDigest: plan.planDigest,
      operation: plan.operation,
      command: plan.fullCommandString,
      reason: 'Build execution is blocked: verified Windows process isolation is required before executing project build/test binaries.',
    };
  }

  // 5. If runner is provided in verified host sandbox
  if (typeof runner === 'function') {
    const startTime = Date.now();
    try {
      const result = await runner({
        binary: plan.binary,
        args: plan.args,
        projectRoot: plan.projectRoot,
        timeoutMs: plan.timeoutMs,
        maxOutputBytes: plan.maxOutputBytes,
      });

      const elapsedMs = Date.now() - startTime;
      const stdout = typeof result.stdout === 'string' ? result.stdout.slice(0, plan.maxOutputBytes) : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr.slice(0, plan.maxOutputBytes) : '';
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1;

      return {
        ok: exitCode === 0,
        status: exitCode === 0 ? BUILD_OUTCOMES.PASSED : BUILD_OUTCOMES.FAILED,
        exitCode,
        stdout,
        stderr,
        elapsedMs,
        operation: plan.operation,
        planDigest: plan.planDigest,
        diagnostics: result.diagnostics || [],
      };
    } catch (runErr) {
      return {
        ok: false,
        status: BUILD_OUTCOMES.FAILED,
        exitCode: -1,
        stderr: runErr.message,
        operation: plan.operation,
        planDigest: plan.planDigest,
        diagnostics: [{ level: 'error', message: runErr.message }],
      };
    }
  }

  // Default fail-closed when sandbox adapter not verified
  return {
    ok: false,
    status: BUILD_OUTCOMES.BLOCKED,
    executionBlocked: true,
    error: 'Execution environment was not verified by host sandbox runner.',
    planDigest: plan.planDigest,
    operation: plan.operation,
  };
}

module.exports = {
  BUILD_OPERATIONS,
  BUILD_OUTCOMES,
  validateCommandSafety,
  discoverBuildOperations,
  checkBuildPrerequisites,
  createBuildPlan,
  executeBuildPlan,
};
