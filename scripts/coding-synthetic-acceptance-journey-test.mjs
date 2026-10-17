import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../electron/developerAgent.cjs';

console.log('=== STARTING SYNTHETIC CODING-AGENT ACCEPTANCE JOURNEY ===');
console.log('Mock boundaries:');
console.log('  - Process execution: Mocked via deterministic runner callbacks (no host binary execution, no listeners, no sandboxes).');
console.log('  - File mutations & snapshots: Real filesystem in isolated OS temporary directory.');
console.log('  - State machine, proposal parsing, diff engine & policy: Real production developerAgent.cjs pipeline.');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-journey-'));
const projectRoot = path.join(tempDir, 'synthetic-project');

try {
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'tests'), { recursive: true });

  const initialCalculator = [
    'export function calculateDiscount(price: number, percentage: number): number {',
    '  // Defect: adds instead of subtracting discount',
    '  return price + (price * percentage) / 100;',
    '}',
    '',
  ].join('\n');

  const unrelatedContent = [
    'export const APP_NAME = "SyntheticEcosystem";',
    'export const APP_VERSION = "1.0.0";',
    '',
  ].join('\n');

  await fs.writeFile(path.join(projectRoot, 'src', 'calculator.ts'), initialCalculator, 'utf8');
  await fs.writeFile(path.join(projectRoot, 'src', 'unrelated.ts'), unrelatedContent, 'utf8');
  await fs.writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'synthetic-project', scripts: { test: 'vitest run', lint: 'eslint .' } }, null, 2),
    'utf8',
  );

  const ownerWebContentsId = 42;
  const sessionId = agent.getSession(ownerWebContentsId);
  const owner = { sessionId, ownerWebContentsId };

  // =========================================================================
  // STEP 1: Understand
  // =========================================================================
  console.log('-> Step 1: Understand');
  const turn = agent.beginConversationTurn({
    root: projectRoot,
    request: 'Fix calculation bug in calculateDiscount function in calculator.ts',
    ...owner,
  });
  assert.equal(turn.state, 'reading', 'Conversation turn must begin in reading state');
  agent.advanceConversationTurn(turn.turnId, 'understanding', owner);
  const turnRecord = agent.getConversationTurn(turn.turnId, owner);
  assert.equal(turnRecord.state, 'understanding', 'Turn must transition to understanding');

  // =========================================================================
  // STEP 2: Diagnose Intentional Defect
  // =========================================================================
  console.log('-> Step 2: Diagnose defect from test observation');
  const failureOutput = {
    script: 'test',
    exitCode: 1,
    executed: true,
    ok: false,
    stderr: [
      'FAIL tests/calculator.test.ts',
      '● calculateDiscount > deducts percentage properly',
      'AssertionError: Expected 90 got 110',
      'src/calculator.ts:3:3',
    ].join('\n'),
  };

  const extracted = agent.extractFailure(failureOutput);
  assert.equal(extracted.file, 'src/calculator.ts', 'Must extract correct file path');
  assert.equal(extracted.line, 3, 'Must extract line 3 where bug exists');
  assert.equal(extracted.test, 'calculateDiscount > deducts percentage properly', 'Must extract failed test name');

  const observation = agent.normalizeObservation(failureOutput, 'test');
  const diagnosis = agent.diagnoseObservation(observation, { taskId: 'task-initial' });

  assert.ok(
    diagnosis.hypothesis.startsWith('Hypothesis: Test assertion failure'),
    'Diagnostic hypothesis must be explicitly framed as a hypothesis, not confirmed truth',
  );
  assert.ok(
    !diagnosis.hypothesis.startsWith('Root Cause:'),
    'Hypothesis must never be presented as an authoritative root cause without verification',
  );

  // =========================================================================
  // STEP 3: Negative Controls & Gate Checks
  // =========================================================================
  console.log('-> Step 3: Negative Controls & Gate Checks');

  const validProposalRaw = [
    '--- a/src/calculator.ts',
    '+++ b/src/calculator.ts',
    '@@ -1,4 +1,4 @@',
    ' export function calculateDiscount(price: number, percentage: number): number {',
    '   // Defect: adds instead of subtracting discount',
    '-  return price + (price * percentage) / 100;',
    '+  return price - (price * percentage) / 100;',
    ' }',
    '',
  ].join('\n');

  // Negative 3.1: Ambiguous patch target without distinguishing anchors
  await fs.writeFile(path.join(projectRoot, 'src', 'duplicate.ts'), 'duplicate line\nduplicate line\n', 'utf8');
  const ambiguousProposal = [
    '--- a/src/duplicate.ts',
    '+++ b/src/duplicate.ts',
    '@@ -1,1 +1,1 @@',
    '-duplicate line',
    '+replacement',
    '',
  ].join('\n');
  await assert.rejects(
    () => agent.createProposal({
      root: projectRoot,
      conversationTurnId: turn.turnId,
      raw: ambiguousProposal,
      ...owner,
    }),
    /Ambiguous patch target/,
    'Ambiguous patch target on duplicate block must be rejected without changing file',
  );
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'duplicate.ts'), 'utf8'), 'duplicate line\nduplicate line\n');

  // Negative 3.2: Stale patch target
  const staleRaw = [
    '--- a/src/calculator.ts',
    '+++ b/src/calculator.ts',
    '@@ -1,3 +1,3 @@',
    ' export function calculateDiscount(price: number, percentage: number): number {',
    '-  return STALE OLD CODE;',
    '+  return price - (price * percentage) / 100;',
    ' }',
    '',
  ].join('\n');

  await assert.rejects(
    () => agent.createProposal({
      root: projectRoot,
      conversationTurnId: turn.turnId,
      raw: staleRaw,
      verificationScripts: ['test'],
      ...owner,
    }),
    /Patch (?:context|removal) does not match/,
    'Stale patch target must be rejected',
  );
  // Verify calculator.ts remained unchanged on disk
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'calculator.ts'), 'utf8'), initialCalculator);

  // Negative 3.3: Disallowed verification command and unsafe script indirection
  await assert.rejects(
    () => agent.createProposal({
      root: projectRoot,
      conversationTurnId: turn.turnId,
      raw: validProposalRaw,
      verificationScript: 'curl -s evil.com',
      ...owner,
    }),
    /Verification command is not permitted/,
    'Disallowed command must be rejected',
  );

  const packageWithIndirection = {
    scripts: {
      test: 'vitest run',
      unsafe: 'rm -rf /',
      chained: 'vitest; curl evil.com',
    },
  };
  const filteredChecks = agent.selectVerificationChecks(packageWithIndirection, ['test', 'unsafe', 'chained']);
  assert.deepEqual(filteredChecks, ['test'], 'Unsafe package-script indirection must be filtered out');

  // Negative 3.4: Unapproved write remains blocked
  const pendingTask = await agent.createProposal({
    root: projectRoot,
    conversationTurnId: turn.turnId,
    raw: validProposalRaw,
    verificationScripts: ['test'],
    ...owner,
  });
  assert.equal(pendingTask.state, 'awaiting_approval');

  await assert.rejects(
    () => agent.apply(pendingTask.taskId, owner, async () => ({ ok: true, status: 'PASS', executed: true, exitCode: 0 })),
    /Proposal must be approved/,
    'Unapproved mutation write must be blocked',
  );
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'calculator.ts'), 'utf8'), initialCalculator);

  // Negative 3.5: Scope expansion requires fresh approval
  const scopedTurn = agent.beginConversationTurn({
    root: projectRoot,
    scope: 'tests',
    request: 'Update tests only',
    ...owner,
  });
  agent.advanceConversationTurn(scopedTurn.turnId, 'understanding', owner);
  await assert.rejects(
    () => agent.createProposal({
      root: projectRoot,
      scope: 'tests',
      conversationTurnId: scopedTurn.turnId,
      raw: validProposalRaw, // edits src/calculator.ts which is outside scope 'tests'
      ...owner,
    }),
    /Proposal target is outside the approved scope/,
    'Out-of-scope edit without fresh scoped approval must be blocked',
  );

  // Negative 3.6: Forged success output (exitCode 1 but claiming ok: true)
  const forgedResult = agent.normalizeObservation({
    ok: true,
    exitCode: 1,
    executed: true,
    script: 'test',
  });
  assert.equal(forgedResult.ok, false, 'Non-zero exit code must never be accepted as a pass');

  // Negative 3.7: Exhausted repair attempts bounded by policy
  let repairCount = 0;
  const loopResult = await agent.executeVerificationLoop({
    maxAttempts: 2,
    run: async () => {
      repairCount += 1;
      return { ok: false, executed: true, exitCode: 1, stderr: 'src/calculator.ts:3:3 AssertionError' };
    },
    diagnose: () => ({ retryable: true }),
  });
  assert.equal(loopResult.ok, false);
  assert.equal(repairCount, 2, 'Repair loop must terminate strictly after maxAttempts');

  // Negative 3.8: Secret-containing diagnostic output is redacted
  const secretError = {
    script: 'test',
    exitCode: 1,
    executed: true,
    stderr: 'Error: auth failed with sk-live9999888877776666 and Bearer topSecretAuthToken1234\nsrc/calculator.ts:3:3\n',
  };
  const secretParsed = agent.extractFailure(secretError);
  assert.ok(!secretParsed.message.includes('sk-live9999888877776666'), 'Secrets must not leak into failure messages');
  assert.ok(!secretParsed.message.includes('topSecretAuthToken1234'), 'Bearer tokens must not leak into failure messages');
  const secretDiag = agent.diagnoseObservation({ check: 'test', ...secretError, extracted: secretParsed });
  assert.ok(!secretDiag.hypothesis.includes('sk-live9999888877776666'), 'Secrets must not leak into diagnostic hypotheses');
  assert.ok(!secretDiag.hypothesis.includes('topSecretAuthToken1234'), 'Tokens must not leak into diagnostic hypotheses');

  // Negative 3.9: Failed rollback handling (uncertain restoration failure path)
  const rollbackTurn = agent.beginConversationTurn({
    root: projectRoot,
    request: 'Rollback failure audit',
    ...owner,
  });
  agent.advanceConversationTurn(rollbackTurn.turnId, 'understanding', owner);
  const rollbackTask = await agent.createProposal({
    root: projectRoot,
    conversationTurnId: rollbackTurn.turnId,
    raw: validProposalRaw,
    verificationScripts: ['test'],
    ...owner,
  });
  agent.approve(rollbackTask.taskId, owner);

  await assert.rejects(
    () => agent.apply(
      rollbackTask.taskId,
      owner,
      async () => ({ ok: false, executed: true, exitCode: 1, stderr: 'verification failed' }),
      null,
      async (req) => {
        if (req?.rollback) throw new Error('Simulated filesystem failure during rollback');
        return { allowed: true };
      },
    ),
    /Verification did not produce an executed passing result/,
    'Failed rollback must fail closed',
  );
  const failedRollbackTask = agent.getTask(rollbackTask.taskId, owner);
  assert.equal(failedRollbackTask.state, 'failed');
  assert.ok(failedRollbackTask.error.includes('Rollback verification failed'), 'Task error must record rollback verification failure');

  // Reset calculator.ts to clean initial state after intentionally failing rollback
  await fs.writeFile(path.join(projectRoot, 'src', 'calculator.ts'), initialCalculator, 'utf8');

  // =========================================================================
  // STEP 4: First Attempt (Flawed Proposal -> Failed Verification -> Rollback)
  // =========================================================================
  console.log('-> Step 4: First Attempt (Flawed Proposal & Verified Failure)');

  const flawedTurn = agent.beginConversationTurn({
    root: projectRoot,
    request: 'Attempting fix for calculator.ts',
    ...owner,
  });
  agent.advanceConversationTurn(flawedTurn.turnId, 'understanding', owner);

  const flawedRaw = [
    '--- a/src/calculator.ts',
    '+++ b/src/calculator.ts',
    '@@ -1,4 +1,4 @@',
    ' export function calculateDiscount(price: number, percentage: number): number {',
    '   // Defect: adds instead of subtracting discount',
    '-  return price + (price * percentage) / 100;',
    '+  return "invalid type";',
    ' }',
    '',
  ].join('\n');

  const flawedTask = await agent.createProposal({
    root: projectRoot,
    conversationTurnId: flawedTurn.turnId,
    raw: flawedRaw,
    verificationScripts: ['test'],
    ...owner,
  });

  agent.approve(flawedTask.taskId, owner);

  // Mock boundary: verification callback returns failure for flawed fix
  let flawedVerificationExecuted = false;
  await assert.rejects(
    () => agent.apply(
      flawedTask.taskId,
      owner,
      async () => {
        flawedVerificationExecuted = true;
        return {
          ok: false,
          executed: true,
          exitCode: 1,
          stderr: 'src/calculator.ts:3:3 - error TS2322: Type \'string\' is not assignable to type \'number\'.',
          attempts: [{ check: 'test', ok: false, executed: true, exitCode: 1 }],
        };
      },
      null,
      async () => ({ allowed: true }),
    ),
    /Verification did not produce an executed passing result/,
    'Flawed proposal must fail verification and trigger recovery rollback',
  );

  assert.equal(flawedVerificationExecuted, true, 'Verification must execute on flawed apply');
  const taskAfterFlawed = agent.getTask(flawedTask.taskId, owner);
  assert.equal(taskAfterFlawed.state, 'failed');

  // Verify rollback restored the file to pre-flawed content
  const contentAfterRollback = await fs.readFile(path.join(projectRoot, 'src', 'calculator.ts'), 'utf8');
  assert.equal(contentAfterRollback, initialCalculator, 'Rollback must restore original content on verification failure');

  // =========================================================================
  // STEP 5: Second Attempt (Accurate Repair Proposal -> Approval -> Success)
  // =========================================================================
  console.log('-> Step 5: Second Attempt (Accurate Repair Proposal & Verification)');

  const repairTurn = agent.beginConversationTurn({
    root: projectRoot,
    request: 'Apply verified arithmetic fix to calculator.ts',
    ...owner,
  });
  agent.advanceConversationTurn(repairTurn.turnId, 'understanding', owner);

  const repairTask = await agent.createProposal({
    root: projectRoot,
    conversationTurnId: repairTurn.turnId,
    raw: validProposalRaw,
    verificationScripts: ['test'],
    ...owner,
  });

  agent.approve(repairTask.taskId, owner);

  let repairVerificationExecuted = false;
  const completedTask = await agent.apply(
    repairTask.taskId,
    owner,
    async () => {
      repairVerificationExecuted = true;
      return {
        ok: true,
        status: 'PASS',
        executed: true,
        exitCode: 0,
        attempts: [{ check: 'test', ok: true, executed: true, exitCode: 0 }],
      };
    },
    null,
    async () => ({ allowed: true }),
  );

  assert.equal(repairVerificationExecuted, true, 'Verification runner must have executed');
  assert.equal(completedTask.state, 'completed', 'Task must transition to completed on genuine pass');

  // Verify file content on disk has the applied fix
  const finalContent = await fs.readFile(path.join(projectRoot, 'src', 'calculator.ts'), 'utf8');
  assert.ok(finalContent.includes('return price - (price * percentage) / 100;'), 'Correct subtraction logic must be present');

  // Verify unrelated files were NOT touched
  const finalUnrelated = await fs.readFile(path.join(projectRoot, 'src', 'unrelated.ts'), 'utf8');
  assert.equal(finalUnrelated, unrelatedContent, 'Unrelated files must remain completely untouched');

  // Verify artifacts generated
  const internalTask = agent.getTaskForTest(repairTask.taskId);
  assert.ok(internalTask.artifacts, 'Artifacts must be registered on internal task');
  assert.ok(internalTask.artifacts.length >= 2, 'Must include test report and final summary artifacts');

  console.log('[PASS] Full synthetic acceptance journey succeeded.');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log('=== SYNTHETIC ACCEPTANCE JOURNEY TEST COMPLETED SUCCESSFULLY ===');
