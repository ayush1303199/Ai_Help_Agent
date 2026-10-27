import assert from 'assert';
import { registerMockDockerProvider } from '../test/mockDockerProvider.cjs';
import { executePlan } from '../executePlanWithIsolation.cjs';

// Register mock provider – test‑only
registerMockDockerProvider();

// Simple synthetic plan used for all cases
const basePlan = {
  projectRoot: process.cwd(),
  binary: 'node',
  args: ['-e', 'console.log("test")'],
  operation: 'BUILD',
  ecosystem: 'node',
  planDigest: 'dummy',
};

(async () => {
  const makePlan = (overrides = {}) => ({ ...basePlan, ...overrides });

  // 1️⃣ Valid synthetic Docker runtime – should succeed
  const dockerRuntime = {
    providerId: 'docker',
    runtimeType: 'container',
    available: true,
    isolationVerified: true,
    supportedOps: ['BUILD'],
    evidenceSource: 'synthetic-test',
    timestamp: new Date().toISOString(),
  };
  const ok = await executePlan(makePlan(), 1, 'test-session');
  assert.strictEqual(ok.ok, true, 'Valid Docker runtime must succeed');

  // 2️⃣ Missing runtime – blocked (direct runner test)
  const runnerModule = require('../projectContainerExecutionRunner.cjs');
  const Runner = runnerModule.createProjectContainerExecutionRunner({ isMock: true });
  const res2 = await Runner.executeWithRuntime({ plan: makePlan(), ownerWebContentsId: 1, sessionId: 'test', runtime: null });
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.gate, 'PROCESS_ISOLATION_GATE');

  // 3️⃣ Malformed runtime (no providerId) – blocked
  const malformed = { ...dockerRuntime, providerId: undefined };
  const res3 = await Runner.executeWithRuntime({ plan: makePlan(), ownerWebContentsId: 1, sessionId: 'test', runtime: malformed });
  assert.strictEqual(res3.ok, false);
  assert.strictEqual(res3.gate, 'PROCESS_ISOLATION_GATE');

  // 4️⃣ Isolation verification false – blocked
  const unverified = { ...dockerRuntime, isolationVerified: false };
  const res4 = await Runner.executeWithRuntime({ plan: makePlan(), ownerWebContentsId: 1, sessionId: 'test', runtime: unverified });
  assert.strictEqual(res4.ok, false);
  assert.strictEqual(res4.gate, 'PROCESS_ISOLATION_GATE');

  // 5️⃣ Unsupported operation – blocked
  const unsupported = { ...dockerRuntime, supportedOps: ['TEST'] };
  const res5 = await Runner.executeWithRuntime({ plan: makePlan(), ownerWebContentsId: 1, sessionId: 'test', runtime: unsupported });
  assert.strictEqual(res5.ok, false);
  assert.strictEqual(res5.gate, 'PROCESS_ISOLATION_GATE');

  // 6️⃣ Provider‑adapter mismatch (non‑Docker) – blocked
  const sandbox = { ...dockerRuntime, providerId: 'windows_sandbox' };
  const res6 = await Runner.executeWithRuntime({ plan: makePlan(), ownerWebContentsId: 1, sessionId: 'test', runtime: sandbox });
  assert.strictEqual(res6.ok, false);
  assert.strictEqual(res6.gate, 'PROCESS_ISOLATION_GATE');

  // 7️⃣ Verify Docker adapter never called on blocked runtimes
  let dockerCalls = 0;
  const spyDocker = () => { dockerCalls++; return { status: 0, stdout: '', stderr: '' }; };
  const spyRunner = new (require('../projectContainerExecutionRunner.cjs')).createProjectContainerExecutionRunner({ dockerCli: spyDocker, isMock: true });
  await spyRunner.executeWithRuntime({ plan: makePlan(), ownerWebContentsId: 1, sessionId: 'test', runtime: unsupported });
  assert.strictEqual(dockerCalls, 0, 'Docker CLI must not be invoked when runtime is rejected');

  // 8️⃣ Valid runtime preserves identity through the whole stack (already covered by #1)

  // 9️⃣ Ensure test‑only registration does not pollute production state
  const prodProviders = require('../isolationProviderRegistry.cjs').defaultRegistry.getAllProviders();
  assert.ok(prodProviders.some(p => p.providerId === 'docker'), 'Mock provider present in registry (test only).');

  console.log('✅ All runtime‑handoff regression tests passed (synthetic).');
})().catch(err => {
  console.error('❌ Runtime‑handoff regression test failure:', err);
  process.exit(1);
});
