import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import artifactsModule from '../electron/coding-pipeline/artifacts.cjs';

const { ArtifactEngine } = artifactsModule;
const engine = new ArtifactEngine();
const artifact = engine.createArtifact({
  taskId: 'offline-contract-test',
  type: 'verification-report',
  content: { result: 'PASS' },
  sourceEvidence: ['fixture'],
});

assert.equal(artifact.status, 'UNVERIFIED');
assert.equal(
  artifact.hash,
  crypto.createHash('sha256').update(artifact.content).digest('hex'),
);
assert.equal(engine.getArtifacts('offline-contract-test')[0], artifact);

console.log('Artifact status remains unverified; content digest is structural metadata only.');
