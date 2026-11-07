const {
  createResultEnvelope,
  evaluateResultEnvelope,
} = require('./executionEvidenceContract.cjs');

const CAPABILITY_STATE_VALUES = Object.freeze([
  'SUPPORTED',
  'UNSUPPORTED',
  'BLOCKED',
  'UNCERTAIN',
  'NOT_ESTABLISHED',
]);
const ISOLATION_CAPABILITIES = Object.freeze([
  'osEnforcedProcessIsolation',
  'runtimeWorkerIdentityBinding',
  'effectiveNetworkEndpointRestrictions',
  'resourceFilesystemBoundaries',
  'hostObservedProcessWorkerTermination',
  'hostObservedResourceCleanup',
  'evidenceFreshnessIntegrityReplayProtection',
  'secureErasureEvidence',
]);
const TRUSTED_SUPERVISOR_OPERATIONS = Object.freeze([
  'issueExecutionGrant',
  'consumeExecutionGrant',
  'allocateWorker',
  'observeWorkerReadiness',
  'observeEffectiveIsolation',
  'executeApprovedOperation',
  'enforceDeadlineAndCancellation',
  'collectHostEvidence',
  'terminateWorker',
  'verifyWorkerTerminationAndResourceRelease',
  'persistLifecycleState',
  'quarantineResource',
  'resolveQuarantine',
]);

// This checks method shape only; it does not establish trust or authorize execution.
/**
 * Authenticates a supervisor's identity against the OS boundary and credential contract.
 * Method-presence checks alone NEVER establish trust or authorize execution.
 *
 * @param {object} supervisor
 * @param {object} [options]
 * @returns {object} Authentication result { authenticated: boolean, state: string, reasonCode: string, reason: string }
 */
function authenticateSupervisor(supervisor, options = {}) {
  if (!supervisor || typeof supervisor !== 'object' || Array.isArray(supervisor)) {
    return {
      authenticated: false,
      state: 'UNAUTHENTICATED',
      reasonCode: 'SUPERVISOR_NOT_AN_OBJECT',
      reason: 'Supervisor must be a structured object with an authenticated OS boundary descriptor.',
    };
  }

  // 1. Caller-forged flag rejection
  if (
    supervisor.authenticated === true ||
    supervisor.trusted === true ||
    supervisor.verified === true ||
    supervisor.nativeSupervisorVerified === true ||
    supervisor.osEnforced === true ||
    supervisor.observerAuthenticated === true
  ) {
    return {
      authenticated: false,
      state: 'CALLER_FORGED',
      reasonCode: 'CALLER_FORGED_SUPERVISOR_IDENTITY',
      reason: 'Caller-supplied supervisor authentication or verification flags are rejected.',
    };
  }

  // 2. Extract identity descriptor
  const descriptor = typeof supervisor.getDescriptor === 'function'
    ? supervisor.getDescriptor()
    : (supervisor.observerDescriptor || supervisor.descriptor);

  if (!descriptor || typeof descriptor !== 'object') {
    return {
      authenticated: false,
      state: 'DESCRIPTOR_MISSING',
      reasonCode: 'DESCRIPTOR_MISSING',
      reason: 'Supervisor identity cannot be verified: missing operating-system identity descriptor.',
    };
  }

  // 3. Delegate to authenticateObserver from executionEvidenceContract
  const { authenticateObserver } = require('./executionEvidenceContract.cjs');
  const peerCreds = options.peerCredentials
    || supervisor.peerCredentials
    || (options.isSyntheticTest && descriptor.pid ? { authenticated: true, peerPid: descriptor.pid } : null);

  const authRes = authenticateObserver({
    observerDescriptor: descriptor,
    peerCredentials: peerCreds,
    ipcChannel: options.ipcChannel || supervisor.ipcChannel || null,
    processContext: options.processContext || { currentPid: process.pid },
    isSyntheticTest: Boolean(options.isSyntheticTest),
  });

  return {
    authenticated: authRes.isAuthenticated === true,
    state: authRes.state,
    reasonCode: authRes.reasonCode,
    reason: authRes.reason,
    descriptor: authRes.observerDescriptor || null,
  };
}

function assertAuthenticatedSupervisor(supervisor, options = {}) {
  assertTrustedSupervisorInterface(supervisor);
  const auth = authenticateSupervisor(supervisor, options);
  if (!auth.authenticated) {
    const error = new Error(`Supervisor authentication failed (${auth.reasonCode || auth.state}): ${auth.reason}`);
    error.code = 'SUPERVISOR_AUTHENTICATION_FAILED';
    error.authReasonCode = auth.reasonCode;
    throw error;
  }
  return auth;
}

function assertTrustedSupervisorInterface(supervisor) {
  if (!supervisor || typeof supervisor !== 'object' || Array.isArray(supervisor)) {
    throw new TypeError('Trusted supervisor interface must be an object.');
  }
  for (const operation of TRUSTED_SUPERVISOR_OPERATIONS) {
    if (typeof supervisor[operation] !== 'function') {
      throw new TypeError(`Trusted supervisor interface is missing required operation: ${operation}.`);
    }
  }
}

function createCapabilityStateMap(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Capability states must be a structured object.');
  }
  const unknown = Object.keys(overrides).filter((name) => !ISOLATION_CAPABILITIES.includes(name));
  if (unknown.length) throw new Error(`Unknown isolation capability state: ${unknown.join(', ')}.`);
  const states = Object.fromEntries(ISOLATION_CAPABILITIES.map((name) => [name, 'NOT_ESTABLISHED']));
  for (const [name, state] of Object.entries(overrides)) {
    if (!CAPABILITY_STATE_VALUES.includes(state)) {
      throw new TypeError(`Invalid state for isolation capability "${name}".`);
    }
    states[name] = state;
  }
  return Object.freeze(states);
}

function getDefaultCapabilities() {
  return {
    documented: false,
    configured: false,
    runtimeAvailable: false,
    independentlyVerified: false,
    humanApproved: false,
    syntheticValidationPassed: false,
    executionAuthorized: false,
    identityIsolation: false,
    credentialIsolation: false,
    egressControl: false,
    resourceLimits: false,
    runtimeCap: false,
    outputCap: false,
    cancellation: false,
    cleanupEvidence: false,
    capabilityStates: createCapabilityStateMap(),
  };
}

function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('Provider adapter must be an object with the required host-observed interface.');
  }
  const requiredMethods = ['getProviderId', 'getConfigRevision', 'getCapabilities'];
  for (const methodName of requiredMethods) {
    if (typeof adapter[methodName] !== 'function') {
      throw new TypeError(`Provider adapter is missing required method: ${methodName}.`);
    }
  }
}

function createProviderAdapter(adapter) {
  assertProviderAdapter(adapter);
  const baseCapabilities = getDefaultCapabilities();
  return {
    getProviderId() {
      return adapter.getProviderId();
    },
    getConfigRevision() {
      return adapter.getConfigRevision();
    },
    getCapabilities() {
      return {
        ...baseCapabilities,
        ...(adapter.getCapabilities ? adapter.getCapabilities() : {}),
        capabilityStates: createCapabilityStateMap(
          typeof adapter.getCapabilityStates === 'function'
            ? adapter.getCapabilityStates()
            : baseCapabilities.capabilityStates,
        ),
      };
    },
    prepareRunEvidence(runContext = {}) {
      if (typeof adapter.prepareRunEvidence === 'function') {
        return adapter.prepareRunEvidence.call(this, runContext);
      }
      return {
        manifest: null,
        evidenceState: {
          state: 'NOT_ESTABLISHED',
          reasonCode: 'HOST_VERIFIER_NOT_ESTABLISHED',
          reason: 'The provider adapter has no trusted host evidence issuer.',
        },
      };
    },
    collectHostObservedResult(rawRunState = {}) {
      if (typeof adapter.collectHostObservedResult === 'function') {
        return adapter.collectHostObservedResult.call(this, rawRunState);
      }
      const source = rawRunState && typeof rawRunState === 'object' ? rawRunState : {};
      const hostObserved = source.hostObserved && typeof source.hostObserved === 'object' ? source.hostObserved : {};
      const guestOutputs = Array.isArray(source.guestOutputs) ? [...source.guestOutputs] : [];
      const guestCleanupReports = Array.isArray(source.guestCleanupReports) ? [...source.guestCleanupReports] : [];
      const providerObservedState = source.providerObservedState && typeof source.providerObservedState === 'object'
        ? { ...source.providerObservedState }
        : {};
      const appVerifiedFacts = hostObserved.appVerifiedFacts && typeof hostObserved.appVerifiedFacts === 'object'
        ? { ...hostObserved.appVerifiedFacts }
        : (source.appVerifiedFacts && typeof source.appVerifiedFacts === 'object' ? { ...source.appVerifiedFacts } : {});
      const acceptedEvidence = hostObserved.acceptedEvidence && typeof hostObserved.acceptedEvidence === 'object'
        ? { ...hostObserved.acceptedEvidence }
        : (source.acceptedEvidence && typeof source.acceptedEvidence === 'object' ? { ...source.acceptedEvidence } : {});
      const envelope = createResultEnvelope({
        untrustedWorkerClaims: [...guestOutputs, ...guestCleanupReports],
        providerObservedState: { ...providerObservedState, source: 'untrusted-caller-input' },
        appVerifiedFacts,
        acceptedEvidence,
      });
      return {
        envelope,
        evaluation: evaluateResultEnvelope(envelope),
      };
    },
  };
}

function createHostObservedEvidenceCollector() {
  return {
    collect(rawRunState = {}) {
      const source = rawRunState && typeof rawRunState === 'object' ? rawRunState : {};
      const guestOutputs = Array.isArray(source.guestOutputs) ? source.guestOutputs : [];
      const guestCleanupReports = Array.isArray(source.guestCleanupReports) ? source.guestCleanupReports : [];
      const hostFacts = source.hostObserved && typeof source.hostObserved === 'object' ? source.hostObserved : {};
      return createResultEnvelope({
        untrustedWorkerClaims: [...guestOutputs, ...guestCleanupReports],
        providerObservedState: { ...source.providerObservedState, source: 'untrusted-caller-input' },
        appVerifiedFacts: hostFacts.appVerifiedFacts || {},
        acceptedEvidence: hostFacts.acceptedEvidence || {},
      });
    },
  };
}

module.exports = {
  CAPABILITY_STATE_VALUES,
  ISOLATION_CAPABILITIES,
  TRUSTED_SUPERVISOR_OPERATIONS,
  assertProviderAdapter,
  assertAuthenticatedSupervisor,
  assertTrustedSupervisorInterface,
  authenticateSupervisor,
  createCapabilityStateMap,
  createHostObservedEvidenceCollector,
  createProviderAdapter,
  getDefaultCapabilities,
};
