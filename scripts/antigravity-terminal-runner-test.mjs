import assert from 'node:assert/strict';
import runnerModule from '../electron/coding-pipeline/antigravityTerminalRunner.cjs';

const { createAntigravityTerminalRunner } = runnerModule;
const permitted = new Set(['test', 'typecheck', 'build']);
const executed = [];
const runner = createAntigravityTerminalRunner({
  commandPolicy(script) {
    if (!permitted.has(script)) throw new Error('Verification command is not permitted.');
    return { script, approvalRequired: true, arbitraryShell: false };
  },
  async runVerification(script, owner, options) {
    executed.push({ script, owner, options });
    return {
      ok: false,
      exitCode: 1,
      executed: true,
      stdout: '',
      stderr: `src/${script}.ts:17:4 - error TS1005: missing token`,
    };
  },
});

const failed = await runner.runCheck('typecheck', 8107, { scope: 'src' });
assert.equal(failed.ok, false);
assert.equal(failed.exitCode, 1);
assert.deepEqual(failed.diagnostics, [{
  file: 'src/typecheck.ts',
  line: 17,
  column: 4,
  category: 'failure',
  message: 'error TS1005: missing token',
}]);
assert.equal(executed.length, 1);
assert.equal(executed[0].owner, 8107);
assert.equal(executed[0].options.scope, 'src');

await assert.rejects(runner.runCheck('test && arbitrary-command', 8107), /not permitted/);
assert.equal(executed.length, 1, 'Rejected commands must never reach the trusted executor.');

const cancelled = await runner.runCheck('test', 8107, { isCancelled: () => true });
assert.equal(cancelled.cancelled, true);
assert.equal(cancelled.executed, false);
assert.equal(executed.length, 1, 'Cancelled runs must not spawn a child process.');

const malformedRunner = createAntigravityTerminalRunner({
  runVerification: async () => ({ ok: true }),
  commandPolicy: () => ({ script: 'test', arbitraryShell: true }),
});
await assert.rejects(malformedRunner.runCheck('test', 8107), /exact allow-listed command/);

console.log('Antigravity terminal runner policy and diagnostics tests passed (executor mocked; process isolation remains in developerFiles).');
