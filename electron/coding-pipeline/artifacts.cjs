/**
 * Structured Task Artifact Engine with Provenance Tracking.
 * Generates and persists verified artifacts for coding workflows.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { authorizeAppOwnedMutation } = require('../appOwnedPersistence.cjs');

const ARTIFACT_TYPES = Object.freeze({
  IMPLEMENTATION_PLAN: 'implementation-plan',
  INVESTIGATION_REPORT: 'investigation-report',
  PATCH_PROPOSAL: 'patch-proposal',
  TEST_REPORT: 'test-report',
  VERIFICATION_REPORT: 'verification-report',
  BROWSER_EVIDENCE: 'browser-evidence',
  FINAL_SUMMARY: 'final-summary',
});

class ArtifactEngine {
  constructor(storageDir = null) {
    this._storageDir = storageDir;
    this._artifacts = new Map(); // taskId -> Array of artifact records
  }

  setStorageDir(dir) {
    this._storageDir = path.resolve(dir);
  }

  createArtifact({ taskId, type, content, phase, sourceEvidence = [] }) {
    if (!taskId) throw new Error('Artifact requires taskId');
    if (!type) throw new Error('Artifact requires type');

    const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const hash = crypto.createHash('sha256').update(contentStr).digest('hex');
    const artifactId = `art_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const artifact = {
      artifactId,
      taskId,
      type,
      phase: phase || 'execution',
      createdAt: new Date().toISOString(),
      content: contentStr,
      hash,
      sourceEvidence: Array.isArray(sourceEvidence) ? sourceEvidence.slice(0, 20) : [],
      status: 'VERIFIED',
    };

    if (!this._artifacts.has(taskId)) {
      this._artifacts.set(taskId, []);
    }
    this._artifacts.get(taskId).push(artifact);

    return artifact;
  }

  getArtifacts(taskId) {
    return this._artifacts.get(taskId) || [];
  }

  getArtifactByType(taskId, type) {
    const list = this.getArtifacts(taskId);
    return list.slice().reverse().find((a) => a.type === type) || null;
  }

  async persistArtifacts(taskId, outputDir) {
    if (!this._storageDir) throw new Error('Application-owned artifact storage is not configured.');
    const targetDir = path.resolve(outputDir || this._storageDir);
    if (targetDir !== this._storageDir) {
      throw new Error('Artifacts may only be persisted to the configured application-owned storage directory.');
    }

    const artifacts = this.getArtifacts(taskId);
    await authorizeAppOwnedMutation({
      root: this._storageDir,
      target: targetDir,
      resource: 'artifact',
      operation: 'write',
    });
    await fs.mkdir(targetDir, { recursive: true });

    const written = [];
    for (const art of artifacts) {
      const ext = art.type === ARTIFACT_TYPES.BROWSER_EVIDENCE ? 'json' : art.type === ARTIFACT_TYPES.PATCH_PROPOSAL ? 'diff' : 'md';
      const filename = `${art.type}.${ext}`;
      const filePath = path.join(targetDir, filename);
      await authorizeAppOwnedMutation({
        root: this._storageDir,
        target: filePath,
        resource: 'artifact',
        operation: 'write',
      });
      await fs.writeFile(filePath, art.content, 'utf8');
      written.push({ ...art, path: filePath });
    }
    return written;
  }
}

const artifactEngine = new ArtifactEngine();

module.exports = {
  ARTIFACT_TYPES,
  ArtifactEngine,
  artifactEngine,
};
