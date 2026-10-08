import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../electron/developerAgent.cjs';
import files from '../electron/developerFiles.cjs';

const root = await fs.mkdtemp(path.join(process.cwd(), '.developer-lifecycle-'));
const ownerWebContentsId = 9001;
const sessionId = agent.getSession(ownerWebContentsId);
const owner = { ownerWebContentsId, sessionId };
const authorizeMutation = async () => ({ allowed: true });
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

  const proposal = await agent.createProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'three'),
  });
  assert.equal(proposal.state, 'awaiting_approval');
  await assert.rejects(() => agent.apply(proposal.taskId, owner), /approved/);
  agent.approve(proposal.taskId, owner);
  const applied = await agent.apply(proposal.taskId, owner, async () => ({ ok: true, status: 'PASS' }), root, authorizeMutation);
  assert.equal(applied.state, 'completed');
  assert.equal(applied.approval.actor, 'renderer-session');
  assert.deepEqual(applied.targetFiles, ['sample.txt']);
  assert.equal((await fs.readFile(file, 'utf8')), 'one\nthree\n');
  await agent.undo(proposal.taskId, owner, authorizeMutation, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\n');

  const failed = await agent.createProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'four'),
  });
  agent.approve(failed.taskId, owner);
  const verificationError = await agent.apply(failed.taskId, owner, async () => ({
    ok: false,
    status: 'CODE_FAILURE',
    classification: 'CODE_FAILURE',
    failure: 'exit',
    attempts: [{
      check: 'typecheck',
      ok: false,
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

  const stale = await agent.createProposal({
    root, sessionId, ownerWebContentsId,
    raw: patch('sample.txt', 'one', 'five'),
  });
  await fs.writeFile(file, 'one\nchanged\n', 'utf8');
  agent.approve(stale.taskId, owner);
  await assert.rejects(() => agent.apply(stale.taskId, owner, async () => ({ ok: true, status: 'PASS' }), root, authorizeMutation), /changed after approval/);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\nchanged\n');
  await fs.writeFile(file, 'one\ntwo\n', 'utf8');

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { typecheck: 'tsc --version', lint: 'eslint --version', deploy: 'echo deploy' },
  }), 'utf8');
  await fs.mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(root, 'node_modules', '.bin', 'tsc.cmd'), '@echo 5.0.0\r\n@exit /b 0', 'utf8');
  } else {
    await fs.writeFile(path.join(root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\necho 5.0.0\nexit 0', { encoding: 'utf8', mode: 0o755 });
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
  assert.deepEqual(plan.scripts, ['typecheck', 'lint']);
  const missingPlan = await files.getVerificationScripts(ownerWebContentsId, ['test']);
  assert.deepEqual(missingPlan.missing, ['test']);
  const command = await files.runVerification('typecheck', ownerWebContentsId);
  assert.equal(command.ok, true);
  files.clearProject(ownerWebContentsId);

  const checks = await agent.runVerificationChecks({
    checks: ['typecheck', 'lint'],
    runCheck: async (script) => ({ ok: script === 'typecheck', script, exitCode: script === 'typecheck' ? 0 : 1, stderr: script === 'lint' ? 'src/App.tsx:4:2 Type error' : '' }),
  });
  assert.equal(checks.ok, false);
  assert.equal(checks.status, 'CODE_FAILURE');
  assert.equal(checks.attempts.length, 2);

  console.log('developer lifecycle tests passed');
} finally {
  try { files.clearProject(ownerWebContentsId); } catch { /* fixture may not own the project after cleanup */ }
  agent.resetForTest();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
