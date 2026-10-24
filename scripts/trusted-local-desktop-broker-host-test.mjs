import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveExistingProjectTestPlan,
  runHermeticRegressionLoopWithRuntime,
} from '../electron/coding-pipeline/modularArchitectureEngine.cjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'trusted-broker-host-test-'));
const workspaceRoot = path.join(fixtureRoot, 'workspace');
const rejectedWorkspaceRoot = path.join(fixtureRoot, 'rejected-workspace');
const approvedWorkspaceRoot = path.join(fixtureRoot, 'approved-workspace');
const autonomousWorkspaceRoot = path.join(fixtureRoot, 'autonomous-workspace');
const populatedWorkspaceRoot = path.join(fixtureRoot, 'populated-workspace');
const autonomousPopulatedWorkspaceRoot = path.join(fixtureRoot, 'autonomous-populated-workspace');
const inlineRuntimeWorkspaceRoot = path.join(fixtureRoot, 'inline-runtime-workspace');
const runtimeSettingsPath = path.join(fixtureRoot, 'runtime-settings.json');
const authToken = randomBytes(32).toString('base64url');
const mutationSecret = randomBytes(32).toString('base64url');
let registered;
let activeWorkspaceRoot = rejectedWorkspaceRoot;
const browserSessionBindings = new Map();
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
    const browserSessionId = request.headers['x-coding-browser-session'];
    if (typeof browserSessionId === 'string') browserSessionBindings.set(browserSessionId, activeWorkspaceRoot);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'PROJECT_ATTACHED', projectRoot: activeWorkspaceRoot }));
  } else if (request.method === 'POST' && request.url === '/api/coding/project-attach') {
    const browserSessionId = request.headers['x-coding-browser-session'];
    if (typeof browserSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(browserSessionId)) {
      response.writeHead(403).end();
      return;
    }
    activeWorkspaceRoot = body.projectRoot;
    browserSessionBindings.set(browserSessionId, activeWorkspaceRoot);
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
  await mkdir(populatedWorkspaceRoot);
  await mkdir(autonomousPopulatedWorkspaceRoot);
  await mkdir(inlineRuntimeWorkspaceRoot);
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
  const browserSessionId = crypto.randomUUID();
  const attachSelectedWorkspace = async (projectRoot) => {
    const response = await fetch(new URL('/api/coding/project-attach', `http://127.0.0.1:${backendPort}`), {
      method: 'POST',
      headers: {
        'X-Coding-Auth': authToken,
        'X-Coding-Browser-Session': browserSessionId,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectRoot }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'PROJECT_ATTACHED');
    return body;
  };
  const restoredProjectState = await fetch(new URL('/api/coding/project-state', `http://127.0.0.1:${backendPort}`), {
    headers: {
      'X-Coding-Auth': authToken,
      'X-Coding-Browser-Session': browserSessionId,
      Origin: origin,
    },
  }).then((response) => response.json());
  assert.equal(restoredProjectState.status, 'PROJECT_ATTACHED');
  assert.equal(
    browserSessionBindings.get(browserSessionId),
    rejectedWorkspaceRoot,
    'A reloaded local browser session should bind to the pre-attached workspace automatically.',
  );
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
  const runDecision = async (lease, decision, executionMode = 'inline_review', {
    userRequest = null,
    targetWorkspace = decision === 'approve' ? approvedWorkspaceRoot
      : decision === 'autonomous' ? autonomousWorkspaceRoot : rejectedWorkspaceRoot,
    expectEmptyBeforeApproval = true,
    expectNoChanges = false,
    minimumBadges = 5,
    minimumDiffPreview = 5,
    minimumFilesModified = expectNoChanges ? 0 : 5,
  } = {}) => {
    const binding = {
      brokerSessionId: lease.brokerSessionId,
      sessionLeaseToken: lease.sessionLeaseToken,
    };
    const workflowResponse = await brokerFetch('/v1/workflows', {
      ...binding,
      userRequest: userRequest || `Create a modular full-stack feature. POST /api/${decision}.\nFields:\n- displayName: string (required)\n- quantity: number (default=1)\nAdd a frontend form UI.`,
      scope: '.',
      executionMode,
    });
    const workflow = await readBrokerJson(workflowResponse, 200);
    if (executionMode === 'autonomous_auto_apply') {
      assert.equal(workflow.outcome, 'SUCCESS', `Autonomous mode should complete the production workflow: ${JSON.stringify(workflow)}\n${childOutput}`);
      assert.equal(workflow.codeApplied, !expectNoChanges, JSON.stringify(workflow));
      assert.equal(workflow.codeVerified, true, JSON.stringify(workflow));
      const createdPaths = workflow.filesModified;
      if (expectNoChanges) {
        assert.equal(workflow.noChangesRequired, true, JSON.stringify(workflow));
        assert.deepEqual(createdPaths, []);
      } else {
        assert.ok(createdPaths.length >= minimumFilesModified);
      }
      for (const relativePath of createdPaths) {
        const fileStat = await stat(path.join(targetWorkspace, ...relativePath.split('/')));
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
    if (userRequest === 'test the project') {
      assert.equal(workflow.executionVerificationReceipt?.status, 'PASSED', JSON.stringify(workflow));
      assert.equal(workflow.hermeticVerification?.passed, 9, JSON.stringify(workflow));
      assert.equal(pending.executionVerificationReceipt?.status, 'PASSED', JSON.stringify(pending));
      assert.equal(pending.hermeticVerification?.passed, 9, JSON.stringify(pending));
      assert.match(workflow.executionVerificationReceipt.message, /staged project-test candidate/);
      assert.match(workflow.message, /Behavioral test suite execution:.*EXECUTED & PASSED \(in-process runtime runner\)/);
      assert.equal(workflow.codeApplied, false);
      assert.equal(workflow.codeVerified, false);
    }
    assert.ok(pending.envelope?.proposalId);
    assert.match(pending.envelope.proposalDigest, /^[a-f0-9]{64}$/i);
    assert.ok(pending.approvalNonce.length > 20);
    assert.equal(pending.envelope.approvalNonce, pending.approvalNonce);
    assert.ok(
      pending.envelope.fileBadges.length >= minimumBadges,
      `Expected at least ${minimumBadges} proposal file badges, got ${pending.envelope.fileBadges.length}: ${JSON.stringify(pending.fileOperations)}`,
    );
    assert.ok(
      pending.envelope.diffPreview.length >= minimumDiffPreview,
      `Expected at least ${minimumDiffPreview} diff preview lines, got ${pending.envelope.diffPreview.length}.`,
    );
    if (expectEmptyBeforeApproval) {
      assert.deepEqual(await readdir(targetWorkspace), [],
        'Staging a browser proposal must not write workspace files.');
    }
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
  await attachSelectedWorkspace(approvedWorkspaceRoot);
  assert.equal(browserSessionBindings.get(browserSessionId), approvedWorkspaceRoot);
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
  assert.ok(createdPaths.some((file) => /(?:^|\/)models\/[^/]+\.js$/.test(file)));
  assert.ok(createdPaths.some((file) => /(?:^|\/)controllers\/[^/]+Controller\.js$/.test(file)));
  assert.ok(createdPaths.some((file) => /(?:^|\/)routes\/[^/]+\.js$/.test(file)));
  assert.ok(createdPaths.includes('server.js'));
  assert.ok(createdPaths.some((file) => file.endsWith('Form.jsx')));
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: approvedLease.brokerSessionId,
    sessionLeaseToken: approvedLease.sessionLeaseToken,
  });
  await attachSelectedWorkspace(autonomousWorkspaceRoot);
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

  const populatedStubs = {
    'server.js': "const express = require('express');\nconst app = express();\nmodule.exports = app;\n",
    'components/OrderForm.jsx': "import React, { useState } from 'react';\nconst fields = ['title', 'description', 'status'];\nexport default function OrderForm() { return null; }\n",
    'models/Order.js': "const mongoose = require('mongoose');\nmodule.exports = new mongoose.Schema({});\n",
    'routes/orders.js': "const { missingHandler } = require('../controllers/orderController');\nmodule.exports = missingHandler;\n",
    'controllers/orderController.js': "const { missingModel } = require('../models/Order');\nmodule.exports = { missingModel };\n",
    'config/db.js': "const mongoose = require('mongoose');\nmodule.exports = mongoose;\n",
    'app/orders/page.jsx': "import { MissingOrderForm } from '../../components/OrderForm.jsx';\nexport default function OrderPage() { return <MissingOrderForm />; }\n",
    'pages/orders.js': 'export default function LegacyOrderPage() { return null; }\n',
    'package.json': JSON.stringify({
      name: 'legacy-order-workspace',
      type: 'commonjs',
      scripts: { start: 'node old-server.js', dev: 'node old-server.js', test: 'echo legacy' },
      dependencies: { express: '^4.0.0', mongoose: '^8.0.0', react: '^18.0.0', 'react-dom': '^18.0.0' },
    }, null, 2),
    '.env.example': 'PORT=4300\nDATABASE_URL=mongodb://localhost/legacy\n',
    'README.md': '# Legacy workspace\n\nKeep this existing documentation.\n',
    'utils/sharedUtils.js': 'module.exports = {};\n',
    'services/featureService.js': 'module.exports = {};\n',
  };
  for (const [relativePath, source] of Object.entries(populatedStubs)) {
    const target = path.join(populatedWorkspaceRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source.replace(/\n/g, '\r\n'), 'utf8');
    const autonomousTarget = path.join(autonomousPopulatedWorkspaceRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(autonomousTarget), { recursive: true });
    await writeFile(autonomousTarget, source.replace(/\n/g, '\r\n'), 'utf8');
  }
  for (const root of [populatedWorkspaceRoot, autonomousPopulatedWorkspaceRoot]) {
    const generatedServer = path.join(root, 'generated', 'order', 'server.js');
    await mkdir(path.dirname(generatedServer), { recursive: true });
    await writeFile(generatedServer, 'module.exports = {};\n', 'utf8');
    const packagePath = path.join(root, 'package.json');
    const packageMetadata = JSON.parse(await readFile(packagePath, 'utf8'));
    packageMetadata.scripts = {
      ...(packageMetadata.scripts || {}),
      start: 'node generated/order/server.js',
      dev: 'node generated/order/server.js',
    };
    await writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`, 'utf8');
  }
  const retainedEnvironment = await readFile(path.join(populatedWorkspaceRoot, '.env.example'), 'utf8');
  const retainedReadme = await readFile(path.join(populatedWorkspaceRoot, 'README.md'), 'utf8');
  const populatedPrompt = `Build a complete full-stack order feature with frontend and backend integration.
Create a POST endpoint /api/orders.
Fields:
- customerName: string (required)
- items: [{ itemName: string, quantity: number, price: number }]
- totalPrice: number (auto calculated)
- status: string (default=Pending)
Create a Next.js App Router page and React form component with Tailwind CSS, dynamic item rows, and validation/success/error messages.
`;
  const updatePrompt = `${populatedPrompt}\nWorkspace resolution: UPDATE_AND_INTEGRATE.`;
  await attachSelectedWorkspace(autonomousPopulatedWorkspaceRoot);
  const autonomousPopulatedSync = await readBrokerJson(await brokerFetch('/v1/synchronize', {}), 200);
  const autonomousPopulatedProject = autonomousPopulatedSync.projects.find((project) => (
    project.projectId !== autonomousProject.projectId
      && project.projectId !== approvedProject.projectId
      && project.projectId !== rejectedProject.projectId
  ));
  assert.ok(autonomousPopulatedProject, 'The broker should synchronize the populated autonomous workspace.');
  const autonomousPopulatedLease = await acquireLease(autonomousPopulatedProject);
  const autonomousPopulatedUpdate = await runDecision(autonomousPopulatedLease, 'autonomous', 'autonomous_auto_apply', {
    userRequest: populatedPrompt,
    targetWorkspace: autonomousPopulatedWorkspaceRoot,
    expectEmptyBeforeApproval: false,
  });
  assert.equal(autonomousPopulatedUpdate.result.outcome, 'SUCCESS');
  assert.equal(autonomousPopulatedUpdate.result.hermeticVerification?.passed, 9);
  assert.equal(autonomousPopulatedUpdate.result.hermeticVerification?.total, 9);
  assert.equal(autonomousPopulatedUpdate.result.executionVerificationReceipt?.status, 'PASSED');
  assert.match(autonomousPopulatedUpdate.result.message, /verified across 9\/9 hermetic gates/);
  assert.match(autonomousPopulatedUpdate.result.message, /POST \/api\/orders -> 201 Created — PASS/);
  assert.match(autonomousPopulatedUpdate.result.message, /GET \/api\/orders -> 200 OK — PASS/);
  assert.match(autonomousPopulatedUpdate.result.message, /GET \/orders interactive form -> 200 — PASS/);
  assert.equal(autonomousPopulatedUpdate.result.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.ok(autonomousPopulatedUpdate.result.hermeticVerification.runtimeVerification.probes
    .some((probe) => probe.method === 'GET' && probe.routePath === '/api/orders' && probe.actual === 200 && probe.passed));
  assert.ok(autonomousPopulatedUpdate.result.hermeticVerification.runtimeVerification.uiPreview.paths
    .some((probe) => probe.path === '/orders' && probe.statusCode === 200 && probe.passed));
  assert.ok(autonomousPopulatedUpdate.result.filesModified.includes('server.js'));
  assert.ok(autonomousPopulatedUpdate.result.filesModified.includes('package.json'));
  assert.ok(autonomousPopulatedUpdate.result.filesModified.includes('tests/order.test.js'));
  assert.equal(
    JSON.parse(await readFile(path.join(autonomousPopulatedWorkspaceRoot, 'package.json'), 'utf8')).scripts.start,
    'node server.js',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(autonomousPopulatedWorkspaceRoot, 'package.json'), 'utf8')).scripts.test,
    'node tests/order.test.js',
  );
  await assert.rejects(stat(path.join(autonomousPopulatedWorkspaceRoot, 'pages', 'orders.js')), { code: 'ENOENT' });
  assert.ok((await stat(path.join(autonomousPopulatedWorkspaceRoot, 'legacy-pages-orders.js.txt'))).isFile());
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: autonomousPopulatedLease.brokerSessionId,
    sessionLeaseToken: autonomousPopulatedLease.sessionLeaseToken,
  });
  await attachSelectedWorkspace(populatedWorkspaceRoot);
  const populatedSyncResponse = await brokerFetch('/v1/synchronize', {});
  const populatedSync = await readBrokerJson(populatedSyncResponse, 200);
  const populatedProject = populatedSync.projects.find((project) => (
    project.projectId !== autonomousProject.projectId
      && project.projectId !== approvedProject.projectId
      && project.projectId !== rejectedProject.projectId
  ));
  assert.ok(populatedProject, 'The broker should synchronize the populated workspace.');

  const explicitLease = await acquireLease(populatedProject);
  const explicitUpdate = await runDecision(explicitLease, 'approve', 'inline_review', {
    userRequest: updatePrompt,
    targetWorkspace: populatedWorkspaceRoot,
    expectEmptyBeforeApproval: false,
  });
  assert.equal(explicitUpdate.result.outcome, 'SUCCESS', `${JSON.stringify(explicitUpdate.result)}\n${childOutput}`);
  assert.equal(explicitUpdate.result.codeApplied, true, JSON.stringify(explicitUpdate.result));
  assert.equal(explicitUpdate.result.codeVerified, true, JSON.stringify(explicitUpdate.result));
  assert.equal(explicitUpdate.result.hermeticVerification?.status, 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED', JSON.stringify(explicitUpdate.result.hermeticVerification));
  assert.equal(explicitUpdate.result.hermeticVerification?.passed, 9);
  assert.equal(explicitUpdate.result.hermeticVerification?.total, 9);
  assert.ok(explicitUpdate.result.filesModified.includes('server.js'));
  assert.ok(explicitUpdate.result.filesModified.includes('package.json'));
  assert.ok(explicitUpdate.result.filesModified.includes('tests/order.test.js'));
  assert.equal(JSON.parse(await readFile(path.join(populatedWorkspaceRoot, 'package.json'), 'utf8')).scripts.start, 'node server.js');
  assert.ok(explicitUpdate.pending.fileOperations.some((file) => (
    file.operation === 'rename' && file.sourcePath === 'pages/orders.js'
  )), 'A conflicting Pages Router file must be preserved through an approved rename.');
  await assert.rejects(stat(path.join(populatedWorkspaceRoot, 'pages', 'orders.js')), { code: 'ENOENT' });
  assert.ok((await stat(path.join(populatedWorkspaceRoot, 'legacy-pages-orders.js.txt'))).isFile());
  assert.doesNotMatch(JSON.stringify(explicitUpdate), /Patch context does not match/);
  for (const relativePath of [
    'config/db.js',
    'models/Order.js',
    'controllers/orderController.js',
    'routes/orders.js',
    'server.js',
    'components/OrderForm.jsx',
    'app/orders/page.jsx',
    'package.json',
  ]) {
    assert.ok(
      explicitUpdate.pending.fileOperations.some((file) => file.path === relativePath && file.operation === 'modify'),
      `Full-stack proposal must stage a snapshot-bound modification for ${relativePath}.`,
    );
    assert.ok(explicitUpdate.result.filesModified.includes(relativePath), `Full-stack proposal must update ${relativePath}.`);
  }
  assert.ok(!explicitUpdate.pending.fileOperations.some((file) => file.path === '.env.example'));
  assert.ok(!explicitUpdate.result.filesModified.includes('.env.example'));
  assert.equal(await readFile(path.join(populatedWorkspaceRoot, '.env.example'), 'utf8'), retainedEnvironment);
  const updatedReadme = await readFile(path.join(populatedWorkspaceRoot, 'README.md'), 'utf8');
  assert.ok(updatedReadme.startsWith(retainedReadme.trimEnd()), 'Existing README content must remain intact.');
  assert.match(updatedReadme, /## Generated local runtime/);
  assert.match(updatedReadme, /npm start/);
  assert.match(updatedReadme, /no `npm install` or `node_modules` directory is needed/i);
  assert.ok(!explicitUpdate.result.filesModified.includes('utils/sharedUtils.js'));
  assert.ok(!explicitUpdate.result.filesModified.includes('services/featureService.js'));
  for (const relativePath of Object.keys(populatedStubs).filter((file) => file !== 'pages/orders.js')) {
    const contents = await readFile(path.join(populatedWorkspaceRoot, ...relativePath.split('/')), 'utf8');
    assert.doesNotMatch(contents, /\r(?!\n)/, `${relativePath} must retain valid newline encoding after apply.`);
  }
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: explicitLease.brokerSessionId,
    sessionLeaseToken: explicitLease.sessionLeaseToken,
  });

  const repeatLease = await acquireLease(populatedProject);
  const repeatedUpdate = await runDecision(repeatLease, 'autonomous', 'autonomous_auto_apply', {
    userRequest: populatedPrompt,
    targetWorkspace: populatedWorkspaceRoot,
    expectEmptyBeforeApproval: false,
    expectNoChanges: true,
  });
  assert.equal(repeatedUpdate.result.outcome, 'SUCCESS', `${JSON.stringify(repeatedUpdate.result)}\n${childOutput}`);
  assert.equal(repeatedUpdate.result.codeApplied, false, JSON.stringify(repeatedUpdate.result));
  assert.equal(repeatedUpdate.result.codeVerified, true, JSON.stringify(repeatedUpdate.result));
  assert.equal(repeatedUpdate.result.hermeticVerification?.status, 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED');
  assert.equal(repeatedUpdate.result.hermeticVerification?.passed, 9);
  assert.equal(repeatedUpdate.result.hermeticVerification?.total, 9);
  assert.equal(repeatedUpdate.result.noChangesRequired, true, JSON.stringify(repeatedUpdate.result));
  assert.ok(repeatedUpdate.result.inspectedFiles?.length, 'No-change repeat runs must return inspected file metadata at top level.');
  assert.ok(repeatedUpdate.result.exploredDirectories?.length, 'No-change repeat runs must return explored directories at top level.');
  assert.ok(
    repeatedUpdate.result.engineeringAnalysis?.length || repeatedUpdate.result.engineeringSummary?.length,
    'No-change repeat runs must return engineering analysis at top level.',
  );
  assert.doesNotMatch(JSON.stringify(repeatedUpdate), /Patch context does not match/);
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: repeatLease.brokerSessionId,
    sessionLeaseToken: repeatLease.sessionLeaseToken,
  });

  for (const resolution of ['KEEP_AND_SCAFFOLD', 'REPLACE_TARGETS']) {
    const resolutionLease = await acquireLease(populatedProject);
    const result = await runDecision(resolutionLease, 'approve', 'inline_review', {
      userRequest: `${populatedPrompt}\nWorkspace resolution: ${resolution}.`,
      targetWorkspace: populatedWorkspaceRoot,
      expectEmptyBeforeApproval: false,
      minimumBadges: 1,
      minimumDiffPreview: 1,
    });
    assert.equal(result.result.outcome, 'SUCCESS', `${resolution}: ${JSON.stringify(result.result)}\n${childOutput}`);
    assert.equal(result.result.codeApplied, true);
    assert.equal(result.result.codeVerified, true);
    assert.equal(result.result.hermeticVerification?.passed, 9);
    assert.equal(result.result.hermeticVerification?.total, 9);
    assert.equal(await readFile(path.join(populatedWorkspaceRoot, '.env.example'), 'utf8'), retainedEnvironment);
    if (resolution === 'KEEP_AND_SCAFFOLD') {
      assert.ok(result.pending.fileOperations.some((file) => file.path === 'generated/order/server.js'));
    } else {
      assert.ok(result.pending.fileOperations.some((file) => file.path === 'server.js' && file.operation === 'modify'));
    }
    await brokerFetch('/v1/sessions/release', {
      brokerSessionId: resolutionLease.brokerSessionId,
      sessionLeaseToken: resolutionLease.sessionLeaseToken,
    });
  }
  await attachSelectedWorkspace(populatedWorkspaceRoot);
  await readBrokerJson(await brokerFetch('/v1/synchronize', {}), 200);
  await rm(path.join(populatedWorkspaceRoot, 'tests'), { recursive: true, force: true });
  const brokerRuntimeManifest = {
    name: 'legacy-order-app',
    version: '1.0.0',
    type: 'commonjs',
    scripts: {
      start: 'node server.js',
      dev: 'node server.js',
      test: 'node --check server.js',
    },
  };
  const brokerRuntimeManifestContents = `${JSON.stringify(brokerRuntimeManifest, null, 2)}\n`;
  assert.ok(Buffer.byteLength(brokerRuntimeManifestContents) <= 278);
  const brokerRuntimeManifestPath = path.join(populatedWorkspaceRoot, 'package.json');
  await writeFile(brokerRuntimeManifestPath, brokerRuntimeManifestContents.padEnd(278, ' '), 'utf8');
  assert.equal((await stat(brokerRuntimeManifestPath)).size, 278);
  await cp(populatedWorkspaceRoot, inlineRuntimeWorkspaceRoot, { recursive: true });
  await rm(path.join(inlineRuntimeWorkspaceRoot, 'tests'), { recursive: true, force: true });
  const inlineRuntimePackagePath = path.join(inlineRuntimeWorkspaceRoot, 'package.json');
  await writeFile(inlineRuntimePackagePath, brokerRuntimeManifestContents.padEnd(278, ' '), 'utf8');
  await attachSelectedWorkspace(inlineRuntimeWorkspaceRoot);
  const previousRuntimeProjectId = populatedProject.projectId;
  const inlineRuntimeSync = await readBrokerJson(await brokerFetch('/v1/synchronize', {}), 200);
  const inlineRuntimeProject = inlineRuntimeSync.projects.find(
    (project) => project.projectId !== previousRuntimeProjectId,
  );
  assert.ok(inlineRuntimeProject, 'The inline runtime-test workspace must be registered.');
  const inlineRuntimeLease = await acquireLease(inlineRuntimeProject);
  const inlineRuntimeResult = await runDecision(inlineRuntimeLease, 'approve', 'inline_review', {
    userRequest: 'test the project',
    targetWorkspace: inlineRuntimeWorkspaceRoot,
    expectEmptyBeforeApproval: false,
    minimumBadges: 1,
    minimumDiffPreview: 1,
    minimumFilesModified: 2,
  });
  assert.equal(inlineRuntimeResult.result.outcome, 'SUCCESS', JSON.stringify(inlineRuntimeResult.result));
  assert.equal(inlineRuntimeResult.result.executionVerificationReceipt?.status, 'PASSED');
  assert.equal(inlineRuntimeResult.result.hermeticVerification?.passed, 9);
  assert.equal(inlineRuntimeResult.result.hermeticVerification?.total, 9);
  assert.doesNotMatch(inlineRuntimeResult.result.message, /VERIFICATION_UNAVAILABLE|Verification runner was unavailable/i);
  assert.equal(JSON.parse(await readFile(inlineRuntimePackagePath, 'utf8')).scripts.test, 'node tests/order.test.js');
  assert.ok((await stat(path.join(inlineRuntimeWorkspaceRoot, 'tests', 'order.test.js'))).isFile());
  assert.equal(inlineRuntimeResult.pending.executionVerificationReceipt.status, 'PASSED');
  assert.equal(inlineRuntimeResult.pending.hermeticVerification.passed, 9);
  assert.match(inlineRuntimeResult.pending.executionVerificationReceipt.message, /staged project-test candidate/);
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: inlineRuntimeLease.brokerSessionId,
    sessionLeaseToken: inlineRuntimeLease.sessionLeaseToken,
  });
  const helloWorkspaceFixture = path.join(repositoryRoot, 'scripts', 'fixtures', 'hello-runtime-workspace');
  let helloWorkspaceSource = process.env.AI_CODING_HELLO_WORKSPACE
    || path.join(os.homedir(), 'Downloads', 'Hello');
  let helloWorkspaceSourceExists = false;
  try {
    if (!(await stat(helloWorkspaceSource)).isDirectory()) {
      throw new Error(`Hello workspace source is not a directory: ${helloWorkspaceSource}`);
    }
    helloWorkspaceSourceExists = true;
  } catch (error) {
    if (process.env.AI_CODING_HELLO_WORKSPACE) throw error;
    if (error.code !== 'ENOENT') throw error;
    helloWorkspaceSource = helloWorkspaceFixture;
    await stat(helloWorkspaceSource);
    helloWorkspaceSourceExists = true;
  }
  if (helloWorkspaceSourceExists) {
    const sourceManifest = await readFile(path.join(helloWorkspaceSource, 'package.json'), 'utf8');
    let previousHelloProjectId = inlineRuntimeProject.projectId;
    for (const executionMode of ['inline_review', 'autonomous_auto_apply']) {
      const helloCloneWorkspaceRoot = path.join(fixtureRoot, `hello-current-clone-${executionMode}`);
      await cp(helloWorkspaceSource, helloCloneWorkspaceRoot, { recursive: true });
      const cloneManifestPath = path.join(helloCloneWorkspaceRoot, 'package.json');
      await attachSelectedWorkspace(helloCloneWorkspaceRoot);
      const helloSync = await readBrokerJson(await brokerFetch('/v1/synchronize', {}), 200);
      const helloProject = helloSync.projects.find((project) => project.projectId !== previousHelloProjectId);
      assert.ok(helloProject, `The exact Hello clone must be registered for ${executionMode}.`);
      previousHelloProjectId = helloProject.projectId;
      const helloLease = await acquireLease(helloProject);
      const helloWorkflow = await readBrokerJson(await brokerFetch('/v1/workflows', {
        brokerSessionId: helloLease.brokerSessionId,
        sessionLeaseToken: helloLease.sessionLeaseToken,
        userRequest: 'test the project',
        scope: '.',
        executionMode,
      }), 200);
      let helloResult = helloWorkflow;
      if (executionMode === 'inline_review' && helloWorkflow.outcome === 'AWAITING_APPROVAL') {
        assert.equal(helloWorkflow.executionVerificationReceipt?.status, 'PASSED', JSON.stringify(helloWorkflow));
        assert.equal(helloWorkflow.executionVerificationReceipt.behavioralTestSuite.status, 'EXECUTED & PASSED');
        assert.equal(helloWorkflow.hermeticVerification?.passed, 9, JSON.stringify(helloWorkflow));
        assert.match(helloWorkflow.executionVerificationReceipt.message, /staged project-test candidate/);
        assert.match(helloWorkflow.executionVerificationReceipt.message, /EXECUTED & PASSED \(in-process runtime runner\)/);
        assert.match(helloWorkflow.executionVerificationReceipt.message, /Detected Workspace Issues & Readiness Audit/);
        assert.match(helloWorkflow.executionVerificationReceipt.message, /Missing node_modules directory/);
        assert.match(helloWorkflow.executionVerificationReceipt.message, /Missing \.env file/);
        assert.match(helloWorkflow.executionVerificationReceipt.message, /Stale inline UI contract: server\.js/);
        assert.match(helloWorkflow.executionVerificationReceipt.message, /REPAIR server\.js/);
        assert.match(helloWorkflow.executionVerificationReceipt.message, /REVIEW_SYNC routes\/orders\.js/);
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'package.json' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'server.js' && file.byteSize > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'config/db.js' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'models/Order.js' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'controllers/orderController.js' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'routes/orders.js' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'components/OrderForm.jsx' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'app/orders/page.jsx' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === 'tests/order.test.js' && file.lineCount > 0));
        assert.ok(helloWorkflow.inspectedFiles.some((file) => file.path === '.env.example' && file.byteSize > 0));
        assert.ok(helloWorkflow.exploredDirectories.some((directory) => directory.path === 'models'));
        assert.ok(helloWorkflow.engineeringSummary.some((item) => item.phase === 'Runtime contract'));
        assert.match(helloWorkflow.executionVerificationReceipt.message, /Engineering Analysis & Inspected Files:/);
        assert.deepEqual(helloWorkflow.filesModified, []);
        const helloDecision = await readBrokerJson(await brokerFetch('/v1/workflows/approval/decision', {
          brokerSessionId: helloLease.brokerSessionId,
          sessionLeaseToken: helloLease.sessionLeaseToken,
          proposalId: helloWorkflow.approval.proposalId,
          proposalDigest: helloWorkflow.approval.proposalDigest,
          approvalNonce: helloWorkflow.approval.approvalNonce,
          approved: true,
          deleteConfirmed: false,
        }), 200);
        helloResult = helloDecision.result;
      }
      assert.equal(helloResult.outcome, 'SUCCESS', JSON.stringify(helloResult));
      assert.equal(helloResult.executionVerificationReceipt?.status, 'PASSED', JSON.stringify(helloResult));
      assert.equal(helloResult.executionVerificationReceipt.behavioralTestSuite.status, 'EXECUTED & PASSED');
      assert.match(helloResult.executionVerificationReceipt.message, /Detected Workspace Issues & Readiness Audit/);
      assert.equal(helloResult.hermeticVerification?.passed, 9, JSON.stringify(helloResult));
      assert.match(helloResult.message, /verified across 9\/9 hermetic gates/i);
      assert.ok(helloResult.inspectedFiles.some((file) => file.path === 'package.json' && file.lineCount > 0));
      assert.ok(helloResult.inspectedFiles.some((file) => file.path === 'controllers/orderController.js' && file.byteSize > 0));
      assert.ok(helloResult.exploredDirectories.some((directory) => directory.path === 'tests'));
      assert.ok(helloResult.engineeringSummary.some((item) => item.phase === 'Live verification'));
      assert.match(helloResult.message, /GET \/orders interactive form -> 200/);
      assert.ok(helloResult.executionVerificationReceipt.apiProbes.some((probe) => probe.statusCode === 201 && probe.passed));
      assert.ok(helloResult.executionVerificationReceipt.apiProbes.some((probe) => probe.statusCode === 400 && probe.passed));
      assert.ok(helloResult.executionVerificationReceipt.apiProbes.some((probe) => probe.statusCode === 500 && probe.passed));
      assert.equal(helloResult.executionVerificationReceipt.apiProbes.length, 5);
      assert.ok(helloResult.executionVerificationReceipt.apiProbes.every((probe) => probe.applicable && probe.passed));
      assert.equal(helloResult.executionVerificationReceipt.collectionProbe.statusCode, 200);
      assert.ok(helloResult.executionVerificationReceipt.uiProbes.some((probe) => probe.path === '/' && probe.statusCode === 200));
      assert.ok(helloResult.executionVerificationReceipt.uiProbes.some((probe) => probe.path === '/orders' && probe.statusCode === 200));
      assert.equal(await readFile(cloneManifestPath, 'utf8'), sourceManifest);
      assert.equal(await readFile(path.join(helloWorkspaceSource, 'package.json'), 'utf8'), sourceManifest);
      await brokerFetch('/v1/sessions/release', {
        brokerSessionId: helloLease.brokerSessionId,
        sessionLeaseToken: helloLease.sessionLeaseToken,
      });
    }
    console.log('Exact current Hello workspace clone passed project-test verification in inline-review and autonomous modes.');
  }
  await attachSelectedWorkspace(populatedWorkspaceRoot);
  const restoredRuntimeSync = await readBrokerJson(await brokerFetch('/v1/synchronize', {}), 200);
  const restoredRuntimeProject = restoredRuntimeSync.projects.find(
    (project) => project.projectId !== inlineRuntimeProject.projectId,
  );
  assert.ok(restoredRuntimeProject, 'The autonomous runtime-test workspace must be re-registered.');
  const initialBrokerRuntimePlan = await deriveExistingProjectTestPlan(populatedWorkspaceRoot);
  assert.ok(initialBrokerRuntimePlan?.isProjectRuntimeTest);
  const brokerRuntimeModelModule = initialBrokerRuntimePlan.modulesToCreate.find(
    (module) => /(?:^|\/)models\/order\.js$/i.test(module.path),
  );
  assert.ok(brokerRuntimeModelModule, 'The runtime plan must include the workspace Order model.');
  const brokerRuntimeModelPath = path.join(populatedWorkspaceRoot, ...brokerRuntimeModelModule.path.split('/'));
  const brokerRuntimeModel = await readFile(brokerRuntimeModelPath, 'utf8');
  assert.match(brokerRuntimeModel, /return records\.map\(\(record\) => \(\{ \.\.\.record \}\)\);/);
  const degradedBrokerRuntimeModel = brokerRuntimeModel.replace(
    /return records\.map\(\(record\) => \(\{ \.\.\.record \}\)\);/,
    'return [];',
  );
  assert.notEqual(degradedBrokerRuntimeModel, brokerRuntimeModel);
  await writeFile(
    brokerRuntimeModelPath,
    degradedBrokerRuntimeModel,
    'utf8',
  );
  const directBrokerRuntimePlan = await deriveExistingProjectTestPlan(populatedWorkspaceRoot);
  assert.ok(directBrokerRuntimePlan?.isProjectRuntimeTest);
  assert.equal(
    directBrokerRuntimePlan.modulesToCreate.find((module) => module.path === brokerRuntimeModelModule.path).content,
    degradedBrokerRuntimeModel,
  );
  const directBrokerRuntimeVerification = await runHermeticRegressionLoopWithRuntime(
    directBrokerRuntimePlan,
    { root: populatedWorkspaceRoot },
  );
  assert.equal(directBrokerRuntimeVerification.passed, 9, JSON.stringify(directBrokerRuntimeVerification));
  assert.ok(directBrokerRuntimeVerification.regressionLoop.repairs.some((repair) => repair.includes('models/Order.js')));
  const brokerRuntimeLease = await acquireLease(restoredRuntimeProject);
  const brokerRuntimeResult = await runDecision(brokerRuntimeLease, 'autonomous', 'autonomous_auto_apply', {
    userRequest: 'test the project',
    targetWorkspace: populatedWorkspaceRoot,
    minimumFilesModified: 2,
  });
  assert.equal(brokerRuntimeResult.result.outcome, 'SUCCESS', JSON.stringify(brokerRuntimeResult.result));
  assert.equal(brokerRuntimeResult.result.hermeticVerification?.passed, 9);
  assert.equal(brokerRuntimeResult.result.hermeticVerification?.total, 9);
  assert.equal(brokerRuntimeResult.result.hermeticVerification?.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.equal(brokerRuntimeResult.result.executionVerificationReceipt?.status, 'PASSED');
  assert.ok(
    brokerRuntimeResult.result.filesModified.includes(brokerRuntimeModelModule.path),
    `Expected the failed persisted-list module to be repaired: ${JSON.stringify({
      filesModified: brokerRuntimeResult.result.filesModified,
      modelAfter: (await readFile(brokerRuntimeModelPath, 'utf8')).match(/function list\(\) \{[\s\S]*?\n\}/)?.[0],
      taskFiles: brokerRuntimeResult.result.taskPlan?.files?.map((file) => file.path),
      probes: brokerRuntimeResult.result.hermeticVerification?.runtimeVerification?.probes,
      repairs: brokerRuntimeResult.result.hermeticVerification?.regressionLoop?.repairs,
    })}`,
  );
  assert.match(brokerRuntimeResult.result.message, /verified across 9\/9 hermetic gates/);
  assert.match(brokerRuntimeResult.result.message, /POST \/api\/orders -> 201 Created — PASS/);
  assert.match(brokerRuntimeResult.result.message, /GET \/orders interactive form -> 200 — PASS/);
  assert.equal(
    JSON.parse(await readFile(brokerRuntimeManifestPath, 'utf8')).scripts.test,
    'node tests/order.test.js',
  );
  assert.ok((await stat(path.join(populatedWorkspaceRoot, 'tests', 'order.test.js'))).isFile());
  assert.doesNotMatch(brokerRuntimeResult.result.message, /no real test suite beyond a syntax check|No test files are present/i);
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: brokerRuntimeLease.brokerSessionId,
    sessionLeaseToken: brokerRuntimeLease.sessionLeaseToken,
  });
  const brokerRepeatLease = await acquireLease(restoredRuntimeProject);
  const brokerRepeatResult = await runDecision(brokerRepeatLease, 'autonomous', 'autonomous_auto_apply', {
    userRequest: 'est the project',
    targetWorkspace: populatedWorkspaceRoot,
    expectNoChanges: true,
  });
  assert.equal(brokerRepeatResult.result.outcome, 'SUCCESS', JSON.stringify(brokerRepeatResult.result));
  assert.equal(brokerRepeatResult.result.hermeticVerification?.passed, 9);
  assert.equal(brokerRepeatResult.result.executionVerificationReceipt?.status, 'PASSED');
  assert.equal(brokerRepeatResult.result.hermeticVerification.runtimeVerification.executionMode, 'IN_PROCESS_HTTP_LOOPBACK');
  assert.deepEqual(brokerRepeatResult.result.filesModified, []);
  assert.match(brokerRepeatResult.result.message, /verified across 9\/9 hermetic gates/);
  await brokerFetch('/v1/sessions/release', {
    brokerSessionId: brokerRepeatLease.brokerSessionId,
    sessionLeaseToken: brokerRepeatLease.sessionLeaseToken,
  });
  console.log('Populated Windows-style stub workspace passed explicit approval and repeated autonomous workflows through /v1/workflows.');
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
