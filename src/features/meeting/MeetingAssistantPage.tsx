import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ComponentProps } from 'react';
import type { InterviewContextConfig } from '../../ai/interviewContext';
import { useAgentProviderSelection, type AgentProviderOption } from '../provider-selection/useAgentProviderSelection';
import { MeetingAssistantWorkspace } from './MeetingAssistantWorkspace';
import { MeetingOverlayBridge } from './MeetingOverlayBridge';
import {
  useMeetingAssistantController,
  type MeetingAssistantControllerOptions,
} from './useMeetingAssistantController';
import { buildMeetingChatRequest, type MeetingRequestBuilderArgs, type MeetingRequestContext } from './meetingRequestBuilder';
import { useScreenReader } from '../screen-reading/useScreenReader';

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
  const controllerActions = useMemo(() => ({
    setMeetingAudioMode: (...args: Parameters<MeetingControllerSnapshot['setMeetingAudioMode']>) => controllerRef.current.setMeetingAudioMode(...args),
    setMeetingMenuOpen: (...args: Parameters<MeetingControllerSnapshot['setMeetingMenuOpen']>) => controllerRef.current.setMeetingMenuOpen(...args),
    setTranscriptOpen: (...args: Parameters<MeetingControllerSnapshot['setTranscriptOpen']>) => controllerRef.current.setTranscriptOpen(...args),
    setPipelineStatus: (...args: Parameters<MeetingControllerSnapshot['setPipelineStatus']>) => controllerRef.current.setPipelineStatus(...args),
    setInput: (...args: Parameters<MeetingControllerSnapshot['setInput']>) => controllerRef.current.setInput(...args),
    reportError: (...args: Parameters<MeetingControllerSnapshot['reportError']>) => controllerRef.current.reportError(...args),
    setTranscriptSearch: (...args: Parameters<MeetingControllerSnapshot['setTranscriptSearch']>) => controllerRef.current.setTranscriptSearch(...args),
    refreshMicrophoneDevices: (...args: Parameters<MeetingControllerSnapshot['refreshMicrophoneDevices']>) => controllerRef.current.refreshMicrophoneDevices(...args),
    stopMeetingCapture: (...args: Parameters<MeetingControllerSnapshot['stopMeetingCapture']>) => controllerRef.current.stopMeetingCapture(...args),
    startMeetingCapture: (...args: Parameters<MeetingControllerSnapshot['startMeetingCapture']>) => controllerRef.current.startMeetingCapture(...args),
    testSystemAudio: (...args: Parameters<MeetingControllerSnapshot['testSystemAudio']>) => controllerRef.current.testSystemAudio(...args),
    saveMeetingTranscript: (...args: Parameters<MeetingControllerSnapshot['saveMeetingTranscript']>) => controllerRef.current.saveMeetingTranscript(...args),
    sendQuestion: (...args: Parameters<MeetingControllerSnapshot['sendQuestion']>) => controllerRef.current.sendQuestion(...args),
    sendTypedQuestion: (...args: Parameters<MeetingControllerSnapshot['sendTypedQuestion']>) => controllerRef.current.sendTypedQuestion(...args),
  }), []);
  const sessionActive = controller.isRecording
    || controller.isTranscribing
    || controller.chatBusy
    || controller.answeredSegments.length > 0
    || ['question', 'thinking', 'answer'].includes(controller.pipelineStatus);
  const statusTone = controller.pipelineStatus === 'error'
    ? 'text-rose-300'
    : controller.pipelineStatus === 'answer' ? 'text-emerald-300' : 'text-sky-300';
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
    testSystemAudio: controllerActions.testSystemAudio,
    saveMeetingTranscript: controllerActions.saveMeetingTranscript,
    sendQuestion: controllerActions.sendQuestion,
    sendTypedQuestion: controllerActions.sendTypedQuestion,
  }), [
    controller.meetingAudioMode, controller.meetingMenuOpen, controller.microphoneDevices,
    controller.microphoneUnavailable, controller.transcriptOpen, controller.isRecording,
    controller.isTranscribing, controller.audioSourceLabel, controller.audioLevel,
    controller.audioStatus, controller.systemAudioStatus, controller.microphoneStatus,
    controller.pipelineStatus, controller.input, controller.chatBusy, controller.answeredSegments,
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
    displayedAudioSourceLabel: controller.displayedAudioSourceLabel,
    displayedAudioStatus: controller.displayedAudioStatus,
    microphoneStatus: controller.microphoneStatus,
    systemAudioStatus: controller.systemAudioStatus,
    audioLevel: controller.audioLevel,
    meetingMenuOpen: controller.meetingMenuOpen,
    statusTone,
    statusLabel,
    pipelineStatus: controller.pipelineStatus,
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
    onTestAudio: () => void controller.testSystemAudio(),
    onStartCapture: () => void controller.startMeetingCapture(),
    onStopCapture: controller.stopMeetingCapture,
    onTranscriptToggle: () => controller.setTranscriptOpen((open) => !open),
    onTranscriptSearchChange: controller.setTranscriptSearch,
    onUseTranscript: (transcript) => controller.setInput(`Summarize the ${transcript.source} meeting and list the action items.`),
    onSaveTranscript: controller.saveMeetingTranscript,
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
