import fs from 'node:fs';
import assert from 'node:assert/strict';
import agent from '../electron/developerAgent.cjs';

const source = fs.readFileSync('electron/main.cjs', 'utf8');
const agentSource = fs.readFileSync('electron/developerAgent.cjs', 'utf8');
const runtimeSettings = JSON.parse(fs.readFileSync('src/config/runtimeSettings.json', 'utf8'));

assert.match(source, /require\(['"]\.\/developerAgent\.cjs['"]\)/);
assert.match(source, /developer:proposal-create/);
assert.match(source, /developer:proposal-approve/);
assert.match(source, /developer:proposal-apply/);
assert.match(source, /developer:proposal-undo/);
assert.match(source, /developer:proposal-cancel/);
assert.equal(runtimeSettings.developer.maxVerificationAttempts, 3);
assert.equal(runtimeSettings.developer.maxAutoRepairAttempts, 3);
assert.match(source, /Number\.isSafeInteger\(runtimeSettings\.developer\.maxVerificationAttempts\)/);
assert.match(source, /runtimeSettings\.developer\.maxVerificationAttempts < 1/);
assert.match(source, /runtimeSettings\.developer\.maxAutoRepairAttempts > 3/);
assert.match(source, /autoRepairProposalScope/);
assert.match(source, /attemptCount:\s*0/);
assert.match(source, /attemptCount >= chain\.maxAttempts/);
assert.match(source, /attemptNumber = \+\+chain\.attemptCount/);
assert.match(source, /verificationConfigHash/);
assert.match(source, /repairToken/);
assert.match(source, /function activeVerificationRepairChain[\s\S]*?chain\.expiresAt <= Date\.now\(\)/);
assert.match(source, /verification-repair-cancel[\s\S]*?clearVerificationRepairChain\(chain\)/);
const conversationStart = source.slice(
  source.indexOf("ipcMain.handle('developer:conversation-start'"),
  source.indexOf("ipcMain.handle('developer:database-inspect'"),
);
assert.match(conversationStart, /payload\?\.repairToken/);
assert.match(conversationStart, /clearVerificationRepairChain\(activeChain\)/);
assert.match(conversationStart, /authorizedChain\.ownerWebContentsId !== owner\.ownerWebContentsId/);
assert.match(
  agentSource,
  /result\.status === 'PASS'[\s\S]*?result\.executed === true[\s\S]*?result\.exitCode === 0/,
  'Only an actually executed passing verification with exit code zero may complete a patch.',
);
assert.deepEqual(agent.STATES.slice(0, 10), [
  'idle', 'reading', 'understanding', 'proposal_ready', 'awaiting_approval',
  'approved', 'applying', 'verifying', 'completed', 'recovering',
]);
assert.equal(agent.commandPolicy('lint').approvalRequired, true);
assert.equal(agent.commandPolicy('lint').arbitraryShell, false);
assert.throws(() => agent.commandPolicy('start-server'), /not permitted/);

console.log('Developer Agent pipeline contract passed.');
