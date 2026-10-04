const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { developer: developerSettings } = require('../src/config/runtimeSettings.json');
const { detectProject, PROJECT_MANIFESTS, VERIFICATION_PROFILES } = require('./coding-pipeline/detect/projectDetector.cjs');

const MAX_FILE_BYTES = developerSettings.maxFileBytes;
const MAX_SEARCH_RESULTS = developerSettings.maxSearchResults;
const MAX_SEARCH_FILES = developerSettings.maxSearchFiles;
const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'logs', 'tmp', 'temp', '.dev-mode-audit.log']);
function isIgnoredName(name) {
  const normalized = String(name || '').toLowerCase();
  return IGNORED_NAMES.has(normalized) || normalized.startsWith('.developer-journal-') || normalized.endsWith('.log');
}
const MAX_COMMAND_DURATION_MS = developerSettings.maxCommandDurationMs;
const MAX_OUTPUT_CHARS = developerSettings.maxOutputChars;
const MAX_RUNTIME_FRAMES = developerSettings.maxRuntimeFrames;
const MAX_RUNTIME_SOURCE_LINES = developerSettings.maxRuntimeSourceLines;
const PROJECT_DISCOVERY_MAX_DEPTH = developerSettings.projectDiscoveryMaxDepth;
const PROJECT_DISCOVERY_TIMEOUT_MS = developerSettings.projectDiscoveryTimeoutMs;
const PROJECT_DISCOVERY_MAX_DIRECTORIES = developerSettings.projectDiscoveryMaxDirectories;
const PROJECT_DISCOVERY_MAX_MATCHES = developerSettings.projectDiscoveryMaxMatches;
const PROJECT_DISCOVERY_EXCLUDED_NAMES = new Set([
  ...IGNORED_NAMES,
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.venv',
  'venv',
  'vendor',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  '$recycle.bin',
  'system volume information',
]);
const SAFE_SCRIPT_NAMES = new Set(['lint', 'typecheck', 'test', 'build', 'check', 'validate', 'verify']);
const UNSAFE_SCRIPT_PATTERN = /[;&|<>`]|\$\(|\b(?:npm|npm\.cmd|yarn|pnpm|npx|git|rm|del|erase|format|powershell|cmd|install|publish|deploy|release|commit|push|reset|clean|generate|fix|update|write)\b/i;
const SAFE_COMMAND_PATTERN = /^\s*(?:tsc|eslint|vite|vitest|jest|mocha|ava|biome|webpack|rollup|next)(?:\s|$)/i;
const SAFE_ENV_KEYS = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'CI']);
const CREDENTIAL_ENV_PATTERN = /(?:key|token|secret|pass|credential|auth|private|cookie|session|client[_-]?secret|access[_-]?id)/i;
const NETWORK_POLICY = Object.freeze({ mode: 'restricted', outbound: 'not-granted-by-verification-layer' });
const SENSITIVE_NAME_PATTERN = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt|cer|der)|id_rsa(?:\..*)?)$/i;
const SENSITIVE_DIRECTORY_NAMES = new Set(['.ssh', '.aws', '.azure', '.config']);
const LOW_VALUE_PATH_PATTERN = /(?:^|[\\/])(?:\.idea|assets?|fonts?|vendor|node_modules|dist|build|coverage|tmp|cache)(?:[\\/]|$)|\.(?:ttf|woff2?|eot|map|min\.(?:js|css))$/i;
const CHECK_COMMANDS = {
  'maven-test': { executable: 'mvn', args: ['test'] },
  'maven-build': { executable: 'mvn', args: ['package', '-DskipTests'] },
  'gradle-test': { executable: process.platform === 'win32' ? 'gradlew.bat' : './gradlew', args: ['test'] },
  'gradle-build': { executable: process.platform === 'win32' ? 'gradlew.bat' : './gradlew', args: ['build'] },
  'go-test': { executable: 'go', args: ['test', './...'] },
  'go-vet': { executable: 'go', args: ['vet', './...'] },
  'go-build': { executable: 'go', args: ['build', './...'] },
  'ruby-test': { executable: 'bundle', args: ['exec', 'rspec'] },
  'ruby-lint': { executable: 'rubocop', args: [] },
  'dotnet-test': { executable: 'dotnet', args: ['test', '--no-restore'] },
  'dotnet-build': { executable: 'dotnet', args: ['build', '--no-restore'] },
  'cargo-test': { executable: 'cargo', args: ['test'] },
  'cargo-clippy': { executable: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
  'cargo-build': { executable: 'cargo', args: ['build'] },
  'python-test': { executable: 'python', args: ['-m', 'pytest'] },
  'python-lint': { executable: 'python', args: ['-m', 'compileall', '-q', '.'] },
};

const PROJECT_STATUSES = Object.freeze({
  ATTACHED: 'PROJECT_ATTACHED',
  DETACHED: 'PROJECT_DETACHED',
  STALE: 'PROJECT_STALE',
  MISSING: 'PROJECT_MISSING',
  RECONNECTING: 'PROJECT_SESSION_RECONNECTING',
  NOT_ATTACHED: 'PROJECT_NOT_ATTACHED',
});

const projectRoots = new Map();
const projectDiscoveryMatches = new Map();
let authoritativeProjectRoot = null;
let authoritativeProjectStatus = PROJECT_STATUSES.NOT_ATTACHED;
let auditDirectory = null;

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSensitivePath(relativePath) {
  const segments = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase()) || SENSITIVE_NAME_PATTERN.test(segment));
}

function isExcludedDiscoveryPath(target) {
  return path.resolve(target).split(/[\\/]/).filter(Boolean)
    .some((segment) => PROJECT_DISCOVERY_EXCLUDED_NAMES.has(segment.toLowerCase()));
}

function getProjectDiscoveryRoots() {
  const configured = String(process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidateRoots = [...configured];

  // Derive roots from current runtime/application context if available
  for (const assignedRoot of projectRoots.values()) {
    if (assignedRoot && typeof assignedRoot === 'string') {
      const parentDir = path.dirname(path.resolve(assignedRoot));
      if (!candidateRoots.includes(parentDir)) candidateRoots.push(parentDir);
    }
  }

  // If no configured roots, include current process working workspace if safe
  if (candidateRoots.length === 0 && process.cwd()) {
    try {
      const cwd = path.resolve(process.cwd());
      const cwdParent = path.dirname(cwd);
      if (!isExcludedDiscoveryPath(cwd) && cwd.toLowerCase() !== path.parse(cwd).root.toLowerCase()) {
        candidateRoots.push(cwd);
      }
      if (!isExcludedDiscoveryPath(cwdParent) && cwdParent.toLowerCase() !== path.parse(cwdParent).root.toLowerCase()) {
        candidateRoots.push(cwdParent);
      }
    } catch {}
  }

  const roots = [];
  for (const entry of candidateRoots) {
    const isNetworkPath = process.platform === 'win32' && /^\\\\/.test(entry);
    if (!path.isAbsolute(entry) || isNetworkPath) {
      throw new Error(`Invalid Coding project discovery root: ${entry}`);
    }
    const root = path.resolve(entry);
    const driveRoot = path.parse(root).root;
    if (root.toLowerCase() === driveRoot.toLowerCase() || isExcludedDiscoveryPath(root)) {
      throw new Error(`Invalid Coding project discovery root: ${root}`);
    }
    if (!roots.some((existing) => existing.toLowerCase() === root.toLowerCase())) roots.push(root);
  }
  return roots;
}

const PROJECT_ROOT_MANIFEST_SIGNATURES = [
  'package.json',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'Cargo.toml',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'artisan',
  'yii',
];

async function findEnclosingProjectRoot(filePath, boundaryRoots = []) {
  const normalizedBoundaries = new Set(boundaryRoots.map((r) => path.resolve(r).toLowerCase()));
  let currentDir = path.resolve(path.dirname(filePath));
  let topCandidate = null;

  while (currentDir) {
    let canonicalCurrent;
    try {
      canonicalCurrent = await fs.realpath(currentDir);
    } catch {
      break;
    }
    const currentLower = canonicalCurrent.toLowerCase();
    if (normalizedBoundaries.has(currentLower) || isExcludedDiscoveryPath(canonicalCurrent)) {
      break;
    }
    const parsed = path.parse(canonicalCurrent);
    if (currentLower === parsed.root.toLowerCase()) {
      break;
    }

    for (const signature of PROJECT_ROOT_MANIFEST_SIGNATURES) {
      try {
        const manifestPath = path.join(canonicalCurrent, signature);
        const stat = await fs.stat(manifestPath);
        if (stat.isFile()) {
          return canonicalCurrent;
        }
      } catch {}
    }

    try {
      const gitPath = path.join(canonicalCurrent, '.git');
      const gitStat = await fs.stat(gitPath);
      if (gitStat.isDirectory() || gitStat.isFile()) {
        return canonicalCurrent;
      }
    } catch {}

    const parent = path.dirname(canonicalCurrent);
    if (parent === canonicalCurrent || normalizedBoundaries.has(parent.toLowerCase())) {
      topCandidate = canonicalCurrent;
      break;
    }
    topCandidate = canonicalCurrent;
    currentDir = parent;
  }

  return topCandidate;
}

async function rankProjectCandidates(candidates, targetName, roots = []) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return Array.isArray(candidates) ? [...candidates] : [];
  const normalizedTarget = String(targetName || '').toLowerCase();
  const scored = await Promise.all(candidates.map(async (candidateRoot) => {
    let score = 0;
    const folderName = path.basename(candidateRoot).toLowerCase();
    if (folderName === normalizedTarget) score += 100;
    for (const signature of PROJECT_ROOT_MANIFEST_SIGNATURES) {
      try {
        const stat = await fs.stat(path.join(candidateRoot, signature));
        if (stat.isFile()) {
          score += 30;
          break;
        }
      } catch {}
    }
    try {
      const entries = await fs.readdir(candidateRoot, { withFileTypes: true });
      const hasStructure = entries.some((e) => e.isDirectory() && !PROJECT_DISCOVERY_EXCLUDED_NAMES.has(e.name.toLowerCase()));
      if (hasStructure) score += 15;
    } catch {}
    const depth = candidateRoot.split(/[\\/]/).filter(Boolean).length;
    score -= depth * 2;
    return { root: candidateRoot, score };
  }));
  scored.sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
  return scored.map((item) => item.root);
}

async function discoverProjectByName(projectName, ownerWebContentsId) {
  if (ownerWebContentsId === undefined) throw new Error('Developer project ownership is required.');
  const name = typeof projectName === 'string' ? projectName.trim() : '';
  if (!name || name.length > 512) {
    throw new TypeError('Coding project name must be a bounded folder name.');
  }
  const pendingMatches = projectDiscoveryMatches.get(ownerWebContentsId) || [];
  if (path.isAbsolute(name)) {
    const selected = pendingMatches.find((match) => match.toLowerCase() === path.resolve(name).toLowerCase());
    if (!selected) throw new Error('The selected project path was not one of the discovered matches.');
    projectRoots.set(ownerWebContentsId, selected);
    projectDiscoveryMatches.delete(ownerWebContentsId);
    try {
      await validateProjectRoot(ownerWebContentsId);
    } catch (error) {
      projectRoots.delete(ownerWebContentsId);
      throw error;
    }
    return { matches: [selected], projectRoot: selected, roots: [] };
  }
  if (!name || (name !== '*' && (name.length > 128 || name === '.' || name === '..'
    || path.basename(name) !== name || /[<>:"/\\|?*\u0000-\u001f]/.test(name)))) {
    throw new TypeError('Coding project name must be a bounded folder name.');
  }

  const roots = getProjectDiscoveryRoots();
  const deadline = Date.now() + PROJECT_DISCOVERY_TIMEOUT_MS;
  const targetName = name.toLowerCase();
  const matches = new Set();
  const queue = [];
  const visitedDirectories = new Set();
  let timedOut = false;
  let directoryLimitReached = false;
  const inaccessible = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']);

  for (const root of roots) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    try {
      const canonicalRoot = await fs.realpath(root);
      if (isExcludedDiscoveryPath(canonicalRoot)) continue;
      const stat = await fs.stat(canonicalRoot);
      if (!stat.isDirectory()) continue;
      const rootKey = canonicalRoot.toLowerCase();
      if (!visitedDirectories.has(rootKey)) {
        visitedDirectories.add(rootKey);
        queue.push({ directory: canonicalRoot, depth: 0 });
      }
    } catch (error) {
      if (!inaccessible.has(error.code)) throw error;
    }
  }

  while (queue.length) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    if (visitedDirectories.size >= PROJECT_DISCOVERY_MAX_DIRECTORIES) {
      directoryLimitReached = true;
      break;
    }
    const current = queue.shift();
    if (current.depth >= PROJECT_DISCOVERY_MAX_DEPTH) continue;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      timedOut = true;
      break;
    }
    let timer;
    let entries;
    try {
      entries = await Promise.race([
        fs.readdir(current.directory, { withFileTypes: true }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), remainingMs); }),
      ]);
    } catch (error) {
      if (!inaccessible.has(error.code)) throw error;
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!entries) {
      timedOut = true;
      break;
    }

    for (const entry of entries) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const entryNameLower = entry.name.toLowerCase();
      if (PROJECT_DISCOVERY_EXCLUDED_NAMES.has(entryNameLower)) continue;

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (!isDirectory && !isFile) {
        try {
          const entryStat = await fs.stat(path.join(current.directory, entry.name));
          isDirectory = entryStat.isDirectory();
          isFile = entryStat.isFile();
        } catch {
          continue;
        }
      }

      const candidatePath = path.join(current.directory, entry.name);

      if (isDirectory) {
        let canonicalCandidate;
        try {
          canonicalCandidate = await fs.realpath(candidatePath);
        } catch (error) {
          if (!inaccessible.has(error.code)) throw error;
          continue;
        }
        if (isExcludedDiscoveryPath(canonicalCandidate)) continue;

        if (targetName === '*' || entryNameLower === targetName) {
          try {
            const stat = await fs.stat(canonicalCandidate);
            if (stat.isDirectory()) {
              if (targetName === '*') {
                let hasManifest = false;
                for (const signature of PROJECT_ROOT_MANIFEST_SIGNATURES) {
                  try {
                    const s = await fs.stat(path.join(canonicalCandidate, signature));
                    if (s.isFile()) { hasManifest = true; break; }
                  } catch {}
                }
                if (hasManifest) matches.add(canonicalCandidate);
              } else {
                matches.add(canonicalCandidate);
              }
            }
          } catch (error) {
            if (!inaccessible.has(error.code)) throw error;
          }
        }

        if (current.depth + 1 < PROJECT_DISCOVERY_MAX_DEPTH) {
          const canonicalKey = canonicalCandidate.toLowerCase();
          if (!visitedDirectories.has(canonicalKey)) {
            visitedDirectories.add(canonicalKey);
            queue.push({ directory: canonicalCandidate, depth: current.depth + 1 });
          }
        }
      } else if (isFile) {
        if (entryNameLower === targetName) {
          try {
            const enclosingRoot = await findEnclosingProjectRoot(candidatePath, roots);
            if (enclosingRoot) {
              const canonicalRoot = await fs.realpath(enclosingRoot);
              const stat = await fs.stat(canonicalRoot);
              if (stat.isDirectory() && !isExcludedDiscoveryPath(canonicalRoot)) {
                matches.add(canonicalRoot);
              }
            }
          } catch (error) {
            if (!inaccessible.has(error.code)) throw error;
          }
        }
      }
    }
  }

  if (timedOut || directoryLimitReached) {
    projectDiscoveryMatches.delete(ownerWebContentsId);
    return {
      matches: [...matches].sort().slice(0, PROJECT_DISCOVERY_MAX_MATCHES),
      projectRoot: null,
      roots,
      timedOut,
      directoryLimitReached,
    };
  }

  const foundUnsorted = [...matches].slice(0, PROJECT_DISCOVERY_MAX_MATCHES);
  const found = await rankProjectCandidates(foundUnsorted, name, roots);
  const projectRoot = found.length === 1 ? found[0] : null;
  if (projectRoot) {
    projectDiscoveryMatches.delete(ownerWebContentsId);
    projectRoots.set(ownerWebContentsId, projectRoot);
    try {
      await validateProjectRoot(ownerWebContentsId);
      await setAuthoritativeProject(projectRoot, ownerWebContentsId);
    } catch (error) {
      projectRoots.delete(ownerWebContentsId);
      throw error;
    }
  } else if (found.length > 1) {
    projectDiscoveryMatches.set(ownerWebContentsId, found);
  } else {
    projectDiscoveryMatches.delete(ownerWebContentsId);
  }

  if (process.env.DEBUG || process.env.AI_HELP_AGENT_LOG_DISCOVERY) {
    console.log(`[CODING DISCOVERY] target=${name} visitedDirectories=${visitedDirectories.size} candidates=${matches.size} selectedProject=${projectRoot || 'none'}`);
  }

  return { matches: found, projectRoot, roots, timedOut: false, directoryLimitReached: false };
}

async function realPathOrParent(target) {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await realPathOrParent(parent), path.basename(target));
  }
}

async function resolveWithinRoot(root, requestedPath = '.') {
  const canonicalRoot = await fs.realpath(root);
  if (typeof requestedPath !== 'string' || path.isAbsolute(requestedPath)) {
    throw new Error('Access denied: project paths must be relative.');
  }
  const requested = path.resolve(canonicalRoot, requestedPath || '.');
  const realTarget = await realPathOrParent(requested);
  if (!isInsideRoot(canonicalRoot, realTarget)) {
    throw new Error('Access denied: the requested path is outside the selected project.');
  }
  const relative = path.relative(canonicalRoot, realTarget);
  if (isSensitivePath(relative)) throw new Error('Access denied: sensitive project files are not available to the Coding Agent.');
  return { root: canonicalRoot, target: realTarget };
}

function normalizeScopedProjectPath(root, scope, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length > 512 || path.isAbsolute(requestedPath)) {
    throw new TypeError('Coding Agent tool path must be a bounded relative path.');
  }
  const clean = requestedPath.replace(/\\/g, '/').trim().replace(/^(?:\.\/)+/, '') || '.';
  if (clean.split('/').includes('..')) throw new Error('Coding Agent tool path traversal is denied.');
  const normalizedScope = String(scope || '.').replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  const scopePath = path.resolve(root, normalizedScope);
  const alreadyScoped = normalizedScope === '.'
    || clean === normalizedScope
    || clean.startsWith(`${normalizedScope}/`);
  const requested = path.resolve(
    root,
    clean === '.' ? normalizedScope : alreadyScoped ? clean : path.join(normalizedScope, clean),
  );
  const relativeToScope = path.relative(scopePath, requested);
  if (relativeToScope === '..' || relativeToScope.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToScope)) {
    throw new Error('Coding Agent tool path is outside the selected scope.');
  }
  const relativeToRoot = path.relative(root, requested);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error('Coding Agent tool path is outside the selected project.');
  }
  return relativeToRoot.replace(/\\/g, '/') || '.';
}

function assertProjectOwner(ownerWebContentsId) {
  if (ownerWebContentsId === undefined) {
    const err = new Error('Developer project owner is required.');
    err.code = 'PROJECT_NOT_ATTACHED';
    throw err;
  }
  if (authoritativeProjectStatus === PROJECT_STATUSES.DETACHED) {
    const err = new Error('Developer project is detached (PROJECT_DETACHED).');
    err.code = 'PROJECT_DETACHED';
    throw err;
  }
  let assignedRoot = projectRoots.get(ownerWebContentsId);
  if (!assignedRoot && projectRoots.size > 0) {
    const err = new Error('Developer project access is not owned by this renderer session.');
    err.code = 'PROJECT_NOT_OWNED';
    throw err;
  }
  if (!assignedRoot && projectRoots.size === 0 && authoritativeProjectRoot && authoritativeProjectStatus === PROJECT_STATUSES.ATTACHED) {
    assignedRoot = authoritativeProjectRoot;
    projectRoots.set(ownerWebContentsId, assignedRoot);
  }
  if (!assignedRoot) {
    const err = new Error('Developer project access is not owned by this renderer session.');
    err.code = 'PROJECT_NOT_ATTACHED';
    throw err;
  }
  const fsSync = require('node:fs');
  try {
    const stat = fsSync.statSync(assignedRoot);
    if (!stat.isDirectory()) {
      authoritativeProjectStatus = PROJECT_STATUSES.MISSING;
      const err = new Error(`Developer project directory does not exist on disk (PROJECT_MISSING): ${assignedRoot}`);
      err.code = 'PROJECT_MISSING';
      throw err;
    }
  } catch (err) {
    if (err.code === 'PROJECT_MISSING') throw err;
    authoritativeProjectStatus = PROJECT_STATUSES.MISSING;
    const missingErr = new Error(`Developer project directory does not exist on disk (PROJECT_MISSING): ${assignedRoot}`);
    missingErr.code = 'PROJECT_MISSING';
    throw missingErr;
  }
  return assignedRoot;
}

async function validateProjectRoot(ownerWebContentsId) {
  assertProjectOwner(ownerWebContentsId);
  const root = projectRoots.get(ownerWebContentsId) || authoritativeProjectRoot;
  if (!root) {
    const err = new Error('No project folder selected.');
    err.code = 'PROJECT_NOT_ATTACHED';
    throw err;
  }
  try {
    const resolvedRoot = await fs.realpath(root);
    const stat = await fs.stat(resolvedRoot);
    if (!stat.isDirectory()) {
      authoritativeProjectStatus = PROJECT_STATUSES.MISSING;
      const err = new Error(`Invalid project path (PROJECT_MISSING): ${root}`);
      err.code = 'PROJECT_MISSING';
      throw err;
    }
    return resolvedRoot;
  } catch (err) {
    authoritativeProjectStatus = PROJECT_STATUSES.MISSING;
    const error = new Error(`Invalid project path (PROJECT_MISSING): ${err.message}`);
    error.code = 'PROJECT_MISSING';
    throw error;
  }
}

function appendAudit(root, tool, target, result) {
  const destination = auditDirectory || path.join(os.homedir(), '.ai-help-agent', 'developer-audit');
  const rootKey = crypto.createHash('sha256').update(path.resolve(root)).digest('hex');
  return fs.appendFile(
    path.join(destination, `${rootKey}.jsonl`),
    `${new Date().toISOString()}\ttool=${tool}\ttarget=${JSON.stringify(target)}\tresult=${result}\n`,
    'utf8',
  ).catch(async (error) => {
    if (error.code !== 'ENOENT') {
      console.error(`[DEVELOPER_AUDIT] Failed to append audit event: ${error.message}`);
      return;
    }
    try {
      await fs.mkdir(destination, { recursive: true });
      await fs.appendFile(
        path.join(destination, `${rootKey}.jsonl`),
        `${new Date().toISOString()}\ttool=${tool}\ttarget=${JSON.stringify(target)}\tresult=${result}\n`,
        'utf8',
      );
    } catch (writeError) {
      console.error(`[DEVELOPER_AUDIT] Failed to initialize audit storage: ${writeError.message}`);
    }
  });
}

async function resolveProjectPath(relativePath = '.', ownerWebContentsId) {
  const root = await validateProjectRoot(ownerWebContentsId);
  return resolveWithinRoot(root, relativePath);
}

async function resolveProjectScope(ownerWebContentsId, relativePath = '.') {
  const requested = String(relativePath || '.').trim() || '.';
  const resolved = await resolveProjectPath(requested, ownerWebContentsId);
  const stat = await fs.stat(resolved.target);
  if (!stat.isDirectory()) throw new Error('Proposal scope must be a directory.');
  return path.relative(resolved.root, resolved.target).replace(/\\/g, '/') || '.';
}

async function chooseProjectFolder(dialog, ownerWebContentsId) {
  if (ownerWebContentsId === undefined) throw new Error('Developer project ownership is required.');
  const scaffoldPath = projectRoots.get(ownerWebContentsId) || authoritativeProjectRoot || process.cwd() || require('node:os').homedir();
  const result = await dialog.showOpenDialog({
    title: 'Select project folder',
    defaultPath: scaffoldPath,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, projectRoot: projectRoots.get(ownerWebContentsId) || authoritativeProjectRoot || null };
  }
  const selectedRoot = await fs.realpath(result.filePaths[0]);
  projectRoots.set(ownerWebContentsId, selectedRoot);
  projectDiscoveryMatches.delete(ownerWebContentsId);
  await setAuthoritativeProject(selectedRoot, ownerWebContentsId);
  return { canceled: false, projectRoot: selectedRoot };
}

async function listDirectory(relativePath = '.', ownerWebContentsId) {
  const { root, target } = await resolveProjectPath(relativePath, ownerWebContentsId);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('The requested path is not a directory.');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const result = entries
    .filter((entry) => !isIgnoredName(entry.name) && !isSensitivePath(entry.name))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  await appendAudit(root, 'list_directory', relativePath, 'success');
  return result;
}

async function readFile(relativePath, ownerWebContentsId) {
  const { root, target } = await resolveProjectPath(relativePath, ownerWebContentsId);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('The requested path is not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File is too large to read (${Math.floor(MAX_FILE_BYTES / 1024)}KB limit).`);
  const result = { path: relativePath, content: await fs.readFile(target, 'utf8') };
  await appendAudit(root, 'read_file', relativePath, 'success');
  return result;
}

async function searchCode(query, ownerWebContentsId, relativeScope = '.') {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!normalizedQuery) throw new Error('Search query is required.');
  const root = await validateProjectRoot(ownerWebContentsId);
  let scope = String(relativeScope || '.').trim() || '.';
  let scopeTarget = await resolveProjectPath(scope, ownerWebContentsId);
  const scopeStat = await fs.stat(scopeTarget.target);
  if (!scopeStat.isDirectory()) {
    scope = path.dirname(scope);
    scopeTarget = await resolveProjectPath(scope, ownerWebContentsId);
    if (!(await fs.stat(scopeTarget.target)).isDirectory()) throw new Error('Search scope must be a directory.');
  }
  const results = [];
  let filesVisited = 0;

  async function walk(relativeDirectory) {
    if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
    const directory = await resolveProjectPath(relativeDirectory, ownerWebContentsId);
    const entries = await fs.readdir(directory.target, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
      const childRelative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
      if (isIgnoredName(entry.name) || isSensitivePath(childRelative)) continue;
      if (LOW_VALUE_PATH_PATTERN.test(childRelative)) continue;
      if (entry.isDirectory()) {
        await walk(childRelative);
        continue;
      }

      if (!entry.isFile()) continue;
      filesVisited += 1;
      const target = await resolveProjectPath(childRelative, ownerWebContentsId);
      const stat = await fs.stat(target.target);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(target.target, 'utf8');
      const lines = content.split(/\r?\n/);
      const nameMatch = entry.name.toLowerCase().includes(normalizedQuery);
      if (nameMatch) {
        results.push({
          path: childRelative,
          line: 0,
          text: entry.name,
          matchType: 'filename',
        });
      }
      lines.forEach((line, lineIndex) => {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        if (line.toLowerCase().includes(normalizedQuery)) {
          results.push({
            path: childRelative,
            line: lineIndex + 1,
            text: line.slice(0, 240),
            matchType: 'content',
          });
        }
      });
    }
  }

  await walk(scope);
  if (results.length === 0) {
    async function addPhpScope(relativeDirectory, depth = 0) {
      if (depth > 6 || results.length >= 40) return;
      const directory = await resolveProjectPath(relativeDirectory, ownerWebContentsId);
      const entries = await fs.readdir(directory.target, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= 40 || isIgnoredName(entry.name) || isSensitivePath(entry.name)) continue;
        const childRelative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
        if (LOW_VALUE_PATH_PATTERN.test(childRelative)) continue;
        if (entry.isDirectory()) {
          if (depth < 4) await addPhpScope(childRelative, depth + 1);
          continue;
        }
        if (entry.isFile() && /\.php$/i.test(entry.name)
          && /(?:controllers?|models?|views?|services?|modules?|components?)/i.test(childRelative)) {
          results.push({ path: childRelative, line: 0, text: entry.name, matchType: 'scope-fallback', relationship: 'scope' });
        }
      }
    }
    await addPhpScope(scope);
  }
  const result = { query, scope, results, filesVisited, truncated: results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES };
  await appendAudit(root, 'search_code', `${scope}:${query}`, 'success');
  return result;
}

function limitOutput(value) {
  const text = String(value || '');
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = Math.floor(MAX_OUTPUT_CHARS * 0.7);
  const tail = MAX_OUTPUT_CHARS - head;
  return `${text.slice(0, head)}\n... output truncated ...\n${text.slice(-tail)}`;
}
function redactOutput(value) {
  return limitOutput(value).replace(/(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*\S+|\$_(?:ENV|SERVER)\s*\[[^\]]+\]\s*=>\s*[^\r\n]+)/gi, '[REDACTED]');
}
function redactRuntimeValue(value, key = '') {
  if (CREDENTIAL_ENV_PATTERN.test(key) || /authorization|cookie|session|^\$_(?:env|server)$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactRuntimeValue(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, childValue]) => [childKey, redactRuntimeValue(childValue, childKey)]));
  }
  return redactOutput(String(value ?? '')).slice(0, 1000);
}
function parseRuntimeFailure(output) {
  const text = String(output || '');
  const frames = [];
  const seen = new Set();
  const patterns = [
    /(?:at\s+(?:[^()\r\n]+\s+\()?|File\s+["'])([A-Za-z]:[\\/][^()\r\n"']+|\/[^()\r\n"']+|[^()\s:"']+\.[cm]?[jt]sx?|[^()\s:"']+\.py):(\d+)(?::(\d+))?/g,
    /File\s+["']([^"']+)["'],\s*line\s+(\d+)/g,
    /(?:PHP\s+(?:Fatal error|Parse error|Warning|Notice):.*?\s+in\s+|#\d+\s+)([A-Za-z]:[\\/][^()\r\n]+|\/[^()\r\n]+|[^()\s:()]+\.php)\s*(?:on line\s+|\()(\d+)/gi,
    /([A-Za-z]:[\\/][^()\r\n]+|\/[^()\r\n]+|[^()\s:()]+\.(?:php|java|kt|go|rb|cs|fs|vb|rs|py|js|jsx|ts|tsx))(?::(\d+)|\((\d+)(?::(\d+))?\))/gi,
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(text)) && frames.length < MAX_RUNTIME_FRAMES) {
      const line = Number(match[2] || match[3]);
      const column = match[4] ? Number(match[4]) : (match[3] && match[2] ? Number(match[3]) : null);
      const frameKey = `${match[1]}:${line}:${column || ''}`;
      if (seen.has(frameKey)) continue;
      seen.add(frameKey);
      frames.push({ file: match[1], line, column });
    }
  });
  const message = text.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && !/^(?:at\s|file\s|npm\s+(?:error|warn)|#\d+\s)/i.test(line)) || '';
  return { message: redactOutput(message).slice(0, 1000), frames, frameCount: frames.length };
}
async function mapRuntimeSource(root, runtimeFailure) {
  const mapped = [];
  for (const frame of runtimeFailure.frames || []) {
    try {
      const absolute = path.isAbsolute(frame.file) ? frame.file : path.resolve(root, frame.file);
      if (!isInsideRoot(root, await realPathOrParent(absolute))) continue;
      const relative = path.relative(root, absolute);
      if (isSensitivePath(relative)) continue;
      const target = await resolveWithinRoot(root, relative);
      const lines = (await fs.readFile(target.target, 'utf8')).split(/\r?\n/);
      const start = Math.max(0, frame.line - 1 - Math.floor(MAX_RUNTIME_SOURCE_LINES / 2));
      const end = Math.min(lines.length, start + MAX_RUNTIME_SOURCE_LINES);
      mapped.push({ file: relative, line: frame.line, column: frame.column, source: lines.slice(start, end).map((text, index) => ({ line: start + index + 1, text: redactOutput(text).slice(0, 240) })) });
    } catch {
      // Omit missing, inaccessible, or sensitive source locations.
    }
  }
  return mapped;
}
async function enrichRuntimeEvidence(root, stdout, stderr, options = {}) {
  const runtimeFailure = parseRuntimeFailure(`${stderr}\n${stdout}`);
  return {
    status: 'captured',
    observed: true,
    message: runtimeFailure.message,
    frames: runtimeFailure.frames,
    mapped: await mapRuntimeSource(root, runtimeFailure),
    redacted: true,
    debugger: {
      requested: Boolean(options.debuggerCapture),
      captured: false,
      reason: options.debuggerCapture ? 'Debugger locals capture requires a separately approved hook.' : 'Debugger locals capture is off by default.',
    },
  };
}
function safeEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env)
    .filter(([key]) => SAFE_ENV_KEYS.has(key) && !CREDENTIAL_ENV_PATTERN.test(key)));
}

async function runGit(args, ownerWebContentsId) {
  const root = await validateProjectRoot(ownerWebContentsId);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid git inspection request.');
  const allowed = args[0] === 'status' || (args[0] === 'diff' && args.every((arg) => ['diff', '--stat', '--name-only', '--no-ext-diff'].includes(arg)));
  if (!allowed) throw new Error('Only read-only git status and diff are permitted.');
  const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = limitOutput(stdout + chunk.toString()); });
  child.stderr.on('data', (chunk) => { stderr = limitOutput(stderr + chunk.toString()); });
  const result = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, error: error.message }));
    child.on('close', (code) => resolve({ code }));
  });
  await appendAudit(root, 'git_inspection', args.join(' '), result.code === 0 ? 'success' : 'failure');
  if (result.code !== 0) throw new Error(limitOutput(stderr || result.error || 'git inspection failed'));
  return { args, stdout, stderr };
}

const detectProjectType = detectProject;

function classifyProjectSignals({ hasPackageJson = false, composer = false, hasPhpFile = false, hasPhpUnitConfig = false } = {}) {
  return { isPhp: !hasPackageJson && Boolean(composer || hasPhpFile), hasPhpUnitConfig };
}

async function readComposer(root, relativePath) {
  if (!relativePath) return null;
  try {
    const file = await resolveWithinRoot(root, relativePath);
    return JSON.parse(await fs.readFile(file.target, 'utf8'));
  } catch {
    return null;
  }
}

async function hasProjectExecutable(root, relativePath) {
  try {
    const target = await resolveWithinRoot(root, relativePath);
    const stat = await fs.stat(target.target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findChangedPhpFiles(root) {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain', '--', '*.php'], { cwd: root, shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(0, MAX_OUTPUT_CHARS); });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(output.split(/\r?\n/).map((item) => item.slice(3).trim())
      .filter((item) => item && /\.php$/i.test(item) && !isSensitivePath(item)).slice(0, 20)));
  });
}

async function runVerification(script, ownerWebContentsId, options = {}) {
  const root = await validateProjectRoot(ownerWebContentsId);
  if (typeof script !== 'string' || !/^[a-z][a-z0-9:_-]{0,31}$/i.test(script)) throw new Error('Verification script name is invalid.');
  const scope = await resolveProjectScope(ownerWebContentsId, options.scope || '.');
  const scopedRoot = scope === '.' ? root : path.join(root, ...scope.split('/'));
  const projectType = await detectProjectType(scopedRoot);
  const rootProjectType = scope === '.' ? projectType : await detectProjectType(root);
  let phpCommand = null;
  if (projectType.type === 'php') {
    if (script === 'phpunit' && projectType.hasPhpUnitConfig
      && await hasProjectExecutable(root, process.platform === 'win32' ? 'vendor/bin/phpunit.bat' : 'vendor/bin/phpunit')) {
      phpCommand = { executable: process.platform === 'win32' ? 'vendor\\bin\\phpunit.bat' : './vendor/bin/phpunit', args: [] };
    } else if (script === 'phpunit' && projectType.hasPhpUnitConfig) {
      throw new Error('PHPUnit is not installed for this project (vendor/bin/phpunit not found); use php-lint instead.');
    } else if (script === 'composer-test' && projectType.composer) {
      const composer = await readComposer(root, projectType.composer);
      if (typeof composer?.scripts?.test === 'string' && composer.scripts.test.trim()
        && !UNSAFE_SCRIPT_PATTERN.test(composer.scripts.test)) {
        phpCommand = { executable: process.platform === 'win32' ? 'composer.bat' : 'composer', args: ['run-script', 'test'] };
      }
    } else if (script === 'php-lint') {
      const changedFiles = (await findChangedPhpFiles(root)).filter((file) => scope === '.' || file.replace(/\\/g, '/').startsWith(`${scope}/`));
      if (!changedFiles.length) throw new Error('NOT_AVAILABLE (no changed PHP files available for syntax lint).');
      phpCommand = { executable: 'php', args: changedFiles.map((file) => ['-l', file]).flat(), lintFiles: changedFiles };
    }
    if (!phpCommand) throw new Error('PHP verification is not available for the selected project or requested check.');
  }
  if (phpCommand) {
    const startedAt = Date.now();
    const safeEnv = safeEnvironment(process.env);
    const child = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(phpCommand.executable)
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${phpCommand.executable} ${phpCommand.args.join(' ')}`], { cwd: root, windowsHide: true, env: safeEnv })
      : spawn(phpCommand.executable, phpCommand.args, { cwd: root, shell: false, windowsHide: true, env: safeEnv });
    let stdout = '';
    let stderr = '';
    const appendBounded = (current, chunk) => current.length >= MAX_OUTPUT_CHARS ? current : (current + chunk.toString()).slice(0, MAX_OUTPUT_CHARS);
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish({ timedOut: true, exitCode: null }); }, MAX_COMMAND_DURATION_MS);
      child.on('error', (error) => finish({ error: error.message, exitCode: null }));
      child.on('close', (code) => finish({ exitCode: code }));
    });
    const durationMs = Date.now() - startedAt;
    if (result.timedOut) return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: 'Verification command timed out.', durationMs, timedOut: true, networkPolicy: NETWORK_POLICY };
    if (result.error) {
      const missing = /enoent|not found/i.test(result.error);
      return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: missing ? `${phpCommand.executable} not found in PATH.` : redactOutput(result.error), durationMs, spawnError: true, reason: missing ? `NOT_AVAILABLE (${phpCommand.executable} not found in PATH)` : undefined, networkPolicy: NETWORK_POLICY };
    }
    const ok = result.exitCode === 0;
    await appendAudit(root, 'run_php_verification', script, ok ? 'success' : `failure:exit-${result.exitCode}`);
    const runtimeEvidence = ok ? null : await enrichRuntimeEvidence(root, stdout, stderr, options);
    const phpunitPath = process.platform === 'win32' ? 'vendor/bin/phpunit.bat' : 'vendor/bin/phpunit';
    const reason = script === 'php-lint'
      && (projectType.hasPhpUnitConfig || rootProjectType.hasPhpUnitConfig || projectType.composer || rootProjectType.composer)
      && !await hasProjectExecutable(root, phpunitPath)
      ? 'PHPUnit is not installed for this project (vendor/bin/phpunit not found); php-lint fallback used.'
      : null;
    return { ok, script, exitCode: result.exitCode, stdout: redactOutput(stdout), stderr: redactOutput(stderr), durationMs, runtimeEvidence, reason, networkPolicy: NETWORK_POLICY, lintFiles: phpCommand.lintFiles };
  }
  if (projectType.type !== 'node') {
    const commandSpec = CHECK_COMMANDS[script];
    if (!commandSpec || !projectType.profile.checks.includes(script)) {
      throw new Error(`Verification check "${script}" is not available for detected project type "${projectType.type}".`);
    }
    const startedAt = Date.now();
    const safeEnv = safeEnvironment(process.env);
    const child = spawn(commandSpec.executable, commandSpec.args, { cwd: root, shell: false, windowsHide: true, env: safeEnv });
    let stdout = ''; let stderr = '';
    const appendBounded = (current, chunk) => current.length >= MAX_OUTPUT_CHARS ? current : (current + chunk.toString()).slice(0, MAX_OUTPUT_CHARS);
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish({ timedOut: true, exitCode: null }); }, MAX_COMMAND_DURATION_MS);
      child.on('error', (error) => finish({ error: error.message, exitCode: null }));
      child.on('close', (code) => finish({ exitCode: code }));
    });
    const durationMs = Date.now() - startedAt;
    if (result.error) {
      const missing = /enoent|not found/i.test(result.error);
      return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: missing ? `${commandSpec.executable} not found in PATH.` : redactOutput(result.error), reason: missing ? `NOT_AVAILABLE (${commandSpec.executable} not found in PATH)` : null, spawnError: true, durationMs, networkPolicy: NETWORK_POLICY };
    }
    if (result.timedOut) return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: 'Verification command timed out.', durationMs, timedOut: true, networkPolicy: NETWORK_POLICY };
    const ok = result.exitCode === 0;
    await appendAudit(root, 'run_verification', script, ok ? 'success' : `failure:exit-${result.exitCode}`);
    return { ok, script, exitCode: result.exitCode, stdout: redactOutput(stdout), stderr: redactOutput(stderr), durationMs, runtimeEvidence: ok ? null : await enrichRuntimeEvidence(root, stdout, stderr, options), networkPolicy: NETWORK_POLICY };
  }
  let packageJson;
  try {
    const packageFile = await resolveWithinRoot(root, 'package.json');
    packageJson = JSON.parse(await fs.readFile(packageFile.target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Selected project has no package.json.');
    throw new Error('Selected project package.json is invalid.');
  }

  const command = packageJson.scripts?.[script];
  if (typeof command !== 'string' || !command.trim()) throw new Error(`Verification script "${script}" is not defined.`);
  if (!SAFE_SCRIPT_NAMES.has(script.toLowerCase()) || UNSAFE_SCRIPT_PATTERN.test(command) || !SAFE_COMMAND_PATTERN.test(command)) {
    throw new Error(`Verification script "${script}" is not permitted.`);
  }

  async function runGit(args) {
    const root = await validateProjectRoot(ownerWebContentsId);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid git inspection request.');
    const allowed = args[0] === 'status' || (args[0] === 'diff' && args.every((arg) => ['diff', '--stat', '--name-only', '--no-ext-diff'].includes(arg)));
    if (!allowed) throw new Error('Only read-only git status and diff are permitted.');
    const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const result = await new Promise((resolve) => {
      child.on('error', (error) => resolve({ code: null, error: error.message }));
      child.on('close', (code) => resolve({ code }));
    });
    await appendAudit(root, 'git_inspection', args.join(' '), result.code === 0 ? 'success' : 'failure');
    if (result.code !== 0) throw new Error(limitOutput(stderr || result.error || 'git inspection failed'));
    return { args, stdout: limitOutput(stdout), stderr: limitOutput(stderr) };
  }
  const startedAt = Date.now();
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Windows exposes npm as a .cmd shim. Invoke it through the fixed command
  // interpreter, while the script name remains strictly validated above.
  const safeEnv = safeEnvironment(process.env);
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${executable} run ${script}`], { cwd: root, windowsHide: true, env: safeEnv })
    : spawn(executable, ['run', script], { cwd: root, shell: false, windowsHide: true, env: safeEnv });
  let stdout = '';
  let stderr = '';
  const appendBounded = (current, chunk) => current.length >= MAX_OUTPUT_CHARS
    ? current
    : (current + chunk.toString()).slice(0, MAX_OUTPUT_CHARS);
  child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
  const result = await new Promise((resolve) => {
    let settled = false;
    let cancellationTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      resolve(value);
    };
    const terminate = () => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(() => {
      terminate();
      finish({ timedOut: true, exitCode: null });
    }, MAX_COMMAND_DURATION_MS);
    if (typeof options.isCancelled === 'function') {
      cancellationTimer = setInterval(() => {
        if (!options.isCancelled()) return;
        terminate();
        finish({ cancelled: true, exitCode: null });
      }, 100);
    }
    child.on('error', (error) => finish({ error: error.message, exitCode: null }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
  const durationMs = Date.now() - startedAt;
  const project = path.basename(root);
  if (result.timedOut) {
    console.warn(`[DEV][VERIFY] project=${project} script=${script} exitCode=null durationMs=${durationMs} success=false timedOut=true`);
    await appendAudit(root, 'run_command', script, 'failure:timeout');
    return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: 'Verification command timed out.', durationMs, timedOut: true, networkPolicy: NETWORK_POLICY };
  }
  if (result.cancelled) {
    await appendAudit(root, 'run_command', script, 'cancelled');
    return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: 'Verification command cancelled.', durationMs, cancelled: true, networkPolicy: NETWORK_POLICY };
  }
  if (result.error) {
    console.warn(`[DEV][VERIFY] project=${project} script=${script} exitCode=null durationMs=${durationMs} success=false`);
    await appendAudit(root, 'run_command', script, 'failure:spawn');
    return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: redactOutput(result.error), durationMs, spawnError: true, networkPolicy: NETWORK_POLICY };
  }
  const ok = result.exitCode === 0;
  console.info(`[DEV][VERIFY] project=${project} script=${script} exitCode=${result.exitCode} durationMs=${durationMs} success=${ok}`);
  await appendAudit(root, 'run_command', script, ok ? 'success' : `failure:exit-${result.exitCode}`);
  const runtimeEvidence = ok ? null : await enrichRuntimeEvidence(root, stdout, stderr, options);
  return { ok, script, exitCode: result.exitCode, stdout: redactOutput(stdout), stderr: redactOutput(stderr), durationMs, runtimeEvidence, networkPolicy: NETWORK_POLICY };
}

async function getVerificationScripts(ownerWebContentsId, requested = []) {
  const root = await validateProjectRoot(ownerWebContentsId);
  const scope = arguments.length > 2 ? await resolveProjectScope(ownerWebContentsId, arguments[2]) : '.';
  const scopedRoot = scope === '.' ? root : path.join(root, ...scope.split('/'));
  const projectType = await detectProjectType(scopedRoot);
  if (projectType.type === 'php') {
    const rootProjectType = scope === '.' ? projectType : await detectProjectType(root);
    const composer = await readComposer(scopedRoot, projectType.composer)
      || await readComposer(root, rootProjectType.composer);
    const available = [];
    const phpunitPath = process.platform === 'win32' ? 'vendor/bin/phpunit.bat' : 'vendor/bin/phpunit';
    const phpunitInstalled = (projectType.hasPhpUnitConfig || rootProjectType.hasPhpUnitConfig)
      && (await hasProjectExecutable(scopedRoot, phpunitPath) || await hasProjectExecutable(root, phpunitPath));
    if (phpunitInstalled) available.push('phpunit');
    if (typeof composer?.scripts?.test === 'string' && composer.scripts.test.trim()
      && !UNSAFE_SCRIPT_PATTERN.test(composer.scripts.test)) available.push('composer-test');
    available.push('php-lint');
    const hasRequestedScripts = Array.isArray(requested) && requested.length > 0;
    const requestedNames = hasRequestedScripts
      ? requested.map((script) => String(script).trim().toLowerCase())
      : available;
    const unavailablePhpUnit = requestedNames.includes('phpunit') && !phpunitInstalled;
    const fallbackRequested = unavailablePhpUnit || (!hasRequestedScripts && !available.includes('phpunit'));
    const scripts = [...new Set([...requestedNames, ...(fallbackRequested ? ['php-lint'] : [])])]
      .filter((script) => available.includes(script) || script === 'php-lint');
    const missing = hasRequestedScripts
      ? [...new Set(requestedNames)].filter((script) => !scripts.includes(script) && script !== 'phpunit')
      : [];
    return {
      scripts,
      missing,
      reason: unavailablePhpUnit
        ? 'PHPUnit is not installed for this project (vendor/bin/phpunit not found); using php-lint fallback.'
        : scripts.length
          ? (missing.length ? `Verification checks are unavailable: ${missing.join(', ')}.` : (scripts.includes('php-lint') && (projectType.composer || rootProjectType.composer) ? 'PHPUnit is not installed for this project (vendor/bin/phpunit not found); using php-lint fallback.' : null))
          : 'NOT_AVAILABLE (PHP verification tools/configuration unavailable).',
    };
  }
  if (projectType.type !== 'node') {
    const checks = projectType.profile.checks || [];
    return { scripts: checks, missing: [], reason: checks.length ? null : `NOT_AVAILABLE (no verification profile for detected project type "${projectType.type}")`, projectType: projectType.type, language: projectType.language, confidence: projectType.confidence };
  }
  let packageJson;
  try {
    const packageFile = await resolveWithinRoot(root, 'package.json');
    packageJson = JSON.parse(await fs.readFile(packageFile.target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { scripts: [], reason: 'Selected project has no package.json.' };
    throw new Error('Selected project package.json is invalid.');
  }
  const hasRequestedScripts = Array.isArray(requested) && requested.length > 0;
  const scriptNames = hasRequestedScripts
    ? requested
    : ['typecheck', 'lint', 'test', 'build'];
  const normalizedScripts = [...new Set(scriptNames.map((script) => String(script).trim().toLowerCase()))];
  const scripts = normalizedScripts
    .filter((script) => SAFE_SCRIPT_NAMES.has(script))
    .filter((script) => typeof packageJson.scripts?.[script] === 'string' && packageJson.scripts[script].trim());
  const missing = hasRequestedScripts ? normalizedScripts.filter((script) => !scripts.includes(script)) : [];
  return {
    scripts,
    missing,
    reason: scripts.length ? (missing.length ? `Verification scripts are unavailable: ${missing.join(', ')}.` : null) : 'No safe verification scripts are defined in package.json.',
  };
}

function syncProjectStateToBackend(projectRoot) {
  try {
    const url = 'http://localhost:3001/api/coding/project-state';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot: projectRoot || null }),
    }).catch(() => undefined);
  } catch {}
}

async function setAuthoritativeProject(selectedRoot, ownerWebContentsId = null) {
  if (!selectedRoot || typeof selectedRoot !== 'string') {
    throw new Error('Valid project path is required.');
  }
  const resolved = await fs.realpath(selectedRoot);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Selected project path is not a directory.');
  authoritativeProjectRoot = resolved;
  authoritativeProjectStatus = PROJECT_STATUSES.ATTACHED;
  syncProjectStateToBackend(resolved);
  if (ownerWebContentsId !== undefined && ownerWebContentsId !== null) {
    projectRoots.set(ownerWebContentsId, resolved);
    projectDiscoveryMatches.delete(ownerWebContentsId);
  }
  return resolved;
}

function detachAuthoritativeProject() {
  authoritativeProjectRoot = null;
  authoritativeProjectStatus = PROJECT_STATUSES.DETACHED;
  syncProjectStateToBackend(null);
  projectRoots.clear();
  projectDiscoveryMatches.clear();
}

async function getProjectState(ownerWebContentsId = null) {
  if (authoritativeProjectStatus === PROJECT_STATUSES.DETACHED) {
    return { status: PROJECT_STATUSES.DETACHED, projectRoot: null, reason: 'Project was intentionally detached.' };
  }
  let candidate = (ownerWebContentsId !== null && ownerWebContentsId !== undefined && projectRoots.get(ownerWebContentsId))
    || authoritativeProjectRoot
    || (projectRoots.size === 1 ? [...projectRoots.values()][0] : null);

  if (!candidate && authoritativeProjectStatus !== PROJECT_STATUSES.DETACHED) {
    try {
      const response = await fetch('http://localhost:3001/api/coding/project-state', { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const backendState = await response.json();
        if (backendState && backendState.status === 'PROJECT_ATTACHED' && backendState.projectRoot) {
          candidate = backendState.projectRoot;
        }
      }
    } catch {}
  }

  if (!candidate) {
    if (authoritativeProjectStatus === PROJECT_STATUSES.MISSING) {
      return { status: PROJECT_STATUSES.MISSING, projectRoot: null, reason: 'Project directory is missing from disk.' };
    }
    return { status: PROJECT_STATUSES.NOT_ATTACHED, projectRoot: null, reason: 'No project attached.' };
  }

  try {
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) {
      authoritativeProjectStatus = PROJECT_STATUSES.MISSING;
      return { status: PROJECT_STATUSES.MISSING, projectRoot: candidate, reason: 'Project path is not a directory.' };
    }
  } catch (error) {
    authoritativeProjectStatus = PROJECT_STATUSES.MISSING;
    return { status: PROJECT_STATUSES.MISSING, projectRoot: candidate, reason: `Project directory missing: ${error.message}` };
  }

  authoritativeProjectRoot = candidate;
  authoritativeProjectStatus = PROJECT_STATUSES.ATTACHED;
  if (ownerWebContentsId !== null && ownerWebContentsId !== undefined) {
    projectRoots.set(ownerWebContentsId, candidate);
  }
  return { status: PROJECT_STATUSES.ATTACHED, projectRoot: candidate };
}

async function attachProject(projectRoot, ownerWebContentsId = null) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    return { status: PROJECT_STATUSES.NOT_ATTACHED, projectRoot: null, reason: 'No project path specified.' };
  }
  try {
    const resolved = await setAuthoritativeProject(projectRoot, ownerWebContentsId);
    return { status: PROJECT_STATUSES.ATTACHED, projectRoot: resolved };
  } catch (error) {
    authoritativeProjectStatus = PROJECT_STATUSES.MISSING;
    return { status: PROJECT_STATUSES.MISSING, projectRoot, reason: error.message };
  }
}

function clearProject(ownerWebContentsId) {
  detachAuthoritativeProject();
  if (ownerWebContentsId !== undefined) {
    projectRoots.delete(ownerWebContentsId);
    projectDiscoveryMatches.delete(ownerWebContentsId);
  }
}

function configureAuditDirectory(directory) {
  if (directory === null || directory === undefined) {
    auditDirectory = null;
    return;
  }
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
    || path.resolve(directory).toLowerCase() === path.parse(path.resolve(directory)).root.toLowerCase()) {
    throw new TypeError('Developer audit storage must be an absolute non-sensitive application-data path.');
  }
  auditDirectory = path.resolve(directory);
}

function releaseProject(ownerWebContentsId) {
  if (ownerWebContentsId !== undefined) {
    projectRoots.delete(ownerWebContentsId);
    projectDiscoveryMatches.delete(ownerWebContentsId);
  }
}

function getProjectRoot(ownerWebContentsId = null) {
  if (ownerWebContentsId !== null && ownerWebContentsId !== undefined) {
    return projectRoots.get(ownerWebContentsId) || null;
  }
  if (projectRoots.size === 1) return [...projectRoots.values()][0];
  if (projectRoots.size === 0 && authoritativeProjectStatus === PROJECT_STATUSES.ATTACHED && authoritativeProjectRoot) {
    return authoritativeProjectRoot;
  }
  return null;
}

async function detectDevServerConfiguration(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    return { detected: false, reason: 'No project root provided' };
  }

  const resolvedRoot = path.resolve(projectRoot);

  // 1. Check Node package.json
  try {
    const pkgPath = path.join(resolvedRoot, 'package.json');
    const pkgStat = await fs.stat(pkgPath);
    if (pkgStat.isFile()) {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      const devScript = ['dev', 'start', 'serve', 'watch'].find((s) => typeof scripts[s] === 'string');
      let port = 3000;
      let framework = 'node';

      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.vite) { framework = 'vite'; port = 5173; }
      else if (deps.next) { framework = 'next'; port = 3000; }
      else if (deps['@angular/core']) { framework = 'angular'; port = 4200; }
      else if (deps['react-scripts']) { framework = 'create-react-app'; port = 3000; }
      else if (deps.nuxt) { framework = 'nuxt'; port = 3000; }
      else if (deps.express) { framework = 'express'; port = 3000; }

      if (devScript) {
        const cmd = scripts[devScript];
        const portMatch = String(cmd).match(/(?:--port|-p)\s+([0-9]+)/);
        if (portMatch) port = parseInt(portMatch[1], 10);

        return {
          detected: true,
          type: 'node',
          framework,
          scriptName: devScript,
          command: `npm run ${devScript}`,
          port,
          confidence: 'HIGH',
        };
      }
    }
  } catch {}

  // 2. Check Python
  try {
    const managePy = path.join(resolvedRoot, 'manage.py');
    const manageStat = await fs.stat(managePy);
    if (manageStat.isFile()) {
      return {
        detected: true,
        type: 'python',
        framework: 'django',
        scriptName: 'runserver',
        command: 'python manage.py runserver',
        port: 8000,
        confidence: 'HIGH',
      };
    }
  } catch {}

  try {
    const appPy = path.join(resolvedRoot, 'app.py');
    const appStat = await fs.stat(appPy);
    if (appStat.isFile()) {
      return {
        detected: true,
        type: 'python',
        framework: 'flask-or-fastapi',
        scriptName: 'app.py',
        command: 'python app.py',
        port: 5000,
        confidence: 'MEDIUM',
      };
    }
  } catch {}

  // 3. Check PHP
  try {
    const artisanPath = path.join(resolvedRoot, 'artisan');
    const artisanStat = await fs.stat(artisanPath);
    if (artisanStat.isFile()) {
      return {
        detected: true,
        type: 'php',
        framework: 'laravel',
        scriptName: 'serve',
        command: 'php artisan serve',
        port: 8000,
        confidence: 'HIGH',
      };
    }
  } catch {}

  return { detected: false, reason: 'No dev server configuration recognized' };
}

module.exports = {
  chooseProjectFolder, listDirectory, readFile, searchCode, runVerification, runGit,
  getVerificationScripts, resolveWithinRoot, resolveProjectScope, normalizeScopedProjectPath, clearProject, releaseProject,
  assertProjectOwner, getProjectRoot, safeEnvironment, NETWORK_POLICY, isSensitivePath,
  discoverProjectByName, getProjectDiscoveryRoots, configureAuditDirectory, findEnclosingProjectRoot,
  rankProjectCandidates,
  redactRuntimeValue, parseRuntimeFailure, mapRuntimeSource, classifyProjectSignals,
  PROJECT_MANIFESTS, VERIFICATION_PROFILES,
  detectProjectType, detectDevServerConfiguration,
  getProjectState, attachProject, setAuthoritativeProject, detachAuthoritativeProject, PROJECT_STATUSES,
};
