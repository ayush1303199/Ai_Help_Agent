const supportedPlatforms = new Set(['win32', 'darwin', 'linux']);

function projectProcessIsolationStatus(platform = process.platform) {
  const supportedPlatform = supportedPlatforms.has(platform);
  const reason = supportedPlatform
    ? 'Project-context process execution is disabled because no verified operating-system sandbox is configured.'
    : `Project-context process execution is unsupported on platform "${platform}".`;
  return Object.freeze({
    available: false,
    verified: false,
    platformRecognized: supportedPlatform,
    reason,
    platform,
  });
}

function requireProjectProcessIsolation(operation) {
  const label = typeof operation === 'string' && operation.trim()
    ? operation.trim()
    : 'Project command';
  throw new Error(`${label} was not started. ${projectProcessIsolationStatus().reason}`);
}

module.exports = {
  requireProjectProcessIsolation,
  projectProcessIsolationStatus,
};
