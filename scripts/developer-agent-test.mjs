import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../electron/developerAgent.cjs';
import { ArtifactEngine, ARTIFACT_TYPES } from '../electron/coding-pipeline/artifacts.cjs';

const createUnboundProposal = agent.createProposal;
agent.createProposal = async (input) => {
  if (input.conversationTurnId) return createUnboundProposal(input);
  const owner = { sessionId: input.sessionId, ownerWebContentsId: input.ownerWebContentsId };
  const turn = agent.beginConversationTurn({
    root: input.root,
    scope: input.scope || '.',
    request: input.request || 'Create the requested test proposal.',
    ...owner,
  });
  agent.advanceConversationTurn(turn.turnId, 'understanding', owner);
  return createUnboundProposal({ ...input, conversationTurnId: turn.turnId });
};

const root = await fs.mkdtemp(path.join(process.cwd(), '.developer-test-'));
const passingVerification = async () => ({
  ok: true,
  status: 'PASS',
  executed: true,
  exitCode: 0,
  attempts: [{ check: 'test', ok: true, executed: true, exitCode: 0 }],
});
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
  const conversationContext = agent.getConversationTurn(conversation.turnId, { sessionId, ownerWebContentsId }).authorizationContext;
  assert.throws(
    () => agent.beginConversationTurn({
      root,
      request: 'Retry an expired authorization.',
      sessionId,
      ownerWebContentsId,
      parentAuthorizationContext: {
        ...conversationContext,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    }),
    /authorization has expired/,
  );
  assert.throws(
    () => agent.beginConversationTurn({
      root: path.join(root, 'different-project'),
      request: 'Do not borrow another project authorization.',
      sessionId,
      ownerWebContentsId,
      parentAuthorizationContext: conversationContext,
    }),
    /does not match this project session/,
  );
  await assert.rejects(
    () => createUnboundProposal({
      root,
      ownerWebContentsId,
      sessionId,
      raw: '--- a/unbound.txt\n+++ b/unbound.txt\n@@ -1 +1 @@\n-before\n+after\n',
    }),
    /request-bound Coding conversation turn is required/,
    'Direct proposal helpers must reject proposals without a trusted request turn.',
  );
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
  assert.equal(agent.getTaskForTest(rejectedProposal.taskId).state, 'cancelled');
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n', 'Rejecting a proposal must leave project files unchanged.');
  const directApplyProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+direct-write\n',
  });
  agent.approve(directApplyProposal.taskId, owner);
  await assert.rejects(
    () => agent.apply(directApplyProposal.taskId, owner, passingVerification),
    /authoritative file mutation policy is unavailable/,
    'A direct low-level apply call must fail closed without PolicyGate authorization.',
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  agent.approve(proposal.taskId, owner);
  assert.match(agent.getTaskForTest(proposal.taskId).approval.manifestHash, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(agent.getTaskForTest(proposal.taskId).approval.expiresAt) > Date.now());
  await agent.apply(proposal.taskId, owner, passingVerification, null, authorizeTestMutation);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\nthree\n');
  assert.equal(agent.getTaskForTest(proposal.taskId).verification.status, 'PASS');
  await assert.rejects(() => agent.apply(proposal.taskId, owner, undefined, null, authorizeTestMutation), /already been used/);
  await assert.rejects(() => agent.undo(proposal.taskId, owner, authorizeTestMutation), /separate explicit user approval/);
  await agent.undo(proposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  assert.ok(authorizedMutations.some((request) => request.operation === 'modify'));
  assert.ok(authorizedMutations.some((request) => request.operation === 'undo'));
  assert.ok(authorizedMutations.every((request) => (
    request.requestBinding?.taskId
    && request.requestBinding?.turnId
    && /^[a-f0-9]{64}$/.test(request.requestBinding?.requestHash || '')
    && request.requestBinding.authorizedFeatures.includes('shared')
  )), 'Every direct apply and undo authorization must carry its original request binding.');

  const meetingDirectory = path.join(root, 'src', 'features', 'meeting');
  await fs.mkdir(meetingDirectory, { recursive: true });
  await fs.writeFile(path.join(meetingDirectory, 'transcript.ts'), 'export const current = true;\n', 'utf8');
  const meetingProposal = await agent.createProposal({
    root,
    ownerWebContentsId,
    sessionId,
    raw: '--- a/src/features/meeting/transcript.ts\n+++ b/src/features/meeting/transcript.ts\n@@ -1 +1 @@\n-export const current = true;\n+export const current = false;\n',
  });
  assert.deepEqual(agent.getTaskForTest(meetingProposal.id).requestedFeatures, ['meeting']);
  assert.throws(
    () => agent.approve(meetingProposal.id, owner),
    /explicit main-process confirmation is required/,
    'A Coding request must not implicitly approve a Meeting feature mutation.',
  );
  agent.approve(meetingProposal.id, owner, {
    source: 'main-process-feature-confirmation',
    proposalId: agent.getTaskForTest(meetingProposal.id).proposalId,
    authorizedFeatures: ['coding', 'meeting', 'shared'],
  });
  await agent.apply(meetingProposal.id, owner, passingVerification, null, authorizeTestMutation);
  assert.equal(await fs.readFile(path.join(meetingDirectory, 'transcript.ts'), 'utf8'), 'export const current = false;\n');
  assert.ok(authorizedMutations.at(-1).requestBinding.authorizedFeatures.includes('meeting'));
  await agent.undo(meetingProposal.id, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(path.join(meetingDirectory, 'transcript.ts'), 'utf8'), 'export const current = true;\n');

  const artifactRoot = path.join(root, 'application-artifacts');
  const attackerRoot = path.join(root, 'unapproved-artifact-destination');
  const artifacts = new ArtifactEngine();
  artifacts.setStorageDir(artifactRoot);
  artifacts.createArtifact({
    taskId: 'artifact-boundary-test',
    type: ARTIFACT_TYPES.INVESTIGATION_REPORT,
    content: 'Evidence-backed report',
  });
  await assert.rejects(
    () => artifacts.persistArtifacts('artifact-boundary-test', attackerRoot),
    /configured application-owned storage directory/,
  );
  await assert.rejects(() => fs.access(attackerRoot), { code: 'ENOENT' });
  const persistedArtifacts = await artifacts.persistArtifacts('artifact-boundary-test');
  assert.equal(persistedArtifacts.length, 1);
  assert.equal(await fs.readFile(persistedArtifacts[0].path, 'utf8'), 'Evidence-backed report');

  const unverifiedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+unverified\n',
  });
  agent.approve(unverifiedProposal.taskId, owner);
  await assert.rejects(
    () => agent.apply(unverifiedProposal.taskId, owner, undefined, null, authorizeTestMutation),
    /executed passing result with exit code 0/,
  );
  assert.equal(agent.getTaskForTest(unverifiedProposal.taskId).verification.status, 'UNVERIFIED');
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n', 'A missing verifier must roll back rather than claim success.');

  const createdProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+created\n',
  });
  assert.equal(createdProposal.files[0].operation, 'create');
  agent.approve(createdProposal.taskId, owner);
  await agent.apply(createdProposal.taskId, owner, passingVerification, null, authorizeTestMutation);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'created\n');
  await agent.undo(createdProposal.taskId, owner, authorizeTestMutation, true);
  await assert.rejects(() => fs.access(path.join(root, 'new.txt')), { code: 'ENOENT' });

  const deletedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n',
  });
  assert.equal(deletedProposal.files[0].operation, 'delete');
  agent.approve(deletedProposal.taskId, owner);
  await agent.apply(deletedProposal.taskId, owner, passingVerification, null, authorizeTestMutation);
  await assert.rejects(() => fs.access(file), { code: 'ENOENT' });
  assert.ok(authorizedMutations.some((request) => request.operation === 'delete'
    && request.paths.length === 1 && request.paths[0] === 'sample.txt'
    && request.deleteConfirmationRequired === true));
  await agent.undo(deletedProposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');

  const renamedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: 'diff --git a/sample.txt b/renamed.txt\nsimilarity index 100%\nrename from sample.txt\nrename to renamed.txt\n',
  });
  assert.equal(renamedProposal.files[0].operation, 'rename');
  agent.approve(renamedProposal.taskId, owner);
  await agent.apply(renamedProposal.taskId, owner, passingVerification, null, authorizeTestMutation);
  assert.equal(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8'), 'one\ntwo\n');
  assert.ok(authorizedMutations.some((request) => request.operation === 'delete'
    && request.paths.length === 1 && request.paths[0] === 'sample.txt'
    && request.deleteConfirmationRequired === true),
  'A rename must separately authorize and confirm deletion of its source.');
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
  await agent.apply(directoryDeleteProposal.taskId, owner, passingVerification, null, authorizeTestMutation);
  await assert.rejects(() => fs.access(path.join(root, 'folder')), { code: 'ENOENT' });
  assert.ok(authorizedMutations.some((request) => request.operation === 'delete_directory'
    && request.paths.length === 1 && request.paths[0] === 'folder'
    && request.deleteConfirmationRequired === true),
  'Directory deletion must request confirmation for the exact directory target.');
  await agent.undo(directoryDeleteProposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(path.join(root, 'folder', 'nested.txt'), 'utf8'), 'nested\n');
  assert.ok(authorizedMutations.some((request) => request.operation === 'delete_directory'
    && request.paths.length === 1 && request.paths[0] === 'folder'
    && request.deleteConfirmationRequired === true),
  'Undoing a directory deletion must separately confirm any current directory removal.');

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
  const failedCreate = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/failed-create.txt\n@@ -0,0 +1,1 @@\n+temporary\n',
  });
  agent.approve(failedCreate.taskId, owner);
  await assert.rejects(
    () => agent.apply(failedCreate.taskId, owner, async () => ({
      ok: false, status: 'CODE_FAILURE', executed: true, exitCode: 1, failure: 'verification',
      attempts: [{ check: 'test', ok: false, executed: true, exitCode: 1 }],
    }), null, authorizeTestMutation),
    /Verification failed/,
  );
  await assert.rejects(() => fs.access(path.join(root, 'failed-create.txt')), { code: 'ENOENT' });

  await fs.writeFile(path.join(root, 'second.txt'), 'alpha\nbeta\n', 'utf8');
  const rollbackProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+ONE\n'
      + '--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-alpha\n+ALPHA\n',
  });
  agent.approve(rollbackProposal.taskId, owner);
  await assert.rejects(
    () => agent.apply(rollbackProposal.taskId, owner, async () => ({
      ok: false, status: 'CODE_FAILURE', executed: true, exitCode: 1, failure: 'test',
      attempts: [{ check: 'test', ok: false, executed: true, exitCode: 1 }],
    }), null, authorizeTestMutation),
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
  agent.approve(staleProposal.taskId, owner);
  await fs.writeFile(file, 'external change\n', 'utf8');
  await assert.rejects(
    () => agent.apply(staleProposal.taskId, owner, undefined, null, authorizeTestMutation),
    /Files changed after approval\./,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'external change\n', 'A stale proposal must not overwrite external changes.');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  const racedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+must-not-overwrite-race\n',
  });
  agent.approve(racedProposal.taskId, owner);
  const originalOpen = fs.open;
  let injectedConcurrentWrite = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (!injectedConcurrentWrite && String(args[0]).includes(`.developer-${racedProposal.taskId}.tmp`)) {
      injectedConcurrentWrite = true;
      await fs.writeFile(file, 'concurrent external update\n', 'utf8');
    }
    return handle;
  };
  try {
    await assert.rejects(
      () => agent.apply(racedProposal.taskId, owner, undefined, null, authorizeTestMutation),
      /changed|stale|concurrent/i,
      'A source change during temporary-file staging must abort apply.',
    );
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(injectedConcurrentWrite, true, 'The race must occur after the pre-write snapshot check.');
  assert.equal(
    await fs.readFile(file, 'utf8'),
    'one\ntwo\n',
    'A raced apply must not overwrite the concurrent change and must restore its original snapshot.',
  );
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  const tamperedProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+tampered\n',
  });
  agent.approve(tamperedProposal.taskId, owner);
  const tamperedChange = agent.getTaskForTest(tamperedProposal.taskId);
  tamperedChange.files[0].content = 'unapproved content\n';
  tamperedChange.files[0].path = 'unapproved.txt';
  tamperedChange.raw += '\n';
  await assert.rejects(
    () => agent.apply(tamperedProposal.taskId, owner, undefined, null, authorizeTestMutation),
    /manifest changed after approval/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  await assert.rejects(() => fs.access(path.join(root, 'unapproved.txt')), { code: 'ENOENT' });
  const expiredProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+expired\n',
  });
  agent.approve(expiredProposal.taskId, owner);
  agent.getTaskForTest(expiredProposal.taskId).approval.expiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(
    () => agent.apply(expiredProposal.taskId, owner, undefined, null, authorizeTestMutation),
    /approval has expired/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  const lineEndingFile = path.join(root, 'crlf.txt');
  await fs.writeFile(lineEndingFile, 'first\r\nsecond\r\n', 'utf8');
  const crlfProposal = await agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,2 +1,2 @@\n first\n-second\n+updated\n',
  });
  agent.approve(crlfProposal.taskId, owner);
  await agent.apply(crlfProposal.taskId, owner, passingVerification, null, authorizeTestMutation);
  assert.equal(await fs.readFile(lineEndingFile, 'utf8'), 'first\r\nupdated\r\n');
  await agent.undo(crlfProposal.taskId, owner, authorizeTestMutation, true);
  assert.equal(await fs.readFile(lineEndingFile, 'utf8'), 'first\r\nsecond\r\n');
  const binaryFile = path.join(root, 'binary.bin');
  await fs.writeFile(binaryFile, Buffer.from([0x41, 0x00, 0x42]));
  await assert.rejects(() => agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/binary.bin\n+++ b/binary.bin\n@@ -1 +1 @@\n-old\n+new\n',
  }), /Binary or invalid UTF-8/);
  const largeFile = path.join(root, 'large.txt');
  await fs.writeFile(largeFile, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  await assert.rejects(() => agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n-old\n+new\n',
  }), /exceeds the 2 MiB/);
  await assert.rejects(() => agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/CON.txt\n@@ -0,0 +1,1 @@\n+blocked\n',
  }), /traversal/);
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-external-'));
  const externalFile = path.join(externalRoot, 'outside.txt');
  await fs.writeFile(externalFile, 'outside\n', 'utf8');
  const linkedDirectory = path.join(root, 'linked');
  try {
    await fs.symlink(externalRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => agent.createProposal({
      root, ownerWebContentsId, sessionId,
      raw: '--- a/linked/outside.txt\n+++ b/linked/outside.txt\n@@ -1 +1 @@\n-outside\n+changed\n',
    }), /Symlink|outside the selected project/);
  } finally {
    await fs.rm(externalRoot, { recursive: true, force: true });
  }
  if (process.platform === 'win32') {
    const caseVariantProposal = await agent.createProposal({
      root, ownerWebContentsId, sessionId,
      raw: '--- a/SAMPLE.TXT\n+++ b/SAMPLE.TXT\n@@ -1 +1 @@\n-one\n+ONE\n',
    });
    agent.approve(caseVariantProposal.taskId, owner);
    await agent.apply(caseVariantProposal.taskId, owner, passingVerification, root.toUpperCase(), authorizeTestMutation);
    assert.equal(await fs.readFile(file, 'utf8'), 'ONE\ntwo\n');
    await agent.undo(caseVariantProposal.taskId, owner, authorizeTestMutation, true);
  }
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');
  await assert.rejects(() => agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/.env\n@@ -0,0 +1,1 @@\n+blocked\n',
  }), /Sensitive files/);
  await assert.rejects(() => agent.createProposal({
    root, ownerWebContentsId, sessionId,
    raw: '--- /dev/null\n+++ b/.aws/credentials\n@@ -0,0 +1,1 @@\n+blocked\n',
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
    applyFix: (id, owner) => agent.apply(id, owner, passingVerification, null, authorizeTestMutation),
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
    approveFix: (id, owner) => agent.approve(id, owner), applyFix: (id, owner) => agent.apply(id, owner, passingVerification, null, authorizeTestMutation),
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
    applyFix: (id, owner) => agent.apply(id, owner, passingVerification, null, authorizeTestMutation),
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
  assert.throws(
    () => agent.approve(durableTask.taskId, owner2),
    /Request-bound authorization is missing or no longer matches/,
    'A restored task must not reuse request authorization after its in-memory turn context is gone.',
  );
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
  const concurrentTask = await agent.createProposal({
    root, sessionId: owner2.sessionId, ownerWebContentsId: owner2.ownerWebContentsId,
    raw: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
  });
  agent.approve(concurrentTask.taskId, owner2);
  const applyResults = await Promise.allSettled([
    agent.apply(concurrentTask.taskId, owner2, passingVerification, null, authorizeTestMutation),
    agent.apply(concurrentTask.taskId, owner2, passingVerification, null, authorizeTestMutation),
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
