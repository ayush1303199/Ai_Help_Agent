'use strict';

/**
 * Pluggable Module Resolver for AI Coding Agent (Milestone V11).
 *
 * Resolves module specifiers to bounded workspace-relative file paths.
 * Accounts for:
 * - Relative imports (./foo, ../bar)
 * - Extension probing (.ts, .tsx, .js, .jsx, .mjs, .cjs, .json)
 * - Index-file conventions (/index.ts, /index.js, etc.)
 * - Configured path aliases (tsconfig.json / jsconfig.json paths & baseUrl)
 * - Built-in Node modules and external package boundaries
 * - Strict root-traversal protection
 *
 * ZERO guesswork: Unresolved specifiers are explicitly recorded with reasons.
 */

const path = require('node:path');
const { isBuiltin } = require('node:module');

const RESOLUTION_STATUS = Object.freeze({
  RESOLVED_INTERNAL: 'RESOLVED_INTERNAL',
  RESOLVED_EXTERNAL: 'RESOLVED_EXTERNAL',
  RESOLVED_BUILTIN: 'RESOLVED_BUILTIN',
  UNRESOLVED_NOT_FOUND: 'UNRESOLVED_NOT_FOUND',
  UNRESOLVED_OUTSIDE_ROOT: 'UNRESOLVED_OUTSIDE_ROOT',
  UNRESOLVED_AMBIGUOUS: 'UNRESOLVED_AMBIGUOUS',
  UNRESOLVED_SYNTAX: 'UNRESOLVED_SYNTAX',
});

const DEFAULT_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);
const DEFAULT_INDEX_NAMES = Object.freeze(['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs']);

/**
 * Normalizes a relative path to standard POSIX-style slashes without leading './' or '/'
 */
function normalizeRelativePath(p) {
  if (typeof p !== 'string') return '';
  const trimmed = p.replace(/\\/g, '/').trim();
  if (trimmed === '.' || trimmed === './') return '';
  return trimmed.replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '');
}

/**
 * Checks if target stays strictly within project root
 */
function isPathInsideRoot(root, absoluteTarget) {
  const rel = path.relative(root, absoluteTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Parses path aliases from tsconfig.json or jsconfig.json structure
 */
function extractPathAliases(tsconfigJson = {}) {
  const compilerOptions = tsconfigJson.compilerOptions || {};
  const baseUrl = normalizeRelativePath(compilerOptions.baseUrl || '.');
  const rawPaths = compilerOptions.paths || {};

  const aliases = [];
  for (const [pattern, targets] of Object.entries(rawPaths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const prefix = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    const isWildcard = pattern.endsWith('/*');

    for (const target of targets) {
      const targetPrefix = target.endsWith('/*') ? target.slice(0, -2) : target;
      const resolvedTargetBase = baseUrl ? `${baseUrl}/${targetPrefix}` : targetPrefix;

      aliases.push({
        pattern,
        prefix,
        isWildcard,
        targetBase: normalizeRelativePath(resolvedTargetBase),
      });
    }
  }

  return { baseUrl, aliases };
}

/**
 * Resolves a specifier to a concrete workspace file or classifies it as external/builtin.
 *
 * @param {object} params
 * @param {string} params.fromFile - Project-relative path of the importing file
 * @param {string} params.specifier - The raw import/require specifier
 * @param {string} params.projectRoot - Authorized project root directory
 * @param {Set<string>|Map<string, any>} params.workspaceFiles - Set or Map of all known normalized workspace relative paths
 * @param {object} [params.aliasConfig] - Result of extractPathAliases
 * @param {string[]} [params.supportedExtensions] - File extensions to probe
 * @returns {object} Resolution result
 */
function resolveModuleSpecifier({
  fromFile,
  specifier,
  projectRoot,
  workspaceFiles,
  aliasConfig = null,
  supportedExtensions = DEFAULT_EXTENSIONS,
}) {
  const normFromFile = normalizeRelativePath(fromFile);
  const rawSpec = String(specifier || '').trim();

  if (!rawSpec) {
    return {
      status: RESOLUTION_STATUS.UNRESOLVED_SYNTAX,
      specifier: rawSpec,
      resolvedPath: null,
      reason: 'Empty or invalid module specifier.',
    };
  }

  // 1. Built-in module check
  if (isBuiltin(rawSpec) || rawSpec.startsWith('node:')) {
    return {
      status: RESOLUTION_STATUS.RESOLVED_BUILTIN,
      specifier: rawSpec,
      resolvedPath: rawSpec,
      reason: 'Standard Node.js built-in module.',
    };
  }

  const fileSet = workspaceFiles instanceof Set ? workspaceFiles : new Set(Object.keys(workspaceFiles || {}));

  // 2. Relative Imports (./ or ../)
  if (rawSpec.startsWith('./') || rawSpec.startsWith('../')) {
    const fromDir = path.posix.dirname(normFromFile);
    const candidateRelative = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, rawSpec));

    // Check traversal escaping root
    if (candidateRelative.startsWith('..') || path.isAbsolute(candidateRelative)) {
      return {
        status: RESOLUTION_STATUS.UNRESOLVED_OUTSIDE_ROOT,
        specifier: rawSpec,
        resolvedPath: null,
        reason: `Specifier [${rawSpec}] attempts to escape the authorized project root.`,
      };
    }

    const resolved = probeFileCandidates(candidateRelative, fileSet, supportedExtensions);
    if (resolved) {
      return {
        status: RESOLUTION_STATUS.RESOLVED_INTERNAL,
        specifier: rawSpec,
        resolvedPath: resolved,
        reason: 'Resolved relative workspace file.',
      };
    }

    return {
      status: RESOLUTION_STATUS.UNRESOLVED_NOT_FOUND,
      specifier: rawSpec,
      resolvedPath: null,
      reason: `Relative file candidate not found: [${candidateRelative}]`,
    };
  }

  // 3. Path Aliases (e.g. from tsconfig.json paths)
  if (aliasConfig && aliasConfig.aliases && aliasConfig.aliases.length > 0) {
    for (const alias of aliasConfig.aliases) {
      let candidateRelative = null;
      if (alias.isWildcard && rawSpec.startsWith(alias.prefix + '/')) {
        const remainder = rawSpec.slice(alias.prefix.length + 1);
        candidateRelative = path.posix.normalize(path.posix.join(alias.targetBase, remainder));
      } else if (!alias.isWildcard && rawSpec === alias.prefix) {
        candidateRelative = path.posix.normalize(alias.targetBase);
      }

      if (candidateRelative) {
        if (candidateRelative.startsWith('..')) {
          return {
            status: RESOLUTION_STATUS.UNRESOLVED_OUTSIDE_ROOT,
            specifier: rawSpec,
            resolvedPath: null,
            reason: `Alias target [${candidateRelative}] escapes project root.`,
          };
        }

        const resolved = probeFileCandidates(candidateRelative, fileSet, supportedExtensions);
        if (resolved) {
          return {
            status: RESOLUTION_STATUS.RESOLVED_INTERNAL,
            specifier: rawSpec,
            resolvedPath: resolved,
            reason: `Resolved via path alias pattern [${alias.pattern}].`,
          };
        }
      }
    }
  }

  // 4. BaseUrl-based non-relative imports
  if (aliasConfig && aliasConfig.baseUrl && aliasConfig.baseUrl !== '.') {
    const candidateRelative = path.posix.normalize(path.posix.join(aliasConfig.baseUrl, rawSpec));
    if (!candidateRelative.startsWith('..')) {
      const resolved = probeFileCandidates(candidateRelative, fileSet, supportedExtensions);
      if (resolved) {
        return {
          status: RESOLUTION_STATUS.RESOLVED_INTERNAL,
          specifier: rawSpec,
          resolvedPath: resolved,
          reason: 'Resolved via configured baseUrl.',
        };
      }
    }
  }

  // 5. External Package (node_modules / third-party dependency)
  if (!rawSpec.startsWith('.') && !rawSpec.startsWith('/')) {
    return {
      status: RESOLUTION_STATUS.RESOLVED_EXTERNAL,
      specifier: rawSpec,
      resolvedPath: rawSpec,
      packageName: extractPackageName(rawSpec),
      reason: 'External dependency package.',
    };
  }

  // 6. Absolute path inside project or fallback
  if (rawSpec.startsWith('/')) {
    const candidateRelative = normalizeRelativePath(rawSpec);
    const resolved = probeFileCandidates(candidateRelative, fileSet, supportedExtensions);
    if (resolved) {
      return {
        status: RESOLUTION_STATUS.RESOLVED_INTERNAL,
        specifier: rawSpec,
        resolvedPath: resolved,
        reason: 'Resolved root-relative workspace file.',
      };
    }
  }

  return {
    status: RESOLUTION_STATUS.UNRESOLVED_NOT_FOUND,
    specifier: rawSpec,
    resolvedPath: null,
    reason: `Unable to resolve specifier [${rawSpec}] to any workspace file or known package.`,
  };
}

/**
 * Probes file candidates for exact match, with extensions, and index files.
 */
function probeFileCandidates(basePath, fileSet, supportedExtensions = DEFAULT_EXTENSIONS) {
  const norm = normalizeRelativePath(basePath);

  // Exact match (e.g. ./utils/format.js)
  if (norm && fileSet.has(norm)) return norm;

  // Extension probes (e.g. ./utils/format -> ./utils/format.ts)
  if (norm) {
    for (const ext of supportedExtensions) {
      const candidate = `${norm}${ext}`;
      if (fileSet.has(candidate)) return candidate;
    }
  }

  // Index probes (e.g. ./components/Button -> ./components/Button/index.tsx, or root index.ts)
  for (const indexName of DEFAULT_INDEX_NAMES) {
    const candidate = norm ? `${norm}/${indexName}` : indexName;
    if (fileSet.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Extracts package name from an import specifier (e.g. @scope/pkg/subpath -> @scope/pkg)
 */
function extractPackageName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

module.exports = {
  RESOLUTION_STATUS,
  DEFAULT_EXTENSIONS,
  DEFAULT_INDEX_NAMES,
  normalizeRelativePath,
  isPathInsideRoot,
  extractPathAliases,
  resolveModuleSpecifier,
  probeFileCandidates,
  extractPackageName,
};
