import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { InterviewContextConfig } from '../../ai/interviewContext';
import { runtimeConfig } from '../../config/runtimeConfig';
import { buildTranscriptSummaryPrompt } from './meetingTranscriptQuality';
import { useAgentProviderSelection, type AgentProviderOption } from '../provider-selection/useAgentProviderSelection';
import { MeetingAssistantWorkspace } from './MeetingAssistantWorkspace';
import { MeetingOverlayBridge } from './MeetingOverlayBridge';
import {
  useMeetingAssistantController,
  type MeetingAssistantControllerOptions,
} from './useMeetingAssistantController';
import { buildMeetingChatRequest, type MeetingRequestBuilderArgs, type MeetingRequestContext } from './meetingRequestBuilder';
import { useScreenReader } from '../screen-reading/useScreenReader';
import { historyTitle, type HistorySession, type MeetingHistoryRetentionDays } from '../../history/historyService';

type MeetingWorkspaceProps = ComponentProps<typeof MeetingAssistantWorkspace>;
export type MeetingControllerSnapshot = ReturnType<typeof useMeetingAssistantController>;

interface MeetingAssistantPageProps {
  active: boolean;
  providers: AgentProviderOption[];
  onProviderStorageError: (message: string) => void;
  interviewConfig: InterviewContextConfig;
  setInterviewConfig: MeetingAssistantControllerOptions['setInterviewConfig'];
  refreshConfiguredProviders: MeetingAssistantControllerOptions['refreshConfiguredProviders'];
  shouldAcceptQuestion: MeetingAssistantControllerOptions['shouldAcceptQuestion'];
  requestContext: MeetingRequestContext;
  onControllerChange: (controller: MeetingControllerSnapshot) => void;
  onScreenReadingChange: (state: Pick<ReturnType<typeof useScreenReader>, 'enabled' | 'setEnabled'>) => void;
  onHistoryEntry: (entry: HistorySession) => void;
  onClearHistory: () => void;
  onHistoryRetentionChange: (days: MeetingHistoryRetentionDays) => void;
}

export function MeetingAssistantPage({
  active,
  providers,
  onProviderStorageError,
  interviewConfig,
  setInterviewConfig,
  refreshConfiguredProviders,
  shouldAcceptQuestion,
  requestContext,
  onControllerChange,
  onScreenReadingChange,
  onHistoryEntry,
  onClearHistory,
  onHistoryRetentionChange,
}: MeetingAssistantPageProps) {
  const { providerId } = useAgentProviderSelection('meeting', providers, onProviderStorageError);
  const buildSelectedChatRequest = useCallback((
    ...args: MeetingRequestBuilderArgs
  ) => ({
      ...buildMeetingChatRequest(requestContext, ...args),
      ...(providerId ? { providerId } : {}),
    }),
    [providerId, requestContext],
  );
  const controller = useMeetingAssistantController({
    interviewConfig,
    setInterviewConfig,
    refreshConfiguredProviders,
    shouldAcceptQuestion,
    buildChatRequest: buildSelectedChatRequest,
  });
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, controller.pipelineStatus]);
  const reportError = controller.reportError;
  const onScreenReadError = useCallback((message: string) => reportError(message), [reportError]);
  const screenReader = useScreenReader({
    storageKey: 'meeting-screen-reading-enabled',
    disabled: !active || controller.chatBusy,
    onError: onScreenReadError,
    onScreenCaptured: async (image) => {
      await controller.sendQuestion(
        'Read the visible question on my shared meeting screen and answer it.',
        { duplicateChecked: true, screenImage: image },
      );
    },
  });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    if (!controller.answeredSegments.length) return;
    const messages = controller.answeredSegments.flatMap((turn): HistorySession['messages'] => [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ]);
    onHistoryEntry({
      id: `meeting-${controller.meetingConversationId}`,
      mode: 'meeting',
      title: historyTitle(messages),
      messages,
      updatedAt: new Date().toISOString(),
    });
  }, [controller.answeredSegments, controller.meetingConversationId, onHistoryEntry]);
  useEffect(() => {
    if (active) return;
    const current = controllerRef.current;
    current.cancelCurrentRequest();
    if (current.isRecording || current.isTranscribing) current.stopMeetingCapture();
  }, [active]);
  const controllerActions = useMemo(() => ({
    setMeetingAudioMode: (...args: Parameters<MeetingControllerSnapshot['setMeetingAudioMode']>) => controllerRef.current.setMeetingAudioMode(...args),
    selectMicrophoneDevice: (...args: Parameters<MeetingControllerSnapshot['selectMicrophoneDevice']>) => controllerRef.current.selectMicrophoneDevice(...args),
    restoreMeetingHistory: (...args: Parameters<MeetingControllerSnapshot['restoreMeetingHistory']>) => controllerRef.current.restoreMeetingHistory(...args),
    setTranscriptionLanguage: (...args: Parameters<MeetingControllerSnapshot['setTranscriptionLanguage']>) => controllerRef.current.setTranscriptionLanguage(...args),
    setReviewBeforeSend: (...args: Parameters<MeetingControllerSnapshot['setReviewBeforeSend']>) => controllerRef.current.setReviewBeforeSend(...args),
    sendReviewedTranscript: (...args: Parameters<MeetingControllerSnapshot['sendReviewedTranscript']>) => controllerRef.current.sendReviewedTranscript(...args),
    skipReviewedTranscript: (...args: Parameters<MeetingControllerSnapshot['skipReviewedTranscript']>) => controllerRef.current.skipReviewedTranscript(...args),
    setMeetingMenuOpen: (...args: Parameters<MeetingControllerSnapshot['setMeetingMenuOpen']>) => controllerRef.current.setMeetingMenuOpen(...args),
    setTranscriptOpen: (...args: Parameters<MeetingControllerSnapshot['setTranscriptOpen']>) => controllerRef.current.setTranscriptOpen(...args),
    setPipelineStatus: (...args: Parameters<MeetingControllerSnapshot['setPipelineStatus']>) => controllerRef.current.setPipelineStatus(...args),
    setInput: (...args: Parameters<MeetingControllerSnapshot['setInput']>) => controllerRef.current.setInput(...args),
    reportError: (...args: Parameters<MeetingControllerSnapshot['reportError']>) => controllerRef.current.reportError(...args),
    setTranscriptSearch: (...args: Parameters<MeetingControllerSnapshot['setTranscriptSearch']>) => controllerRef.current.setTranscriptSearch(...args),
    refreshMicrophoneDevices: (...args: Parameters<MeetingControllerSnapshot['refreshMicrophoneDevices']>) => controllerRef.current.refreshMicrophoneDevices(...args),
    stopMeetingCapture: (...args: Parameters<MeetingControllerSnapshot['stopMeetingCapture']>) => controllerRef.current.stopMeetingCapture(...args),
    startMeetingCapture: (...args: Parameters<MeetingControllerSnapshot['startMeetingCapture']>) => controllerRef.current.startMeetingCapture(...args),
    testMeetingAudio: (...args: Parameters<MeetingControllerSnapshot['testMeetingAudio']>) => controllerRef.current.testMeetingAudio(...args),
    saveMeetingTranscript: (...args: Parameters<MeetingControllerSnapshot['saveMeetingTranscript']>) => controllerRef.current.saveMeetingTranscript(...args),
    deleteMeetingTranscript: (...args: Parameters<MeetingControllerSnapshot['deleteMeetingTranscript']>) => controllerRef.current.deleteMeetingTranscript(...args),
    clearMeetingHistory: (...args: Parameters<MeetingControllerSnapshot['clearMeetingHistory']>) => controllerRef.current.clearMeetingHistory(...args),
    setHistoryRetentionDays: (...args: Parameters<MeetingControllerSnapshot['setHistoryRetentionDays']>) => controllerRef.current.setHistoryRetentionDays(...args),
    sendQuestion: (...args: Parameters<MeetingControllerSnapshot['sendQuestion']>) => controllerRef.current.sendQuestion(...args),
    sendTypedQuestion: (...args: Parameters<MeetingControllerSnapshot['sendTypedQuestion']>) => controllerRef.current.sendTypedQuestion(...args),
    sendEditedTranscript: (...args: Parameters<MeetingControllerSnapshot['sendEditedTranscript']>) => controllerRef.current.sendEditedTranscript(...args),
    cancelCurrentRequest: (...args: Parameters<MeetingControllerSnapshot['cancelCurrentRequest']>) => controllerRef.current.cancelCurrentRequest(...args),
  }), []);
  const sessionActive = controller.isRecording
    || controller.isTranscribing
    || controller.chatBusy
    || controller.pendingTranscriptReviews.length > 0
    || controller.answeredSegments.length > 0
    || ['question', 'thinking', 'answer'].includes(controller.pipelineStatus);
  const statusLabel = controller.meetingStatusMessage || (
    controller.pipelineStatus === 'listening' ? 'Listening...'
      : controller.pipelineStatus === 'transcribing' ? 'Transcribing...'
        : controller.pipelineStatus === 'question' ? 'Question detected'
          : controller.pipelineStatus === 'thinking' ? 'Thinking...'
            : controller.pipelineStatus === 'answer' ? 'Answer ready'
              : controller.pipelineStatus === 'stopped' ? 'Stopped'
                : controller.pipelineStatus === 'error' ? 'Unable to connect' : 'Ready'
  );

  const snapshot: MeetingControllerSnapshot = useMemo(() => ({
    meetingAudioMode: controller.meetingAudioMode,
    setMeetingAudioMode: controllerActions.setMeetingAudioMode,
    selectMicrophoneDevice: controllerActions.selectMicrophoneDevice,
    restoreMeetingHistory: controllerActions.restoreMeetingHistory,
    meetingConversationId: controller.meetingConversationId,
    transcriptionLanguage: controller.transcriptionLanguage,
    setTranscriptionLanguage: controllerActions.setTranscriptionLanguage,
    reviewBeforeSend: controller.reviewBeforeSend,
    setReviewBeforeSend: controllerActions.setReviewBeforeSend,
    pendingTranscriptReviews: controller.pendingTranscriptReviews,
    sendReviewedTranscript: controllerActions.sendReviewedTranscript,
    skipReviewedTranscript: controllerActions.skipReviewedTranscript,
    meetingMenuOpen: controller.meetingMenuOpen,
    setMeetingMenuOpen: controllerActions.setMeetingMenuOpen,
    microphoneDevices: controller.microphoneDevices,
    microphoneUnavailable: controller.microphoneUnavailable,
    transcriptOpen: controller.transcriptOpen,
    setTranscriptOpen: controllerActions.setTranscriptOpen,
    isRecording: controller.isRecording,
    isTranscribing: controller.isTranscribing,
    audioSourceLabel: controller.audioSourceLabel,
    audioLevel: controller.audioLevel,
    audioStatus: controller.audioStatus,
    systemAudioStatus: controller.systemAudioStatus,
    microphoneStatus: controller.microphoneStatus,
    pipelineStatus: controller.pipelineStatus,
    pipelineStatusSince: controller.pipelineStatusSince,
    audioSignalDetected: controller.audioSignalDetected,
    lastStageTimings: controller.lastStageTimings,
    setPipelineStatus: controllerActions.setPipelineStatus,
    input: controller.input,
    setInput: controllerActions.setInput,
    chatBusy: controller.chatBusy,
    answeredSegments: controller.answeredSegments,
    meetingError: controller.meetingError,
    meetingStatusMessage: controller.meetingStatusMessage,
    reportError: controllerActions.reportError,
    lastQuestion: controller.lastQuestion,
    lastAnswer: controller.lastAnswer,
    liveTranscript: controller.liveTranscript,
    transcripts: controller.transcripts,
    transcriptSearch: controller.transcriptSearch,
    setTranscriptSearch: controllerActions.setTranscriptSearch,
    filteredTranscripts: controller.filteredTranscripts,
    selectedMicrophone: controller.selectedMicrophone,
    selectedMicrophoneLabel: controller.selectedMicrophoneLabel,
    microphoneDevicePresent: controller.microphoneDevicePresent,
    configuredMicrophoneLabel: controller.configuredMicrophoneLabel,
    displayedAudioSourceLabel: controller.displayedAudioSourceLabel,
    displayedAudioStatus: controller.displayedAudioStatus,
    refreshMicrophoneDevices: controllerActions.refreshMicrophoneDevices,
    stopMeetingCapture: controllerActions.stopMeetingCapture,
    startMeetingCapture: controllerActions.startMeetingCapture,
    testMeetingAudio: controllerActions.testMeetingAudio,
    saveMeetingTranscript: controllerActions.saveMeetingTranscript,
    deleteMeetingTranscript: controllerActions.deleteMeetingTranscript,
    clearMeetingHistory: controllerActions.clearMeetingHistory,
    historyRetentionDays: controller.historyRetentionDays,
    setHistoryRetentionDays: controllerActions.setHistoryRetentionDays,
    sendQuestion: controllerActions.sendQuestion,
    sendTypedQuestion: controllerActions.sendTypedQuestion,
    sendEditedTranscript: controllerActions.sendEditedTranscript,
    cancelCurrentRequest: controllerActions.cancelCurrentRequest,
  }), [
    controller.meetingAudioMode, controller.transcriptionLanguage,
    controller.reviewBeforeSend, controller.pendingTranscriptReviews,
    controller.meetingConversationId,
    controller.historyRetentionDays,
    controller.meetingMenuOpen, controller.microphoneDevices,
    controller.microphoneUnavailable, controller.transcriptOpen, controller.isRecording,
    controller.isTranscribing, controller.audioSourceLabel, controller.audioLevel,
    controller.audioStatus, controller.systemAudioStatus, controller.microphoneStatus,
    controller.pipelineStatus, controller.pipelineStatusSince, controller.audioSignalDetected,
    controller.lastStageTimings,
    controller.input, controller.chatBusy, controller.answeredSegments,
    controller.meetingError, controller.meetingStatusMessage, controller.lastQuestion,
    controller.lastAnswer, controller.liveTranscript, controller.transcripts,
    controller.transcriptSearch, controller.filteredTranscripts, controller.selectedMicrophone,
    controller.selectedMicrophoneLabel, controller.microphoneDevicePresent,
    controller.configuredMicrophoneLabel, controller.displayedAudioSourceLabel,
    controller.displayedAudioStatus, controllerActions,
  ]);

  useEffect(() => {
    onControllerChange(snapshot);
  }, [onControllerChange, snapshot]);

  useEffect(() => {
    onScreenReadingChange({ enabled: screenReader.enabled, setEnabled: screenReader.setEnabled });
  }, [onScreenReadingChange, screenReader.enabled, screenReader.setEnabled]);

  const workspace: MeetingWorkspaceProps = {
    sessionActive,
    meetingAudioMode: controller.meetingAudioMode,
    transcriptionLanguage: controller.transcriptionLanguage,
    reviewBeforeSend: controller.reviewBeforeSend,
    pendingTranscriptReviews: controller.pendingTranscriptReviews,
    displayedAudioSourceLabel: controller.displayedAudioSourceLabel,
    displayedAudioStatus: controller.displayedAudioStatus,
    microphoneStatus: controller.microphoneStatus,
    microphoneUnavailable: controller.microphoneUnavailable,
    systemAudioStatus: controller.systemAudioStatus,
    audioLevel: controller.audioLevel,
    audioSignalDetected: controller.audioSignalDetected,
    meetingMenuOpen: controller.meetingMenuOpen,
    statusLabel,
    pipelineStatus: controller.pipelineStatus,
    pipelineElapsedMs: Math.max(0, clockNow - controller.pipelineStatusSince),
    lastStageTimings: controller.lastStageTimings,
    liveTranscript: controller.liveTranscript,
    lastQuestion: controller.lastQuestion,
    lastAnswer: controller.lastAnswer,
    answeredSegments: controller.answeredSegments,
    transcripts: controller.transcripts,
    transcriptSearch: controller.transcriptSearch,
    filteredTranscripts: controller.filteredTranscripts,
    transcriptOpen: controller.transcriptOpen,
    error: controller.meetingError,
    input: controller.input,
    isRecording: controller.isRecording,
    isTranscribing: controller.isTranscribing,
    chatStreaming: controller.chatBusy,
    onAudioModeChange: controller.setMeetingAudioMode,
    onTranscriptionLanguageChange: controllerActions.setTranscriptionLanguage,
    onReviewBeforeSendChange: controllerActions.setReviewBeforeSend,
    onSendReviewedTranscript: controllerActions.sendReviewedTranscript,
    onSkipReviewedTranscript: controllerActions.skipReviewedTranscript,
    onTestAudio: () => void controller.testMeetingAudio(),
    onStartCapture: () => void controller.startMeetingCapture(),
    onStopCapture: controller.stopMeetingCapture,
    onCancelRequest: controller.cancelCurrentRequest,
    onOpenAudioSettings: () => {
      controller.setMeetingMenuOpen(true);
      void controller.refreshMicrophoneDevices();
    },
    onTranscriptToggle: () => controller.setTranscriptOpen((open) => !open),
    onTranscriptSearchChange: controller.setTranscriptSearch,
    onUseTranscript: (transcript) => {
      controller.setInput(buildTranscriptSummaryPrompt(
        transcript.source,
        transcript.text,
        runtimeConfig.limits.maxContextChars,
      ));
    },
    onSaveTranscript: controller.saveMeetingTranscript,
    onSendTranscript: controllerActions.sendEditedTranscript,
    onDeleteTranscript: controllerActions.deleteMeetingTranscript,
    onClearHistory: () => {
      controllerActions.clearMeetingHistory();
      onClearHistory();
    },
    historyRetentionDays: controller.historyRetentionDays,
    onRetentionDaysChange: onHistoryRetentionChange,
    onInputChange: controller.setInput,
    onSendMessage: controller.sendTypedQuestion,
    onReadScreen: () => void screenReader.readScreen(),
    screenReading: screenReader.screenReading,
    screenReadingEnabled: screenReader.enabled,
  };

  return (
    <>
      <section hidden={!active} className={`${active ? 'flex' : 'hidden'} m-auto w-full max-w-3xl flex-1 flex-col rounded-2xl border border-teal-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7`}>
        <MeetingAssistantWorkspace {...workspace} />
      </section>
      <MeetingOverlayBridge active={active} controller={controller} />
    </>
  );
}
