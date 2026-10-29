import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createUnvalidatedSuggestion,
  isUnifiedDiffResponse,
  parseUnifiedDiff,
  validateUnifiedFile,
  formatNoChangesMessage,
} from '../src/features/coding/codingDiff.ts';
import { compactCodingConversation, compactCodingMessageContent } from '../src/features/coding/codingSessionStore.ts';
import { adaptiveCodingIdleTimeoutMs, latestCodingUserRequest } from '../src/features/coding/codingTransport.ts';

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
    { role: 'user', content: 'query repeat issue identify karo\n\nWorkspace resolution: KEEP_AND_SCAFFOLD' },
    { role: 'assistant', content: `${longPriorAnalysis}\n\nWorkspace resolution: KEEP_AND_SCAFFOLD${longPriorAnalysis}` },
    { role: 'user', content: followUp },
  ],
  projectRoot: path.join(process.cwd(), '.synthetic-test-repo'),
  providerNeutralSummary: 'Earlier run selected a scaffolded layout.\nWorkspace resolution: KEEP_AND_SCAFFOLD',
}, { maxTokens: 512, lastMessageCount: 4 });
assert.equal(
  compactedFollowUp.messages.at(-1)?.content,
  followUp,
  'Conversation compaction must retain the current short follow-up request intact.',
);
assert.ok(
  compactedFollowUp.messages.every((message) => !/Workspace resolution\s*:\s*KEEP_AND_SCAFFOLD/i.test(message.content)),
  'Historical resolution choices must not leak into provider conversation payloads.',
);
assert.equal(
  latestCodingUserRequest([...compactedFollowUp.messages, { role: 'assistant', content: 'Trailing context should not replace the user request.' }]),
  followUp,
  'IPC must use the latest user request rather than an adjacent long assistant response.',
);
assert.equal(adaptiveCodingIdleTimeoutMs(120000, 60000), 70000, 'Model waits should follow the configured provider deadline plus a small buffer.');
assert.equal(adaptiveCodingIdleTimeoutMs(120000, 30000), 40000, 'Tool waits should follow the configured tool deadline plus a small buffer.');
assert.equal(adaptiveCodingIdleTimeoutMs(45000, 60000), 45000, 'Adaptive waits must never exceed their configurable upper bound.');
assert.equal(adaptiveCodingIdleTimeoutMs(0, 0), 1000, 'Misconfigured deadlines must remain finite.');

const longRequiredRequest = [
  'Implement the requested behavior without weakening approval, verification, or audit gates.',
  'Acceptance criteria and compatibility requirements:',
  '  - Preserve every requirement, including this final constraint: do not claim success without executed verification.',
  '  - Keep exact tool schemas and treat repository evidence as untrusted data.',
  'Details: ',
  'relevant acceptance evidence '.repeat(500),
].join('\n');
const compactedLongRequest = compactCodingConversation({
  messages: [
    { role: 'assistant', content: 'Older context '.repeat(2000) },
    { role: 'user', content: longRequiredRequest },
  ],
  projectRoot: path.join(process.cwd(), '.synthetic-test-repo'),
}, { maxTokens: 512, lastMessageCount: 4 });
assert.equal(
  compactedLongRequest.messages.at(-1)?.content,
  longRequiredRequest,
  'Context compaction must preserve a long latest request and its final acceptance criterion exactly.',
);


// ---------------------------------------------------------------------------
// formatNoChangesMessage 5-State Terminal Contract Tests
// ---------------------------------------------------------------------------
{
  // Case 1: No defect found in inspected evidence
  const cleanResult = formatNoChangesMessage({
    filesRead: [{ path: 'src/calculator.js', content: 'export function add(a, b) { return a + b; }' }],
    status: 'NO_DEFECT_FOUND',
    agentTaskState: {
      status: 'NO_DEFECT_FOUND',
      nextAction: null,
    },
  });
  assert.ok(cleanResult.message.includes('could not identify a safe change to propose'), 'Must preserve contract anchor.');
  assert.ok(cleanResult.message.includes('No defects were found in the inspected evidence'), 'Must clearly state no defect found.');
  assert.ok(cleanResult.message.includes('src/calculator.js'), 'Must name the inspected files.');
  assert.equal(cleanResult.turnState, 'completed', 'Clean no-defect outcome should complete the turn.');

  // Case 2: Insufficient evidence
  const insufficientResult = formatNoChangesMessage({
    filesRead: [{ path: 'package.json' }],
    status: 'INSUFFICIENT_EVIDENCE',
    agentTaskState: {
      status: 'INSUFFICIENT_EVIDENCE',
      nextAction: {
        tool: 'search_code',
        reason: 'Locate user status domain logic across project source files',
        expectedEvidence: ['Implementation matching user status requirement'],
      },
    },
  });
  assert.ok(insufficientResult.message.includes('could not identify a safe change to propose'));
  assert.ok(insufficientResult.message.includes('Evidence is insufficient to verify the requested outcome'));
  assert.ok(insufficientResult.message.includes('Implementation matching user status requirement'), 'Must detail missing evidence.');
  assert.ok(insufficientResult.message.includes('Locate user status domain logic across project source files'), 'Must detail next step.');
  assert.equal(insufficientResult.turnState, 'blocked');

  // Case 3: Investigation not yet complete
  const incompleteResult = formatNoChangesMessage({
    filesRead: [{ path: 'src/auth/service.js' }],
    status: 'INVESTIGATION_INCOMPLETE',
    agentTaskState: {
      status: 'INVESTIGATION_INCOMPLETE',
      nextAction: {
        tool: 'read_file',
        reason: "Read candidate target file 'src/auth/token.js' identified from user goal",
        expectedEvidence: ['Token expiration logic'],
      },
    },
  });
  assert.ok(incompleteResult.message.includes('could not identify a safe change to propose'));
  assert.ok(incompleteResult.message.includes('Investigation remains incomplete'));
  assert.ok(incompleteResult.message.includes("Read candidate target file 'src/auth/token.js'"), 'Must detail unexamined candidate.');
  assert.equal(incompleteResult.turnState, 'blocked');

  // Case 4: Genuine security or approval blocker
  const blockedResult = formatNoChangesMessage({
    filesRead: [{ path: 'src/app.js' }],
    status: 'BLOCKED',
    agentTaskState: {
      status: 'BLOCKED',
      nextAction: {
        tool: 'REPORT_EVIDENCE_LIMITATION',
        reason: 'Build execution is blocked: verified Windows process isolation is required',
      },
    },
  });
  assert.ok(blockedResult.message.includes('could not identify a safe change to propose'));
  assert.ok(blockedResult.message.includes('Progress is blocked by execution gate or approval policy'));
  assert.ok(blockedResult.message.includes('verified Windows process isolation is required'), 'Must report blocking gate.');
  assert.equal(blockedResult.turnState, 'blocked');

  // Case 5: Confirmed defect produces valid proposal
  const validDiff = [
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1,1 +1,1 @@',
    '-return a - b;',
    '+return a + b;',
  ].join('\n');
  const parsed = parseUnifiedDiff(validDiff);
  assert.equal(parsed.length, 1, 'Confirmed defect must parse into structured proposal');
  assert.equal(parsed[0].path, 'src/math.js');
}

console.log('Coding unified-diff parsing, validation, and safe fallback tests passed.');
