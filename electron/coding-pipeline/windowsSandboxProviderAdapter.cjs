const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createCapabilityStateMap,
  createProviderAdapter,
} = require('./providerAdapterContract.cjs');
const { createResultEnvelope, evaluateResultEnvelope } = require('./executionEvidenceContract.cjs');
const { createSandboxResourceLifecycle } = require('./sandboxResourceLifecycle.cjs');

const DEFAULT_MEMORY_MB = 1024;
const MIN_MEMORY_MB = 512;
const MAX_MEMORY_MB = 4096;
const SANDBOX_OUTPUT_ROOT = path.join(os.tmpdir(), 'ai-help-agent-windows-sandbox-');
const DISABLED_REASON = 'Windows Sandbox execution remains disabled until per-instance process ownership and handle release can be independently verified by a supported host API.';

function ensureOnlyKeys(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a structured object.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported options: ${unknown.join(', ')}.`);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertPlainDirectory(candidate, expectedParent, label) {
  const resolved = path.resolve(candidate);
  const parent = path.resolve(expectedParent);
  if (!isWithin(parent, resolved) || path.dirname(resolved) !== parent) {
    throw new Error(`${label} must be a direct child of the adapter-owned temporary root.`);
  }
  const rootStat = await fs.lstat(parent);
  const itemStat = await fs.lstat(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !itemStat.isDirectory() || itemStat.isSymbolicLink()) {
    throw new Error(`${label} and its parent must be ordinary, non-symbolic directories.`);
  }
  const realParent = await fs.realpath(parent);
  const realItem = await fs.realpath(resolved);
  if (path.dirname(realItem) !== realParent) {
    throw new Error(`${label} resolves outside the adapter-owned temporary root.`);
  }
  return realItem;
}

async function buildWindowsSandboxConfiguration(options = {}) {
  ensureOnlyKeys(options, ['temporaryRoot', 'controlDirectory', 'outputDirectory', 'memoryInMB'], 'Windows Sandbox options');
  const temporaryRoot = path.resolve(String(options.temporaryRoot || ''));
  const tempRoot = path.resolve(os.tmpdir());
  if (!isWithin(tempRoot, temporaryRoot) || path.dirname(temporaryRoot) !== tempRoot) {
    throw new Error('Windows Sandbox temporary root must be a fresh direct child of the operating-system temp directory.');
  }
  const controlDirectory = await assertPlainDirectory(
    String(options.controlDirectory || ''),
    temporaryRoot,
    'Windows Sandbox control directory',
  );
  const outputDirectory = await assertPlainDirectory(
    String(options.outputDirectory || ''),
    temporaryRoot,
    'Windows Sandbox output directory',
  );
  if (controlDirectory === outputDirectory) throw new Error('Control and output directories must be separate.');

  const memoryInMB = options.memoryInMB ?? DEFAULT_MEMORY_MB;
  if (!Number.isInteger(memoryInMB) || memoryInMB < MIN_MEMORY_MB || memoryInMB > MAX_MEMORY_MB) {
    throw new Error(`Windows Sandbox memory must be an integer between ${MIN_MEMORY_MB} and ${MAX_MEMORY_MB} MB.`);
  }

  return `<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Disable</Networking>
  <MemoryInMB>${memoryInMB}</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${escapeXml(controlDirectory)}</HostFolder><SandboxFolder>C:\\ai-help-agent-control</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${escapeXml(outputDirectory)}</HostFolder><SandboxFolder>C:\\ai-help-agent-output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ProtectedClient>Enable</ProtectedClient>
</Configuration>`;
}

function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

async function createSyntheticSandboxWorkspace() {
  const temporaryRoot = await fs.mkdtemp(SANDBOX_OUTPUT_ROOT);
  const controlDirectory = path.join(temporaryRoot, 'control');
  const outputDirectory = path.join(temporaryRoot, 'output');
  try {
    await fs.mkdir(controlDirectory);
    await fs.mkdir(outputDirectory);
    await fs.writeFile(
      path.join(controlDirectory, 'synthetic-probe.txt'),
      'synthetic runtime probe\nline two\nline three\nline four\nline five\n',
      { encoding: 'utf8', flag: 'wx' },
    );
    return Object.freeze({ temporaryRoot, controlDirectory, outputDirectory });
  } catch (error) {
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: false });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Synthetic Windows Sandbox workspace preparation and cleanup both failed.');
    }
    throw error;
  }
}

function validateHostShutdownObservation(observation, expectedRunId, expectedProcessId) {
  return Boolean(
    observation
    && observation.source === 'host-process-inspection'
    && observation.runId === expectedRunId
    && observation.launcherPid === expectedProcessId
    && observation.launcherTerminated === true
    && observation.sandboxClientsRemaining === 0
    && observation.ownedSandboxProcessCount === 0
    && observation.sandboxResourceAbsent === true
    && observation.sandboxHandlesReleased === true,
  );
}

function createWindowsSandboxHostLifecycle({
  createTemporaryRoot = async () => (await createSyntheticSandboxWorkspace()).temporaryRoot,
  observeShutdown = null,
  removeTemporaryRoot = (temporaryRoot) => fs.rm(temporaryRoot, { recursive: true, force: false }),
  verifyTemporaryRootRemoved = async (temporaryRoot) => {
    try {
      await fs.lstat(temporaryRoot);
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  },
} = {}) {
  const runIdByTemporaryRoot = new Map();
  const lifecycle = createSandboxResourceLifecycle({
    createTemporaryRoot,
    waitForShutdown: async (process, baselinePids, temporaryRoot) => {
      const runId = runIdByTemporaryRoot.get(temporaryRoot);
      if (!runId) {
        throw new Error(`Windows Sandbox run ownership is unavailable. Temporary data was retained at "${temporaryRoot}".`);
      }
      if (typeof observeShutdown !== 'function') {
        throw new Error(`${DISABLED_REASON} Temporary data was retained at "${temporaryRoot}".`);
      }
      const observation = await observeShutdown({ process, baselinePids, temporaryRoot, runId });
      if (!validateHostShutdownObservation(observation, runId, process?.pid)) {
        throw new Error(`Host did not establish launcher termination, ownership, client absence, sandbox resource absence, and handle release for run "${runId}". Temporary data was retained at "${temporaryRoot}".`);
      }
      return observation;
    },
    removeTemporaryRoot,
    verifyTemporaryRootRemoved,
  });

  async function createResource({ runId } = {}) {
    if (typeof runId !== 'string' || !runId.trim()) {
      throw new TypeError('A non-empty Windows Sandbox run ID is required.');
    }
    const resource = await lifecycle.createResource({ runId });
    runIdByTemporaryRoot.set(lifecycle.getTemporaryRoot(resource), runId);
    return resource;
  }

  async function cleanup(resource) {
    const temporaryRoot = lifecycle.getTemporaryRoot(resource);
    const observation = await lifecycle.cleanup(resource);
    runIdByTemporaryRoot.delete(temporaryRoot);
    return Object.freeze({
      ...observation,
      evidenceState: 'NOT_ESTABLISHED',
      sandboxHandlesReleased: observation.sandboxHandlesReleased === true,
      sandboxResourceDeleted: observation.sandboxResourceDeleted === true,
      stagingDirectoryDeleted: observation.stagingDirectoryRemoved === true,
      source: 'host-process-inspection-and-filesystem',
    });
  }

  function getStatus(resource) {
    return lifecycle.getStatus(resource);
  }

  return Object.freeze({
    cleanup,
    createResource,
    getStatus,
    getTemporaryRoot(resource) {
      return lifecycle.getTemporaryRoot(resource);
    },
    markLaunchStarting(resource) {
      return lifecycle.markLaunchStarting(resource);
    },
    markLauncherStarted(resource, process) {
      return lifecycle.markLauncherStarted(resource, process);
    },
  });
}

function createWindowsSandboxProviderAdapter(config = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  const adapter = createProviderAdapter({
    getProviderId: () => 'windows-sandbox',
    getConfigRevision: () => settings.configRevision || 'windows-sandbox-disabled',
    getCapabilities: () => ({
      documented: true,
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
      disabledReason: DISABLED_REASON,
    }),
    getCapabilityStates: () => createCapabilityStateMap({
      osEnforcedProcessIsolation: 'BLOCKED',
    }),
    prepareRunEvidence: () => ({
      manifest: null,
      evidenceState: {
        state: 'BLOCKED',
        reasonCode: 'WINDOWS_SANDBOX_HOST_VERIFICATION_UNAVAILABLE',
        reason: DISABLED_REASON,
      },
    }),
    collectHostObservedResult: (input = {}) => {
      const source = input && typeof input === 'object' ? input : {};
      const claims = [
        ...(Array.isArray(source.guestOutputs) ? source.guestOutputs : []),
        ...(Array.isArray(source.guestCleanupReports) ? source.guestCleanupReports : []),
        ...(Array.isArray(source.guestFiles) ? source.guestFiles : []),
      ];
      const envelope = createResultEnvelope({
        untrustedWorkerClaims: claims,
        providerObservedState: { source: 'unverified-windows-sandbox' },
        appVerifiedFacts: {},
        acceptedEvidence: {},
      });
      return {
        envelope,
        evaluation: evaluateResultEnvelope(envelope),
        classification: 'BLOCKED',
      };
    },
  });
  return Object.freeze({
    ...adapter,
    buildConfiguration: buildWindowsSandboxConfiguration,
    createSyntheticWorkspace: createSyntheticSandboxWorkspace,
    createHostLifecycle: createWindowsSandboxHostLifecycle,
    disabledReason: DISABLED_REASON,
  });
}

module.exports = {
  DEFAULT_MEMORY_MB,
  DISABLED_REASON,
  buildWindowsSandboxConfiguration,
  createSyntheticSandboxWorkspace,
  createWindowsSandboxHostLifecycle,
  createWindowsSandboxProviderAdapter,
  validateHostShutdownObservation,
};
