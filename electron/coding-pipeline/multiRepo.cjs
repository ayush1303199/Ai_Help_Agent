/**
 * Multi-Repository Coordination & Baseline Snapshot Isolation Engine.
 * Manages cross-repo dependency graphs, baseline pre-change snapshots, and change ownership.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

    let preExistingChanges = [];
    try {
      const output = await new Promise((resolve) => {
        const proc = spawn('git', ['status', '--short'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', (d) => { out += d; });
        proc.on('close', (code) => {
          if (code === 0) resolve(out.trim());
          else resolve('');
        });
        proc.on('error', () => resolve(''));
      });

      preExistingChanges = output ? output.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    } catch {}

    const fileSnapshots = new Map();
    for (const f of filesToTrack) {
      const fullPath = path.isAbsolute(f) ? f : path.join(repoRoot, f);
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        fileSnapshots.set(fullPath, content);
      } catch {
        fileSnapshots.set(fullPath, null);
      }
    }

    const resolvedRoot = path.resolve(repoRoot);
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
      hasPreExistingChanges: preExistingChanges.length > 0,
      fileSnapshots,
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

  recordRepoModification(taskId, repoRoot, modifiedFiles = []) {
    if (!this._repoModifications) this._repoModifications = new Map();
    if (!this._repoModifications.has(taskId)) {
      this._repoModifications.set(taskId, new Map());
    }
    const resolvedRoot = path.resolve(repoRoot);
    const existing = this._repoModifications.get(taskId).get(resolvedRoot) || [];
    this._repoModifications.get(taskId).set(resolvedRoot, [...new Set([...existing, ...modifiedFiles])]);
  }

  async rollbackMultiRepoChanges(taskId) {
    if (!this._repoModifications || !this._repoModifications.has(taskId)) {
      return { ok: true, rolledBackRepos: [] };
    }

    const reposMap = this._repoModifications.get(taskId);
    const rolledBackRepos = [];

    for (const [repoRoot, files] of reposMap.entries()) {
      const baseline = this.getBaselineSnapshot(taskId, repoRoot);
      const preExisting = baseline ? baseline.preExistingChanges : [];
      const snapshots = baseline?.fileSnapshots || new Map();

      for (const file of files) {
        const fullPath = path.isAbsolute(file) ? file : path.join(repoRoot, file);
        const isPreExisting = preExisting.some((p) => p.includes(path.basename(file)));
        if (!isPreExisting) {
          let gitCheckoutSuccess = false;
          try {
            gitCheckoutSuccess = await new Promise((resolve) => {
              const proc = spawn('git', ['checkout', '--', file], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
              proc.on('close', (code) => resolve(code === 0));
              proc.on('error', () => resolve(false));
            });
          } catch {
            gitCheckoutSuccess = false;
          }

          // If git checkout was not successful or repo is not a git repo, fall back to file snapshot restoration
          if (!gitCheckoutSuccess && snapshots.has(fullPath)) {
            const originalContent = snapshots.get(fullPath);
            try {
              if (originalContent === null) {
                await fs.unlink(fullPath);
              } else {
                await fs.writeFile(fullPath, originalContent, 'utf8');
              }
            } catch {}
          }
        }
      }
      rolledBackRepos.push(repoRoot);
    }

    this._repoModifications.delete(taskId);
    return { ok: true, rolledBackRepos };
  }

  async executeCoordinatedChange(taskId, repoChanges = [], applyFn, verifyFn) {
    const applied = [];
    let failureEncountered = null;

    for (const change of repoChanges) {
      const { repoRoot, files = [], patch } = change;
      await this.captureBaselineSnapshot(taskId, repoRoot, files);

      try {
        const applyRes = await applyFn(repoRoot, patch, files);
        if (!applyRes || !applyRes.ok) {
          throw new Error(applyRes?.error || `Apply failed on repo: ${repoRoot}`);
        }
        this.recordRepoModification(taskId, repoRoot, files);
        applied.push(change);

        const verifyRes = await verifyFn(repoRoot);
        if (!verifyRes || !verifyRes.ok) {
          throw new Error(verifyRes?.error || `Verification failed on repo: ${repoRoot}`);
        }
      } catch (err) {
        failureEncountered = err.message;
        break;
      }
    }

    if (failureEncountered) {
      await this.rollbackMultiRepoChanges(taskId);
      return {
        ok: false,
        transactionalRollback: true,
        error: failureEncountered,
        rolledBackCount: applied.length,
      };
    }

    return { ok: true, appliedCount: applied.length };
  }
}

const multiRepoCoordinator = new MultiRepoCoordinator();

module.exports = {
  MultiRepoCoordinator,
  multiRepoCoordinator,
};
