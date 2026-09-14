import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../electron/developerAgent.cjs';

const root = await fs.mkdtemp(path.join(process.cwd(), '.developer-test-'));
try {
  const ownerWebContentsId = 11;
  const sessionId = agent.getSession(ownerWebContentsId);
  const file = path.join(root, 'sample.txt');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  const proposal = await agent.createProposal({
    root,
    ownerWebContentsId,
    sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
  });
  assert.equal(proposal.state, 'awaiting_approval');
  const owner = { ownerWebContentsId, sessionId };
  await assert.rejects(() => agent.apply(proposal.taskId, owner), /approved/);
  assert.throws(() => agent.approve(proposal.taskId, { ownerWebContentsId: 12, sessionId: agent.getSession(12) }), /not owned/);
  agent.approve(proposal.taskId, owner);
  await agent.apply(proposal.taskId, owner);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\nthree\n');
  await agent.undo(proposal.taskId, owner);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  await assert.rejects(() => agent.createProposal({ root, ownerWebContentsId, sessionId, raw: '--- a/../escape\n+++ b/../escape\n@@ -1 +1 @@\n-x\n+y\n' }), /traversal|exist/);
  assert.equal(agent.classifyFailure({ timedOut: true }), 'timeout');
  assert.equal(agent.classifyFailure({ exitCode: 1, stderr: 'Access denied' }), 'permission');
  assert.equal(agent.classifyFailure({ exitCode: 1, stderr: 'Syntax error' }), 'compile');
  assert.equal(agent.classifyFailure({ exitCode: 1, stderr: 'module missing' }), 'missing_dependency');
  assert.equal(agent.classifyFailure({ cancelled: true }), 'cancelled');
  assert.equal(agent.STATE_ALIASES.awaiting_approval, 'WAITING_FOR_APPROVAL');
  assert.equal(agent.normalizeCommandResult({ ok: false, script: 'lint', exitCode: 1 }).failure, 'exit');
  assert.throws(() => agent.commandPolicy('install'), /not permitted/);
  const loop = await agent.executeVerificationLoop({
    run: async () => ({ ok: false, script: 'test', exitCode: 1 }),
    diagnose: () => ({ retryable: true, kind: 'transient' }),
  });
  assert.equal(loop.attempts.length, 2);
  assert.deepEqual(agent.selectVerificationChecks({ scripts: { test: 'vitest', lint: 'eslint .', deploy: 'echo deploy' } }), ['test', 'lint']);
  assert.deepEqual(agent.extractFailure({ stderr: 'src/app.ts:12:4 test should pass' }), {
    file: 'src/app.ts', line: 12, column: 4, test: null, message: 'src/app.ts:12:4 test should pass',
  });
  const owner2 = { ownerWebContentsId: 21, sessionId: agent.getSession(21) };
  const progress = [];
  let checkRuns = 0;
  let proposalRuns = 0;
  const loopResult = await agent.runEngineeringLoop({
    owner: owner2, checks: ['test'], maxAttempts: 2,
    runCheck: async () => (++checkRuns === 1 ? { ok: false, script: 'test', exitCode: 1, stderr: 'src/app.ts:2:1 expected true' } : { ok: true, script: 'test', exitCode: 0 }),
    proposeFix: async () => {
      proposalRuns += 1;
      return agent.createProposal({ root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
        raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n' });
    },
    approveFix: (id, owner) => agent.approve(id, owner),
    applyFix: (id, owner) => agent.apply(id, owner),
    onProgress: (event) => progress.push(event.phase),
  });
  assert.equal(loopResult.status, 'PASS');
  assert.equal(proposalRuns, 1);
  assert.ok(progress.includes('diagnosing') && progress.includes('retesting'));
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  const noProgress = await agent.runEngineeringLoop({
    owner: owner2, checks: ['test'], maxAttempts: 3,
    runCheck: async () => ({ ok: false, script: 'test', exitCode: 1, stderr: 'same failure' }),
    proposeFix: async () => agent.createProposal({ root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
      raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n' }),
    approveFix: (id, owner) => agent.approve(id, owner), applyFix: (id, owner) => agent.apply(id, owner),
  });
  assert.equal(noProgress.status, 'NO_PROGRESS');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  const lifecycleTask = await agent.createProposal({
    root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
  });
  const lifecycleProgress = [];
  let lifecycleRuns = 0;
  const lifecycleResult = await agent.runEngineeringLoop({
    taskId: lifecycleTask.taskId, owner: owner2, checks: ['test'], maxAttempts: 2,
    runCheck: async () => (++lifecycleRuns === 1 ? { ok: false, script: 'test', exitCode: 1, stderr: 'same lifecycle failure' } : { ok: true, script: 'test', exitCode: 0 }),
    proposeFix: async () => agent.createProposal({
      root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
      raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
    }),
    approveFix: (id, owner) => agent.approve(id, owner),
    applyFix: (id, owner) => agent.apply(id, owner),
    onProgress: (event) => lifecycleProgress.push(event.phase),
  });
  assert.equal(lifecycleResult.status, 'PASS');
  const lifecycleSnapshot = agent.getTaskForTest(lifecycleTask.taskId);
  assert.equal(lifecycleSnapshot.state, 'completed');
  assert.equal(lifecycleSnapshot.outcome, 'PASS');
  assert.ok(['verifying', 'retesting', 'complete'].some((phase) => lifecycleProgress.includes(phase)));
  const environmentFailure = await agent.runEngineeringLoop({
    owner: owner2, checks: ['test'], runCheck: async () => ({ ok: false, script: 'test', error: 'spawn failed' }),
    proposeFix: async () => { throw new Error('should not propose'); }, approveFix: async () => {}, applyFix: async () => {},
  });
  assert.equal(environmentFailure.status, 'ENVIRONMENT_FAILURE');
  const journalRoot = await fs.mkdtemp(path.join(process.cwd(), '.developer-journal-'));
  const journalFile = path.join(journalRoot, 'journal.json');
  const auditFile = path.join(journalRoot, 'audit.jsonl');
  agent.configureDurability({ journalFile, auditFile });
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  const durableTask = await agent.createProposal({
    root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
  });
  await agent.flushDurability();
  const eventLines = (await fs.readFile(auditFile, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(eventLines.length >= 2);
  assert.deepEqual(eventLines.map((event) => event.sequence), [...eventLines.map((event) => event.sequence)].sort((a, b) => a - b));
  assert.ok(!JSON.stringify(eventLines).match(/sk-[A-Za-z0-9]/));
  agent.resetForTest();
  agent.configureDurability({ journalFile, auditFile });
  const restored = await agent.loadJournal();
  assert.ok(restored.loaded >= 1);
  assert.throws(() => agent.getTask(durableTask.taskId, owner2), /not owned/);
  agent.resumeSession(21, owner2.sessionId);
  assert.equal(agent.getTask(durableTask.taskId, owner2).state, 'awaiting_approval');
  const interrupted = await agent.createProposal({
    root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
  });
  agent.getTaskForTest(interrupted.taskId).state = 'applying';
  await agent.flushDurability();
  agent.resetForTest();
  agent.configureDurability({ journalFile, auditFile });
  await agent.loadJournal();
  assert.equal(agent.getTaskForTest(interrupted.taskId).state, 'failed');
  agent.resumeSession(21, owner2.sessionId);
  const concurrentTask = agent.getTaskForTest(durableTask.taskId);
  agent.approve(durableTask.taskId, owner2);
  const applyResults = await Promise.allSettled([
    agent.apply(durableTask.taskId, owner2),
    agent.apply(durableTask.taskId, owner2),
  ]);
  assert.equal(applyResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(applyResults.filter((result) => result.status === 'rejected').length, 1);
  const failedAuditPath = path.join(journalRoot, 'audit-directory');
  await fs.mkdir(failedAuditPath);
  agent.configureDurability({ journalFile: null, auditFile: failedAuditPath });
  agent.resetForTest();
  agent.configureDurability({ journalFile: null, auditFile: failedAuditPath });
  const failureTask = await agent.createProposal({
    root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-three\n+four\n',
  });
  await assert.rejects(() => agent.flushDurability(), /audit write failed/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.rm(journalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  console.log('developer-agent tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
