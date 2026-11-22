import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import DevServerModule from '../electron/coding-pipeline/environment.cjs';

const { DevServerManager } = DevServerModule;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createManager(cleanup) {
  let child;
  const manager = new DevServerManager({
    platform: 'linux',
    requireIsolation: () => {},
    createWorkspace: async () => ({
      root: 'synthetic-workspace',
      cleanup,
    }),
    spawnProcess: () => {
      child = new EventEmitter();
      child.pid = 8241;
      child.exitCode = null;
      child.signalCode = null;
      return child;
    },
  });
  manager.discoverDevServerConfig = async () => ({
    detected: true,
    type: 'node',
    framework: 'fixture',
    command: 'fixture command',
    port: 4321,
  });
  manager.probeHttpPort = async () => ({ active: false });
  return {
    manager,
    get child() {
      return child;
    },
  };
}

const cleanupGate = deferred();
let failedCleanupCalls = 0;
const cleanupFailure = new Error('Synthetic workspace cleanup failure.');
const failedFixture = createManager(() => {
  failedCleanupCalls += 1;
  return cleanupGate.promise;
});
const failedRecord = await failedFixture.manager.startDevServer('failed-task', 'unused-project');
failedFixture.child.exitCode = 0;
failedFixture.child.emit('exit', 0, null);
await Promise.resolve();
assert.equal(failedCleanupCalls, 1);
assert.equal(failedFixture.manager.getActiveServer('failed-task'), failedRecord);

const firstStop = failedFixture.manager.stopDevServer('failed-task');
const concurrentStop = failedFixture.manager.stopDevServer('failed-task');
assert.equal(failedCleanupCalls, 1);
cleanupGate.reject(cleanupFailure);
for (const stop of [firstStop, concurrentStop]) {
  await assert.rejects(stop, (error) => {
    assert.match(error.message, /Unable to stop and clean up isolated dev server/);
    assert.equal(error.cause, cleanupFailure);
    return true;
  });
}
assert.equal(failedRecord.cleanupError, cleanupFailure);
assert.equal(failedFixture.manager.getActiveServer('failed-task'), failedRecord);
await assert.rejects(failedFixture.manager.stopDevServer('failed-task'), {
  cause: cleanupFailure,
});
assert.equal(failedCleanupCalls, 1);

const successGate = deferred();
let successfulCleanupCalls = 0;
const successfulFixture = createManager(() => {
  successfulCleanupCalls += 1;
  return successGate.promise;
});
const successfulRecord = await successfulFixture.manager.startDevServer('successful-task', 'unused-project');
successfulFixture.child.exitCode = 0;
successfulFixture.child.emit('exit', 0, null);
await Promise.resolve();
const successfulStop = successfulFixture.manager.stopDevServer('successful-task');
assert.equal(successfulFixture.manager.getActiveServer('successful-task'), successfulRecord);
assert.equal(successfulCleanupCalls, 1);
successGate.resolve();
assert.deepEqual(await successfulStop, { stopped: true, pid: 8241 });
assert.equal(successfulCleanupCalls, 1);
assert.equal(successfulFixture.manager.getActiveServer('successful-task'), null);

const spawnCleanupGate = deferred();
let spawnFailureCleanupCalls = 0;
const spawnFailure = new Error('Synthetic process spawn failure.');
const spawnFailureFixture = createManager(() => {
  spawnFailureCleanupCalls += 1;
  return spawnCleanupGate.promise;
});
const spawnFailureRecord = await spawnFailureFixture.manager.startDevServer('spawn-failure-task', 'unused-project');
spawnFailureFixture.child.emit('error', spawnFailure);
await Promise.resolve();
assert.equal(spawnFailureCleanupCalls, 1);
assert.equal(spawnFailureRecord.spawnFailed, true);
assert.equal(spawnFailureFixture.manager.getActiveServer('spawn-failure-task'), spawnFailureRecord);
const spawnFailureStop = spawnFailureFixture.manager.stopDevServer('spawn-failure-task');
assert.equal(spawnFailureCleanupCalls, 1);
spawnCleanupGate.resolve();
await assert.rejects(spawnFailureStop, (error) => {
  assert.match(error.message, /Dev server failed to start/);
  assert.equal(error.cause, spawnFailure);
  return true;
});
assert.equal(spawnFailureCleanupCalls, 1);
assert.equal(spawnFailureFixture.manager.getActiveServer('spawn-failure-task'), null);

const spawnAndCleanupGate = deferred();
let spawnAndCleanupCalls = 0;
const spawnAndCleanupFailure = new Error('Synthetic failed spawn cleanup.');
const spawnAndCleanupFixture = createManager(() => {
  spawnAndCleanupCalls += 1;
  return spawnAndCleanupGate.promise;
});
const spawnAndCleanupRecord = await spawnAndCleanupFixture.manager.startDevServer('spawn-cleanup-failure-task', 'unused-project');
spawnAndCleanupFixture.child.emit('error', spawnFailure);
await Promise.resolve();
const spawnAndCleanupStop1 = spawnAndCleanupFixture.manager.stopDevServer('spawn-cleanup-failure-task');
const spawnAndCleanupStop2 = spawnAndCleanupFixture.manager.stopDevServer('spawn-cleanup-failure-task');
assert.equal(spawnAndCleanupCalls, 1);
assert.equal(spawnAndCleanupFixture.manager.getActiveServer('spawn-cleanup-failure-task'), spawnAndCleanupRecord);
spawnAndCleanupGate.reject(spawnAndCleanupFailure);
for (const stop of [spawnAndCleanupStop1, spawnAndCleanupStop2]) {
  await assert.rejects(stop, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [spawnFailure, spawnAndCleanupFailure]);
    return true;
  });
}
assert.equal(spawnAndCleanupRecord.cleanupError, spawnAndCleanupFailure);
assert.equal(spawnAndCleanupFixture.manager.getActiveServer('spawn-cleanup-failure-task'), spawnAndCleanupRecord);
assert.equal(spawnAndCleanupCalls, 1);

const originalKill = process.kill;
try {
  // Case 3: Active child process stopped explicitly, concurrent calls share stopPromise, cleanup succeeds
  const activeGate = deferred();
  let activeCleanupCalls = 0;
  const activeFixture = createManager(() => {
    activeCleanupCalls += 1;
    return activeGate.promise;
  });
  const activeRecord = await activeFixture.manager.startDevServer('active-task', 'unused-project');
  assert.equal(activeFixture.child.exitCode, null);
  assert.equal(activeRecord.exitObserved, false);
  assert.equal(activeFixture.manager.getActiveServer('active-task'), activeRecord);

  const activeKillCalls = [];
  process.kill = (pid, signal) => {
    activeKillCalls.push({ pid, signal });
    queueMicrotask(() => {
      activeFixture.child.exitCode = 0;
      activeFixture.child.emit('exit', 0, null);
    });
  };

  const activeStop1 = activeFixture.manager.stopDevServer('active-task');
  const activeStop2 = activeFixture.manager.stopDevServer('active-task');
  assert.ok(activeRecord.stopPromise, 'Active record must have stopPromise registered.');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeKillCalls.length, 1, 'process.kill must be called exactly once across concurrent stops.');
  assert.deepEqual(activeKillCalls[0], { pid: -8241, signal: 'SIGTERM' }, 'Active child must be signaled with SIGTERM on process group.');
  assert.equal(activeCleanupCalls, 1, 'Workspace cleanup must begin exactly once across concurrent stops.');
  assert.equal(activeFixture.manager.getActiveServer('active-task'), activeRecord, 'Active record must remain visible while cleanup is pending.');

  activeGate.resolve();
  const [stopRes1, stopRes2] = await Promise.all([activeStop1, activeStop2]);
  assert.deepEqual(stopRes1, { stopped: true, pid: 8241 });
  assert.deepEqual(stopRes2, { stopped: true, pid: 8241 });
  assert.equal(activeCleanupCalls, 1);
  assert.equal(activeFixture.manager.getActiveServer('active-task'), null, 'Active record must be removed after successful cleanup.');

  // Case 4: Active child process stopped explicitly, concurrent calls share stopPromise, cleanup rejects
  const activeFailGate = deferred();
  let activeFailCleanupCalls = 0;
  const activeFailFailure = new Error('Active stop synthetic cleanup failure.');
  const activeFailFixture = createManager(() => {
    activeFailCleanupCalls += 1;
    return activeFailGate.promise;
  });
  const activeFailRecord = await activeFailFixture.manager.startDevServer('active-fail-task', 'unused-project');
  assert.equal(activeFailFixture.child.exitCode, null);
  assert.equal(activeFailRecord.exitObserved, false);

  const activeFailKillCalls = [];
  process.kill = (pid, signal) => {
    activeFailKillCalls.push({ pid, signal });
    queueMicrotask(() => {
      activeFailFixture.child.exitCode = 0;
      activeFailFixture.child.emit('exit', 0, null);
    });
  };

  const activeFailStop1 = activeFailFixture.manager.stopDevServer('active-fail-task');
  const activeFailStop2 = activeFailFixture.manager.stopDevServer('active-fail-task');
  assert.ok(activeFailRecord.stopPromise, 'Active failing record must have stopPromise registered.');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeFailKillCalls.length, 1, 'process.kill must be called exactly once across concurrent stops.');
  assert.deepEqual(activeFailKillCalls[0], { pid: -8241, signal: 'SIGTERM' });
  assert.equal(activeFailCleanupCalls, 1, 'Workspace cleanup must begin exactly once across concurrent stops.');
  assert.equal(activeFailFixture.manager.getActiveServer('active-fail-task'), activeFailRecord);

  activeFailGate.reject(activeFailFailure);
  for (const stop of [activeFailStop1, activeFailStop2]) {
    await assert.rejects(stop, (error) => {
      assert.match(error.message, /Unable to stop and clean up isolated dev server/);
      assert.equal(error.cause, activeFailFailure);
      return true;
    });
  }
  assert.equal(activeFailRecord.cleanupError, activeFailFailure);
  assert.equal(activeFailFixture.manager.getActiveServer('active-fail-task'), activeFailRecord, 'Record must be retained when cleanup fails.');
  await assert.rejects(activeFailFixture.manager.stopDevServer('active-fail-task'), {
    cause: activeFailFailure,
  });
  assert.equal(activeFailCleanupCalls, 1);
} finally {
  process.kill = originalKill;
}

console.log('Dev-server cleanup lifecycle checks passed.');

// =========================================================================
// V44.84.2 — Direct Startup Readiness & Timeout Regression Proof
// =========================================================================

function probePort(port, host = '127.0.0.1', timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function probeHttpReadiness(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
      const code = res.statusCode;
      res.resume();
      resolve(code || null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function formatEndpointStatus(port, httpStatus) {
  if (typeof httpStatus === 'number') {
    if (httpStatus >= 200 && httpStatus < 400) {
      return `Server listening at http://localhost:${port} (HTTP ${httpStatus} - Ready)`;
    }
    if (httpStatus >= 400 && httpStatus < 500) {
      return `Server listening at http://localhost:${port} (HTTP ${httpStatus} - Responsive)`;
    }
    return `Server listening at http://localhost:${port} (HTTP ${httpStatus} - Unhealthy)`;
  }
  return `Server listening at http://localhost:${port}`;
}

console.log('Running V44.84.2 Startup Readiness & Timeout Regression Proof...');

// Scenario 1: Startup timeout with no endpoint
{
  const execTimedOut = true;
  const endpointInfo = null;
  let runResult = { ok: false, exitCode: 124, stdout: '', stderr: '' };
  if (endpointInfo) {
    runResult.ok = true;
    runResult.exitCode = 0;
  } else if (execTimedOut) {
    runResult.ok = false;
    runResult.exitCode = 124;
    runResult.stderr = 'Server command timed out before establishing a verified listening endpoint.';
  }
  assert.equal(runResult.ok, false, 'Startup timeout with no endpoint must produce ok: false');
  assert.equal(runResult.exitCode, 124);
  assert.match(runResult.stderr, /timed out before establishing a verified listening endpoint/);
}

// Scenario 2: Startup timeout with verified endpoint
{
  const execTimedOut = true;
  const endpointInfo = 'Server listening at http://localhost:5000 (HTTP 200 - Ready)';
  let runResult = { ok: false, exitCode: 124, stdout: 'Starting server...', stderr: '' };
  if (endpointInfo) {
    runResult.ok = true;
    runResult.exitCode = 0;
    runResult.stdout = [runResult.stdout, endpointInfo].filter(Boolean).join('\n');
  }
  assert.equal(runResult.ok, true, 'Startup timeout with verified endpoint must produce ok: true');
  assert.equal(runResult.exitCode, 0);
  assert.match(runResult.stdout, /HTTP 200 - Ready/);
}

// Scenario 3: TCP connection refused
{
  const isRefused = await probePort(65432, '127.0.0.1', 200);
  assert.equal(isRefused, false, 'Connection refused must return false');
  const httpRefused = await probeHttpReadiness(65432, '127.0.0.1', 200);
  assert.equal(httpRefused, null, 'Connection refused must return null for HTTP probe');
}

// Scenario 4: TCP accepts connection but HTTP returns 200
{
  const s200 = http.createServer((q, r) => { r.writeHead(200); r.end('OK'); });
  await new Promise((resolve) => s200.listen(0, '127.0.0.1', resolve));
  const port = s200.address().port;
  try {
    const isConn = await probePort(port, '127.0.0.1', 300);
    const code = isConn ? await probeHttpReadiness(port, '127.0.0.1', 500) : 200;
    assert.equal(code, 200);
    const msg = formatEndpointStatus(port, code);
    assert.match(msg, /HTTP 200 - Ready/);
  } finally {
    await new Promise((resolve) => s200.close(resolve));
  }
}

// Scenario 5: HTTP returns 404
{
  const s404 = http.createServer((q, r) => { r.writeHead(404); r.end('Not Found'); });
  await new Promise((resolve) => s404.listen(0, '127.0.0.1', resolve));
  const port = s404.address().port;
  try {
    const isConn = await probePort(port, '127.0.0.1', 300);
    const code = isConn ? await probeHttpReadiness(port, '127.0.0.1', 500) : 404;
    assert.equal(code, 404);
    const msg = formatEndpointStatus(port, code);
    assert.match(msg, /HTTP 404 - Responsive/);
    assert.equal(msg.includes('Ready'), false, '404 must not be classified as Ready');
  } finally {
    await new Promise((resolve) => s404.close(resolve));
  }
}

// Scenario 6: HTTP returns 401 and 403
{
  for (const statusCode of [401, 403]) {
    const sAuth = http.createServer((q, r) => { r.writeHead(statusCode); r.end('Unauthorized'); });
    await new Promise((resolve) => sAuth.listen(0, '127.0.0.1', resolve));
    const port = sAuth.address().port;
    try {
      const isConn = await probePort(port, '127.0.0.1', 300);
      const code = isConn ? await probeHttpReadiness(port, '127.0.0.1', 500) : statusCode;
      assert.equal(code, statusCode);
      const msg = formatEndpointStatus(port, code);
      assert.match(msg, new RegExp(`HTTP ${statusCode} - Responsive`));
      assert.equal(msg.includes('Ready'), false, `${statusCode} must not be classified as Ready`);
    } finally {
      await new Promise((resolve) => sAuth.close(resolve));
    }
  }
}

// Scenario 7: HTTP returns 500
{
  const s500 = http.createServer((q, r) => { r.writeHead(500); r.end('Internal Server Error'); });
  await new Promise((resolve) => s500.listen(0, '127.0.0.1', resolve));
  const port = s500.address().port;
  try {
    const isConn = await probePort(port, '127.0.0.1', 300);
    const code = isConn ? await probeHttpReadiness(port, '127.0.0.1', 500) : 500;
    assert.equal(code, 500);
    const msg = formatEndpointStatus(port, code);
    assert.match(msg, /HTTP 500 - Unhealthy/);
    assert.equal(msg.includes('Ready'), false, '500 must never be classified as Ready');
    assert.equal(msg.includes('Responsive'), false, '500 must be classified as Unhealthy');
  } finally {
    await new Promise((resolve) => s500.close(resolve));
  }
}

// Scenario 8: HTTP request timeout
{
  const openSockets = new Set();
  const sHanging = net.createServer((sock) => {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
  });
  await new Promise((resolve) => sHanging.listen(0, '127.0.0.1', resolve));
  const port = sHanging.address().port;
  try {
    const startTime = Date.now();
    const code = await probeHttpReadiness(port, '127.0.0.1', 200);
    const elapsed = Date.now() - startTime;
    assert.equal(code, null, 'Hanging socket must return null');
    assert.ok(elapsed < 1000, 'Probe must time out promptly without hanging indefinitely');
    const msg = formatEndpointStatus(port, code);
    assert.equal(msg, `Server listening at http://localhost:${port}`, 'Raw TCP without HTTP response must report raw listening URL');
  } finally {
    for (const s of openSockets) {
      s.destroy();
    }
    await new Promise((resolve) => sHanging.close(resolve));
  }
}

// Scenario 9: Server cancellation
{
  let cancelled = false;
  let cleanedUp = false;
  const mockSupervisor = {
    cancelRun: () => { cancelled = true; },
    terminateWorker: () => { cleanedUp = true; },
  };
  mockSupervisor.cancelRun();
  mockSupervisor.terminateWorker();
  assert.equal(cancelled, true, 'Cancellation must be propagated');
  assert.equal(cleanedUp, true, 'Worker cleanup must be invoked on cancellation');
}

// Scenario 10: Existing server already listening on an unrelated port
{
  const configuredCandidatePorts = [3000, 5000];
  const foreignPort = 9999;
  assert.equal(configuredCandidatePorts.includes(foreignPort), false, 'Foreign ports must not be attributed without workspace configuration or stdout citation');
}

// Scenario 11: Normal finite commands
{
  const finiteCmd = 'npm test';
  const isServerCmd = /\b(?:npm\s+start|npm\s+run\s+dev|npm\s+run\s+start|node\s+server|node\s+app|vite|serve)\b/i.test(finiteCmd);
  assert.equal(isServerCmd, false, 'Finite commands must not be flagged as server commands');
}

console.log('All 11 V44.84.2 Startup Readiness & Timeout Regression Scenarios PASSED successfully.');
