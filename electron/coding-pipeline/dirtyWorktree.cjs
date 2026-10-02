const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

class DirtyWorktreeProtector {
  constructor() {
    this._baselines = new Map(); // taskId -> { repoRoot, preExistingFiles: Map<path, { hash, content }> }
  }

  async capturePreExistingBaseline(taskId, repoRoot, filesToInspect = []) {
    const preExistingFiles = new Map();
    for (const relPath of filesToInspect) {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath);
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        const hash = sha256(content);
        preExistingFiles.set(relPath, {
          fullPath,
          hash,
          content,
          capturedAt: new Date().toISOString(),
        });
      } catch {
        // File does not exist yet; not a pre-existing dirty file
      }
    }

    const baseline = {
      taskId,
      repoRoot,
      preExistingFiles,
      capturedAt: new Date().toISOString(),
    };
    this._baselines.set(taskId, baseline);
    return baseline;
  }

  getBaseline(taskId) {
    return this._baselines.get(taskId) || null;
  }

  async verifyDirtyWorktreePreserved(taskId, agentTargetFiles = []) {
    const baseline = this.getBaseline(taskId);
    if (!baseline) {
      return { ok: true, verifiedCount: 0, violations: [] };
    }

    const violations = [];
    let preservedCount = 0;
    const normalizedAgentTargets = new Set(
      agentTargetFiles.map((f) => path.normalize(f))
    );

    for (const [relPath, recorded] of baseline.preExistingFiles.entries()) {
      const normalizedRel = path.normalize(relPath);
      // Skip files intentionally modified by the approved proposal
      if (normalizedAgentTargets.has(normalizedRel)) {
        continue;
      }

      try {
        const currentContent = await fs.readFile(recorded.fullPath, 'utf8');
        const currentHash = sha256(currentContent);
        if (currentHash !== recorded.hash) {
          violations.push({
            file: relPath,
            expectedHash: recorded.hash,
            actualHash: currentHash,
            reason: 'PRE_EXISTING_USER_FILE_UNINTENTIONALLY_MODIFIED',
          });
        } else {
          preservedCount += 1;
        }
      } catch (err) {
        violations.push({
          file: relPath,
          reason: `PRE_EXISTING_FILE_MISSING: ${err.message}`,
        });
      }
    }

    return {
      ok: violations.length === 0,
      preservedCount,
      violations,
      verifiedAt: new Date().toISOString(),
    };
  }

  calculateAgentDelta(preApplySnapshots = [], postApplySnapshots = []) {
    const preMap = new Map(preApplySnapshots.map((s) => [s.path, s.hash]));
    const agentDelta = [];

    for (const post of postApplySnapshots) {
      const preHash = preMap.get(post.path);
      if (!preHash || preHash !== post.hash) {
        agentDelta.push({
          path: post.path,
          preHash: preHash || null,
          postHash: post.hash,
          type: preHash ? 'MODIFIED' : 'CREATED',
        });
      }
    }
    return agentDelta;
  }
}

const dirtyWorktreeProtector = new DirtyWorktreeProtector();

module.exports = {
  DirtyWorktreeProtector,
  dirtyWorktreeProtector,
};
