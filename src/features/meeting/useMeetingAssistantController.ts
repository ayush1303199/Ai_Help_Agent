import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { prepareQuestion, prepareTextRequest, type PreparedQuestion } from '../../audio/transcriptUtils';
import type { InterviewContextConfig } from '../../ai/interviewContext';
import type { MeetingAudioMode } from '../../app/appTypes';
import { runtimeConfig } from '../../config/runtimeConfig';
import {
  readMeetingHistoryRetention,
  type HistorySession,
} from '../../history/historyService';
import { MeetingAgentTransport, type MeetingChatMessage, type MeetingChatRequest } from './meetingTransport';
import {
  systemAudioErrorMessage,
  useMeetingAudioSources,
} from './useMeetingAudioSources';
import {
  attachMeetingTrackEndHandlers,
  classifySttClientError,
  logSttTrace,
  meetingCaptureStartDecision,
  shouldHandleMeetingTrackEnd,
} from './meetingCaptureLifecycle';
import { useMeetingTranscriptHistory } from './useMeetingTranscriptHistory';
export type { MeetingTranscript } from './useMeetingTranscriptHistory';
import { createMeetingSttSegmentProcessor } from './meetingSttSegmentProcessor';
import { meetingSttUserError } from './meetingSttError';
import {
  MAX_PENDING_TRANSCRIPT_REVIEWS,
  prunePendingTranscriptReviews,
  readPendingTranscriptReviews,
  writePendingTranscriptReviews,
} from './meetingTranscriptReviewStore';
import type { MeetingHistoryRetentionDays } from '../../history/historyService';
import {
  adaptiveAudioLevelThreshold,
  adaptiveSilenceTimeoutMs,
} from './meetingTranscriptQuality';

interface PendingAudioSegment {
  blob: Blob;
  durationMs: number;
  sttSession: string;
  continuationEligible: boolean;
}

export type MeetingTranscriptionLanguage = 'auto' | 'en' | 'hi' | 'hinglish';

export interface MeetingAssistantControllerOptions {
  interviewConfig: InterviewContextConfig;
  setInterviewConfig: Dispatch<SetStateAction<InterviewContextConfig>>;
  refreshConfiguredProviders: () => Promise<unknown>;
  shouldAcceptQuestion: (question: string) => boolean;
  buildChatRequest: (question: string, history: MeetingChatMessage[], screenImage?: string) => MeetingChatRequest;
}

const HTTP_URL = runtimeConfig.httpUrl;
// Capture starts from the authorized microphone and can also include selected
// system audio. Transcription begins only after a complete utterance ends.
const {
  systemSilenceMs: SYSTEM_AUDIO_SILENCE_MS,
  systemLevelThreshold: SYSTEM_AUDIO_LEVEL_THRESHOLD,
} = runtimeConfig.audio;

export function useMeetingAssistantController({
  interviewConfig,
  setInterviewConfig,
  refreshConfiguredProviders: refreshProviders,
  shouldAcceptQuestion,
  buildChatRequest,
}: MeetingAssistantControllerOptions) {
  const [meetingAudioMode, setMeetingAudioMode] = useState<MeetingAudioMode>('microphone');
  const [transcriptionLanguage, setTranscriptionLanguage] = useState<MeetingTranscriptionLanguage>(() => {
    try {
      const saved = localStorage.getItem('meeting-transcription-language');
      return saved === 'en' || saved === 'hi' || saved === 'hinglish' ? saved : 'auto';
    } catch {
      return 'auto';
    }
  });
  const [reviewBeforeSend, setReviewBeforeSend] = useState(() => {
    try {
      return localStorage.getItem('meeting-review-before-send') === 'true';
    } catch {
      return false;
    }
  });
  const [transcriptReviewLoad] = useState(() => readPendingTranscriptReviews(readMeetingHistoryRetention()));
  const [pendingTranscriptReviews, setPendingTranscriptReviews] = useState(transcriptReviewLoad.reviews);
  const [meetingMenuOpen, setMeetingMenuOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState<'ready' | 'listening' | 'transcribing' | 'question' | 'thinking' | 'answer' | 'error' | 'stopped'>('ready');
  const [pipelineStatusSince, setPipelineStatusSince] = useState(() => Date.now());
  const [audioSignalDetected, setAudioSignalDetected] = useState(false);
  const [lastStageTimings, setLastStageTimings] = useState<{ transcriptionMs?: number; answerMs?: number }>({});
  const [liveTranscript, setLiveTranscript] = useState('');
  const [answerPending, setAnswerPending] = useState(false);
  const {
    transcripts,
    transcriptSearch,
    setTranscriptSearch,
    answeredSegments,
    meetingConversationId,
    filteredTranscripts,
    appendAnsweredSegment,
    restoreMeetingHistory: restoreTranscriptHistory,
    addTranscript,
    deleteTranscript,
    clearMeetingHistory: clearSavedMeetingHistory,
    historyRetentionDays,
    setHistoryRetentionDays: setMeetingHistoryRetention,
  } = useMeetingTranscriptHistory(
    runtimeConfig.history.maxSessions,
    runtimeConfig.history.maxMeetingTranscripts,
  );
  const [input, setInput] = useState('');
  const [displayedQuestion, setDisplayedQuestion] = useState('');
  const [displayedAnswer, setDisplayedAnswer] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [meetingError, setMeetingError] = useState('');
  const [meetingStatusMessage, setMeetingStatusMessage] = useState('');
  const audioSources = useMeetingAudioSources({
    meetingAudioMode,
    interviewConfig,
    setInterviewConfig,
    onStatus: setMeetingStatusMessage,
  });
  const {
    microphoneDevices,
    microphoneUnavailable,
    audioSourceLabel,
    audioLevel,
    audioStatus,
    systemAudioStatus,
    microphoneStatus,
    setAudioSourceLabel,
    setAudioStatus,
    setSystemAudioStatus,
    setMicrophoneStatus,
    audioLevelRef,
    selectedMicrophone,
    selectedMicrophoneLabel,
    microphoneDevicePresent,
    configuredMicrophoneLabel,
    refreshMicrophoneDevices,
    selectMicrophoneDevice,
    requestMeetingAudioStream,
    stopAudioMonitoring,
  } = audioSources;
  const transportRef = useRef<MeetingAgentTransport | null>(null);
  const onError = setMeetingError;
  const onStatus = setMeetingStatusMessage;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const segmentSilenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentAudioContextRef = useRef<AudioContext | null>(null);
  const segmentHeardAudioRef = useRef(false);
  const speechStartedAtRef = useRef(0);
  const recentAudioLevelsRef = useRef<number[]>([]);
  const aboveThresholdSamplesRef = useRef(0);
  const segmentStartedAtRef = useRef(0);
  const captureActiveRef = useRef(false);
  const captureStartInProgressRef = useRef(false);
  const captureStartGenerationRef = useRef(0);
  const captureSessionIdRef = useRef('');
  const finalCaptureSegmentClosedRef = useRef(false);
  const pendingSegmentQueueRef = useRef<PendingAudioSegment[]>([]);
  const segmentProcessorActiveRef = useRef(false);
  const segmentProcessorRef = useRef<(() => Promise<void>) | null>(null);
  const segmentCloseInProgressRef = useRef(false);
  const requestInProgressRef = useRef(false);
  const pendingPartialQuestionRef = useRef('');
  const pendingPartialRawTextRef = useRef('');
  const pendingPartialTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureCleanupRef = useRef<(() => void) | null>(null);
  const activeSttAbortRef = useRef<AbortController | null>(null);
  const activeChatAbortRef = useRef<AbortController | null>(null);
  const answerRequestGenerationRef = useRef(0);
  const { domain, background } = interviewConfig;
  const meetingSource = meetingAudioMode === 'meeting' ? 'Microphone + System Audio' : meetingAudioMode === 'system' ? 'System Audio' : 'Microphone';
  const configuredAudioSourceLabel = meetingAudioMode === 'system' ? 'System Audio' : meetingAudioMode === 'meeting' ? `${configuredMicrophoneLabel} + System Audio` : configuredMicrophoneLabel;
  const displayedAudioSourceLabel = isRecording || audioStatus === 'connected' ? audioSourceLabel : configuredAudioSourceLabel;
  const displayedAudioStatus = audioStatus === 'testing' ? 'Testing' : isRecording ? 'Listening' : 'Ready';
  const inputQualityMessage = (classification: PreparedQuestion['qualityClassification']) => {
    if (classification === 'INCOMPLETE') return 'Please finish the request before sending it.';
    if (classification === 'FILLER' || classification === 'REPEATED_NOISE' || classification === 'NOT_A_QUESTION') {
      return 'I did not detect a complete request.';
    }
    return '';
  };

  useEffect(() => {
    setPipelineStatusSince(Date.now());
  }, [pipelineStatus]);

  useEffect(() => {
    const transport = new MeetingAgentTransport();
    transportRef.current = transport;
    return () => {
      transport.close();
      transportRef.current = null;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('meeting-transcription-language', transcriptionLanguage);
  }, [transcriptionLanguage]);
  useEffect(() => {
    localStorage.setItem('meeting-review-before-send', String(reviewBeforeSend));
  }, [reviewBeforeSend]);
  useEffect(() => {
    if (transcriptReviewLoad.error && pendingTranscriptReviews === transcriptReviewLoad.reviews) {
      setMeetingError(transcriptReviewLoad.error);
      return;
    }
    const retainedReviews = prunePendingTranscriptReviews(pendingTranscriptReviews, historyRetentionDays);
    if (retainedReviews.length !== pendingTranscriptReviews.length) {
      setPendingTranscriptReviews(retainedReviews);
      return;
    }
    if (!writePendingTranscriptReviews(retainedReviews, historyRetentionDays)) {
      setMeetingError('Pending transcript reviews could not be saved on this device. Keep this window open and check local storage.');
      return;
    }
    setMeetingError((current) => current.startsWith('Pending transcript reviews could not be saved')
      || current.startsWith('Saved transcript reviews ')
      ? ''
      : current);
  }, [historyRetentionDays, pendingTranscriptReviews, transcriptReviewLoad]);
  useEffect(() => {
    const pruneExpiredReviews = () => {
      setPendingTranscriptReviews((current) => prunePendingTranscriptReviews(current, historyRetentionDays));
    };
    const timer = window.setInterval(pruneExpiredReviews, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [historyRetentionDays]);
  const sendQuestion = async (
    rawQuestion: string,
    options: {
      preparedQuestion?: PreparedQuestion;
      screenImage?: string;
      duplicateChecked?: boolean;
      preserveTranscriptionTiming?: boolean;
    } = {},
  ): Promise<boolean> => {
    const question = rawQuestion.trim();
    if (!question || chatBusy) return false;
    const preparedQuestion = options.preparedQuestion || prepareQuestion(question);
    if (!preparedQuestion.acceptedQuestion) {
      onStatus(inputQualityMessage(preparedQuestion.qualityClassification));
      return false;
    }
    const acceptedQuestion = preparedQuestion.acceptedQuestion;
    if (!options.duplicateChecked && !shouldAcceptQuestion(acceptedQuestion)) {
      onStatus('This question was already submitted recently.');
      return false;
    }
    setDisplayedQuestion(acceptedQuestion);
    setDisplayedAnswer('');
    setAnswerPending(true);
    setInput('');
    setLiveTranscript(acceptedQuestion);
    setPipelineStatus('question');
    setChatBusy(true);
    setPipelineStatus('thinking');
    onError('');
    setLastStageTimings((current) => options.preserveTranscriptionTiming
      ? { transcriptionMs: current.transcriptionMs }
      : {});
    const answerRequestGeneration = answerRequestGenerationRef.current + 1;
    answerRequestGenerationRef.current = answerRequestGeneration;
    const abortController = new AbortController();
    activeChatAbortRef.current = abortController;
    const answerStartedAt = performance.now();
    try {
      const transport = transportRef.current;
      if (!transport) throw new Error('Meeting Assistant transport is unavailable.');
      const history = answeredSegments.flatMap((segment): MeetingChatMessage[] => [
        { role: 'user', content: segment.question },
        { role: 'assistant', content: segment.answer },
      ]);
      const result = await transport.send(
        buildChatRequest(acceptedQuestion, history, options.screenImage),
        abortController.signal,
      );
      if (answerRequestGenerationRef.current !== answerRequestGeneration) return false;
      if (!result.content.trim()) {
        throw new Error('The Meeting Assistant returned an empty answer. Please try the question again.');
      }
      setDisplayedAnswer(result.content);
      setLastStageTimings((current) => ({
        ...current,
        answerMs: Math.round(performance.now() - answerStartedAt),
      }));
      setAnswerPending(false);
      appendAnsweredSegment({ question: acceptedQuestion, answer: result.content });
      setPipelineStatus('answer');
      onStatus('');
      return true;
    } catch (failure) {
      if (answerRequestGenerationRef.current !== answerRequestGeneration) return false;
      setLastStageTimings((current) => ({
        ...current,
        answerMs: Math.round(performance.now() - answerStartedAt),
      }));
      setPipelineStatus('error');
      onError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (activeChatAbortRef.current === abortController) activeChatAbortRef.current = null;
      if (answerRequestGenerationRef.current === answerRequestGeneration) setChatBusy(false);
    }
  };

  const cancelCurrentRequest = () => {
    const cancellingTranscription = Boolean(activeSttAbortRef.current);
    const cancellingAnswer = Boolean(activeChatAbortRef.current);
    if (!cancellingTranscription && !cancellingAnswer) return false;
    pendingSegmentQueueRef.current = [];
    if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
    pendingPartialTimeoutRef.current = null;
    pendingPartialQuestionRef.current = '';
    pendingPartialRawTextRef.current = '';
    activeSttAbortRef.current?.abort();
    activeSttAbortRef.current = null;
    if (cancellingAnswer) {
      answerRequestGenerationRef.current += 1;
      activeChatAbortRef.current?.abort();
      activeChatAbortRef.current = null;
      setChatBusy(false);
      setAnswerPending(false);
    }
    setPipelineStatus(captureActiveRef.current ? 'listening' : 'stopped');
    onStatus(cancellingTranscription ? 'Transcription cancelled.' : 'Answer cancelled.');
    return true;
  };

  const sendTypedQuestion = () => void sendQuestion(input, { preparedQuestion: prepareTextRequest(input) });

  const stopMeetingCapture = () => {
    captureStartGenerationRef.current += 1;
    captureStartInProgressRef.current = false;
    const sttSession = captureSessionIdRef.current;
    const recorder = recorderRef.current;
    const stream = streamRef.current;
    logSttTrace(sttSession || 'none', 'CAPTURE_STOP_REQUESTED', {
      captureState: captureActiveRef.current ? 'live' : 'inactive',
      sessionGeneration: sttSession || 'none',
      recorderState: recorder?.state || 'missing',
      microphoneTrackCount: stream?.getAudioTracks().length || 0,
      systemAudioTrackCount: stream?.getAudioTracks().length || 0,
      stopRequested: true,
    });
    captureActiveRef.current = false;
    segmentHeardAudioRef.current = false;
    speechStartedAtRef.current = 0;
    recentAudioLevelsRef.current = [];
    aboveThresholdSamplesRef.current = 0;
    setAudioSignalDetected(false);
    finalCaptureSegmentClosedRef.current = true;
    pendingPartialQuestionRef.current = '';
    pendingPartialRawTextRef.current = '';
    if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
    pendingPartialTimeoutRef.current = null;
    if (segmentSilenceTimerRef.current) clearInterval(segmentSilenceTimerRef.current);
    segmentSilenceTimerRef.current = null;
    void segmentAudioContextRef.current?.close();
    segmentAudioContextRef.current = null;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    } else {
      finalCaptureSegmentClosedRef.current = true;
      recorderRef.current = null;
      streamRef.current = null;
      if (
        captureSessionIdRef.current === sttSession
        && !segmentProcessorActiveRef.current
        && pendingSegmentQueueRef.current.length === 0
      ) captureSessionIdRef.current = '';
      captureCleanupRef.current?.();
      captureCleanupRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      setIsRecording(false);
    }
    stopAudioMonitoring();
    setAudioStatus('disabled');
    setSystemAudioStatus('off');
    onStatus('');
    setPipelineStatus('stopped');
    setMicrophoneStatus('off');
  };

  const recordAudioStream = async (stream: MediaStream, cleanup: () => void) => {
    let cleanedUp = false;
    let removeTrackEndedListeners = () => {};
    const cleanupCapture = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      removeTrackEndedListeners();
      cleanup();
    };
    captureCleanupRef.current = cleanupCapture;
    streamRef.current = stream;
    const supportedMimeType = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
    const recorder = supportedMimeType
      ? new MediaRecorder(stream, { mimeType: supportedMimeType })
      : new MediaRecorder(stream);
    const sttSession = captureSessionIdRef.current;
    const handleTrackEnded = () => {
      if (!shouldHandleMeetingTrackEnd(captureActiveRef.current, captureSessionIdRef.current, sttSession)) return;
      const sourceName = meetingAudioMode === 'system' ? 'System audio' : 'Audio input';
      stopMeetingCapture();
      onError(`${sourceName} disconnected while listening. Reconnect the source and start listening again.`);
      onStatus('');
      setPipelineStatus('error');
    };
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.some((track) => track.readyState === 'live')) {
      cleanupCapture();
      throw new Error('Audio stream ended before recording could start. Reconnect the audio source and try again.');
    }
    removeTrackEndedListeners = attachMeetingTrackEndHandlers(
      audioTracks,
      () => shouldHandleMeetingTrackEnd(
        captureActiveRef.current,
        captureSessionIdRef.current,
        sttSession,
      ),
      handleTrackEnded,
    );
    const chunks: Blob[] = [];
    const isCurrentSession = () => captureActiveRef.current
      && captureSessionIdRef.current === sttSession
      && recorderRef.current === recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const processSegment = createMeetingSttSegmentProcessor({
      transcriptionLanguage,
      meetingAudioMode,
      meetingSource,
      background,
      domain,
      captureSessionIdRef,
      pendingPartialQuestionRef,
      pendingPartialRawTextRef,
      pendingPartialTimeoutRef,
      activeSttAbortRef,
      setLastStageTimings,
      setIsTranscribing,
      setPipelineStatus,
      setLiveTranscript,
      setDisplayedQuestion,
      setDisplayedAnswer,
      setAnswerPending,
      addTranscript,
      onStatus,
      onError,
      reviewBeforeSend,
      onReviewQuestion: (text: string) => {
        if (pendingTranscriptReviews.length >= MAX_PENDING_TRANSCRIPT_REVIEWS) {
          setMeetingError(`The review queue is full (${MAX_PENDING_TRANSCRIPT_REVIEWS} questions). Review or skip an item before capturing more questions.`);
          return;
        }
        setPendingTranscriptReviews((current) => [...current, {
          id: crypto.randomUUID(),
          text,
          createdAt: new Date().toISOString(),
        }]);
      },
      sendQuestion: async (question, options) => { await sendQuestion(question, options); },
    });

    const processPendingSegments = async () => {
      if (segmentProcessorActiveRef.current) return;
      segmentProcessorActiveRef.current = true;
      requestInProgressRef.current = true;
      try {
        while (pendingSegmentQueueRef.current.length > 0) {
          if (captureSessionIdRef.current !== sttSession) break;
          const nextSegment = pendingSegmentQueueRef.current.shift();
          if (nextSegment?.sttSession === sttSession) {
            await processSegment(nextSegment.blob, nextSegment.durationMs, nextSegment.continuationEligible, sttSession, recorder.mimeType);
          }
        }
      } finally {
        requestInProgressRef.current = false;
        segmentProcessorActiveRef.current = false;
        if (isCurrentSession()) setPipelineStatus('listening');
        if (
          !captureActiveRef.current
          && finalCaptureSegmentClosedRef.current
          && pendingSegmentQueueRef.current.length === 0
          && captureSessionIdRef.current === sttSession
        ) {
          captureSessionIdRef.current = '';
          setIsRecording(false);
          setIsTranscribing(false);
        }
        const nextProcessor = segmentProcessorRef.current;
        if (nextProcessor && nextProcessor !== processPendingSegments && captureActiveRef.current) {
          void nextProcessor();
        }
      }
    };
    segmentProcessorRef.current = processPendingSegments;

    recorder.onstop = () => {
      if (segmentCloseInProgressRef.current) {
        logSttTrace(sttSession, 'DUPLICATE_SEGMENT_CLOSE_IGNORED', {
          recorderState: recorder.state,
        });
        return;
      }
      segmentCloseInProgressRef.current = true;
      const segment = chunks.splice(0, chunks.length);
      segmentHeardAudioRef.current = false;
      speechStartedAtRef.current = 0;
      aboveThresholdSamplesRef.current = 0;
      setAudioSignalDetected(false);
      const segmentDurationMs = Math.max(0, Math.round(performance.now() - (segmentStartedAtRef.current || performance.now())));
      segmentStartedAtRef.current = 0;
      if (captureSessionIdRef.current !== sttSession || recorderRef.current !== recorder) {
        cleanupCapture();
        stream.getTracks().forEach((track) => track.stop());
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (captureSessionIdRef.current === sttSession) captureSessionIdRef.current = '';
        logSttTrace(sttSession, 'CAPTURE_STOPPED', {
          segmentDurationMs,
          clearedQueuedSegments: pendingSegmentQueueRef.current.length,
          stale: true,
        });
        return;
      }
      const continueCapture = captureActiveRef.current;
      if (continueCapture) {
        recorder.start();
        setTimeout(() => {
          if (captureSessionIdRef.current === sttSession && recorderRef.current === recorder) {
            segmentCloseInProgressRef.current = false;
          }
        }, 0);
        segmentStartedAtRef.current = performance.now();
        console.log('[CAPTURE] Utterance segment started');
      } else {
        recorderRef.current = null;
        streamRef.current = null;
        cleanupCapture();
        captureCleanupRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        setIsRecording(false);
      }
      const audioSegment = new Blob(segment, { type: recorder.mimeType || 'audio/webm' });
      if (audioSegment.size > 0) {
        logSttTrace(sttSession, 'SEGMENT_CLOSED', {
          segmentDurationMs,
          segmentBytes: audioSegment.size,
          encoding: audioSegment.type || recorder.mimeType || 'unknown',
        });
        pendingSegmentQueueRef.current.push({
          blob: audioSegment,
          durationMs: segmentDurationMs,
          sttSession,
          continuationEligible: continueCapture,
        });
        void processPendingSegments();
      } else {
        if (!continueCapture) setIsRecording(false);
        if (
          !continueCapture
          && captureSessionIdRef.current === sttSession
          && !segmentProcessorActiveRef.current
          && pendingSegmentQueueRef.current.length === 0
        ) captureSessionIdRef.current = '';
        logSttTrace(sttSession, 'SEGMENT_DISCARDED', {
          segmentDurationMs,
          segmentBytes: 0,
          classification: 'AUDIO_CAPTURE_NO_SIGNAL',
        });
      }
    };
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    if (audioContext.state !== 'running') await audioContext.resume();
    if (audioContext.state !== 'running') {
      await audioContext.close();
      throw new Error('Audio level monitoring could not start. Allow microphone access and try again.');
    }
    segmentAudioContextRef.current = audioContext;
    const samples = new Uint8Array(analyser.fftSize);
    recentAudioLevelsRef.current = [];
    aboveThresholdSamplesRef.current = 0;
    let lastAudioAt = Date.now();
    recorder.start();
    segmentCloseInProgressRef.current = false;
    captureActiveRef.current = true;
    finalCaptureSegmentClosedRef.current = false;
    segmentStartedAtRef.current = performance.now();
    logSttTrace(sttSession, 'SEGMENT_STARTED', { encoding: recorder.mimeType || 'unknown' });
    recorderRef.current = recorder;
    setLiveTranscript('');
    setAudioSignalDetected(false);
    setIsRecording(true);
    setPipelineStatus('listening');
    segmentSilenceTimerRef.current = setInterval(() => {
      if (!captureActiveRef.current || recorder.state !== 'recording') return;
      analyser.getByteTimeDomainData(samples);
      let volume = 0;
      for (const sample of samples) volume += Math.abs(sample - 128);
      volume /= samples.length;
      const recentLevels = recentAudioLevelsRef.current;
      if (!segmentHeardAudioRef.current && volume <= SYSTEM_AUDIO_LEVEL_THRESHOLD + 10) {
        recentLevels.push(volume);
        if (recentLevels.length > 40) recentLevels.shift();
      }
      const threshold = adaptiveAudioLevelThreshold(SYSTEM_AUDIO_LEVEL_THRESHOLD, recentLevels);
      if (volume > threshold) {
        aboveThresholdSamplesRef.current += 1;
      } else {
        aboveThresholdSamplesRef.current = 0;
      }
      if (aboveThresholdSamplesRef.current >= 2) {
        if (!segmentHeardAudioRef.current) {
          logSttTrace(sttSession, 'AUDIO_SIGNAL_DETECTED', {
            level: Number(volume.toFixed(2)),
            threshold: Number(threshold.toFixed(2)),
          });
          speechStartedAtRef.current = Date.now();
          setAudioSignalDetected(true);
        }
        segmentHeardAudioRef.current = true;
        lastAudioAt = Date.now();
      } else if (segmentHeardAudioRef.current
        && Date.now() - lastAudioAt >= adaptiveSilenceTimeoutMs(
          SYSTEM_AUDIO_SILENCE_MS,
          Date.now() - speechStartedAtRef.current,
        )) {
        console.log('[CAPTURE] Silence/end-of-utterance detected — flushing segment');
        recorder.stop();
      }
    }, 100);
  };

  const startMeetingCapture = async () => {
    const startDecision = meetingCaptureStartDecision(
      captureActiveRef.current,
      captureStartInProgressRef.current,
      captureSessionIdRef.current,
    );
    if (startDecision === 'already-active') return true;
    if (startDecision === 'blocked') return false;
    captureStartInProgressRef.current = true;
    const startGeneration = captureStartGenerationRef.current + 1;
    captureStartGenerationRef.current = startGeneration;
    try {
      await refreshProviders();
      if (captureStartGenerationRef.current !== startGeneration) {
        captureStartInProgressRef.current = false;
        return false;
      }
      const healthResponse = await fetch(`${HTTP_URL}/api/health`);
      const healthData = await healthResponse.json();
      if (captureStartGenerationRef.current !== startGeneration) {
        captureStartInProgressRef.current = false;
        return false;
      }
      if (!healthResponse.ok || healthData.sttReady === false) {
        onError('No speech-capable provider key is available to this desktop session. Open Settings → Configured Providers, save the key in this desktop app, then try again.');
        onStatus('');
        captureStartInProgressRef.current = false;
        return false;
      }
    } catch (error) {
      onError(`Could not verify speech transcription readiness: ${(error as Error).message}`);
      onStatus('');
      captureStartInProgressRef.current = false;
      return false;
    }
    onError('');
    pendingPartialQuestionRef.current = '';
    pendingPartialRawTextRef.current = '';
    if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
    pendingPartialTimeoutRef.current = null;
    pendingSegmentQueueRef.current = [];
    const sttSession = crypto.randomUUID();
    captureSessionIdRef.current = sttSession;
    const requestedSources = meetingAudioMode === 'microphone'
      ? ['microphone']
      : meetingAudioMode === 'system'
        ? ['system_audio']
        : ['microphone', 'system_audio'];
    logSttTrace(sttSession, 'CAPTURE_SESSION_STARTED', { requestedSources });
    onStatus(meetingAudioMode === 'microphone'
      ? 'Requesting microphone access...'
      : meetingAudioMode === 'system'
        ? 'Requesting internal system-audio access...'
        : 'Requesting microphone and internal system-audio access...');
    try {
      const capture = await requestMeetingAudioStream(captureSessionIdRef.current);
      if (captureSessionIdRef.current !== sttSession
        || captureStartGenerationRef.current !== startGeneration) {
        capture.cleanup();
        capture.stream.getTracks().forEach((track) => track.stop());
        if (!captureSessionIdRef.current) {
          stopAudioMonitoring();
          setAudioStatus('disabled');
          setSystemAudioStatus('off');
          setMicrophoneStatus('off');
          setAudioSourceLabel('Not connected');
        }
        captureStartInProgressRef.current = false;
        return false;
      }
      await recordAudioStream(capture.stream, capture.cleanup);
      captureStartInProgressRef.current = false;
      onStatus(capture.systemAudio
        ? capture.microphoneAudio
          ? 'Microphone and system audio connected. Listening is ready.'
          : 'System audio connected. Listening is ready.'
        : 'Microphone connected. Listening is ready.');
      logSttTrace(sttSession, 'AUDIO_CAPTURE_READY', {
        systemAudio: capture.systemAudio,
        audioTracks: capture.stream.getAudioTracks().length,
      });
      return true;
    } catch (err) {
      if (captureSessionIdRef.current !== sttSession) {
        captureStartInProgressRef.current = false;
        return false;
      }
      const recorder = recorderRef.current;
      captureActiveRef.current = false;
      captureStartGenerationRef.current += 1;
      captureStartInProgressRef.current = false;
      captureSessionIdRef.current = '';
      recorderRef.current = null;
      if (recorder?.state === 'recording') recorder.stop();
      captureCleanupRef.current?.();
      captureCleanupRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (segmentSilenceTimerRef.current) clearInterval(segmentSilenceTimerRef.current);
      segmentSilenceTimerRef.current = null;
      void segmentAudioContextRef.current?.close();
      segmentAudioContextRef.current = null;
      pendingSegmentQueueRef.current = [];
      stopAudioMonitoring();
      setAudioStatus('disabled');
      setSystemAudioStatus('off');
      setMicrophoneStatus('off');
      setAudioSourceLabel('Not connected');
      const classification = classifySttClientError(err);
      logSttTrace(sttSession, 'CAPTURE_SESSION_FAILED', { classification });
      onError(classification === 'AUDIO_PERMISSION'
        ? meetingSttUserError(classification, 'Microphone permission was denied or blocked.')
        : (err instanceof Error ? err.message : String(err)));
      onStatus('');
      captureStartInProgressRef.current = false;
      return false;
    }
  };

  const testMeetingAudio = async () => {
    onError('');
    const sourceLabel = meetingAudioMode === 'meeting' ? 'microphone and system audio'
      : meetingAudioMode === 'system' ? 'system audio' : 'microphone';
    onStatus(meetingAudioMode === 'system' ? 'Opening the system-audio source selector...' : 'Testing the selected microphone...');
    let capture: Awaited<ReturnType<typeof requestMeetingAudioStream>> | null = null;
    audioLevelRef.current = 0;
    try {
      capture = await requestMeetingAudioStream('audio-test');
      setAudioStatus('testing');
      if (capture.systemAudio) setSystemAudioStatus('testing');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const liveTracks = capture.stream.getAudioTracks().filter((track) => track.readyState === 'live');
      if (liveTracks.length > 0) {
        onStatus(audioLevelRef.current > 2
          ? `Audio test passed for ${sourceLabel}; sound signal detected.`
          : `The ${sourceLabel} device is connected, but no sound was detected. Speak or play audio, then test again.`);
      }
      else throw new Error(`No live audio track was detected for ${sourceLabel}.`);
    } catch (err) {
      setAudioStatus('disabled');
      setSystemAudioStatus('off');
      setMicrophoneStatus('off');
      setAudioSourceLabel('Not connected');
      onError(meetingAudioMode === 'microphone'
        ? (err instanceof Error ? err.message : 'Microphone test failed.')
        : systemAudioErrorMessage(err, 'test'));
      onStatus('');
    } finally {
      capture?.cleanup();
      capture?.stream.getTracks().forEach((track) => track.stop());
      stopAudioMonitoring();
      if (!isRecording) setAudioStatus('disabled');
      if (!isRecording) setSystemAudioStatus('off');
      if (!isRecording) setMicrophoneStatus('off');
    }
  };

  const restoreMeetingHistory = (session: HistorySession) => {
    const lastTurn = restoreTranscriptHistory(session);
    setDisplayedQuestion(lastTurn?.question || '');
    setDisplayedAnswer(lastTurn?.answer || '');
    setAnswerPending(false);
    setPipelineStatus(lastTurn ? 'answer' : 'ready');
  };

  const saveMeetingTranscript = () => {
    if (!liveTranscript.trim()) {
      onError('No transcript text has been captured yet.');
      return;
    }
    addTranscript({
      id: crypto.randomUUID(),
      source: meetingSource,
      text: liveTranscript.trim(),
      createdAt: new Date().toISOString(),
    });
    setLiveTranscript('');
  };

  const deleteMeetingTranscript = deleteTranscript;
  const setHistoryRetentionDays = (days: MeetingHistoryRetentionDays) => setMeetingHistoryRetention(days);

  const clearMeetingHistory = () => {
    cancelCurrentRequest();
    clearSavedMeetingHistory();
    setPendingTranscriptReviews([]);
    setDisplayedQuestion('');
    setDisplayedAnswer('');
    setAnswerPending(false);
    setLiveTranscript('');
    setInput('');
    onStatus('');
    onError('');
    if (!captureActiveRef.current) setPipelineStatus('ready');
  };

  const sendEditedTranscript = (text: string) => {
    const question = text.trim();
    if (!question) {
      onStatus('Enter transcript text before sending it.');
      return;
    }
    void sendQuestion(question, {
      preparedQuestion: prepareTextRequest(question),
      duplicateChecked: true,
    });
  };

  const sendReviewedTranscript = async (id: string, text: string) => {
    const sent = await sendQuestion(text, {
      preparedQuestion: prepareTextRequest(text),
      duplicateChecked: true,
    });
    if (sent) {
      setPendingTranscriptReviews((current) => current.filter((review) => review.id !== id));
    }
  };

  const skipReviewedTranscript = (id: string) => {
    setPendingTranscriptReviews((current) => current.filter((review) => review.id !== id));
  };

  useEffect(() => () => {
    captureActiveRef.current = false;
    captureSessionIdRef.current = '';
    if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
    if (segmentSilenceTimerRef.current) clearInterval(segmentSilenceTimerRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    captureCleanupRef.current?.();
    void segmentAudioContextRef.current?.close();
  }, []);

  return {
    meetingAudioMode, setMeetingAudioMode, transcriptionLanguage, setTranscriptionLanguage,
    reviewBeforeSend, setReviewBeforeSend, pendingTranscriptReviews,
    sendReviewedTranscript, skipReviewedTranscript,
    meetingMenuOpen, setMeetingMenuOpen,
    microphoneDevices, microphoneUnavailable, transcriptOpen, setTranscriptOpen,
    isRecording, isTranscribing, audioSourceLabel, audioLevel, audioStatus,
    systemAudioStatus, microphoneStatus, pipelineStatus, pipelineStatusSince,
    audioSignalDetected, lastStageTimings, setPipelineStatus,
    input, setInput, chatBusy, answeredSegments, meetingError, meetingStatusMessage,
    reportError: setMeetingError,
    lastQuestion: displayedQuestion || (answeredSegments.length ? answeredSegments[answeredSegments.length - 1].question : ''),
    lastAnswer: displayedAnswer || (!answerPending && answeredSegments.length ? answeredSegments[answeredSegments.length - 1].answer : ''),
    liveTranscript, transcripts, transcriptSearch, setTranscriptSearch, filteredTranscripts,
    selectedMicrophone, selectedMicrophoneLabel, microphoneDevicePresent, configuredMicrophoneLabel,
    displayedAudioSourceLabel, displayedAudioStatus,
    refreshMicrophoneDevices, selectMicrophoneDevice, stopMeetingCapture, startMeetingCapture,
    testMeetingAudio, restoreMeetingHistory, meetingConversationId, saveMeetingTranscript,
    deleteMeetingTranscript, clearMeetingHistory, cancelCurrentRequest, sendQuestion, sendTypedQuestion, sendEditedTranscript,
    historyRetentionDays, setHistoryRetentionDays,
  };
}
