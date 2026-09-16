import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const transcriptUtils = await import('../src/audio/transcriptUtils.ts');
const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

assert.equal(transcriptUtils.cleanTranscript(' um how are you'), 'how are you?');
assert.deepEqual(transcriptUtils.detectQuestion('How are you?'), {
  isQuestion: true,
  question: 'How are you?',
});
assert.equal(transcriptUtils.voiceSafeText('  a   complete   answer  '), 'a complete answer');

assert.match(appSource, /type AppMode = 'assistant' \| 'developer' \| 'general';/);
assert.match(appSource, /useState<AppMode>\('assistant'\)/);
assert.match(appSource, /setAppMode\('assistant'\)/);
assert.match(appSource, /setAppMode\('developer'\)/);
assert.match(appSource, /setAppMode\('general'\)/);
assert.match(appSource, /\{appMode === 'general' \?[\s\S]+appMode === 'developer' \?/);
assert.match(appSource, /const \[messages, setMessages\]/);
assert.match(appSource, /const \[developerMessages, setDeveloperMessages\]/);
assert.match(appSource, /const \[generalTask, setGeneralTask\]/);

const generalBranch = appSource.indexOf("{appMode === 'general' ?");
const developerBranch = appSource.indexOf(") : appMode === 'developer' ?");
const assistantCapture = appSource.lastIndexOf('startMeetingCapture()');
assert.ok(generalBranch >= 0 && developerBranch > generalBranch, 'application modes must have isolated render branches');
assert.ok(assistantCapture > developerBranch, 'Assistant capture controls must remain in the Assistant render branch');

console.log(JSON.stringify({
  smoke: 'assistant-mode',
  transcriptPipeline: true,
  modeSwitches: ['assistant', 'developer', 'general'],
  stateIsolation: true,
  audioCaptureAssistantOnly: true,
}));
