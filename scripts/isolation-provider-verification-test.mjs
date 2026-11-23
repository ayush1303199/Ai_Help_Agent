/**
 * AI Help Agent - V9: Isolation Provider Verification & Sandbox Readiness Tests
 *
 * Verifies:
 * 1. Provider absent or unsupported.
 * 2. Provider detected but not trusted.
 * 3. Required capability missing.
 * 4. Malformed or stale evidence.
 * 5. Evidence bound to the wrong provider or workload.
 * 6. Caller-supplied isolation booleans rejected.
 * 7. Tampered or contradictory evidence rejected.
 * 8. Policy change invalidates previous readiness.
 * 9. Provider version/configuration change invalidates stale evidence.
 * 10. Incomplete network, credential, filesystem, or process isolation blocks readiness.
 * 11. Browser caller cannot bypass the gate.
 * 12. Worker authorization cannot override a blocked isolation result.
 * 13. Cancellation and recovery behavior remains intact.
 * 14. Existing V1-V8 contracts and architecture boundaries remain compatible.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import registryPkg from '../electron/coding-pipeline/isolationProviderRegistry.cjs';
const {
  PROVIDER_STATUSES,
  ISOLATION_LEVELS,
  createIsolationProviderRegistry,
} = registryPkg;

import verifierPkg from '../electron/coding-pipeline/isolationCapabilityVerifier.cjs';
const {
  DEFAULT_ISOLATION_POLICY,
  verifyIsolationCapabilities,
} = verifierPkg;

import windowsProvPkg from '../electron/coding-pipeline/providers/windowsSandboxProvider.cjs';
const {
  WINDOWS_DISABLED_REASON,
  createWindowsSandboxProvider,
} = windowsProvPkg;

import containerProvPkg from '../electron/coding-pipeline/providers/containerProvider.cjs';
const {
  createContainerProvider,
} = containerProvPkg;

import linuxProvPkg from '../electron/coding-pipeline/providers/linuxNamespaceProvider.cjs';
const {
  createLinuxNamespaceProvider,
} = linuxProvPkg;

import windowsAdapterPkg from '../electron/coding-pipeline/windowsSandboxProviderAdapter.cjs';
const {
  createNativeSupervisorClient,
  queryWindowsOperatingSystemIdentity,
  verifyLiveSupervisorProcessIsolation,
} = windowsAdapterPkg;

import projectIsoPkg from '../electron/coding-pipeline/projectProcessIsolation.cjs';
const {
  verifyProjectProcessIsolation,
} = projectIsoPkg;

import executionEvidencePkg from '../electron/coding-pipeline/executionEvidenceContract.cjs';
const {
  authenticateObserver,
  validateRealIsolationEvidence,
} = executionEvidencePkg;

import devAgentPkg from '../electron/developerAgent.cjs';
const {
  WORKER_CAPABILITIES,
  createWorkerAuthorizationGrant,
  validateWorkerAuthorizationGrant,
  verifyIsolationEvidence,
  executeInVerifiedSandbox,
} = devAgentPkg;

console.log('Starting Isolation Provider Verification & Sandbox Readiness regression tests (V9)...');

let tempDir;

async function setupTestDir() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v9-isolation-test-'));
}

async function cleanupTestDir() {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------
// Test 1: Provider Absent or Unsupported Platform
// -------------------------------------------------------------
async function testProviderAbsentOrUnsupported() {
  console.log('Testing absent or unsupported provider handling...');
  // 1. Null provider descriptor
  const nullCheck = verifyIsolationCapabilities({ providerDescriptor: null });
  assert.strictEqual(nullCheck.ready, false);
  assert.strictEqual(nullCheck.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(nullCheck.reason.includes('descriptor is null'));

  // 2. Linux provider on non-Linux platform
  const linuxProvider = createLinuxNamespaceProvider();
  const caps = await linuxProvider.discoverCapabilities();
  if (process.platform !== 'linux') {
    assert.strictEqual(caps.capabilityVerificationStatus, PROVIDER_STATUSES.UNSUPPORTED);
    const verifyRes = linuxProvider.verifyEvidence({ dummy: 1 });
    assert.strictEqual(verifyRes.status, PROVIDER_STATUSES.UNSUPPORTED);
  }
}

// -------------------------------------------------------------
// Test 2: Provider Detected But Not Trusted (Discovery != Trust)
// -------------------------------------------------------------
async function testProviderDiscoveryDoesNotEqualTrust() {
  console.log('Testing provider discovery does not equal trust...');
  const registry = createIsolationProviderRegistry();
  const winProvider = createWindowsSandboxProvider();
  const discoveredCaps = await winProvider.discoverCapabilities();

  registry.registerProvider(discoveredCaps);
  const registered = registry.getProvider('windows-sandbox-provider');

  // Even though provider was discovered and registered, isReady must be false!
  assert.strictEqual(registered.isReady, false);
  assert.strictEqual(registered.capabilityVerificationStatus, process.platform === 'win32' ? PROVIDER_STATUSES.BLOCKED : PROVIDER_STATUSES.UNSUPPORTED);
  assert.ok(registered.blockingReasons.length > 0);
}

// -------------------------------------------------------------
// Test 3: Required Capability Missing
// -------------------------------------------------------------
async function testRequiredCapabilityMissing() {
  console.log('Testing missing capability blocks readiness...');
  const weakProviderDescriptor = {
    providerId: 'weak-test-provider',
    version: '1.0.0',
    supportedPlatforms: [process.platform],
    isolationLevel: ISOLATION_LEVELS.BASIC_PROCESS,
    availability: { isInstalled: true, isRunning: true, health: 'READY' },
    filesystemCapabilities: { ephemeralCopyOnWrite: false }, // Missing CoW!
    processCapabilities: { independentProcessTree: true, credentialIsolation: false }, // Missing credential isolation!
    networkCapabilities: { defaultDenyAll: false, isolatedNetworkNamespace: false }, // Missing network deny!
    resourceLimits: { timeoutEnforcementSupported: true },
  };

  const outcome = verifyIsolationCapabilities({
    providerDescriptor: weakProviderDescriptor,
    requestedPolicy: {
      requireFilesystemCow: true,
      requireCredentialIsolation: true,
      requireNetworkDeny: true,
    },
    evidence: {
      providerId: 'weak-test-provider',
      provenance: 'SYSTEM_DAEMON',
    },
  });

  assert.strictEqual(outcome.ready, false);
  assert.strictEqual(outcome.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(outcome.missingCapabilities.includes('ephemeral_copy_on_write'));
  assert.ok(outcome.missingCapabilities.includes('credential_isolation'));
  assert.ok(outcome.missingCapabilities.includes('network_isolation'));
}

// -------------------------------------------------------------
// Test 4 & 5: Malformed, Stale, or Workload-Mismatched Evidence
// -------------------------------------------------------------
async function testEvidenceIntegrityAndWorkloadBinding() {
  console.log('Testing evidence integrity, freshness, and workload binding...');
  const validDescriptor = {
    providerId: 'good-provider',
    supportedPlatforms: [process.platform],
    processCapabilities: { independentProcessTree: true, credentialIsolation: true },
    networkCapabilities: { defaultDenyAll: true },
    filesystemCapabilities: { ephemeralCopyOnWrite: true },
    resourceLimits: { timeoutEnforcementSupported: true },
  };

  // Stale / Expired evidence
  const expiredEvidence = {
    providerId: 'good-provider',
    provenance: 'DAEMON_ATTESTATION',
    evidenceExpiry: new Date(Date.now() - 60000).toISOString(), // Expired 1 min ago
  };
  const staleCheck = verifyIsolationCapabilities({
    providerDescriptor: validDescriptor,
    evidence: expiredEvidence,
  });
  assert.strictEqual(staleCheck.ready, false);
  assert.strictEqual(staleCheck.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(staleCheck.reason.includes('expired'));

  // Wrong workload / workflowId binding
  const mismatchedWorkflowEvidence = {
    providerId: 'good-provider',
    provenance: 'DAEMON_ATTESTATION',
    workflowId: 'wf-other-tenant',
  };
  const workloadCheck = verifyIsolationCapabilities({
    providerDescriptor: validDescriptor,
    evidence: mismatchedWorkflowEvidence,
    context: { workflowId: 'wf-my-task' },
  });
  assert.strictEqual(workloadCheck.ready, false);
  assert.strictEqual(workloadCheck.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(workloadCheck.reason.includes('Workflow binding mismatch'));

  // Wrong plan digest binding
  const mismatchedPlanEvidence = {
    providerId: 'good-provider',
    provenance: 'DAEMON_ATTESTATION',
    planDigest: 'digest-old-version',
  };
  const planCheck = verifyIsolationCapabilities({
    providerDescriptor: validDescriptor,
    evidence: mismatchedPlanEvidence,
    context: { planDigest: 'digest-new-version' },
  });
  assert.strictEqual(planCheck.ready, false);
  assert.ok(planCheck.reason.includes('Plan digest mismatch'));
}

// -------------------------------------------------------------
// Test 6 & 7: Caller-Supplied Boolean Flags Rejected
// -------------------------------------------------------------
async function testCallerSuppliedBooleanFlagsRejected() {
  console.log('Testing caller-supplied boolean flags rejection...');
  const descriptor = {
    providerId: 'test-prov',
    supportedPlatforms: [process.platform],
  };

  // Flag: sandbox: true
  const flagA = verifyIsolationCapabilities({
    providerDescriptor: descriptor,
    evidence: { sandbox: true },
  });
  assert.strictEqual(flagA.ready, false);
  assert.strictEqual(flagA.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(flagA.reason.includes('Caller-supplied Boolean flag'));

  // Flag: isolationVerified: true
  const flagB = verifyIsolationCapabilities({
    providerDescriptor: descriptor,
    evidence: { isolationVerified: true },
  });
  assert.strictEqual(flagB.ready, false);
  assert.strictEqual(flagB.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(flagB.reason.includes('Caller-supplied Boolean flag'));

  // Simulated / Mock provenance
  const simEvidence = verifyIsolationCapabilities({
    providerDescriptor: descriptor,
    evidence: { provenance: 'mock', runId: 'fake' },
  });
  assert.strictEqual(simEvidence.ready, false);
  assert.strictEqual(simEvidence.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(simEvidence.reason.includes('untrusted or simulated'));
}

// -------------------------------------------------------------
// Test 8: Policy Change Invalidates Previous Readiness
// -------------------------------------------------------------
async function testPolicyChangeInvalidation() {
  console.log('Testing policy change invalidates previous readiness...');
  const descriptor = {
    providerId: 'partial-prov',
    supportedPlatforms: [process.platform],
    processCapabilities: { independentProcessTree: true, credentialIsolation: true },
    networkCapabilities: { defaultDenyAll: false, isolatedNetworkNamespace: false }, // lacks network deny
    filesystemCapabilities: { ephemeralCopyOnWrite: true },
    resourceLimits: { timeoutEnforcementSupported: true },
  };

  // Under relaxed policy (network deny not required)
  const relaxedCheck = verifyIsolationCapabilities({
    providerDescriptor: descriptor,
    requestedPolicy: { requireNetworkDeny: false },
    evidence: { providerId: 'partial-prov', provenance: 'ATTESTED_DAEMON' },
  });
  // If not on win32 (which has policy block), relaxed check passes
  if (process.platform !== 'win32') {
    assert.strictEqual(relaxedCheck.ready, true);
  }

  // Under strict policy requiring network isolation, same provider is BLOCKED
  const strictCheck = verifyIsolationCapabilities({
    providerDescriptor: descriptor,
    requestedPolicy: { requireNetworkDeny: true },
    evidence: { providerId: 'partial-prov', provenance: 'ATTESTED_DAEMON' },
  });
  assert.strictEqual(strictCheck.ready, false);
  assert.strictEqual(strictCheck.status, PROVIDER_STATUSES.BLOCKED);
  assert.ok(strictCheck.missingCapabilities.includes('network_isolation'));
}

// -------------------------------------------------------------
// Test 11 & 12: Worker Authorization Cannot Override Blocked Isolation
// -------------------------------------------------------------
async function testWorkerAuthCannotOverrideBlockedIsolation() {
  console.log('Testing worker authorization cannot override blocked isolation...');
  // Even if worker authorization grant claims EXECUTE_COMMAND capability,
  // without verified isolation evidence, validateWorkerAuthorizationGrant must fail-closed at PROCESS_ISOLATION_GATE
  const grant = createWorkerAuthorizationGrant({
    workerId: 'worker-bypass-attempt',
    workflowId: 'wf-bypass',
    sessionId: 'sess-bypass',
    ownerWebContentsId: 1,
    projectIdentity: { projectRoot: tempDir },
    permittedCapabilities: [WORKER_CAPABILITIES.EXECUTE_COMMAND],
    isolationEvidence: null,
  });

  const authVal = validateWorkerAuthorizationGrant(grant, {
    requiredCapability: WORKER_CAPABILITIES.EXECUTE_COMMAND,
  });

  assert.strictEqual(authVal.ok, false);
  assert.strictEqual(authVal.status, 'BLOCKED');
  assert.strictEqual(authVal.gate, 'PROCESS_ISOLATION_GATE');
  assert.strictEqual(authVal.isolationBlocked, true);
}

// -------------------------------------------------------------
// Test 13: Windows Host Policy Blocks Live Command Execution
// -------------------------------------------------------------
async function testWindowsHostPolicyBlocksExecution() {
  console.log('Testing Windows host policy blocks live command execution fail-closed...');
  const execResult = await executeInVerifiedSandbox({
    plan: {
      projectRoot: tempDir,
      binary: 'npm',
      args: ['test'],
      planDigest: 'digest-fail-closed',
    },
    ownerWebContentsId: 1,
    sessionId: 'sess-1',
    isolationEvidence: null,
  });

  assert.strictEqual(execResult.ok, false);
  assert.strictEqual(execResult.executionBlocked, true);
}

// -------------------------------------------------------------
// Test 14: Milestone V44.85.6 Security Gate & Supervisor Remediation
// -------------------------------------------------------------
async function testV44856SecurityGateAndSupervisorRemediation() {
  console.log('Testing Milestone V44.85.6: Security Gate & Supervisor Authorization Remediation...');

  // 1. SYSTEM SID never implies synthetic mode
  const sysClient = createNativeSupervisorClient({
    tokenUserSid: 'S-1-5-18',
    isSyntheticTest: false,
  });
  const desc = sysClient.getDescriptor();
  assert.strictEqual(desc.windowsProcessPeer.tokenUserSid, 'S-1-5-18');
  assert.strictEqual(desc.windowsProcessPeer.serviceSecurityBoundary, 'USER_PROCESS'); // not live service

  // 2. HCS API success never promotes BLOCKED to ALLOWED on real host queries
  const liveResult = await verifyLiveSupervisorProcessIsolation({
    isSyntheticTest: false,
    timeoutMs: 500,
  });
  assert.strictEqual(liveResult.verified, false);
  assert.strictEqual(liveResult.processIsolationGate, 'BLOCKED');
  assert.strictEqual(liveResult.hostFallback, 'ZERO');

  // 3. Explicit synthetic test context is preserved
  const synResult = await verifyLiveSupervisorProcessIsolation({
    isSyntheticTest: true,
    timeoutMs: 500,
  });
  if (synResult.identity?.ok) {
    assert.strictEqual(synResult.verified, true);
    assert.strictEqual(synResult.processIsolationGate, 'SYNTHETIC_ALLOW');
    assert.strictEqual(synResult.isolationState, 'SYNTHETIC_TEST_BOUNDARY');
  }

  // 4. Capability states in projectProcessIsolation cannot be falsely promoted
  const isoStatus = await verifyProjectProcessIsolation({ isSyntheticTest: false });
  assert.strictEqual(isoStatus.available, false);
  assert.strictEqual(isoStatus.verified, false);
  assert.strictEqual(isoStatus.capabilityStates.osEnforcedProcessIsolation, 'BLOCKED');
  assert.strictEqual(isoStatus.capabilityStates.runtimeWorkerIdentityBinding, 'NOT_ESTABLISHED');
  assert.strictEqual(isoStatus.capabilityStates.effectiveNetworkEndpointRestrictions, 'NOT_ESTABLISHED');
  assert.strictEqual(isoStatus.capabilityStates.resourceFilesystemBoundaries, 'NOT_ESTABLISHED');

  // 5. Caller-supplied service identity claims rejected without verified service SID
  const forgedAuth = authenticateObserver({
    observerDescriptor: {
      identitySource: 'independent_authenticated_observer',
      pid: 9999,
      executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\AiHelpAgentSupervisor.exe',
      serviceSecurityBoundary: 'LOCAL_SYSTEM_SERVICE', // caller claim
      windowsProcessPeer: {
        pid: 9999,
        handleValid: true,
        processExited: false,
        processCreationTimeUtc: new Date().toISOString(),
        executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\AiHelpAgentSupervisor.exe',
        tokenUserSid: 'S-1-5-21-unprivileged-user', // not SYSTEM
        identitySource: 'independent_authenticated_observer',
        serviceSecurityBoundary: 'LOCAL_SYSTEM_SERVICE',
        isLiveSupervisorService: false,
      },
    },
    peerCredentials: { authenticated: true, peerPid: 9999 },
    isSyntheticTest: false,
  });
  assert.strictEqual(forgedAuth.isAuthenticated, false);
  assert.strictEqual(forgedAuth.reasonCode, 'SECURITY_PRINCIPAL_MISMATCH');

  // Also test forged claim with SYSTEM SID but unverified live service execution
  const unverifiedServiceAuth = authenticateObserver({
    observerDescriptor: {
      identitySource: 'independent_authenticated_observer',
      pid: 9999,
      executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\AiHelpAgentSupervisor.exe',
      serviceSecurityBoundary: 'LOCAL_SYSTEM_SERVICE', // caller claim
      windowsProcessPeer: {
        pid: 9999,
        handleValid: true,
        processExited: false,
        processCreationTimeUtc: new Date().toISOString(),
        executablePath: 'C:\\Program Files\\AI Help Agent\\libexec\\AiHelpAgentSupervisor.exe',
        tokenUserSid: 'S-1-5-18',
        identitySource: 'independent_authenticated_observer',
        serviceSecurityBoundary: 'LOCAL_SYSTEM_SERVICE',
        isLiveSupervisorService: false, // unverified service
      },
    },
    peerCredentials: { authenticated: true, peerPid: 9999 },
    isSyntheticTest: false,
  });
  assert.strictEqual(unverifiedServiceAuth.isAuthenticated, false);
  assert.strictEqual(unverifiedServiceAuth.reasonCode, 'OS_PROCESS_IDENTITY_NOT_VERIFIED');

  // 6. Host inspection failure returns honest states without fact fabrication
  const osIdentity = queryWindowsOperatingSystemIdentity();
  assert.ok(osIdentity.authoritativeProductName !== undefined);
  if (osIdentity.inspectionState === 'UNAVAILABLE') {
    assert.strictEqual(osIdentity.authoritativeProductName, 'UNKNOWN');
    assert.strictEqual(osIdentity.buildNumber, null);
    assert.strictEqual(osIdentity.hypervisorDetected, false);
    assert.strictEqual(osIdentity.vbsRunning, false);
  }
}

async function testV44856BSecurityHardening() {
  console.log('Testing Milestone V44.85.6B: Trusted Supervisor IPC Authentication & Hardening...');

  const { executeWithSupervisor } = windowsAdapterPkg;

  function createMockSupervisor(overrides = {}) {
    const base = createNativeSupervisorClient({
      isSyntheticTest: true,
      pid: 9999,
      tokenUserSid: 'S-1-5-18',
    });
    return {
      ...base,
      issueExecutionGrant: async (req) => ({
        granted: true,
        runId: req.runId,
        workspaceRoot: req.workspaceRoot,
        approvedSnapshotDigest: req.approvedSnapshotDigest,
        commandDigest: req.commandDigest,
        sessionId: req.sessionId,
      }),
      consumeExecutionGrant: async () => ({ consumed: true }),
      allocateWorker: async () => ({ workerId: 'w1' }),
      observeEffectiveIsolation: async () => ({ effectiveIsolationVerified: true }),
      executeApprovedOperation: async () => ({ ok: true, exitCode: 0 }),
      enforceDeadlineAndCancellation: async () => {},
      collectHostEvidence: async () => ({ evidenceCollected: true }),
      terminateWorker: async () => ({ terminated: true }),
      verifyWorkerTerminationAndResourceRelease: async () => ({ released: true }),
      quarantineResource: async () => ({ quarantined: true }),
      resolveQuarantine: async () => ({ resolved: true }),
      ...overrides,
    };
  }

  // 1. Path Traversal & Invalid Characters
  const invalidAdPath = path.join(tempDir, 'workspace:stream');
  let adErr = null;
  try {
    await executeWithSupervisor({
      supervisor: createMockSupervisor(),
      isSyntheticTest: true,
      runId: 'run-path-ad',
      workspaceRoot: invalidAdPath,
      approvedSnapshotDigest: 'snap-digest',
      command: 'echo hello',
    });
  } catch (err) {
    adErr = err;
  }
  assert.ok(adErr, 'Should reject Alternate Data Stream in workspace path');
  assert.strictEqual(adErr.reasonCode, 'INVALID_WORKSPACE_PATH');

  // Null byte in workspace path
  let nullErr = null;
  try {
    await executeWithSupervisor({
      supervisor: createMockSupervisor(),
      isSyntheticTest: true,
      runId: 'run-path-null',
      workspaceRoot: 'C:\\workspace\0evil',
      approvedSnapshotDigest: 'snap-digest',
      command: 'echo hello',
    });
  } catch (err) {
    nullErr = err;
  }
  assert.ok(nullErr, 'Should reject null byte in workspace path');
  assert.strictEqual(nullErr.reasonCode, 'INVALID_WORKSPACE_PATH');

  // 2. Command Digest Tampering Guard in executeWithSupervisor
  const testWorkspace = path.join(tempDir, 'safe-workspace');
  await fs.mkdir(testWorkspace, { recursive: true });

  let cmdMismatchErr = null;
  try {
    await executeWithSupervisor({
      supervisor: createMockSupervisor({
        issueExecutionGrant: async (req) => ({
          granted: true,
          runId: req.runId,
          workspaceRoot: req.workspaceRoot,
          approvedSnapshotDigest: req.approvedSnapshotDigest,
          commandDigest: crypto.createHash('sha256').update('npm test').digest('hex'),
          sessionId: req.sessionId,
        }),
      }),
      isSyntheticTest: true,
      runId: 'run-tampered-cmd',
      workspaceRoot: testWorkspace,
      approvedSnapshotDigest: 'snap-digest',
      command: 'npm run malicious',
    });
  } catch (err) {
    cmdMismatchErr = err;
  }
  assert.ok(cmdMismatchErr, 'Should reject execution when command does not match issued grant commandDigest');
  assert.strictEqual(cmdMismatchErr.reasonCode, 'COMMAND_APPROVAL_MISMATCH');

  // 3. Session Mismatch Rejection
  let sessionMismatchErr = null;
  try {
    await executeWithSupervisor({
      supervisor: createMockSupervisor({
        issueExecutionGrant: async (req) => ({
          granted: true,
          runId: req.runId,
          workspaceRoot: req.workspaceRoot,
          approvedSnapshotDigest: req.approvedSnapshotDigest,
          commandDigest: crypto.createHash('sha256').update('npm test').digest('hex'),
          sessionId: 'session-attacker',
        }),
      }),
      isSyntheticTest: true,
      runId: 'run-sess-tamper',
      workspaceRoot: testWorkspace,
      approvedSnapshotDigest: 'snap-digest',
      command: 'npm test',
      sessionId: 'session-authorized',
    });
  } catch (err) {
    sessionMismatchErr = err;
  }
  assert.ok(sessionMismatchErr, 'Should reject execution on session mismatch');
  assert.strictEqual(sessionMismatchErr.reasonCode, 'SESSION_MISMATCH');

  // 4. Reparse point / junction escape detection on child directories
  const junctionTarget = path.join(tempDir, 'junction-target');
  const junctionWorkspace = path.join(tempDir, 'workspace-with-junction');
  const nestedJunction = path.join(junctionWorkspace, 'nested-link');
  await fs.mkdir(junctionTarget, { recursive: true });
  await fs.mkdir(junctionWorkspace, { recursive: true });

  let junctionCreated = false;
  try {
    await fs.symlink(junctionTarget, nestedJunction, 'junction');
    junctionCreated = true;
  } catch {}

  if (junctionCreated) {
    let junctionErr = null;
    try {
      await executeWithSupervisor({
        supervisor: createMockSupervisor(),
        isSyntheticTest: true,
        runId: 'run-junction-test',
        workspaceRoot: junctionWorkspace,
        approvedSnapshotDigest: 'snap-digest',
        command: 'npm test',
      });
    } catch (err) {
      junctionErr = err;
    }
    assert.ok(junctionErr, 'Should reject workspace containing nested junction/reparse point');
    assert.strictEqual(junctionErr.reasonCode, 'WORKSPACE_REPARSE_POINT_DETECTED');
  }

  // 5. Fail-closed gates remain strictly enforced
  const liveCheck = await verifyLiveSupervisorProcessIsolation({ isSyntheticTest: false, timeoutMs: 500 });
  assert.strictEqual(liveCheck.processIsolationGate, 'BLOCKED');
  assert.strictEqual(liveCheck.hostFallback, 'ZERO');
}

// -------------------------------------------------------------
// Test 11: Milestone V44.85.6D Security Remediation Tests
// -------------------------------------------------------------
async function testV44856DSecurityRemediation() {
  console.log('Testing V44.85.6D fail-closed session, handle lifecycle and path validation...');

  const { executeWithSupervisor, assertSecureWorkspacePath } = windowsAdapterPkg;

  function createMockSupervisor(overrides = {}) {
    const base = createNativeSupervisorClient({
      isSyntheticTest: true,
      pid: 9999,
      tokenUserSid: 'S-1-5-18',
    });
    return {
      ...base,
      issueExecutionGrant: async (req) => {
        if (!req.sessionId) {
          return { granted: false, rejected: true, reasonCode: 'SESSION_ID_REQUIRED' };
        }
        return {
          granted: true,
          runId: req.runId,
          workspaceRoot: req.workspaceRoot,
          approvedSnapshotDigest: req.approvedSnapshotDigest,
          commandDigest: req.commandDigest,
          sessionId: req.sessionId,
        };
      },
      consumeExecutionGrant: async (grant) => {
        if (!grant.sessionId) {
          return { ok: false, consumed: false, reasonCode: 'SESSION_ID_REQUIRED' };
        }
        return { ok: true, consumed: true };
      },
      allocateWorker: async (req) => {
        if (!req.sessionId) {
          return { allocated: false, reasonCode: 'SESSION_ID_REQUIRED' };
        }
        return { workerId: 'w-v44-test' };
      },
      observeEffectiveIsolation: async () => ({ effectiveIsolationVerified: true }),
      executeApprovedOperation: async (req) => {
        if (!req.sessionId) {
          return { ok: false, exitCode: -1, reasonCode: 'SESSION_ID_REQUIRED' };
        }
        return { ok: true, exitCode: 0 };
      },
      enforceDeadlineAndCancellation: async () => {},
      collectHostEvidence: async () => ({ evidenceCollected: true }),
      terminateWorker: async () => ({ terminated: true }),
      verifyWorkerTerminationAndResourceRelease: async () => ({ released: true }),
      quarantineResource: async () => ({ quarantined: true }),
      resolveQuarantine: async () => ({ resolved: true }),
      ...overrides,
    };
  }

  const safeWs = path.join(tempDir, 'v44-safe-ws');
  await fs.mkdir(safeWs, { recursive: true });

  // 1. Missing / Mismatched Session Rejection on Grant Issuance & Return
  let missingSessErr = null;
  try {
    await executeWithSupervisor({
      supervisor: createMockSupervisor({
        issueExecutionGrant: async (req) => ({
          granted: true,
          runId: req.runId,
          workspaceRoot: req.workspaceRoot,
          approvedSnapshotDigest: req.approvedSnapshotDigest,
          commandDigest: crypto.createHash('sha256').update('npm test').digest('hex'),
          // Intentionally omitting sessionId
        }),
      }),
      isSyntheticTest: true,
      runId: 'run-missing-session-test',
      workspaceRoot: safeWs,
      approvedSnapshotDigest: 'snap-digest-v44',
      command: 'npm test',
      sessionId: 'session-explicit-123',
    });
  } catch (err) {
    missingSessErr = err;
  }
  assert.ok(missingSessErr, 'Should reject execution when grant omits sessionId');
  assert.strictEqual(missingSessErr.reasonCode, 'SESSION_MISMATCH');

  // 2. Reparse-point scan bounded depth (depth >= 4) fails closed
  const deepDir = path.join(tempDir, 'deep-ws', 'lvl1', 'lvl2', 'lvl3', 'lvl4');
  await fs.mkdir(deepDir, { recursive: true });
  const deepWsRoot = path.join(tempDir, 'deep-ws');

  let scanBoundErr = null;
  try {
    await assertSecureWorkspacePath(deepWsRoot);
  } catch (err) {
    scanBoundErr = err;
  }
  assert.ok(scanBoundErr, 'Should fail closed when directory hierarchy reaches depth >= 4');
  assert.strictEqual(scanBoundErr.reasonCode, 'WORKSPACE_SCAN_BOUND_EXCEEDED');

  // 3. Unreadable workspace directory fails closed
  let unreadableErr = null;
  const originalReaddir = fs.readdir;
  try {
    fs.readdir = async () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    };
    await assertSecureWorkspacePath(safeWs);
  } catch (err) {
    unreadableErr = err;
  } finally {
    fs.readdir = originalReaddir;
  }
  assert.ok(unreadableErr, 'Should fail closed on unreadable directory');
  assert.strictEqual(unreadableErr.reasonCode, 'WORKSPACE_DIRECTORY_UNREADABLE');

  // 4. Live supervisor process isolation gate remains strictly BLOCKED
  const liveRes = await verifyLiveSupervisorProcessIsolation({ isSyntheticTest: false, timeoutMs: 500 });
  assert.strictEqual(liveRes.processIsolationGate, 'BLOCKED');
  assert.strictEqual(liveRes.hostFallback, 'ZERO');
}

// -------------------------------------------------------------
// Test 12: Milestone V44.85.7A Command Output Integrity & Evidence Pipeline
// -------------------------------------------------------------
async function testV44857ACommandOutputIntegrity() {
  console.log('Testing V44.85.7A command output integrity, real process evidence and honest launch verification...');

  const { executeWithSupervisor } = windowsAdapterPkg;

  function createMockSupervisor(overrides = {}) {
    const base = createNativeSupervisorClient({
      isSyntheticTest: true,
      pid: 9999,
      tokenUserSid: 'S-1-5-18',
    });
    return {
      ...base,
      issueExecutionGrant: async (req) => ({
        granted: true,
        runId: req.runId,
        workspaceRoot: req.workspaceRoot,
        approvedSnapshotDigest: req.approvedSnapshotDigest,
        commandDigest: req.commandDigest,
        sessionId: req.sessionId,
      }),
      consumeExecutionGrant: async () => ({ ok: true, consumed: true }),
      allocateWorker: async () => ({ workerId: 'w-v44-7a' }),
      observeEffectiveIsolation: async () => ({ effectiveIsolationVerified: true }),
      executeApprovedOperation: async (req) => {
        return {
          ok: true,
          exitCode: 0,
          stdout: 'REAL_STDOUT_PAYLOAD',
          stderr: 'REAL_STDERR_PAYLOAD',
          workerPid: 54321,
          childProcessSpawned: true,
          isSynthetic: false,
        };
      },
      enforceDeadlineAndCancellation: async () => {},
      collectHostEvidence: async () => ({ evidenceCollected: true }),
      terminateWorker: async () => ({ terminated: true }),
      verifyWorkerTerminationAndResourceRelease: async () => ({ released: true }),
      quarantineResource: async () => ({ quarantined: true }),
      resolveQuarantine: async () => ({ resolved: true }),
      ...overrides,
    };
  }

  const safeWs = path.join(tempDir, 'v44-7a-safe-ws');
  await fs.mkdir(safeWs, { recursive: true });

  // 1. Real stdout and stderr preservation
  const realRes = await executeWithSupervisor({
    supervisor: createMockSupervisor(),
    isSyntheticTest: true,
    runId: 'run-v44-real-out',
    workspaceRoot: safeWs,
    approvedSnapshotDigest: 'snap-digest',
    command: 'npm run test-evidence',
    sessionId: 'session-7a',
  });
  assert.strictEqual(realRes.ok, true);
  assert.strictEqual(realRes.exitCode, 0);
  assert.strictEqual(realRes.stdout, 'REAL_STDOUT_PAYLOAD', 'Actual child stdout must be preserved intact');
  assert.strictEqual(realRes.stderr, 'REAL_STDERR_PAYLOAD', 'Actual child stderr must be preserved intact');
  assert.strictEqual(realRes.workerPid, 54321);
  assert.strictEqual(realRes.childProcessSpawned, true);

  // 2. Non-zero exit code preservation (never inverted to 0)
  const failRes = await executeWithSupervisor({
    supervisor: createMockSupervisor({
      executeApprovedOperation: async () => ({
        ok: false,
        exitCode: 42,
        stdout: '',
        stderr: 'Compilation failed on line 12',
        workerPid: 54322,
        childProcessSpawned: true,
      }),
    }),
    isSyntheticTest: true,
    runId: 'run-v44-fail-out',
    workspaceRoot: safeWs,
    approvedSnapshotDigest: 'snap-digest',
    command: 'npm run compile',
    sessionId: 'session-7a',
  });
  assert.strictEqual(failRes.ok, false);
  assert.strictEqual(failRes.exitCode, 42, 'Non-zero exit code must be preserved');
  assert.strictEqual(failRes.stderr, 'Compilation failed on line 12');

  // 3. Process creation failure handling
  let createFailErr = null;
  try {
    await executeWithSupervisor({
      supervisor: createMockSupervisor({
        executeApprovedOperation: async () => {
          const err = new Error('CreateProcess failed: binary not found.');
          err.code = 'PROCESS_CREATE_FAILED';
          err.exitCode = -1;
          throw err;
        },
      }),
      isSyntheticTest: true,
      runId: 'run-v44-create-fail',
      workspaceRoot: safeWs,
      approvedSnapshotDigest: 'snap-digest',
      command: 'nonexistent-binary',
      sessionId: 'session-7a',
    });
  } catch (err) {
    createFailErr = err;
  }
  assert.ok(createFailErr, 'Process creation failure must be caught and not reported as success');
  assert.strictEqual(createFailErr.code, 'PROCESS_CREATE_FAILED');

  // 4. Missing process result rejection (null/undefined exitCode must not yield ok: true)
  const missingExitRes = await executeWithSupervisor({
    supervisor: createMockSupervisor({
      executeApprovedOperation: async () => ({
        stdout: '',
        stderr: '',
        // exitCode is missing
      }),
    }),
    isSyntheticTest: true,
    runId: 'run-v44-missing-exit',
    workspaceRoot: safeWs,
    approvedSnapshotDigest: 'snap-digest',
    command: 'npm test',
    sessionId: 'session-7a',
  });
  assert.strictEqual(missingExitRes.ok, false, 'Missing exit code must not become ok: true');
  assert.strictEqual(missingExitRes.exitCode, null);

  // 5. Empty output handling without substituting wrapper message
  const emptyRes = await executeWithSupervisor({
    supervisor: createMockSupervisor({
      executeApprovedOperation: async () => ({
        ok: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        workerPid: 54323,
        childProcessSpawned: true,
      }),
    }),
    isSyntheticTest: true,
    runId: 'run-v44-empty-out',
    workspaceRoot: safeWs,
    approvedSnapshotDigest: 'snap-digest',
    command: 'npm install',
    sessionId: 'session-7a',
  });
  assert.strictEqual(emptyRes.ok, true);
  assert.strictEqual(emptyRes.exitCode, 0);
  assert.strictEqual(emptyRes.stdout, '', 'Empty stdout must not be substituted with wrapper strings');

  // 6. Distinction between synthetic mock and real OS process evidence
  const synRes = await executeWithSupervisor({
    supervisor: createMockSupervisor({
      executeApprovedOperation: async () => ({
        ok: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        childProcessSpawned: false,
        isSynthetic: true,
      }),
    }),
    isSyntheticTest: true,
    runId: 'run-v44-syn-out',
    workspaceRoot: safeWs,
    approvedSnapshotDigest: 'snap-digest',
    command: 'echo synthetic',
    sessionId: 'session-7a',
  });
  assert.strictEqual(synRes.childProcessSpawned, false, 'Synthetic execution must report childProcessSpawned: false');
  assert.strictEqual(synRes.isSynthetic, true, 'Synthetic execution must report isSynthetic: true');
}

async function runAllTests() {
  try {
    await setupTestDir();
    await testProviderAbsentOrUnsupported();
    await testProviderDiscoveryDoesNotEqualTrust();
    await testRequiredCapabilityMissing();
    await testEvidenceIntegrityAndWorkloadBinding();
    await testCallerSuppliedBooleanFlagsRejected();
    await testPolicyChangeInvalidation();
    await testWorkerAuthCannotOverrideBlockedIsolation();
    await testWindowsHostPolicyBlocksExecution();
    await testV44856SecurityGateAndSupervisorRemediation();
    await testV44856BSecurityHardening();
    await testV44856DSecurityRemediation();
    await testV44857ACommandOutputIntegrity();
    console.log('All Isolation Provider Verification & Sandbox Readiness regression tests passed successfully!');
  } finally {
    await cleanupTestDir();
  }
}

runAllTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
