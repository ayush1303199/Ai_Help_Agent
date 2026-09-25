const PROJECT_PROFILE_CONTRACT = Object.freeze({
  type: 'string',
  language: 'string',
  manifest: 'string|null',
  confidence: 'manifest|extension-guess|unknown',
  extensions: 'string[]',
  profile: 'object',
  detectedFiles: 'number',
});

const INDEX_SNAPSHOT_CONTRACT = Object.freeze({
  root: 'string',
  files: 'object',
  dependencyGraph: 'object',
  repositoryMap: 'object',
  createdAt: 'string',
});

module.exports = { PROJECT_PROFILE_CONTRACT, INDEX_SNAPSHOT_CONTRACT };
