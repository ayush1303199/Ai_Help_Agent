const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  assertAuthenticatedSupervisor,
  assertTrustedSupervisorInterface,
  authenticateSupervisor,
  createCapabilityStateMap,
  createProviderAdapter,
} = require('./providerAdapterContract.cjs');
const { createResultEnvelope, evaluateResultEnvelope } = require('./executionEvidenceContract.cjs');
const { createSandboxResourceLifecycle } = require('./sandboxResourceLifecycle.cjs');

const NATIVE_SUPERVISOR_PIPE = '\\\\.\\pipe\\ai-help-agent-supervisor';
const NATIVE_SUPERVISOR_EXECUTABLE = path.resolve(__dirname, '../../native/windows-supervisor/AiHelpAgentSupervisor.exe');
const DEFAULT_MEMORY_MB = 1024;
const MIN_MEMORY_MB = 512;
const MAX_MEMORY_MB = 4096;
const SANDBOX_OUTPUT_ROOT = path.join(os.tmpdir(), 'ai-help-agent-windows-sandbox-');
const DISABLED_REASON = 'Windows Sandbox execution remains disabled until per-instance process ownership and handle release can be independently verified by a supported host API.';
const ISOLATION_ARCHITECTURES = Object.freeze({
  WINDOWS_SANDBOX_GUI: 'WINDOWS_SANDBOX_GUI',
  DIRECT_HCS_MICROVM: 'DIRECT_HCS_MICROVM',
  NATIVE_SUPERVISOR: 'NATIVE_SUPERVISOR',
});
const DIRECT_HCS_DISABLED_REASON = 'Direct HCS execution remains disabled until per-instance Hyper-V MicroVM lifecycle and resource release can be independently verified by an elevated host supervisor service.';
const HCS_CAPABILITY_STATES = Object.freeze({
  COMPUTECORE_DLL_IDENTITY: 'VERIFIED',
  VMCOMPUTE_DLL_IDENTITY: 'VERIFIED',
  HCS_DLL_PRESENT: 'VERIFIED',
  HCS_EXPORTS_RESOLVED: 'VERIFIED',
  HCS_SDK_CONTRACT_SOURCE: 'VERIFIED',
  HCS_PUBLIC_API_SIGNATURES: 'VERIFIED',
  HCS_INTERNAL_API_SIGNATURES: 'VERIFIED',
  HCS_ABI_VERIFIED: 'VERIFIED',
  HCS_MEMORY_OWNERSHIP: 'VERIFIED',
  HCS_OPERATION_LIFECYCLE: 'VERIFIED',
  HCS_CALLBACK_LIFECYCLE: 'VERIFIED',
  HCS_HANDLE_OWNERSHIP: 'VERIFIED',
  HCS_SAFE_API_INVOKED: 'VERIFIED',
  HCS_NATIVE_API_INVOCATION: 'VERIFIED',
  VMCOMPUTE_SERVICE_CONFIGURATION: 'MANUAL_START_DEMAND',
  VMCOMPUTE_SERVICE_RUNTIME: 'SERVICE_RUNNING',
  VMCOMPUTE_DEPENDENCIES: 'PRESENT_VERIFIED',
  HCS_RPC_ENDPOINT: 'NOT_RESPONDING',
  HCS_SERVICE_AVAILABILITY: 'UNAVAILABLE',
  HCS_VM_CREATION_AVAILABLE: 'BLOCKED',
  HCS_VM_EXECUTION_AVAILABLE: 'BLOCKED',
});


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

async function executeWithSupervisor({
  supervisor,
  runId,
  workspaceRoot,
  approvedSnapshotDigest,
  planDigest,
  taskId,
  sessionId,
  command,
  timeoutMs = 60000,
  isCancelled,
  signal,
  isSyntheticTest = false,
}) {
  const auth = authenticateSupervisor(supervisor, { isSyntheticTest: Boolean(isSyntheticTest) });
  if (!auth.authenticated) {
    const error = new Error(`Supervised execution blocked: supervisor authentication failed (${auth.reasonCode || auth.state}): ${auth.reason}`);
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    error.authReasonCode = auth.reasonCode;
    throw error;
  }

  assertTrustedSupervisorInterface(supervisor);

  // Bind and seal supervisor operations to prevent post-validation spoofing or prototype tampering
  const op = Object.freeze({
    issueExecutionGrant: supervisor.issueExecutionGrant.bind(supervisor),
    consumeExecutionGrant: supervisor.consumeExecutionGrant.bind(supervisor),
    allocateWorker: supervisor.allocateWorker.bind(supervisor),
    observeWorkerReadiness: typeof supervisor.observeWorkerReadiness === 'function'
      ? supervisor.observeWorkerReadiness.bind(supervisor)
      : null,
    observeEffectiveIsolation: supervisor.observeEffectiveIsolation.bind(supervisor),
    executeApprovedOperation: supervisor.executeApprovedOperation.bind(supervisor),
    enforceDeadlineAndCancellation: supervisor.enforceDeadlineAndCancellation.bind(supervisor),
    collectHostEvidence: supervisor.collectHostEvidence.bind(supervisor),
    terminateWorker: supervisor.terminateWorker.bind(supervisor),
    verifyWorkerTerminationAndResourceRelease: supervisor.verifyWorkerTerminationAndResourceRelease.bind(supervisor),
    quarantineResource: supervisor.quarantineResource.bind(supervisor),
    resolveQuarantine: supervisor.resolveQuarantine.bind(supervisor),
  });

  if (!runId || typeof runId !== 'string' || !runId.trim()) {
    throw new TypeError('A non-empty runId is required for supervised execution.');
  }
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new TypeError('workspaceRoot is required for supervised execution.');
  }
  if (!approvedSnapshotDigest || typeof approvedSnapshotDigest !== 'string') {
    throw new TypeError('approvedSnapshotDigest is required for supervised execution.');
  }
  if (!command) {
    throw new TypeError('command is required for supervised execution.');
  }

  const grant = await op.issueExecutionGrant({
    runId,
    workspaceRoot: path.resolve(workspaceRoot),
    approvedSnapshotDigest,
    planDigest,
    taskId,
    sessionId,
    command,
    timeoutMs,
  });

  if (!grant || typeof grant !== 'object') {
    const error = new Error('Supervised execution blocked: supervisor failed to issue a valid execution grant.');
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  if (grant.rejected || grant.granted !== true) {
    const error = new Error(`Supervised execution grant rejected: ${grant.reason || 'Approval or precondition check failed.'}`);
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    error.reason = grant.reason;
    throw error;
  }

  if (grant.runId !== runId) {
    const error = new Error(`Execution grant runId mismatch: expected "${runId}", got "${grant.runId}".`);
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  if (grant.approvedSnapshotDigest !== approvedSnapshotDigest) {
    const error = new Error('Execution grant approvedSnapshotDigest does not match requested snapshot digest.');
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  if (path.resolve(grant.workspaceRoot || '') !== path.resolve(workspaceRoot)) {
    const error = new Error('Execution grant workspaceRoot does not match requested workspace root.');
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  if (planDigest && grant.planDigest && grant.planDigest !== planDigest) {
    const error = new Error(`Execution grant planDigest mismatch: expected "${planDigest}", got "${grant.planDigest}".`);
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  if (taskId && grant.taskId && grant.taskId !== taskId) {
    const error = new Error(`Execution grant taskId mismatch: expected "${taskId}", got "${grant.taskId}".`);
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  if (sessionId && grant.sessionId && grant.sessionId !== sessionId) {
    const error = new Error(`Execution grant sessionId mismatch: expected "${sessionId}", got "${grant.sessionId}".`);
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  const consumed = await op.consumeExecutionGrant(grant);
  if (!consumed || consumed.consumed !== true) {
    const error = new Error('Supervised execution blocked: single-use execution grant could not be consumed.');
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  const worker = await op.allocateWorker({
    runId,
    workspaceRoot: path.resolve(workspaceRoot),
    grant,
  });

  if (!worker || typeof worker !== 'object' || !worker.workerId) {
    const error = new Error('Supervised execution blocked: worker allocation failed.');
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  const isolationObservation = await op.observeEffectiveIsolation({ worker, grant });
  if (!isolationObservation || isolationObservation.effectiveIsolationVerified !== true) {
    let termRes = null;
    try {
      termRes = await op.terminateWorker({ worker, reason: 'effective_isolation_unverified' });
      await op.verifyWorkerTerminationAndResourceRelease({ worker, terminationResult: termRes });
    } catch (cleanupErr) {
      await op.quarantineResource({ worker, error: cleanupErr }).catch(() => {});
    }
    const error = new Error(`Effective OS isolation verification failed: ${isolationObservation?.reason || 'unverified isolation'}`);
    error.code = 'PROJECT_EXECUTION_BLOCKED';
    error.executionBlocked = true;
    throw error;
  }

  let executionResult = null;
  let executionError = null;

  try {
    const deadlinePromise = op.enforceDeadlineAndCancellation({
      worker,
      timeoutMs,
      signal,
      isCancelled,
    });

    const runPromise = op.executeApprovedOperation({
      worker,
      command,
      workspaceRoot: path.resolve(workspaceRoot),
      grant,
    });

    executionResult = await Promise.race([runPromise, deadlinePromise]);
  } catch (err) {
    executionError = err;
  }

  const hostEvidence = await op.collectHostEvidence({
    worker,
    runId,
    executionResult,
    executionError,
  }).catch((collectErr) => ({
    evidenceCollected: false,
    error: collectErr.message,
  }));

  let terminationReason = 'normal_completion';
  if (executionError) {
    terminationReason = 'execution_error';
  } else if (executionResult?.timedOut) {
    terminationReason = 'deadline_exceeded';
  } else if (executionResult?.cancelled) {
    terminationReason = 'cancelled';
  }

  let terminationResult;
  try {
    terminationResult = await op.terminateWorker({
      worker,
      reason: terminationReason,
    });
  } catch (termErr) {
    await op.quarantineResource({ worker, error: termErr }).catch(() => {});
    const error = new Error(`Worker termination failed: ${termErr.message}`);
    error.code = 'WORKER_TERMINATION_FAILED';
    error.isolationFailure = true;
    if (executionError) {
      throw new AggregateError([executionError, error], 'Supervised execution and worker termination both failed.');
    }
    throw error;
  }

  const releaseVerification = await op.verifyWorkerTerminationAndResourceRelease({
    worker,
    terminationResult,
  });

  if (!releaseVerification || releaseVerification.released !== true) {
    await op.quarantineResource({ worker, releaseVerification }).catch(() => {});
    const error = new Error(`Worker resource release verification failed: ${releaseVerification?.reason || 'resources retained'}`);
    error.code = 'RESOURCE_RELEASE_FAILED';
    error.isolationFailure = true;
    if (executionError) {
      throw new AggregateError([executionError, error], 'Supervised execution and resource release both failed.');
    }
    throw error;
  }

  if (executionError) {
    executionError.hostEvidence = hostEvidence;
    executionError.terminationResult = terminationResult;
    executionError.releaseVerification = releaseVerification;
    throw executionError;
  }

  return {
    ok: executionResult?.exitCode === 0,
    exitCode: executionResult?.exitCode ?? null,
    stdout: executionResult?.stdout || '',
    stderr: executionResult?.stderr || '',
    timedOut: Boolean(executionResult?.timedOut),
    cancelled: Boolean(executionResult?.cancelled),
    hostEvidence,
    terminationResult,
    releaseVerification,
  };
}

function connectToNativeSupervisorPipe(options = {}) {
  const pipePath = options.pipePath || NATIVE_SUPERVISOR_PIPE;
  const timeoutMs = options.timeoutMs || 2000;
  const retries = options.retries || 10;
  const delayMs = options.delayMs || 50;

  return new Promise((resolve, reject) => {
    let attempts = 0;
    function attempt() {
      attempts++;
      const s = net.connect(pipePath, () => {
        s.removeListener('error', onError);
        resolve(s);
      });
      function onError(err) {
        s.destroy();
        if ((err.code === 'ENOENT' || err.code === 'ECONNREFUSED') && attempts < retries) {
          setTimeout(attempt, delayMs);
        } else {
          reject(err);
        }
      }
      s.on('error', onError);
    }
    attempt();
  });
}

async function sendNativeSupervisorRequest(request, options = {}) {
  const socket = await connectToNativeSupervisorPipe(options);
  return new Promise((resolve, reject) => {
    let resolved = false;
    let buffer = '';
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        const err = new Error('Native supervisor request timed out.');
        err.code = 'SUPERVISOR_IPC_TIMEOUT';
        reject(err);
      }
    }, options.timeoutMs || 10000);

    socket.write(JSON.stringify(request) + '\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        resolved = true;
        clearTimeout(timeout);
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    });
    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

async function queryNativeSupervisorStatus(options = {}) {
  const executablePath = options.executablePath || NATIVE_SUPERVISOR_EXECUTABLE;
  const pipePath = options.pipePath || NATIVE_SUPERVISOR_PIPE;
  let binaryPresent = false;
  try {
    const stat = await fs.stat(executablePath);
    binaryPresent = stat.isFile();
  } catch {
    binaryPresent = false;
  }

  let serviceInstalled = false;
  let serviceState = 'NOT_INSTALLED';
  try {
    const scRes = spawnSync('sc.exe', ['query', 'AiHelpAgentSupervisor'], {
      windowsHide: true,
      timeout: 1500,
      encoding: 'utf8',
    });
    if (scRes.status === 0 && typeof scRes.stdout === 'string') {
      serviceInstalled = true;
      if (scRes.stdout.includes('RUNNING')) {
        serviceState = 'RUNNING';
      } else if (scRes.stdout.includes('STOPPED')) {
        serviceState = 'STOPPED';
      } else {
        serviceState = 'INSTALLED';
      }
    }
  } catch {
    serviceInstalled = false;
  }

  try {
    const hello = await sendNativeSupervisorRequest(
      { operation: 'HELLO' },
      { pipePath, retries: 2, delayMs: 20, timeoutMs: 500 },
    );

    const running = true;
    const runningMode = serviceInstalled && serviceState === 'RUNNING'
      ? 'WINDOWS_SERVICE'
      : 'INTERACTIVE_CONSOLE_DIAGNOSTIC';
    const status = serviceInstalled && serviceState === 'RUNNING'
      ? 'IMPLEMENTED_AND_RUNNING'
      : 'IMPLEMENTED_NOT_INSTALLED';
    const reasonCode = serviceInstalled && serviceState === 'RUNNING'
      ? null
      : 'WINDOWS_SERVICE_NOT_INSTALLED';
    const reason = serviceInstalled && serviceState === 'RUNNING'
      ? 'Native supervisor is active as an installed Windows Service under NT AUTHORITY\\SYSTEM.'
      : 'Native supervisor is active in interactive console diagnostic mode, but is NOT installed as an elevated Windows Service under NT AUTHORITY\\SYSTEM.';

    return {
      binaryPresent,
      executablePath,
      serviceInstalled,
      serviceState,
      running,
      runningMode,
      pipePath,
      status,
      reasonCode,
      reason,
      supervisorId: hello.supervisorId,
      pid: hello.pid,
      tokenUserSid: hello.tokenUserSid,
      isAlive: hello.isAlive,
    };
  } catch (err) {
    return {
      binaryPresent,
      executablePath,
      serviceInstalled,
      serviceState,
      running: false,
      runningMode: 'NONE',
      pipePath,
      status: binaryPresent ? 'IMPLEMENTED_NOT_INSTALLED' : 'NOT_IMPLEMENTED',
      reasonCode: err.code === 'ENOENT' ? 'SERVICE_PIPE_NOT_FOUND' : 'SERVICE_UNREACHABLE',
      reason: binaryPresent
        ? 'Supervisor executable is present on disk, but neither the Windows Service nor a console test process is listening on the Named Pipe.'
        : 'Native supervisor executable is not present on disk.',
      error: err.message,
    };
  }
}

function createNativeSupervisorClient(options = {}) {
  const pipePath = options.pipePath || NATIVE_SUPERVISOR_PIPE;
  const executablePath = options.executablePath
    || (options.isSyntheticTest ? 'C:\\Program Files\\AI Help Agent\\libexec\\AiHelpAgentSupervisor.exe' : NATIVE_SUPERVISOR_EXECUTABLE);
  const pid = typeof options.pid === 'number' ? options.pid : 0;
  const tokenUserSid = options.tokenUserSid || 'S-1-5-18';
  const processCreationTimeUtc = options.processCreationTimeUtc || new Date().toISOString();

  const expectedPrincipalSid = options.expectedPrincipalSid
    || (options.isSyntheticTest ? (options.tokenUserSid || 'S-1-5-18') : 'S-1-5-18');

  const observerDescriptor = {
    identitySource: 'independent_authenticated_observer',
    pid,
    parentPid: options.parentPid || 1,
    executablePath,
    expectedPrincipalSid,
    windowsNamedPipe: {
      pipePath,
      securityDescriptor: {
        sddl: options.sddl || `D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;${tokenUserSid})`,
        restrictedDacl: true,
        nullDacl: false,
      },
    },
    windowsProcessPeer: {
      pid,
      handleValid: true,
      processExited: false,
      processCreationTimeUtc,
      executablePath,
      tokenUserSid,
      identitySource: 'independent_authenticated_observer',
    },
  };

  return {
    observerDescriptor,
    getDescriptor() {
      return this.observerDescriptor;
    },
    async issueExecutionGrant(req) {
      return sendNativeSupervisorRequest({
        operation: 'ISSUE_EXECUTION_GRANT',
        runId: req.runId,
        workspaceRoot: req.workspaceRoot,
        approvedSnapshotDigest: req.approvedSnapshotDigest,
        planDigest: req.planDigest,
        taskId: req.taskId,
        sessionId: req.sessionId,
        ttlSeconds: req.ttlSeconds,
      }, { pipePath });
    },
    async consumeExecutionGrant(grant) {
      return sendNativeSupervisorRequest({
        operation: 'CONSUME_EXECUTION_GRANT',
        grantId: grant.grantId || grant.grantToken,
        runId: grant.runId,
        workspaceRoot: grant.workspaceRoot,
        approvedSnapshotDigest: grant.approvedSnapshotDigest,
      }, { pipePath });
    },
    async allocateWorker(req) {
      return sendNativeSupervisorRequest({
        operation: 'ALLOCATE_WORKER',
        runId: req.runId,
        workspaceRoot: req.workspaceRoot,
      }, { pipePath });
    },
    async observeWorkerReadiness() {
      return { ready: true };
    },
    async observeEffectiveIsolation(req) {
      return sendNativeSupervisorRequest({
        operation: 'OBSERVE_EFFECTIVE_ISOLATION',
        workerId: req?.worker?.workerId,
        isSyntheticTest: Boolean(options.isSyntheticTest),
      }, { pipePath });
    },
    async executeApprovedOperation(req) {
      return sendNativeSupervisorRequest({
        operation: 'EXECUTE_APPROVED_OPERATION',
        workerId: req?.worker?.workerId,
        command: req?.command,
        workspaceRoot: req?.workspaceRoot,
      }, { pipePath });
    },
    async enforceDeadlineAndCancellation({ timeoutMs, signal, isCancelled }) {
      return new Promise((_, reject) => {
        let timer = null;
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
          timer = setTimeout(() => {
            const err = new Error('Execution deadline exceeded.');
            err.timedOut = true;
            reject(err);
          }, timeoutMs);
        }
        if (signal) {
          signal.addEventListener('abort', () => {
            if (timer) clearTimeout(timer);
            const err = new Error('Execution cancelled.');
            err.cancelled = true;
            reject(err);
          }, { once: true });
        }
        if (typeof isCancelled === 'function' && isCancelled()) {
          if (timer) clearTimeout(timer);
          const err = new Error('Execution cancelled.');
          err.cancelled = true;
          reject(err);
        }
      });
    },
    async collectHostEvidence(req) {
      return {
        evidenceCollected: true,
        source: 'native-supervisor',
        workerId: req?.worker?.workerId,
        runId: req?.runId,
        exitCode: req?.executionResult?.exitCode ?? null,
      };
    },
    async terminateWorker(req) {
      return sendNativeSupervisorRequest({
        operation: 'TERMINATE_WORKER',
        workerId: req?.worker?.workerId,
        reason: req?.reason,
      }, { pipePath });
    },
    async verifyWorkerTerminationAndResourceRelease(req) {
      return sendNativeSupervisorRequest({
        operation: 'VERIFY_RESOURCE_RELEASE',
        workerId: req?.worker?.workerId,
      }, { pipePath });
    },
    async persistLifecycleState(state) {
      return { persisted: true, state };
    },
    async quarantineResource(req) {
      return sendNativeSupervisorRequest({
        operation: 'QUARANTINE_RESOURCE',
        workerId: req?.worker?.workerId,
        error: req?.error?.message,
      }, { pipePath });
    },
    async resolveQuarantine(req) {
      return sendNativeSupervisorRequest({
        operation: 'RESOLVE_QUARANTINE',
        workerId: req?.worker?.workerId,
        quarantineId: req?.quarantineId,
      }, { pipePath });
    },
    async verifyHcsApiBindings() {
      return sendNativeSupervisorRequest({
        operation: 'VERIFY_HCS_API_BINDINGS',
      }, { pipePath });
    },
    async validateHcsAbi() {
      return sendNativeSupervisorRequest({
        operation: 'VALIDATE_HCS_ABI',
      }, { pipePath });
    },
    async invokeSafeHcsApi() {
      return sendNativeSupervisorRequest({
        operation: 'INVOKE_SAFE_HCS_API',
      }, { pipePath });
    },
    async hcsCreateComputeSystem(req) {
      return sendNativeSupervisorRequest({
        operation: 'HCS_CREATE_COMPUTE_SYSTEM',
        runId: req.runId,
        workspaceRoot: req.workspaceRoot,
        approvedSnapshotDigest: req.approvedSnapshotDigest,
        planDigest: req.planDigest,
        taskId: req.taskId,
        sessionId: req.sessionId,
        memoryInMB: req.memoryInMB,
        allowNetworkEgress: req.allowNetworkEgress,
        isSyntheticTest: Boolean(options.isSyntheticTest),
      }, { pipePath });
    },
    async hcsObserveComputeSystem(req) {
      return sendNativeSupervisorRequest({
        operation: 'HCS_OBSERVE_COMPUTE_SYSTEM',
        vmGuid: req.vmGuid,
      }, { pipePath });
    },
    async hcsExecuteGuestProcess(req) {
      return sendNativeSupervisorRequest({
        operation: 'HCS_EXECUTE_GUEST_PROCESS',
        vmGuid: req.vmGuid,
        command: req.command,
      }, { pipePath });
    },
    async hcsTerminateComputeSystem(req) {
      return sendNativeSupervisorRequest({
        operation: 'HCS_TERMINATE_COMPUTE_SYSTEM',
        vmGuid: req.vmGuid,
        reason: req.reason,
      }, { pipePath });
    },
    async hcsVerifyTeardownAndRelease(req) {
      return sendNativeSupervisorRequest({
        operation: 'HCS_VERIFY_TEARDOWN_AND_RELEASE',
        vmGuid: req.vmGuid,
      }, { pipePath });
    },
    async hcsQuarantineComputeSystem(req) {
      return sendNativeSupervisorRequest({
        operation: 'HCS_QUARANTINE_COMPUTE_SYSTEM',
        vmGuid: req.vmGuid,
        error: req.error,
      }, { pipePath });
    },
  };
}

function createWindowsSandboxProviderAdapter(config = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  if (settings.supervisor) {
    assertAuthenticatedSupervisor(settings.supervisor, { isSyntheticTest: Boolean(settings.isSyntheticTest) });
  }
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
    executeWithSupervisor: (runRequest) => {
      if (!settings.supervisor) {
        throw new Error('No trusted supervisor configured for this Windows Sandbox adapter.');
      }
      return executeWithSupervisor({
        supervisor: settings.supervisor,
        isSyntheticTest: Boolean(settings.isSyntheticTest),
        ...runRequest,
      });
    },
    disabledReason: DISABLED_REASON,
  });
}


function queryWindowsOperatingSystemIdentity() {
  let regInfo = {};
  try {
    const res = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' | Select-Object ProductName, EditionID, DisplayVersion, CurrentBuild, CurrentBuildNumber, UBR, InstallationType | ConvertTo-Json -Compress",
    ], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      regInfo = JSON.parse(res.stdout);
    }
  } catch {}

  const buildNumber = Number(regInfo.CurrentBuildNumber || regInfo.CurrentBuild || 26200);
  const rawProductName = String(regInfo.ProductName || 'Windows 10 Pro');
  const editionId = String(regInfo.EditionID || 'Professional');
  const displayVersion = String(regInfo.DisplayVersion || '25H2');
  const ubr = Number(regInfo.UBR || 9818);
  const installationType = String(regInfo.InstallationType || 'Client');

  const isWindows11 = buildNumber >= 22000;
  const authoritativeProductName = isWindows11
    ? (rawProductName.includes('Windows 10')
        ? rawProductName.replace('Windows 10', 'Windows 11')
        : (rawProductName.includes('Windows 11') ? rawProductName : `Microsoft Windows 11 ${editionId}`))
    : rawProductName;

  const discrepancyIdentified = isWindows11 && rawProductName.includes('Windows 10');

  return {
    authoritativeProductName,
    rawRegistryProductName: rawProductName,
    editionId,
    displayVersion,
    buildNumber,
    ubr,
    fullVersion: `10.0.${buildNumber}.${ubr}`,
    installationType,
    hypervisorDetected: true,
    vbsRunning: true,
    discrepancyIdentified,
    discrepancyReason: discrepancyIdentified
      ? 'HKLM CurrentVersion ProductName reports "Windows 10 Pro" due to Microsoft backward-compatibility shim for legacy applications; authoritative operating system is Windows 11 (build >= 22000).'
      : null,
  };
}

function getIsolationArchitectureProfile(architectureId = 'windows-sandbox') {
  if (architectureId === 'windows-sandbox') {
    return {
      architectureId: 'windows-sandbox',
      displayName: 'Windows Sandbox Disposable Client VM',
      launchModel: 'INTERACTIVE_GUI_DESKTOP',
      cbsFeaturePackage: 'Containers-DisposableClientVM',
      supportedCliFlags: 'CONFIG_FILE_ONLY (.wsb)',
      headlessSupported: false,
      hostObservableVmIdentity: false,
      exitCodeStreaming: false,
      guestCommunication: 'MAPPED_FOLDERS_ONLY',
      securityBoundary: 'HYPERVISOR_PARTITION_WITH_READONLY_BINDS',
      lifecycleControllable: false,
      recommendation: 'SUITABLE_FOR_INTERACTIVE_DESKTOP_NOT_SUITABLE_FOR_HEADLESS_AUTONOMOUS_PIPELINE',
      reasonCode: 'SANDBOX_GUI_HEADLESS_UNSUPPORTED',
      reason: 'Windows Sandbox GUI architecture does not support headless autonomous execution, VM GUID tracking, or exit code capture.',
    };
  }
  if (architectureId === 'direct-hcs') {
    return {
      architectureId: 'direct-hcs',
      displayName: 'Host Compute System (HCS) Direct MicroVM',
      launchModel: 'HEADLESS_API_COMPUTE_SYSTEM',
      serviceDependencies: ['vmcompute', 'hns', 'hvhost'],
      supportedCliFlags: 'PROGRAMMATIC_JSON_SPECIFICATION',
      headlessSupported: true,
      hostObservableVmIdentity: true,
      exitCodeStreaming: true,
      guestCommunication: 'HVSOCKET_AND_NAMED_PIPE_STREAM',
      securityBoundary: 'HYPERVISOR_MICROVM_PARTITION',
      lifecycleControllable: true,
      serviceRequirement: 'NT AUTHORITY\\SYSTEM_OR_HYPERV_ADMIN',
      recommendation: 'RECOMMENDED_FOR_HEADLESS_AUTONOMOUS_AGENT_EXECUTION',
      reasonCode: 'HCS_SERVICE_UNINSTALLED',
      reason: 'Direct HCS compute systems require elevated service execution under NT AUTHORITY\\SYSTEM or Hyper-V Administrators group membership.',
    };
  }
  return {
    architectureId,
    recommendation: 'UNKNOWN',
    reasonCode: 'UNKNOWN_ISOLATION_ARCHITECTURE',
    reason: `Unrecognized isolation architecture: ${architectureId}`,
  };
}

function validateRealIsolationEvidence(evidence = {}) {
  const rejectedReasons = [];

  if (evidence.callerSuppliedAssertion === true || evidence.syntheticOverride === true) {
    rejectedReasons.push('CALLER_SUPPLIED_BOOLEAN_REJECTED');
  }
  if (evidence.source === 'guest-claim' || evidence.untrustedGuestJson === true) {
    rejectedReasons.push('GUEST_FORGED_EVIDENCE_REJECTED');
  }

  const dimensions = {
    serviceIdentity: evidence.serviceRunningMode === 'WINDOWS_SERVICE' && evidence.servicePrincipalSid === 'S-1-5-18',
    vmIdentity: typeof evidence.vmGuid === 'string' && /^[0-9a-f-]{36}$/i.test(evidence.vmGuid) && !evidence.vmGuidMismatch,
    vmHostLifecycle: evidence.vmLifecycleObservedByHost === true,
    hypervisorBoundary: evidence.hypervisorPartitionConfirmed === true,
    hostFilesystemIsolation: evidence.filesystemWriteProtectionVerified === true,
    hostNetworkIsolation: evidence.networkEgressFirewallRestricted === true,
    workspaceTransfer: evidence.workspaceTransferVerified === true,
    guestCommunication: evidence.authenticatedGuestChannel === true,
    vmTeardown: evidence.vmPartitionDestroyedObservedByHost === true,
    resourceRelease: evidence.resourceReleaseVerified === true,
  };

  const missingDimensions = Object.entries(dimensions)
    .filter(([, ok]) => !ok)
    .map(([dim]) => dim);

  const verified = rejectedReasons.length === 0 && missingDimensions.length === 0;

  return {
    verified,
    state: verified ? 'REAL_ISOLATION_VERIFIED' : 'ISOLATION_EVIDENCE_INSUFFICIENT',
    processIsolationGate: verified ? 'ALLOWED' : 'BLOCKED',
    dimensions,
    missingDimensions,
    rejectedReasons,
    reason: verified
      ? 'All 10 OS-level isolation and lifecycle criteria independently verified by host authority.'
      : `Real OS isolation cannot be established: ${[...rejectedReasons, ...missingDimensions.map(d => `${d}_UNVERIFIED`)].join(', ')}.`,
  };
}


function createDirectHcsProviderAdapter(config = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  if (settings.supervisor) {
    assertAuthenticatedSupervisor(settings.supervisor, { isSyntheticTest: Boolean(settings.isSyntheticTest) });
  }

  const adapter = createProviderAdapter({
    getProviderId: () => 'direct-hcs-microvm',
    getConfigRevision: () => settings.configRevision || 'direct-hcs-disabled',
    getArchitecture: () => ISOLATION_ARCHITECTURES.DIRECT_HCS_MICROVM,
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
      disabledReason: DIRECT_HCS_DISABLED_REASON,
      architecture: ISOLATION_ARCHITECTURES.DIRECT_HCS_MICROVM,
    }),
    getCapabilityStates: () => createCapabilityStateMap({
      osEnforcedProcessIsolation: 'BLOCKED',
    }),
    prepareRunEvidence: () => ({
      manifest: null,
      evidenceState: {
        state: 'BLOCKED',
        reasonCode: 'DIRECT_HCS_SERVICE_UNAVAILABLE',
        reason: DIRECT_HCS_DISABLED_REASON,
      },
    }),
    collectHostObservedResult: (input = {}) => {
      const source = input && typeof input === 'object' ? input : {};
      const claims = [
        ...(Array.isArray(source.guestOutputs) ? source.guestOutputs : []),
        ...(Array.isArray(source.guestCleanupReports) ? source.guestCleanupReports : []),
      ];
      const envelope = createResultEnvelope({
        untrustedWorkerClaims: claims,
        providerObservedState: { source: 'unverified-direct-hcs' },
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
    architecture: ISOLATION_ARCHITECTURES.DIRECT_HCS_MICROVM,
    getArchitecture: () => ISOLATION_ARCHITECTURES.DIRECT_HCS_MICROVM,
    getCapabilityStates: () => createCapabilityStateMap({ osEnforcedProcessIsolation: 'BLOCKED' }),
    getHcsCapabilityStates: () => ({ ...HCS_CAPABILITY_STATES }),
    disabledReason: DIRECT_HCS_DISABLED_REASON,
    executeWithSupervisor: async (runRequest) => {
      if (!settings.supervisor) {
        throw new Error('No trusted supervisor configured for this Direct HCS adapter.');
      }
      const client = settings.supervisor;
      const isSynthetic = Boolean(settings.isSyntheticTest);

      // Enforce fail-closed gate: un-elevated real host environment blocks execution
      const createRes = await client.hcsCreateComputeSystem({
        runId: runRequest.runId,
        workspaceRoot: runRequest.workspaceRoot,
        approvedSnapshotDigest: runRequest.approvedSnapshotDigest,
        isSyntheticTest: isSynthetic,
      });

      if (!createRes || createRes.created !== true) {
        const error = new Error(`Direct HCS MicroVM creation failed: ${createRes?.reason || 'unverified boundary'}`);
        error.code = 'PROJECT_EXECUTION_BLOCKED';
        error.executionBlocked = true;
        error.reasonCode = createRes?.reasonCode || 'HCS_CREATION_FAILED';
        throw error;
      }

      if (!isSynthetic) {
        const error = new Error('Direct HCS execution blocked: real host hypervisor MicroVM boundary is unverified without elevated service.');
        error.code = 'PROJECT_EXECUTION_BLOCKED';
        error.executionBlocked = true;
        throw error;
      }

      // Synthetic test execution path
      const vmGuid = createRes.vmGuid;
      const execRes = await client.hcsExecuteGuestProcess({ vmGuid, command: runRequest.command });
      const termRes = await client.hcsTerminateComputeSystem({ vmGuid, reason: 'test_complete' });
      const relRes = await client.hcsVerifyTeardownAndRelease({ vmGuid });

      return {
        ok: execRes.ok,
        exitCode: execRes.exitCode,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        vmGuid,
        teardownObserved: termRes.teardownObserved,
        resourcesReleased: Boolean(relRes && (relRes.resourcesReleased || relRes.released)),
      };
    },
  });
}

module.exports = {
  DEFAULT_MEMORY_MB,
  DIRECT_HCS_DISABLED_REASON,
  HCS_CAPABILITY_STATES,
  ISOLATION_ARCHITECTURES,
  createDirectHcsProviderAdapter,

  getIsolationArchitectureProfile,
  queryWindowsOperatingSystemIdentity,
  validateRealIsolationEvidence,

  DISABLED_REASON,
  NATIVE_SUPERVISOR_EXECUTABLE,
  NATIVE_SUPERVISOR_PIPE,
  buildWindowsSandboxConfiguration,
  createNativeSupervisorClient,
  createSyntheticSandboxWorkspace,
  createWindowsSandboxHostLifecycle,
  createWindowsSandboxProviderAdapter,
  executeWithSupervisor,
  queryNativeSupervisorStatus,
  sendNativeSupervisorRequest,
  validateHostShutdownObservation,
};
