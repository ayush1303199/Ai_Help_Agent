import { useEffect, useRef } from 'react';
import { prepareQuestion } from '../../audio/transcriptUtils';
import { runtimeConfig } from '../../config/runtimeConfig';
import {
  buildOverlayActionItems,
  buildOverlayAnalysis,
  buildOverlaySummary,
} from '../overlay/overlayAnswerInsights';
import {
  isMissingMeetingOverlayHandler,
  meetingOverlayAnswer,
  meetingOverlayQuestion,
} from './meetingOverlayProtocol';
import type { MeetingControllerSnapshot } from './MeetingAssistantPage';

interface MeetingOverlayBridgeProps {
  active: boolean;
  controller: Pick<MeetingControllerSnapshot,
    | 'lastQuestion'
    | 'lastAnswer'
    | 'liveTranscript'
    | 'pipelineStatus'
    | 'pipelineStatusSince'
    | 'meetingError'
    | 'meetingStatusMessage'
    | 'chatBusy'
    | 'isRecording'
    | 'isTranscribing'
    | 'audioSignalDetected'
    | 'transcripts'
    | 'answeredSegments'
    | 'sendQuestion'
    | 'startMeetingCapture'
    | 'stopMeetingCapture'
    | 'cancelCurrentRequest'
    | 'setMeetingMenuOpen'
    | 'refreshMicrophoneDevices'
  >;
}

export function MeetingOverlayBridge({ active, controller }: MeetingOverlayBridgeProps) {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const activeRef = useRef(active);
  activeRef.current = active;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const ipcRelayUnavailableRef = useRef(false);
  const stateRef = useRef<MeetingOverlayRuntimeState>({
    answer: '',
    question: '',
    analysis: '',
    summary: '',
    actionItems: [] as string[],
    transcripts: [] as MeetingControllerSnapshot['transcripts'],
    answeredSegments: [] as MeetingControllerSnapshot['answeredSegments'],
    status: 'ready',
    error: '',
    statusMessage: '',
    statusStartedAt: Date.now(),
    agent: 'meeting',
    captureActive: false,
    transcribing: false,
    audioSignalDetected: false,
    meetingActive: false,
    version: 0,
    updatedAt: 0,
  });

  const reportCommandResult = async (result: MeetingOverlayCommandResult) => {
    channelRef.current?.postMessage({ type: 'meeting-command-result', ...result });
    if (!window.electronAPI || ipcRelayUnavailableRef.current) return;
    try {
      await window.electronAPI.reportMeetingOverlayCommandResult(result);
    } catch (error) {
      if (isMissingMeetingOverlayHandler(error)) {
        ipcRelayUnavailableRef.current = true;
        return;
      }
      console.error('Failed to report Meeting overlay command result:', error);
    }
  };

  useEffect(() => {
    const wasActive = stateRef.current.meetingActive;
    const historyChanged = stateRef.current.transcripts !== controller.transcripts
      || stateRef.current.answeredSegments !== controller.answeredSegments;
    const {
      lastQuestion,
      lastAnswer,
      liveTranscript,
      pipelineStatus,
      pipelineStatusSince,
      meetingError,
      meetingStatusMessage,
      isRecording,
      isTranscribing,
      audioSignalDetected,
      transcripts,
      answeredSegments,
    } = controller;
    const updatedAt = Date.now();
    const answer = meetingOverlayAnswer(pipelineStatus, lastAnswer);
    const question = meetingOverlayQuestion(pipelineStatus, lastQuestion, liveTranscript);
    stateRef.current = {
      answer,
      question,
      analysis: buildOverlayAnalysis(question, answer),
      summary: buildOverlaySummary(answer),
      actionItems: answer ? buildOverlayActionItems(answer) : [],
      transcripts,
      answeredSegments,
      status: pipelineStatus,
      error: meetingError,
      statusMessage: meetingStatusMessage,
      statusStartedAt: pipelineStatusSince,
      agent: 'meeting',
      captureActive: isRecording,
      transcribing: isTranscribing,
      audioSignalDetected,
      meetingActive: active,
      version: Math.max(updatedAt, stateRef.current.version + 1),
      updatedAt,
    };
    const stateToPublish = historyChanged
      ? stateRef.current
      : { ...stateRef.current, transcripts: undefined, answeredSegments: undefined };
    if (window.electronAPI && !ipcRelayUnavailableRef.current && (active || wasActive)) {
      void window.electronAPI.publishMeetingOverlayState(stateToPublish).catch((error: unknown) => {
        if (isMissingMeetingOverlayHandler(error)) {
          ipcRelayUnavailableRef.current = true;
          channelRef.current?.postMessage({ type: 'state', ...stateRef.current });
          return;
        }
        console.error('Failed to publish Meeting overlay state:', error);
      });
    } else if (active || wasActive) {
      channelRef.current?.postMessage({ type: 'state', ...stateRef.current });
    }
  }, [active, controller]);

  useEffect(() => {
    const handleCommand = async (command: MeetingOverlayCommand) => {
      if (!command.commandId) return;
      if (!activeRef.current) {
        await reportCommandResult({
          commandId: command.commandId,
          ok: false,
          message: 'Open the Meeting page before using Meeting overlay controls.',
        });
        return;
      }
      const current = controllerRef.current;
      if (command.type === 'cancel-request') {
        const cancelled = current.cancelCurrentRequest();
        await reportCommandResult({
          commandId: command.commandId,
          ok: cancelled,
          ...(cancelled ? {} : { message: 'There is no active transcription or answer to cancel.' }),
        });
        return;
      }
      if (command.type === 'open-audio-settings') {
        current.setMeetingMenuOpen(true);
        await current.refreshMicrophoneDevices();
        await reportCommandResult({ commandId: command.commandId, ok: true });
        return;
      }
      if (command.type === 'start-listening') {
        const started = current.isRecording || await current.startMeetingCapture();
        await reportCommandResult({
          commandId: command.commandId,
          ok: started,
          captureActive: started || current.isRecording,
          ...(started ? {} : { message: current.meetingError || 'Meeting listening could not start.' }),
        });
        return;
      }
      if (command.type === 'stop-listening') {
        try {
          if (current.isRecording || current.isTranscribing) current.stopMeetingCapture();
          await reportCommandResult({ commandId: command.commandId, ok: true });
        } catch (error) {
          await reportCommandResult({
            commandId: command.commandId,
            ok: false,
            message: error instanceof Error ? error.message : 'Meeting listening could not stop.',
          });
        }
        return;
      }
      const question = typeof command.question === 'string'
        ? command.question.trim().slice(0, runtimeConfig.overlay.questionMaxChars)
        : '';
      if (!question) {
        await reportCommandResult({ commandId: command.commandId, ok: false, message: 'Enter a question first.' });
        return;
      }
      const preparedQuestion = prepareQuestion(question);
      if (!preparedQuestion.acceptedQuestion) {
        await reportCommandResult({
          commandId: command.commandId,
          ok: false,
          message: 'Please enter a complete question or request.',
        });
        return;
      }
      if (current.chatBusy) {
        const error = 'Please wait for the current meeting answer to finish.';
        const updatedAt = Date.now();
        stateRef.current = {
          ...stateRef.current,
          status: 'error',
          error,
          version: Math.max(updatedAt, stateRef.current.version + 1),
          updatedAt,
        };
        if (window.electronAPI && !ipcRelayUnavailableRef.current) {
          void window.electronAPI.publishMeetingOverlayState(stateRef.current).catch((publishError: unknown) => {
            if (isMissingMeetingOverlayHandler(publishError)) {
              ipcRelayUnavailableRef.current = true;
              channelRef.current?.postMessage({ type: 'state', ...stateRef.current });
            } else {
              console.error('Failed to publish Meeting overlay error:', publishError);
            }
          });
        } else {
          channelRef.current?.postMessage({ type: 'overlay-search-error', message: error });
        }
        await reportCommandResult({ commandId: command.commandId, ok: false, message: error });
        return;
      }
      void current.sendQuestion(question, { preparedQuestion, duplicateChecked: true });
      await reportCommandResult({ commandId: command.commandId, ok: true });
    };

    const removeIpcListener = window.electronAPI?.onMeetingOverlayCommand((command) => { void handleCommand(command); });
    if (typeof BroadcastChannel === 'undefined') return removeIpcListener;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel('meeting-ai-overlay');
    } catch {
      return;
    }
    channelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type === 'meeting-state-refresh') {
        if (activeRef.current) {
          channel.postMessage({ type: 'state', ...stateRef.current });
          if (window.electronAPI && !ipcRelayUnavailableRef.current) {
            void window.electronAPI.publishMeetingOverlayState(stateRef.current).catch((error: unknown) => {
              if (isMissingMeetingOverlayHandler(error)) ipcRelayUnavailableRef.current = true;
              else console.error('Failed to refresh Meeting overlay state:', error);
            });
          }
        }
        return;
      }
      if (event.data?.type === 'overlay-ready') {
        if (activeRef.current) channel.postMessage({ type: 'state', ...stateRef.current });
        return;
      }
      if (!activeRef.current) return;
      if (event.data?.type === 'overlay-start-listening') {
        void handleCommand({ type: 'start-listening', commandId: event.data.commandId });
        return;
      }
      if (event.data?.type === 'overlay-stop-listening') {
        void handleCommand({ type: 'stop-listening', commandId: event.data.commandId });
        return;
      }
      if (event.data?.type === 'overlay-cancel-request') {
        void handleCommand({ type: 'cancel-request', commandId: event.data.commandId });
        return;
      }
      if (event.data?.type === 'overlay-open-audio-settings') {
        void handleCommand({ type: 'open-audio-settings', commandId: event.data.commandId });
        return;
      }
      if (event.data?.type !== 'overlay-question') return;
      void handleCommand({ type: 'question', question: event.data.question, commandId: event.data.commandId });
    };
    return () => {
      removeIpcListener?.();
      channel.close();
      channelRef.current = null;
    };
  }, []);

  return null;
}
