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

console.log('Dev-server cleanup lifecycle checks passed.');
