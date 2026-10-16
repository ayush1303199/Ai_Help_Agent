import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dockerAdapter from '../electron/coding-pipeline/dockerProviderAdapter.cjs';
import projectIsolation from '../electron/coding-pipeline/projectProcessIsolation.cjs';
import windowsSandboxProvider from '../electron/coding-pipeline/windowsSandboxProviderAdapter.cjs';

const {
  createLocalDockerProviderAdapter,
  inspectDockerHost,
} = dockerAdapter;
const {
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
} = projectIsolation;

function queryWindowsSandboxFeature() {
  if (process.platform !== 'win32') {
    return { state: 'NOT_ESTABLISHED', exitCode: null, timedOut: false, error: 'Windows capability query requires a Windows host.' };
  }
  const command = "try { (Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -ErrorAction Stop).State } catch { Write-Output ('QUERY_UNAVAILABLE: ' + $_.Exception.Message); exit 2 }";
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 32 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = String(result.stdout || '').trim();
  return {
    state: result.status === 0 ? state : 'NOT_ESTABLISHED',
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error?.message || String(result.stderr || '').trim() || null,
    output: String(result.stdout || '').trim(),
  };
}

function capabilityState(feature) {
  if (feature.state === 'Enabled') return { configured: true, runtimeAvailable: 'NOT_ESTABLISHED' };
  if (feature.state === 'Disabled') return { configured: false, runtimeAvailable: false };
  return { configured: 'NOT_ESTABLISHED', runtimeAvailable: 'NOT_ESTABLISHED' };
}

async function main() {
  const dockerHost = inspectDockerHost({
    dockerExecutable: 'docker',
    commandTimeoutMs: 5_000,
  });
  const dockerAdapterInstance = createLocalDockerProviderAdapter({
    enabled: true,
    dockerExecutable: 'docker',
    hostInspection: dockerHost,
  });
  const dockerCapabilities = dockerAdapterInstance.getCapabilities();

  const sandboxExecutable = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsSandbox.exe',
  );
  const sandboxExecutablePresent = fs.existsSync(sandboxExecutable);
  const sandboxFeature = queryWindowsSandboxFeature();
  const sandboxFeatureState = capabilityState(sandboxFeature);
  const windowsSandboxAdapter = windowsSandboxProvider.createWindowsSandboxProviderAdapter();
  const sandboxCapabilities = windowsSandboxAdapter.getCapabilities();
  const windowsIsolation = projectProcessIsolationStatus('win32');

  assert.equal(dockerCapabilities.runtimeAvailable, dockerHost.daemonAvailable);
  assert.equal(dockerCapabilities.independentlyVerified, false, 'A daemon response alone must not establish isolation.');
  assert.equal(windowsIsolation.available, false, 'Windows project execution remains disabled.');
  assert.equal(windowsIsolation.verified, false, 'Windows isolation remains unverified.');
  assert.throws(
    () => requireProjectProcessIsolation('Runtime isolation probe'),
    /was not started/i,
    'The shared execution gate must reject project execution on this host.',
  );

  let syntheticProbe;
  let approvedImage = String(process.env.AI_HELP_AGENT_PROBE_IMAGE || '').trim();
  if (!dockerHost.daemonAvailable) {
    approvedImage = '';
    syntheticProbe = await dockerAdapterInstance.runSyntheticProbe({ image: approvedImage });
    assert.equal(syntheticProbe.classification, 'BLOCKED');
    assert.match(syntheticProbe.reason, /Docker CLI or daemon is unavailable/);
  } else if (!approvedImage) {
    syntheticProbe = {
      classification: 'BLOCKED',
      reason: 'BLOCKED — NO APPROVED LOCAL PROBE IMAGE. Set AI_HELP_AGENT_PROBE_IMAGE to an already-present, explicitly approved local image; no pull is performed.',
    };
  } else {
    syntheticProbe = await dockerAdapterInstance.runSyntheticProbe({
      image: approvedImage,
      executionTimeoutMs: 15_000,
      commandTimeoutMs: 5_000,
      maxTimeoutMs: 60_000,
    });
  }

  const crossPlatform = {
    macOS: {
      classification: 'NOT_ESTABLISHED',
      isolation: projectProcessIsolationStatus('darwin'),
    },
    Linux: {
      classification: 'NOT_ESTABLISHED',
      isolation: projectProcessIsolationStatus('linux'),
    },
  };
  const result = {
    host: { platform: process.platform, architecture: process.arch },
    docker: {
      documented: dockerHost.documented,
      configured: dockerHost.configured,
      adapterEnabled: dockerCapabilities.configured,
      runtimeAvailable: dockerHost.runtimeAvailable,
      independentlyVerified: dockerHost.independentlyVerified,
      hasDockerCli: dockerHost.hasDockerCli,
      daemonVersion: dockerHost.serverVersion,
      operatingSystem: dockerHost.operatingSystem,
      architecture: dockerHost.architecture,
      rootless: dockerHost.rootless,
      securityOptions: dockerHost.securityOptions,
      versionCommand: dockerHost.versionCommand,
      infoCommand: dockerHost.infoCommand,
    },
    windowsSandbox: {
      documented: true,
      binaryPresent: sandboxExecutablePresent,
      binaryPresence: sandboxExecutablePresent,
      executablePath: sandboxExecutable,
      configured: sandboxFeatureState.configured,
      featureConfigurationState: sandboxFeatureState.configured,
      featureQueryState: sandboxFeature.state,
      runtimeAvailable: sandboxFeatureState.runtimeAvailable,
      nonElevatedRuntimeAvailability: sandboxFeatureState.runtimeAvailable,
      independentlyVerified: sandboxCapabilities.independentlyVerified,
      independentlyVerifiedRuntimeExecution: sandboxCapabilities.independentlyVerified,
      hostObservedTeardownEvidence: 'NOT_ESTABLISHED',
      providerEnabled: false,
      disabledReason: windowsSandboxAdapter.disabledReason,
      featureQuery: sandboxFeature,
      projectIsolationGate: windowsIsolation,
      guestLaunched: false,
    },
    syntheticProbe,
    macOSLinux: crossPlatform,
    milestones: {
      runtimeIsolationAndHostEvidence: syntheticProbe.classification === 'PASS' ? 'PASS' : syntheticProbe.classification,
      untrustedGuestOutputSeparation: syntheticProbe.untrustedWorkerClaims ? 'PASS' : 'BLOCKED',
      terminationDeletionCleanupAndSecureErasure: syntheticProbe.lifecycle
        ? {
            classification: syntheticProbe.lifecycle.cleanupVerified ? 'PASS' : 'BLOCKED',
            ...syntheticProbe.lifecycle,
          }
        : 'BLOCKED',
      crossPlatformVerificationBoundary: 'NOT_ESTABLISHED',
    },
    hostFallback: {
      attempted: false,
      projectExecutionInvoked: false,
      gateRejectedProjectExecution: true,
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('Runtime isolation probe failed:', error);
  process.exitCode = 1;
});
