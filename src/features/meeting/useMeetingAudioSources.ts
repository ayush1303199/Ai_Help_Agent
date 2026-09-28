import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  chooseMicrophoneDevice,
  microphoneDisplayLabel,
  normalizeMicrophoneDevices,
  type InterviewContextConfig,
  type MicrophoneDeviceOption,
} from '../../ai/interviewContext';
import type { MeetingAudioMode } from '../../app/appTypes';
import { runtimeConfig } from '../../config/runtimeConfig';
import { classifySttClientError, logSttTrace } from './meetingCaptureLifecycle';
import { resolveMeetingMicrophoneInventory } from './meetingAudioDeviceState';

const {
  voiceHighPassHz: VOICE_HIGH_PASS_HZ,
  voiceLowPassHz: VOICE_LOW_PASS_HZ,
  voiceCompressorThresholdDb: VOICE_COMPRESSOR_THRESHOLD_DB,
  voiceCompressorRatio: VOICE_COMPRESSOR_RATIO,
} = runtimeConfig.audio;

export function systemAudioErrorMessage(error: unknown, action: 'capture' | 'test') {
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

export interface MeetingAudioCapture {
  stream: MediaStream;
  cleanup: () => void;
  microphoneAudio: boolean;
  systemAudio: boolean;
}

interface MeetingAudioSourcesOptions {
  meetingAudioMode: MeetingAudioMode;
  interviewConfig: InterviewContextConfig;
  setInterviewConfig: Dispatch<SetStateAction<InterviewContextConfig>>;
  onStatus: Dispatch<SetStateAction<string>>;
}

export function useMeetingAudioSources({
  meetingAudioMode,
  interviewConfig,
  setInterviewConfig,
  onStatus,
}: MeetingAudioSourcesOptions) {
  const { microphoneDeviceId } = interviewConfig;
  const [microphoneDevices, setMicrophoneDevices] = useState<MicrophoneDeviceOption[]>([]);
  const [microphoneUnavailable, setMicrophoneUnavailable] = useState(false);
  const [microphonePermissionRequired, setMicrophonePermissionRequired] = useState(false);
  const [audioSourceLabel, setAudioSourceLabel] = useState('Not connected');
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioStatus, setAudioStatus] = useState<'disabled' | 'connected' | 'testing'>('disabled');
  const [systemAudioStatus, setSystemAudioStatus] = useState<'off' | 'connected' | 'testing'>('off');
  const [microphoneStatus, setMicrophoneStatus] = useState<'off' | 'connected'>('off');
  const audioLevelRef = useRef(0);
  const electronAudioContextRef = useRef<AudioContext | null>(null);
  const audioLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedMicrophone = microphoneDevices.find((device) => device.deviceId === microphoneDeviceId) || null;
  const selectedMicrophoneLabel = microphoneDisplayLabel(selectedMicrophone);
  const microphoneDevicePresent = Boolean(selectedMicrophone) || microphonePermissionRequired;
  const configuredMicrophoneLabel = selectedMicrophone
    ? selectedMicrophoneLabel
    : microphoneUnavailable
      ? 'Microphone unavailable'
      : microphonePermissionRequired
        ? 'Default microphone (permission needed)'
        : 'Default microphone';

  const refreshMicrophoneDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicrophoneDevices([]);
      setMicrophoneUnavailable(true);
      setMicrophonePermissionRequired(false);
      return;
    }
    try {
      const audioInputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput');
      const devices = normalizeMicrophoneDevices(audioInputs
        .filter((device) => Boolean(device.deviceId))
        .map((device) => ({ deviceId: device.deviceId, label: device.label, groupId: device.groupId })));
      const inventory = resolveMeetingMicrophoneInventory(audioInputs.length, devices);
      setMicrophoneDevices(inventory.devices);
      setMicrophoneUnavailable(inventory.unavailable);
      setMicrophonePermissionRequired(inventory.permissionRequired);
      if (inventory.unavailable) {
        setInterviewConfig((current) => current.microphoneDeviceId ? { ...current, microphoneDeviceId: null } : current);
        return;
      }
      if (inventory.permissionRequired) {
        setInterviewConfig((current) => current.microphoneDeviceId ? { ...current, microphoneDeviceId: null } : current);
        return;
      }
      setInterviewConfig((current) => {
        const selected = chooseMicrophoneDevice(inventory.devices, current.microphoneDeviceId);
        return selected === current.microphoneDeviceId ? current : { ...current, microphoneDeviceId: selected };
      });
    } catch {
      setMicrophoneDevices([]);
      setMicrophoneUnavailable(true);
      setMicrophonePermissionRequired(false);
    }
  }, [setInterviewConfig]);

  useEffect(() => {
    void refreshMicrophoneDevices();
    const handleDeviceChange = () => { void refreshMicrophoneDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
  }, [refreshMicrophoneDevices]);

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
        const level = Math.min(100, Math.round((volume / samples.length) * 5));
        audioLevelRef.current = level;
        setAudioLevel(level);
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
    audioLevelRef.current = 0;
    setAudioLevel(0);
  };

  const requestSystemAudioStream = async (): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(/Electron/i.test(navigator.userAgent)
        ? 'System audio capture is unavailable in this Electron build.'
        : 'System audio capture requires the Electron desktop app on Windows.');
    }
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = displayStream.getAudioTracks().filter((track) => track.readyState === 'live');
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error('No system audio source selected. Choose a tab, window, or screen and enable Share audio.');
    }
    displayStream.getVideoTracks().forEach((track) => track.stop());
    return new MediaStream(audioTracks);
  };

  const processMicrophoneVoice = async (microphoneStream: MediaStream, sttSession: string) => {
    let audioContext: AudioContext | null = null;
    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(microphoneStream);
      const highPass = audioContext.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = VOICE_HIGH_PASS_HZ;
      const lowPass = audioContext.createBiquadFilter();
      lowPass.type = 'lowpass';
      lowPass.frequency.value = VOICE_LOW_PASS_HZ;
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = VOICE_COMPRESSOR_THRESHOLD_DB;
      compressor.knee.value = 18;
      compressor.ratio.value = VOICE_COMPRESSOR_RATIO;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      const destination = audioContext.createMediaStreamDestination();
      source.connect(highPass).connect(lowPass).connect(compressor).connect(destination);
      if (audioContext.state !== 'running') await audioContext.resume();
      if (audioContext.state !== 'running') throw new Error('Microphone voice filtering could not start.');
      logSttTrace(sttSession, 'MICROPHONE_VOICE_FILTER_ENABLED', {
        browserNoiseSuppression: microphoneStream.getAudioTracks()[0]?.getSettings?.().noiseSuppression ?? null,
        highPassHz: VOICE_HIGH_PASS_HZ,
        lowPassHz: VOICE_LOW_PASS_HZ,
        compressorRatio: VOICE_COMPRESSOR_RATIO,
      });
      return {
        stream: destination.stream,
        cleanup: () => {
          destination.stream.getTracks().forEach((track) => track.stop());
          microphoneStream.getTracks().forEach((track) => track.stop());
          void audioContext?.close();
        },
      };
    } catch (error) {
      microphoneStream.getTracks().forEach((track) => track.stop());
      void audioContext?.close();
      throw error;
    }
  };

  const requestMicrophoneStream = async (sttSession: string): Promise<{ stream: MediaStream; deviceId: string | null; label: string }> => {
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (error) {
      const errorName = error instanceof DOMException
        ? error.name
        : (typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '');
      const selectedDeviceUnavailable = Boolean(
        microphoneDeviceId && ['NotFoundError', 'OverconstrainedError'].includes(errorName),
      );
      if (!selectedDeviceUnavailable) throw error;
      const availableDevices = normalizeMicrophoneDevices(
        (await navigator.mediaDevices.enumerateDevices())
          .filter((device) => device.kind === 'audioinput' && Boolean(device.deviceId))
          .map((device) => ({ deviceId: device.deviceId, label: device.label, groupId: device.groupId })),
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
    void refreshMicrophoneDevices();
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
      const classification = classifySttClientError(error);
      logSttTrace(sttSession, 'AUDIO_CAPTURE_FAILED', {
        classification: classification === 'STT_UNKNOWN' ? 'AUDIO_PERMISSION' : classification,
        errorName: error instanceof DOMException ? error.name : 'Error',
      });
      throw new Error(classification === 'AUDIO_PERMISSION'
        ? 'Microphone permission was denied or blocked.'
        : (error instanceof Error ? error.message : String(error)));
    }
  };

  const requestMeetingAudioStream = async (sttSession = 'audio-test'): Promise<MeetingAudioCapture> => {
    const microphoneAudio = meetingAudioMode !== 'system';
    const systemAudioRequested = meetingAudioMode !== 'microphone';
    const microphoneCapture = microphoneAudio ? await requestMicrophoneStream(sttSession) : null;
    const microphoneStream = microphoneCapture?.stream || null;
    let systemStream: MediaStream | null = null;
    let systemAudio = false;
    if (systemAudioRequested) {
      try {
        systemStream = await requestSystemAudioStream();
        systemAudio = systemStream.getAudioTracks().some((track) => track.readyState === 'live');
      } catch (error) {
        logSttTrace(sttSession, 'SYSTEM_AUDIO_UNAVAILABLE', { classification: classifySttClientError(error) });
        microphoneStream?.getTracks().forEach((track) => track.stop());
        setSystemAudioStatus('off');
        throw new Error(systemAudioErrorMessage(error, 'capture'));
      }
    }
    let processedMicrophone: Awaited<ReturnType<typeof processMicrophoneVoice>> | null = null;
    try {
      processedMicrophone = microphoneStream ? await processMicrophoneVoice(microphoneStream, sttSession) : null;
    } catch (error) {
      systemStream?.getTracks().forEach((track) => track.stop());
      throw error;
    }
    const sourceStreams = [
      ...(processedMicrophone ? [processedMicrophone.stream] : []),
      ...(systemStream && systemAudio ? [systemStream] : []),
    ];
    if (sourceStreams.length === 0) throw new Error('No microphone or system-audio source is available.');
    setMicrophoneStatus(microphoneStream ? 'connected' : 'off');
    setSystemAudioStatus(systemAudio ? 'connected' : 'off');
    if (sourceStreams.length === 1) {
      setAudioSourceLabel(systemAudio ? 'System Audio' : microphoneCapture?.label || configuredMicrophoneLabel);
      setAudioStatus('connected');
      try {
        monitorSystemAudio(sourceStreams[0]);
      } catch (error) {
        processedMicrophone?.cleanup();
        systemStream?.getTracks().forEach((track) => track.stop());
        throw error;
      }
      return {
        stream: sourceStreams[0],
        microphoneAudio: Boolean(microphoneStream),
        systemAudio,
        cleanup: () => {
          processedMicrophone?.cleanup();
          systemStream?.getTracks().forEach((track) => track.stop());
        },
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
      processedMicrophone?.cleanup();
      systemStream?.getTracks().forEach((track) => track.stop());
      destination?.stream.getTracks().forEach((track) => track.stop());
      void mixContext.close();
      throw error;
    }
    return {
      stream: destination.stream,
      microphoneAudio: Boolean(microphoneStream),
      systemAudio,
      cleanup: () => {
        processedMicrophone?.cleanup();
        systemStream?.getTracks().forEach((track) => track.stop());
        destination?.stream.getTracks().forEach((track) => track.stop());
        void mixContext.close();
      },
    };
  };

  const selectMicrophoneDevice = (deviceId: string) => {
    setInterviewConfig((current) => ({ ...current, microphoneDeviceId: deviceId || null }));
  };

  useEffect(() => () => {
    void electronAudioContextRef.current?.close();
    electronAudioContextRef.current = null;
    if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
    audioLevelTimerRef.current = null;
    audioLevelRef.current = 0;
  }, []);

  return {
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
  };
}
