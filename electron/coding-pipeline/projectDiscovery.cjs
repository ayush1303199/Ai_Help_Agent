'use strict';

/**
 * Safe Project Discovery Service for AI Coding Agent (Milestone V1).
 *
 * Inspects authorized attached workspaces to discover manifests, directory structures,
 * declared scripts, language/toolchain indicators, and determines workspace state:
 * EMPTY, PARTIALLY_INITIALIZED, or EXISTING_APPLICATION.
 *
 * Enforces session ownership authorization and honest reporting.
 * ZERO hardcoded application or project assumptions.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const developerFiles = require('../developerFiles.cjs');

const WORKSPACE_STATES = Object.freeze({
  EMPTY: 'EMPTY',
  PARTIALLY_INITIALIZED: 'PARTIALLY_INITIALIZED',
  EXISTING_APPLICATION: 'EXISTING_APPLICATION',
});

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.idea',
  '.vscode',
  '.gemini',
  'tmp',
  'temp',
  '__pycache__',
]);

const EXCLUDED_FILES = new Set([
  '.ds_store',
  'thumbs.db',
  '.dev-mode-audit.log',
]);

const MANIFEST_SIGNATURES = [
  { name: 'package.json', type: 'node', language: 'javascript' },
  { name: 'composer.json', type: 'php', language: 'php' },
  { name: 'Cargo.toml', type: 'rust', language: 'rust' },
  { name: 'go.mod', type: 'go', language: 'go' },
  { name: 'pyproject.toml', type: 'python', language: 'python' },
  { name: 'requirements.txt', type: 'python', language: 'python' },
  { name: 'setup.py', type: 'python', language: 'python' },
  { name: 'pom.xml', type: 'java', language: 'java' },
  { name: 'build.gradle', type: 'gradle', language: 'java' },
  { name: 'build.gradle.kts', type: 'gradle', language: 'kotlin' },
  { name: 'Makefile', type: 'make', language: 'c/cpp' },
  { name: 'CMakeLists.txt', type: 'cmake', language: 'c/cpp' },
  { name: 'Gemfile', type: 'ruby', language: 'ruby' },
];

const STANDARD_ENTRY_FILENAMES = [
  'index.ts', 'index.js', 'index.mjs', 'index.cjs',
  'main.ts', 'main.js', 'main.py', 'main.go',
  'app.ts', 'app.js', 'app.py',
  'server.ts', 'server.js', 'index.php',
  'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
  'src/main.rs', 'src/lib.rs', 'src/App.tsx', 'src/App.jsx',
];

/**
 * Verifies that the given projectRoot is authorized for the given session owner.
 */
async function verifyProjectAuthorization(projectRoot, ownerWebContentsId) {
  if (ownerWebContentsId === undefined || ownerWebContentsId === null) {
    return {
      isAuthorized: false,
      reason: 'Owner webContentsId is required for project authorization.',
    };
  }

  try {
    const authorizedRoot = developerFiles.getProjectRoot(ownerWebContentsId);
    if (!authorizedRoot) {
      return {
        isAuthorized: false,
        reason: 'No project root is currently attached for this session owner.',
      };
    }

    const canonicalInput = await fs.realpath(projectRoot);
    const canonicalAuth = await fs.realpath(authorizedRoot);

    if (canonicalInput.toLowerCase() !== canonicalAuth.toLowerCase()) {
      return {
        isAuthorized: false,
        reason: `Target path [${projectRoot}] is not the authorized project root for this session.`,
      };
    }

    return { isAuthorized: true, canonicalRoot: canonicalAuth };
  } catch (error) {
    return {
      isAuthorized: false,
      reason: `Authorization check failed: ${error.message}`,
    };
  }
}

/**
 * Safely inspects a workspace directory to discover architecture, manifests,
 * scripts, and determine workspace state.
 *
 * @param {Object} options
 * @param {string} options.projectRoot - Path to the workspace directory.
 * @param {number|null} [options.ownerWebContentsId] - Renderer owner ID for authorization check.
 * @param {string|null} [options.sessionId] - Session ID.
 * @param {number} [options.maxDepth=3] - Maximum directory traversal depth.
 * @returns {Promise<Object>} Discovered project details and evidence.
 */
async function discoverWorkspace({
  projectRoot,
  ownerWebContentsId = null,
  sessionId = null,
  maxDepth = 3,
} = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new TypeError('projectRoot must be a non-empty string path.');
  }

  // Enforce session authorization if ownerWebContentsId is provided
  if (ownerWebContentsId !== null && ownerWebContentsId !== undefined) {
    const auth = await verifyProjectAuthorization(projectRoot, ownerWebContentsId);
    if (!auth.isAuthorized) {
      return {
        status: 'UNAUTHORIZED',
        projectRoot,
        isAuthorized: false,
        workspaceState: null,
        error: auth.reason,
        evidence: [],
        manifests: [],
        scripts: {},
        languages: [],
        inaccessible: [{ path: projectRoot, reason: auth.reason }],
      };
    }
  }

  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(projectRoot);
  } catch (error) {
    return {
      status: 'INACCESSIBLE',
      projectRoot,
      isAuthorized: true,
      workspaceState: null,
      error: error.message,
      evidence: [],
      manifests: [],
      scripts: {},
      languages: [],
      inaccessible: [{ path: projectRoot, reason: error.message }],
    };
  }

  const evidence = [];
  const inaccessible = [];
  const warnings = [];
  const discoveredManifests = [];
  const scripts = {};
  const discoveredLanguages = new Set();
  const discoveredDirectories = [];
  const existingSourceFiles = [];
  const extensionCounts = new Map();

  let totalFilesCount = 0;
  let nonIgnoredFileCount = 0;

  // Safe recursive scan
  async function scanDir(currentDir, currentRel, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      inaccessible.push({ path: currentRel || '.', reason: err.message });
      return;
    }

    for (const entry of entries) {
      const entryRel = currentRel ? path.join(currentRel, entry.name).replace(/\\/g, '/') : entry.name;
      const lower = entry.name.toLowerCase();

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(lower)) continue;
        discoveredDirectories.push(entryRel);
        await scanDir(path.join(currentDir, entry.name), entryRel, depth + 1);
      } else if (entry.isFile()) {
        totalFilesCount += 1;
        if (EXCLUDED_FILES.has(lower)) continue;
        nonIgnoredFileCount += 1;
        existingSourceFiles.push(entryRel);

        const ext = path.extname(entry.name).toLowerCase();
        if (ext) {
          extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);
        }
      }
    }
  }

  await scanDir(canonicalRoot, '', 0);

  // 1. Check manifests at root
  for (const sig of MANIFEST_SIGNATURES) {
    const manifestPath = path.join(canonicalRoot, sig.name);
    try {
      const stat = await fs.stat(manifestPath);
      if (stat.isFile()) {
        discoveredLanguages.add(sig.language);
        let parsedContent = null;
        try {
          const raw = await fs.readFile(manifestPath, 'utf8');
          if (sig.name.endsWith('.json')) {
            parsedContent = JSON.parse(raw);
          } else {
            parsedContent = { rawText: raw.slice(0, 1000) };
          }
        } catch (parseErr) {
          warnings.push(`Manifest [${sig.name}] could not be fully parsed: ${parseErr.message}`);
          inaccessible.push({ path: sig.name, reason: `Parse error: ${parseErr.message}` });
        }

        const manifestInfo = {
          name: sig.name,
          type: sig.type,
          language: sig.language,
          parsed: parsedContent,
        };
        discoveredManifests.push(manifestInfo);

        // Extract declared scripts
        if (parsedContent && typeof parsedContent.scripts === 'object' && parsedContent.scripts !== null) {
          for (const [key, val] of Object.entries(parsedContent.scripts)) {
            if (typeof val === 'string') {
              scripts[key] = val;
            }
          }
        }

        evidence.push({
          type: 'MANIFEST',
          path: sig.name,
          details: `Discovered ${sig.type} project manifest (${sig.name})${parsedContent?.scripts ? ` with ${Object.keys(parsedContent.scripts).length} script(s)` : ''}`,
        });
      }
    } catch {}
  }

  // 2. Discover toolchain indicators based on extension frequency
  const extToLang = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.php': 'php',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.rb': 'ruby',
    '.c': 'c',
    '.cpp': 'cpp',
  };

  for (const [ext, count] of extensionCounts) {
    if (extToLang[ext] && count > 0) {
      discoveredLanguages.add(extToLang[ext]);
    }
  }

  // 3. Discover entrypoint files
  const discoveredEntrypoints = [];
  for (const entryCandidate of STANDARD_ENTRY_FILENAMES) {
    try {
      const fullPath = path.join(canonicalRoot, entryCandidate);
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        discoveredEntrypoints.push(entryCandidate);
        evidence.push({
          type: 'ENTRYPOINT',
          path: entryCandidate,
          details: `Discovered existing project entrypoint file: ${entryCandidate}`,
        });
      }
    } catch {}
  }

  // 4. Determine Workspace State
  let workspaceState = WORKSPACE_STATES.EMPTY;
  if (nonIgnoredFileCount === 0) {
    workspaceState = WORKSPACE_STATES.EMPTY;
  } else if (discoveredManifests.length > 0 || discoveredEntrypoints.length > 0 || nonIgnoredFileCount > 5) {
    workspaceState = WORKSPACE_STATES.EXISTING_APPLICATION;
  } else {
    // Some files exist (e.g. README or .gitignore or empty dirs), but not a full app
    workspaceState = WORKSPACE_STATES.PARTIALLY_INITIALIZED;
  }

  evidence.push({
    type: 'WORKSPACE_STATE',
    path: '.',
    details: `Workspace state determined as ${workspaceState} based on ${nonIgnoredFileCount} file(s) and ${discoveredManifests.length} manifest(s).`,
  });

  if (discoveredDirectories.length > 0) {
    evidence.push({
      type: 'DIRECTORY_STRUCTURE',
      path: '.',
      details: `Discovered structure with directories: ${discoveredDirectories.slice(0, 10).join(', ')}${discoveredDirectories.length > 10 ? ` (+${discoveredDirectories.length - 10} more)` : ''}`,
    });
  }

  return {
    status: 'DISCOVERED',
    projectRoot: canonicalRoot,
    isAuthorized: true,
    workspaceState,
    manifests: discoveredManifests,
    scripts,
    preferDeclaredScripts: Object.keys(scripts).length > 0,
    languages: [...discoveredLanguages],
    entrypoints: discoveredEntrypoints,
    directories: discoveredDirectories,
    fileCount: nonIgnoredFileCount,
    evidence,
    inaccessible,
    warnings,
  };
}

module.exports = {
  WORKSPACE_STATES,
  MANIFEST_SIGNATURES,
  STANDARD_ENTRY_FILENAMES,
  verifyProjectAuthorization,
  discoverWorkspace,
};
