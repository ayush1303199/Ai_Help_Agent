import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../electron/developerAgent.cjs';

const root = await fs.mkdtemp(path.join(process.cwd(), '.developer-test-'));
try {
  const ownerWebContentsId = 11;
  const sessionId = agent.getSession(ownerWebContentsId);
  const conversation = agent.beginConversationTurn({
    root,
    request: 'is fix ka proposal banao',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(conversation.state, 'reading', 'A normal follow-up request must pass conversation-start validation.');
  assert.throws(
    () => agent.beginConversationTurn({
      root,
      request: 'x'.repeat(4001),
      sessionId,
      ownerWebContentsId,
    }),
    /Coding request is too long \(4001 characters; maximum 4000\)/,
    'Only an oversized current request should hit the character limit, with an actionable message.',
  );
  assert.throws(
    () => agent.beginConversationTurn({ root, request: '   ', sessionId, ownerWebContentsId }),
    /Coding request must be a non-empty string/,
    'An empty request should report a specific validation error.',
  );
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
  const authorizedMutations = [];
  const authorizeTestMutation = async (request) => {
    authorizedMutations.push(request);
    return { allowed: true };
  };
  await assert.rejects(() => agent.apply(proposal.taskId, owner), /approved/);
  assert.throws(() => agent.approve(proposal.taskId, { ownerWebContentsId: 12, sessionId: agent.getSession(12) }), /not owned/);
  const rejectedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
  });
  assert.equal(agent.reject(rejectedProposal.taskId, owner).state, 'cancelled');
  assert.throws(() => agent.approve(rejectedProposal.taskId, owner), /awaiting approval/);
  assert.equal(agent.getTaskForTest(rejectedProposal.taskId).approval, undefined);
  await assert.rejects(() => agent.apply(rejectedProposal.taskId, owner), /approved/);
  agent.approve(proposal.taskId, owner);
  await agent.apply(proposal.taskId, owner, undefined, null, authorizeTestMutation);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\nthree\n');
  await assert.rejects(() => agent.undo(proposal.taskId, owner, authorizeTestMutation), /separate explicit user approval/);
  await agent.undo(proposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  assert.ok(authorizedMutations.some((request) => request.operation === 'modify'));
  assert.ok(authorizedMutations.some((request) => request.operation === 'undo'));

  const createdProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+created\n',
  });
  assert.equal(createdProposal.files[0].operation, 'create');
  agent.approve(createdProposal.taskId, owner);
  await agent.apply(createdProposal.taskId, owner, undefined, null, authorizeTestMutation);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'created\n');
  await agent.undo(createdProposal.taskId, owner, authorizeTestMutation, true);
  await assert.rejects(() => fs.access(path.join(root, 'new.txt')), { code: 'ENOENT' });

  const deletedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n',
  });
  assert.equal(deletedProposal.files[0].operation, 'delete');
  agent.approve(deletedProposal.taskId, owner);
  await agent.apply(deletedProposal.taskId, owner, undefined, null, authorizeTestMutation);
  await assert.rejects(() => fs.access(file), { code: 'ENOENT' });
  await agent.undo(deletedProposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');

  const renamedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: 'diff --git a/sample.txt b/renamed.txt\nsimilarity index 100%\nrename from sample.txt\nrename to renamed.txt\n',
  });
  assert.equal(renamedProposal.files[0].operation, 'rename');
  agent.approve(renamedProposal.taskId, owner);
  await agent.apply(renamedProposal.taskId, owner, undefined, null, authorizeTestMutation);
  assert.equal(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8'), 'one\ntwo\n');
  await agent.undo(renamedProposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  await assert.rejects(() => fs.access(path.join(root, 'renamed.txt')), { code: 'ENOENT' });

  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'folder', 'nested.txt'), 'nested\n', 'utf8');
  const directoryDeleteProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '*** Delete Directory: folder\n',
  });
  assert.equal(directoryDeleteProposal.files[0].operation, 'delete_directory');
  agent.approve(directoryDeleteProposal.taskId, owner);
  await agent.apply(directoryDeleteProposal.taskId, owner, undefined, null, authorizeTestMutation);
  await assert.rejects(() => fs.access(path.join(root, 'folder')), { code: 'ENOENT' });
  await agent.undo(directoryDeleteProposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(path.join(root, 'folder', 'nested.txt'), 'utf8'), 'nested\n');

  const deniedCreate = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/denied.txt\n@@ -0,0 +1,1 @@\n+nope\n',
  });
  agent.approve(deniedCreate.taskId, owner);
  await assert.rejects(
    () => agent.apply(deniedCreate.taskId, owner, undefined, null, async () => ({ allowed: false, reason: 'policy denial' })),
    /policy denial/,
  );
  await assert.rejects(() => fs.access(path.join(root, 'denied.txt')), { code: 'ENOENT' });
  const multiCreate = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/first.txt\n@@ -0,0 +1,1 @@\n+first\n'
      + '--- /dev/null\n+++ b/second.txt\n@@ -0,0 +1,1 @@\n+second\n',
  });
  agent.approve(multiCreate.taskId, owner);
  let policyCallCount = 0;
  await assert.rejects(() => agent.apply(multiCreate.taskId, owner, undefined, null, async () => {
    policyCallCount += 1;
    return policyCallCount === 1 ? { allowed: true } : { allowed: false, reason: 'second target denied' };
  }), /second target denied/);
  assert.equal(policyCallCount, 2, 'Each target must reach PolicyGate before any file is written.');
  await assert.rejects(() => fs.access(path.join(root, 'first.txt')), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(path.join(root, 'second.txt')), { code: 'ENOENT' });

  await fs.writeFile(path.join(root, 'second.txt'), 'alpha\nbeta\n', 'utf8');
  const rollbackProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+ONE\n'
      + '--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-alpha\n+ALPHA\n',
  });
  agent.approve(rollbackProposal.taskId, owner);
  await assert.rejects(
    () => agent.apply(rollbackProposal.taskId, owner, async () => ({ ok: false, failure: 'test' }), null, authorizeTestMutation),
    /Verification failed/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'alpha\nbeta\n');

  const mismatchedRoot = path.join(root, 'different-project');
  await fs.mkdir(mismatchedRoot);
  const rootMismatchProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+ONE\n',
  });
  agent.approve(rootMismatchProposal.taskId, owner);
  await assert.rejects(
    () => agent.apply(rootMismatchProposal.taskId, owner, undefined, mismatchedRoot, authorizeTestMutation),
    /project changed/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  const staleProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n-one\n+changed\n two\n',
  });
  await fs.writeFile(file, 'external change\n', 'utf8');
  agent.approve(staleProposal.taskId, owner);
  await assert.rejects(() => agent.apply(staleProposal.taskId, owner, undefined, null, authorizeTestMutation), /changed after approval/);
  assert.equal(await fs.readFile(file, 'utf8'), 'external change\n', 'A stale proposal must not overwrite external changes.');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  await assert.rejects(() => agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/.env\n@@ -0,0 +1,1 @@\n+blocked\n',
  }), /Sensitive files/);
  await assert.rejects(() => agent.createProposal({
    root, ownerWebContentsId, sessionId, scope: 'subdir',
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+outside\n',
  }), /outside the approved scope/);

  await assert.rejects(() => agent.createProposal({ root, ownerWebContentsId, sessionId, raw: '--- a/../escape\n+++ b/../escape\n@@ -1 +1 @@\n-x\n+y\n' }), /traversal|exist|scope/);
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
    applyFix: (id, owner) => agent.apply(id, owner, undefined, null, authorizeTestMutation),
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
    approveFix: (id, owner) => agent.approve(id, owner), applyFix: (id, owner) => agent.apply(id, owner, undefined, null, authorizeTestMutation),
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
    applyFix: (id, owner) => agent.apply(id, owner, undefined, null, authorizeTestMutation),
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
    agent.apply(durableTask.taskId, owner2, undefined, null, authorizeTestMutation),
    agent.apply(durableTask.taskId, owner2, undefined, null, authorizeTestMutation),
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
