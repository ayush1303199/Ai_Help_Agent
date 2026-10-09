/**
 * Multi-Repository Coordination & Baseline Snapshot Isolation Engine.
 * Manages cross-repo dependency graphs, baseline pre-change snapshots, and change ownership.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

async function resolveSafeRepositoryFile(repoRoot, file) {
  const resolvedRoot = await fs.realpath(repoRoot);
  const fullPath = path.resolve(resolvedRoot, file);
  const relative = path.relative(resolvedRoot, fullPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Multi-repository target is outside its repository.');
  }
  const parent = await fs.realpath(path.dirname(fullPath));
  const parentRelative = path.relative(resolvedRoot, parent);
  if (parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new Error(`Multi-repository target parent escapes its repository: ${relative}`);
  }
  try {
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Multi-repository target is not a regular file: ${relative}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { resolvedRoot, fullPath, relative };
}

async function readRepositoryFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

class MultiRepoCoordinator {
  constructor() {
    this._repoGraphs = new Map(); // workspaceRoot -> dependency graph
    this._baselineSnapshots = new Map(); // taskId -> { repoRoot -> { status, headCommit, preExistingChanges } }
  }

  async discoverRepositoriesInWorkspace(workspaceRoot) {
    if (!workspaceRoot) return [];
    const resolvedRoot = path.resolve(workspaceRoot);
    const repos = [];

    try {
      const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'dist', 'build'].includes(entry.name)) continue;

        const subPath = path.join(resolvedRoot, entry.name);
        try {
          const gitStat = await fs.stat(path.join(subPath, '.git'));
          if (gitStat.isDirectory() || gitStat.isFile()) {
            repos.push({
              name: entry.name,
              root: subPath,
              isGitRepo: true,
            });
          }
        } catch {
          // Check if it has a manifest
          try {
            await fs.stat(path.join(subPath, 'package.json'));
            repos.push({ name: entry.name, root: subPath, isGitRepo: false, isPackage: true });
          } catch {}
        }
      }
    } catch {}

    // Check if workspaceRoot itself is a git repo
    try {
      const rootGit = await fs.stat(path.join(resolvedRoot, '.git'));
      if (rootGit.isDirectory() || rootGit.isFile()) {
        repos.unshift({ name: path.basename(resolvedRoot), root: resolvedRoot, isGitRepo: true, isRoot: true });
      }
    } catch {}

    return repos;
  }

  async buildCrossRepoDependencyGraph(repos = []) {
    const graph = {
      repositories: repos.map((r) => r.name),
      dependencies: {}, // repoName -> [dependsOnRepoNames]
      contracts: {},
    };

    for (const repo of repos) {
      graph.dependencies[repo.name] = [];

      // Check package.json dependencies
      try {
        const pkgPath = path.join(repo.root, 'package.json');
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        for (const other of repos) {
          if (other.name === repo.name) continue;
          if (allDeps[other.name] || Object.keys(allDeps).some((d) => d.includes(other.name))) {
            graph.dependencies[repo.name].push(other.name);
          }
        }
      } catch {}
    }

    return graph;
  }

  async captureBaselineSnapshot(taskId, repoRoot, filesToTrack = []) {
    if (!taskId || !repoRoot) return null;
    const resolvedRoot = await fs.realpath(repoRoot);

    const preExistingChanges = [];

    const fileSnapshots = new Map();
    for (const f of filesToTrack) {
      const { fullPath } = await resolveSafeRepositoryFile(resolvedRoot, f);
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        fileSnapshots.set(fullPath, content);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fileSnapshots.set(fullPath, null);
      }
    }

    const existingMap = this._baselineSnapshots.get(taskId);
    const existingSnapshot = existingMap?.get(resolvedRoot);
    if (existingSnapshot && existingSnapshot.fileSnapshots) {
      for (const [k, v] of existingSnapshot.fileSnapshots.entries()) {
        if (!fileSnapshots.has(k)) {
          fileSnapshots.set(k, v);
        }
      }
    }

    const snapshot = {
      taskId,
      repoRoot: resolvedRoot,
      timestamp: new Date().toISOString(),
      preExistingChanges,
      preExistingChangesStatus: 'NOT_VERIFIED_NO_OS_SANDBOX',
      hasPreExistingChanges: null,
      fileSnapshots,
      postSnapshots: new Map(),
    };

    if (!this._baselineSnapshots.has(taskId)) {
      this._baselineSnapshots.set(taskId, new Map());
    }
    this._baselineSnapshots.get(taskId).set(resolvedRoot, snapshot);

    return snapshot;
  }

  getBaselineSnapshot(taskId, repoRoot) {
    return this._baselineSnapshots.get(taskId)?.get(path.resolve(repoRoot)) || null;
  }

  async recordRepoModification(taskId, repoRoot, modifiedFiles = []) {
    if (!this._repoModifications) this._repoModifications = new Map();
    if (!this._repoModifications.has(taskId)) {
      this._repoModifications.set(taskId, new Map());
    }
    const resolvedRoot = path.resolve(repoRoot);
    const existing = this._repoModifications.get(taskId).get(resolvedRoot) || [];
    this._repoModifications.get(taskId).set(resolvedRoot, [...new Set([...existing, ...modifiedFiles])]);
    const baseline = this.getBaselineSnapshot(taskId, resolvedRoot);
    if (!baseline) throw new Error('Multi-repository rollback requires a captured baseline.');
    for (const file of modifiedFiles) {
      const { fullPath } = await resolveSafeRepositoryFile(resolvedRoot, file);
      try {
        baseline.postSnapshots.set(fullPath, await fs.readFile(fullPath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        baseline.postSnapshots.set(fullPath, null);
      }
    }
  }

  async getRollbackPlan(taskId) {
    if (!this._repoModifications || !this._repoModifications.has(taskId)) return [];
    const plan = [];
    for (const [repoRoot, files] of this._repoModifications.get(taskId).entries()) {
      const baseline = this.getBaselineSnapshot(taskId, repoRoot);
      if (!baseline) throw new Error('Multi-repository rollback baseline is missing.');
      const resolvedRoot = await fs.realpath(repoRoot);
      for (const file of files) {
        const fullPath = path.resolve(resolvedRoot, file);
        const relative = path.relative(resolvedRoot, fullPath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('Multi-repository rollback target is outside its repository.');
        }
        if (!baseline.fileSnapshots.has(fullPath) || !baseline.postSnapshots.has(fullPath)) {
          throw new Error(`Multi-repository rollback state is incomplete for ${relative}.`);
        }
        if (baseline.fileSnapshots.get(fullPath) === baseline.postSnapshots.get(fullPath)) continue;
        plan.push({
          repoRoot: resolvedRoot,
          path: relative,
          operation: baseline.fileSnapshots.get(fullPath) === null ? 'delete' : 'undo',
          deleteConfirmationRequired: baseline.fileSnapshots.get(fullPath) === null,
        });
      }
    }
    return plan;
  }

  async rollbackMultiRepoChanges(taskId, authorize) {
    if (!this._repoModifications || !this._repoModifications.has(taskId)) {
      return { ok: true, rolledBackRepos: [] };
    }
    if (typeof authorize !== 'function') {
      throw new Error('Multi-repository rollback requires the authoritative mutation policy.');
    }
    const reposMap = this._repoModifications.get(taskId);
    const rolledBackRepos = [];

    for (const [repoRoot, files] of reposMap.entries()) {
      const baseline = this.getBaselineSnapshot(taskId, repoRoot);
      if (!baseline) throw new Error('Multi-repository rollback baseline is missing.');
      const resolvedRoot = await fs.realpath(repoRoot);

      for (const file of files) {
        const { fullPath, relative } = await resolveSafeRepositoryFile(resolvedRoot, file);
        if (!baseline.fileSnapshots.has(fullPath) || !baseline.postSnapshots.has(fullPath)) {
          throw new Error(`Multi-repository rollback state is incomplete for ${relative}.`);
        }
        const original = baseline.fileSnapshots.get(fullPath);
        const expectedCurrent = baseline.postSnapshots.get(fullPath);
        if (original === expectedCurrent) continue;
        const readCurrent = async () => {
          try {
            const stat = await fs.lstat(fullPath);
            if (!stat.isFile() || stat.isSymbolicLink()) {
              throw new Error(`Multi-repository rollback target is not a regular file: ${relative}`);
            }
            return await fs.readFile(fullPath, 'utf8');
          } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
          }
        };
        if (await readCurrent() !== expectedCurrent) {
          throw new Error(`Multi-repository rollback refused because the target changed: ${relative}`);
        }
        const decision = await authorize({
          repoRoot: resolvedRoot,
          operation: original === null ? 'delete' : 'undo',
          paths: [relative],
          proposalApproved: true,
          rollback: true,
          deleteConfirmationRequired: original === null,
        });
        if (!decision || decision.allowed !== true) {
          throw new Error(decision?.reason || `Policy Gate denied multi-repository rollback for ${relative}.`);
        }
        if (await readCurrent() !== expectedCurrent) {
          throw new Error(`Multi-repository rollback target changed during authorization: ${relative}`);
        }
        if (original === null) {
          await fs.unlink(fullPath);
        } else {
          await fs.writeFile(fullPath, original, 'utf8');
        }
      }
      rolledBackRepos.push(repoRoot);
    }

    this._repoModifications.delete(taskId);
    return { ok: true, rolledBackRepos };
  }

  async executeCoordinatedChange() {
    throw new Error(
      'Callback-based coordinated changes are disabled because callbacks can mutate outside the authorized target set.',
    );
  }
}

const multiRepoCoordinator = new MultiRepoCoordinator();

module.exports = {
  MultiRepoCoordinator,
  multiRepoCoordinator,
};
