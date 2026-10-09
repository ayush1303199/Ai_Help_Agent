const reason = 'Project-context process execution is disabled because no verified operating-system sandbox is configured.';

function requireProjectProcessIsolation(operation) {
  const label = typeof operation === 'string' && operation.trim()
    ? operation.trim()
    : 'Project command';
  throw new Error(`${label} was not started. ${reason}`);
}

function projectProcessIsolationStatus() {
  return Object.freeze({
    available: false,
    reason,
    platform: process.platform,
  });
}

module.exports = {
  requireProjectProcessIsolation,
  projectProcessIsolationStatus,
};
