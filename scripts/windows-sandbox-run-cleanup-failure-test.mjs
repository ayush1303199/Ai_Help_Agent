import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sandboxRunner from '../electron/coding-pipeline/windowsSandboxRunner.cjs';

const runFailure = new Error('synthetic command failure');
const cleanupFailure = new Error('synthetic cleanup failure');
const combinedFailure = sandboxRunner.combineSandboxRunAndCleanupFailures(runFailure, cleanupFailure);

assert.ok(combinedFailure instanceof AggregateError);
assert.deepEqual(combinedFailure.errors, [runFailure, cleanupFailure]);
assert.equal(combinedFailure.isolationFailure, true);
assert.match(combinedFailure.message, /synthetic command failure/);
assert.match(combinedFailure.message, /synthetic cleanup failure/);

const source = await fs.readFile(
  new URL('../electron/coding-pipeline/windowsSandboxRunner.cjs', import.meta.url),
  'utf8',
);
assert.match(source, /runFailed = true;[\s\S]*?runFailure = error;/);
assert.match(source, /if \(runFailed\) \{\s*throw combineSandboxRunAndCleanupFailures\(runFailure, error\);/);
assert.match(source, /if \(runFailed\) throw runFailure;/);

console.log('Windows Sandbox run and cleanup failure propagation checks passed.');
