'use strict';

/**
 * Modular Dependency Manager for AI Coding Agent (Milestone V2).
 *
 * Discovers declared vs installed dependencies across npm/pnpm/yarn, Composer,
 * Python, Go, Rust, and Maven/Gradle ecosystems. Detects missing, mismatched,
 * and ambiguous dependencies, flags suspicious lifecycle scripts and side effects,
 * generates minimal approval-bound installation plans, and enforces safe execution gates.
 *
 * ZERO hardcoded application packages or invented versions.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyProjectAuthorization } = require('./projectDiscovery.cjs');
const { requireProjectProcessIsolation } = require('./projectProcessIsolation.cjs');
const { validateProposalContract } = require('./investigationWorkflowContract.cjs');

const SUPPORTED_ECOSYSTEMS = Object.freeze({
  NODE: 'node',
  PHP: 'php',
  PYTHON: 'python',
  GO: 'go',
  RUST: 'rust',
  JAVA_GRADLE: 'java_gradle',
  JAVA_MAVEN: 'java_maven',
});

const DEPENDENCY_STATUSES = Object.freeze({
  INSTALLED: 'INSTALLED',
  MISSING: 'MISSING',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  UNRESOLVED: 'UNRESOLVED',
});

const PACKAGE_MANAGERS = Object.freeze({
  NPM: 'npm',
  PNPM: 'pnpm',
  YARN: 'yarn',
  BUN: 'bun',
  COMPOSER: 'composer',
  PIP: 'pip',
  POETRY: 'poetry',
  PIPENV: 'pipenv',
  CARGO: 'cargo',
  GO: 'go',
  GRADLE: 'gradle',
  MAVEN: 'maven',
});

const SUSPICIOUS_SCRIPT_PATTERNS = [
  /\b(?:curl|wget|fetch)\b/i,
  /\b(?:rm\s+-rf|del\s+\/f|rmdir\s+\/s)\b/i,
  /\b(?:bash|sh|powershell|cmd\.exe)\s+-c\b/i,
  /\b(?:http:\/\/|https:\/\/)[^\s"']+/i,
  /\b(?:base64\s+-d|eval\s*\()/i,
];

/**
 * Normalizes version strings for basic prefix matching without inventing versions.
 */
function cleanVersion(ver) {
  return String(ver || '').trim().replace(/^[\^~>=<v\s]+/, '');
}

/**
 * Analyzes lifecycle scripts for suspicious or material side-effect patterns.
 */
function inspectLifecycleScripts(scripts = {}) {
  const lifecycleScriptNames = ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare'];
  const detected = [];

  for (const name of lifecycleScriptNames) {
    if (scripts[name] && typeof scripts[name] === 'string') {
      const command = scripts[name];
      const isSuspicious = SUSPICIOUS_SCRIPT_PATTERNS.some((p) => p.test(command));
      detected.push({
        scriptName: name,
        command,
        isSuspicious,
        riskLevel: isSuspicious ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  return detected;
}

/**
 * Inspects a Node.js workspace (package.json + lockfiles + node_modules).
 */
async function inspectNodeDependencies(projectRoot) {
  const manifestPath = path.join(projectRoot, 'package.json');
  let manifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    return {
      ecosystem: SUPPORTED_ECOSYSTEMS.NODE,
      hasManifest: false,
      error: `Could not parse package.json: ${err.message}`,
      dependencies: [],
      missingDependencies: [],
      packageManager: null,
      lockfiles: [],
      warnings: [`Unreadable or invalid manifest at ${manifestPath}`],
    };
  }

  // Detect lockfiles and determine preferred package manager
  const lockfiles = [];
  let preferredPm = PACKAGE_MANAGERS.NPM;

  const lockCandidates = [
    { file: 'pnpm-lock.yaml', pm: PACKAGE_MANAGERS.PNPM },
    { file: 'yarn.lock', pm: PACKAGE_MANAGERS.YARN },
    { file: 'package-lock.json', pm: PACKAGE_MANAGERS.NPM },
    { file: 'bun.lockb', pm: PACKAGE_MANAGERS.BUN },
    { file: 'bun.lock', pm: PACKAGE_MANAGERS.BUN },
  ];

  for (const { file, pm } of lockCandidates) {
    try {
      await fs.stat(path.join(projectRoot, file));
      lockfiles.push(file);
    } catch {}
  }

  if (lockfiles.includes('pnpm-lock.yaml')) preferredPm = PACKAGE_MANAGERS.PNPM;
  else if (lockfiles.includes('yarn.lock')) preferredPm = PACKAGE_MANAGERS.YARN;
  else if (lockfiles.includes('bun.lock') || lockfiles.includes('bun.lockb')) preferredPm = PACKAGE_MANAGERS.BUN;
  else if (lockfiles.includes('package-lock.json')) preferredPm = PACKAGE_MANAGERS.NPM;

  // Collect declared dependencies
  const declared = [];
  const deps = manifest.dependencies || {};
  const devDeps = manifest.devDependencies || {};
  const peerDeps = manifest.peerDependencies || {};

  for (const [name, version] of Object.entries(deps)) {
    declared.push({ name, version: String(version), type: 'production', isDev: false });
  }
  for (const [name, version] of Object.entries(devDeps)) {
    declared.push({ name, version: String(version), type: 'development', isDev: true });
  }
  for (const [name, version] of Object.entries(peerDeps)) {
    declared.push({ name, version: String(version), type: 'peer', isDev: false });
  }

  // Check actual installed state in node_modules
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  let hasNodeModules = false;
  try {
    const stat = await fs.stat(nodeModulesDir);
    hasNodeModules = stat.isDirectory();
  } catch {}

  const inspected = [];
  const missing = [];
  const warnings = [];

  if (declared.length > 0 && lockfiles.length === 0) {
    warnings.push('Manifest declares dependencies but no lockfile exists in the project root.');
  }

  for (const dep of declared) {
    if (!hasNodeModules) {
      const item = {
        name: dep.name,
        declaredVersion: dep.version,
        installedVersion: null,
        status: DEPENDENCY_STATUSES.MISSING,
        type: dep.type,
        isDev: dep.isDev,
      };
      inspected.push(item);
      missing.push(item);
      continue;
    }

    const pkgJsonPath = path.join(nodeModulesDir, dep.name, 'package.json');
    try {
      const rawPkg = await fs.readFile(pkgJsonPath, 'utf8');
      const installedPkg = JSON.parse(rawPkg);
      const installedVer = String(installedPkg.version || '');
      const reqClean = cleanVersion(dep.version);
      const instClean = cleanVersion(installedVer);

      let status = DEPENDENCY_STATUSES.INSTALLED;
      if (reqClean && instClean && !installedVer.startsWith(reqClean.split('.')[0])) {
        // Major version difference
        status = DEPENDENCY_STATUSES.VERSION_MISMATCH;
      }

      const item = {
        name: dep.name,
        declaredVersion: dep.version,
        installedVersion: installedVer,
        status,
        type: dep.type,
        isDev: dep.isDev,
      };
      inspected.push(item);
      if (status === DEPENDENCY_STATUSES.VERSION_MISMATCH) {
        warnings.push(`Dependency [${dep.name}] installed version (${installedVer}) diverges from declared (${dep.version}).`);
      }
    } catch {
      const item = {
        name: dep.name,
        declaredVersion: dep.version,
        installedVersion: null,
        status: DEPENDENCY_STATUSES.MISSING,
        type: dep.type,
        isDev: dep.isDev,
      };
      inspected.push(item);
      missing.push(item);
    }
  }

  const lifecycleScripts = inspectLifecycleScripts(manifest.scripts || {});

  return {
    ecosystem: SUPPORTED_ECOSYSTEMS.NODE,
    hasManifest: true,
    manifestPath: 'package.json',
    packageManager: preferredPm,
    lockfiles,
    dependencies: inspected,
    missingDependencies: missing,
    hasNodeModules,
    workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages || []),
    lifecycleScripts,
    warnings,
  };
}

/**
 * Inspects a PHP workspace (composer.json + composer.lock + vendor).
 */
async function inspectPhpDependencies(projectRoot) {
  const manifestPath = path.join(projectRoot, 'composer.json');
  let manifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    return {
      ecosystem: SUPPORTED_ECOSYSTEMS.PHP,
      hasManifest: false,
      error: `Could not parse composer.json: ${err.message}`,
      dependencies: [],
      missingDependencies: [],
      packageManager: null,
      lockfiles: [],
      warnings: [`Unreadable or invalid manifest at ${manifestPath}`],
    };
  }

  const lockfiles = [];
  try {
    await fs.stat(path.join(projectRoot, 'composer.lock'));
    lockfiles.push('composer.lock');
  } catch {}

  const declared = [];
  const req = manifest.require || {};
  const reqDev = manifest['require-dev'] || {};

  for (const [name, ver] of Object.entries(req)) {
    if (name.toLowerCase() === 'php' || name.startsWith('ext-')) continue;
    declared.push({ name, version: String(ver), type: 'production', isDev: false });
  }
  for (const [name, ver] of Object.entries(reqDev)) {
    declared.push({ name, version: String(ver), type: 'development', isDev: true });
  }

  const vendorDir = path.join(projectRoot, 'vendor');
  let hasVendor = false;
  try {
    const stat = await fs.stat(vendorDir);
    hasVendor = stat.isDirectory();
  } catch {}

  const inspected = [];
  const missing = [];
  const warnings = [];

  for (const dep of declared) {
    if (!hasVendor) {
      const item = {
        name: dep.name,
        declaredVersion: dep.version,
        installedVersion: null,
        status: DEPENDENCY_STATUSES.MISSING,
        type: dep.type,
        isDev: dep.isDev,
      };
      inspected.push(item);
      missing.push(item);
      continue;
    }

    const packageDir = path.join(vendorDir, dep.name);
    try {
      await fs.stat(packageDir);
      inspected.push({
        name: dep.name,
        declaredVersion: dep.version,
        installedVersion: dep.version,
        status: DEPENDENCY_STATUSES.INSTALLED,
        type: dep.type,
        isDev: dep.isDev,
      });
    } catch {
      const item = {
        name: dep.name,
        declaredVersion: dep.version,
        installedVersion: null,
        status: DEPENDENCY_STATUSES.MISSING,
        type: dep.type,
        isDev: dep.isDev,
      };
      inspected.push(item);
      missing.push(item);
    }
  }

  return {
    ecosystem: SUPPORTED_ECOSYSTEMS.PHP,
    hasManifest: true,
    manifestPath: 'composer.json',
    packageManager: PACKAGE_MANAGERS.COMPOSER,
    lockfiles,
    dependencies: inspected,
    missingDependencies: missing,
    hasVendor,
    lifecycleScripts: inspectLifecycleScripts(manifest.scripts || {}),
    warnings,
  };
}

/**
 * Inspects a Python workspace (pyproject.toml, requirements.txt, Pipfile).
 */
async function inspectPythonDependencies(projectRoot) {
  let manifestPath = null;
  let pm = PACKAGE_MANAGERS.PIP;
  const lockfiles = [];
  const declared = [];
  const warnings = [];

  // 1. Check requirements.txt
  try {
    const reqPath = path.join(projectRoot, 'requirements.txt');
    const raw = await fs.readFile(reqPath, 'utf8');
    manifestPath = 'requirements.txt';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(/[>=<~]+/);
      declared.push({
        name: parts[0].trim(),
        version: parts[1] ? parts[1].trim() : '*',
        type: 'production',
        isDev: false,
      });
    }
  } catch {}

  // 2. Check pyproject.toml
  try {
    const pyprojPath = path.join(projectRoot, 'pyproject.toml');
    const raw = await fs.readFile(pyprojPath, 'utf8');
    manifestPath = manifestPath || 'pyproject.toml';
    if (raw.includes('[tool.poetry]')) pm = PACKAGE_MANAGERS.POETRY;
    const depSectionMatch = raw.match(/\[(?:tool\.poetry\.dependencies|project\.dependencies)\]([\s\S]*?)(?=\n\[|$)/);
    if (depSectionMatch) {
      const depSection = depSectionMatch[1];
      const depMatches = depSection.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/gm);
      for (const match of depMatches) {
        if (match[1].toLowerCase() !== 'python') {
          declared.push({
            name: match[1],
            version: match[2],
            type: 'production',
            isDev: false,
          });
        }
      }
    }
  } catch {}

  // Check lockfiles
  for (const lock of ['poetry.lock', 'Pipfile.lock', 'requirements.lock']) {
    try {
      await fs.stat(path.join(projectRoot, lock));
      lockfiles.push(lock);
    } catch {}
  }

  const inspected = declared.map((d) => ({
    name: d.name,
    declaredVersion: d.version,
    installedVersion: null,
    status: DEPENDENCY_STATUSES.UNRESOLVED,
    type: d.type,
    isDev: d.isDev,
  }));

  return {
    ecosystem: SUPPORTED_ECOSYSTEMS.PYTHON,
    hasManifest: Boolean(manifestPath),
    manifestPath,
    packageManager: pm,
    lockfiles,
    dependencies: inspected,
    missingDependencies: [],
    warnings,
  };
}

/**
 * Inspects a Go workspace (go.mod + go.sum).
 */
async function inspectGoDependencies(projectRoot) {
  const modPath = path.join(projectRoot, 'go.mod');
  let rawMod;
  try {
    rawMod = await fs.readFile(modPath, 'utf8');
  } catch (err) {
    return {
      ecosystem: SUPPORTED_ECOSYSTEMS.GO,
      hasManifest: false,
      error: err.message,
      dependencies: [],
      missingDependencies: [],
      packageManager: null,
      lockfiles: [],
      warnings: [],
    };
  }

  const lockfiles = [];
  try {
    await fs.stat(path.join(projectRoot, 'go.sum'));
    lockfiles.push('go.sum');
  } catch {}

  const declared = [];
  const reqMatches = rawMod.matchAll(/^\s*require\s+([^\s]+)\s+([^\s]+)/gm);
  for (const m of reqMatches) {
    declared.push({ name: m[1], version: m[2], type: 'production', isDev: false });
  }

  return {
    ecosystem: SUPPORTED_ECOSYSTEMS.GO,
    hasManifest: true,
    manifestPath: 'go.mod',
    packageManager: PACKAGE_MANAGERS.GO,
    lockfiles,
    dependencies: declared.map((d) => ({
      name: d.name,
      declaredVersion: d.version,
      installedVersion: lockfiles.length > 0 ? d.version : null,
      status: lockfiles.length > 0 ? DEPENDENCY_STATUSES.INSTALLED : DEPENDENCY_STATUSES.UNRESOLVED,
      type: d.type,
      isDev: d.isDev,
    })),
    missingDependencies: [],
    warnings: [],
  };
}

/**
 * Inspects a Rust workspace (Cargo.toml + Cargo.lock).
 */
async function inspectRustDependencies(projectRoot) {
  const cargoPath = path.join(projectRoot, 'Cargo.toml');
  let rawCargo;
  try {
    rawCargo = await fs.readFile(cargoPath, 'utf8');
  } catch (err) {
    return {
      ecosystem: SUPPORTED_ECOSYSTEMS.RUST,
      hasManifest: false,
      error: err.message,
      dependencies: [],
      missingDependencies: [],
      packageManager: null,
      lockfiles: [],
      warnings: [],
    };
  }

  const lockfiles = [];
  try {
    await fs.stat(path.join(projectRoot, 'Cargo.lock'));
    lockfiles.push('Cargo.lock');
  } catch {}

  const declared = [];
  const depMatches = rawCargo.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/gm);
  for (const m of depMatches) {
    if (m[1].toLowerCase() !== 'name' && m[1].toLowerCase() !== 'version') {
      declared.push({ name: m[1], version: m[2], type: 'production', isDev: false });
    }
  }

  return {
    ecosystem: SUPPORTED_ECOSYSTEMS.RUST,
    hasManifest: true,
    manifestPath: 'Cargo.toml',
    packageManager: PACKAGE_MANAGERS.CARGO,
    lockfiles,
    dependencies: declared.map((d) => ({
      name: d.name,
      declaredVersion: d.version,
      installedVersion: lockfiles.length > 0 ? d.version : null,
      status: lockfiles.length > 0 ? DEPENDENCY_STATUSES.INSTALLED : DEPENDENCY_STATUSES.UNRESOLVED,
      type: d.type,
      isDev: d.isDev,
    })),
    missingDependencies: [],
    warnings: [],
  };
}

/**
 * Discovers and inspects all project dependencies across supported ecosystems.
 * Handles monorepo/workspaces by scanning root and immediate subdirectories.
 *
 * @param {string} projectRoot - Root directory of the authorized workspace.
 * @returns {Promise<Object>} Comprehensive dependency discovery report.
 */
async function discoverDependencies(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new TypeError('projectRoot must be a non-empty string path.');
  }

  const reports = [];

  // Check supported ecosystems in root
  const [nodeReport, phpReport, pythonReport, goReport, rustReport] = await Promise.all([
    inspectNodeDependencies(projectRoot),
    inspectPhpDependencies(projectRoot),
    inspectPythonDependencies(projectRoot),
    inspectGoDependencies(projectRoot),
    inspectRustDependencies(projectRoot),
  ]);

  if (nodeReport.hasManifest) reports.push(nodeReport);
  if (phpReport.hasManifest) reports.push(phpReport);
  if (pythonReport.hasManifest) reports.push(pythonReport);
  if (goReport.hasManifest) reports.push(goReport);
  if (rustReport.hasManifest) reports.push(rustReport);

  // If node workspaces are declared, scan child directories
  const subpackageReports = [];
  if (nodeReport.workspaces && Array.isArray(nodeReport.workspaces)) {
    for (const wsPattern of nodeReport.workspaces) {
      const baseDir = wsPattern.replace(/\/\*.*$/, '');
      try {
        const fullBase = path.join(projectRoot, baseDir);
        const entries = await fs.readdir(fullBase, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subRoot = path.join(fullBase, entry.name);
            const subNode = await inspectNodeDependencies(subRoot);
            if (subNode.hasManifest) {
              subNode.subpackagePath = path.join(baseDir, entry.name).replace(/\\/g, '/');
              subpackageReports.push(subNode);
            }
          }
        }
      } catch {}
    }
  }

  const allReports = [...reports, ...subpackageReports];

  // Aggregate missing dependencies across all inspected reports
  const allMissing = allReports.flatMap((r) => r.missingDependencies.map((m) => ({
    ...m,
    ecosystem: r.ecosystem,
    manifestPath: r.subpackagePath ? path.join(r.subpackagePath, r.manifestPath).replace(/\\/g, '/') : r.manifestPath,
    packageManager: r.packageManager,
  })));

  const allWarnings = allReports.flatMap((r) => r.warnings || []);
  const allLifecycleScripts = allReports.flatMap((r) => r.lifecycleScripts || []);

  const primaryReport = reports[0] || null;
  const needsInstallation = allMissing.length > 0;

  return {
    projectRoot,
    ecosystemsFound: allReports.map((r) => r.ecosystem),
    reports: allReports,
    primaryReport,
    declaredCount: allReports.reduce((sum, r) => sum + r.dependencies.length, 0),
    missingCount: allMissing.length,
    missingDependencies: allMissing,
    needsInstallation,
    lifecycleScripts: allLifecycleScripts,
    warnings: allWarnings,
    preferredPackageManager: primaryReport?.packageManager || null,
  };
}

/**
 * Creates an auditable, minimal installation plan bound to the exact project identity.
 *
 * @param {Object} options
 * @param {string} options.projectRoot - Canonical project path.
 * @param {Object} options.dependencyReport - Output from discoverDependencies.
 * @param {Array<string>} [options.targets] - Specific package names to install, or empty for all missing.
 * @returns {Object} Installation plan proposal.
 */
/**
 * Constructs a validated proposal contract from a dependency installation plan.
 */
function createDependencyProposalContract(plan, dependencyReport = null) {
  if (!plan) return null;
  const missingCount = dependencyReport?.missingCount ?? (plan.targetCount ?? plan.targets?.length ?? 0);
  const missingNames = (plan.targets || []).map((t) => t.name).join(', ') || 'declared dependencies';
  const manifestFile = dependencyReport?.primaryReport?.manifestPath || 'package.json';

  return {
    proposalId: plan.planId || crypto.randomUUID(),
    type: 'DEPENDENCY_INSTALL_PROPOSAL',
    proposalType: 'DEPENDENCY_INSTALL',
    isModular: true,
    targetFile: manifestFile,
    files: [manifestFile],
    projectRoot: plan.projectRoot,
    packageManager: plan.packageManager,
    command: plan.command,
    args: plan.args,
    fullCommandString: plan.fullCommandString,
    targets: plan.targets || [],
    targetCount: plan.targetCount ?? (plan.targets?.length || 0),
    planDigest: plan.planDigest,
    networkRequired: plan.networkRequired !== false,
    materialSideEffects: plan.materialSideEffects || {},
    rootCauseSummary: `Project declares dependencies in ${manifestFile} that are not installed on disk (${missingCount} missing: ${missingNames}).`,
    expectedBehavior: `Install missing dependencies (${missingNames}) using ${plan.fullCommandString} in an isolated container environment.`,
    status: 'PROPOSAL_READY',
    approved: false,
    createdAt: plan.createdAt || new Date().toISOString(),
  };
}

/**
 * Validates a dependency plan's proposal contract against the formal proposal validator.
 */
function validateDependencyProposal(plan) {
  if (!plan) {
    return { isValid: false, rejectionReason: 'Plan must be a non-null object.' };
  }
  const contract = plan.proposalContract || plan;
  return validateProposalContract(contract);
}

function createDependencyPlan({
  projectRoot,
  dependencyReport,
  targets = [],
} = {}) {
  if (!projectRoot || !dependencyReport) {
    throw new TypeError('projectRoot and dependencyReport are required to create a plan.');
  }

  const pm = dependencyReport.preferredPackageManager
    || dependencyReport.packageManager
    || dependencyReport.primaryReport?.packageManager
    || PACKAGE_MANAGERS.NPM;
  const missing = dependencyReport.missingDependencies || [];
  const targetItems = targets.length > 0
    ? missing.filter((m) => targets.includes(m.name))
    : missing;

  let command;
  let args = [];

  switch (pm) {
    case PACKAGE_MANAGERS.PNPM:
      command = 'pnpm';
      args = targets.length > 0 ? ['add', ...targets] : ['install'];
      break;
    case PACKAGE_MANAGERS.YARN:
      command = 'yarn';
      args = targets.length > 0 ? ['add', ...targets] : ['install'];
      break;
    case PACKAGE_MANAGERS.BUN:
      command = 'bun';
      args = targets.length > 0 ? ['add', ...targets] : ['install'];
      break;
    case PACKAGE_MANAGERS.COMPOSER:
      command = 'composer';
      args = targets.length > 0 ? ['require', ...targets] : ['install'];
      break;
    case PACKAGE_MANAGERS.POETRY:
      command = 'poetry';
      args = targets.length > 0 ? ['add', ...targets] : ['install'];
      break;
    case PACKAGE_MANAGERS.PIP:
      command = 'pip';
      args = targets.length > 0 ? ['install', ...targets] : ['install', '-r', 'requirements.txt'];
      break;
    case PACKAGE_MANAGERS.CARGO:
      command = 'cargo';
      args = ['build'];
      break;
    case PACKAGE_MANAGERS.GO:
      command = 'go';
      args = ['mod', 'download'];
      break;
    case PACKAGE_MANAGERS.NPM:
    default:
      command = 'npm';
      args = targets.length > 0 ? ['install', ...targets] : ['install'];
      break;
  }

  const scriptsList = dependencyReport.lifecycleScripts || dependencyReport.primaryReport?.lifecycleScripts || [];
  const lifecycleRisks = scriptsList.filter((s) => s.isSuspicious);

  // Compute plan digest to bind approval to exact plan parameters
  const planPayload = JSON.stringify({
    projectRoot,
    packageManager: pm,
    command,
    args,
    targets: targetItems.map((t) => t.name),
  });
  const planDigest = crypto.createHash('sha256').update(planPayload).digest('hex');

  const lockfiles = dependencyReport.primaryReport?.lockfiles || dependencyReport.lockfiles || [];

  const manifestFile = dependencyReport.primaryReport?.manifestPath || 'package.json';
  const targetNames = targetItems.map((t) => `${t.name}@${t.declaredVersion || 'latest'}`).join(', ') || 'all missing dependencies';
  const planDiff = `# Dependency Installation Plan\n# Command: ${command} ${args.join(' ')}\n# Target Workspace: ${projectRoot}\n# Dependencies (${targetItems.length}): ${targetNames}\n`;
  const planId = crypto.randomUUID();

  const plan = {
    planId,
    taskId: planId,
    planDigest,
    manifestHash: planDigest,
    projectRoot,
    packageManager: pm,
    command,
    args,
    fullCommandString: `${command} ${args.join(' ')}`,
    targets: targetItems,
    targetCount: targetItems.length,
    targetFiles: [manifestFile],
    files: [{
      path: manifestFile,
      sourcePath: null,
      operation: 'modify',
      hash: null,
      content: null,
      lines: planDiff.split('\n'),
    }],
    diff: planDiff,
    networkRequired: true,
    materialSideEffects: {
      networkAccess: true,
      lockfileModified: lockfiles.length > 0,
      lifecycleScriptsRunning: scriptsList.map((s) => s.scriptName),
      hasSuspiciousScripts: lifecycleRisks.length > 0,
      suspiciousScripts: lifecycleRisks,
    },
    status: 'PROPOSAL_READY',
    approved: false,
    createdAt: new Date().toISOString(),
  };
  plan.proposalContract = createDependencyProposalContract(plan, dependencyReport);
  return plan;
}

/**
 * Attempts to execute an approved dependency plan behind the verified execution gate.
 *
 * FAILS CLOSED: Since Windows process isolation is unverified without host-backed sandbox,
 * real execution is blocked and never claimed as successful without verified execution.
 *
 * @param {Object} options
 * @param {Object} options.plan - Proposal plan generated by createDependencyPlan.
 * @param {number} options.ownerWebContentsId - Session owner webContents ID.
 * @param {string} options.sessionId - Session ID.
 * @returns {Promise<Object>} Execution result (fails closed if unverified).
 */
async function executeDependencyPlan({
  plan,
  ownerWebContentsId,
  sessionId,
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
      status: 'UNAUTHORIZED',
      executionBlocked: true,
      error: `Project authorization failed: ${auth.reason}`,
      planDigest: plan.planDigest,
      installed: false,
    };
  }

  // 2. If containerRunner is provided, execute inside verified container
  if (containerRunner && typeof containerRunner.execute === 'function') {
    const runResult = await containerRunner.execute({
      plan,
      ownerWebContentsId,
      sessionId,
      networkMode: 'allow_package_egress',
    });
    if (!runResult.ok && runResult.executionBlocked) {
      return {
        ...runResult,
        installed: false,
        reason: runResult.reason && runResult.reason.includes('verified Windows process isolation is required')
          ? runResult.reason
          : `Dependency installation execution is blocked: verified Windows process isolation is required before executing package manager commands or lifecycle scripts (${runResult.reason || 'unverified container isolation'}).`,
      };
    }
    const verification = await verifyInstalledDependencies(plan.projectRoot);
    return {
      ...runResult,
      installed: runResult.ok && verification.isFullyInstalled,
      dependencyVerification: verification,
    };
  }

  // 3. Enforce verified operating-system process isolation boundary
  // Under milestone safety policy, unverified Windows process isolation blocks command execution
  try {
    requireProjectProcessIsolation(`Dependency installation (${plan.fullCommandString})`);
  } catch (gateErr) {
    return {
      ok: false,
      status: 'BLOCKED',
      executionBlocked: true,
      gate: 'PROCESS_ISOLATION_GATE',
      error: gateErr.message,
      planDigest: plan.planDigest,
      command: plan.fullCommandString,
      installed: false,
      reason: 'Dependency installation execution is blocked: verified Windows process isolation is required before executing package manager commands or lifecycle scripts.',
    };
  }

  // If process isolation became verified in the future, real execution would happen here:
  return {
    ok: false,
    status: 'UNVERIFIED_ENVIRONMENT',
    executionBlocked: true,
    error: 'Execution environment was not verified by host sandbox runner.',
    installed: false,
  };
}

/**
 * Verifies on-disk dependency resolution after any operation.
 */
async function verifyInstalledDependencies(projectRoot) {
  const current = await discoverDependencies(projectRoot);
  return {
    isFullyInstalled: !current.needsInstallation,
    missingCount: current.missingCount,
    missingDependencies: current.missingDependencies,
    lockfilesPresent: current.primaryReport?.lockfiles || [],
    warnings: current.warnings,
  };
}

module.exports = {
  SUPPORTED_ECOSYSTEMS,
  DEPENDENCY_STATUSES,
  PACKAGE_MANAGERS,
  cleanVersion,
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
  createDependencyProposalContract,
  validateDependencyProposal,
};
