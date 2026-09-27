import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const {
  INTERVIEW_BACKGROUND_OPTIONS,
  INTERVIEW_DOMAIN_OPTIONS,
  chooseMicrophoneDevice,
  createCanonicalInterviewContext,
  microphoneDisplayLabel,
  normalizeMicrophoneDevices,
  normalizeInterviewContext,
} = await import('../src/ai/interviewContext.ts');
const { buildInterviewSystemPrompt, buildCanonicalInterviewSystemPrompt } = await import('../src/ai/interviewSystemPrompt.ts');
const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const meetingControllerSource = await fs.readFile(new URL('../src/features/meeting/useMeetingAssistantController.ts', import.meta.url), 'utf8');
const assistantControllerSource = await fs.readFile(new URL('../src/features/assistant/useAssistantAgentController.ts', import.meta.url), 'utf8');
const assistantRequestBuilderSource = await fs.readFile(new URL('../src/features/assistant/assistantRequestBuilder.ts', import.meta.url), 'utf8');
const meetingRequestBuilderSource = await fs.readFile(new URL('../src/features/meeting/meetingRequestBuilder.ts', import.meta.url), 'utf8');

const cases = [
  {
    domain: 'Software Engineer',
    background: ['Java', 'Spring Boot', 'MySQL', 'AWS'],
  },
  {
    domain: 'Data Scientist',
    background: ['Python', 'SQL', 'Spark', 'Kafka'],
  },
  {
    domain: 'Cloud Architect/Engineer',
    background: ['AWS', 'AWS EC2', 'AWS S3', 'AWS Lambda', 'Terraform'],
  },
];

for (const testCase of cases) {
  const prompt = buildInterviewSystemPrompt({
    currentQuestion: 'How would you approach this interview question?',
    hasCandidateContext: true,
    ...testCase,
  });
  assert.match(prompt, new RegExp(`INTERVIEW DOMAIN: ${testCase.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const item of testCase.background) assert.match(prompt, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const emptyPrompt = buildInterviewSystemPrompt({
  currentQuestion: 'What is dependency injection?',
  hasCandidateContext: false,
  domain: null,
  background: [],
});
assert.match(emptyPrompt, /INTERVIEW DOMAIN: Not specified/);
assert.match(emptyPrompt, /TECHNICAL BACKGROUND: Not specified/);
assert.match(emptyPrompt, /The message labeled CURRENT QUESTION is the primary target/);
assert.match(emptyPrompt, /Technical Background is a focus signal/);

const canonicalContext = createCanonicalInterviewContext({
  currentQuestion: '  What is dependency injection?  ',
  hasCandidateContext: true,
  domain: 'Software Engineer',
  background: ['Java', '', 'Spring Boot'],
  customPrompt: 'Prefer concise examples.',
});
assert.deepEqual(canonicalContext, {
  currentQuestion: 'What is dependency injection?',
  hasCandidateContext: true,
  domain: 'Software Engineer',
  background: ['Java', 'Spring Boot'],
  customPrompt: 'Prefer concise examples.',
});
const canonicalPrompt = buildCanonicalInterviewSystemPrompt(canonicalContext);
assert.match(canonicalPrompt, /Current user request: What is dependency injection\?/);
assert.match(canonicalPrompt, /Custom interview instruction: Prefer concise examples\./);
assert.match(canonicalPrompt, /TECHNICAL BACKGROUND: Java, Spring Boot/);

const normalized = normalizeInterviewContext({
  domain: 'Data Engineering',
  background: ['Python', 'Python', 'SQL', 'Not an option'],
  microphoneDeviceId: 'saved-microphone',
});
assert.deepEqual(normalized, {
  domain: 'Data Scientist',
  background: ['Python', 'SQL'],
  microphoneDeviceId: 'saved-microphone',
});
assert.equal(INTERVIEW_DOMAIN_OPTIONS.includes('Software Engineer'), true);
assert.equal(INTERVIEW_DOMAIN_OPTIONS.includes('Software Engineering'), false);
assert.equal(INTERVIEW_BACKGROUND_OPTIONS.includes('Spring Boot'), true);
assert.equal(INTERVIEW_BACKGROUND_OPTIONS.includes('All Technologies'), true);
assert.equal(INTERVIEW_BACKGROUND_OPTIONS.includes('Swift (iOS)'), true);
assert.equal(INTERVIEW_BACKGROUND_OPTIONS.includes('Kotlin (Android)'), true);
assert.equal(INTERVIEW_BACKGROUND_OPTIONS.includes('Dart/Flutter'), true);
const normalizedMicrophones = normalizeMicrophoneDevices([
  { deviceId: 'default', label: 'Default Microphone (AB13X USB Audio)', groupId: 'ab13x' },
  { deviceId: 'usb-ab13x', label: 'AB13X USB Audio', groupId: 'ab13x' },
  { deviceId: 'realtek', label: 'Microphone Array (2- Realtek(R) Audio)', groupId: 'realtek' },
]);
assert.deepEqual(normalizedMicrophones.map((device) => device.deviceId), ['usb-ab13x', 'realtek']);
assert.equal(normalizedMicrophones[0].isDefault, true);
assert.equal(normalizedMicrophones[0].deviceId, 'usb-ab13x');
assert.deepEqual(
  normalizeMicrophoneDevices([
    { deviceId: 'default', label: 'Default - AB13X USB Audio' },
    { deviceId: 'usb-ab13x', label: 'AB13X USB Audio' },
  ]).map((device) => device.deviceId),
  ['usb-ab13x'],
);
assert.deepEqual(
  normalizeMicrophoneDevices([
    { deviceId: 'mic-a', label: 'Shared label', groupId: 'group-a' },
    { deviceId: 'mic-b', label: 'Shared label', groupId: 'group-b' },
  ]).map((device) => device.deviceId),
  ['mic-a', 'mic-b'],
);
assert.equal(
  chooseMicrophoneDevice([
    { deviceId: 'default', label: 'Default' },
    { deviceId: 'usb', label: 'AB13X USB Audio' },
  ], 'missing'),
  'usb',
);
assert.equal(
  chooseMicrophoneDevice([
    { deviceId: 'default', label: 'Default' },
    { deviceId: 'usb', label: 'USB microphone' },
  ], 'usb'),
  'usb',
);
assert.equal(
  chooseMicrophoneDevice([{ deviceId: 'first', label: '' }], 'missing'),
  'first',
);
assert.equal(chooseMicrophoneDevice([], 'saved'), null);
assert.equal(microphoneDisplayLabel(null), 'Microphone unavailable');
assert.match(microphoneDisplayLabel({ deviceId: 'usb', label: 'AB13X USB Audio' }), /AB13X USB Audio/);
assert.match(appSource, /readPersistedInterviewContext\(\)/);
assert.match(appSource, /writePersistedInterviewContext\(interviewConfig\)/);
assert.match(meetingControllerSource, /normalizeMicrophoneDevices\(/);
assert.match(appSource, />Background<\/label>/);
assert.match(meetingControllerSource, /enumerateDevices\(\)/);
assert.match(meetingControllerSource, /deviceId: \{ exact: microphoneDeviceId \}/);
assert.match(meetingControllerSource, /deviceId: \{ exact: fallbackDeviceId \}/);
assert.match(assistantRequestBuilderSource, /microphoneConfigured: Boolean\(context\.interviewConfig\.microphoneDeviceId\)/);
assert.match(assistantRequestBuilderSource, /microphoneDevicePresent: context\.microphoneDevicePresent/);
assert.match(assistantRequestBuilderSource, /contextCharBudget: context\.contextCharBudget/);
assert.match(assistantRequestBuilderSource, /profileCharBudget: context\.contextCharBudget/);
assert.match(meetingRequestBuilderSource, /microphoneConfigured: Boolean\(context\.interviewConfig\.microphoneDeviceId\)/);
assert.match(meetingRequestBuilderSource, /microphoneDevicePresent: context\.microphoneDevicePresent/);
assert.match(meetingRequestBuilderSource, /contextCharBudget: context\.contextCharBudget/);
assert.match(meetingRequestBuilderSource, /profileCharBudget: context\.contextCharBudget/);
assert.match(appSource, /const microphoneDevicePresent = meetingController\?\.microphoneDevicePresent \?\? false/);
assert.match(appSource, /Math\.floor\(MAX_CONTEXT_CHARS \* runtimeConfig\.limits\.pdfContextBudgetRatio\)/);

console.log(JSON.stringify({
  interviewContext: true,
  domains: cases.length,
  deduplication: true,
  persistence: true,
  microphoneSelection: true,
  emptyContextRegression: true,
}));
