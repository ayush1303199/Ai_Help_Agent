import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const transcriptUtils = await import('../src/audio/transcriptUtils.ts');
const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appTypesSource = await fs.readFile(new URL('../src/app/appTypes.ts', import.meta.url), 'utf8');
const modeControlsSource = await fs.readFile(new URL('../src/ui/header/ModeControls.tsx', import.meta.url), 'utf8');
const meetingWorkspaceSource = await fs.readFile(new URL('../src/features/meeting/MeetingAssistantWorkspace.tsx', import.meta.url), 'utf8');
const meetingControllerSource = await fs.readFile(new URL('../src/features/meeting/useMeetingAssistantController.ts', import.meta.url), 'utf8');
const meetingTransportSource = await fs.readFile(new URL('../src/features/meeting/meetingTransport.ts', import.meta.url), 'utf8');
const assistantControllerSource = await fs.readFile(new URL('../src/features/assistant/useAssistantAgentController.ts', import.meta.url), 'utf8');
const assistantTransportSource = await fs.readFile(new URL('../src/features/assistant/assistantTransport.ts', import.meta.url), 'utf8');
const codingPageSource = await fs.readFile(new URL('../src/features/coding/CodingAgentPage.tsx', import.meta.url), 'utf8');
const generalPageSource = await fs.readFile(new URL('../src/features/general/GeneralAgentPage.tsx', import.meta.url), 'utf8');
const generalControllerSource = await fs.readFile(new URL('../src/features/general/useGeneralAgentController.ts', import.meta.url), 'utf8');
const assistantPageSource = await fs.readFile(new URL('../src/features/assistant/AssistantAgentPage.tsx', import.meta.url), 'utf8');
const assistantOverlaySource = await fs.readFile(new URL('../src/features/assistant/AssistantOverlayBridge.tsx', import.meta.url), 'utf8');
const electronMainSource = await fs.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const interviewPromptSource = await fs.readFile(new URL('../src/ai/interviewSystemPrompt.ts', import.meta.url), 'utf8');

assert.equal(transcriptUtils.cleanTranscript(' um how are you'), 'how are you?');
assert.equal(transcriptUtils.cleanTranscript('what is spring boot'), 'what is Spring Boot?');
assert.equal(transcriptUtils.cleanTranscript('explain node.js and fastapi'), 'explain Node.js and FastAPI?');
assert.equal(transcriptUtils.cleanTranscript('Explain dependency injection in Spring.'), 'Explain dependency injection in Spring?');
assert.equal(transcriptUtils.cleanTranscript('What is Spring Boot???'), 'What is Spring Boot?');
assert.equal(transcriptUtils.cleanTranscript('What is concurrent hashmap'), 'What is ConcurrentHashMap?');
const interviewVocabulary = { supportedTerms: ['Spring Boot', 'Spring Security', 'Java'] };
assert.equal(
  transcriptUtils.cleanTranscript('What is dependency injection in the springboard', interviewVocabulary),
  'What is dependency injection in the Spring Boot?',
);
assert.equal(
  transcriptUtils.cleanTranscript('What a dependency injection in the string board', interviewVocabulary),
  'What is dependency injection in the Spring Boot?',
);
assert.equal(
  transcriptUtils.cleanTranscript('What is the tendency injection in the springboard', interviewVocabulary),
  'What is the dependency injection in the Spring Boot?',
);
assert.equal(
  transcriptUtils.cleanTranscript('What is a springboard', interviewVocabulary),
  'What is a springboard?',
);
assert.equal(
  transcriptUtils.cleanTranscript('Explain the tendency injection in the springboard', interviewVocabulary),
  'Explain the dependency injection in the Spring Boot?',
);
const rawInterviewQuestion = 'Explain my experience with Java and Spring Boot.';
const preparedInterviewQuestion = transcriptUtils.prepareQuestion(rawInterviewQuestion, interviewVocabulary);
assert.equal(preparedInterviewQuestion.rawText, rawInterviewQuestion);
assert.equal(preparedInterviewQuestion.normalizedText, 'Explain my experience with Java and Spring Boot?');
assert.equal(preparedInterviewQuestion.acceptedQuestion, 'Explain my experience with Java and Spring Boot?');
assert.equal(
  transcriptUtils.prepareQuestion('I will explain my experience with Java and Spring Boot.', interviewVocabulary).acceptedQuestion,
  null,
);
assert.doesNotMatch(await fs.readFile(new URL('../server/src/index.py', import.meta.url), 'utf8'), /Output only the transcript/);
assert.deepEqual(transcriptUtils.detectQuestion('How are you?'), {
  isQuestion: true,
  question: 'How are you?',
});
assert.deepEqual(transcriptUtils.detectQuestion('What? What?'), {
  isQuestion: false,
  question: null,
});
assert.deepEqual(transcriptUtils.detectQuestion('random unrelated words here.'), {
  isQuestion: false,
  question: null,
});
assert.deepEqual(transcriptUtils.detectQuestion('What is Java?'), {
  isQuestion: true,
  question: 'What is Java?',
});
assert.equal(transcriptUtils.prepareQuestion('uh...').qualityClassification, 'FILLER');
assert.equal(transcriptUtils.prepareQuestion('What is the difference between...').qualityClassification, 'INCOMPLETE');
assert.equal(transcriptUtils.prepareQuestion('What is Spring Boot?').acceptedQuestion, 'What is Spring Boot?');
assert.equal(transcriptUtils.prepareQuestion('Introduce yourself.').acceptedQuestion, 'Introduce yourself.');
assert.equal(transcriptUtils.prepareQuestion('Technical vocabulary. Technical vocabulary. Technical vocabulary.').qualityClassification, 'REPEATED_NOISE');
assert.equal(transcriptUtils.prepareTextRequest('Introduce yourself').acceptedQuestion, 'Introduce yourself');
assert.equal(transcriptUtils.prepareTextRequest('hi').acceptedQuestion, 'hi');
assert.equal(transcriptUtils.prepareTextRequest('weather today').acceptedQuestion, 'weather today');
assert.equal(transcriptUtils.prepareTextRequest('Explain dependency injection in Spring.').acceptedQuestion, 'Explain dependency injection in Spring?');
assert.equal(transcriptUtils.prepareQuestion('Explain artificial intelligence.').acceptedQuestion, 'Explain artificial intelligence?');
assert.equal(transcriptUtils.prepareQuestion('Tell me how Spring Boot works.').acceptedQuestion, 'Tell me how Spring Boot works?');
assert.equal(transcriptUtils.prepareQuestion('I need help debugging this code.').acceptedQuestion, 'I need help debugging this code.');
assert.equal(transcriptUtils.prepareQuestion('The first is the first.').acceptedQuestion, null);
assert.equal(
  transcriptUtils.joinQuestionContinuation('Can you explain...', 'how Spring Boot dependency injection works?'),
  'Can you explain how Spring Boot dependency injection works?',
);
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

assert.match(appTypesSource, /export type AppMode = 'assistant' \| 'meeting' \| 'developer' \| 'general';/);
assert.match(appSource, /useState<AppMode>\('assistant'\)/);
assert.match(modeControlsSource, /onAppModeChange\('assistant'\)/);
assert.match(modeControlsSource, /onAppModeChange\('meeting'\)/);
assert.match(modeControlsSource, /onAppModeChange\('developer'\)/);
assert.match(modeControlsSource, /onAppModeChange\('general'\)/);
assert.match(appSource, /<GeneralAgentPage[\s\S]*active=\{appMode === 'general'\}/);
assert.match(generalPageSource, /useGeneralAgentController\(\)/);
assert.doesNotMatch(appSource, /useGeneralAgentController/);
assert.doesNotMatch(appSource, /runGeneralAgentRequest|pendingGeneralRequestIdsRef|type: 'chat',\s*mode: 'general'/);
assert.match(appSource, /onHistoryEntry=\{addGeneralHistoryEntry\}/, 'General history must cross the page boundary as a completed history entry.');
assert.doesNotMatch(appSource, /useMeetingAssistantController/);
assert.match(appSource, /<MeetingAssistantPage/);
assert.match(appSource, /active=\{appMode === 'meeting'\}/);
assert.match(appSource, /buildChatRequest=\{buildMeetingChatRequest\}/);
assert.match(meetingControllerSource, /sendTypedQuestion/);
assert.match(meetingControllerSource, /new MeetingAgentTransport\(\)/);
assert.match(meetingControllerSource, /transport\.send\(buildChatRequest\(/);
assert.match(meetingTransportSource, /agent: 'meeting'/);
assert.doesNotMatch(appSource, /transcribeAudioSegment|MediaRecorder|getUserMedia|segmentProcessorRef|captureSessionIdRef|pendingPartialQuestionRef/);
assert.match(codingPageSource, /from '\.\/CodingAgentWorkspace'/);
assert.match(codingPageSource, /<CodingAgentWorkspace[\s\S]*\{\.\.\.workspace\}/);
assert.match(generalPageSource, /from '\.\/GeneralAgentWorkspace'/);
assert.match(generalPageSource, /useGeneralAgentController\(\)/);
assert.match(generalPageSource, /<GeneralAgentWorkspace/);
assert.match(generalControllerSource, /const \[task, setTask\] = useState<GeneralTaskState \| null>/);
assert.match(generalControllerSource, /GENERAL_WS_URL = .*\/general/);
assert.match(generalControllerSource, /new WebSocket\(GENERAL_WS_URL\)/);
assert.match(assistantPageSource, /useAssistantAgentController\(/);
assert.doesNotMatch(appSource, /useAssistantAgentController/);
assert.match(assistantControllerSource, /const \[messages, setMessages\]/);
assert.match(assistantControllerSource, /sendMessage = useCallback/);
assert.match(assistantControllerSource, /improveDraft = useCallback/);
assert.match(assistantTransportSource, /ASSISTANT_WS_URL = .*\/assistant/);
assert.match(assistantTransportSource, /agent: 'assistant'/);
assert.doesNotMatch(appSource, /new WebSocket|wsRef|ensureWs|handleWsMessage/);
assert.match(appSource, /if \(appMode === 'meeting'\)[\s\S]*sendMeetingQuestion[\s\S]*sendAssistantMessage/);
assert.doesNotMatch(appSource, /generalAnswer \|\| assistantAnswer/);
assert.match(appSource, /onAppModeChange=\{setAppMode\}/);
assert.match(codingPageSource, /useCodingAgentController\(/);
assert.doesNotMatch(appSource, /useCodingAgentController/);
assert.match(interviewPromptSource, /## Source priority and grounding/);
assert.match(interviewPromptSource, /## Candidate interview persona/);
assert.match(interviewPromptSource, /## Technical answers/);
assert.match(interviewPromptSource, /## Question fidelity and response quality/);
assert.match(appSource, /buildCanonicalInterviewSystemPrompt\(/);
assert.match(assistantOverlaySource, /question,\s*analysis:/);

assert.match(appSource, /active=\{appMode === 'general'\}/);
assert.match(appSource, /active=\{appMode === 'developer'\}/);
assert.match(appSource, /active=\{appMode === 'meeting'\}/);
assert.match(appSource, /active=\{appMode === 'assistant'\}/);
assert.match(appSource, /CURRENT QUESTION:/);
assert.match(appSource, /DIRECT MODE ACTIVE CONTEXT:/);
assert.match(interviewPromptSource, /do not say "I am ChatGPT"/i);
assert.match(meetingControllerSource, /DUPLICATE_TRANSCRIPT_IGNORED/);
assert.match(meetingControllerSource, /rawText: candidateRawText/);
assert.match(assistantControllerSource, /releaseAcceptedQuestion/);
assert.match(appTypesSource, /export type MeetingAudioMode = 'microphone' \| 'system' \| 'meeting';/);
assert.match(meetingControllerSource, /const microphoneAudio = meetingAudioMode !== 'system';/);
assert.match(meetingControllerSource, /const systemAudioRequested = meetingAudioMode !== 'microphone';/);
assert.match(meetingWorkspaceSource, /System \/ Internal Audio \(meeting sound\)/);
assert.doesNotMatch(meetingWorkspaceSource, /Click a website button or result|Review click/);
assert.match(meetingWorkspaceSource, /Ask the assistant\.\.\./);
assert.doesNotMatch(appSource, /browserClickTarget|requestBrowserButtonClick/);
assert.doesNotMatch(electronMainSource, /browser:click-confirmed-target|browserClickService|Confirm browser click/);
assert.match(meetingControllerSource, /Microphone and system audio connected/);
assert.match(meetingControllerSource, /System audio connected/);
assert.match(meetingControllerSource, /SYSTEM_AUDIO_UNAVAILABLE/);
assert.doesNotMatch(meetingControllerSource, /SYSTEM_AUDIO_OPTIONAL_UNAVAILABLE/);
assert.match(meetingControllerSource, /selectedDeviceConfigured/);
assert.match(meetingControllerSource, /selectedDevicePresent/);
assert.match(meetingControllerSource, /displayedAudioSourceLabel/);
assert.match(meetingControllerSource, /displayedAudioStatus/);
assert.match(meetingControllerSource, /const stopMeetingCapture = \(\) =>/);
assert.match(meetingControllerSource, /if \(captureActiveRef\.current \|\| captureSessionIdRef\.current\) return;/);
const meetingCaptureStart = meetingControllerSource.indexOf('const startMeetingCapture = async () =>');
const meetingCaptureReadiness = meetingControllerSource.indexOf('await refreshProviders();', meetingCaptureStart);
const meetingCaptureHealthCheck = meetingControllerSource.indexOf("fetch(`${HTTP_URL}/api/health`)", meetingCaptureStart);
assert.ok(
  meetingCaptureStart >= 0 && meetingCaptureReadiness > meetingCaptureStart && meetingCaptureHealthCheck > meetingCaptureReadiness,
  'Meeting capture must rehydrate persisted provider credentials before checking STT readiness.',
);
assert.match(meetingControllerSource, /No speech-capable provider key is available to this desktop session/);
assert.match(meetingControllerSource, /No enabled provider with speech-transcription support is available/);
assert.match(meetingControllerSource, /speech-to-text provider key is missing or was rejected/);
assert.doesNotMatch(meetingControllerSource, /The active provider does not support speech transcription/);
assert.match(meetingControllerSource, /captureSessionIdRef\.current = ''/);
assert.match(meetingControllerSource, /recorder\.state === 'recording'/);
assert.match(meetingControllerSource, /recorderRef\.current === recorder/);
assert.match(meetingControllerSource, /nextSegment\?\.sttSession === sttSession/);
assert.match(meetingControllerSource, /STALE_STT_CALLBACK_IGNORED/);
assert.match(meetingControllerSource, /setIsRecording\(false\);\s*setIsTranscribing\(false\);\s*setPipelineStatus\('stopped'\)/);
assert.match(meetingWorkspaceSource, /isRecording \|\| isTranscribing \? <button type="button" onClick=\{onStopCapture\}/);
assert.match(meetingWorkspaceSource, /<button type="button" onClick=\{onStartCapture\}[^>]*>Start Listening<\/button>/);
assert.match(electronMainSource, /setDisplayMediaRequestHandler/);
assert.match(electronMainSource, /audio: 'loopback'/);
assert.match(electronMainSource, /types: \['screen'\]/);

console.log(JSON.stringify({
  smoke: 'assistant-mode',
  transcriptPipeline: true,
  modeSwitches: ['assistant', 'meeting', 'developer', 'general'],
  stateIsolation: true,
  audioCaptureMeetingOnly: true,
  audioSources: ['microphone', 'system', 'microphone+system'],
}));
