import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const transcriptUtils = await import('../src/audio/transcriptUtils.ts');
const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

assert.equal(transcriptUtils.cleanTranscript(' um how are you'), 'how are you?');
assert.equal(transcriptUtils.cleanTranscript('what is spring boot'), 'what is Spring Boot?');
assert.equal(transcriptUtils.cleanTranscript('explain node.js and fastapi'), 'explain Node.js and FastAPI?');
assert.equal(transcriptUtils.cleanTranscript('Explain dependency injection in Spring.'), 'Explain dependency injection in Spring?');
assert.equal(transcriptUtils.cleanTranscript('What is Spring Boot???'), 'What is Spring Boot?');
assert.equal(transcriptUtils.cleanTranscript('What is concurrent hashmap'), 'What is ConcurrentHashMap?');
assert.doesNotMatch(await fs.readFile(new URL('../server/src/index.py', import.meta.url), 'utf8'), /Output only the transcript/);
assert.deepEqual(transcriptUtils.detectQuestion('How are you?'), {
  isQuestion: true,
  question: 'How are you?',
});
assert.deepEqual(transcriptUtils.detectQuestion('What? What?'), {
  isQuestion: false,
  question: null,
});
assert.equal(transcriptUtils.prepareQuestion('uh...').qualityClassification, 'FILLER');
assert.equal(transcriptUtils.prepareQuestion('What is the difference between...').qualityClassification, 'INCOMPLETE');
assert.equal(transcriptUtils.prepareQuestion('What is Spring Boot?').acceptedQuestion, 'What is Spring Boot?');
assert.equal(transcriptUtils.prepareTextRequest('Introduce yourself').acceptedQuestion, 'Introduce yourself');
assert.equal(transcriptUtils.prepareTextRequest('Explain dependency injection in Spring.').acceptedQuestion, 'Explain dependency injection in Spring?');
assert.equal(
  transcriptUtils.joinQuestionContinuation(
    'What is the difference between...',
    'HashMap and ConcurrentHashMap?',
  ),
  'What is the difference between HashMap and ConcurrentHashMap?',
);
assert.equal(
  transcriptUtils.questionFingerprintForComparison(' What is Spring Boot??? '),
  'what is spring boot',
);
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
assert.match(appSource, /Answer policy:/);
assert.match(appSource, /question: latestQuestion/);

const generalBranch = appSource.indexOf("{appMode === 'general' ?");
const developerBranch = appSource.indexOf(") : appMode === 'developer' ?");
const assistantCapture = appSource.lastIndexOf('startMeetingCapture()');
assert.ok(generalBranch >= 0 && developerBranch > generalBranch, 'application modes must have isolated render branches');
assert.ok(assistantCapture > developerBranch, 'Assistant capture controls must remain in the Assistant render branch');
assert.match(appSource, /CURRENT QUESTION:/);
assert.match(appSource, /DUPLICATE_TRANSCRIPT_IGNORED/);
assert.match(appSource, /rawText: candidateRawText/);

console.log(JSON.stringify({
  smoke: 'assistant-mode',
  transcriptPipeline: true,
  modeSwitches: ['assistant', 'developer', 'general'],
  stateIsolation: true,
  audioCaptureAssistantOnly: true,
}));
