import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createUnvalidatedSuggestion,
  isUnifiedDiffResponse,
  parseUnifiedDiff,
  validateUnifiedFile,
} from '../src/features/coding/codingDiff.ts';
import { compactCodingConversation, compactCodingMessageContent } from '../src/features/coding/codingSessionStore.ts';
import { latestCodingUserRequest } from '../src/features/coding/codingTransport.ts';

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

const addedFile = parseUnifiedDiff('--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+export {};\n');
assert.equal(addedFile[0].operation, 'create');
assert.equal(addedFile[0].path, 'src/new.ts');
assert.equal(validateUnifiedFile(addedFile[0].lines, ''), true);

const removedFile = parseUnifiedDiff('--- a/src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n');
assert.equal(removedFile[0].operation, 'delete');
assert.equal(removedFile[0].path, 'src/old.ts');
assert.equal(validateUnifiedFile(removedFile[0].lines, 'old'), true);

const renamedFiles = parseUnifiedDiff([
  'diff --git a/src/old.ts b/src/new.ts',
  'similarity index 100%',
  'rename from src/old.ts',
  'rename to src/new.ts',
  'diff --git a/src/next.ts b/src/final.ts',
  'similarity index 100%',
  'rename from src/next.ts',
  'rename to src/final.ts',
].join('\n'));
assert.equal(renamedFiles.length, 2);
assert.equal(renamedFiles[0].operation, 'rename');
assert.equal(renamedFiles[0].sourcePath, 'src/old.ts');
assert.equal(renamedFiles[1].path, 'src/final.ts');
assert.equal(isUnifiedDiffResponse('*** Delete Directory: src/unused\n'), true);

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

const longPriorAnalysis = `AdmOuPrgList.php query analysis\n${'| column | explanation |\\n|---|---|\\n| duplicate query | inspect the controller |\\n'.repeat(120)}`;
const boundedPriorAnalysis = compactCodingMessageContent(longPriorAnalysis, 900);
assert.ok(boundedPriorAnalysis.length <= 900, 'Long prior Coding answers must be bounded before reuse.');
assert.match(boundedPriorAnalysis, /AdmOuPrgList\.php query analysis/, 'Compaction should preserve the prior answer introduction.');
assert.match(boundedPriorAnalysis, /duplicate query \| inspect the controller/, 'Compaction should preserve recent analysis details.');

const followUp = 'is fix ka proposal banao';
const compactedFollowUp = compactCodingConversation({
  messages: [
    { role: 'user', content: 'query repeat issue identify karo' },
    { role: 'assistant', content: `${longPriorAnalysis}${longPriorAnalysis}` },
    { role: 'user', content: followUp },
  ],
  projectRoot: path.join(process.cwd(), '.synthetic-test-repo'),
}, { maxTokens: 512, lastMessageCount: 4 });
assert.equal(
  compactedFollowUp.messages.at(-1)?.content,
  followUp,
  'Conversation compaction must retain the current short follow-up request intact.',
);
assert.equal(
  latestCodingUserRequest([...compactedFollowUp.messages, { role: 'assistant', content: 'Trailing context should not replace the user request.' }]),
  followUp,
  'IPC must use the latest user request rather than an adjacent long assistant response.',
);

console.log('Coding unified-diff parsing, validation, and safe fallback tests passed.');
