const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  createResultEnvelope,
  evaluateResultEnvelope,
  normalizeTimeoutMs,
} = require('./executionEvidenceContract.cjs');
const {
  createCapabilityStateMap,
  createProviderAdapter,
} = require('./providerAdapterContract.cjs');
const { evaluateLifecycleClaim } = require('./sandboxResourceLifecycle.cjs');

const SENSITIVE_ENV_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'NPM_TOKEN',
  'TOKEN',
  'API_KEY',
  'SECRET',
  'PASSWORD',
]);

const DEFAULT_DOCKER_CLI_TIMEOUT_MS = 5_000;
const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024;
const SYNTHETIC_STAGING_PREFIX = 'ai-help-agent-docker-probe-';
const SYNTHETIC_MEMORY_BYTES = 128 * 1024 * 1024;
const SYNTHETIC_CPU_NANOCPUS = 500_000_000;
const SYNTHETIC_PIDS_LIMIT = 32;
const TRUSTED_HOST_INSPECTIONS = new WeakSet();
let validatedDockerEndpoint = null;
const SYNTHETIC_FIXTURE = [
  'AI Help Agent isolated runtime probe',
  'synthetic workload only',
  'no repository or user data',
  'host-owned temporary fixture',
  'end of synthetic fixture',
].join('\n') + '\n';

function runDockerCli(executable, args, timeoutMs = DEFAULT_DOCKER_CLI_TIMEOUT_MS, encoding = 'utf8') {
  const environmentOverride = Object.entries(process.env)
    .some(([name, value]) => ['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(name.toUpperCase()) && String(value || '').trim());
  const isContextInspection = Array.isArray(args) && args[0] === 'context';
  const endpointArgs = isContextInspection
    ? ['--context', 'default', ...args]
    : validatedDockerEndpoint
      ? ['--host', validatedDockerEndpoint, ...args]
      : null;
  if (environmentOverride || executable !== 'docker' || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string') || !endpointArgs) {
    return {
      status: null,
      signal: null,
      timedOut: false,
      error: 'BLOCKED: Docker CLI invocation has no validated local endpoint or uses an endpoint override.',
      stdout: encoding === 'buffer' ? Buffer.alloc(0) : '',
      stderr: encoding === 'buffer' ? Buffer.alloc(0) : '',
    };
  }
  const env = { ...process.env };
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  let execBinary = executable;
  let finalArgs = endpointArgs;

  if (process.platform === 'win32' && executable === 'docker') {
    let hasNative = false;
    try {
      const probe = spawnSync('docker', ['--version'], { stdio: 'ignore', windowsHide: true });
      hasNative = !probe.error || probe.error.code !== 'ENOENT';
    } catch {
      hasNative = false;
    }
    if (!hasNative) {
      execBinary = 'wsl.exe';
      const translatedArgs = endpointArgs.map((arg) => {
        if (typeof arg === 'string' && /^[a-zA-Z]:[\\/]/.test(arg)) {
          return arg.replace(/^([a-zA-Z]):[\\/](.*)$/, (_, drive, rest) => `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`);
        }
        return arg;
      });
      finalArgs = ['-d', 'Ubuntu', '--', 'docker', ...translatedArgs];
    }
  }

  const result = spawnSync(execBinary, finalArgs, {
    encoding,
    timeout: timeoutMs,
    maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });
  return {
    status: result.status,
    signal: result.signal || null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error ? `${result.error.code || 'PROCESS_ERROR'}: ${result.error.message}` : null,
    stdout: result.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : ''),
    stderr: result.stderr ?? (encoding === 'buffer' ? Buffer.alloc(0) : ''),
  };
}

function validateDockerEndpointPolicy({ contextName, endpoint, environment = process.env, platform = process.platform } = {}) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    return { valid: false, reasonCode: 'DOCKER_ENVIRONMENT_INVALID' };
  }
  const overrides = Object.entries(environment)
    .filter(([name, value]) => ['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(name.toUpperCase()) && String(value || '').trim());
  if (overrides.length > 0) {
    return { valid: false, reasonCode: 'DOCKER_ENDPOINT_OVERRIDE' };
  }
  if (contextName !== 'default') {
    return { valid: false, reasonCode: 'DOCKER_CONTEXT_NOT_DEFAULT' };
  }
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    return { valid: false, reasonCode: 'DOCKER_ENDPOINT_MISSING' };
  }

  const normalizedEndpoint = endpoint.trim().toLowerCase();
  if (platform === 'win32') {
    const isWslUnix = normalizedEndpoint === 'unix:///var/run/docker.sock'
      || /^unix:\/\/\/[^?#\r\n]+$/.test(normalizedEndpoint);
    const valid = isWslUnix
      || normalizedEndpoint === 'npipe:////./pipe/docker_engine'
      || normalizedEndpoint === 'npipe://./pipe/docker_engine';
    return { valid, reasonCode: valid ? 'LOCAL_DOCKER_ENDPOINT' : 'DOCKER_ENDPOINT_NOT_LOCAL' };
  }
  if (platform === 'linux' || platform === 'darwin') {
    const valid = /^unix:\/\/\/[^?#\r\n]+$/.test(normalizedEndpoint)
      && !normalizedEndpoint.startsWith('unix:////');
    return { valid, reasonCode: valid ? 'LOCAL_DOCKER_ENDPOINT' : 'DOCKER_ENDPOINT_NOT_LOCAL' };
  }
  return { valid: false, reasonCode: 'DOCKER_PLATFORM_UNSUPPORTED' };
}

function inspectDockerHost(options = {}) {
  const executable = 'docker';
  const timeoutMs = normalizeTimeoutMs(options.commandTimeoutMs ?? DEFAULT_DOCKER_CLI_TIMEOUT_MS, {
    defaultMs: DEFAULT_DOCKER_CLI_TIMEOUT_MS,
    maxMs: 30_000,
  });
  const environmentOverride = Object.entries(process.env)
    .some(([name, value]) => ['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(name.toUpperCase()) && String(value || '').trim());
  if (environmentOverride) {
    const blocked = Object.freeze({
      documented: true,
      configured: false,
      hasDockerCli: false,
      runtimeAvailable: false,
      independentlyVerified: false,
      serverVersion: null,
      operatingSystem: null,
      architecture: null,
      daemonId: null,
      rootless: false,
      securityOptions: Object.freeze([]),
      daemonAvailable: false,
      endpointPolicy: { valid: false, reasonCode: 'DOCKER_ENDPOINT_OVERRIDE' },
      versionCommand: null,
      infoCommand: null,
      contextCommand: null,
    });
    TRUSTED_HOST_INSPECTIONS.add(blocked);
    return blocked;
  }
  const contextResult = runDockerCli(executable, ['context', 'inspect', 'default', '--format', '{{json .}}'], timeoutMs);
  let contextData = null;
  if (contextResult.status === 0 && !contextResult.error) {
    try {
      contextData = JSON.parse(contextResult.stdout);
    } catch {}
  }
  const contextName = typeof contextData?.Name === 'string' ? contextData.Name : '';
  const endpoint = contextData?.Endpoints?.docker?.Host;
  const endpointPolicy = validateDockerEndpointPolicy({
    contextName,
    endpoint,
    environment: process.env,
    platform: process.platform,
  });
  const emptyHostInspection = {
    documented: true,
    configured: false,
    hasDockerCli: false,
    runtimeAvailable: false,
    independentlyVerified: false,
    serverVersion: null,
    operatingSystem: null,
    architecture: null,
    daemonId: null,
    rootless: false,
    securityOptions: Object.freeze([]),
    daemonAvailable: false,
    endpointPolicy,
    versionCommand: null,
    infoCommand: null,
  };
  if (!endpointPolicy.valid) {
    const hasDockerCli = !/ENOENT|not recognized/i.test(contextResult.error || '');
    const blocked = Object.freeze({
      ...emptyHostInspection,
      configured: hasDockerCli,
      hasDockerCli,
      endpointPolicy,
      contextCommand: {
        exitCode: contextResult.status,
        timedOut: contextResult.timedOut,
        error: contextResult.error,
      },
    });
    TRUSTED_HOST_INSPECTIONS.add(blocked);
    return blocked;
  }
  validatedDockerEndpoint = endpoint;
  const version = runDockerCli(executable, ['version', '--format', '{{.Server.Version}}'], timeoutMs);
  const serverVersion = typeof version.stdout === 'string' ? version.stdout.trim() : '';
  const versionAvailable = version.status === 0 && Boolean(serverVersion);
  const info = versionAvailable
    ? runDockerCli(executable, ['info', '--format', '{{json .}}'], timeoutMs)
    : null;
  let infoData = null;
  if (info?.status === 0) {
    try {
      infoData = JSON.parse(info.stdout);
    } catch {}
  }
  const securityOptions = Array.isArray(infoData?.SecurityOptions) ? infoData.SecurityOptions : [];
  const hasDockerCli = !/ENOENT|not recognized/i.test(version.error || '');
  const daemonAvailable = Boolean(versionAvailable && info?.status === 0 && infoData && typeof infoData.ID === 'string' && infoData.ID.trim());
  const inspection = Object.freeze({
    documented: true,
    configured: hasDockerCli && endpointPolicy.valid,
    hasDockerCli,
    runtimeAvailable: daemonAvailable,
    independentlyVerified: false,
    serverVersion: serverVersion || null,
    operatingSystem: infoData?.OperatingSystem || null,
    architecture: infoData?.Architecture || null,
    daemonId: infoData?.ID || null,
    rootless: securityOptions.some((item) => String(item).toLowerCase().includes('rootless')),
    securityOptions: Object.freeze([...securityOptions]),
    daemonAvailable,
    endpointPolicy,
    contextName,
    endpoint,
    versionCommand: {
      exitCode: version.status,
      timedOut: version.timedOut,
      signal: version.signal,
      error: version.error,
      stderr: typeof version.stderr === 'string' ? version.stderr.trim() : '',
    },
    infoCommand: info ? {
      exitCode: info.status,
      timedOut: info.timedOut,
      signal: info.signal,
      error: info.error,
      stderr: typeof info.stderr === 'string' ? info.stderr.trim() : '',
    } : null,
  });
  TRUSTED_HOST_INSPECTIONS.add(inspection);
  return inspection;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inspectContainer(executable, containerId, timeoutMs) {
  const result = runDockerCli(executable, ['inspect', '--format', '{{json .}}', containerId], timeoutMs);
  if (result.status !== 0 || result.error) return { ...result, data: null };
  try {
    return { ...result, data: JSON.parse(result.stdout) };
  } catch (error) {
    return { ...result, data: null, error: `Invalid docker inspect JSON: ${error.message}` };
  }
}

function noExecutionLifecycle() {
  return {
    executionCompleted: false,
    executionTimedOut: false,
    processTerminated: false,
    containerDeleted: false,
    resourceDeleted: false,
    stagingDirectoryDeleted: false,
    cleanupVerified: false,
    secureErasureProven: 'NOT_ESTABLISHED',
  };
}

async function closeProbeListener(server) {
  if (!server.listening) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), DEFAULT_DOCKER_CLI_TIMEOUT_MS);
    server.close((error) => {
      clearTimeout(timeout);
      resolve(!error);
    });
  });
}

function validateImmutableImageIdentity(imageId) {
  return typeof imageId === 'string' && /^sha256:[a-f0-9]{64}$/i.test(imageId.trim());
}

function validateSyntheticStagingDirectory(stagingDirectory) {
  if (typeof stagingDirectory !== 'string' || !stagingDirectory.trim()) return false;
  try {
    const resolved = path.resolve(stagingDirectory);
    const canonical = fs.realpathSync.native(resolved);
    const temporaryRoot = fs.realpathSync.native(os.tmpdir());
    const relative = path.relative(temporaryRoot, canonical);
    const stat = fs.lstatSync(resolved);
    return canonical === resolved
      && stat.isDirectory()
      && !stat.isSymbolicLink()
      && path.basename(canonical).startsWith(SYNTHETIC_STAGING_PREFIX)
      && relative !== ''
      && !relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative)
      && !canonical.includes(',')
      && !/[\r\n]/.test(canonical);
  } catch {
    return false;
  }
}

function buildDockerContainerRunArgs(options = {}) {
  const request = options && typeof options === 'object' ? options : {};
  const allowedKeys = new Set(['imageId', 'runId', 'stagingDir', 'listenerPort']);
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) {
    throw new Error('Docker launch arguments are restricted to the fixed synthetic-probe contract.');
  }
  const imageId = normalizeString(request.imageId);
  const runId = normalizeString(request.runId);
  const stagingDir = normalizeString(request.stagingDir);
  const listenerPort = Number(request.listenerPort);
  if (!validateImmutableImageIdentity(imageId)) {
    throw new Error('A verified immutable Docker image ID is required.');
  }
  if (!/^[a-f0-9-]{36}$/i.test(runId)) {
    throw new Error('A valid synthetic run ID is required.');
  }
  if (!validateSyntheticStagingDirectory(stagingDir)) {
    throw new Error('Docker staging must be a canonical temporary synthetic-probe directory.');
  }
  const stagedEntries = fs.readdirSync(stagingDir);
  const fixturePath = path.join(stagingDir, 'synthetic-probe.txt');
  const fixtureStat = fs.lstatSync(fixturePath);
  if (stagedEntries.length !== 1 || stagedEntries[0] !== 'synthetic-probe.txt'
    || !fixtureStat.isFile() || fixtureStat.isSymbolicLink()
    || fs.readFileSync(fixturePath, 'utf8') !== SYNTHETIC_FIXTURE) {
    throw new Error('Docker staging must contain only the fixed host-owned synthetic fixture.');
  }
  if (!Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) {
    throw new Error('A valid host-owned probe port is required.');
  }

  const shellCommand = [
    'test "$(wc -l < /workspace/synthetic-probe.txt)" -eq 5 || exit 20',
    'cat /workspace/synthetic-probe.txt',
    'if nc -z -w 2 127.0.0.1 "$PROBE_PORT"; then echo LOOPBACK_HOST_PROBE=CONNECTED; else echo LOOPBACK_HOST_PROBE=FAILED; fi',
    'printf "guest-written cleanup claim (untrusted)\\n" > /tmp/guest-cleanup-claim.txt',
    'echo GUEST_CLEANUP_FILE_WRITTEN',
  ].join('; ');
  return [
    'run', '--detach',
    '--network=none',
    '--memory=128m', '--memory-swap=128m',
    '--cpus=0.5', '--pids-limit=32',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=1m',
    '--label', `ai-help-agent.synthetic-run=${runId}`,
    '--mount', `type=bind,source=${stagingDir},target=/workspace,readonly`,
    '--env', `PROBE_PORT=${listenerPort}`,
    '--entrypoint', 'sh',
    imageId, '-c', shellCommand,
  ];
}

function validateObservedContainerConfiguration(inspectData, expected = {}) {
  if (!inspectData || typeof inspectData !== 'object'
    || inspectData.Id !== expected.containerId
    || inspectData.Image !== expected.imageId
    || inspectData.Config?.Image !== expected.imageId
    || inspectData.Config?.Labels?.['ai-help-agent.synthetic-run'] !== expected.runId) {
    return { valid: false, reasonCode: 'CONTAINER_IDENTITY_MISMATCH' };
  }
  const host = inspectData.HostConfig;
  const tmpfs = host?.Tmpfs;
  const mounts = Array.isArray(inspectData.Mounts) ? inspectData.Mounts : [];
  const stagingMount = mounts.find((mount) => mount.Destination === '/workspace');
  const expectedSource = path.resolve(expected.stagingDirectory || '');
  const observedSource = typeof stagingMount?.Source === 'string' ? path.resolve(stagingMount.Source) : '';
  const sourceMatches = process.platform === 'win32'
    ? observedSource.toLowerCase() === expectedSource.toLowerCase()
    : observedSource === expectedSource;
  const securityOptions = Array.isArray(host?.SecurityOpt) ? host.SecurityOpt : [];
  const valid = host?.NetworkMode === 'none'
    && host?.Memory === SYNTHETIC_MEMORY_BYTES
    && host?.MemorySwap === SYNTHETIC_MEMORY_BYTES
    && host?.NanoCpus === SYNTHETIC_CPU_NANOCPUS
    && host?.PidsLimit === SYNTHETIC_PIDS_LIMIT
    && host?.ReadonlyRootfs === true
    && Array.isArray(host?.CapDrop)
    && host.CapDrop.length === 1
    && host.CapDrop[0] === 'ALL'
    && securityOptions.length === 1
    && /^no-new-privileges(?::true)?$/i.test(securityOptions[0])
    && tmpfs?.['/tmp'] === 'rw,noexec,nosuid,nodev,size=1m'
    && stagingMount?.Type === 'bind'
    && stagingMount?.Destination === '/workspace'
    && stagingMount?.RW === false
    && sourceMatches;
  return {
    valid,
    reasonCode: valid ? 'SYNTHETIC_CONFIG_MATCH' : 'SYNTHETIC_CONFIG_MISMATCH',
  };
}

function classifyNetworkIsolationEvidence(hostAcceptedConnections) {
  if (!Number.isInteger(hostAcceptedConnections) || hostAcceptedConnections < 0) return 'BLOCKED';
  return hostAcceptedConnections > 0 ? 'FAIL' : 'BLOCKED';
}

async function runSyntheticDockerProbe(options = {}) {
  const executable = 'docker';
  const commandTimeoutMs = normalizeTimeoutMs(options.commandTimeoutMs ?? DEFAULT_DOCKER_CLI_TIMEOUT_MS, {
    defaultMs: DEFAULT_DOCKER_CLI_TIMEOUT_MS,
    maxMs: 30_000,
  });
  const executionTimeoutMs = resolveExecutionTimeout({
    executionTimeoutMs: options.executionTimeoutMs ?? 15_000,
    maxTimeoutMs: options.maxTimeoutMs ?? 60_000,
  });
  const image = normalizeString(options.image);
  const runtime = TRUSTED_HOST_INSPECTIONS.has(options.hostInspection)
    ? options.hostInspection
    : null;
  if (!runtime) {
    return {
      classification: 'BLOCKED',
      reason: 'Docker host inspection must be obtained by the internal local-endpoint verifier before a synthetic probe can be prepared.',
      runtime: null,
      lifecycle: noExecutionLifecycle(),
    };
  }
  if (!runtime.daemonAvailable) {
    return {
      classification: 'BLOCKED',
      reason: 'Docker CLI or daemon is unavailable; no staging directory or container was created.',
      runtime,
      lifecycle: noExecutionLifecycle(),
    };
  }
  if (!image) {
    return {
      classification: 'BLOCKED',
      reason: 'An explicitly selected local probe image is required; automatic image selection and pulls are prohibited.',
      runtime,
      lifecycle: noExecutionLifecycle(),
    };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image)) {
    return {
      classification: 'BLOCKED',
      reason: 'Probe image reference contains unsupported characters.',
      runtime,
      lifecycle: noExecutionLifecycle(),
    };
  }

  const imageCheck = runDockerCli(executable, ['image', 'inspect', '--format', '{{.Id}}', image], commandTimeoutMs);
  const imageId = typeof imageCheck.stdout === 'string' ? imageCheck.stdout.trim() : '';
  if (imageCheck.status !== 0 || imageCheck.error || !validateImmutableImageIdentity(imageId)) {
    return {
      classification: 'BLOCKED',
      reason: `The explicitly selected probe image is not available locally; no pull was attempted. ${String(imageCheck.stderr).trim()}`,
      runtime,
      imageInspection: { exitCode: imageCheck.status, timedOut: imageCheck.timedOut, error: imageCheck.error },
      lifecycle: noExecutionLifecycle(),
    };
  }

  const runId = crypto.randomUUID();
  const label = `ai-help-agent.synthetic-run=${runId}`;
  const stagingDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), SYNTHETIC_STAGING_PREFIX));
  const fixturePath = path.join(stagingDirectory, 'synthetic-probe.txt');
  const listener = net.createServer((socket) => socket.destroy());
  let listenerClosed = false;
  let containerId = null;
  let containerLaunchAttempted = false;
  let containerAbsenceConfirmed = false;
  let inspectData = null;
  let executionTimedOut = false;
  let executionCompleted = false;
  let processTerminated = false;
  let containerDeleted = false;
  let stagingDirectoryDeleted = false;
  let cleanupVerified = false;
  let quarantine = false;
  let failureReason = null;
  let logs = null;
  let cleanupFile = null;
  let hostDeadline = null;
  let hostProbeAcceptedConnections = 0;

  try {
    await fsp.writeFile(fixturePath, SYNTHETIC_FIXTURE, { encoding: 'utf8', flag: 'wx' });
    if (!validateSyntheticStagingDirectory(stagingDirectory)) {
      throw new Error('Docker staging directory is not a canonical, non-symlink temporary directory.');
    }
    const stagedEntries = await fsp.readdir(stagingDirectory);
    if (stagedEntries.length !== 1 || stagedEntries[0] !== 'synthetic-probe.txt'
      || await fsp.readFile(fixturePath, 'utf8') !== SYNTHETIC_FIXTURE) {
      throw new Error('Host staging directory does not contain exactly the expected synthetic fixture.');
    }
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    listener.on('connection', () => { hostProbeAcceptedConnections += 1; });
    const listenerPort = listener.address().port;
    const args = buildDockerContainerRunArgs({ imageId, runId, stagingDir: stagingDirectory, listenerPort });
    const startedAt = Date.now();
    hostDeadline = startedAt + executionTimeoutMs;
    containerLaunchAttempted = true;
    const runResult = runDockerCli(executable, args, Math.min(commandTimeoutMs, executionTimeoutMs));
    containerId = typeof runResult.stdout === 'string' ? runResult.stdout.trim() : '';
    if (runResult.status !== 0 || runResult.error || !/^[a-f0-9]{12,64}$/i.test(containerId)) {
      failureReason = runResult.timedOut
        ? 'Docker run timed out before a trustworthy container identity was returned.'
        : `Docker did not return a valid host-observed container ID (exit=${runResult.status}, error=${runResult.error || 'none'}).`;
      quarantine = Boolean(runResult.timedOut || runResult.error);
      if (!quarantine) {
        const byLabel = runDockerCli(executable, ['ps', '-aq', '--filter', `label=${label}`], commandTimeoutMs);
        const ids = String(byLabel.stdout || '').split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
        if (byLabel.status === 0 && !byLabel.error && ids.length === 0) {
          containerAbsenceConfirmed = true;
        } else {
          quarantine = true;
        }
      }
    } else {
      while (Date.now() < hostDeadline) {
        const inspected = inspectContainer(executable, containerId, commandTimeoutMs);
        if (inspected.status !== 0 || inspected.error || !inspected.data) {
          failureReason = `Docker daemon could not provide a trustworthy container inspection: ${inspected.error || String(inspected.stderr).trim()}`;
          quarantine = true;
          break;
        }
        inspectData = inspected.data;
        const observedConfiguration = validateObservedContainerConfiguration(inspectData, {
          containerId,
          imageId,
          runId,
          stagingDirectory,
        });
        if (!observedConfiguration.valid) {
          failureReason = `Docker inspect failed the immutable identity or exact synthetic configuration check (${observedConfiguration.reasonCode}).`;
          quarantine = true;
          break;
        }
        if (inspectData.State?.Running === false && inspectData.State?.Status === 'exited') {
          processTerminated = true;
          executionCompleted = true;
          break;
        }
        await wait(200);
      }
      if (!processTerminated && !quarantine) {
        executionTimedOut = true;
        const stop = runDockerCli(executable, ['stop', '--time', '1', containerId], commandTimeoutMs);
        const afterStop = inspectContainer(executable, containerId, commandTimeoutMs);
        const stoppedConfiguration = validateObservedContainerConfiguration(afterStop.data, {
          containerId,
          imageId,
          runId,
          stagingDirectory,
        });
        if (stop.status === 0 && !stop.error && afterStop.status === 0 && stoppedConfiguration.valid
          && afterStop.data?.State?.Running === false && afterStop.data?.State?.Status === 'exited') {
          inspectData = afterStop.data;
          processTerminated = true;
        } else {
          failureReason = 'Host deadline expired, but container termination could not be independently verified.';
          quarantine = true;
        }
      }
      const logResult = runDockerCli(executable, ['logs', containerId], commandTimeoutMs);
      logs = {
        stdout: String(logResult.stdout || ''),
        stderr: String(logResult.stderr || ''),
        exitCode: logResult.status,
        timedOut: logResult.timedOut,
      };
      const copyResult = runDockerCli(executable, ['cp', `${containerId}:/tmp/guest-cleanup-claim.txt`, '-'], commandTimeoutMs, 'buffer');
      cleanupFile = {
        tarBase64: Buffer.isBuffer(copyResult.stdout) ? copyResult.stdout.toString('base64') : '',
        exitCode: copyResult.status,
        timedOut: copyResult.timedOut,
        error: copyResult.error,
      };
    }

    if (containerId && processTerminated) {
      const remove = runDockerCli(executable, ['rm', '-f', containerId], commandTimeoutMs);
      const inspectAfterRemove = inspectContainer(executable, containerId, commandTimeoutMs);
      const listAfterRemove = runDockerCli(executable, ['ps', '-aq', '--filter', `id=${containerId}`], commandTimeoutMs);
      containerDeleted = remove.status === 0 && !remove.error
        && inspectAfterRemove.status !== 0 && !inspectAfterRemove.error
        && listAfterRemove.status === 0 && !listAfterRemove.error
        && !String(listAfterRemove.stdout).trim();
      if (!containerDeleted) {
        failureReason = 'Docker container removal or daemon-side absence could not be verified.';
        quarantine = true;
      }
    }
    listenerClosed = await closeProbeListener(listener);
    if (!listenerClosed) {
      failureReason = 'The host-owned loopback probe listener did not close cleanly.';
      quarantine = true;
    }
    if (!quarantine && (containerDeleted || !containerLaunchAttempted || containerAbsenceConfirmed)) {
      await fsp.rm(stagingDirectory, { recursive: true, force: false });
      try {
        await fsp.stat(stagingDirectory);
      } catch (error) {
        if (error.code === 'ENOENT') stagingDirectoryDeleted = true;
        else throw error;
      }
      cleanupVerified = processTerminated && containerDeleted && stagingDirectoryDeleted && listenerClosed;
      if (containerLaunchAttempted && containerAbsenceConfirmed && !containerId && stagingDirectoryDeleted && listenerClosed) {
        cleanupVerified = false;
      }
      if (containerLaunchAttempted && containerId && !cleanupVerified) {
        failureReason = 'One or more independent cleanup observations are missing.';
        quarantine = true;
      }
    } else {
      quarantine = true;
    }
  } catch (error) {
    failureReason = error.message;
    quarantine = containerLaunchAttempted;
    listenerClosed = await closeProbeListener(listener);
    if (!containerLaunchAttempted && listenerClosed) {
      try {
        await fsp.rm(stagingDirectory, { recursive: true, force: false });
        try {
          await fsp.stat(stagingDirectory);
        } catch (statError) {
          if (statError.code === 'ENOENT') stagingDirectoryDeleted = true;
          else throw statError;
        }
      } catch {
        quarantine = true;
      }
    }
  }

  const guestReportedNetworkOutcome = logs?.stdout?.includes('LOOPBACK_HOST_PROBE=CONNECTED')
    ? 'GUEST_CLAIMED_CONNECTED'
    : logs?.stdout?.includes('LOOPBACK_HOST_PROBE=FAILED')
      ? 'GUEST_CLAIMED_FAILED'
      : 'NOT_OBSERVED';
  const appVerifiedFacts = {
    executionCompleted,
    executionTimedOut,
    processTerminated,
    containerDeleted,
    resourceDeleted: containerDeleted,
    stagingDirectoryDeleted,
    cleanupVerified,
    quarantined: quarantine,
    secureErasureProven: 'NOT_ESTABLISHED',
    exitCode: Number.isInteger(inspectData?.State?.ExitCode) ? inspectData.State.ExitCode : null,
    networkMode: inspectData?.HostConfig?.NetworkMode || null,
    readOnlyRootfs: inspectData?.HostConfig?.ReadonlyRootfs === true,
    memoryLimitBytes: inspectData?.HostConfig?.Memory ?? null,
    pidsLimit: inspectData?.HostConfig?.PidsLimit ?? null,
    cpuLimitNanoCpus: inspectData?.HostConfig?.NanoCpus ?? null,
    capDropAll: Array.isArray(inspectData?.HostConfig?.CapDrop) && inspectData.HostConfig.CapDrop.includes('ALL'),
    noNewPrivileges: Array.isArray(inspectData?.HostConfig?.SecurityOpt)
      && inspectData.HostConfig.SecurityOpt.some((item) => String(item).toLowerCase().startsWith('no-new-privileges')),
    hostLoopbackListenerAcceptedConnections: hostProbeAcceptedConnections,
  };
  const untrustedWorkerClaims = [];
  if (logs) untrustedWorkerClaims.push({ kind: 'container-logs', ...logs });
  if (cleanupFile) untrustedWorkerClaims.push({ kind: 'container-cleanup-file-tar', ...cleanupFile });
  const networkProbe = {
    classification: classifyNetworkIsolationEvidence(hostProbeAcceptedConnections),
    test: 'Guest attempts TCP connection to a host-owned 127.0.0.1 listener on an ephemeral port while container uses --network=none.',
    guestReportedOutcome: guestReportedNetworkOutcome,
    hostObservedAcceptedConnections: hostProbeAcceptedConnections,
    limitation: 'Only a host-observed accepted connection proves a violation. No connection does not prove the guest attempted it or establish all-network isolation.',
  };
  const mandatoryVerified = !failureReason && cleanupVerified && executionCompleted
    && appVerifiedFacts.exitCode === 0
    && appVerifiedFacts.networkMode === 'none'
    && appVerifiedFacts.readOnlyRootfs
    && appVerifiedFacts.capDropAll
    && appVerifiedFacts.noNewPrivileges
    && appVerifiedFacts.memoryLimitBytes === SYNTHETIC_MEMORY_BYTES
    && appVerifiedFacts.cpuLimitNanoCpus === SYNTHETIC_CPU_NANOCPUS
    && appVerifiedFacts.pidsLimit === SYNTHETIC_PIDS_LIMIT
    && networkProbe.classification === 'PASS';
  const envelope = createResultEnvelope({
    untrustedWorkerClaims,
    providerObservedState: {
      containerId: containerId || null,
      source: 'docker-daemon-inspect',
      observedState: inspectData?.State?.Status || 'unknown',
    },
    appVerifiedFacts,
    acceptedEvidence: cleanupVerified
      ? { processTerminated, containerDeleted, stagingDirectoryDeleted, cleanupVerified }
      : {},
  });
  const evidenceEvaluation = evaluateResultEnvelope(envelope);
  const classification = mandatoryVerified
    ? 'PASS'
    : (quarantine ? 'UNCERTAIN' : 'BLOCKED');
  return {
    classification,
    reason: failureReason || (mandatoryVerified
      ? 'Synthetic container lifecycle and host-observed teardown completed. The guest network-attempt output remains untrusted.'
      : 'One or more mandatory runtime or teardown claims were not independently verified.'),
    runId,
    runtime,
    image: { reference: image, imageId },
    hostDeadline,
    providerObservedState: { containerId: containerId || null, source: 'docker-daemon-inspect' },
    appVerifiedFacts,
    untrustedWorkerClaims,
    envelope,
    evidenceEvaluation,
    lifecycle: {
      executionCompleted,
      processTerminated,
      containerDeleted,
      resourceDeleted: containerDeleted,
      stagingDirectoryDeleted,
      cleanupVerified,
      secureErasureProven: 'NOT_ESTABLISHED',
      quarantined: quarantine,
    },
    networkProbe,
    containerLaunchAttempted,
    stagingDirectory: stagingDirectoryDeleted ? 'deleted-and-host-verified' : `retained-or-uncertain:${stagingDirectory}`,
    hostProbeListenerClosed: listenerClosed,
  };
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveExecutionTimeout(config = {}) {
  const effectiveConfig = config && typeof config === 'object' ? config : {};
  const effectiveTimeout = effectiveConfig.executionTimeoutMs ?? effectiveConfig.timeoutMs ?? effectiveConfig.hostTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return normalizeTimeoutMs(effectiveTimeout, {
    defaultMs: DEFAULT_TIMEOUT_MS,
    maxMs: effectiveConfig.maxTimeoutMs ?? MAX_TIMEOUT_MS,
  });
}

function detectDockerRuntime(config = {}) {
  const effectiveConfig = config && typeof config === 'object' ? config : {};
  const hostInspection = TRUSTED_HOST_INSPECTIONS.has(effectiveConfig.hostInspection)
    ? effectiveConfig.hostInspection
    : null;

  return {
    daemonAvailable: hostInspection?.daemonAvailable === true,
    rootless: hostInspection?.rootless === true,
    networkIsolationVerified: false,
    securityProfileVerified: false,
    hasDockerCli: hostInspection?.hasDockerCli === true,
    cleanupEvidence: false,
  };
}

function getDockerCapabilities(config = {}) {
  const effectiveConfig = config && typeof config === 'object' ? config : {};
  const runtime = detectDockerRuntime(effectiveConfig);
  const configured = Boolean(effectiveConfig.enabled !== false);

  return {
    documented: true,
    configured,
    runtimeAvailable: runtime.daemonAvailable,
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
    cleanupEvidence: runtime.cleanupEvidence,
  };
}

function validateDockerLaunchRequest(request = {}) {
  const source = request && typeof request === 'object' ? request : {};
  const repoRoot = normalizeString(source.repoRoot || source.projectRoot || source.workspaceRoot);
  const workspaceMount = normalizeString(source.workspaceMount || source.mountRoot || source.mountPath || '');
  const networkMode = normalizeString(source.networkMode || 'none');
  const hostCredentialEnv = source.hostCredentialEnv && typeof source.hostCredentialEnv === 'object'
    ? source.hostCredentialEnv
    : {};
  const unsupportedOptions = [
    'extraArgs', 'command', 'image', 'mounts', 'mount', 'stagingDir', 'ephemeralDir',
    'ephemeralMountDir', 'device', 'devices', 'dockerSocket', 'privileged',
    'allowPrivileged', 'pidMode', 'ipcMode', 'networkModeOverride',
  ];
  const unsupportedOption = unsupportedOptions.find((name) => Object.hasOwn(source, name));
  if (unsupportedOption) {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: `Docker launch request rejected: generic option '${unsupportedOption}' is not supported; only the fixed synthetic-probe argument contract is available.`,
    };
  }

  try {
    const timeoutMs = resolveExecutionTimeout({
      executionTimeoutMs: source.executionTimeoutMs ?? source.timeoutMs ?? source.hostTimeoutMs,
      maxTimeoutMs: source.maxTimeoutMs ?? MAX_TIMEOUT_MS,
    });
    if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
      throw new Error('Host execution timeout configuration is invalid.');
    }
  } catch (error) {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: `Docker launch request rejected: invalid host execution timeout (${error.message}).`,
    };
  }

  if (source.privileged === true || source.allowPrivileged === true) {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: 'Docker launch request rejected: privileged mode is not allowed.',
    };
  }

  if (networkMode !== 'none') {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: `Docker launch request rejected: network mode must remain 'none'; received '${networkMode}'.`,
    };
  }

  if (source.allowUnrestrictedNetwork === true || source.unrestrictedNetwork === true) {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: 'Docker launch request rejected: unrestricted network egress is forbidden.',
    };
  }

  if (Object.keys(hostCredentialEnv).length > 0) {
    const leakedKeys = Object.keys(hostCredentialEnv).filter((key) => {
      const normalized = key.toUpperCase();
      return SENSITIVE_ENV_KEYS.has(normalized) || normalized.includes('TOKEN') || normalized.includes('SECRET') || normalized.includes('KEY');
    });
    if (leakedKeys.length > 0) {
      return {
        valid: false,
        reasonCode: 'BLOCKED',
        reason: `Docker launch request rejected: host credentials were provided in environment variables (${leakedKeys.join(', ')}).`,
      };
    }
  }

  if (source.environment && typeof source.environment === 'object') {
    for (const [key, value] of Object.entries(source.environment)) {
      const upper = String(key).toUpperCase();
      if (SENSITIVE_ENV_KEYS.has(upper) || upper.includes('TOKEN') || upper.includes('SECRET') || upper.includes('KEY')) {
        return {
          valid: false,
          reasonCode: 'BLOCKED',
          reason: `Docker launch request rejected: sensitive environment variable '${key}' is forbidden in the container environment.`,
        };
      }
    }
  }

  if (workspaceMount || source.mountRoot || source.mountPath) {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: 'Docker launch request rejected: arbitrary host mounts are unsupported.',
    };
  }

  if (repoRoot && (repoRoot.toLowerCase().includes('.git') || repoRoot.toLowerCase().includes('docker.sock'))) {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: 'Docker launch request rejected: repository metadata or Docker socket paths are not valid staging roots.',
    };
  }

  if (source.mountRoot) {
    return {
      valid: false,
      reasonCode: 'BLOCKED',
      reason: 'Docker launch request rejected: generic mount roots are unsupported.',
    };
  }

  return { valid: true, reasonCode: 'VALID', reason: 'Docker launch request passed fail-closed validation.' };
}

function createLocalDockerProviderAdapter(config = {}) {
  const effectiveConfig = config && typeof config === 'object' ? config : {};
  const adapter = createProviderAdapter({
    getProviderId() {
      return 'local-docker';
    },
    getConfigRevision() {
      return effectiveConfig.configRevision || 'docker-config-default';
    },
    getCapabilities() {
      return getDockerCapabilities(effectiveConfig);
    },
    getCapabilityStates() {
      return createCapabilityStateMap({
        osEnforcedProcessIsolation: 'BLOCKED',
      });
    },
    prepareRunEvidence(runContext = {}) {
      return {
        manifest: null,
        evidenceState: Object.freeze({
          state: 'NOT_ESTABLISHED',
          reasonCode: 'HOST_VERIFIER_NOT_ESTABLISHED',
          reason: 'The Docker adapter has no trusted project-execution authorization issuer or host verifier.',
        }),
      };
    },
    collectHostObservedResult(rawRunState = {}) {
      const source = rawRunState && typeof rawRunState === 'object' ? rawRunState : {};
      const untrustedWorkerClaims = [
        ...(Array.isArray(source.guestOutputs) ? source.guestOutputs : []),
        ...(Array.isArray(source.guestCleanupReports) ? source.guestCleanupReports : []),
        ...(source.appVerifiedFacts && typeof source.appVerifiedFacts === 'object' ? [source.appVerifiedFacts] : []),
        ...(source.providerObservedState && typeof source.providerObservedState === 'object' ? [source.providerObservedState] : []),
        ...(source.acceptedEvidence && typeof source.acceptedEvidence === 'object' ? [source.acceptedEvidence] : []),
        source,
      ];
      const envelope = createResultEnvelope({
        untrustedWorkerClaims,
        providerObservedState: { source: 'untrusted-caller-input' },
        appVerifiedFacts: {},
        acceptedEvidence: {},
      });
      const evaluation = evaluateResultEnvelope(envelope);
      return {
        envelope,
        evaluation,
        quarantine: true,
        cleanupVerified: false,
        deletionAuthorized: false,
        timeoutVerified: false,
        processTerminated: false,
        containerRemoved: false,
        stagingDirectoryRemoved: false,
      };
    },
  });

  const hostVerifier = {
    inspectHostRuntime() {
      return TRUSTED_HOST_INSPECTIONS.has(effectiveConfig.hostInspection)
        ? effectiveConfig.hostInspection
        : inspectDockerHost(effectiveConfig);
    },
    runSyntheticProbe(options = {}) {
      return runSyntheticDockerProbe({
        ...effectiveConfig,
        ...(options && typeof options === 'object' ? options : {}),
      });
    },
    checkDockerAvailability() {
      return detectDockerRuntime(effectiveConfig).daemonAvailable;
    },
    assertLaunchRequest(request) {
      const result = validateDockerLaunchRequest(request);
      if (!result.valid) {
        throw new Error(result.reason);
      }
      return result;
    },
    resolveExecutionTimeout(config = {}) {
      return resolveExecutionTimeout({
        ...effectiveConfig,
        ...(config && typeof config === 'object' ? config : {}),
      });
    },
    evaluateLifecycle(claim, evidence = null, expectedContext = {}) {
      return evaluateLifecycleClaim(claim, evidence, expectedContext);
    },
  };

  return Object.freeze({
    ...adapter,
    ...hostVerifier,
  });
}

module.exports = {
  createLocalDockerProviderAdapter,
  detectDockerRuntime,
  getDockerCapabilities,
  inspectDockerHost,
  resolveExecutionTimeout,
  runSyntheticDockerProbe,
  validateDockerEndpointPolicy,
  validateImmutableImageIdentity,
  classifyNetworkIsolationEvidence,
  validateSyntheticStagingDirectory,
  validateObservedContainerConfiguration,
  validateDockerLaunchRequest,
  runDockerCli,
};
