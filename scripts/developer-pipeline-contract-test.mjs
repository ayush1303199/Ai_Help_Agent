import fs from 'node:fs';
import assert from 'node:assert/strict';
import agent from '../electron/developerAgent.cjs';

const source = fs.readFileSync('electron/main.cjs', 'utf8');

assert.match(source, /require\(['"]\.\/developerAgent\.cjs['"]\)/);
assert.match(source, /developer:proposal-create/);
assert.match(source, /developer:proposal-approve/);
assert.match(source, /developer:proposal-apply/);
assert.match(source, /developer:proposal-undo/);
assert.match(source, /developer:proposal-cancel/);
assert.deepEqual(agent.STATES.slice(0, 10), [
  'idle', 'reading', 'understanding', 'proposal_ready', 'awaiting_approval',
  'approved', 'applying', 'verifying', 'completed', 'recovering',
]);
assert.equal(agent.commandPolicy('lint').approvalRequired, true);
assert.equal(agent.commandPolicy('lint').arbitraryShell, false);
assert.throws(() => agent.commandPolicy('start-server'), /not permitted/);

console.log('Developer Agent pipeline contract passed.');
