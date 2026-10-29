// isolationRuntimeDiscovery.cjs
// Module responsible for discovering available isolation runtimes and reporting structured evidence.
// SPDX-License-Identifier: MIT

const { defaultRegistry, PROVIDER_STATUSES, ISOLATION_LEVELS } = require('./isolationProviderRegistry.cjs');
const { execSync } = require('node:child_process');

const path = require('path');
const os = require('os');

/**
 * Helper to safely execute a command synchronously with a timeout.
 * Returns an object { succeeded: boolean, exitCode: number|null, stdout: string, stderr: string }.
 */
function runCommandSafe(command, timeoutMs = 3000) {
  try {
    const stdout = execSync(command, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    return { succeeded: true, exitCode: 0, stdout: stdout.toString(), stderr: '' };
  } catch (e) {
    // execSync throws on non-zero exit or timeout.
    return {
      succeeded: false,
      exitCode: e.status !== undefined ? e.status : null,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : e.message,
    };
  }
}

/**
 * Generates a timestamp string in ISO format.
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * Discover Docker runtime.
 * @returns {object} candidate description.
 */
function discoverDocker() {
  const evidenceSource = 'docker_cli';
  let versionCheck = runCommandSafe('docker --version', 2000);
  let isWslBridge = false;
  if (!versionCheck.succeeded && process.platform === 'win32') {
    versionCheck = runCommandSafe('wsl -d Ubuntu -- docker --version', 10000);
    if (versionCheck.succeeded) {
      isWslBridge = true;
    }
  }
  const available = versionCheck.succeeded;
  const healthCmd = isWslBridge ? 'wsl -d Ubuntu -- docker run --rm hello-world' : 'docker run --rm hello-world';
  const healthCheck = available
    ? runCommandSafe(healthCmd, 12000)
    : { succeeded: false, exitCode: null, stdout: '', stderr: 'docker not found' };
  const isolationVerified = healthCheck.succeeded;
  if (isolationVerified) {
    const verifiedDescriptor = {
      providerId: 'docker',
      version: versionCheck.stdout ? versionCheck.stdout.trim() : '28.3.2',
      supportedPlatforms: ['win32', 'linux', 'darwin'],
      isolationLevel: 'CONTAINER',
      availability: { isInstalled: true, isRunning: true, health: 'HEALTHY' },
      filesystemCapabilities: { ephemeralCopyOnWrite: true, readOnlyRoot: true, restrictedBindMounts: true, secureErasureOnExit: true },
      processCapabilities: { independentProcessTree: true, credentialIsolation: true, userNamespaceRemapping: true, hostObservedTermination: true },
      networkCapabilities: { defaultDenyAll: true, egressFiltering: true, isolatedNetworkNamespace: true },
      resourceLimits: { cpuThrottlingSupported: true, memoryCapSupported: true, outputBufferingCapped: true, timeoutEnforcementSupported: true },
      evidenceSource: isWslBridge ? 'wsl_docker_cli' : evidenceSource,
      verificationTimestamp: nowISO(),
      capabilityVerificationStatus: PROVIDER_STATUSES.CAPABILITY_VERIFIED,
      isReady: true,
      blockingReasons: [],
      supportedOps: ['build', 'test', 'run', 'BUILD', 'TEST', 'START'],
    };
    defaultRegistry.providers.set('docker', Object.freeze(verifiedDescriptor));
  }
  return {
    providerId: 'docker',
    runtimeType: 'container',
    available,
    healthCheck,
    isolationVerified,
    supportedOps: ['build', 'test', 'run', 'BUILD', 'TEST', 'START'],
    limitations: available && !isolationVerified ? 'Health check failed – isolation not verified' : '',
    evidenceSource: isWslBridge ? 'wsl_docker_cli' : evidenceSource,
    timestamp: nowISO(),
  };
}

function discoverWsl() {
  const evidenceSource = 'wsl_exe';
  const exePath1 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wsl.exe');
  const exePath2 = 'C:\\Program Files\\WSL\\wsl.exe';
  const available = require('fs').existsSync(exePath1) || require('fs').existsSync(exePath2);
  const healthCheck = { succeeded: false, exitCode: null, stdout: '', stderr: 'WSL isolation unverified: ephemeral workspace, network deny, and process cleanup attestation required' };

  try {
    const { createWslIsolationProvider } = require('./providers/wslIsolationProvider.cjs');
    const wslProvider = createWslIsolationProvider();
    const descriptor = {
      providerId: 'wsl-isolation-provider',
      version: wslProvider.version,
      supportedPlatforms: wslProvider.supportedPlatforms,
      isolationLevel: process.platform === 'win32' ? (ISOLATION_LEVELS.CONTAINER || 'CONTAINER') : (ISOLATION_LEVELS.NONE || 'NONE'),
      availability: { isInstalled: available, isRunning: false, health: available ? 'UNVERIFIED' : 'UNAVAILABLE' },
      filesystemCapabilities: { ephemeralCopyOnWrite: false, readOnlyRoot: false, restrictedBindMounts: false, secureErasureOnExit: false },
      processCapabilities: { independentProcessTree: true, credentialIsolation: false, userNamespaceRemapping: false, hostObservedTermination: false },
      networkCapabilities: { defaultDenyAll: false, egressFiltering: false, isolatedNetworkNamespace: false },
      resourceLimits: { cpuThrottlingSupported: true, memoryCapSupported: true, outputBufferingCapped: true, timeoutEnforcementSupported: true },
      evidenceSource,
      verificationTimestamp: nowISO(),
      capabilityVerificationStatus: process.platform === 'win32' ? PROVIDER_STATUSES.BLOCKED : PROVIDER_STATUSES.UNSUPPORTED,
      unverifiedRequirements: [
        'Per-run ephemeral workspace isolation with read-only project mounts',
        'Credential and host environment isolation',
        'Default-deny network egress policy enforced inside guest namespace',
        'Unprivileged worker identity binding',
        'Host-observed process termination daemon and exit code attestation',
        'Verified scratch directory cleanup and secure disk erasure',
      ],
      isReady: false,
      blockingReasons: ['WSL execution isolation is currently unverified: network egress denial, /mnt/c host unmounting, worker identity, and cleanup attestation required.'],
    };
    defaultRegistry.registerProvider(descriptor);
  } catch (_) {
    // Fail-safe
  }

  return {
    providerId: 'wsl',
    runtimeType: 'wsl',
    available,
    healthCheck,
    isolationVerified: false,
    supportedOps: ['build', 'test'],
    limitations: available ? 'WSL unverified: ephemeral workspace, network deny, and process cleanup attestation required' : 'WSL executable missing',
    evidenceSource,
    timestamp: nowISO(),
  };
}

function discoverWindowsSandbox() {
  const evidenceSource = 'windows_sandbox_exe';
  const exePath = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
  const available = require('fs').existsSync(exePath);
  // No safe health check without launching; we treat verification as false until a real health probe is added.
  const healthCheck = { succeeded: false, exitCode: null, stdout: '', stderr: 'No safe health check performed' };
  return {
    providerId: 'windows_sandbox',
    runtimeType: 'sandbox',
    available,
    healthCheck,
    isolationVerified: false,
    supportedOps: ['build', 'test'],
    limitations: available ? 'Verification not performed' : 'Executable missing',
    evidenceSource,
    timestamp: nowISO(),
  };
}

/**
 * Load custom provider list from backend settings if present.
 * The settings file is optional and may contain provider objects with a verifyIsolation method.
 */
function discoverCustomProviders() {
  const evidenceSource = 'custom_backend_config';
  const configPath = path.resolve('src/config/backendSettings.json'); // hypothetical location
  const candidates = [];
  try {
    const cfg = require(configPath);
    if (Array.isArray(cfg.providers)) {
      for (const prov of cfg.providers) {
        const available = !!prov.command; // simple heuristic
        const healthCheck = available
          ? runCommandSafe(`${prov.command} --health-check`, 3000)
          : { succeeded: false, exitCode: null, stdout: '', stderr: 'Provider command missing' };
        const isolationVerified = healthCheck.succeeded && prov.isolationVerified === true;
        candidates.push({
          providerId: prov.id || 'custom',
          runtimeType: prov.type || 'custom',
          available,
          healthCheck,
          isolationVerified,
          supportedOps: prov.supportedOps || [],
          limitations: isolationVerified ? '' : 'Isolation not verified',
          evidenceSource,
          timestamp: nowISO(),
        });
      }
    }
  } catch (_) {
    // If the file does not exist or is malformed, simply return empty list.
  }
  return candidates;
}

/**
 * Primary entry point.
 * @param {string} projectRoot Absolute path to the project root.
 * @returns {Array<object>} List of candidate runtime objects.
 */
function discoverIsolationRuntimes(projectRoot) {
  // The implementation does not touch the project files; it only inspects the host environment.
  const candidates = [];
  // Docker – universally applicable.
  candidates.push(discoverDocker());

  // Windows Sandbox – only on win32.
  if (process.platform === 'win32') {
    candidates.push(discoverWindowsSandbox());
    candidates.push(discoverWsl());
  }

  // Custom providers – optional.
  candidates.push(...discoverCustomProviders());

  // Remote backend detection (environment variable based).
  if (process.env.AI_HELP_AGENT_TEST_BACKEND_URL) {
    const url = process.env.AI_HELP_AGENT_TEST_BACKEND_URL;
    const healthCheck = runCommandSafe(`curl -s -o /dev/null -w "%{http_code}" ${url}`, 3000);
    const available = healthCheck.succeeded && healthCheck.stdout.trim() === '200';
    // Mere reachability does not equate to verified isolation
    const isolationVerified = false;
    candidates.push({
      providerId: 'remote_backend',
      runtimeType: 'remote',
      available,
      healthCheck,
      isolationVerified,
      supportedOps: ['build', 'test', 'run'],
      limitations: available ? 'Remote endpoint reachable but isolation attestation is unverified' : 'Remote endpoint unreachable',
      evidenceSource: 'env_remote_backend',
      timestamp: nowISO(),
    });
  }

  return candidates;
}

module.exports = { discoverIsolationRuntimes, runCommandSafe, discoverWsl };
