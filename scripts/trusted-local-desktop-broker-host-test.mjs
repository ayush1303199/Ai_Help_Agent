import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'trusted-broker-host-test-'));
const workspaceRoot = path.join(fixtureRoot, 'workspace');
const rejectedWorkspaceRoot = path.join(fixtureRoot, 'rejected-workspace');
const approvedWorkspaceRoot = path.join(fixtureRoot, 'approved-workspace');
const autonomousWorkspaceRoot = path.join(fixtureRoot, 'autonomous-workspace');
const runtimeSettingsPath = path.join(fixtureRoot, 'runtime-settings.json');
const authToken = randomBytes(32).toString('base64url');
const mutationSecret = randomBytes(32).toString('base64url');
let registered;
let activeWorkspaceRoot = rejectedWorkspaceRoot;
let child;
let childOutput = '';
let renderer;
const backend = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (request.headers['x-coding-auth'] !== authToken) {
    response.writeHead(401).end();
  } else if (request.method === 'GET' && request.url === '/api/coding/project-state') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'PROJECT_ATTACHED', projectRoot: activeWorkspaceRoot }));
  } else if (request.method === 'POST' && request.url === '/api/coding/broker/register') {
    registered = body;
    response.writeHead(200).end();
  } else if (request.method === 'POST' && request.url === '/api/coding/policy/file-mutation') {
    const canonical = (value) => Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
        : value;
    const expectedProof = createHmac('sha256', mutationSecret)
      .update(JSON.stringify(canonical(body)))
      .digest('hex');
    const proofMatches = request.headers['x-coding-mutation-proof'] === expectedProof;
    response.writeHead(proofMatches && body.proposalApproved === true ? 200 : 403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      decision: proofMatches && body.proposalApproved === true ? 'ALLOW' : 'BLOCK',
      reason: proofMatches ? 'Approved request binding validated.' : 'Mutation proof did not match.',
    }));
  } else {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not Found', path: request.url }));
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

try {
  await mkdir(workspaceRoot);
  await mkdir(rejectedWorkspaceRoot);
  await mkdir(approvedWorkspaceRoot);
  await mkdir(autonomousWorkspaceRoot);
  renderer = http.createServer();
  const [backendPort, rendererPort] = await Promise.all([listen(backend), listen(renderer)]);
  const runtimeSettings = {
    services: {
      http: { baseUrl: `http://127.0.0.1:${backendPort}` },
      devServer: { host: '127.0.0.1', port: rendererPort },
    },
    electron: { portConnectTimeoutMs: 1000 },
  };
  await writeFile(runtimeSettingsPath, JSON.stringify(runtimeSettings));
  child = spawn(process.execPath, ['electron/trustedLocalDesktopBrokerHost.cjs'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AI_RUNTIME_SETTINGS_PATH: runtimeSettingsPath,
      AI_CODING_AUTH_TOKEN: authToken,
      AI_CODING_MUTATION_HANDSHAKE_SECRET: mutationSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8').on('data', (text) => { childOutput += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => { childOutput += text; });

  const startupDeadline = Date.now() + 15000;
  while (!registered && Date.now() < startupDeadline) {
    if (child.exitCode !== null) throw new Error(`Standalone broker host exited early: ${childOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(registered, `Standalone host should register with the backend: ${childOutput}`);
  assert.equal(registered.projects.length, 1);
  assert.match(registered.projects[0].projectId, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(registered.projects[0], 'root'), false, 'Broker registration must not publish raw workspace paths.');

  const origin = `http://127.0.0.1:${rendererPort}`;
  const readBrokerJson = async (response, expectedStatus) => {
    const text = await response.text();
    assert.equal(response.status, expectedStatus, text);
    return JSON.parse(text);
  };
  const brokerFetch = async (route, payload) => fetch(new URL(route, registered.endpoint), {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const waitForRegistration = async (previousProjectId = null) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (registered?.projects?.length === 1
        && registered.projects[0].projectId !== previousProjectId) return registered.projects[0];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for the standalone host to bind the attached workspace: ${childOutput}`);
  };
  const acquireLease = async (project) => {
    const response = await brokerFetch('/v1/sessions', { projectId: project.projectId });
    return readBrokerJson(response, 201);
  };
  const runDecision = async (lease, decision, executionMode = 'inline_review') => {
    const binding = {
      brokerSessionId: lease.brokerSessionId,
      sessionLeaseToken: lease.sessionLeaseToken,
    };
    const workflowResponse = await brokerFetch('/v1/workflows', {
      ...binding,
      userRequest: `Create a modular full-stack feature. POST /api/${decision}.\nFields:\n- displayName: string (required)\n- quantity: number (default=1)\nAdd a frontend form UI.`,
      scope: '.',
      executionMode,
    });
    const workflow = await readBrokerJson(workflowResponse, 200);
    if (executionMode === 'autonomous_auto_apply') {
      assert.equal(workflow.outcome, 'SUCCESS', `Autonomous mode should apply and verify the production proposal: ${JSON.stringify(workflow)}\n${childOutput}`);
      assert.equal(workflow.codeApplied, true, JSON.stringify(workflow));
      assert.equal(workflow.codeVerified, true, JSON.stringify(workflow));
      const createdPaths = workflow.filesModified;
      assert.ok(createdPaths.length >= 5);
      for (const relativePath of createdPaths) {
        const fileStat = await stat(path.join(autonomousWorkspaceRoot, ...relativePath.split('/')));
        assert.ok(fileStat.isFile(), `Expected autonomous file ${relativePath} on disk.`);
      }
      return { result: workflow };
    }
    assert.equal(
      workflow.outcome,
      'AWAITING_APPROVAL',
      `Production developerAgent should return the staged proposal without an Electron renderer: ${JSON.stringify(workflow)}\n${childOutput}`,
    );
    assert.doesNotMatch(childOutput, /The Coding Agent renderer is unavailable for inline proposal review/);
    const pending = workflow.approval;
    assert.ok(pending, 'The workflow response must carry the staged inline proposal.');
    assert.ok(pending.envelope?.proposalId);
    assert.match(pending.envelope.proposalDigest, /^[a-f0-9]{64}$/i);
    assert.ok(pending.approvalNonce.length > 20);
    assert.equal(pending.envelope.approvalNonce, pending.approvalNonce);
    assert.ok(pending.envelope.fileBadges.length >= 5);
    assert.ok(pending.envelope.diffPreview.length >= 5);
    assert.deepEqual(await readdir(decision === 'approve' ? approvedWorkspaceRoot : rejectedWorkspaceRoot), [],
      'Staging a browser proposal must not write workspace files.');
    const decisionResponse = await brokerFetch('/v1/workflows/approval/decision', {
      ...binding,
      proposalId: pending.proposalId,
      proposalDigest: pending.proposalDigest,
      approvalNonce: pending.approvalNonce,
      approved: decision === 'approve',
      deleteConfirmed: false,
    });
    const decisionPayload = await readBrokerJson(decisionResponse, 200);
    assert.equal(decisionPayload.decisionAccepted, true);
    const result = decisionPayload.result;
    assert.ok(result && typeof result.outcome === 'string', 'Approval route must return the completed workflow result.');
    return { pending, result };
  };

  const rejectedProject = await waitForRegistration();
  const rejectedLease = await acquireLease(rejectedProject);
  const rejected = await runDecision(rejectedLease, 'reject');
  assert.equal(rejected.result.codeApplied, false, JSON.stringify(rejected.result));
  assert.deepEqual(await readdir(rejectedWorkspaceRoot), [], 'Rejecting a proposal must leave the workspace empty.');
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: rejectedLease.brokerSessionId,
    sessionLeaseToken: rejectedLease.sessionLeaseToken,
  });

  const previousProjectId = rejectedProject.projectId;
  activeWorkspaceRoot = approvedWorkspaceRoot;
  const syncResponse = await brokerFetch('/v1/synchronize', {});
  const synchronized = await readBrokerJson(syncResponse, 200);
  assert.equal(synchronized.synchronized, true);
  assert.ok(synchronized.projects.some((project) => project.projectId !== previousProjectId),
    'On-demand synchronization should register a newly attached workspace without waiting for the host poll.');
  const approvedProject = synchronized.projects.find((project) => project.projectId !== previousProjectId);
  const approvedLease = await acquireLease(approvedProject);
  const approved = await runDecision(approvedLease, 'approve');
  assert.equal(approved.result.codeApplied, true, JSON.stringify(approved.result));
  assert.equal(approved.result.codeVerified, true, JSON.stringify(approved.result));
  const createdPaths = approved.pending.fileOperations.map((file) => file.path);
  assert.ok(createdPaths.length >= 5);
  for (const relativePath of createdPaths) {
    const fileStat = await stat(path.join(approvedWorkspaceRoot, ...relativePath.split('/')));
    assert.ok(fileStat.isFile(), `Expected approved file ${relativePath} on disk.`);
  }
  assert.ok(createdPaths.some((file) => file.endsWith('Schema.js')));
  assert.ok(createdPaths.some((file) => file.endsWith('Controller.js')));
  assert.ok(createdPaths.some((file) => file.endsWith('Routes.js')));
  assert.ok(createdPaths.includes('server.js'));
  assert.ok(createdPaths.some((file) => file.endsWith('Form.jsx')));
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: approvedLease.brokerSessionId,
    sessionLeaseToken: approvedLease.sessionLeaseToken,
  });
  activeWorkspaceRoot = autonomousWorkspaceRoot;
  const autoSyncResponse = await brokerFetch('/v1/synchronize', {});
  const autoSync = await readBrokerJson(autoSyncResponse, 200);
  const autonomousProject = autoSync.projects.find((project) => project.projectId !== approvedProject.projectId);
  assert.ok(autonomousProject, 'The broker should synchronize the newly attached autonomous-mode workspace.');
  const autonomousLease = await acquireLease(autonomousProject);
  const autonomous = await runDecision(autonomousLease, 'autonomous', 'autonomous_auto_apply');
  assert.equal(autonomous.result.codeApplied, true);
  assert.equal(autonomous.result.codeVerified, true);
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: autonomousLease.brokerSessionId,
    sessionLeaseToken: autonomousLease.sessionLeaseToken,
  });
  console.log('Standalone broker host integration passed (production developerAgent proposal, inline reject/approve, materialization, and verification; backend policy/registry endpoints are isolated fixtures).');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
  }
  await close(backend).catch(() => {});
  if (renderer) await close(renderer).catch(() => {});
  await rm(fixtureRoot, { recursive: true, force: true });
}
