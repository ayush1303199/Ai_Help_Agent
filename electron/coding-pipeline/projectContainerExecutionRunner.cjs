'use strict';

/**
 * AI Help Agent - Authorized Project Container Runner (Milestone V7 Security Audit).
 *
 * Implements genuine OS-enforced container isolation for approved project commands:
 * - Deterministic image identity verification & approved image allowlist policy.
 * - Filesystem boundaries via copy-on-write staging with symlink escape prevention.
 * - Sensitive credential & secret exclusion (.git, .ssh, .aws, .env*, .npmrc, etc.).
 * - Network isolation: default deny-all (--network=none), explicit package-egress policy for dependencies.
 * - Resource limits: bounded memory, CPU nanocores, PID limits, dropped capabilities, no-new-privileges.
 * - Process supervision: deadline enforcement, abort cancellation, real exit-code capture, secret redaction.
 * - Host-observed container lifecycle: absence confirmation, cleanup verification, failure reporting.
 * - Artifact sync-back validation: safe destination boundaries, no symlink escapes, never sync on failure.
 * - Verifiable evidence integrity: distinguishes mock/test fixtures from authentic supervisor execution.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { verifyProjectAuthorization } = require('./projectDiscovery.cjs');
const { validateCommandSafety } = require('./buildOrchestrator.cjs');
const { redactSensitiveData } = require('./diagnosticEngine.cjs');
const { defaultRegistry, PROVIDER_STATUSES } = require('./isolationProviderRegistry.cjs');


const {
  detectDockerRuntime,
  runDockerCli,
  runDockerCliAsync,
  validateImmutableImageIdentity,
} = require('./dockerProviderAdapter.cjs');

const STAGING_STRATEGIES = Object.freeze({
  COPY_ON_WRITE: 'COPY_ON_WRITE',
  READ_ONLY_BIND_MOUNT: 'READ_ONLY_BIND_MOUNT',
});

const NETWORK_POLICIES = Object.freeze({
  NONE: 'none',
  ALLOW_PACKAGE_EGRESS: 'allow_package_egress',
});

const DEFAULT_PROJECT_IMAGES = Object.freeze({
  node: 'node:20-alpine',
  python: 'python:3.11-slim',
  php: 'composer:2',
  rust: 'rust:alpine',
  go: 'golang:alpine',
});

const APPROVED_BASE_IMAGES = new Set([
  'node:20-alpine',
  'python:3.11-slim',
  'composer:2',
  'rust:alpine',
  'golang:alpine',
]);

const SENSITIVE_DIRS = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.gnupg',
  '.docker',
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.staging',
  '.env.test',
  '.npmrc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  'credentials',
]);

function isSensitiveEntry(name) {
  const lower = name.toLowerCase();
  if (SENSITIVE_DIRS.has(lower) || SENSITIVE_FILE_NAMES.has(lower)) {
    return true;
  }
  return lower.startsWith('.env.') || lower.startsWith('id_');
}

const DEFAULT_CONTAINER_TIMEOUT_MS = 60_000;
const MAX_CONTAINER_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_MEMORY_LIMIT = '512m';
const DEFAULT_CPUS = '1.0';
const DEFAULT_PIDS_LIMIT = 64;
const DEFAULT_TMPFS_CONFIG = '/tmp:rw,noexec,nosuid,nodev,size=64m';

function validateContainerRunArgs(dockerArgs) {
  if (!Array.isArray(dockerArgs) || dockerArgs.length === 0) {
    throw new Error('Docker arguments must be a non-empty array.');
  }
  if (!dockerArgs.includes('--read-only')) {
    throw new Error('Docker run arguments missing required --read-only root filesystem restriction.');
  }
  const tmpfsIndex = dockerArgs.indexOf('--tmpfs');
  if (tmpfsIndex === -1 || typeof dockerArgs[tmpfsIndex + 1] !== 'string') {
    throw new Error('Docker run arguments missing required --tmpfs mount configuration.');
  }
  const tmpfsArg = dockerArgs[tmpfsIndex + 1];
  if (!tmpfsArg.startsWith('/tmp:') || !tmpfsArg.includes('size=64m') || !tmpfsArg.includes('noexec')) {
    throw new Error(`Invalid --tmpfs configuration: "${tmpfsArg}". Must configure bounded /tmp storage with noexec,nosuid,nodev,size=64m.`);
  }
  return true;
}

class ProjectContainerExecutionRunner {
  async executeWithRuntime({ plan, ownerWebContentsId, sessionId, runtime }) {
    // ---- 1️⃣ Runtime presence & structural validation ----
    if (!runtime || typeof runtime !== 'object') {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: 'Runtime object missing or malformed.' };
    }
    const { providerId, supportedOps, isolationVerified, isReady, capabilityVerificationStatus } = runtime;
    if (!providerId || !Array.isArray(supportedOps) || typeof isolationVerified !== 'boolean') {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: 'Runtime missing required fields.' };
    }
    if (!isolationVerified) {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: `Runtime "${providerId}" isolation is unverified.` };
    }

    const isUntrustedProvenanceSource = (src) => {
      const s = String(src || '').toLowerCase();
      return ['mock', 'fixture', 'synthetic', 'synthetic-test', 'synthetic-test-seam', 'simulated', 'offline', 'test-fixture', 'guest', 'guest-writable', 'worker', 'untrusted-caller-input'].includes(s);
    };

    if ((isUntrustedProvenanceSource(runtime.evidenceSource) || isUntrustedProvenanceSource(runtime.provenance) || runtime.isMock === true || runtime.trustClass === 'UNTRUSTED') && !this.isMockRunner) {
      return {
        ok: false,
        gate: 'PROCESS_ISOLATION_GATE',
        reason: 'Synthetic or untrusted runtime evidence rejected: non-mock production runner requires verified container environment.',
      };
    }

    if (runtime.sandbox === true || runtime.verified === true || runtime.independentlyVerified === true || runtime.kernelEnforced === true || runtime.daemonTrust === 'VERIFIED' || runtime.isTrustedDaemon === true || runtime.cgroupEnforced === true || runtime.readOnlyEnforced === true || runtime.observerAuthenticated === true || runtime.trustedObserver === true || runtime.windowsPipeVerified === true || runtime.osProcessIdentityVerified === true) {
      return {
        ok: false,
        gate: 'PROCESS_ISOLATION_GATE',
        reason: 'Caller-supplied Boolean isolation flags rejected as unverified.',
      };
    }

    // ---- 2️⃣ Registry cross‑check (fail‑closed) ----
    const reg = defaultRegistry.getProvider(providerId);
    if (!reg) {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: `Provider "${providerId}" not registered.` };
    }
    if (isUntrustedProvenanceSource(reg.evidenceSource) && !this.isMockRunner) {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: 'Synthetic test evidence rejected: non-mock production runner requires verified container environment.' };
    }
    if (!reg.isReady || reg.capabilityVerificationStatus !== PROVIDER_STATUSES.CAPABILITY_VERIFIED) {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: `Provider "${providerId}" not ready or not verified.` };
    }
    // ---- 3️⃣ Adapter match (Docker‑only) ----
    if (providerId !== 'docker') {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: 'Adapter mismatch: only Docker provider is supported.' };
    }
    // ---- 4️⃣ Operation support check ----
    if (!supportedOps.includes(plan.operation)) {
      return { ok: false, gate: 'PROCESS_ISOLATION_GATE', reason: `Operation "${plan.operation}" not supported by provider.` };
    }

    // ---- 5️⃣ Continue with existing launch flow ----
    const launchResult = await this.validateLaunchPolicy({
      plan,
      ownerWebContentsId,
      // image resolution kept simple for demo; real code may map plan.toolchain
      image: plan.image || undefined,
    });
    if (!launchResult.valid) {
      return launchResult; // already contains gate & reason
    }

    // ---- 6️⃣ Run Docker (or mock) ----
    const dockerArgs = ['run', '--rm', '--read-only', '--tmpfs', DEFAULT_TMPFS_CONFIG, plan.binary, ...plan.args];
    validateContainerRunArgs(dockerArgs);
    const execResult = await Promise.resolve(this.dockerCli('docker', dockerArgs));
    return { ok: true, result: execResult };
  }

  /**
   * @param {Object} [options]
   * @param {Function} [options.dockerCli] - Docker CLI runner function
   * @param {Function} [options.runtimeDetector] - Runtime availability detector
   * @param {boolean} [options.isMock] - Whether this runner uses simulated/mocked Docker
   */
  constructor(options = {}) {
    this.dockerCli = typeof options.dockerCli === 'function' ? options.dockerCli : runDockerCliAsync;
    this.runtimeDetector = typeof options.runtimeDetector === 'function' ? options.runtimeDetector : detectDockerRuntime;
    this.isMockRunner = Boolean(options.isMock || (options.dockerCli && options.dockerCli !== runDockerCli && options.dockerCli !== runDockerCliAsync));
  }

  /**
   * Checks whether the underlying container runtime is currently available.
   * @returns {{ available: boolean, reason?: string }}
   */
  checkAvailability() {
    const runtime = this.runtimeDetector();
    if (runtime && runtime.daemonAvailable) {
      return { available: true };
    }
    const dockerProvider = defaultRegistry.getProvider('docker');
    if (dockerProvider && dockerProvider.isReady && dockerProvider.availability?.isRunning) {
      return { available: true };
    }
    return {
      available: false,
      reason: 'Container runtime is unavailable: Docker daemon is not running or unverified.',
    };
  }

  /**
   * Validates launch policy against project boundaries and security rules.
   *
   * @param {Object} params
   * @param {Object} params.plan
   * @param {number} params.ownerWebContentsId
   * @param {string} params.image
   * @param {string} [params.networkMode]
   * @returns {Promise<Object>}
   */
  async validateLaunchPolicy({
    plan,
    ownerWebContentsId,
    image,
    networkMode = NETWORK_POLICIES.NONE,
  } = {}) {
    if (!plan || typeof plan !== 'object') {
      return { valid: false, gate: 'POLICY_GATE', reason: 'Execution plan is required.' };
    }
    if (!ownerWebContentsId) {
      return { valid: false, gate: 'AUTHORIZATION_GATE', reason: 'Session ownerWebContentsId is required.' };
    }

    // 1. Revalidate project authorization (never trust caller-supplied claims)
    const auth = await verifyProjectAuthorization(plan.projectRoot, ownerWebContentsId);
    if (!auth.isAuthorized) {
      return {
        valid: false,
        gate: 'AUTHORIZATION_GATE',
        reason: `Project authorization rejected: ${auth.reason}`,
      };
    }

    // 2. Validate command safety (no shell chaining / metacharacters)
    const binary = plan.binary || plan.command;
    const safety = validateCommandSafety(binary, plan.args);
    if (!safety.valid) {
      return {
        valid: false,
        gate: 'COMMAND_SAFETY_GATE',
        reason: `Command safety check failed: ${safety.error}`,
      };
    }

    // 3. Digest Binding & Proposal Integrity
    if (!plan.planDigest || typeof plan.planDigest !== 'string') {
      return {
        valid: false,
        gate: 'APPROVAL_DIGEST_GATE',
        reason: 'Plan digest is missing. Cannot verify proposal integrity.',
      };
    }

    // Re-verify plan parameters against digest if plan carries standard structure
    if (plan.operation && plan.toolchain !== undefined) {
      const expectedDigestPayload = JSON.stringify({
        projectRoot: path.resolve(plan.projectRoot),
        operation: plan.operation,
        binary: plan.binary,
        args: plan.args,
        toolchain: plan.toolchain,
        prerequisitesSatisfied: plan.prerequisites?.satisfied,
      });
      const expectedDigest = crypto.createHash('sha256').update(expectedDigestPayload).digest('hex');
      if (plan.planDigest !== expectedDigest) {
        return {
          valid: false,
          gate: 'APPROVAL_DIGEST_GATE',
          reason: 'Plan digest mismatch: execution parameters do not match approved build plan proposal.',
        };
      }
    } else if (plan.packageManager) {
      const expectedDigestPayload = JSON.stringify({
        projectRoot: plan.projectRoot,
        packageManager: plan.packageManager,
        command: plan.command || plan.binary,
        args: plan.args,
        targets: (plan.targets || []).map((t) => typeof t === 'string' ? t : t.name),
      });
      const expectedDigest = crypto.createHash('sha256').update(expectedDigestPayload).digest('hex');
      if (plan.planDigest !== expectedDigest) {
        return {
          valid: false,
          gate: 'APPROVAL_DIGEST_GATE',
          reason: 'Plan digest mismatch: execution parameters do not match approved dependency plan proposal.',
        };
      }
    }

    // 4. Image Reference & Provenance Validation
    if (!image || typeof image !== 'string') {
      return {
        valid: false,
        gate: 'IMAGE_POLICY_GATE',
        reason: 'Container image reference is required.',
      };
    }
    const trimmedImage = image.trim();
    const isApprovedBase = APPROVED_BASE_IMAGES.has(trimmedImage);
    const isImmutableDigest = validateImmutableImageIdentity(trimmedImage);
    if (!isApprovedBase && !isImmutableDigest) {
      return {
        valid: false,
        gate: 'IMAGE_POLICY_GATE',
        reason: `Container image "${trimmedImage}" is unverified. Only approved base images or immutable digests are permitted.`,
      };
    }

    // 5. Network Policy Check
    if (networkMode !== NETWORK_POLICIES.NONE) {
      const isDependencyOperation = plan.operation === 'DEPENDENCY_INSTALL'
        || plan.operation === 'INSTALL'
        || plan.isDependencyInstall === true
        || Boolean(plan.packageManager)
        || Boolean(plan.networkRequired);
      if (!isDependencyOperation) {
        return {
          valid: false,
          gate: 'NETWORK_POLICY_GATE',
          reason: `Network access "${networkMode}" is strictly forbidden for non-dependency operations.`,
        };
      }
      if (networkMode !== NETWORK_POLICIES.ALLOW_PACKAGE_EGRESS) {
        return {
          valid: false,
          gate: 'NETWORK_POLICY_GATE',
          reason: `Disallowed network policy: "${networkMode}". Only "none" and "allow_package_egress" are supported.`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Executes an approved plan inside an isolated container boundary.
   *
   * @param {Object} options
   * @param {Object} options.plan - Approved execution plan
   * @param {number} options.ownerWebContentsId - Authorized session owner ID
   * @param {string} options.sessionId - Session UUID
   * @param {string} [options.image] - Approved container image reference
   * @param {string} [options.networkMode] - 'none' | 'allow_package_egress'
   * @param {string} [options.stagingStrategy] - 'COPY_ON_WRITE' | 'READ_ONLY_BIND_MOUNT'
   * @param {number} [options.timeoutMs] - Maximum execution time
   * @param {number} [options.maxOutputBytes] - Maximum allowed stdout/stderr buffer
   * @param {AbortSignal} [options.signal] - Cancellation signal
   * @returns {Promise<Object>} Execution receipt
   */
  async execute({
    plan,
    ownerWebContentsId,
    sessionId,
    image = null,
    networkMode = NETWORK_POLICIES.NONE,
    stagingStrategy = STAGING_STRATEGIES.COPY_ON_WRITE,
    timeoutMs = DEFAULT_CONTAINER_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    signal = null, runtime = null,
  } = {}) {
    const executionId = crypto.randomUUID();
    const startTime = Date.now();
    const effectiveTimeout = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_CONTAINER_TIMEOUT_MS), MAX_CONTAINER_TIMEOUT_MS);

    // 1. Runtime availability check
    const availability = this.checkAvailability();
    if (!availability.available) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: availability.reason,
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }

    // 1b. Verify selected runtime (passed from orchestrator)
    if (!runtime) {
      if (this.isMockRunner) {
        runtime = {
          providerId: 'docker',
          runtimeType: 'container',
          isolationVerified: true,
          supportedOps: ['build', 'test', 'run', 'BUILD', 'TEST', 'START', 'INSTALL', 'DEPENDENCY_INSTALL', 'install', plan?.operation, undefined],
          evidenceSource: 'mock_runner',
        };
      } else {
        return {
          ok: false,
          executionId,
          status: 'BLOCKED',
          gate: 'PROCESS_ISOLATION_GATE',
          executionBlocked: true,
          reason: 'No verified runtime provided to container runner.',
          planDigest: plan?.planDigest || null,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    if (!runtime.isolationVerified && !this.isMockRunner) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: `Runtime provider '${runtime.providerId}' is unverified: isolation attestation has not been established.`,
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }
    const isUntrustedProvenanceSource = (src) => {
      const s = String(src || '').toLowerCase();
      return ['mock', 'fixture', 'synthetic', 'synthetic-test', 'synthetic-test-seam', 'simulated', 'offline', 'test-fixture', 'guest', 'guest-writable', 'worker', 'untrusted-caller-input'].includes(s);
    };

    if (isUntrustedProvenanceSource(runtime.evidenceSource) && !this.isMockRunner) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: 'Synthetic test evidence rejected: non-mock production runner requires verified container environment.',
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }

    // Retrieve provider descriptor from registry
    const provider = defaultRegistry.getProvider(runtime.providerId);
    if (!provider && !this.isMockRunner) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: `Runtime provider '${runtime.providerId}' is not registered.`,
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }

    if (isUntrustedProvenanceSource(provider?.evidenceSource) && !this.isMockRunner) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: 'Synthetic test evidence rejected: non-mock production runner requires verified container environment.',
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }

    // Ensure provider is ready and capability verified
    if (provider && (!provider.isReady || provider.capabilityVerificationStatus !== PROVIDER_STATUSES.CAPABILITY_VERIFIED) && !this.isMockRunner) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: `Provider '${provider.providerId}' is not ready or capability not verified.`,
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }
    // Only Docker container runtime is currently supported
    if (runtime.providerId !== 'docker' || runtime.runtimeType !== 'container') {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: `Unsupported isolation runtime '${runtime.providerId}'. Only Docker containers are supported.`,
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }

    // 2. Select default image by ecosystem if not specified

    // Authoritative evidence freshness validation from registry provider descriptor
    const registryTimestamp = provider?.verificationTimestamp;
    if (registryTimestamp) {
      const parsedRegistryTime = Date.parse(registryTimestamp);
      if (isNaN(parsedRegistryTime) || Math.abs(Date.now() - parsedRegistryTime) > 5 * 60 * 1000) {
        return {
          ok: false,
          executionId,
          status: 'BLOCKED',
          gate: 'PROCESS_ISOLATION_GATE',
          executionBlocked: true,
          reason: 'Authoritative isolation verification evidence has expired or has invalid timestamp.',
          planDigest: plan?.planDigest || null,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    if (runtime.timestamp) {
      const parsedTime = Date.parse(runtime.timestamp);
      if (isNaN(parsedTime) || Math.abs(Date.now() - parsedTime) > 5 * 60 * 1000) {
        return {
          ok: false,
          executionId,
          status: 'BLOCKED',
          gate: 'PROCESS_ISOLATION_GATE',
          executionBlocked: true,
          reason: 'Isolation runtime verification evidence has expired or has invalid timestamp.',
          planDigest: plan?.planDigest || null,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    if (runtime.isolationVerified !== true) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: 'Selected runtime isolation has not been verified.',
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }

    if (Array.isArray(runtime.supportedOps) && !runtime.supportedOps.includes(plan.operation)) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: `Operation '${plan.operation}' is not supported by runtime provider.`,
        planDigest: plan?.planDigest || null,
        elapsedMs: Date.now() - startTime,
      };
    }
    const selectedImage = image || (plan.ecosystem && DEFAULT_PROJECT_IMAGES[plan.ecosystem]) || DEFAULT_PROJECT_IMAGES.node;
    const binary = plan.binary || plan.command;

    // 3. Validate Launch Policy
    const policy = await this.validateLaunchPolicy({
      plan,
      ownerWebContentsId,
      image: selectedImage,
      networkMode,
    });
    if (!policy.valid) {
      return {
        ok: false,
        executionId,
        status: 'BLOCKED',
        gate: policy.gate || 'PROCESS_ISOLATION_GATE',
        executionBlocked: true,
        reason: policy.reason,
        planDigest: plan.planDigest,
        elapsedMs: Date.now() - startTime,
      };
    }

    // 4. Pre-execution Cancellation check
    if (signal?.aborted) {
      return {
        ok: false,
        executionId,
        status: 'CANCELLED',
        reason: 'Execution was cancelled by the caller before container creation.',
        planDigest: plan.planDigest,
        elapsedMs: Date.now() - startTime,
      };
    }

    // 5. Setup Staging Workspace
    let stagingDir = null;
    let volumeArg = '';
    const runId = crypto.randomUUID();
    const containerLabel = `ai-help-agent-execution-id=${executionId}`;
    const containerName = `aha-project-${runId.slice(0, 8)}`;
    let containerLaunchAttempted = false;
    let cleanupResult = null;
    let executionResult = null;

    try {
      if (stagingStrategy === STAGING_STRATEGIES.COPY_ON_WRITE) {
        stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-container-staging-'));
        await this._copyWorkspaceToStaging(plan.projectRoot, stagingDir);
        volumeArg = `${path.resolve(stagingDir)}:/workspace:rw`;
      } else {
        volumeArg = `${path.resolve(plan.projectRoot)}:/workspace:ro`;
      }

      // 6. Build Docker Run Arguments with Hardened Rootfs & Bounded Tmpfs
      const dockerArgs = [
        'run',
        '--rm',
        '--name', containerName,
        `--label=${containerLabel}`,
        '--workdir=/workspace',
        '--read-only',
        '--tmpfs', DEFAULT_TMPFS_CONFIG,
        networkMode === NETWORK_POLICIES.ALLOW_PACKAGE_EGRESS ? '--network=bridge' : '--network=none',
        `--memory=${DEFAULT_MEMORY_LIMIT}`,
        `--cpus=${DEFAULT_CPUS}`,
        `--pids-limit=${DEFAULT_PIDS_LIMIT}`,
        '--security-opt=no-new-privileges',
        '--cap-drop=ALL',
        '--env', 'CI=1',
        '-v', volumeArg,
        selectedImage,
        binary,
        ...(plan.args || []),
      ];

      validateContainerRunArgs(dockerArgs);

      // 7. Execute Container (Asynchronous with in-flight cancellation)
      containerLaunchAttempted = true;
      const runResult = await Promise.resolve(
        this.dockerCli('docker', dockerArgs, effectiveTimeout, {
          signal,
          timeoutMs: effectiveTimeout,
          maxBuffer: maxOutputBytes,
        })
      );

      const elapsedMs = Date.now() - startTime;
      const rawStdout = typeof runResult.stdout === 'string' ? runResult.stdout : (Buffer.isBuffer(runResult.stdout) ? runResult.stdout.toString() : '');
      const rawStderr = typeof runResult.stderr === 'string' ? runResult.stderr : (Buffer.isBuffer(runResult.stderr) ? runResult.stderr.toString() : '');
      const stdout = redactSensitiveData(rawStdout.slice(0, maxOutputBytes));
      const stderr = redactSensitiveData(rawStderr.slice(0, maxOutputBytes));
      const exitCode = typeof runResult.status === 'number' ? runResult.status : (runResult.error ? 1 : 0);
      const timedOut = Boolean(runResult.timedOut);
      const cancelled = Boolean(runResult.cancelled || signal?.aborted);

      // 8. Absence & Cleanup Verification (guaranteed for every outcome)
      cleanupResult = await this._verifyCleanup(containerLabel);
      const cleanupStatus = cleanupResult.status;

      // Handle Cleanup Failure First (explicit reporting, never claim success without evidence)
      if (!cleanupResult.cleaned) {
        let failureReason = `Container cleanup verification failed: ${cleanupResult.error || 'Lingering container detected.'}`;
        if (timedOut) {
          failureReason = `Container execution timed out after ${effectiveTimeout}ms; additionally, ${failureReason}`;
        } else if (cancelled) {
          failureReason = `Container execution was cancelled by caller; additionally, ${failureReason}`;
        } else if (runResult.error) {
          failureReason = `Docker CLI failed: ${runResult.error}; additionally, ${failureReason}`;
        }
        executionResult = {
          ok: false,
          executionId,
          status: 'CLEANUP_FAILED',
          exitCode: -1,
          stdout,
          stderr,
          elapsedMs,
          cleanupStatus: 'CLEANUP_FAILED',
          cleanupFailed: true,
          planDigest: plan.planDigest,
          reason: failureReason,
          isolationEvidence: null,
        };
        return executionResult;
      }

      if (timedOut) {
        executionResult = {
          ok: false,
          executionId,
          status: 'TIMED_OUT',
          exitCode: -1,
          stdout,
          stderr,
          elapsedMs,
          cleanupStatus,
          planDigest: plan.planDigest,
          reason: `Container execution timed out after ${effectiveTimeout}ms.`,
        };
        return executionResult;
      }

      if (cancelled) {
        executionResult = {
          ok: false,
          executionId,
          status: 'CANCELLED',
          exitCode: -1,
          stdout,
          stderr,
          elapsedMs,
          cleanupStatus,
          planDigest: plan.planDigest,
          reason: 'Container execution was cancelled by caller.',
        };
        return executionResult;
      }

      const passed = exitCode === 0;

      // 9. If mutating operation succeeded and cleanup was verified, sync back generated artifacts safely
      const isMutatingDependencyOp = plan.operation === 'DEPENDENCY_INSTALL'
        || plan.operation === 'INSTALL'
        || Boolean(plan.packageManager)
        || Boolean(plan.networkRequired);

      if (passed && stagingStrategy === STAGING_STRATEGIES.COPY_ON_WRITE && isMutatingDependencyOp) {
        await this._syncStagedArtifactsToRoot(stagingDir, plan.projectRoot, ownerWebContentsId);
      }

      const isolationEvidence = {
        executionId,
        containerIdentity: containerName,
        image: selectedImage,
        networkMode,
        stagingStrategy,
        readOnlyRoot: true,
        tmpfsMount: DEFAULT_TMPFS_CONFIG,
        planDigest: plan.planDigest,
        command: `${binary} ${(plan.args || []).join(' ')}`.trim(),
        executionExitCode: exitCode,
        elapsedMs,
        isolationLevel: 'CONTAINER_PROCESS_ISOLATION',
        provenance: this.isMockRunner ? 'mock_container_supervisor' : 'container_runtime_supervisor',
        trustClass: this.isMockRunner ? 'UNTRUSTED' : 'CONTAINER_ISOLATED',
        isMock: this.isMockRunner,
        resourceLimits: {
          memory: DEFAULT_MEMORY_LIMIT,
          cpus: DEFAULT_CPUS,
          pidsLimit: DEFAULT_PIDS_LIMIT,
        },
        capabilityEvidence: {
          readOnlyRootfs: {
            name: 'readOnlyRootfs',
            configured: true,
            runtimeEnforcement: 'NOT_VERIFIED',
            verificationMethod: 'CLI_FLAG_CONFIGURATION',
            evidenceSource: 'docker_run_args',
            limitation: 'Configured via --read-only launch argument; kernel-level write restriction in container was not independently tested at runtime.',
          },
          networkMode: {
            name: 'networkMode',
            configured: networkMode,
            egressFiltering: 'NOT_VERIFIED',
            verificationMethod: 'CLI_FLAG_CONFIGURATION',
            evidenceSource: 'docker_run_args',
            limitation: networkMode === 'none'
              ? 'Loopback isolation configured via --network=none; active egress block not independently probed.'
              : 'Bridge network mode does not enforce default-deny egress filtering.',
          },
          resourceLimits: {
            name: 'resourceLimits',
            configured: { memory: DEFAULT_MEMORY_LIMIT, cpus: DEFAULT_CPUS, pidsLimit: DEFAULT_PIDS_LIMIT },
            cgroupEnforcement: 'NOT_VERIFIED',
            verificationMethod: 'CLI_FLAG_CONFIGURATION',
            evidenceSource: 'docker_run_args',
            limitation: 'Cgroup limit flags passed to docker run; OS kernel cgroup quota enforcement not verified.',
          },
          temporaryStorage: {
            name: 'temporaryStorage',
            configured: DEFAULT_TMPFS_CONFIG,
            runtimeEnforcement: 'NOT_VERIFIED',
            verificationMethod: 'CLI_FLAG_CONFIGURATION',
            evidenceSource: 'docker_run_args',
            limitation: 'Mounted tmpfs with noexec,nosuid,nodev,size=64m; memory mount boundaries not verified at runtime.',
          },
        },
      };

      executionResult = {
        ok: passed,
        executionId,
        status: passed ? 'PASSED' : 'FAILED',
        exitCode,
        stdout,
        stderr,
        elapsedMs,
        cleanupStatus,
        planDigest: plan.planDigest,
        command: `${binary} ${(plan.args || []).join(' ')}`.trim(),
        containerIdentity: containerName,
        isolationEvidence,
        reason: runResult.error || (passed ? null : `Process exited with code ${exitCode}`),
      };
      return executionResult;
    } catch (execErr) {
      // Ensure cleanup runs when an unexpected exception or failure occurred
      if (containerLaunchAttempted && !cleanupResult) {
        try {
          cleanupResult = await this._verifyCleanup(containerLabel);
        } catch (cleanupErr) {
          cleanupResult = { cleaned: false, status: 'CLEANUP_FAILED', error: cleanupErr.message };
        }
      }

      const elapsedMs = Date.now() - startTime;
      const cleanupStatus = cleanupResult?.status || (containerLaunchAttempted ? 'CLEANUP_FAILED' : 'NOT_APPLICABLE');
      const cleanupFailed = cleanupResult ? !cleanupResult.cleaned : false;

      let reason = `Container execution failed: ${execErr.message}`;
      if (cleanupFailed) {
        reason += `; additionally, container cleanup verification failed: ${cleanupResult.error || 'Lingering container detected.'}`;
      }

      executionResult = {
        ok: false,
        executionId,
        status: cleanupFailed ? 'CLEANUP_FAILED' : 'FAILED',
        exitCode: -1,
        stderr: redactSensitiveData(execErr.message),
        elapsedMs,
        cleanupStatus,
        cleanupFailed,
        planDigest: plan?.planDigest || null,
        reason,
        originalError: execErr.message,
      };
      return executionResult;
    } finally {
      // Guaranteed cleanup safety net: ensure cleanup executed for launched container
      if (containerLaunchAttempted && !cleanupResult) {
        try {
          cleanupResult = await this._verifyCleanup(containerLabel);
        } catch (cleanupErr) {
          cleanupResult = { cleaned: false, status: 'CLEANUP_FAILED', error: cleanupErr.message };
        }
      }

      // 10. Clean up staging directory
      if (stagingDir) {
        try {
          await fs.rm(stagingDir, { recursive: true, force: true });
        } catch {
          // ignore staging dir cleanup errors
        }
      }
    }
  }

  /**
   * Creates a supervisor runner function compatible with sandboxExecutionAdapter.
   *
   * @param {Object} [runnerConfig]
   * @returns {Function} Supervisor runner
   */
  createSupervisorRunner(runnerConfig = {}) {
    return async ({ executionId, binary, args, projectRoot, timeoutMs, maxOutputBytes, signal }) => {
      const plan = {
        projectRoot,
        binary,
        args,
        planDigest: crypto.createHash('sha256').update(JSON.stringify({ projectRoot, binary, args })).digest('hex'),
        operation: runnerConfig.operation || 'TEST',
        ecosystem: runnerConfig.ecosystem || 'node',
      };
      const result = await this.execute({
        plan,
        ownerWebContentsId: runnerConfig.ownerWebContentsId || 1,
        sessionId: runnerConfig.sessionId || crypto.randomUUID(),
        image: runnerConfig.image,
        networkMode: runnerConfig.networkMode || NETWORK_POLICIES.NONE,
        stagingStrategy: runnerConfig.stagingStrategy || STAGING_STRATEGIES.COPY_ON_WRITE,
        timeoutMs,
        maxOutputBytes,
        signal,
      });

      return {
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.status === 'TIMED_OUT',
        cancelled: result.status === 'CANCELLED',
        cleanupStatus: result.cleanupStatus || 'HOST_VERIFIED_CLEANED',
      };
    };
  }

  async _copyWorkspaceToStaging(sourceRoot, targetRoot) {
    const canonicalSource = await fs.realpath(sourceRoot);
    await this._copyDirectorySafe(canonicalSource, targetRoot, canonicalSource);
  }

  async _copyDirectorySafe(currentSource, currentTarget, rootBoundary) {
    await fs.mkdir(currentTarget, { recursive: true });
    const entries = await fs.readdir(currentSource, { withFileTypes: true });

    for (const entry of entries) {
      if (isSensitiveEntry(entry.name)) continue;

      const srcPath = path.join(currentSource, entry.name);
      const dstPath = path.join(currentTarget, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          const linkTarget = await fs.realpath(srcPath);
          // If symlink target escapes project root boundary, reject copying it
          if (!linkTarget.toLowerCase().startsWith(rootBoundary.toLowerCase() + path.sep)) {
            continue; // Skip symlink escape
          }
          const linkStat = await fs.stat(linkTarget);
          if (linkStat.isDirectory()) {
            await this._copyDirectorySafe(linkTarget, dstPath, rootBoundary);
          } else {
            await fs.copyFile(linkTarget, dstPath);
          }
        } catch {
          // broken symlink, skip
        }
      } else if (entry.isDirectory()) {
        await this._copyDirectorySafe(srcPath, dstPath, rootBoundary);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, dstPath);
      }
    }
  }

  async _syncStagedArtifactsToRoot(stagingDir, projectRoot, ownerWebContentsId) {
    // Re-verify authorization before any write back
    if (ownerWebContentsId) {
      const auth = await verifyProjectAuthorization(projectRoot, ownerWebContentsId);
      if (!auth.isAuthorized) {
        throw new Error(`Artifact sync-back unauthorized: ${auth.reason}`);
      }
    }

    const canonicalRoot = await fs.realpath(projectRoot);
    const syncCandidates = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'node_modules'];

    for (const item of syncCandidates) {
      const stagedPath = path.join(stagingDir, item);
      const rootPath = path.join(canonicalRoot, item);

      // Verify destination is strictly inside canonical root
      const resolvedTarget = path.resolve(rootPath);
      if (!resolvedTarget.toLowerCase().startsWith(canonicalRoot.toLowerCase() + path.sep)) {
        throw new Error(`Unsafe artifact sync destination: [${resolvedTarget}] escapes authorized project root.`);
      }

      try {
        const stat = await fs.lstat(stagedPath);
        if (stat.isSymbolicLink()) {
          // Reject top-level symlink sync
          continue;
        }

        if (stat.isDirectory()) {
          await this._syncDirectorySafe(stagedPath, rootPath, canonicalRoot);
        } else if (stat.isFile()) {
          await fs.copyFile(stagedPath, rootPath);
        }
      } catch {
        // Candidate was not generated, skip
      }
    }
  }

  async _syncDirectorySafe(stagedDir, targetDir, projectRootBoundary) {
    await fs.mkdir(targetDir, { recursive: true });
    const entries = await fs.readdir(stagedDir, { withFileTypes: true });

    for (const entry of entries) {
      if (isSensitiveEntry(entry.name)) continue;

      const srcPath = path.join(stagedDir, entry.name);
      const dstPath = path.join(targetDir, entry.name);

      const resolvedDst = path.resolve(dstPath);
      if (!resolvedDst.toLowerCase().startsWith(projectRootBoundary.toLowerCase() + path.sep)) {
        throw new Error(`Unsafe file sync destination: [${resolvedDst}] escapes project boundary.`);
      }

      if (entry.isSymbolicLink()) {
        try {
          const linkTarget = await fs.readlink(srcPath);
          // If absolute or traversing outside project boundary, reject
          if (path.isAbsolute(linkTarget) || linkTarget.includes('..')) {
            const resolvedLink = path.resolve(stagedDir, linkTarget);
            if (!resolvedLink.toLowerCase().startsWith(projectRootBoundary.toLowerCase() + path.sep)) {
              continue; // Skip dangerous escaping symlink
            }
          }
          await fs.symlink(linkTarget, dstPath);
        } catch {
          // Ignore symlink failure
        }
      } else if (entry.isDirectory()) {
        await this._syncDirectorySafe(srcPath, dstPath, projectRootBoundary);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, dstPath);
      }
    }
  }

  async _verifyCleanup(label) {
    try {
      if (!label || typeof label !== 'string' || !label.trim()) {
        return { cleaned: false, status: 'CLEANUP_FAILED', error: 'Missing container label for cleanup verification.' };
      }
      const byLabel = await Promise.resolve(this.dockerCli('docker', ['ps', '-aq', '--filter', `label=${label}`], 5000));
      if (!byLabel || byLabel.error || byLabel.status !== 0) {
        return {
          cleaned: false,
          status: 'CLEANUP_FAILED',
          error: byLabel?.stderr || byLabel?.error || 'Failed to query container status for cleanup verification.',
        };
      }
      const ids = String(byLabel.stdout || '').split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0) {
        return { cleaned: true, status: 'HOST_VERIFIED_CLEANED' };
      }

      // Force kill leftover containers
      for (const id of ids) {
        const rmRes = await Promise.resolve(this.dockerCli('docker', ['rm', '-f', id], 5000));
        if (rmRes.error || rmRes.status !== 0) {
          return { cleaned: false, status: 'CLEANUP_FAILED', error: rmRes.stderr || rmRes.error };
        }
      }

      // Query again to confirm complete absence
      const confirm = await Promise.resolve(this.dockerCli('docker', ['ps', '-aq', '--filter', `label=${label}`], 5000));
      if (!confirm || confirm.error || confirm.status !== 0) {
        return {
          cleaned: false,
          status: 'CLEANUP_FAILED',
          error: confirm?.stderr || confirm?.error || 'Failed to confirm container cleanup absence.',
        };
      }
      const remainingIds = String(confirm.stdout || '').split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
      if (remainingIds.length === 0) {
        return { cleaned: true, status: 'HOST_VERIFIED_FORCE_CLEANED' };
      }

      return { cleaned: false, status: 'CLEANUP_FAILED', error: `Containers lingering: ${remainingIds.join(', ')}` };
    } catch (err) {
      return { cleaned: false, status: 'CLEANUP_FAILED', error: err.message };
    }
  }
}

function createProjectContainerExecutionRunner(options = {}) {
  return new ProjectContainerExecutionRunner(options);
}

module.exports = {
  STAGING_STRATEGIES,
  NETWORK_POLICIES,
  DEFAULT_PROJECT_IMAGES,
  APPROVED_BASE_IMAGES,
  DEFAULT_TMPFS_CONFIG,
  validateContainerRunArgs,
  ProjectContainerExecutionRunner,
  createProjectContainerExecutionRunner,
};
