import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { cleanTranscript, joinQuestionContinuation, prepareQuestion, type PreparedQuestion } from '../../audio/transcriptUtils.ts';
import { transcribeAudioSegment } from '../../audio/sttService.ts';
import type { SttFailureClassification } from '../../audio/sttTypes';
import type { MeetingAudioMode } from '../../app/appTypes';
import { runtimeConfig } from '../../config/runtimeConfig.ts';
import type { MeetingTranscript } from './useMeetingTranscriptHistory';
import { classifySttClientError, logSttTrace, shouldApplyMeetingSttResult } from './meetingCaptureLifecycle.ts';
import { transcribeMeetingSegmentWithRetry } from './meetingSttRetry.ts';
import { meetingSttUserError } from './meetingSttError.ts';
import {
  hasMeetingRequestIntent,
  hasRepeatedSpeechLoop,
  joinShortTranscriptContinuation,
  shouldBufferShortTranscript,
} from './meetingTranscriptQuality.ts';

const HTTP_URL = runtimeConfig.httpUrl;
const {
  systemSilenceMs: SYSTEM_AUDIO_SILENCE_MS,
  continuationTimeoutMs: AUDIO_CONTINUATION_TIMEOUT_MS,
  continuationMaxChars: AUDIO_CONTINUATION_MAX_CHARS,
  shortFragmentMaxWords: SHORT_FRAGMENT_MAX_WORDS,
  shortFragmentMaxDurationMs: SHORT_FRAGMENT_MAX_DURATION_MS,
} = runtimeConfig.audio;

type PipelineStatus = 'ready' | 'listening' | 'transcribing' | 'question' | 'thinking' | 'answer' | 'error' | 'stopped';

interface SegmentRequestOptions {
  preparedQuestion?: PreparedQuestion;
  duplicateChecked?: boolean;
  preserveTranscriptionTiming?: boolean;
}

interface MeetingSttSegmentProcessorOptions {
  transcriptionLanguage: 'auto' | 'en' | 'hi' | 'hinglish';
  meetingAudioMode: MeetingAudioMode;
  meetingSource: string;
  background: string[];
  domain: string | null;
  captureSessionIdRef: MutableRefObject<string>;
  pendingPartialQuestionRef: MutableRefObject<string>;
  pendingPartialRawTextRef: MutableRefObject<string>;
  pendingPartialTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  activeSttAbortRef: MutableRefObject<AbortController | null>;
  setLastStageTimings: Dispatch<SetStateAction<{ transcriptionMs?: number; answerMs?: number }>>;
  setIsTranscribing: Dispatch<SetStateAction<boolean>>;
  setPipelineStatus: Dispatch<SetStateAction<PipelineStatus>>;
  setLiveTranscript: Dispatch<SetStateAction<string>>;
  setDisplayedQuestion: Dispatch<SetStateAction<string>>;
  setDisplayedAnswer: Dispatch<SetStateAction<string>>;
  setAnswerPending: Dispatch<SetStateAction<boolean>>;
  addTranscript: (transcript: MeetingTranscript) => void;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  sendQuestion: (question: string, options: SegmentRequestOptions) => Promise<void>;
  transcribeAudio?: typeof transcribeAudioSegment;
}

export function createMeetingSttSegmentProcessor(options: MeetingSttSegmentProcessorOptions) {
  const {
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
    sendQuestion,
    transcribeAudio = transcribeAudioSegment,
  } = options;

  const inputQualityMessage = (classification: PreparedQuestion['qualityClassification']) => {
    if (classification === 'INCOMPLETE') return 'Please finish the request before sending it.';
    if (classification === 'FILLER' || classification === 'REPEATED_NOISE' || classification === 'NOT_A_QUESTION') {
      return 'I did not detect a complete request.';
    }
    return '';
  };

  return async (
    segment: Blob,
    segmentDurationMs: number,
    continuationEligible: boolean,
    sttSession: string,
    recorderMimeType: string,
  ) => {
    if (captureSessionIdRef.current !== sttSession) return;
    setLastStageTimings({});
    const segmentId = crypto.randomUUID();
    setIsTranscribing(true);
    setPipelineStatus('transcribing');
    const requestStartedAt = performance.now();
    const abortController = new AbortController();
    activeSttAbortRef.current = abortController;
    const payloadType = segment.type || recorderMimeType || 'unknown';
    const payloadName = /ogg/i.test(payloadType) ? 'meeting.ogg' : 'meeting.webm';
    logSttTrace(sttSession, 'STT_REQUEST_STARTED', {
      segmentId,
      segmentDurationMs,
      segmentBytes: segment.size,
      encoding: payloadType,
      recorderMimeType: recorderMimeType || 'unknown',
    });
    try {
      if (segment.size === 0) {
        throw Object.assign(new Error('No audio signal was captured.'), { classification: 'AUDIO_CAPTURE_NO_SIGNAL' });
      }
      let sttResponse: { text: string; status: number };
      try {
        const request = {
          audio: segment,
          endpoint: `${HTTP_URL}/api/transcribe-audio`,
          sessionId: sttSession,
          segmentId,
          payloadName,
          language: transcriptionLanguage,
          source: meetingAudioMode === 'microphone'
            ? 'meeting_microphone' as const
            : meetingAudioMode === 'system'
              ? 'meeting_system_audio' as const
              : 'meeting_mixed' as const,
          signal: abortController.signal,
        };
        sttResponse = await transcribeMeetingSegmentWithRetry(
          request,
          transcribeAudio,
          {
            signal: abortController.signal,
            onRetry: (retryNumber) => {
              onStatus(`Temporary transcription issue. Retrying (${retryNumber}/2)...`);
              logSttTrace(sttSession, 'STT_RETRY_SCHEDULED', { segmentId, retryNumber });
            },
          },
        );
      } catch (error) {
        if (abortController.signal.aborted) return;
        setLastStageTimings((current) => ({
          ...current,
          transcriptionMs: Math.round(performance.now() - requestStartedAt),
        }));
        const classification = ((error as { classification?: SttFailureClassification }).classification || 'STT_UNKNOWN');
        logSttTrace(sttSession, 'STT_RESPONSE_FAILED', {
          segmentId,
          status: (error as { status?: number }).status || 0,
          classification,
          durationMs: Math.round(performance.now() - requestStartedAt),
        });
        throw error;
      }
      setLastStageTimings((current) => ({
        ...current,
        transcriptionMs: Math.round(performance.now() - requestStartedAt),
      }));
      if (!shouldApplyMeetingSttResult(captureSessionIdRef.current, sttSession, abortController.signal.aborted)) {
        logSttTrace(sttSession, 'STALE_STT_CALLBACK_IGNORED', { segmentId, stopRequested: true });
        return;
      }
      const rawTranscript = sttResponse.text;
      const transcriptNormalizationContext = { supportedTerms: [...background, ...(domain ? [domain] : [])] };
      const normalizedTranscript = cleanTranscript(rawTranscript, transcriptNormalizationContext);
      logSttTrace(sttSession, 'STT_RESPONSE_RECEIVED', {
        segmentId,
        status: sttResponse.status,
        durationMs: Math.round(performance.now() - requestStartedAt),
        rawTranscriptLength: rawTranscript.length,
        normalizedTranscriptLength: normalizedTranscript.length,
      });
      if (!normalizedTranscript) {
        throw Object.assign(new Error('No speech detected.'), { classification: 'AUDIO_CAPTURE_NO_SIGNAL' });
      }
      const pendingQuestion = pendingPartialQuestionRef.current;
      const pendingRawText = pendingPartialRawTextRef.current;
      if (pendingQuestion && pendingPartialTimeoutRef.current) {
        clearTimeout(pendingPartialTimeoutRef.current);
        pendingPartialTimeoutRef.current = null;
      }
      const continuedQuestion = pendingQuestion
        ? joinQuestionContinuation(pendingQuestion, normalizedTranscript, transcriptNormalizationContext)
          || joinShortTranscriptContinuation(pendingQuestion, normalizedTranscript)
        : null;
      const candidateText = continuedQuestion || normalizedTranscript;
      const candidateRawText = continuedQuestion && pendingRawText
        ? `${pendingRawText} ${rawTranscript}`.replace(/\s+/g, ' ').trim()
        : rawTranscript;
      const bufferShortTranscript = () => {
        if (!continuationEligible || !shouldBufferShortTranscript(
          candidateText,
          segmentDurationMs,
          SYSTEM_AUDIO_SILENCE_MS,
          SHORT_FRAGMENT_MAX_WORDS,
          SHORT_FRAGMENT_MAX_DURATION_MS,
        )) return false;
        pendingPartialQuestionRef.current = candidateText;
        pendingPartialRawTextRef.current = candidateRawText;
        pendingPartialTimeoutRef.current = setTimeout(() => {
          if (captureSessionIdRef.current !== sttSession
            || pendingPartialQuestionRef.current !== candidateText) return;
          pendingPartialQuestionRef.current = '';
          pendingPartialRawTextRef.current = '';
          pendingPartialTimeoutRef.current = null;
          onStatus('Short speech was saved. Ask a complete question to get an AI answer.');
          logSttTrace(sttSession, 'SHORT_TRANSCRIPT_SAVED_WITHOUT_REQUEST', {
            segmentId,
            transcriptLength: candidateText.length,
            segmentDurationMs,
          });
        }, AUDIO_CONTINUATION_TIMEOUT_MS);
        onStatus('I heard a short phrase. Continue speaking to complete your question.');
        logSttTrace(sttSession, 'SHORT_TRANSCRIPT_WAITING_FOR_CONTINUATION', {
          segmentId,
          transcriptLength: candidateText.length,
          segmentDurationMs,
          timeoutMs: AUDIO_CONTINUATION_TIMEOUT_MS,
        });
        return true;
      };
      setLiveTranscript(candidateText);
      setDisplayedQuestion(candidateText);
      setDisplayedAnswer('');
      setAnswerPending(true);
      addTranscript({
        id: crypto.randomUUID(),
        source: meetingSource,
        rawText: candidateRawText,
        normalizedText: candidateText,
        text: candidateText,
        createdAt: new Date().toISOString(),
      });
      if (hasRepeatedSpeechLoop(candidateText)) {
        onStatus('Speech recognition detected repeated words and did not send them. Please repeat your question clearly.');
        setPipelineStatus('ready');
        onError('');
        logSttTrace(sttSession, 'REPEATED_SPEECH_LOOP_REJECTED', { segmentId, transcriptLength: candidateText.length });
        return;
      }
      const preparedQuestion = {
        ...prepareQuestion(candidateText, transcriptNormalizationContext),
        rawText: candidateRawText,
      };
      logSttTrace(sttSession, 'TRANSCRIPT_PROCESSED', {
        segmentId,
        rawTranscript: candidateRawText,
        normalizedTranscript: preparedQuestion.normalizedText,
        finalQuestion: preparedQuestion.acceptedQuestion,
        transcriptLength: preparedQuestion.normalizedText.length,
        requestDetected: Boolean(preparedQuestion.acceptedQuestion),
        qualityClassification: preparedQuestion.qualityClassification,
        continuation: Boolean(continuedQuestion),
      });
      if (!preparedQuestion.acceptedQuestion) {
        if (preparedQuestion.qualityClassification === 'INCOMPLETE') {
          if (preparedQuestion.normalizedText.length <= AUDIO_CONTINUATION_MAX_CHARS) {
            pendingPartialQuestionRef.current = preparedQuestion.normalizedText;
            pendingPartialRawTextRef.current = candidateRawText;
            pendingPartialTimeoutRef.current = setTimeout(() => {
              if (captureSessionIdRef.current !== sttSession) return;
              pendingPartialQuestionRef.current = '';
              pendingPartialRawTextRef.current = '';
              pendingPartialTimeoutRef.current = null;
              onStatus('The incomplete request timed out. Please try again.');
              logSttTrace(sttSession, 'PARTIAL_REQUEST_EXPIRED', {
                segmentId,
                transcriptLength: preparedQuestion.normalizedText.length,
              });
            }, AUDIO_CONTINUATION_TIMEOUT_MS);
            onStatus('Please finish the request before I send it.');
            logSttTrace(sttSession, 'PARTIAL_REQUEST_WAITING', {
              segmentId,
              transcriptLength: preparedQuestion.normalizedText.length,
              timeoutMs: AUDIO_CONTINUATION_TIMEOUT_MS,
            });
          } else {
            pendingPartialQuestionRef.current = '';
            pendingPartialRawTextRef.current = '';
            onStatus('The request was too long to continue safely. Please try again.');
            logSttTrace(sttSession, 'PARTIAL_REQUEST_REJECTED', {
              segmentId,
              transcriptLength: preparedQuestion.normalizedText.length,
              maxChars: AUDIO_CONTINUATION_MAX_CHARS,
            });
          }
        } else if (hasMeetingRequestIntent(candidateText) || !bufferShortTranscript()) {
          pendingPartialQuestionRef.current = '';
          pendingPartialRawTextRef.current = '';
          onStatus(inputQualityMessage(preparedQuestion.qualityClassification));
          logSttTrace(sttSession, 'TRANSCRIPT_REJECTED', {
            segmentId,
            transcriptLength: preparedQuestion.normalizedText.length,
            qualityClassification: preparedQuestion.qualityClassification,
          });
        }
        setPipelineStatus('ready');
        onError('');
        return;
      }
      if (!hasMeetingRequestIntent(candidateText)) {
        if (bufferShortTranscript()) {
          setPipelineStatus('ready');
          onError('');
          return;
        }
        pendingPartialQuestionRef.current = '';
        pendingPartialRawTextRef.current = '';
        onStatus('I heard speech but could not detect a complete question. Your transcript was saved; please ask the question again.');
        setPipelineStatus('ready');
        onError('');
        logSttTrace(sttSession, 'SPOKEN_REQUEST_INTENT_NOT_DETECTED', {
          segmentId,
          transcriptLength: candidateText.length,
        });
        return;
      }
      pendingPartialQuestionRef.current = '';
      pendingPartialRawTextRef.current = '';
      if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
      pendingPartialTimeoutRef.current = null;
      const acceptedQuestion = preparedQuestion.acceptedQuestion;
      onStatus('');
      setPipelineStatus('question');
      logSttTrace(sttSession, 'REQUEST_DETECTED', {
        segmentId,
        transcriptLength: acceptedQuestion.length,
        continuation: Boolean(continuedQuestion),
      });
      setLiveTranscript(acceptedQuestion);
      setPipelineStatus('thinking');
      logSttTrace(sttSession, 'AI_REQUEST_STARTED', { segmentId, questionLength: acceptedQuestion.length });
      await sendQuestion(acceptedQuestion, {
        preparedQuestion: { ...preparedQuestion, rawText: candidateRawText },
        duplicateChecked: true,
        preserveTranscriptionTiming: true,
      });
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (!shouldApplyMeetingSttResult(captureSessionIdRef.current, sttSession, abortController.signal.aborted)) {
        logSttTrace(sttSession, 'STALE_STT_CALLBACK_IGNORED', { segmentId, stopRequested: true });
        return;
      }
      const classification = ((error as { classification?: SttFailureClassification }).classification
        || classifySttClientError(error)) as SttFailureClassification;
      logSttTrace(sttSession, 'STT_PIPELINE_FAILED', {
        segmentId,
        classification,
        durationMs: Math.round(performance.now() - requestStartedAt),
      });
      onStatus('');
      setPipelineStatus('error');
      onError(meetingSttUserError(classification, error instanceof Error ? error.message : String(error)));
    } finally {
      if (activeSttAbortRef.current === abortController) activeSttAbortRef.current = null;
      if (captureSessionIdRef.current === sttSession) setIsTranscribing(false);
    }
  };
}
