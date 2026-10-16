const {
  evaluateProviderEligibility,
  validateExecutionEvidenceManifest,
} = require('./executionEvidenceContract.cjs');
const { createCapabilityStateMap } = require('./providerAdapterContract.cjs');

const supportedPlatforms = new Set(['win32', 'darwin', 'linux']);
const windowsDisabledReason = 'Windows project-context process execution is disabled pending an independently reviewed isolation mechanism.';
const unsupportedPlatformCapabilities = createCapabilityStateMap({
  osEnforcedProcessIsolation: 'UNSUPPORTED',
  runtimeWorkerIdentityBinding: 'UNSUPPORTED',
  effectiveNetworkEndpointRestrictions: 'UNSUPPORTED',
  resourceFilesystemBoundaries: 'UNSUPPORTED',
  hostObservedProcessWorkerTermination: 'UNSUPPORTED',
  hostObservedResourceCleanup: 'UNSUPPORTED',
  evidenceFreshnessIntegrityReplayProtection: 'UNSUPPORTED',
  secureErasureEvidence: 'UNSUPPORTED',
});

function capabilityStatesForPlatform(platform) {
  if (platform !== 'win32') return unsupportedPlatformCapabilities;
  return createCapabilityStateMap({
    osEnforcedProcessIsolation: 'BLOCKED',
  });
}

function makeUnavailableStatus(
  reason = 'Project-context process execution is disabled because no verified operating-system sandbox is configured.',
  platform = process.platform,
) {
  return Object.freeze({
    available: false,
    verified: false,
    platformRecognized: supportedPlatforms.has(platform),
    reason,
    platform,
    capabilityStates: capabilityStatesForPlatform(platform),
  });
}

let currentStatus = makeUnavailableStatus();

function projectProcessIsolationStatus(platform = process.platform) {
  if (platform !== process.platform) {
    const supportedPlatform = supportedPlatforms.has(platform);
    return makeUnavailableStatus(
      supportedPlatform
        ? `Project-context process execution has not been verified on platform "${platform}".`
        : `Project-context process execution is unsupported on platform "${platform}".`,
      platform,
    );
  }
  if (process.platform === 'win32') {
    return makeUnavailableStatus(windowsDisabledReason);
  }
  return currentStatus;
}

async function verifyProjectProcessIsolation() {
  const reason = process.platform === 'win32'
    ? windowsDisabledReason
    : `Project-context process execution has no verified sandbox adapter for platform "${process.platform}".`;
  currentStatus = makeUnavailableStatus(reason);
  return currentStatus;
}

function markProjectProcessIsolationUnavailable(reason) {
  const detail = typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : 'The Windows Sandbox runner failed after its initial probe.';
  currentStatus = makeUnavailableStatus(`Windows Sandbox isolation is no longer verified: ${detail.slice(0, 400)}`);
}

function evaluateExecutionEvidence(manifest, expectedContext = {}, capabilities = {}) {
  const evidenceResult = validateExecutionEvidenceManifest(manifest, expectedContext);
  if (evidenceResult.state !== 'EXECUTION_AUTHORIZED') {
    return evidenceResult;
  }
  return evaluateProviderEligibility(capabilities, evidenceResult);
}

function executionGateError(operation, status, evidenceState, reason) {
  const error = new Error(`${operation} was not started. ${reason}`);
  error.code = 'PROJECT_EXECUTION_BLOCKED';
  error.executionBlocked = true;
  error.executionStatus = status;
  error.evidenceState = evidenceState;
  return error;
}

function requireProjectProcessIsolation(operation, evidence = null, expectedContext = null, capabilities = {}) {
  const label = typeof operation === 'string' && operation.trim()
    ? operation.trim()
    : 'Project command';
  const status = projectProcessIsolationStatus();
  if (process.platform === 'win32' || !status.available || !status.verified) {
    throw executionGateError(label, 'BLOCKED', 'NOT_ESTABLISHED', status.reason);
  }

  const resolvedContext = expectedContext && typeof expectedContext === 'object' ? expectedContext : {};
  const resolvedCapabilities = capabilities && typeof capabilities === 'object' ? capabilities : {};
  if (!evidence) {
    throw executionGateError(label, 'BLOCKED', 'NOT_ESTABLISHED', 'Execution evidence manifest is missing.');
  }

  const evaluation = evaluateExecutionEvidence(evidence, resolvedContext, resolvedCapabilities);
  if (evaluation.state !== 'EXECUTION_AUTHORIZED') {
    const state = ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(evaluation.state)
      ? evaluation.state
      : 'NOT_ESTABLISHED';
    throw executionGateError(label, state, state, evaluation.reason);
  }
}

module.exports = {
  evaluateExecutionEvidence,
  markProjectProcessIsolationUnavailable,
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
  verifyProjectProcessIsolation,
};
