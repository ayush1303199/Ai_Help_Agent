import assert from 'node:assert/strict';
import {
  buildOverlayActionItems,
  buildOverlayAnalysis,
  buildOverlaySummary,
} from '../src/features/overlay/overlayAnswerInsights.ts';

const answer = [
  'Use dependency injection to keep services loosely coupled. This also makes testing easier.',
  '',
  '1. Define an interface.',
  '2. Inject the implementation.',
  '',
  '```python',
  'print("This code line is not an action item")',
  '```',
].join('\n');

assert.equal(
  buildOverlaySummary(answer),
  'Use dependency injection to keep services loosely coupled. This also makes testing easier. Includes a code example.',
  'Summary should be concise and exclude code.',
);
assert.match(buildOverlayAnalysis('How does dependency injection help?', answer), /Question focus: How does dependency injection help\?/);
assert.match(buildOverlayAnalysis('How does dependency injection help?', answer), /Response type: Code solution with steps/);
assert.match(buildOverlayAnalysis('How does dependency injection help?', answer), /Key points:\n- Define an interface\.\n- Inject the implementation\./);
assert.deepEqual(buildOverlayActionItems(answer), [
  'Define an interface.',
  'Inject the implementation.',
], 'Only actual answer list items should become actions; code lines must be ignored.');

const codeOnly = '```python\nn = int(input())\nprint(n % 2 == 0)\n```';
assert.equal(buildOverlaySummary(codeOnly), 'A code solution is provided.');
assert.match(buildOverlayAnalysis('Check if a number is even.', codeOnly), /Response type: Code solution/);
assert.match(buildOverlayAnalysis('Check if a number is even.', codeOnly), /runnable code example/);
assert.deepEqual(buildOverlayActionItems(codeOnly), ['No specific action items identified in this answer.']);
assert.equal(buildOverlaySummary(''), '');
assert.equal(buildOverlayAnalysis('Question with no answer', ''), '');

const listOnly = [
  '### Process',
  '1. Validate the input.',
  '2. Compute the result.',
  '3. Return the output.',
].join('\n');
assert.equal(
  buildOverlaySummary(listOnly),
  'The answer outlines 3 steps: Validate the input.; Compute the result.',
  'List-only answers should have a readable summary.',
);
assert.match(buildOverlayAnalysis('What is the process?', listOnly), /Response type: Step-by-step answer/);
assert.match(buildOverlayAnalysis('What is the process?', listOnly), /Return the output\./);

const longAnswer = `${'This is a detailed explanation sentence. '.repeat(20)}Final unrelated detail.`;
assert.ok(buildOverlaySummary(longAnswer).length <= 280, 'Summaries should stay short enough for the Overlay.');
assert.doesNotMatch(buildOverlaySummary(longAnswer), /Final unrelated detail/);

console.log('Overlay answer insight tests passed.');
