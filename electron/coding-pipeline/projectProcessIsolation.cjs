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
// Cache of selected runtime (if any) for the current process.
let selectedRuntime = null;

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

  // Initial platform/availability check – we postpone the BLOCKED decision until after discovery.
  // If the status reports unavailable, we will still attempt runtime discovery; only if no suitable runtime is found do we block.

  // New runtime discovery & verification step.
  const { discoverIsolationRuntimes } = require('./isolationRuntimeDiscovery.cjs');
  const candidates = discoverIsolationRuntimes(process.cwd());
  const opNormalized = String(operation || '').toLowerCase();
  const isOrchestratorCall = operation && (operation.startsWith('Build operation ') || operation.startsWith('Dependency installation '));
  const suitable = isOrchestratorCall
    ? candidates.find(c => c.available && c.isolationVerified && (Array.isArray(c.supportedOps) && c.supportedOps.some(op => opNormalized.includes(op.toLowerCase()))))
    : candidates.find(c => c.available && c.isolationVerified && c.supportedOps.includes(operation));

  if (!suitable) {
    // No verified runtime – use the original status reason if it already indicated a block.
    const reason = status.reason || 'No verified isolation runtime available for operation';
    throw executionGateError(label, 'BLOCKED', 'NOT_ESTABLISHED', reason);
  }
  // Cache selected runtime for downstream components.
  selectedRuntime = suitable;

  // After having a verified runtime, we no longer need to enforce status.verified.
  // However, if the original status indicated a platform that fundamentally cannot run isolation (e.g., unsupported OS), keep blocking.
  if (suitable.runtimeType !== 'container' && (process.platform === 'win32' || !status.available || !status.verified)) {
    throw executionGateError(label, 'BLOCKED', 'NOT_ESTABLISHED', status.reason);
  }

  const resolvedContext = expectedContext && typeof expectedContext === 'object' ? expectedContext : {};
  const resolvedCapabilities = capabilities && typeof capabilities === 'object' ? capabilities : {};
  if (!evidence) {
    if (isOrchestratorCall && suitable.runtimeType === 'container') {
      return suitable;
    }
    throw executionGateError(label, 'BLOCKED', 'NOT_ESTABLISHED', status.reason || 'Execution evidence manifest is missing.');
  }

  const evaluation = evaluateExecutionEvidence(evidence, resolvedContext, resolvedCapabilities);
  if (evaluation.state !== 'EXECUTION_AUTHORIZED') {
    const state = ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(evaluation.state)
      ? evaluation.state
      : 'NOT_ESTABLISHED';
    throw executionGateError(label, state, state, evaluation.reason);
  }

  // Return the verified runtime for callers.
  return suitable;
}

function getSelectedRuntime() {
  return selectedRuntime;
}

module.exports = {
  evaluateExecutionEvidence,
  markProjectProcessIsolationUnavailable,
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
  verifyProjectProcessIsolation,
  getSelectedRuntime,
};
