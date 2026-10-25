'use strict';

/**
 * Semantic Project Graph Model & Dependency Tracker for AI Coding Agent (Milestone V11).
 *
 * Provides a modular, evidence-backed dependency and relationship graph for workspace files.
 * Replaces pure regex filename lists with resolved, bidirectional module and symbol connections.
 *
 * Invariants:
 * 1. Strict Root Boundary: All paths are bounded to authorized workspace root (POSIX normalized).
 * 2. Pluggable Resolution: Relative imports, path aliases (tsconfig/jsconfig), index files,
 *    and extension probing are accurately resolved via moduleResolver.cjs.
 * 3. Explicit Unresolved Preservation: Unresolved or ambiguous specifiers are never guessed;
 *    they remain explicitly recorded as unresolved with strict reasons.
 * 4. Incremental Invalidation: File additions, modifications, renames, and deletions invalidate
 *    only affected nodes and dependent edges with automatic reconciliation.
 * 5. Cyclic Safe: Graph traversal handles circular dependencies without infinite loops.
 * 6. Non-Authorizing Invariant: Graph evidence informs proposals and regression targets;
 *    it does not authorize mutations or bypass user approval.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const {
  RESOLUTION_STATUS,
  normalizeRelativePath,
  resolveModuleSpecifier,
} = require('./moduleResolver.cjs');

const GRAPH_VERSION = 1;

/**
 * Computes SHA-256 digest of content.
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

/**
 * Parses source code to extract symbols, definitions, references, imports, exports, and routes.
 */
function parseModuleAstEvidence(relativePath, content) {
  const normPath = normalizeRelativePath(relativePath);
  const symbols = [];
  const definitions = [];
  const references = [];
  const imports = [];
  const exports = [];
  const reExports = [];
  const routes = [];

  const lines = String(content || '').split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();

    // 1. Static Imports: import ... from '...' or import '...'
    const staticImportMatch = trimmed.match(/^import\s+(?:(type)\s+)?(?:([\s\S]+?)\s+from\s+)?['"]([^'"]+)['"]/);
    if (staticImportMatch) {
      const isTypeOnly = Boolean(staticImportMatch[1]);
      const clause = staticImportMatch[2] || '';
      const specifier = staticImportMatch[3];
      const importedSymbols = [];

      if (clause) {
        // Named imports { a, b as c }
        const namedMatch = clause.match(/\{([^}]+)\}/);
        if (namedMatch) {
          namedMatch[1].split(',').forEach((s) => {
            const sym = s.trim().split(/\s+as\s+/)[0].trim();
            if (sym) importedSymbols.push(sym);
          });
        }
        // Default import
        const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)/);
        if (defaultMatch && !clause.startsWith('{')) {
          importedSymbols.push('default');
        }
        // Namespace import * as foo
        if (clause.includes('* as ')) {
          importedSymbols.push('*');
        }
      }

      imports.push({
        specifier,
        importedSymbols,
        isTypeOnly,
        isDynamic: false,
        kind: 'STATIC_IMPORT',
        line: lineNum,
      });
    }

    // 2. CommonJS require: require('...')
    for (const reqMatch of trimmed.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      imports.push({
        specifier: reqMatch[1],
        importedSymbols: ['*'],
        isTypeOnly: false,
        isDynamic: false,
        kind: 'REQUIRE',
        line: lineNum,
      });
    }

    // 3. Dynamic import: import('...')
    for (const dynMatch of trimmed.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      imports.push({
        specifier: dynMatch[1],
        importedSymbols: ['*'],
        isTypeOnly: false,
        isDynamic: true,
        kind: 'DYNAMIC_IMPORT',
        line: lineNum,
      });
    }

    // 4. Re-exports: export { x } from '...' or export * from '...'
    const reExportMatch = trimmed.match(/^export\s+(?:(type)\s+)?(?:(\*)|(?:\{([^}]+)\}))\s+from\s+['"]([^'"]+)['"]/);
    if (reExportMatch) {
      const isWildcard = Boolean(reExportMatch[2]);
      const namedClause = reExportMatch[3] || '';
      const specifier = reExportMatch[4];
      const exportedSymbols = [];

      if (namedClause) {
        namedClause.split(',').forEach((s) => {
          const sym = s.trim().split(/\s+as\s+/)[0].trim();
          if (sym) exportedSymbols.push(sym);
        });
      }

      reExports.push({
        specifier,
        exportedSymbols,
        isWildcard,
        isTypeOnly: Boolean(reExportMatch[1]),
        line: lineNum,
      });
    }

    // 5. Symbol Definitions and Standard Exports
    const declMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (declMatch) {
      const kind = declMatch[1];
      const name = declMatch[2];
      const isExported = trimmed.startsWith('export ');

      const sym = { name, kind, line: lineNum, exported: isExported };
      symbols.push(sym);
      definitions.push(sym);

      if (isExported) {
        exports.push({ name, localName: name, isReExport: false, line: lineNum });
      }
    } else if (trimmed.startsWith('export default ')) {
      exports.push({ name: 'default', localName: 'default', isReExport: false, line: lineNum });
    }

    // 6. Generic Route Declarations (e.g. app.get('/api/...', handler), router.post(...), { method, path })
    const routeMatch = trimmed.match(/\b(?:app|router)\.(get|post|put|delete|patch|options|head)\(\s*['"]([^'"]+)['"]/i);
    if (routeMatch) {
      routes.push({
        method: routeMatch[1].toUpperCase(),
        path: routeMatch[2],
        line: lineNum,
      });
    } else {
      const routeObjMatch = trimmed.match(/\bmethod:\s*['"](GET|POST|PUT|DELETE|PATCH)['"],\s*path:\s*['"]([^'"]+)['"]/i);
      if (routeObjMatch) {
        routes.push({
          method: routeObjMatch[1].toUpperCase(),
          path: routeObjMatch[2],
          line: lineNum,
        });
      }
    }

    // 7. General Identifier References (function call invocations)
    const isDeclLine = /^(?:export\s+)?(?:async\s+)?function\b/.test(trimmed);
    for (const refMatch of trimmed.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const refName = refMatch[1];
      if (!['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'import', 'require'].includes(refName)) {
        if (!isDeclLine || !trimmed.includes(`function ${refName}`)) {
          references.push({ name: refName, line: lineNum });
        }
      }
    }
  });

  return {
    path: normPath,
    contentHash: sha256(content),
    symbols,
    definitions,
    references,
    imports,
    exports,
    reExports,
    routes,
  };
}

/**
 * Semantic Project Graph representation.
 */
class SemanticProjectGraph {
  constructor(projectRoot, options = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.aliasConfig = options.aliasConfig || null;
    this.supportedExtensions = options.supportedExtensions;

    // file -> NodeData
    this.nodes = new Map();
    // dependency edges: array of edge objects
    this.edges = [];
    // unresolved references
    this.unresolvedReferences = [];

    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.version = GRAPH_VERSION;
  }

  /**
   * Builds or re-indexes the entire workspace from an existing map of relativePath -> content
   */
  buildFromWorkspace(fileContentsMap = new Map()) {
    this.nodes.clear();
    this.edges = [];
    this.unresolvedReferences = [];

    const fileSet = new Set();
    for (const rawPath of fileContentsMap.keys()) {
      fileSet.add(normalizeRelativePath(rawPath));
    }

    // 1. Parse all files into nodes
    for (const [rawPath, content] of fileContentsMap.entries()) {
      const normPath = normalizeRelativePath(rawPath);
      const nodeData = parseModuleAstEvidence(normPath, content);
      this.nodes.set(normPath, nodeData);
    }

    // 2. Resolve all edges and re-exports
    this._resolveAllEdges(fileSet);

    this.updatedAt = new Date().toISOString();
    return this;
  }

  /**
   * Internal edge resolution across all nodes.
   */
  _resolveAllEdges(fileSet) {
    this.edges = [];
    this.unresolvedReferences = [];

    for (const [filePath, node] of this.nodes.entries()) {
      // Resolve regular imports
      for (const imp of node.imports) {
        const resolution = resolveModuleSpecifier({
          fromFile: filePath,
          specifier: imp.specifier,
          projectRoot: this.projectRoot,
          workspaceFiles: fileSet,
          aliasConfig: this.aliasConfig,
          supportedExtensions: this.supportedExtensions,
        });

        imp.status = resolution.status;
        imp.resolvedPath = resolution.resolvedPath;
        imp.reason = resolution.reason;

        if (resolution.status === RESOLUTION_STATUS.RESOLVED_INTERNAL) {
          this.edges.push({
            from: filePath,
            to: resolution.resolvedPath,
            specifier: imp.specifier,
            kind: imp.kind,
            importedSymbols: imp.importedSymbols,
            resolved: true,
            line: imp.line,
          });
        } else {
          this.unresolvedReferences.push({
            from: filePath,
            specifier: imp.specifier,
            status: resolution.status,
            reason: resolution.reason,
            line: imp.line,
          });
        }
      }

      // Resolve re-exports
      for (const reExp of node.reExports) {
        const resolution = resolveModuleSpecifier({
          fromFile: filePath,
          specifier: reExp.specifier,
          projectRoot: this.projectRoot,
          workspaceFiles: fileSet,
          aliasConfig: this.aliasConfig,
          supportedExtensions: this.supportedExtensions,
        });

        reExp.status = resolution.status;
        reExp.resolvedPath = resolution.resolvedPath;
        reExp.reason = resolution.reason;

        if (resolution.status === RESOLUTION_STATUS.RESOLVED_INTERNAL) {
          this.edges.push({
            from: filePath,
            to: resolution.resolvedPath,
            specifier: reExp.specifier,
            kind: 'RE_EXPORT',
            exportedSymbols: reExp.exportedSymbols,
            isWildcard: reExp.isWildcard,
            resolved: true,
            line: reExp.line,
          });
        } else {
          this.unresolvedReferences.push({
            from: filePath,
            specifier: reExp.specifier,
            status: resolution.status,
            reason: resolution.reason,
            line: reExp.line,
          });
        }
      }
    }
  }

  /**
   * Incremental invalidation when files are modified, added, or deleted.
   */
  invalidateFiles({ modified = [], deleted = [], added = [], fileContents = new Map() }) {
    // 1. Remove deleted files
    for (const rawDel of deleted) {
      const normDel = normalizeRelativePath(rawDel);
      this.nodes.delete(normDel);
    }

    // 2. Parse added and modified files
    for (const rawMod of [...modified, ...added]) {
      const normMod = normalizeRelativePath(rawMod);
      const content = fileContents.get(rawMod) ?? fileContents.get(normMod);
      if (content !== undefined) {
        const nodeData = parseModuleAstEvidence(normMod, content);
        this.nodes.set(normMod, nodeData);
      }
    }

    // 3. Re-resolve all edges with updated node set
    const fileSet = new Set(this.nodes.keys());
    this._resolveAllEdges(fileSet);

    this.updatedAt = new Date().toISOString();
    return this;
  }

  /**
   * Returns direct dependencies imported or re-exported by filePath.
   */
  getDirectDependencies(filePath) {
    const norm = normalizeRelativePath(filePath);
    const deps = new Set();
    for (const edge of this.edges) {
      if (edge.from === norm && edge.resolved && edge.to) {
        deps.add(edge.to);
      }
    }
    return Array.from(deps);
  }

  /**
   * Returns cyclic-safe transitive dependencies.
   */
  getTransitiveDependencies(filePath, maxDepth = 30) {
    const norm = normalizeRelativePath(filePath);
    const visited = new Set();
    const queue = [{ path: norm, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;

      const direct = this.getDirectDependencies(current.path);
      for (const dep of direct) {
        if (!visited.has(dep) && dep !== norm) {
          visited.add(dep);
          queue.push({ path: dep, depth: current.depth + 1 });
        }
      }
    }

    return Array.from(visited);
  }

  /**
   * Returns direct downstream dependents that import or re-export filePath.
   */
  getDirectDependents(filePath) {
    const norm = normalizeRelativePath(filePath);
    const dependents = new Set();
    for (const edge of this.edges) {
      if (edge.to === norm && edge.resolved) {
        dependents.add(edge.from);
      }
    }
    return Array.from(dependents);
  }

  /**
   * Returns cyclic-safe transitive downstream dependents.
   */
  getTransitiveDependents(filePath, maxDepth = 30) {
    const norm = normalizeRelativePath(filePath);
    const visited = new Set();
    const queue = [{ path: norm, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;

      const direct = this.getDirectDependents(current.path);
      for (const dep of direct) {
        if (!visited.has(dep) && dep !== norm) {
          visited.add(dep);
          queue.push({ path: dep, depth: current.depth + 1 });
        }
      }
    }

    return Array.from(visited);
  }

  /**
   * Finds importers of a specific symbol from a given file.
   */
  findImportersOfSymbol(filePath, symbolName) {
    const norm = normalizeRelativePath(filePath);
    const importers = [];

    for (const edge of this.edges) {
      if (edge.to === norm && edge.resolved) {
        const importsSymbol = (edge.importedSymbols || []).includes(symbolName)
          || (edge.importedSymbols || []).includes('*')
          || (edge.exportedSymbols || []).includes(symbolName)
          || edge.isWildcard;

        if (importsSymbol) {
          importers.push({
            file: edge.from,
            line: edge.line,
            kind: edge.kind,
            specifier: edge.specifier,
          });
        }
      }
    }

    return importers;
  }

  /**
   * Detects candidate affected files based on verified graph relationships.
   *
   * @param {string[]} modifiedFiles - Array of relative file paths proposed for modification
   * @returns {Array<{ file: string, reason: string, severity: 'HIGH' | 'MEDIUM' | 'LOW' }>}
   */
  detectAffectedFiles(modifiedFiles = []) {
    const affected = new Map();
    const normalizedMod = modifiedFiles.map(normalizeRelativePath);

    // 1. Mark modified files themselves
    for (const mod of normalizedMod) {
      const existsInGraph = this.nodes.has(mod);
      affected.set(mod, {
        file: mod,
        reason: existsInGraph ? 'DIRECTLY_MODIFIED' : 'DIRECTLY_MODIFIED (UNINDEXED_OR_NEW)',
        relationshipType: 'DIRECTLY_MODIFIED',
        severity: 'HIGH',
        edgeProvenance: [],
      });
    }

    // 2. Mark direct dependents
    for (const mod of normalizedMod) {
      const directDependents = this.getDirectDependents(mod);
      for (const dep of directDependents) {
        if (!affected.has(dep)) {
          const directEdges = this.edges.filter((e) => e.from === dep && e.to === mod);
          affected.set(dep, {
            file: dep,
            reason: `DIRECT_IMPORTER_OF: ${mod}`,
            relationshipType: 'DIRECT_IMPORTER',
            severity: 'HIGH',
            edgeProvenance: directEdges.map((e) => ({
              specifier: e.specifier,
              kind: e.kind,
              line: e.line,
            })),
          });
        }
      }
    }

    // 3. Mark transitive dependents
    for (const mod of normalizedMod) {
      const transitive = this.getTransitiveDependents(mod);
      for (const tran of transitive) {
        if (!affected.has(tran)) {
          affected.set(tran, {
            file: tran,
            reason: `TRANSITIVE_DEPENDENT_OF: ${mod}`,
            relationshipType: 'TRANSITIVE_DEPENDENT',
            severity: 'MEDIUM',
            edgeProvenance: [],
          });
        }
      }
    }

    return Array.from(affected.values());
  }

  /**
   * Returns rich detailed affected-files impact report with graph status and unresolved dependencies.
   */
  detectAffectedFilesDetailed(modifiedFiles = []) {
    const normalizedMod = modifiedFiles.map(normalizeRelativePath);
    const targets = this.detectAffectedFiles(modifiedFiles);

    const unresolvedDependencies = [];
    for (const mod of normalizedMod) {
      for (const unres of this.unresolvedReferences) {
        if (unres.from === mod) {
          unresolvedDependencies.push(unres);
        }
      }
    }

    let status = 'VERIFIED';
    if (this.nodes.size === 0) {
      status = 'EMPTY_GRAPH';
    } else if (unresolvedDependencies.length > 0 || this.unresolvedReferences.length > 0) {
      status = 'DEGRADED_UNRESOLVED';
    }

    return {
      status,
      targets,
      unresolvedDependencies,
      totalTargets: targets.length,
      provenance: {
        source: 'SEMANTIC_PROJECT_GRAPH',
        version: this.version,
        updatedAt: this.updatedAt,
      },
    };
  }

  /**
   * Explains the verified relationship path between fromFile and toFile.
   */
  explainRelationship(fromFile, toFile) {
    const normFrom = normalizeRelativePath(fromFile);
    const normTo = normalizeRelativePath(toFile);

    if (normFrom === normTo) {
      return { relationship: 'SELF', path: [normFrom], isDirect: true };
    }

    // Check direct edge
    const directEdges = this.edges.filter((e) => e.from === normFrom && e.to === normTo);
    if (directEdges.length > 0) {
      return {
        relationship: 'DIRECT_IMPORT',
        isDirect: true,
        path: [normFrom, normTo],
        edges: directEdges.map((e) => ({ specifier: e.specifier, kind: e.kind, line: e.line })),
      };
    }

    // BFS for shortest transitive path
    const queue = [[normFrom]];
    const visited = new Set([normFrom]);

    while (queue.length > 0) {
      const currentPath = queue.shift();
      const tail = currentPath[currentPath.length - 1];

      const direct = this.getDirectDependencies(tail);
      for (const next of direct) {
        if (next === normTo) {
          return {
            relationship: 'TRANSITIVE_DEPENDENT',
            isDirect: false,
            path: [...currentPath, normTo],
          };
        }
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([...currentPath, next]);
        }
      }
    }

    return { relationship: 'UNRELATED', isDirect: false, path: [] };
  }

  /**
   * Serializes graph summary for diagnostic, auditor, and workflow consumption.
   */
  toSummary() {
    return {
      version: this.version,
      projectRoot: this.projectRoot,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      totalNodes: this.nodes.size,
      totalEdges: this.edges.length,
      totalUnresolved: this.unresolvedReferences.length,
      capabilities: {
        staticImports: true,
        dynamicImports: true,
        reExports: true,
        pathAliases: Boolean(this.aliasConfig),
        resolvedPaths: true,
        cyclicSafe: true,
      },
      limitations: [
        'Deterministic regex & heuristic AST parsing (static references only)',
        'Dynamic expressions with runtime-computed paths remain unresolved by design',
      ],
    };
  }
}

/**
 * Factory to create a SemanticProjectGraph.
 */
function createSemanticProjectGraph(projectRoot, options = {}) {
  return new SemanticProjectGraph(projectRoot, options);
}

module.exports = {
  GRAPH_VERSION,
  sha256,
  parseModuleAstEvidence,
  SemanticProjectGraph,
  createSemanticProjectGraph,
};
