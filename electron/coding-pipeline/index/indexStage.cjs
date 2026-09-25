const INDEX_STAGE = Object.freeze({
  name: 'INDEX',
  input: 'projectRoot + ProjectProfile',
  output: 'IndexSnapshot',
});

function runIndexStage(indexer, root, profile, previous = null) {
  if (!indexer || typeof indexer.buildIndex !== 'function') throw new Error('Index stage implementation is unavailable.');
  return indexer.buildIndex(root, previous).then((snapshot) => ({ ...snapshot, projectProfile: profile }));
}

module.exports = { INDEX_STAGE, runIndexStage };
