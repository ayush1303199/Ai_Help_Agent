import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import brokerModule from '../electron/coding-pipeline/trustedLocalDesktopBroker.cjs';

const { TrustedLocalDesktopBroker } = brokerModule;
const { verifyIntegrationReachability } = await import('../electron/coding-pipeline/modularArchitectureEngine.cjs');

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeProposal(scope = '.') {
  const taskId = randomUUID();
  const firstPath = `${randomBytes(5).toString('hex')}/${randomBytes(5).toString('hex')}.mjs`;
  const secondPath = `${randomBytes(5).toString('hex')}.mjs`;
  const files = [
    { path: firstPath, operation: 'create', sourcePath: null, content: `export const value = '${randomUUID()}';\n` },
    { path: secondPath, operation: 'create', sourcePath: null, content: `export { value } from './${firstPath.replace(/\\/g, '/')}';\n` },
  ].map((file) => ({ ...file, hash: hash(file.content) }));
  return {
    taskId,
    proposalId: randomUUID(),
    manifestHash: randomBytes(32).toString('hex'),
    scope,
    files,
    before: files.map((file) => ({
      path: file.path,
      exists: false,
      type: 'missing',
      hash: hash('MISSING'),
    })),
  };
}

async function post(endpoint, origin, route, body) {
  return fetch(new URL(route, endpoint), {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function assertNoFiles(root) {
  assert.deepEqual(await fs.readdir(root), []);
}

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), `trusted-broker-${randomBytes(5).toString('hex')}-`));
const workspaceA = path.join(fixtureRoot, randomBytes(5).toString('hex'));
const workspaceB = path.join(fixtureRoot, randomBytes(5).toString('hex'));
await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB)]);
const origin = `http://127.0.0.1:${await reservePort()}`;
let approvalMode = 'approve';
let currentProposal = null;
let capturedApproval = null;
let mutationRoot = null;
let driftPath = null;
let notifyWorkflowStarted = () => {};
let workflowStarted = Promise.resolve();
const broker = new TrustedLocalDesktopBroker({
  allowedOrigins: [origin],
  sessionTtlMs: 1200,
  onLeaseCreated: async () => {},
  onLeaseReleased: async () => {},
  getTask: (taskId) => currentProposal?.taskId === taskId ? currentProposal : null,
  validateSnapshots: async (taskId) => {
    if (currentProposal?.taskId !== taskId) throw new Error('No task is available for snapshot validation.');
    for (const snapshot of currentProposal.before) {
      if (!snapshot.exists) {
        try {
          await fs.stat(path.join(mutationRoot, snapshot.path));
          const error = new Error('Fixture disk state changed after approval.');
          error.code = 'STALE_PROPOSAL_DRIFT';
          throw error;
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        }
      }
    }
  },
  requestApproval: async (approval) => {
    capturedApproval = approval;
    assert.equal(approval.proposalDigest.length, 64);
    await assertNoFiles(mutationRoot);
    return !['reject', 'malformed', 'invalid-path'].includes(approvalMode);
  },
  executeWorkflow: async (input) => {
    if (approvalMode === 'cancel') {
      notifyWorkflowStarted();
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (input.isCancelled()) {
            clearInterval(timer);
            resolve();
          }
        }, 5);
      });
      return { outcome: 'CANCELLED', filesModified: [] };
    }
    currentProposal = makeProposal(input.scope);
    const proposal = currentProposal;
    if (approvalMode === 'malformed') {
      proposal.manifestHash = '';
    }
    if (approvalMode === 'invalid-path') {
      proposal.files[0].path = `../${proposal.files[0].path}`;
    }
    const approved = await input.requestApproval({
      taskId: proposal.taskId,
      proposal,
      proposalContract: { isGreenfield: true },
      diff: proposal.files.map((file) => `+++ ${file.path}\n+${file.content}`).join('\n'),
    });
    if (!approved) return { outcome: 'APPROVAL_REJECTED', filesModified: [] };
    const preApprovalManifestHash = proposal.manifestHash;
    proposal.manifestHash = randomBytes(32).toString('hex');
    proposal.approval = {
      proposalId: proposal.proposalId,
      manifestHash: proposal.manifestHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: new Date().toISOString(),
    };
    proposal.state = 'applying';
    assert.notEqual(proposal.manifestHash, preApprovalManifestHash);
    if (approvalMode === 'tamper') {
      currentProposal.files[0].content += 'tampered\n';
    }
    if (approvalMode === 'drift') {
      driftPath = path.join(input.root, proposal.files[0].path);
      await fs.mkdir(path.dirname(driftPath), { recursive: true });
      await fs.writeFile(driftPath, 'external change\n', { flag: 'wx' });
    }
    const authorizationRoot = approvalMode === 'cross-project' ? workspaceB : input.root;
    await input.authorizeMutation({
      taskId: proposal.taskId,
      operation: 'create',
      paths: proposal.files.map((file) => file.path),
      proposalApproved: true,
      requestBinding: { root: authorizationRoot, scope: input.scope },
    });
    for (const file of proposal.files) {
      const target = path.resolve(input.root, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, { flag: 'wx' });
    }
    return { outcome: 'SUCCESS', filesModified: proposal.files.map((file) => file.path) };
  },
});

try {
  const endpoint = await broker.start();
  const health = await fetch(new URL('/v1/health', endpoint), {
    headers: { Origin: origin },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ready: true });
  const registrationA = await broker.registerProject({ root: workspaceA, registrationOwnerId: 11001 });
  assert.deepEqual(
    await broker.registerProject({ root: workspaceA, registrationOwnerId: 11001 }),
    registrationA,
    'Synchronizing an unchanged project must preserve its opaque authorization identity.',
  );
  const registrationB = await broker.registerProject({ root: workspaceB, registrationOwnerId: 11002 });

  const forgedProject = await post(endpoint, origin, '/v1/sessions', {
    projectId: randomUUID(),
  });
  assert.equal(forgedProject.status, 403);
  const rawPathRegistration = await post(endpoint, origin, '/v1/sessions', {
    projectId: registrationA.projectId,
    root: workspaceA,
  });
  assert.equal(rawPathRegistration.status, 400);

  const leaseResponse = await post(endpoint, origin, '/v1/sessions', { projectId: registrationA.projectId });
  assert.equal(leaseResponse.status, 201);
  const lease = await leaseResponse.json();
  assert.equal('approvalGrant' in lease, false);
  assert.equal('approvalNonce' in lease, false);
  assert.equal('masterToken' in lease, false);

  const forgedApproval = await post(endpoint, origin, '/v1/workflows', {
    ...lease,
    userRequest: 'Create a generic multi-module project.',
    scope: '.',
    approved: true,
  });
  assert.equal(forgedApproval.status, 400);
  assert.equal(capturedApproval, null);

  mutationRoot = workspaceA;
  approvalMode = 'approve';
  const successResponse = await post(endpoint, origin, '/v1/workflows', {
    brokerSessionId: lease.brokerSessionId,
    sessionLeaseToken: lease.sessionLeaseToken,
    userRequest: 'Create a generic multi-module project.',
    scope: '.',
  });
  assert.equal(successResponse.status, 200);
  const success = await successResponse.json();
  assert.equal(success.outcome, 'SUCCESS');
  assert.equal(success.filesModified.length, 2);
  assert.equal(capturedApproval.fileOperations.length, 2);
  for (const file of success.filesModified) {
    assert.ok((await fs.readFile(path.join(workspaceA, file), 'utf8')).length > 0);
  }
  const reachability = await verifyIntegrationReachability(workspaceA, {
    modulesToCreate: success.filesModified.map((file) => ({ path: file })),
    integrationPoints: [{
      targetFile: success.filesModified[1],
      integrationSnippet: success.filesModified[0],
    }],
  });
  assert.equal(reachability.isValid, true, JSON.stringify(reachability));
  assert.deepEqual(await fs.readdir(workspaceB), []);
  await broker.releaseSession({ ...lease, origin });

  await fs.rm(workspaceA, { recursive: true, force: true });
  await fs.mkdir(workspaceA);
  broker.browserApproval = true;
  approvalMode = 'approve';
  mutationRoot = workspaceA;
  const browserApprovalLease = await (await post(endpoint, origin, '/v1/sessions', {
    projectId: registrationA.projectId,
  })).json();
  const browserWorkflowResponse = await post(endpoint, origin, '/v1/workflows', {
    brokerSessionId: browserApprovalLease.brokerSessionId,
    sessionLeaseToken: browserApprovalLease.sessionLeaseToken,
    userRequest: 'Create a generic multi-module project.',
    scope: '.',
  });
  assert.equal(browserWorkflowResponse.status, 200);
  const stagedWorkflow = await browserWorkflowResponse.json();
  assert.equal(stagedWorkflow.outcome, 'AWAITING_APPROVAL');
  const pendingApproval = stagedWorkflow.approval;
  assert.ok(pendingApproval, 'Standalone broker should return its staged browser proposal in the workflow response.');
  assert.equal(pendingApproval.fileOperations.length, 2);
  assert.equal(pendingApproval.proposalDigest.length, 64);
  assert.ok(pendingApproval.approvalNonce.length > 20);
  assert.match(pendingApproval.diff, /trusted|[+]/i);
  await assertNoFiles(workspaceA);
  const unboundApproval = await post(endpoint, origin, '/v1/workflows/approval/decision', {
    brokerSessionId: browserApprovalLease.brokerSessionId,
    sessionLeaseToken: browserApprovalLease.sessionLeaseToken,
    proposalId: pendingApproval.proposalId,
    proposalDigest: pendingApproval.proposalDigest,
    approved: true,
    deleteConfirmed: false,
  });
  assert.equal(unboundApproval.status, 403, 'A bare approval flag without the issued nonce must fail closed.');
  await assertNoFiles(workspaceA);
  const browserDecision = await post(endpoint, origin, '/v1/workflows/approval/decision', {
    brokerSessionId: browserApprovalLease.brokerSessionId,
    sessionLeaseToken: browserApprovalLease.sessionLeaseToken,
    proposalId: pendingApproval.proposalId,
    proposalDigest: pendingApproval.proposalDigest,
    approvalNonce: pendingApproval.approvalNonce,
    approved: true,
    deleteConfirmed: false,
  });
  assert.equal(browserDecision.status, 200);
  const browserDecisionResult = await browserDecision.json();
  assert.equal(browserDecisionResult.decisionAccepted, true);
  const browserWorkflow = browserDecisionResult.result;
  assert.equal(browserWorkflow.outcome, 'SUCCESS');
  for (const file of browserWorkflow.filesModified) {
    assert.ok((await fs.readFile(path.join(workspaceA, file), 'utf8')).trim().length > 0);
  }
  const browserReachability = await verifyIntegrationReachability(workspaceA, {
    modulesToCreate: browserWorkflow.filesModified.map((filePath) => ({ path: filePath })),
    integrationPoints: [{ targetFile: browserWorkflow.filesModified[1], integrationSnippet: browserWorkflow.filesModified[0] }],
  });
  assert.equal(browserReachability.isValid, true, JSON.stringify(browserReachability));
  await broker.releaseSession({ ...browserApprovalLease, origin });
  broker.browserApproval = false;

  const runBlockedScenario = async (mode, expectedCode, expectedStatus = 403) => {
    await fs.rm(workspaceA, { recursive: true, force: true });
    await fs.mkdir(workspaceA);
    approvalMode = mode;
    mutationRoot = workspaceA;
    const nextLeaseResponse = await post(endpoint, origin, '/v1/sessions', { projectId: registrationA.projectId });
    const nextLease = await nextLeaseResponse.json();
    const resultResponse = await post(endpoint, origin, '/v1/workflows', {
      brokerSessionId: nextLease.brokerSessionId,
      sessionLeaseToken: nextLease.sessionLeaseToken,
      userRequest: 'Create a generic multi-module project.',
      scope: '.',
    });
    if (expectedCode) {
      assert.equal(resultResponse.status, expectedStatus);
      assert.equal((await resultResponse.json()).error.code, expectedCode);
    } else {
      assert.equal(resultResponse.status, 200);
      assert.equal((await resultResponse.json()).outcome, 'APPROVAL_REJECTED');
    }
    if (mode === 'drift') {
      assert.equal(await fs.readFile(driftPath, 'utf8'), 'external change\n');
      await fs.rm(driftPath, { force: true });
      let parent = path.dirname(driftPath);
      while (parent !== workspaceA) {
        await fs.rmdir(parent).catch(() => {});
        parent = path.dirname(parent);
      }
      driftPath = null;
    } else {
      await assertNoFiles(workspaceA);
    }
    await broker.releaseSession({ ...nextLease, origin }).catch(() => {});
  };

  await runBlockedScenario('reject', null);
  await runBlockedScenario('tamper', 'BROKER_APPROVAL_DIGEST_MISMATCH');
  await runBlockedScenario('cross-project', 'BROKER_APPROVAL_REQUIRED');
  await runBlockedScenario('drift', 'STALE_PROPOSAL_DRIFT', 409);
  await runBlockedScenario('malformed', 'BROKER_PROPOSAL_INVALID', 422);
  await runBlockedScenario('invalid-path', 'BROKER_PROPOSAL_INVALID', 422);

  approvalMode = 'cancel';
  workflowStarted = new Promise((resolve) => { notifyWorkflowStarted = resolve; });
  const cancellationLease = await (await post(endpoint, origin, '/v1/sessions', {
    projectId: registrationA.projectId,
  })).json();
  const activeWorkflowResponse = post(endpoint, origin, '/v1/workflows', {
    brokerSessionId: cancellationLease.brokerSessionId,
    sessionLeaseToken: cancellationLease.sessionLeaseToken,
    userRequest: 'Create a generic multi-module project.',
    scope: '.',
  });
  await workflowStarted;
  const cancellationResponse = await post(endpoint, origin, '/v1/workflows/cancel', {
    brokerSessionId: cancellationLease.brokerSessionId,
    sessionLeaseToken: cancellationLease.sessionLeaseToken,
  });
  assert.equal(cancellationResponse.status, 200);
  assert.equal((await cancellationResponse.json()).cancellationAccepted, true);
  assert.equal((await (await activeWorkflowResponse).json()).outcome, 'CANCELLED');
  await assertNoFiles(workspaceA);
  await broker.releaseSession({ ...cancellationLease, origin });

  const traversalLeaseResponse = await post(endpoint, origin, '/v1/sessions', { projectId: registrationA.projectId });
  const traversalLease = await traversalLeaseResponse.json();
  const traversalResponse = await post(endpoint, origin, '/v1/workflows', {
    brokerSessionId: traversalLease.brokerSessionId,
    sessionLeaseToken: traversalLease.sessionLeaseToken,
    userRequest: 'Create a generic multi-module project.',
    scope: '../',
  });
  assert.equal(traversalResponse.status, 400);
  await assertNoFiles(workspaceA);
  await broker.releaseSession({ ...traversalLease, origin });

  const shortLivedResponse = await post(endpoint, origin, '/v1/sessions', { projectId: registrationB.projectId });
  const shortLivedLease = await shortLivedResponse.json();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const expiredResponse = await post(endpoint, origin, '/v1/workflows', {
    brokerSessionId: shortLivedLease.brokerSessionId,
    sessionLeaseToken: shortLivedLease.sessionLeaseToken,
    userRequest: 'Create a generic multi-module project.',
    scope: '.',
  });
  assert.equal(expiredResponse.status, 403);
  await assertNoFiles(workspaceB);

  const renewableLease = await (await post(endpoint, origin, '/v1/sessions', {
    projectId: registrationB.projectId,
  })).json();
  const renewableBinding = {
    brokerSessionId: renewableLease.brokerSessionId,
    sessionLeaseToken: renewableLease.sessionLeaseToken,
  };
  await new Promise((resolve) => setTimeout(resolve, 700));
  const firstHeartbeat = await post(endpoint, origin, '/v1/sessions/heartbeat', renewableBinding);
  assert.equal(firstHeartbeat.status, 200);
  const firstHeartbeatExpiry = (await firstHeartbeat.json()).expiresAt;
  await new Promise((resolve) => setTimeout(resolve, 700));
  const secondHeartbeat = await post(endpoint, origin, '/v1/sessions/heartbeat', renewableBinding);
  assert.equal(secondHeartbeat.status, 200, 'Heartbeat should extend the real broker lease beyond its original TTL.');
  assert.ok(Date.parse((await secondHeartbeat.json()).expiresAt) > Date.parse(firstHeartbeatExpiry));
  await broker.releaseSession({ ...renewableBinding, origin });

  const malformedTokenResponse = await post(endpoint, origin, '/v1/workflows', {
    brokerSessionId: lease.brokerSessionId,
    sessionLeaseToken: 'x',
    userRequest: 'Create a generic multi-module project.',
    scope: '.',
  });
  assert.equal(malformedTokenResponse.status, 403);
  assert.equal((await malformedTokenResponse.json()).error.code, 'BROKER_SESSION_UNAUTHORIZED');
  console.log('Trusted desktop broker threat tests passed (deterministic test delegate; no provider call).');
} finally {
  await broker.stop();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
