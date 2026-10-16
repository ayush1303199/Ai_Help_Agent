const CLAIM_OPERATIONS = Object.freeze({
  runtimeIdentityVerified: 'runtime-identity-observation',
  networkPolicyEnforced: 'endpoint-policy-observation',
  processCreated: 'process-creation',
  processTerminated: 'process-termination',
  launcherTerminated: 'launcher-termination',
  guestTerminated: 'guest-termination',
  workerTerminated: 'worker-termination',
  processTreeTerminated: 'process-tree-termination',
  resourceCreated: 'resource-creation',
  resourceDeleted: 'resource-deletion',
  stagingDirectoryRemoved: 'staging-directory-removal',
  sandboxHandlesReleased: 'handle-release',
  secureErasureProven: 'secure-erasure',
  jobComplete: 'execution-completion',
  cancelled: 'cancellation',
  executionCompleted: 'execution-completion',
  executionTimedOut: 'execution-timeout',
  executionCancelled: 'cancellation',
  cleanupVerified: 'cleanup-verification',
  quarantined: 'quarantine',
});
const MAX_LIFECYCLE_OBSERVATION_AGE_MS = 5 * 60 * 1000;

function evaluateLifecycleClaim(claim, evidence = null, expected = {}) {
  if (!Object.prototype.hasOwnProperty.call(CLAIM_OPERATIONS, claim)) {
    return {
      state: 'BLOCKED',
      reasonCode: 'CLAIM_INVALID',
      reason: `Lifecycle claim is invalid or unsupported: ${String(claim)}.`,
    };
  }
  const operation = CLAIM_OPERATIONS[claim];

  const bindings = ['runId', 'providerId', 'workerIdentity', 'resourceId'];
  if (!expected || typeof expected !== 'object'
    || bindings.some((field) => typeof expected[field] !== 'string' || !expected[field].trim())) {
    return {
      state: 'BLOCKED',
      reasonCode: 'LIFECYCLE_BINDING_CONTEXT_MISSING',
      reason: 'Run, provider, worker, and resource bindings are required to evaluate lifecycle evidence.',
    };
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      state: 'NOT_ESTABLISHED',
      reasonCode: 'NOT_ESTABLISHED',
      reason: `Lifecycle claim '${claim}' has no observation.`,
    };
  }

  if (bindings.some((field) => evidence[field] !== expected[field])
    || evidence.operation !== operation
    || evidence.claim !== claim) {
    return {
      state: 'BLOCKED',
      reasonCode: 'LIFECYCLE_BINDING_MISMATCH',
      reason: `Lifecycle evidence does not match the expected run, provider, worker, resource, and '${operation}' operation.`,
    };
  }

  if (evidence.value !== true || evidence.contradictory === true) {
    return {
      state: 'UNCERTAIN',
      reasonCode: 'LIFECYCLE_OBSERVATION_INCOMPLETE',
      reason: `Lifecycle observation for '${claim}' is missing, false, or contradictory.`,
    };
  }

  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const currentTime = Date.now();
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
    || observedAt > currentTime || expiresAt <= observedAt) {
    return {
      state: 'BLOCKED',
      reasonCode: 'LIFECYCLE_OBSERVATION_INVALID',
      reason: `Lifecycle observation for '${claim}' has malformed or contradictory timestamps.`,
    };
  }
  if (expiresAt <= currentTime || currentTime - observedAt > MAX_LIFECYCLE_OBSERVATION_AGE_MS) {
    return {
      state: 'BLOCKED',
      reasonCode: 'LIFECYCLE_OBSERVATION_STALE',
      reason: `Lifecycle observation for '${claim}' is expired or older than the maximum permitted age.`,
    };
  }

  return {
    state: 'NOT_ESTABLISHED',
    reasonCode: claim === 'secureErasureProven' ? 'SECURE_ERASURE_NOT_ESTABLISHED' : 'HOST_EVIDENCE_ISSUER_MISSING',
    reason: claim === 'secureErasureProven'
      ? 'A structurally valid observation does not prove secure erasure; no trusted issuer or verified erase semantics are available.'
      : `Lifecycle observation for '${claim}' is structurally bound, but no trusted host evidence issuer is available.`,
  };
}

function createLifecycleObservationLedger() {
  const seenOperations = new Set();
  const seenNonces = new Set();
  const lastSequenceByResource = new Map();

  function review(claim, evidence, expected) {
    const structuralReview = evaluateLifecycleClaim(claim, evidence, expected);
    if (structuralReview.state !== 'NOT_ESTABLISHED') return structuralReview;

    if (typeof evidence.operationId !== 'string' || !evidence.operationId.trim()
      || typeof evidence.nonce !== 'string' || !evidence.nonce.trim()
      || !Number.isSafeInteger(evidence.sequenceNumber) || evidence.sequenceNumber < 1) {
      return {
        state: 'BLOCKED',
        reasonCode: 'LIFECYCLE_ENVELOPE_INCOMPLETE',
        reason: 'Lifecycle observation requires an operation ID, nonce, and positive safe-integer sequence number.',
      };
    }

    const scope = JSON.stringify([
      expected.runId,
      expected.providerId,
      expected.workerIdentity,
      expected.resourceId,
    ]);
    const operationKey = JSON.stringify([scope, evidence.operationId]);
    const nonceKey = JSON.stringify([scope, evidence.nonce]);
    const previousSequence = lastSequenceByResource.get(scope) || 0;
    if (seenOperations.has(operationKey) || seenNonces.has(nonceKey)
      || evidence.sequenceNumber <= previousSequence) {
      return {
        state: 'BLOCKED',
        reasonCode: 'LIFECYCLE_REPLAY_OR_REORDER',
        reason: 'Lifecycle operation IDs, nonces, and sequence numbers must be unique and strictly increasing within a run resource.',
      };
    }

    seenOperations.add(operationKey);
    seenNonces.add(nonceKey);
    lastSequenceByResource.set(scope, evidence.sequenceNumber);
    return structuralReview;
  }

  return Object.freeze({ review });
}

function transitionSandboxResourceState(state, event) {
  switch (event) {
    case 'launch-started':
      return state.launchState === 'starting'
        ? { ...state, launchState: 'started' }
        : state;
    case 'launch-failed':
      return state.launchState === 'starting'
        ? { ...state, launchState: 'failed' }
        : state;
    case 'shutdown-confirmed':
      return { ...state, shutdownConfirmed: true };
    case 'cleanup-failed':
      return { ...state, quarantined: true, leaseActive: true, cleanupVerified: false };
    case 'cleanup-succeeded':
      if (state.launchState === 'started'
        && (state.cleanupVerified !== true || state.stagingDirectoryRemoved !== true)) {
        throw new Error('Windows Sandbox cleanup cannot release its lease without verified shutdown and staging cleanup.');
      }
      return {
        ...state,
        quarantined: false,
        leaseActive: false,
      };
    default:
      throw new TypeError(`Unknown Windows Sandbox resource lifecycle event: ${event}`);
  }
}

function canDeleteSandboxTemporaryRoot(state) {
  if (state.quarantined === true) return false;
  if (state.launchState === 'preparing' || state.launchState === 'failed') return true;
  return state.launchState === 'started' && state.shutdownConfirmed === true;
}

function hasVerifiedShutdownObservation(observation, expectedLauncherPid) {
  return Boolean(
    observation
    && observation.launcherPid === expectedLauncherPid
    && observation.launcherTerminated === true
    && observation.sandboxClientsRemaining === 0
    && observation.ownedSandboxProcessCount === 0
    && observation.sandboxResourceAbsent === true
    && observation.sandboxHandlesReleased === true,
  );
}

function createSandboxResourceLifecycle({
  createTemporaryRoot,
  waitForShutdown,
  removeTemporaryRoot,
  verifyTemporaryRootRemoved,
}) {
  if (typeof createTemporaryRoot !== 'function'
    || typeof waitForShutdown !== 'function'
    || typeof removeTemporaryRoot !== 'function'
    || typeof verifyTemporaryRootRemoved !== 'function') {
    throw new TypeError('Windows Sandbox lifecycle dependencies must be functions.');
  }

  const resources = new WeakMap();
  const quarantined = new Set();
  let leaseActive = false;

  function getResource(resource) {
    const state = resources.get(resource);
    if (!state) throw new Error('Windows Sandbox resource is not owned by this lifecycle.');
    return state;
  }

  function apply(resource, event) {
    const state = getResource(resource);
    Object.assign(state, transitionSandboxResourceState(state, event));
    return state;
  }

  async function createResource({ runId = null } = {}) {
    if (leaseActive) throw new Error('A prior Windows Sandbox resource is still active or quarantined.');
    if (runId !== null && (typeof runId !== 'string' || !runId.trim())) {
      throw new TypeError('Windows Sandbox run identity must be a non-empty string.');
    }
    leaseActive = true;
    let temporaryRoot;
    try {
      temporaryRoot = await createTemporaryRoot();
    } catch (error) {
      leaseActive = false;
      throw error;
    }
    const resource = Object.freeze({});
    resources.set(resource, {
      runId,
      temporaryRoot,
      process: null,
      baselinePids: [],
      launchState: 'preparing',
      shutdownConfirmed: false,
      quarantined: false,
      leaseActive: true,
      cleanupVerified: false,
      launcherTerminated: false,
      resourceDeleted: false,
      stagingDirectoryRemoved: false,
      sandboxHandlesReleased: false,
      secureErasureProven: 'NOT_ESTABLISHED',
      shutdownObservation: null,
    });
    return resource;
  }

  function setBaselinePids(resource, baselinePids) {
    getResource(resource).baselinePids = [...baselinePids];
  }

  function getTemporaryRoot(resource) {
    return getResource(resource).temporaryRoot;
  }

  function markLaunchStarting(resource) {
    getResource(resource).launchState = 'starting';
  }

  function markLauncherStarted(resource, process) {
    const state = apply(resource, 'launch-started');
    state.process = process;
  }

  function markLaunchFailed(resource) {
    apply(resource, 'launch-failed');
  }

  async function cleanup(resource) {
    const state = getResource(resource);
    try {
      if (state.launchState === 'starting') {
        throw new Error('Windows Sandbox launch state is uncertain; temporary data was retained.');
      }
      if (state.launchState === 'started') {
        if (!state.process?.pid) {
          throw new Error('Windows Sandbox launcher ownership is uncertain; temporary data was retained.');
        }
        state.shutdownObservation = await waitForShutdown(state.process, state.baselinePids, state.temporaryRoot);
        if (!hasVerifiedShutdownObservation(state.shutdownObservation, state.process.pid)) {
          throw new Error('Windows Sandbox shutdown, resource absence, or handle release is unverified; temporary data was retained.');
        }
        apply(resource, 'shutdown-confirmed');
      }
      if (!canDeleteSandboxTemporaryRoot(state)) {
        throw new Error('Windows Sandbox shutdown was not confirmed; temporary data was retained.');
      }
      await removeTemporaryRoot(state.temporaryRoot);
      if (await verifyTemporaryRootRemoved(state.temporaryRoot) !== true) {
        throw new Error('Windows Sandbox staging directory removal could not be verified; temporary data was retained.');
      }
      const cleanupObservation = Object.freeze({
        launcherTerminated: state.launchState === 'started' ? state.shutdownObservation?.launcherTerminated === true : null,
        sandboxClientsRemaining: state.launchState === 'started' ? state.shutdownObservation?.sandboxClientsRemaining : null,
        sandboxResourceDeleted: state.launchState === 'started' ? state.shutdownObservation?.sandboxResourceAbsent === true : null,
        sandboxHandlesReleased: state.launchState === 'started' ? state.shutdownObservation?.sandboxHandlesReleased === true : null,
        stagingDirectoryRemoved: true,
        cleanupVerified: state.launchState === 'started'
          && state.shutdownObservation?.launcherTerminated === true
          && state.shutdownObservation?.sandboxClientsRemaining === 0
          && state.shutdownObservation?.ownedSandboxProcessCount === 0
          && state.shutdownObservation?.sandboxResourceAbsent === true
          && state.shutdownObservation?.sandboxHandlesReleased === true,
        resourceDeleted: state.launchState === 'started' ? state.shutdownObservation?.sandboxResourceAbsent === true : null,
        runId: state.runId || null,
        secureErasureProven: 'NOT_ESTABLISHED',
        evidenceState: 'NOT_ESTABLISHED',
      });
      state.launcherTerminated = cleanupObservation.launcherTerminated === true;
      state.resourceDeleted = cleanupObservation.resourceDeleted === true;
      state.sandboxHandlesReleased = cleanupObservation.sandboxHandlesReleased === true;
      state.stagingDirectoryRemoved = cleanupObservation.stagingDirectoryRemoved === true;
      state.cleanupVerified = cleanupObservation.cleanupVerified === true && state.stagingDirectoryRemoved;
      Object.assign(state, transitionSandboxResourceState(state, 'cleanup-succeeded'));
      resources.delete(resource);
      quarantined.delete(resource);
      leaseActive = false;
      return cleanupObservation;
    } catch (error) {
      apply(resource, 'cleanup-failed');
      quarantined.add(resource);
      throw error;
    }
  }

  function getStatus(resource) {
    const state = getResource(resource);
    return Object.freeze({
      launchState: state.launchState,
      shutdownConfirmed: state.shutdownConfirmed,
      quarantined: quarantined.has(resource),
      leaseActive,
      cleanupVerified: state.cleanupVerified,
      launcherTerminated: state.launcherTerminated,
      resourceDeleted: state.resourceDeleted,
      stagingDirectoryRemoved: state.stagingDirectoryRemoved,
      sandboxHandlesReleased: state.sandboxHandlesReleased,
      secureErasureProven: state.secureErasureProven,
    });
  }

  return Object.freeze({
    cleanup,
    createResource,
    getStatus,
    getTemporaryRoot,
    markLaunchFailed,
    markLaunchStarting,
    markLauncherStarted,
    setBaselinePids,
  });
}

module.exports = {
  MAX_LIFECYCLE_OBSERVATION_AGE_MS,
  canDeleteSandboxTemporaryRoot,
  createSandboxResourceLifecycle,
  createLifecycleObservationLedger,
  hasVerifiedShutdownObservation,
  evaluateLifecycleClaim,
  transitionSandboxResourceState,
};
