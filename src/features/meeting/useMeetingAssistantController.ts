import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { cleanTranscript, joinQuestionContinuation, prepareQuestion, type PreparedQuestion } from '../../audio/transcriptUtils';
import { transcribeAudioSegment } from '../../audio/sttService';
import type { SttFailureClassification } from '../../audio/sttTypes';
import { chooseMicrophoneDevice, microphoneDisplayLabel, normalizeMicrophoneDevices, type InterviewContextConfig, type MicrophoneDeviceOption } from '../../ai/interviewContext';
import type { MeetingAudioMode } from '../../app/appTypes';
import { runtimeConfig } from '../../config/runtimeConfig';
import { MeetingAgentTransport, type MeetingChatMessage, type MeetingChatRequest } from './meetingTransport';

interface PendingAudioSegment {
  blob: Blob;
  durationMs: number;
  sttSession: string;
}

export interface MeetingTranscript {
  id: string;
  source: string;
  text: string;
  rawText?: string;
  normalizedText?: string;
  createdAt: string;
}

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
  continuationTimeoutMs: AUDIO_CONTINUATION_TIMEOUT_MS,
  continuationMaxChars: AUDIO_CONTINUATION_MAX_CHARS,
} = runtimeConfig.audio;

function logSttTrace(sttSession: string, event: string, fields: Record<string, unknown> = {}) {
  console.info(`[STT_TRACE] ${JSON.stringify({ sttSession, event, ...fields })}`);
}

function classifySttClientError(error: unknown): SttFailureClassification {
  const name = error instanceof DOMException ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/i.test(message)) {
    return 'AUDIO_PERMISSION';
  }
  if (/unsupported|codec|mime|format|audio type/i.test(message)) return 'STT_UNSUPPORTED_AUDIO';
  if (/timeout|timed out/i.test(message)) return 'STT_TIMEOUT';
  if (/network|fetch|failed to fetch|load failed/i.test(message)) return 'STT_NETWORK_ERROR';
  return 'STT_UNKNOWN';
}

function sttUserError(classification: SttFailureClassification, fallback: string) {
  switch (classification) {
    case 'AUDIO_PERMISSION':
      return 'Microphone permission was denied or blocked. Allow microphone access and try again.';
    case 'AUDIO_CAPTURE_NO_SIGNAL':
      return 'No usable audio signal was captured. Speak closer to the microphone and try again.';
    case 'STT_AUTH_ERROR':
      return 'The speech-to-text provider key is missing or was rejected. Save a valid key in Settings → Configured Providers.';
    case 'STT_BAD_REQUEST':
    case 'STT_UNSUPPORTED_AUDIO':
      return 'The speech-to-text provider rejected this audio format.';
    case 'STT_RATE_LIMIT':
      return 'The speech-to-text provider is temporarily rate-limited. Please try again shortly.';
    case 'STT_TIMEOUT':
      return 'The speech-to-text provider timed out. Please try again.';
    case 'STT_NETWORK_ERROR':
      return 'The speech-to-text provider could not be reached. Check the connection and try again.';
    case 'STT_RESPONSE_PARSE_ERROR':
      return 'The speech-to-text response was invalid. Please try again.';
    case 'STT_PROVIDER_ERROR':
      return 'The selected speech provider rejected transcription. Choose another speech-capable provider in Settings and try again.';
    case 'STT_PROVIDER_UNSUPPORTED':
      return 'No enabled provider with speech-transcription support is available. Configure or enable a speech-capable provider in Settings.';
    default:
      return fallback;
  }
}

function systemAudioErrorMessage(error: unknown, action: 'capture' | 'test') {
  const message = error instanceof Error ? error.message : String(error);
  const isElectron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
  if (/not supported/i.test(message)) {
    if (!isElectron) {
      return `System audio ${action} needs the Electron desktop app on Windows. Start it with "npm run electron:dev"; the plain Vite browser session cannot provide Windows loopback audio.`;
    }
    return `System audio ${action} is not supported by this platform configuration. On Windows, restart the Electron app and select a playback source. On macOS, route meeting audio through a supported virtual device such as BlackHole.`;
  }
  return `System audio ${action} failed: ${message}`;
}



export function useMeetingAssistantController({
  interviewConfig,
  setInterviewConfig,
  refreshConfiguredProviders: refreshProviders,
  shouldAcceptQuestion,
  buildChatRequest,
}: MeetingAssistantControllerOptions) {
  const [meetingAudioMode, setMeetingAudioMode] = useState<MeetingAudioMode>('microphone');
  const [meetingMenuOpen, setMeetingMenuOpen] = useState(false);
  const [microphoneDevices, setMicrophoneDevices] = useState<MicrophoneDeviceOption[]>([]);
  const [microphoneUnavailable, setMicrophoneUnavailable] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [audioSourceLabel, setAudioSourceLabel] = useState('Not connected');
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioStatus, setAudioStatus] = useState<'disabled' | 'connected' | 'testing'>('disabled');
  const [systemAudioStatus, setSystemAudioStatus] = useState<'off' | 'connected' | 'testing'>('off');
  const [microphoneStatus, setMicrophoneStatus] = useState<'off' | 'connected'>('off');
  const [pipelineStatus, setPipelineStatus] = useState<'ready' | 'listening' | 'transcribing' | 'question' | 'thinking' | 'answer' | 'error' | 'stopped'>('ready');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [transcripts, setTranscripts] = useState<MeetingTranscript[]>(() => {
    try { return JSON.parse(localStorage.getItem('meeting-transcripts') || '[]'); } catch { return []; }
  });
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [input, setInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [meetingError, setMeetingError] = useState('');
  const [meetingStatusMessage, setMeetingStatusMessage] = useState('');
  const [answeredSegments, setAnsweredSegments] = useState<Array<{ question: string; answer: string }>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('meeting-chat-state') || '[]');
      return Array.isArray(stored) ? stored.filter((item): item is { question: string; answer: string } => (
        Boolean(item)
        && typeof item === 'object'
        && typeof item.question === 'string'
        && typeof item.answer === 'string'
      )).slice(0, 30) : [];
    } catch {
      return [];
    }
  });
  const transportRef = useRef<MeetingAgentTransport | null>(null);
  const onError = setMeetingError;
  const onStatus = setMeetingStatusMessage;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const electronAudioContextRef = useRef<AudioContext | null>(null);
  const audioLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentSilenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentAudioContextRef = useRef<AudioContext | null>(null);
  const segmentHeardAudioRef = useRef(false);
  const segmentStartedAtRef = useRef(0);
  const captureActiveRef = useRef(false);
  const captureSessionIdRef = useRef('');
  const pendingSegmentQueueRef = useRef<PendingAudioSegment[]>([]);
  const segmentProcessorActiveRef = useRef(false);
  const segmentProcessorRef = useRef<(() => Promise<void>) | null>(null);
  const segmentCloseInProgressRef = useRef(false);
  const requestInProgressRef = useRef(false);
  const pendingPartialQuestionRef = useRef('');
  const pendingPartialRawTextRef = useRef('');
  const pendingPartialTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureCleanupRef = useRef<(() => void) | null>(null);
  const { domain, background, microphoneDeviceId } = interviewConfig;
  const meetingSource = meetingAudioMode === 'meeting' ? 'Microphone + System Audio' : meetingAudioMode === 'system' ? 'System Audio' : 'Microphone';
  const selectedMicrophone = microphoneDevices.find((device) => device.deviceId === microphoneDeviceId) || null;
  const selectedMicrophoneLabel = microphoneDisplayLabel(selectedMicrophone);
  const microphoneDevicePresent = Boolean(selectedMicrophone);
  const configuredMicrophoneLabel = selectedMicrophone ? selectedMicrophoneLabel : 'Microphone unavailable';
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
    const transport = new MeetingAgentTransport();
    transportRef.current = transport;
    return () => {
      transport.close();
      transportRef.current = null;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('meeting-chat-state', JSON.stringify(answeredSegments.slice(0, 30)));
  }, [answeredSegments]);

  const sendQuestion = async (
    rawQuestion: string,
    options: { preparedQuestion?: PreparedQuestion; screenImage?: string; duplicateChecked?: boolean } = {},
  ) => {
    const question = rawQuestion.trim();
    if (!question || chatBusy) return;
    const preparedQuestion = options.preparedQuestion || prepareQuestion(question);
    if (!preparedQuestion.acceptedQuestion) {
      onStatus(inputQualityMessage(preparedQuestion.qualityClassification));
      return;
    }
    const acceptedQuestion = preparedQuestion.acceptedQuestion;
    if (!options.duplicateChecked && !shouldAcceptQuestion(acceptedQuestion)) {
      onStatus('This question was already submitted recently.');
      return;
    }
    setInput('');
    setLiveTranscript(acceptedQuestion);
    setPipelineStatus('question');
    setChatBusy(true);
    setPipelineStatus('thinking');
    onError('');
    try {
      const transport = transportRef.current;
      if (!transport) throw new Error('Meeting Assistant transport is unavailable.');
      const history = answeredSegments.flatMap((segment): MeetingChatMessage[] => [
        { role: 'user', content: segment.question },
        { role: 'assistant', content: segment.answer },
      ]);
      const result = await transport.send(buildChatRequest(acceptedQuestion, history, options.screenImage));
      setAnsweredSegments((previous) => [...previous, { question: acceptedQuestion, answer: result.content }].slice(-30));
      setPipelineStatus('answer');
      onStatus('');
    } catch (failure) {
      setPipelineStatus('error');
      onError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setChatBusy(false);
    }
  };

  const sendTypedQuestion = () => void sendQuestion(input, { preparedQuestion: prepareQuestion(input) });

  const refreshMicrophoneDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicrophoneDevices([]);
      setMicrophoneUnavailable(true);
      return;
    }
    try {
      const devices = normalizeMicrophoneDevices((await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput' && Boolean(device.deviceId))
        .map((device) => ({ deviceId: device.deviceId, label: device.label, groupId: device.groupId })));
      setMicrophoneDevices(devices);
      if (!devices.length) {
        setMicrophoneUnavailable(true);
        setInterviewConfig((current) => current.microphoneDeviceId ? { ...current, microphoneDeviceId: null } : current);
        return;
      }
      setMicrophoneUnavailable(false);
      setInterviewConfig((current) => {
        const selected = chooseMicrophoneDevice(devices, current.microphoneDeviceId);
        return selected === current.microphoneDeviceId ? current : { ...current, microphoneDeviceId: selected };
      });
    } catch {
      setMicrophoneDevices([]);
      setMicrophoneUnavailable(true);
    }
  }, [setInterviewConfig]);

  useEffect(() => {
    void refreshMicrophoneDevices();
    const handleDeviceChange = () => { void refreshMicrophoneDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
  }, [refreshMicrophoneDevices]);
  useEffect(() => { localStorage.setItem('meeting-transcripts', JSON.stringify(transcripts)); }, [transcripts]);

  const stopMeetingCapture = () => {
    captureCleanupRef.current?.();
    captureCleanupRef.current = null;
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
    captureSessionIdRef.current = '';
    pendingPartialQuestionRef.current = '';
    pendingPartialRawTextRef.current = '';
    if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
    pendingPartialTimeoutRef.current = null;
    pendingSegmentQueueRef.current = [];
    if (segmentSilenceTimerRef.current) clearInterval(segmentSilenceTimerRef.current);
    segmentSilenceTimerRef.current = null;
    void segmentAudioContextRef.current?.close();
    segmentAudioContextRef.current = null;
    recorderRef.current = null;
    streamRef.current = null;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    stopAudioMonitoring();
    setAudioLevel(0);
    setAudioStatus('disabled');
    setSystemAudioStatus('off');
    onStatus('');
    setIsRecording(false);
    setIsTranscribing(false);
    setPipelineStatus('stopped');
    setMicrophoneStatus('off');
  };

  const monitorSystemAudio = (stream: MediaStream) => {
    const audioContext = new AudioContext();
    try {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      electronAudioContextRef.current = audioContext;
      const samples = new Uint8Array(analyser.fftSize);
      if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
      audioLevelTimerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let volume = 0;
        for (const sample of samples) volume += Math.abs(sample - 128);
        setAudioLevel(Math.min(100, Math.round((volume / samples.length) * 5)));
      }, 100);
    } catch (error) {
      void audioContext.close();
      throw error;
    }
  };

  const stopAudioMonitoring = () => {
    void electronAudioContextRef.current?.close();
    electronAudioContextRef.current = null;
    if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
    audioLevelTimerRef.current = null;
    setAudioLevel(0);
  };

  const requestSystemAudioStream = async (): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(/Electron/i.test(navigator.userAgent)
        ? 'System audio capture is unavailable in this Electron build.'
        : 'System audio capture requires the Electron desktop app on Windows.');
    }

    // The OS chooser controls the source. We request audio only semantically;
    // Chromium requires a video permission for display capture, so its video
    // track is stopped immediately and never sent to recording or STT.
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = displayStream.getAudioTracks().filter((track) => track.readyState === 'live');
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error('No system audio source selected. Choose a tab, window, or screen and enable Share audio.');
    }
    displayStream.getVideoTracks().forEach((track) => track.stop());
    const systemStream = new MediaStream(audioTracks);
    return systemStream;
  };

  const requestMicrophoneStream = async (): Promise<{ stream: MediaStream; deviceId: string | null; label: string }> => {
    const sttSession = captureSessionIdRef.current;
    let captureDeviceId = microphoneDeviceId;
    let captureDeviceLabel = configuredMicrophoneLabel;
    let permission = 'unknown';
    try {
      permission = (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
    } catch {
      // Permission querying is not available in every Chromium configuration.
    }
    logSttTrace(sttSession, 'AUDIO_PERMISSION_CHECKED', { permission });
    if (!navigator.mediaDevices?.getUserMedia) {
      logSttTrace(sttSession, 'AUDIO_CAPTURE_FAILED', { classification: 'AUDIO_PERMISSION', reason: 'getUserMedia_unavailable' });
      throw new Error('Microphone capture is unavailable in this Electron build.');
    }

    const audioConstraints: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(microphoneDeviceId ? { deviceId: { exact: microphoneDeviceId } } : {}),
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
    } catch (error) {
      const errorName = error instanceof DOMException
        ? error.name
        : (typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '');
      const selectedDeviceUnavailable = Boolean(
        microphoneDeviceId
        && ['NotFoundError', 'OverconstrainedError'].includes(errorName),
      );
      if (!selectedDeviceUnavailable) throw error;
      const availableDevices = normalizeMicrophoneDevices(
        (await navigator.mediaDevices.enumerateDevices())
          .filter((device) => device.kind === 'audioinput' && Boolean(device.deviceId))
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label,
            groupId: device.groupId,
          })),
      );
      const fallbackDeviceId = chooseMicrophoneDevice(availableDevices, null);
      if (!fallbackDeviceId || fallbackDeviceId === microphoneDeviceId) throw error;
      setInterviewConfig((current) => ({ ...current, microphoneDeviceId: fallbackDeviceId }));
      setMicrophoneDevices(availableDevices);
      setMicrophoneUnavailable(false);
      captureDeviceId = fallbackDeviceId;
      captureDeviceLabel = microphoneDisplayLabel(
        availableDevices.find((device) => device.deviceId === fallbackDeviceId) || null,
      );
      onStatus('The saved microphone is unavailable. Using the available default microphone.');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...audioConstraints, deviceId: { exact: fallbackDeviceId } },
        video: false,
      });
    }
    try {
      const tracks = stream.getAudioTracks();
      const track = tracks[0];
      const settings = track?.getSettings?.() || {};
      const live = Boolean(track && track.readyState === 'live' && track.enabled && !track.muted);
      logSttTrace(sttSession, live ? 'AUDIO_STREAM_CREATED' : 'AUDIO_CAPTURE_FAILED', {
        classification: live ? undefined : 'AUDIO_CAPTURE_NO_SIGNAL',
        audioTracks: tracks.length,
        audioTrackState: track?.readyState || 'missing',
        enabled: track?.enabled ?? false,
        muted: track?.muted ?? false,
        selectedDeviceConfigured: Boolean(captureDeviceId),
        selectedDevicePresent: captureDeviceLabel !== 'Microphone unavailable',
        captureState: live ? 'live' : 'missing',
        deviceIdPresent: Boolean(settings.deviceId),
        sampleRate: settings.sampleRate || null,
        channelCount: settings.channelCount || null,
      });
      if (!live) {
        tracks.forEach((item) => item.stop());
        throw new Error('Microphone stream was created without a live audio track.');
      }
      setMicrophoneStatus('connected');
      return { stream, deviceId: captureDeviceId, label: captureDeviceLabel };
    } catch (error) {
      const classification = classifySttClientError(error) === 'STT_UNKNOWN'
        ? 'AUDIO_PERMISSION'
        : classifySttClientError(error);
      logSttTrace(sttSession, 'AUDIO_CAPTURE_FAILED', {
        classification,
        errorName: error instanceof DOMException ? error.name : 'Error',
      });
      throw new Error(classification === 'AUDIO_PERMISSION'
        ? 'Microphone permission was denied or blocked.'
        : (error instanceof Error ? error.message : String(error)));
    }
  };

  const requestMeetingAudioStream = async (): Promise<{
    stream: MediaStream;
    cleanup: () => void;
    microphoneAudio: boolean;
    systemAudio: boolean;
  }> => {
    const microphoneAudio = meetingAudioMode !== 'system';
    const systemAudioRequested = meetingAudioMode !== 'microphone';
    const microphoneCapture = microphoneAudio ? await requestMicrophoneStream() : null;
    const microphoneStream = microphoneCapture?.stream || null;
    let systemStream: MediaStream | null = null;
    let systemAudio = false;
    if (systemAudioRequested) {
      try {
        systemStream = await requestSystemAudioStream();
        systemAudio = systemStream.getAudioTracks().some((track) => track.readyState === 'live');
      } catch (error) {
        logSttTrace(captureSessionIdRef.current, 'SYSTEM_AUDIO_UNAVAILABLE', {
          classification: classifySttClientError(error),
        });
        microphoneStream?.getTracks().forEach((track) => track.stop());
        setSystemAudioStatus('off');
        throw new Error(systemAudioErrorMessage(error, 'capture'));
      }
    }

    const sourceStreams = [
      ...(microphoneStream ? [microphoneStream] : []),
      ...(systemStream && systemAudio ? [systemStream] : []),
    ];
    if (sourceStreams.length === 0) {
      throw new Error('No microphone or system-audio source is available.');
    }
    setMicrophoneStatus(microphoneStream ? 'connected' : 'off');
    setSystemAudioStatus(systemAudio ? 'connected' : 'off');
    if (sourceStreams.length === 1) {
      setAudioSourceLabel(systemAudio ? 'System Audio' : microphoneCapture?.label || configuredMicrophoneLabel);
      setAudioStatus('connected');
      try {
        monitorSystemAudio(sourceStreams[0]);
      } catch (error) {
        sourceStreams.forEach((source) => source.getTracks().forEach((track) => track.stop()));
        throw error;
      }
      return {
        stream: sourceStreams[0],
        microphoneAudio: Boolean(microphoneStream),
        systemAudio,
        cleanup: () => sourceStreams.forEach((source) => source.getTracks().forEach((track) => track.stop())),
      };
    }

    const mixContext = new AudioContext();
    let destination: MediaStreamAudioDestinationNode | null = null;
    try {
      await mixContext.resume().catch(() => undefined);
      destination = mixContext.createMediaStreamDestination();
      sourceStreams.forEach((source) => mixContext.createMediaStreamSource(source).connect(destination!));
      setAudioSourceLabel(`${microphoneCapture?.label || configuredMicrophoneLabel} + System Audio`);
      setAudioStatus('connected');
      monitorSystemAudio(destination.stream);
    } catch (error) {
      sourceStreams.forEach((source) => source.getTracks().forEach((track) => track.stop()));
      destination?.stream.getTracks().forEach((track) => track.stop());
      void mixContext.close();
      throw error;
    }
    return {
      stream: destination.stream,
      microphoneAudio: Boolean(microphoneStream),
      systemAudio,
      cleanup: () => {
        sourceStreams.forEach((source) => source.getTracks().forEach((track) => track.stop()));
        destination.stream.getTracks().forEach((track) => track.stop());
        void mixContext.close();
      },
    };
  };

  const recordAudioStream = (stream: MediaStream, cleanup: () => void) => {
    let cleanedUp = false;
    const cleanupCapture = () => {
      if (cleanedUp) return;
      cleanedUp = true;
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
    const chunks: Blob[] = [];
    const isCurrentSession = () => captureActiveRef.current
      && captureSessionIdRef.current === sttSession
      && recorderRef.current === recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const processSegment = async (segment: Blob, segmentDurationMs: number) => {
      if (captureSessionIdRef.current !== sttSession) return;
      const segmentId = crypto.randomUUID();
      setIsTranscribing(true);
      setPipelineStatus('transcribing');
      const requestStartedAt = performance.now();
      const payloadType = segment.type || recorder.mimeType || 'unknown';
      const payloadName = /ogg/i.test(payloadType) ? 'meeting.ogg' : 'meeting.webm';
      logSttTrace(sttSession, 'STT_REQUEST_STARTED', {
        segmentId,
        segmentDurationMs,
        segmentBytes: segment.size,
        encoding: payloadType,
        recorderMimeType: recorder.mimeType || 'unknown',
      });
      try {
        if (segment.size === 0) {
          throw Object.assign(new Error('No audio signal was captured.'), { classification: 'AUDIO_CAPTURE_NO_SIGNAL' });
        }
        let sttResponse: { text: string; status: number };
        try {
          sttResponse = await transcribeAudioSegment({
            audio: segment,
            endpoint: `${HTTP_URL}/api/transcribe-audio`,
            sessionId: sttSession,
            segmentId,
            payloadName,
          });
        } catch (error) {
          const classification = ((error as { classification?: SttFailureClassification }).classification || 'STT_UNKNOWN');
          logSttTrace(sttSession, 'STT_RESPONSE_FAILED', {
            segmentId,
            status: (error as { status?: number }).status || 0,
            classification,
            durationMs: Math.round(performance.now() - requestStartedAt),
          });
          throw error;
        }
        if (captureSessionIdRef.current !== sttSession) {
          logSttTrace(sttSession, 'STALE_STT_CALLBACK_IGNORED', {
            segmentId,
            stopRequested: true,
          });
          return;
        }
        const rawTranscript = sttResponse.text;
        const transcriptNormalizationContext = {
          supportedTerms: [...background, ...(domain ? [domain] : [])],
        };
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
          : null;
        const candidateText = continuedQuestion || normalizedTranscript;
        const candidateRawText = continuedQuestion && pendingRawText
          ? `${pendingRawText} ${rawTranscript}`.replace(/\s+/g, ' ').trim()
          : rawTranscript;
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
          } else {
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
        pendingPartialQuestionRef.current = '';
        pendingPartialRawTextRef.current = '';
        if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
        pendingPartialTimeoutRef.current = null;
        const acceptedQuestion = preparedQuestion.acceptedQuestion;
        if (!shouldAcceptQuestion(acceptedQuestion)) {
          logSttTrace(sttSession, 'DUPLICATE_TRANSCRIPT_IGNORED', {
            segmentId,
            transcriptLength: acceptedQuestion.length,
            duplicate: true,
          });
          setPipelineStatus('ready');
          onError('');
          return;
        }
        setPipelineStatus('question');
        logSttTrace(sttSession, 'REQUEST_DETECTED', {
          segmentId,
          transcriptLength: acceptedQuestion.length,
          continuation: Boolean(continuedQuestion),
        });
        setLiveTranscript(acceptedQuestion);
        setTranscripts((current) => [{
          id: crypto.randomUUID(),
          source: meetingSource,
          rawText: candidateRawText,
          normalizedText: preparedQuestion.normalizedText,
          text: acceptedQuestion,
          createdAt: new Date().toISOString(),
        }, ...current]);
        setPipelineStatus('thinking');
        logSttTrace(sttSession, 'AI_REQUEST_STARTED', { segmentId, questionLength: acceptedQuestion.length });
        await sendQuestion(acceptedQuestion, {
          preparedQuestion: { ...preparedQuestion, rawText: candidateRawText },
          duplicateChecked: true,
        });
      } catch (err) {
        if (captureSessionIdRef.current !== sttSession) {
          logSttTrace(sttSession, 'STALE_STT_CALLBACK_IGNORED', {
            segmentId,
            stopRequested: true,
          });
          return;
        }
        const classification = ((err as { classification?: SttFailureClassification }).classification
          || classifySttClientError(err)) as SttFailureClassification;
        logSttTrace(sttSession, 'STT_PIPELINE_FAILED', {
          segmentId,
          classification,
          durationMs: Math.round(performance.now() - requestStartedAt),
        });
        setPipelineStatus('error');
        onError(sttUserError(classification, err instanceof Error ? err.message : String(err)));
      } finally {
        if (captureSessionIdRef.current === sttSession) setIsTranscribing(false);
      }
    };

    const processPendingSegments = async () => {
      if (segmentProcessorActiveRef.current) return;
      segmentProcessorActiveRef.current = true;
      requestInProgressRef.current = true;
      try {
        while (pendingSegmentQueueRef.current.length > 0) {
          if (captureSessionIdRef.current !== sttSession) break;
          const nextSegment = pendingSegmentQueueRef.current.shift();
          if (nextSegment?.sttSession === sttSession) {
            await processSegment(nextSegment.blob, nextSegment.durationMs);
          }
        }
      } finally {
        requestInProgressRef.current = false;
        segmentProcessorActiveRef.current = false;
        if (isCurrentSession()) setPipelineStatus('listening');
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
      const segmentDurationMs = Math.max(0, Math.round(performance.now() - (segmentStartedAtRef.current || performance.now())));
      segmentStartedAtRef.current = 0;
      if (!isCurrentSession()) {
        cleanupCapture();
        stream.getTracks().forEach((track) => track.stop());
        logSttTrace(sttSession, 'CAPTURE_STOPPED', {
          segmentDurationMs,
          clearedQueuedSegments: pendingSegmentQueueRef.current.length,
          stale: true,
        });
        return;
      }
      recorder.start();
      setTimeout(() => {
        if (captureSessionIdRef.current === sttSession && recorderRef.current === recorder) {
          segmentCloseInProgressRef.current = false;
        }
      }, 0);
      segmentStartedAtRef.current = performance.now();
      console.log('[CAPTURE] Utterance segment started');
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
        });
        void processPendingSegments();
      } else {
        logSttTrace(sttSession, 'SEGMENT_DISCARDED', {
          segmentDurationMs,
          segmentBytes: 0,
          classification: 'AUDIO_CAPTURE_NO_SIGNAL',
        });
      }
    };
    recorder.start();
    segmentCloseInProgressRef.current = false;
    captureActiveRef.current = true;
    segmentStartedAtRef.current = performance.now();
    logSttTrace(sttSession, 'SEGMENT_STARTED', { encoding: recorder.mimeType || 'unknown' });
    recorderRef.current = recorder;
    setLiveTranscript('');
    setIsRecording(true);
    setPipelineStatus('listening');

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    segmentAudioContextRef.current = audioContext;
    const samples = new Uint8Array(analyser.fftSize);
    let lastAudioAt = Date.now();
    segmentSilenceTimerRef.current = setInterval(() => {
      if (!captureActiveRef.current || recorder.state !== 'recording') return;
      analyser.getByteTimeDomainData(samples);
      let volume = 0;
      for (const sample of samples) volume += Math.abs(sample - 128);
      volume /= samples.length;
      if (volume > SYSTEM_AUDIO_LEVEL_THRESHOLD) {
        if (!segmentHeardAudioRef.current) {
          logSttTrace(sttSession, 'AUDIO_SIGNAL_DETECTED', { level: Number(volume.toFixed(2)) });
        }
        segmentHeardAudioRef.current = true;
        lastAudioAt = Date.now();
      } else if (segmentHeardAudioRef.current && Date.now() - lastAudioAt >= SYSTEM_AUDIO_SILENCE_MS) {
        console.log('[CAPTURE] Silence/end-of-utterance detected — flushing segment');
        recorder.stop();
      }
    }, 100);
  };

  const startMeetingCapture = async () => {
    if (captureActiveRef.current || captureSessionIdRef.current) return;
    try {
      await refreshProviders();
      const healthResponse = await fetch(`${HTTP_URL}/api/health`);
      const healthData = await healthResponse.json();
      if (!healthResponse.ok || healthData.sttReady === false) {
        onError('No speech-capable provider key is available to this desktop session. Open Settings → Configured Providers, save the key in this desktop app, then try again.');
        onStatus('');
        return;
      }
    } catch (error) {
      onError(`Could not verify speech transcription readiness: ${(error as Error).message}`);
      onStatus('');
      return;
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
      const capture = await requestMeetingAudioStream();
      if (captureSessionIdRef.current !== sttSession) {
        capture.cleanup();
        capture.stream.getTracks().forEach((track) => track.stop());
        stopAudioMonitoring();
        if (!captureSessionIdRef.current) {
          setAudioStatus('disabled');
          setSystemAudioStatus('off');
          setMicrophoneStatus('off');
          setAudioSourceLabel('Not connected');
        }
        return;
      }
      recordAudioStream(capture.stream, capture.cleanup);
      onStatus(capture.systemAudio
        ? capture.microphoneAudio
          ? 'Microphone and system audio connected. Listening is ready.'
          : 'System audio connected. Listening is ready.'
        : 'Microphone connected. Listening is ready.');
      logSttTrace(sttSession, 'AUDIO_CAPTURE_READY', {
        systemAudio: capture.systemAudio,
        audioTracks: capture.stream.getAudioTracks().length,
      });
    } catch (err) {
      if (captureSessionIdRef.current !== sttSession) return;
      const recorder = recorderRef.current;
      captureActiveRef.current = false;
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
        ? sttUserError(classification, 'Microphone permission was denied or blocked.')
        : (err instanceof Error ? err.message : String(err)));
      onStatus('');
    }
  };

  const testSystemAudio = async () => {
    onError('');
    onStatus('Opening the system-audio source selector...');
    let stream: MediaStream | null = null;
    try {
      stream = await requestSystemAudioStream();
      setAudioStatus('testing');
      setSystemAudioStatus('testing');
      monitorSystemAudio(stream);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        onError('System audio test passed. This test checks only the selected system-audio source.');
      }
    } catch (err) {
      setAudioStatus('disabled');
      setSystemAudioStatus('off');
      setAudioSourceLabel('Not connected');
      onError(systemAudioErrorMessage(err, 'test'));
      onStatus('');
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      stopAudioMonitoring();
      if (!isRecording) setAudioStatus('disabled');
      if (!isRecording) setSystemAudioStatus('off');
      if (!isRecording && !meetingError) onStatus('');
    }
  };

  const saveMeetingTranscript = () => {
    if (!liveTranscript.trim()) {
      onError('No transcript text has been captured yet.');
      return;
    }
    setTranscripts((current) => [{
      id: crypto.randomUUID(),
      source: meetingSource,
      text: liveTranscript.trim(),
      createdAt: new Date().toISOString(),
    }, ...current]);
    setLiveTranscript('');
  };

  const filteredTranscripts = transcripts.filter((item) =>
    item.text.toLowerCase().includes(transcriptSearch.toLowerCase()) ||
    item.source.toLowerCase().includes(transcriptSearch.toLowerCase()),
  );

  useEffect(() => () => {
    captureActiveRef.current = false;
    captureSessionIdRef.current = '';
    if (pendingPartialTimeoutRef.current) clearTimeout(pendingPartialTimeoutRef.current);
    if (segmentSilenceTimerRef.current) clearInterval(segmentSilenceTimerRef.current);
    if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    captureCleanupRef.current?.();
    void electronAudioContextRef.current?.close();
    void segmentAudioContextRef.current?.close();
  }, []);

  return {
    meetingAudioMode, setMeetingAudioMode, meetingMenuOpen, setMeetingMenuOpen,
    microphoneDevices, microphoneUnavailable, transcriptOpen, setTranscriptOpen,
    isRecording, isTranscribing, audioSourceLabel, audioLevel, audioStatus,
    systemAudioStatus, microphoneStatus, pipelineStatus, setPipelineStatus,
    input, setInput, chatBusy, answeredSegments, meetingError, meetingStatusMessage,
    reportError: setMeetingError,
    lastQuestion: answeredSegments.length ? answeredSegments[answeredSegments.length - 1].question : '',
    lastAnswer: answeredSegments.length ? answeredSegments[answeredSegments.length - 1].answer : '',
    liveTranscript, transcripts, transcriptSearch, setTranscriptSearch, filteredTranscripts,
    selectedMicrophone, selectedMicrophoneLabel, microphoneDevicePresent, configuredMicrophoneLabel,
    displayedAudioSourceLabel, displayedAudioStatus,
    refreshMicrophoneDevices, stopMeetingCapture, startMeetingCapture, testSystemAudio, saveMeetingTranscript,
    sendQuestion, sendTypedQuestion,
  };
}
