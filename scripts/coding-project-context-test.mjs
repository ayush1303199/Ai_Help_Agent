import assert from 'node:assert/strict';
import { hasProjectContextMismatch, projectRootsMatch } from '../src/features/coding/projectContext.ts';

assert.equal(projectRootsMatch('C:\\Projects\\Candidate', 'c:/projects/candidate/'), true);
assert.equal(projectRootsMatch('/work/project', '/work/other'), false);

assert.equal(hasProjectContextMismatch(null, null, false), false);
assert.equal(hasProjectContextMismatch('C:\\Projects\\Candidate', 'c:/projects/candidate/', true), false);
assert.equal(hasProjectContextMismatch('C:\\Projects\\Candidate', 'C:\\Projects\\Other', true), true);
assert.equal(hasProjectContextMismatch('C:\\Projects\\Candidate', null, true), true);
assert.equal(hasProjectContextMismatch('C:\\Projects\\Candidate', 'C:\\Projects\\Candidate', false), true);

console.log('Coding project context reconciliation tests passed.');
