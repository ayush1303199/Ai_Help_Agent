import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../electron/developerAgent.cjs';
import files from '../electron/developerFiles.cjs';

let attemptedExternalRequests = 0;
let blockedExternalRequests = 0;
let permittedLoopbackRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, ...args) => {
  const urlStr = String(url);
  const isLocal = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(urlStr);
  if (!isLocal) {
    attemptedExternalRequests += 1;
    blockedExternalRequests += 1;
    throw new Error(`Unexpected live external network call to ${urlStr} in deterministic offline test.`);
  }
  permittedLoopbackRequests += 1;
  return { ok: true, json: async () => ({ decision: 'ALLOW', ok: true }) };
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), '.developer-lifecycle-'));
const ownerWebContentsId = 9001;
const sessionId = agent.getSession(ownerWebContentsId);
const owner = { ownerWebContentsId, sessionId };
const authorizeMutation = async () => ({ allowed: true });
const createBoundProposal = async (input) => {
  const turn = agent.beginConversationTurn({
    root: input.root,
    scope: input.scope || '.',
    request: 'Update the requested project file.',
    ...owner,
  });
  agent.advanceConversationTurn(turn.turnId, 'understanding', owner);
  return agent.createProposal({ ...input, conversationTurnId: turn.turnId });
};
const patch = (file, from, to) => `--- a/${file}
+++ b/${file}
@@ -1,2 +1,2 @@
 ${from}
-${from === 'one' ? 'two' : 'three'}
+${to}
`;

try {
  const file = path.join(root, 'sample.txt');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');

  const blockedTurn = agent.beginConversationTurn({
    root,
    request: 'Inspect the project and report remaining evidence needs.',
    ...owner,
  });
  agent.advanceConversationTurn(blockedTurn.turnId, 'understanding', owner);
  const blockedResult = agent.advanceConversationTurn(
    blockedTurn.turnId,
    'blocked',
    owner,
    { phase: 'INVESTIGATION_INCOMPLETE' },
  );
  assert.equal(blockedResult.state, 'blocked');
  assert.equal(agent.getConversationTurn(blockedTurn.turnId, owner).state, 'blocked');

  const proposal = await createBoundProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'three'),
  });
  assert.equal(proposal.state, 'awaiting_approval');
  await assert.rejects(() => agent.apply(proposal.taskId, owner), /approved/);
  agent.approve(proposal.taskId, owner);
  const applied = await agent.apply(proposal.taskId, owner, async () => ({
    ok: true, status: 'PASS', executed: true, exitCode: 0,
    attempts: [{ check: 'typecheck', ok: true, executed: true, exitCode: 0 }],
  }), root, authorizeMutation);
  assert.equal(applied.state, 'completed');
  assert.throws(() => agent.resumeTask(applied.taskId, 'applying', owner), /terminal state/);
  assert.throws(() => agent.pauseTask(applied.taskId, owner), /terminal state/);
  assert.equal(applied.approval.actor, 'renderer-session');
  assert.deepEqual(applied.targetFiles, ['sample.txt']);
  assert.equal(applied.verification.ok, true);
  assert.equal(applied.verification.executed, true);
  assert.equal(applied.verification.exitCode, 0);
  assert.equal((await fs.readFile(file, 'utf8')), 'one\nthree\n');
  await agent.undo(proposal.taskId, owner, authorizeMutation, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');

  const failed = await createBoundProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'four'),
  });
  agent.approve(failed.taskId, owner);
  const verificationError = await agent.apply(failed.taskId, owner, async () => ({
    ok: false,
    status: 'CODE_FAILURE',
    executed: true,
    exitCode: 1,
    classification: 'CODE_FAILURE',
    failure: 'exit',
    attempts: [{
      check: 'typecheck',
      ok: false,
      executed: true,
      exitCode: 1,
      classification: 'CODE_FAILURE',
      stderr: 'src/App.tsx:4:2 Type error api_key=sk-sensitive123456',
      extracted: { file: 'src/App.tsx', line: 4, message: 'Type error' },
    }],
  }), root, authorizeMutation).catch((error) => error);
  assert.match(verificationError.message, /Verification failed/);
  assert.equal(agent.getTaskForTest(failed.taskId).state, 'failed');
  assert.equal(agent.getTaskForTest(failed.taskId).verification.classification, 'CODE_FAILURE');
  assert.equal(verificationError.taskSnapshot.evidence.find((item) => item.kind === 'VERIFICATION').checks[0].check, 'typecheck');
  assert.equal(verificationError.taskSnapshot.evidence.find((item) => item.kind === 'DIAGNOSIS').checks[0].extracted.file, 'src/App.tsx');
  assert.equal(verificationError.taskSnapshot.runtime.metrics.verificationRuns, 1);
  assert.doesNotMatch(JSON.stringify(verificationError.taskSnapshot.verification), /sk-sensitive123456/);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');

  const stale = await createBoundProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'five'),
  });
  await fs.writeFile(file, 'one\nchanged\n', 'utf8');
  agent.approve(stale.taskId, owner);
  await assert.rejects(() => agent.apply(stale.taskId, owner, async () => ({
    ok: true, status: 'PASS', executed: true, exitCode: 0,
    attempts: [{ check: 'typecheck', ok: true, executed: true, exitCode: 0 }],
  }), root, authorizeMutation), /changed after approval/);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\nchanged\n');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'tsc --version',
      lint: 'eslint --version',
      build: 'vite build --outDir verification-output',
      deploy: 'echo deploy',
    },
  }), 'utf8');
  await fs.mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(root, 'node_modules', '.bin', 'tsc.cmd'), '@echo 5.0.0\r\n@exit /b 0', 'utf8');
    await fs.writeFile(path.join(root, 'node_modules', '.bin', 'vite.cmd'), '@echo off\r\n@mkdir verification-output 2>nul\r\n@exit /b 0\r\n', 'utf8');
  } else {
    await fs.writeFile(path.join(root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\necho 5.0.0\nexit 0', { encoding: 'utf8', mode: 0o755 });
    await fs.writeFile(path.join(root, 'node_modules', '.bin', 'vite'), '#!/bin/sh\nmkdir verification-output\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
  }
  const capturedOptions = [];
  await files.chooseProjectFolder({
    showOpenDialog: async (options) => {
      capturedOptions.push(options);
      return { canceled: false, filePaths: [root] };
    },
  }, ownerWebContentsId);
  assert.equal(capturedOptions[0].defaultPath, process.cwd());
  await assert.rejects(() => files.listDirectory('.', ownerWebContentsId + 1), /not owned/);
  const plan = await files.getVerificationScripts(ownerWebContentsId);
  assert.deepEqual(plan.scripts, ['typecheck', 'lint', 'build']);
  const missingPlan = await files.getVerificationScripts(ownerWebContentsId, ['test']);
  assert.deepEqual(missingPlan.missing, ['test']);
  await assert.rejects(
    () => files.runVerification('typecheck', ownerWebContentsId),
    (error) => error.code === 'PROJECT_EXECUTION_BLOCKED'
      && error.executionBlocked === true
      && error.executionStatus === 'BLOCKED'
      && error.evidenceState === 'NOT_ESTABLISHED',
  );
  await assert.rejects(
    () => files.runVerification('build', ownerWebContentsId),
    /Project verification was not started/,
  );
  await assert.rejects(
    () => files.runGit(['status', '--short'], ownerWebContentsId),
    process.platform === 'win32'
      ? /Windows host-side Git inspection is unavailable pending verified isolation\./
      : /Project Git inspection was not started/,
  );
  await assert.rejects(() => fs.access(path.join(root, 'verification-output')), { code: 'ENOENT' });
  files.clearProject(ownerWebContentsId);

  const checks = await agent.runVerificationChecks({
    checks: ['typecheck', 'lint'],
    runCheck: async (script) => ({
      ok: script === 'typecheck',
      executed: true,
      script,
      exitCode: script === 'typecheck' ? 0 : 1,
      stderr: script === 'lint' ? 'src/App.tsx:4:2 Type error' : '',
    }),
  });
  assert.equal(checks.ok, false);
  assert.equal(checks.status, 'CODE_FAILURE');
  assert.equal(checks.attempts.length, 2);

  for (const status of ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED']) {
    const unavailable = await agent.runVerificationChecks({
      checks: ['typecheck'],
      runCheck: async () => ({
        ok: false,
        status,
        evidenceState: status,
        executionBlocked: true,
        executed: false,
        exitCode: null,
        reason: 'Execution evidence is not established.',
        error: 'Verification was not started.',
      }),
    });
    assert.equal(unavailable.status, status);
    assert.equal(unavailable.evidenceState, status);
    assert.equal(unavailable.executed, false);
    assert.equal(unavailable.reason, 'Execution evidence is not established.');
  }
  const malformedGateError = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => {
      throw Object.assign(new Error('Gate denied execution.'), {
        executionBlocked: true,
        executionStatus: 'UNVERIFIED',
        evidenceState: 'NOT_ESTABLISHED',
      });
    },
  });
  assert.equal(malformedGateError.status, 'BLOCKED');
  assert.equal(malformedGateError.evidenceState, 'NOT_ESTABLISHED');
  assert.equal(malformedGateError.executed, false);
  assert.equal(malformedGateError.attempts.length, 1);
  const staleBlockedResult = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => ({
      ok: false,
      status: 'UNVERIFIED',
      executionBlocked: true,
      evidenceState: 'NOT_ESTABLISHED',
      executed: false,
      exitCode: null,
    }),
  });
  assert.equal(staleBlockedResult.status, 'BLOCKED');
  assert.equal(staleBlockedResult.evidenceState, 'NOT_ESTABLISHED');

  const verificationResultMatrix = [
    { name: 'PASS without execution', result: { ok: true, status: 'PASS', exitCode: 0, attempts: [] } },
    { name: 'null result', result: null },
    {
      name: 'unknown status',
      result: {
        ok: true, status: 'VERIFIED', executed: true, exitCode: 0,
        attempts: [{ check: 'typecheck', ok: true, executed: true, exitCode: 0 }],
      },
    },
    {
      name: 'contradictory success',
      result: {
        ok: true, status: 'PASS', success: false, executed: true, exitCode: 0,
        attempts: [{ check: 'typecheck', ok: true, executed: true, exitCode: 0 }],
      },
    },
    {
      name: 'blocked success-shaped result',
      result: {
        ok: true, status: 'BLOCKED', executionBlocked: true, evidenceState: 'NOT_ESTABLISHED',
        executed: true, exitCode: 0,
      },
    },
    {
      name: 'untrusted flags without valid result',
      result: { verified: true, authorized: true, success: true },
    },
  ];
  for (const scenario of verificationResultMatrix) {
    const normalized = await agent.runVerificationChecks({
      checks: ['typecheck'],
      runCheck: async () => scenario.result,
    });
    assert.notEqual(normalized.status, 'PASS', scenario.name);
    assert.notEqual(normalized.ok, true, scenario.name);
  }

  let verificationAttempt = 0;
  const throwAfterPass = await agent.runVerificationChecks({
    checks: ['typecheck', 'lint'],
    runCheck: async (script) => {
      verificationAttempt += 1;
      if (verificationAttempt === 1) {
        return { ok: true, status: 'PASS', script, executed: true, exitCode: 0 };
      }
      const error = new Error('Host evidence is unavailable.');
      error.executionBlocked = true;
      error.executionStatus = 'BLOCKED';
      error.evidenceState = 'NOT_ESTABLISHED';
      throw error;
    },
  });
  assert.equal(throwAfterPass.status, 'BLOCKED');
  assert.equal(throwAfterPass.evidenceState, 'NOT_ESTABLISHED');
  assert.equal(throwAfterPass.attempts.length, 2);
  assert.equal(throwAfterPass.attempts[0].ok, true);
  assert.equal(throwAfterPass.attempts[1].ok, false);

  const blockedProposal = await createBoundProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'blocked'),
  });
  const auditDirectory = path.join(root, 'audit-fixture');
  agent.configureDurability({
    journalFile: path.join(auditDirectory, 'journal.json'),
    auditFile: path.join(auditDirectory, 'audit.jsonl'),
  });
  agent.approve(blockedProposal.taskId, owner);
  const blockedActivity = [];
  const blockedApplyError = await agent.apply(
    blockedProposal.taskId,
    owner,
    async () => ({
      ok: false,
      status: 'UNVERIFIED',
      executionBlocked: true,
      evidenceState: 'NOT_ESTABLISHED',
      executed: false,
      exitCode: null,
      reason: 'Host isolation is not established.',
      attempts: [],
    }),
    root,
    authorizeMutation,
    1,
    (activity) => blockedActivity.push(activity),
  ).catch((error) => error);
  assert.equal(blockedApplyError.taskSnapshot.verification.status, 'BLOCKED');
  assert.equal(blockedApplyError.taskSnapshot.verification.evidenceState, 'NOT_ESTABLISHED');
  assert.equal(blockedApplyError.taskSnapshot.verification.reason, 'Host isolation is not established.');
  const blockedEvidence = blockedApplyError.taskSnapshot.evidence.find((item) => item.kind === 'VERIFICATION');
  assert.equal(blockedEvidence.status, 'BLOCKED');
  assert.equal(blockedEvidence.evidenceState, 'NOT_ESTABLISHED');
  await agent.flushDurability();
  const auditEvents = (await fs.readFile(path.join(auditDirectory, 'audit.jsonl'), 'utf8'))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const verificationAudit = auditEvents.find((event) => event.type === 'verification_recorded');
  assert.equal(verificationAudit.details.result, 'BLOCKED');
  assert.equal(verificationAudit.details.evidenceState, 'NOT_ESTABLISHED');
  assert.ok(blockedActivity.some((activity) => (
    activity.phase === 'verification'
    && activity.status === 'BLOCKED'
    && activity.evidenceState === 'NOT_ESTABLISHED'
  )));
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n', 'A blocked verification must roll back the applied fixture patch.');

  const malformedAttemptProposal = await createBoundProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'malformed-attempt'),
  });
  agent.approve(malformedAttemptProposal.taskId, owner);
  const malformedAttemptError = await agent.apply(
    malformedAttemptProposal.taskId,
    owner,
    async () => ({
      ok: true,
      status: 'PASS',
      executed: true,
      exitCode: 0,
      attempts: [null],
    }),
    root,
    authorizeMutation,
  ).catch((error) => error);
  assert.equal(malformedAttemptError.taskSnapshot.verification.status, 'UNVERIFIED');
  assert.equal(malformedAttemptError.taskSnapshot.evidence.find((item) => item.kind === 'VERIFICATION').status, 'UNVERIFIED');
  await agent.flushDurability();
  const malformedAuditEvents = (await fs.readFile(path.join(auditDirectory, 'audit.jsonl'), 'utf8'))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const malformedVerificationAudit = malformedAuditEvents.find((event) => (
    event.taskId === malformedAttemptProposal.taskId && event.type === 'verification_recorded'
  ));
  assert.equal(malformedVerificationAudit.details.result, 'UNVERIFIED');
  assert.deepEqual(malformedVerificationAudit.details.checks, [{
    check: null,
    ok: false,
    classification: null,
  }]);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n', 'A malformed attempt must not prevent rollback.');

  // =========================================================================
  // Milestone V44.53: Deterministic Offline Synthetic Provider Verification
  // =========================================================================
  // Scenario A: Provider connection reset / network error (e.g. daily-cloudcode-pa.googleapis.com)
  const networkErrorCheck = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => {
      const err = new Error('fetch failed: connection reset to daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent');
      err.status = 'NETWORK_ERROR';
      err.classification = 'NETWORK_ERROR';
      throw err;
    },
  });
  assert.equal(networkErrorCheck.ok, false, 'Network error must never produce a PASS');
  assert.equal(networkErrorCheck.status, 'NETWORK_ERROR');
  assert.equal(networkErrorCheck.classification, 'NETWORK_ERROR');

  // Scenario B: Provider timeout
  const timeoutCheck = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => {
      const err = new Error('Provider request timed out after 45000ms (ETIMEDOUT)');
      err.status = 'TIMEOUT';
      err.classification = 'TIMEOUT';
      throw err;
    },
  });
  assert.equal(timeoutCheck.ok, false, 'Provider timeout must never produce a PASS');
  assert.equal(timeoutCheck.status, 'TIMEOUT');
  assert.equal(timeoutCheck.classification, 'TIMEOUT');

  // Scenario C: Interrupted streaming / truncated response
  const interruptedStreamCheck = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => {
      throw new Error('Streaming response interrupted mid-stream: unexpected EOF from provider');
    },
  });
  assert.equal(interruptedStreamCheck.ok, false, 'Interrupted stream must not produce a PASS');
  assert.notEqual(interruptedStreamCheck.status, 'PASS');

  // Scenario D: 5 distinct failure outcomes verification (PASS, CODE_FAILURE, BLOCKED, NETWORK_ERROR, CANCELLED)
  const passCheck = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => ({ ok: true, status: 'PASS', executed: true, exitCode: 0, attempts: [{ check: 'typecheck', ok: true, executed: true, exitCode: 0 }] }),
  });
  assert.equal(passCheck.ok, true);
  assert.equal(passCheck.status, 'PASS');

  const failCheck = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => ({ ok: false, status: 'CODE_FAILURE', classification: 'CODE_FAILURE', executed: true, exitCode: 1, attempts: [{ check: 'typecheck', ok: false, executed: true, exitCode: 1 }] }),
  });
  assert.equal(failCheck.ok, false);
  assert.equal(failCheck.status, 'CODE_FAILURE');

  const blockedCheck = await agent.runVerificationChecks({
    checks: ['typecheck'],
    runCheck: async () => ({ ok: false, status: 'BLOCKED', executionBlocked: true, evidenceState: 'NOT_ESTABLISHED', executed: false, exitCode: null }),
  });
  assert.equal(blockedCheck.ok, false);
  assert.equal(blockedCheck.status, 'BLOCKED');

  const cancelledCheck = await agent.runVerificationChecks({
    checks: ['typecheck'],
    isCancelled: () => true,
    runCheck: async () => ({ ok: true }),
  });
  assert.equal(cancelledCheck.ok, false);
  assert.equal(cancelledCheck.status, 'CANCELLED');

  // Scenario E: Model suggestion unverified defect must NOT be promoted to confirmed
  const unverifiedDefect = agent.classifyDefect({
    filePath: 'sample.txt',
    symbol: 'testFn',
    lines: '1-5',
    evidenceType: 'MODEL_SUGGESTION_UNVERIFIED',
  });
  assert.equal(unverifiedDefect.isConfirmed, false);
  assert.equal(unverifiedDefect.classification, 'UNVERIFIED');

  // Scenario F: Cancelled task cannot be revived
  const rejectProposal = await createBoundProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'five'),
  });
  agent.reject(rejectProposal.taskId, owner);
  assert.throws(() => agent.resumeTask(rejectProposal.taskId, 'applying', owner), /terminal state/);
  assert.throws(() => agent.pauseTask(rejectProposal.taskId, owner), /terminal state/);

  // Scenario E: Zero Live Network Calls
  assert.equal(attemptedExternalRequests, 0, 'Lifecycle test must execute with ZERO attempted external requests');
  assert.equal(blockedExternalRequests, 0, 'Lifecycle test must have ZERO blocked external requests');
  console.log(`[NETWORK_GUARD] developer-lifecycle-test: attemptedExternalRequests=${attemptedExternalRequests}, blockedExternalRequests=${blockedExternalRequests}, permittedLoopbackRequests=${permittedLoopbackRequests}`);

  console.log('developer lifecycle tests passed');
} finally {
  globalThis.fetch = originalFetch;
  try { files.clearProject(ownerWebContentsId); } catch { /* fixture may not own the project after cleanup */ }
  agent.resetForTest();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
