import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import modularEngine from '../electron/coding-pipeline/modularArchitectureEngine.cjs';

const require = createRequire(import.meta.url);
const { deriveModularPlan, verifyIntegrationReachability } = modularEngine;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-route-proof-'));
const fixtureName = `Feature${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let server;

try {
  const plan = await deriveModularPlan(root, {
    userRequest: `Build a complete "${fixtureName}" full-stack API feature with backend routes.`,
  });
  assert.ok(plan.routeContracts.length >= 1, 'A generated backend route must carry runtime reachability contracts.');
  for (const module of plan.modulesToCreate) {
    const filePath = path.join(root, ...module.path.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, module.content);
  }
  for (const point of plan.integrationPoints) {
    const filePath = path.join(root, ...point.targetFile.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, point.patchedContent || point.originalContent || '');
  }

  const unprobed = await verifyIntegrationReachability(root, plan);
  assert.equal(unprobed.isValid, false, 'Static files alone cannot establish live route reachability.');
  assert.match(unprobed.rejectionReason, /Live route reachability is unverified/);

  server = http.createServer((request, response) => {
    const contract = plan.routeContracts.find((route) => (
      route.method === request.method && route.path === request.url
    ));
    if (!contract) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(request.method === 'POST' ? 201 : 200).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const reachable = await verifyIntegrationReachability(root, plan, {
    probeRoute: async ({ method, path: routePath }) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${routePath}`, { method });
      return { executed: true, status: response.status };
    },
  });
  assert.equal(reachable.isValid, true, JSON.stringify(reachable));

  const missing = await verifyIntegrationReachability(root, plan, {
    probeRoute: async () => ({ executed: true, status: 404 }),
  });
  assert.equal(missing.isValid, false);
  assert.match(missing.rejectionReason, /returned 404/);

  const forgedObservation = await verifyIntegrationReachability(root, plan, {
    probeRoute: async () => ({ executed: false, status: 201 }),
  });
  assert.equal(forgedObservation.isValid, false, 'Unexecuted status claims must not prove reachability.');

  const dynamicRoot = path.join(root, 'dynamic-full-stack');
  await fs.mkdir(dynamicRoot);
  const resource = `resource-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const routePath = `/api/${resource}`;
  const dynamicPlan = await deriveModularPlan(dynamicRoot, {
    userRequest: `Build a full-stack application with the endpoint POST ${routePath}.\nFields:\n- displayName: string (required)\n- quantity: number (default=1)\nProvide a frontend form UI.`,
  });
  assert.equal(dynamicPlan.routeContracts.length, 1);
  assert.equal(dynamicPlan.routeContracts[0].method, 'POST');
  assert.equal(dynamicPlan.routeContracts[0].path, routePath);
  assert.deepEqual(dynamicPlan.routeSchema.fields.map(({ name, type, required }) => ({ name, type, required })), [
    { name: 'displayName', type: 'string', required: true },
    { name: 'quantity', type: 'number', required: false },
  ]);
  for (const module of dynamicPlan.modulesToCreate) {
    const filePath = path.join(dynamicRoot, ...module.path.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, module.content);
  }
  const staticMount = await verifyIntegrationReachability(dynamicRoot, dynamicPlan);
  assert.equal(staticMount.isValid, true, JSON.stringify(staticMount));
  assert.equal(staticMount.routeMounts[0].status, 'PASS');
  const { createApplication } = require(path.join(dynamicRoot, 'server.js'));
  const generatedServer = createApplication();
  await new Promise((resolve, reject) => {
    generatedServer.once('error', reject);
    generatedServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = generatedServer.address();
    const created = await fetch(`http://127.0.0.1:${address.port}${routePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'demo' }),
    });
    assert.equal(created.status, 201);
    const invalid = await fetch(`http://127.0.0.1:${address.port}${routePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);
    const missing = await fetch(`http://127.0.0.1:${address.port}/not-registered`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => generatedServer.close(resolve));
  }
  await assert.rejects(
    deriveModularPlan(root, {
      explicitPlan: {
        routeContracts: [{
          method: 'GET',
          path: '/%2e%2e/outside',
          targetFile: plan.routeContracts[0].targetFile,
        }],
      },
    }),
    /Route path must be an origin-relative path/,
  );
  console.log('Route reachability gate tests passed (dynamic paths; real local HTTP probe plus fail-closed cases).');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
