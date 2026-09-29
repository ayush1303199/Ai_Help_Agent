import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const transcriptUtils = await import('../src/audio/transcriptUtils.ts');
const meetingTranscriptQuality = await import('../src/features/meeting/meetingTranscriptQuality.ts');
const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appTypesSource = await fs.readFile(new URL('../src/app/appTypes.ts', import.meta.url), 'utf8');
const modeControlsSource = await fs.readFile(new URL('../src/ui/header/ModeControls.tsx', import.meta.url), 'utf8');
const meetingWorkspaceSource = await fs.readFile(new URL('../src/features/meeting/MeetingAssistantWorkspace.tsx', import.meta.url), 'utf8');
const meetingPageSource = await fs.readFile(new URL('../src/features/meeting/MeetingAssistantPage.tsx', import.meta.url), 'utf8');
const meetingControllerSource = await fs.readFile(new URL('../src/features/meeting/useMeetingAssistantController.ts', import.meta.url), 'utf8');
const meetingSttErrorSource = await fs.readFile(new URL('../src/features/meeting/meetingSttError.ts', import.meta.url), 'utf8');
const meetingAudioSourcesSource = await fs.readFile(new URL('../src/features/meeting/useMeetingAudioSources.ts', import.meta.url), 'utf8');
const meetingCaptureLifecycleSource = await fs.readFile(new URL('../src/features/meeting/meetingCaptureLifecycle.ts', import.meta.url), 'utf8');
const meetingSttSegmentProcessorSource = await fs.readFile(new URL('../src/features/meeting/meetingSttSegmentProcessor.ts', import.meta.url), 'utf8');
const meetingTranscriptHistorySource = await fs.readFile(new URL('../src/features/meeting/useMeetingTranscriptHistory.ts', import.meta.url), 'utf8');
const meetingTransportSource = await fs.readFile(new URL('../src/features/meeting/meetingTransport.ts', import.meta.url), 'utf8');
const historyServiceSource = await fs.readFile(new URL('../src/history/historyService.ts', import.meta.url), 'utf8');
const assistantControllerSource = await fs.readFile(new URL('../src/features/assistant/useAssistantAgentController.ts', import.meta.url), 'utf8');
const assistantTransportSource = await fs.readFile(new URL('../src/features/assistant/assistantTransport.ts', import.meta.url), 'utf8');
const codingPageSource = await fs.readFile(new URL('../src/features/coding/CodingAgentPage.tsx', import.meta.url), 'utf8');
const generalPageSource = await fs.readFile(new URL('../src/features/general/GeneralAgentPage.tsx', import.meta.url), 'utf8');
const generalControllerSource = await fs.readFile(new URL('../src/features/general/useGeneralAgentController.ts', import.meta.url), 'utf8');
const assistantPageSource = await fs.readFile(new URL('../src/features/assistant/AssistantAgentPage.tsx', import.meta.url), 'utf8');
const assistantRequestBuilderSource = await fs.readFile(new URL('../src/features/assistant/assistantRequestBuilder.ts', import.meta.url), 'utf8');
const meetingRequestBuilderSource = await fs.readFile(new URL('../src/features/meeting/meetingRequestBuilder.ts', import.meta.url), 'utf8');
const assistantOverlaySource = await fs.readFile(new URL('../src/features/assistant/AssistantOverlayBridge.tsx', import.meta.url), 'utf8');
const electronMainSource = await fs.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const screenReaderSource = await fs.readFile(new URL('../src/features/screen-reading/useScreenReader.ts', import.meta.url), 'utf8');
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
assert.equal(transcriptUtils.prepareQuestion('hi').acceptedQuestion, null, 'spoken-input filtering must still reject filler-like short utterances');
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
assert.equal(
  meetingTranscriptQuality.hasRepeatedSpeechLoop('It is very clear, very clear, very clear, very clear.'),
  true,
);
assert.equal(
  meetingTranscriptQuality.hasRepeatedSpeechLoop('And the answer is clear. And the answer is clear. So let us go. And the answer is clear. And the answer is clear.'),
  true,
);
assert.equal(meetingTranscriptQuality.hasRepeatedSpeechLoop('Thank you. What is JavaScript?'), false);
assert.equal(meetingTranscriptQuality.shouldBufferShortTranscript('haan', 2200, 1800, 2, 5000), true);
assert.equal(meetingTranscriptQuality.shouldBufferShortTranscript('haan', 1500, 1800, 2, 5000), false);
assert.equal(meetingTranscriptQuality.shouldBufferShortTranscript('haan', 5200, 1800, 2, 5000), false);
assert.equal(meetingTranscriptQuality.shouldBufferShortTranscript('What is JavaScript?', 2200, 1800, 2, 5000), false);
assert.equal(meetingTranscriptQuality.shouldBufferShortTranscript('Java and Spring', 2200, 1800, 2, 5000), false);
assert.equal(
  meetingTranscriptQuality.joinShortTranscriptContinuation('Java', 'What does it do?'),
  'Java What does it do?',
);
assert.equal(meetingTranscriptQuality.hasMeetingRequestIntent('The first time we saw the word is uncertain.'), false);
assert.equal(meetingTranscriptQuality.hasMeetingRequestIntent('haan'), false);
assert.equal(meetingTranscriptQuality.hasMeetingRequestIntent('Thank you. What is JavaScript?'), true);
assert.equal(meetingTranscriptQuality.hasMeetingRequestIntent('I need help debugging this code.'), true);
assert.equal(meetingTranscriptQuality.hasMeetingRequestIntent('Do it to yourself?'), true);
assert.equal(transcriptUtils.prepareQuestion('Do it to yourself?').acceptedQuestion, 'Do it to yourself?');

assert.match(appTypesSource, /export type AppMode = 'assistant' \| 'meeting' \| 'developer' \| 'general';/);
assert.match(appSource, /useState<AppMode>\('assistant'\)/);
assert.match(modeControlsSource, /onAppModeChange\('assistant'\)/);
assert.match(modeControlsSource, /onAppModeChange\('meeting'\)/);
assert.match(modeControlsSource, /onAppModeChange\('developer'\)/);
assert.match(modeControlsSource, /onAppModeChange\('general'\)/);
assert.match(appSource, /<GeneralAgentPage[\s\S]*active=\{appMode === 'general'\}/);
assert.match(generalPageSource, /useGeneralAgentController\(\{ providerId \}\)/);
assert.doesNotMatch(appSource, /useGeneralAgentController/);
assert.doesNotMatch(appSource, /runGeneralAgentRequest|pendingGeneralRequestIdsRef|type: 'chat',\s*mode: 'general'/);
assert.match(appSource, /onHistoryEntry=\{addGeneralHistoryEntry\}/, 'General history must cross the page boundary as a completed history entry.');
assert.doesNotMatch(appSource, /useMeetingAssistantController/);
assert.match(appSource, /<MeetingAssistantPage/);
assert.match(appSource, /active=\{appMode === 'meeting'\}/);
assert.match(appSource, /requestContext=\{meetingRequestContext\}/);
assert.match(appSource, /requestContext=\{assistantRequestContext\}/);
assert.match(appSource, /onHistoryEntries=\{addAssistantHistoryEntries\}/);
assert.match(meetingControllerSource, /sendTypedQuestion/);
assert.match(meetingControllerSource, /sendTypedQuestion = \(\) => void sendQuestion\(input, \{ preparedQuestion: prepareTextRequest\(input\) \}\)/);
assert.match(meetingControllerSource, /useMeetingAudioSources/);
assert.match(meetingControllerSource, /useMeetingTranscriptHistory/);
assert.match(meetingControllerSource, /new MeetingAgentTransport\(\)/);
assert.match(meetingPageSource, /controller\.pendingTranscriptReviews\.length > 0/, 'Queued transcript reviews must stay visible after capture stops.');
assert.match(meetingControllerSource, /transport\.send\([\s\S]*?buildChatRequest\([\s\S]*?abortController\.signal/);
assert.match(meetingSttSegmentProcessorSource, /REPEATED_SPEECH_LOOP_REJECTED/);
assert.match(meetingSttSegmentProcessorSource, /SHORT_TRANSCRIPT_WAITING_FOR_CONTINUATION/);
assert.match(meetingSttSegmentProcessorSource, /joinQuestionContinuation\(pendingQuestion, normalizedTranscript/);
assert.match(meetingSttSegmentProcessorSource, /shouldBufferShortTranscript\(/);
assert.ok(
  meetingSttSegmentProcessorSource.indexOf('prepareQuestion(candidateText')
    < meetingSttSegmentProcessorSource.indexOf('if (!hasMeetingRequestIntent(candidateText))'),
  'Incomplete transcript continuation must be evaluated before rejecting missing request intent.',
);
assert.match(meetingSttSegmentProcessorSource, /source: meetingAudioMode === 'microphone'/);
assert.match(meetingSttSegmentProcessorSource, /setAnswerPending\(true\)/);
assert.match(meetingSttSegmentProcessorSource, /setDisplayedQuestion\(candidateText\)/);
assert.match(meetingControllerSource, /lastQuestion: displayedQuestion \|\|/);
assert.match(meetingControllerSource, /setDisplayedAnswer\(result\.content\)/);
assert.match(meetingControllerSource, /!answerPending && answeredSegments\.length/);
assert.match(meetingTransportSource, /agent: 'meeting'/);
assert.doesNotMatch(appSource, /transcribeAudioSegment|MediaRecorder|getUserMedia|segmentProcessorRef|captureSessionIdRef|pendingPartialQuestionRef/);
assert.match(codingPageSource, /from '\.\/CodingAgentWorkspace'/);
assert.match(codingPageSource, /<CodingAgentWorkspace[\s\S]*\{\.\.\.workspace\}/);
assert.match(generalPageSource, /from '\.\/GeneralAgentWorkspace'/);
assert.match(generalPageSource, /useGeneralAgentController\(\{ providerId \}\)/);
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
assert.match(meetingPageSource, /useMeetingAssistantController\(/);
assert.match(assistantPageSource, /sendMessage,/);
assert.doesNotMatch(appSource, /sendMeetingQuestion/);
assert.doesNotMatch(appSource, /generalAnswer \|\| assistantAnswer/);
assert.match(appSource, /onAppModeChange=\{setAppMode\}/);
assert.match(codingPageSource, /useCodingAgentController\(/);
assert.doesNotMatch(appSource, /useCodingAgentController/);
assert.match(interviewPromptSource, /## Source priority and grounding/);
assert.match(interviewPromptSource, /## Candidate interview persona/);
assert.match(interviewPromptSource, /## Technical answers/);
assert.match(interviewPromptSource, /## Question fidelity and response quality/);
assert.match(assistantRequestBuilderSource, /buildCanonicalInterviewSystemPrompt\(/);
assert.match(meetingRequestBuilderSource, /buildCanonicalInterviewSystemPrompt\(/);
assert.match(assistantOverlaySource, /question,\s*analysis:/);

assert.match(appSource, /active=\{appMode === 'general'\}/);
assert.match(appSource, /active=\{appMode === 'developer'\}/);
assert.match(appSource, /active=\{appMode === 'meeting'\}/);
assert.match(appSource, /active=\{appMode === 'assistant'\}/);
assert.match(assistantRequestBuilderSource, /CURRENT QUESTION:/);
assert.match(assistantRequestBuilderSource, /DIRECT MODE ACTIVE CONTEXT:/);
assert.match(interviewPromptSource, /do not say "I am ChatGPT"/i);
const meetingVoiceProcessorStart = meetingSttSegmentProcessorSource.indexOf('return async (');
const meetingVoiceProcessorEnd = meetingSttSegmentProcessorSource.length;
const meetingVoiceProcessor = meetingSttSegmentProcessorSource.slice(meetingVoiceProcessorStart, meetingVoiceProcessorEnd);
assert.ok(meetingVoiceProcessorStart >= 0 && meetingVoiceProcessorEnd > meetingVoiceProcessorStart);
assert.doesNotMatch(meetingVoiceProcessor, /shouldAcceptQuestion/);
assert.match(meetingVoiceProcessor, /onStatus\(''\);\s*setPipelineStatus\('question'\)/);
assert.match(meetingSttSegmentProcessorSource, /rawText: candidateRawText/);
assert.match(assistantControllerSource, /releaseAcceptedQuestion/);
assert.match(appTypesSource, /export type MeetingAudioMode = 'microphone' \| 'system' \| 'meeting';/);
assert.match(meetingAudioSourcesSource, /const microphoneAudio = meetingAudioMode !== 'system';/);
assert.match(meetingAudioSourcesSource, /const systemAudioRequested = meetingAudioMode !== 'microphone';/);
assert.match(meetingWorkspaceSource, /System \/ Internal Audio \(meeting sound\)/);
assert.doesNotMatch(meetingWorkspaceSource, /Click a website button or result|Review click/);
assert.match(meetingWorkspaceSource, /Ask the assistant\.\.\./);
assert.ok(
  meetingWorkspaceSource.indexOf('placeholder="Ask the assistant..."')
    < meetingWorkspaceSource.indexOf('if (!sessionActive)'),
  'The Meeting question composer must be defined before both the idle and active workspace layouts.',
);
assert.doesNotMatch(appSource, /browserClickTarget|requestBrowserButtonClick/);
assert.doesNotMatch(electronMainSource, /browser:click-confirmed-target|browserClickService|Confirm browser click/);
assert.match(meetingControllerSource, /Microphone and system audio connected/);
assert.match(meetingControllerSource, /System audio connected/);
assert.match(meetingAudioSourcesSource, /SYSTEM_AUDIO_UNAVAILABLE/);
assert.doesNotMatch(meetingAudioSourcesSource, /SYSTEM_AUDIO_OPTIONAL_UNAVAILABLE/);
assert.match(meetingAudioSourcesSource, /selectedDeviceConfigured/);
assert.match(meetingAudioSourcesSource, /selectedDevicePresent/);
assert.match(meetingControllerSource, /displayedAudioSourceLabel/);
assert.match(meetingControllerSource, /displayedAudioStatus/);
assert.match(meetingControllerSource, /const stopMeetingCapture = \(\) =>/);
assert.match(meetingControllerSource, /meetingCaptureStartDecision\(/);
assert.match(meetingCaptureLifecycleSource, /startInProgress \|\| activeSessionId !== ''/);
assert.match(meetingControllerSource, /captureStartGenerationRef\.current \+= 1/);
assert.match(meetingControllerSource, /adaptiveSilenceTimeoutMs\(\s*SYSTEM_AUDIO_SILENCE_MS/);
assert.match(meetingControllerSource, /adaptiveAudioLevelThreshold\(SYSTEM_AUDIO_LEVEL_THRESHOLD, recentLevels\)/);
assert.match(meetingTranscriptHistorySource, /limitMeetingTranscriptHistory<MeetingTranscript>/);
assert.match(meetingTranscriptHistorySource, /meeting-transcripts/);
assert.match(meetingTranscriptHistorySource, /meeting-chat-state/);
assert.match(meetingTranscriptHistorySource, /appendAnsweredSegment/);
assert.match(meetingTranscriptHistorySource, /restoreMeetingHistory/);
assert.match(meetingControllerSource, /deleteMeetingTranscript/);
assert.match(meetingCaptureLifecycleSource, /addEventListener\('ended', handleEnded\)/);
assert.match(meetingAudioSourcesSource, /devicechange/);
assert.match(meetingControllerSource, /setAudioSignalDetected\(true\)/);
assert.match(meetingWorkspaceSource, /Edit transcript before sending/);
assert.match(meetingWorkspaceSource, /Send edited question/);
assert.match(meetingWorkspaceSource, /meetingAudioDiagnostic/);
assert.match(meetingWorkspaceSource, /Transcription language/);
assert.doesNotMatch(meetingWorkspaceSource, /Technical terms \(optional\)|Comma- or line-separated/);
assert.match(meetingSttSegmentProcessorSource, /language: transcriptionLanguage/);
assert.doesNotMatch(meetingControllerSource, /meeting-transcription-glossary|glossary: transcriptionGlossary/);
assert.match(meetingPageSource, /onScreenCaptured: async \(image\) =>[\s\S]*controller\.sendQuestion\([\s\S]*screenImage: image/);
assert.match(meetingPageSource, /mode: 'meeting'/);
assert.match(meetingPageSource, /controller\.answeredSegments\.flatMap/);
assert.match(historyServiceSource, /session\.mode === 'meeting'/);
assert.match(historyServiceSource, /readPersistedMeetingHistory/);
assert.match(historyServiceSource, /meeting-history-conversation-id/);
assert.match(appSource, /meetingController\?\.clearMeetingHistory\(\);[\s\S]*setChatHistory\(\[\]\)/, 'Deleting all shared history must clear the Meeting-only persisted copy as well.');
assert.match(appSource, /session\.mode === 'meeting'[\s\S]*meeting\.restoreMeetingHistory\(session\)/);
assert.match(meetingWorkspaceSource, /if \(!sessionActive\)[\s\S]*<ScreenReadingButton/);
assert.doesNotMatch(meetingWorkspaceSource, /Microphone device|Meeting microphone device|No microphone found/);
assert.match(meetingPageSource, /onTestAudio: \(\) => void controller\.testMeetingAudio\(\)/);
assert.match(meetingControllerSource, /const testMeetingAudio = async \(\) =>[\s\S]*requestMeetingAudioStream\('audio-test'\)/);
assert.match(meetingWorkspaceSource, /Last request: transcription/);
assert.match(meetingWorkspaceSource, /onDeleteTranscript/);
assert.match(meetingWorkspaceSource, /navigator\.clipboard\.writeText/);
assert.match(meetingWorkspaceSource, /Cancel \{chatStreaming \? 'answer' : 'transcription'\}/);
assert.match(meetingPageSource, /buildTranscriptSummaryPrompt/);
assert.match(meetingPageSource, /onOpenAudioSettings/);
assert.match(meetingPageSource, /if \(active\) return;[\s\S]*?cancelCurrentRequest\(\)/);
const meetingCaptureStart = meetingControllerSource.indexOf('const startMeetingCapture = async () =>');
const meetingCaptureReadiness = meetingControllerSource.indexOf('await refreshProviders();', meetingCaptureStart);
const meetingCaptureHealthCheck = meetingControllerSource.indexOf("fetch(`${HTTP_URL}/api/health`)", meetingCaptureStart);
assert.ok(
  meetingCaptureStart >= 0 && meetingCaptureReadiness > meetingCaptureStart && meetingCaptureHealthCheck > meetingCaptureReadiness,
  'Meeting capture must rehydrate persisted provider credentials before checking STT readiness.',
);
assert.match(meetingControllerSource, /No speech-capable provider key is available to this desktop session/);
assert.match(meetingSttErrorSource, /No enabled provider with speech-transcription support is available/);
assert.match(meetingSttErrorSource, /speech-to-text provider key is missing or was rejected/);
assert.doesNotMatch(meetingControllerSource, /The active provider does not support speech transcription/);
assert.match(meetingControllerSource, /captureSessionIdRef\.current = ''/);
assert.match(meetingAudioSourcesSource, /createDynamicsCompressor\(\)/);
assert.match(meetingAudioSourcesSource, /createBiquadFilter\(\)/);
assert.match(meetingAudioSourcesSource, /noiseSuppression: true/);
assert.match(meetingAudioSourcesSource, /echoCancellation: true/);
assert.match(meetingAudioSourcesSource, /MICROPHONE_VOICE_FILTER_ENABLED/);
assert.match(meetingControllerSource, /shouldHandleMeetingTrackEnd/);
assert.match(meetingSttSegmentProcessorSource, /shouldApplyMeetingSttResult/);
assert.match(meetingControllerSource, /meetingCaptureStartDecision/);
assert.match(meetingCaptureLifecycleSource, /classifySttClientError/);
assert.match(meetingControllerSource, /recorder\.state === 'recording'/);
assert.match(meetingControllerSource, /recorderRef\.current === recorder/);
assert.match(meetingControllerSource, /nextSegment\?\.sttSession === sttSession/);
assert.match(meetingSttSegmentProcessorSource, /STALE_STT_CALLBACK_IGNORED/);
assert.match(meetingAudioSourcesSource, /if \(audioContext\.state !== 'running'\) await audioContext\.resume\(\)/);
assert.match(meetingControllerSource, /finalCaptureSegmentClosedRef/);
assert.match(meetingControllerSource, /if \(recorder && recorder\.state === 'recording'\) \{\s*recorder\.stop\(\);/);
assert.match(meetingControllerSource, /The Meeting Assistant returned an empty answer/);
assert.match(meetingSttSegmentProcessorSource, /addTranscript\(\{\s*id: crypto\.randomUUID\(\),\s*source: meetingSource,\s*rawText: candidateRawText/);
assert.match(meetingTransportSource, /transportRequestTimeoutMs/);
const initialMeetingPageEnd = meetingWorkspaceSource.indexOf('if (!sessionActive)');
const activeMeetingPageStart = meetingWorkspaceSource.lastIndexOf('return (');
const initialMeetingPage = meetingWorkspaceSource.slice(initialMeetingPageEnd, activeMeetingPageStart);
const activeMeetingPage = meetingWorkspaceSource.slice(activeMeetingPageStart);
assert.ok(
  initialMeetingPageEnd > 0
    && activeMeetingPageStart > initialMeetingPageEnd
    && initialMeetingPage.includes('aria-label="Audio source"')
    && initialMeetingPage.includes('onTestAudio')
    && !activeMeetingPage.includes('aria-label="Audio source"')
    && !activeMeetingPage.includes('onTestAudio'),
  'Audio source selection and audio test must appear only on the initial Meeting page.',
);
assert.match(meetingWorkspaceSource, /onStartCapture/);
assert.match(meetingWorkspaceSource, /onStopCapture/);
const activeComposerIndex = meetingWorkspaceSource.indexOf('{questionComposer}', activeMeetingPageStart);
assert.ok(
  activeMeetingPageStart >= 0 && activeComposerIndex > activeMeetingPageStart,
  'The active Meeting page must continue rendering its question and answer workspace.',
);
assert.match(electronMainSource, /setDisplayMediaRequestHandler/);
assert.match(electronMainSource, /audio: 'loopback'/);
assert.match(electronMainSource, /types: \['screen'\]/);
const screenCaptureHandler = electronMainSource.slice(electronMainSource.indexOf("ipcMain.handle('screen:capture'"));
assert.match(screenCaptureHandler, /visibleWindows\.forEach\(\(window\) => window\.hide\(\)\)/);
assert.match(screenCaptureHandler, /finally\s*\{[\s\S]*window\.showInactive\(\)/);
assert.match(screenReaderSource, /if \(!window\.electronAPI\?\.captureScreen\)\s*\{\s*onError\('Screen reading is available in the Electron desktop app\.'\)/);

console.log(JSON.stringify({
  smoke: 'assistant-mode',
  transcriptPipeline: true,
  modeSwitches: ['assistant', 'meeting', 'developer', 'general'],
  stateIsolation: true,
  audioCaptureMeetingOnly: true,
  audioSources: ['microphone', 'system', 'microphone+system'],
}));
