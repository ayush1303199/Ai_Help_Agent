import assert from 'node:assert/strict';
import {
  createUnvalidatedSuggestion,
  isUnifiedDiffResponse,
  parseUnifiedDiff,
  validateUnifiedFile,
} from '../src/features/coding/codingDiff.ts';

const original = 'function load() {\n  return query();\n}\n';
const gitDiff = [
  '--- a/modules/academic/controller.js',
  '+++ b/modules/academic/controller.js',
  '@@ -1,3 +1,3 @@',
  ' function load() {',
  '-  return query();',
  '+  return queryOnce();',
  ' }',
].join('\n');

const parsedGitDiff = parseUnifiedDiff(gitDiff);
assert.equal(parsedGitDiff.length, 1);
assert.equal(parsedGitDiff[0].path, 'modules/academic/controller.js');
assert.equal(validateUnifiedFile(parsedGitDiff[0].lines, original), true);
assert.equal(isUnifiedDiffResponse(gitDiff), true);

const plainHeaderDiff = [
  '--- modules/academic/controller.js',
  '+++ modules/academic/controller.js',
  '@@ -2 +2 @@',
  '-  return query();',
  '+  return queryOnce();',
].join('\n');
const parsedPlainHeader = parseUnifiedDiff(plainHeaderDiff);
assert.equal(parsedPlainHeader[0].path, 'modules/academic/controller.js');
assert.equal(validateUnifiedFile(parsedPlainHeader[0].lines, original), true);

const fencedDiff = `\`\`\`diff\n${gitDiff}\n\`\`\``;
assert.equal(parseUnifiedDiff(fencedDiff)[0].path, 'modules/academic/controller.js');
assert.equal(isUnifiedDiffResponse('NO_CHANGES'), true);
assert.equal(isUnifiedDiffResponse('Here is a suggestion, but no patch.'), false);
assert.equal(parseUnifiedDiff(gitDiff.replace('+++ b/modules/academic/controller.js', '+++ ../outside.js')).length, 0);
assert.equal(parseUnifiedDiff(gitDiff.replace('+++ b/modules/academic/controller.js', '+++ C:\\\\outside.js')).length, 0);

const fallback = createUnvalidatedSuggestion('Use the existing query cache for repeated academic lookups.');
assert.match(fallback, /Unvalidated model suggestion \(not a proposal\)/);
assert.match(fallback, /no proposal was created or applied/i);
assert.match(fallback, /existing query cache/);
assert.equal(createUnvalidatedSuggestion('').endsWith('The model returned no usable text suggestion.'), true);

console.log('Coding unified-diff parsing, validation, and safe fallback tests passed.');
