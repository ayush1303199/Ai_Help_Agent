import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
