import {
  Bot,
  CheckCircle2,
  FileText,
  History,
  Link as LinkIcon,
  Loader2,
  MonitorUp,
  Search,
  Settings,
  Square,
  Video,
  Volume2,
  VolumeX,
  X,
  Zap
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { questionFingerprintForComparison, type PreparedQuestion } from './audio/transcriptUtils';
import {
  INTERVIEW_BACKGROUND_OPTIONS,
  INTERVIEW_DOMAIN_OPTIONS,
  microphoneDisplayLabel,
  readPersistedInterviewContext,
  writePersistedInterviewContext,
  type InterviewContextConfig,
} from './ai/interviewContext';
import { truncateContextText } from './context/contextResolver';
import {
  allowsCustomModel,
  getDefaultModel,
  getModelsForProvider,
  getProviderConfig,
  getProviderIds,
  getProviderModelValidationError,
  isValidCustomProviderEndpoint,
  isProviderEndpointConfigurable,
  isProviderEndpointRequired,
  type ProviderId,
} from './config/providerRegistry.helpers';
import { getProviderSecret, removeProviderSecret, setProviderSecret } from './config/providerSecretStore';
import { ProviderHydrationRequestError, retryProviderHydration } from './config/providerHydration';
import {
  readPersistedProviderSecrets,
  readPersistedProviderSettings,
  writePersistedProviderSettings,
} from './config/providerPersistence';
import { runtimeConfig } from './config/runtimeConfig';
import { createPastedDocument, extractPdfDocuments, type NormalizedDocument } from './documents/documentService';
import { ConfiguredProvidersPanel } from './ui/ConfiguredProvidersPanel';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { ContextInputDialog } from './ui/ContextInputDialog';
import { CodingAgentPage } from './features/coding/CodingAgentPage';
import type { CodingHistoryRestoreRequest } from './features/coding/CodingAgentPage';
import { GeneralAgentPage } from './features/general/GeneralAgentPage';
import { AssistantAgentPage } from './features/assistant/AssistantAgentPage';
import type { AssistantControllerSnapshot } from './features/assistant/AssistantAgentPage';
import { MeetingAssistantPage } from './features/meeting/MeetingAssistantPage';
import type { MeetingControllerSnapshot } from './features/meeting/MeetingAssistantPage';
import type { MeetingRequestContext } from './features/meeting/meetingRequestBuilder';
import type { AssistantRequestContext } from './features/assistant/assistantRequestBuilder';
import { ChatHistoryModal } from './features/history/ChatHistoryModal';
import { AppHeader } from './ui/header/AppHeader';
import { ContextButton, ContextPanel, FontSizeControls, HistoryButton, OverlayButton, ScreenReadingToggle, SettingsButton } from './ui/header/HeaderActions';
import { ModeControls } from './ui/header/ModeControls';
import type { AppMode, AssistantMode, MeetingAudioMode } from './app/appTypes';
import { DEFAULT_MEETING_HISTORY_RETENTION_DAYS, isMeetingHistoryRetentionDue, pruneHistorySessions, readHistory, readMeetingHistoryRetention, removeHistorySession, searchHistory, upsertHistory, writeHistory, writeMeetingHistoryRetention, type HistoryMode, type HistorySession, type MeetingHistoryRetentionDays } from './history/historyService';

type Message = AssistantControllerSnapshot['messages'][number];

const EMPTY_ASSISTANT_MESSAGES: AssistantControllerSnapshot['messages'] = [];
const IGNORE_ASSISTANT_MESSAGES: AssistantControllerSnapshot['setMessages'] = () => {};
const IGNORE_ASSISTANT_INPUT: AssistantControllerSnapshot['setInput'] = () => {};
const IGNORE_ASSISTANT_SEND: AssistantControllerSnapshot['sendMessage'] = async () => {};
const EMPTY_MEETING_CONTROLLER: MeetingControllerSnapshot = {
  meetingAudioMode: 'microphone',
  setMeetingAudioMode: () => {},
  selectMicrophoneDevice: () => {},
  restoreMeetingHistory: () => {},
  meetingConversationId: '',
  transcriptionLanguage: 'auto',
  setTranscriptionLanguage: () => {},
  reviewBeforeSend: false,
  setReviewBeforeSend: () => {},
  pendingTranscriptReviews: [],
  sendReviewedTranscript: async () => {},
  skipReviewedTranscript: () => {},
  meetingMenuOpen: false,
  setMeetingMenuOpen: () => {},
  microphoneDevices: [],
  microphoneUnavailable: false,
  transcriptOpen: false,
  setTranscriptOpen: () => {},
  isRecording: false,
  isTranscribing: false,
  audioSourceLabel: '',
  audioLevel: 0,
  audioStatus: 'disabled',
  systemAudioStatus: 'off',
  microphoneStatus: 'off',
  pipelineStatus: 'ready',
  pipelineStatusSince: 0,
  audioSignalDetected: false,
  lastStageTimings: {},
  setPipelineStatus: () => {},
  input: '',
  setInput: () => {},
  chatBusy: false,
  answeredSegments: [],
  meetingError: '',
  meetingStatusMessage: '',
  reportError: () => {},
  lastQuestion: '',
  lastAnswer: '',
  liveTranscript: '',
  transcripts: [],
  transcriptSearch: '',
  setTranscriptSearch: () => {},
  filteredTranscripts: [],
  selectedMicrophone: null,
  selectedMicrophoneLabel: '',
  microphoneDevicePresent: false,
  configuredMicrophoneLabel: '',
  displayedAudioSourceLabel: '',
  displayedAudioStatus: '',
  refreshMicrophoneDevices: async () => {},
  stopMeetingCapture: () => {},
  startMeetingCapture: async () => false,
  testMeetingAudio: async () => {},
  saveMeetingTranscript: () => undefined,
  deleteMeetingTranscript: () => undefined,
  clearMeetingHistory: () => undefined,
  historyRetentionDays: DEFAULT_MEETING_HISTORY_RETENTION_DAYS,
  setHistoryRetentionDays: () => true,
  sendQuestion: async () => false,
  sendTypedQuestion: () => undefined,
  sendEditedTranscript: () => undefined,
  cancelCurrentRequest: () => false,
};

interface AgentActivity {
  id: string;
  target: string;
  action: string;
  createdAt: string;
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
  mode: HistoryMode;
  projectRoot?: string | null;
  pendingPlan?: Record<string, unknown> | null;
  appliedPatchLog?: Array<{ proposalId?: string; files: string[]; state: string; appliedAt?: string; verification?: string }>;
  providerNeutralSummary?: string;
  lastUsedProvider?: { id?: string; label?: string; model?: string; changedAt?: string } | null;
}

type SessionDocument = NormalizedDocument;

interface TrainedProfile {
  id: string;
  name: string;
  summary: string;
  context: string;
  createdAt: number;
}

interface ConfiguredProvider {
  id: string;
  label: string;
  adapterType: string;
  model: string;
  baseURL?: string;
  enabled: boolean;
  priority: number;
  status?: string;
  hasApiKey?: boolean;
  assistantCapable?: boolean;
  developerToolCalling?: boolean;
  developerToolCallingVerified?: boolean;
  developerStatus?: string;
  capabilities?: { chat?: boolean; toolCalling?: boolean; streaming?: boolean; stt?: boolean };
  capabilityStates?: Record<string, 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'>;
  failureCategory?: string;
  failureDetails?: {
    category?: string;
    reason?: string;
    statusCode?: number | null;
    rawMessage?: string;
    requestCapture?: { method?: string; url?: string; body?: string };
  };
  configurationValid?: boolean;
  configurationError?: { code?: string; message?: string };
}

interface ConfirmationRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: 'danger' | 'primary';
  onConfirm: () => void | Promise<void>;
}

interface ScreenReadingPreference {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const HTTP_URL = runtimeConfig.httpUrl;
const CUSTOM_PROVIDER_MODEL = '__custom_provider_model__';
const {
  maxChatHistoryMessages: MAX_CHAT_HISTORY_MESSAGES,
  maxContextChars: MAX_CONTEXT_CHARS,
} = runtimeConfig.limits;
const PDF_CONTEXT_CHAR_BUDGET = Math.floor(MAX_CONTEXT_CHARS * runtimeConfig.limits.pdfContextBudgetRatio);
function providerResponseError(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.error === 'string') return data.error;
  if (typeof data.detail === 'string') return data.detail;
  if (data.detail && typeof data.detail === 'object' && typeof (data.detail as { message?: unknown }).message === 'string') {
    return (data.detail as { message: string }).message;
  }
  return fallback;
}
const defaultAgentPermissions = { openTeams: false, openBrowser: false, openCamera: false, openChrome: false, openVSCode: false, openDesktop: false, openSourceTree: false, openSqlServer: false, openNotepad: false, openSublime: false };
const allAgentPermissions = { openTeams: true, openBrowser: true, openCamera: true, openChrome: true, openVSCode: true, openDesktop: true, openSourceTree: true, openSqlServer: true, openNotepad: true, openSublime: true };
const agentPermissionOptions = [
  ['openCamera', 'Camera', 'camera'], ['openChrome', 'Chrome', 'chrome'], ['openVSCode', 'VS Code', 'vscode'], ['openDesktop', 'Desktop / File Explorer', 'desktop'], ['openSourceTree', 'SourceTree', 'sourcetree'], ['openSqlServer', 'SQL Server Management Studio', 'sqlserver'], ['openNotepad', 'Notepad', 'notepad'], ['openSublime', 'Sublime Text', 'sublime'], ['openTeams', 'Microsoft Teams', 'teams'], ['openBrowser', 'Browser URL', 'browser'],
] as const;

function App() {
  const [chatHistory, setChatHistory] = useState<ChatSession[]>(readHistory);
  const [historyRetention, setHistoryRetention] = useState<MeetingHistoryRetentionDays>(readMeetingHistoryRetention);
  const [activeChatId, setActiveChatId] = useState<string>(() => crypto.randomUUID());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [copiedItem, setCopiedItem] = useState('');
  const [appMode, setAppMode] = useState<AppMode>('assistant');
  const [mode, setMode] = useState<AssistantMode>('direct');
  const [pdfText, setPdfText] = useState('');
  const [pdfName, setPdfName] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [health, setHealth] = useState<{ provider: string; model: string; sttReady?: boolean; sttProvider?: string } | null>(null);
  const [assistantController, setAssistantController] = useState<AssistantControllerSnapshot | null>(null);
  const [meetingController, setMeetingController] = useState<MeetingControllerSnapshot | null>(null);
  const [assistantScreenReading, setAssistantScreenReading] = useState<ScreenReadingPreference | null>(null);
  const [meetingScreenReading, setMeetingScreenReading] = useState<ScreenReadingPreference | null>(null);
  const [codingBusy, setCodingBusy] = useState(false);
  const [codingRestoreRequest, setCodingRestoreRequest] = useState<CodingHistoryRestoreRequest | null>(null);
  const codingRestoreKeyRef = useRef(0);
  const [generalBusy, setGeneralBusy] = useState(false);
  const [sessionDocuments, setSessionDocuments] = useState<SessionDocument[]>([]);
  const [trainedProfiles, setTrainedProfiles] = useState<TrainedProfile[]>(() => {
    try {
      const raw = localStorage.getItem('trained-profiles-v1');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('active-profile-id-v1') || null;
    } catch {
      return null;
    }
  });
  const [profilePreviewOpen, setProfilePreviewOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState('');
  const [profileTraining, setProfileTraining] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [jobDescription, setJobDescription] = useState('');
  const [interviewConfig, setInterviewConfig] = useState<InterviewContextConfig>(() => readPersistedInterviewContext());
  const [backgroundSearch, setBackgroundSearch] = useState('');
  const [backgroundOptionsOpen, setBackgroundOptionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'providers' | 'permissions'>('providers');
  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const [providerKey, setProviderKey] = useState('');
  const [providerModel, setProviderModel] = useState('');
  const [providerModelIsCustom, setProviderModelIsCustom] = useState(false);
  const [providerBaseURL, setProviderBaseURL] = useState('');
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerRefreshing, setProviderRefreshing] = useState(false);
  const providerHydrationPromiseRef = useRef<Promise<void> | null>(null);
  const providerHydrationAbortControllerRef = useRef<AbortController | null>(null);
  const [selfTestingProviderId, setSelfTestingProviderId] = useState<string | null>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [speechProviderId, setSpeechProviderId] = useState('');
  const [effectiveSpeechProviderId, setEffectiveSpeechProviderId] = useState('');
  const [providerLabel, setProviderLabel] = useState('');
  const [providerEnabled, setProviderEnabled] = useState(true);
  const [fallbackEnabled, setFallbackEnabled] = useState(true);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [agentPermissions, setAgentPermissions] = useState(defaultAgentPermissions);
  const [agentUrl, setAgentUrl] = useState('https://teams.microsoft.com');
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentActionTarget, setAgentActionTarget] = useState<string | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeFileInputRef = useRef<HTMLInputElement>(null);
  const jobDescriptionFileInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const activeProfile = trainedProfiles.find((profile) => profile.id === activeProfileId) ?? null;
  const microphoneDevicePresent = meetingController?.microphoneDevicePresent ?? false;
  const assistantRequestContext = useMemo<AssistantRequestContext>(() => ({
    mode,
    sessionDocuments,
    activeProfile,
    interviewConfig,
    microphoneDevicePresent,
    contextCharBudget: PDF_CONTEXT_CHAR_BUDGET,
    maxHistoryMessages: MAX_CHAT_HISTORY_MESSAGES,
    maxContextChars: MAX_CONTEXT_CHARS,
  }), [activeProfile, interviewConfig, microphoneDevicePresent, mode, sessionDocuments]);
  const meetingRequestContext = useMemo<MeetingRequestContext>(() => ({
    mode,
    sessionDocuments,
    activeProfile,
    interviewConfig,
    microphoneDevicePresent,
    contextCharBudget: PDF_CONTEXT_CHAR_BUDGET,
    maxHistoryMessages: MAX_CHAT_HISTORY_MESSAGES,
    maxContextChars: MAX_CONTEXT_CHARS,
  }), [activeProfile, interviewConfig, microphoneDevicePresent, mode, sessionDocuments]);
  const acceptedQuestionHistoryRef = useRef<string[]>([]);
  const rememberAcceptedQuestion = useCallback((question: string) => {
    const fingerprint = questionFingerprintForComparison(question);
    const history = acceptedQuestionHistoryRef.current;
    if (!fingerprint || history.includes(fingerprint)) return false;
    acceptedQuestionHistoryRef.current = [...history, fingerprint].slice(-5);
    return true;
  }, []);
  const meeting = meetingController ?? EMPTY_MEETING_CONTROLLER;
  const {
    meetingAudioMode, setMeetingAudioMode, meetingMenuOpen, setMeetingMenuOpen,
    microphoneDevices, microphoneUnavailable, selectedMicrophoneLabel,
    isRecording, isTranscribing, audioLevel, audioStatus, systemAudioStatus, microphoneStatus,
    pipelineStatus, chatBusy: meetingChatBusy,
    answeredSegments: meetingAnsweredSegments, liveTranscript, transcripts, transcriptSearch,
    setTranscriptSearch, filteredTranscripts, displayedAudioSourceLabel, startMeetingCapture,
    stopMeetingCapture, testMeetingAudio, saveMeetingTranscript,
  } = meeting;
  const messages = assistantController?.messages ?? EMPTY_ASSISTANT_MESSAGES;
  const setMessages: AssistantControllerSnapshot['setMessages'] = assistantController?.setMessages ?? IGNORE_ASSISTANT_MESSAGES;
  const input = assistantController?.input ?? '';
  const setInput: AssistantControllerSnapshot['setInput'] = assistantController?.setInput ?? IGNORE_ASSISTANT_INPUT;
  const assistantPipelineStatus = assistantController?.pipelineStatus ?? 'ready';
  const connected = assistantController?.connected ?? false;
  const sendAssistantMessage: AssistantControllerSnapshot['sendMessage'] = assistantController?.sendMessage ?? IGNORE_ASSISTANT_SEND;
  const requestConfirmation = useCallback((request: ConfirmationRequest) => {
    setConfirmation(request);
  }, []);

  const addGeneralHistoryEntry = useCallback((entry: HistorySession) => {
    setChatHistory((previous) => upsertHistory(previous, entry));
  }, []);

  const addMeetingHistoryEntry = useCallback((entry: HistorySession) => {
    setChatHistory((previous) => upsertHistory(previous, entry));
  }, []);

  const clearMeetingHistory = useCallback(() => {
    setChatHistory((previous) => previous.filter((session) => session.mode !== 'meeting'));
  }, []);

  const changeHistoryRetention = useCallback((retention: MeetingHistoryRetentionDays) => {
    const saved = meetingController?.setHistoryRetentionDays(retention);
    if (saved === false || (saved === undefined && !writeMeetingHistoryRetention(retention))) {
      throw new Error('Could not save the history retention setting.');
    }
    setHistoryRetention(retention);
    setChatHistory((previous) => pruneHistorySessions(previous, retention));
  }, [meetingController]);
  const addAssistantHistoryEntries = useCallback((conversationId: string, entries: HistorySession[]) => {
    setChatHistory((previous) => {
      const withoutCurrentConversation = previous.filter((session) => session.id !== conversationId
        && !session.id.startsWith(`${conversationId}-turn-`));
      return entries.reduce((sessions, entry) => upsertHistory(sessions, entry), withoutCurrentConversation);
    });
  }, []);

  const closeConfirmation = useCallback(() => {
    setConfirmation(null);
  }, []);

  // --- Auto-scroll to bottom on new content ---
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!writeHistory(chatHistory)) {
      setError('Chat history could not be saved because browser storage is full or unavailable.');
    }
  }, [chatHistory]);
  useEffect(() => {
    const pruneExpiredHistory = () => {
      const retention = readMeetingHistoryRetention();
      setChatHistory((current) => {
        const retained = pruneHistorySessions(current, retention);
        return retained.length === current.length ? current : retained;
      });
      if (isMeetingHistoryRetentionDue(retention)) {
        if (writeMeetingHistoryRetention(DEFAULT_MEETING_HISTORY_RETENTION_DAYS)) {
          setHistoryRetention(DEFAULT_MEETING_HISTORY_RETENTION_DAYS);
        } else {
          setError('Scheduled history was deleted, but the retention setting could not be reset. Update it in Chat history.');
        }
        setMessages([]);
        setInput('');
      }
    };
    pruneExpiredHistory();
    const timer = window.setInterval(pruneExpiredHistory, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [setInput, setMessages]);

  const resetProviderForm = useCallback(() => {
    setEditingProviderId(null);
    setProviderId(null);
    setProviderKey('');
    setProviderModel('');
    setProviderModelIsCustom(false);
    setProviderBaseURL('');
    setProviderLabel('');
    setProviderEnabled(true);
  }, []);

  useEffect(() => {
    if (settingsOpen) return;
    resetProviderForm();
  }, [resetProviderForm, settingsOpen]);

  useEffect(() => {
    if (configuredProviders.length === 0) return;
    const selectedProviderType = configuredProviders.find((provider) => provider.id === activeProviderId)?.adapterType || null;
    const persisted = writePersistedProviderSettings(selectedProviderType, configuredProviders.map((provider) => ({
      id: provider.id,
      label: provider.label,
      adapterType: provider.adapterType,
      model: provider.model,
      baseURL: provider.baseURL || '',
      enabled: provider.enabled,
      priority: provider.priority,
      status: provider.status || 'unknown',
    })), readPersistedProviderSecrets());
    if (!persisted) setError('Provider settings could not be saved in browser storage.');
  }, [activeProviderId, configuredProviders]);

  useEffect(() => {
    localStorage.setItem('trained-profiles-v1', JSON.stringify(trainedProfiles));
  }, [trainedProfiles]);

  useEffect(() => {
    if (activeProfileId) {
      localStorage.setItem('active-profile-id-v1', activeProfileId);
    } else {
      localStorage.removeItem('active-profile-id-v1');
    }
  }, [activeProfileId]);

  useEffect(() => {
    writePersistedInterviewContext(interviewConfig);
  }, [interviewConfig]);

  const savedJobDescription = sessionDocuments.find((document) => document.name === 'Job Description: Pasted text')?.text || '';
  const closeContextMenu = useCallback(() => {
    setContextMenuOpen(false);
    setBackgroundOptionsOpen(false);
    setBackgroundSearch('');
    setJobDescription(savedJobDescription);
  }, [savedJobDescription]);

  const openContextMenu = useCallback(() => {
    setJobDescription(savedJobDescription);
    setContextMenuOpen(true);
  }, [savedJobDescription]);

  useEffect(() => {
    if (!settingsOpen && !historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmation || profileDialogOpen) return;
      if (settingsOpen && (providerSaving || agentSaving)) return;
      if (settingsOpen) setSettingsOpen(false);
      if (historyOpen) setHistoryOpen(false);
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [agentSaving, confirmation, historyOpen, profileDialogOpen, providerSaving, settingsOpen]);

  useEffect(() => {
    if ((!contextMenuOpen && !meetingMenuOpen) || confirmation || profileDialogOpen) return;
    const closePopoverOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (contextMenuOpen) closeContextMenu();
      if (meetingMenuOpen) setMeetingMenuOpen(false);
    };
    const closeContextOnOutsidePointer = (event: MouseEvent) => {
      if (!contextMenuOpen || !(event.target instanceof Node)) return;
      const target = event.target as Element;
      if (contextMenuRef.current?.contains(target) || target.closest('[data-context-toggle]')) return;
      closeContextMenu();
    };
    document.addEventListener('keydown', closePopoverOnEscape);
    document.addEventListener('mousedown', closeContextOnOutsidePointer);
    return () => {
      document.removeEventListener('keydown', closePopoverOnEscape);
      document.removeEventListener('mousedown', closeContextOnOutsidePointer);
    };
  }, [closeContextMenu, confirmation, contextMenuOpen, meetingMenuOpen, profileDialogOpen, setMeetingMenuOpen]);

  // --- Fetch health info on mount ---
  useEffect(() => {
    fetch(`${HTTP_URL}/api/health`)
      .then((r) => r.json())
      .then((data) => setHealth({ provider: data.provider, model: data.model }))
      .catch(() => setError(`Cannot reach the AI server at ${HTTP_URL}.`));
  }, []);

  const { domain, background, microphoneDeviceId } = interviewConfig;
  const filteredBackgroundOptions = INTERVIEW_BACKGROUND_OPTIONS.filter((option) => (
    !background.includes(option)
    && (!backgroundSearch.trim() || option.toLowerCase().includes(backgroundSearch.trim().toLowerCase()))
  ));

  const selectDomain = (value: string) => {
    setInterviewConfig((current) => ({ ...current, domain: value || null }));
  };

  const toggleBackground = (technology: string) => {
    setInterviewConfig((current) => ({
      ...current,
      background: current.background.includes(technology)
        ? current.background.filter((item) => item !== technology)
        : [...current.background, technology],
    }));
  };

  const clearSessionContext = useCallback(() => {
    setSessionDocuments([]);
    setPdfText('');
    setPdfName('');
    setJobDescription('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (resumeFileInputRef.current) resumeFileInputRef.current.value = '';
    if (jobDescriptionFileInputRef.current) jobDescriptionFileInputRef.current.value = '';
    setStatusMessage('Session context cleared.');
  }, []);

  const requestClearSessionContext = useCallback(() => {
    requestConfirmation({
      title: 'Clear session uploads?',
      description: 'This removes the uploaded Resume and Job Description from the current session. Trained profiles are kept.',
      confirmLabel: 'Clear uploads',
      onConfirm: clearSessionContext,
    });
  }, [clearSessionContext, requestConfirmation]);

  const deleteProfile = useCallback((profileId: string) => {
    const profile = trainedProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    requestConfirmation({
      title: 'Delete trained profile?',
      description: `Delete "${profile.name}" permanently? The currently uploaded session documents will not be changed.`,
      confirmLabel: 'Delete profile',
      onConfirm: () => {
        setTrainedProfiles((prev) => prev.filter((item) => item.id !== profileId));
        setActiveProfileId((current) => (current === profileId ? null : current));
        setProfilePreviewOpen(false);
        setStatusMessage('Profile deleted.');
      },
    });
  }, [requestConfirmation, trainedProfiles]);

  const replaceSessionDocuments = useCallback((documentLabel: string, documents: SessionDocument[]) => {
    setSessionDocuments((previous) => [
      ...previous.filter((document) => !document.name.startsWith(`${documentLabel}:`)),
      ...documents,
    ]);
  }, []);

  const removeSessionDocuments = useCallback((documentLabel: string) => {
    setSessionDocuments((previous) => {
      const next = previous.filter((document) => !document.name.startsWith(`${documentLabel}:`));
      setPdfText(next.map((document) => document.text).join('\n\n'));
      return next;
    });
    if (documentLabel === 'Resume') setPdfName('');
    if (documentLabel === 'Job Description') setJobDescription('');
  }, []);

  const requestRemoveResume = useCallback(() => {
    requestConfirmation({
      title: 'Remove Resume?',
      description: 'Remove the current Resume from this session context. The Job Description and trained profiles will remain.',
      confirmLabel: 'Remove Resume',
      onConfirm: () => {
        removeSessionDocuments('Resume');
        setStatusMessage('Resume removed from session context.');
      },
    });
  }, [removeSessionDocuments, requestConfirmation]);

  const requestRemoveJobDescription = useCallback(() => {
    requestConfirmation({
      title: 'Remove Job Description?',
      description: 'Remove the current Job Description from this session context. The Resume will remain.',
      confirmLabel: 'Remove Job Description',
      onConfirm: () => {
        removeSessionDocuments('Job Description');
        setStatusMessage('Job Description removed from session context.');
      },
    });
  }, [removeSessionDocuments, requestConfirmation]);

  const handlePdfUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>, documentType: 'resume' | 'job-description' | 'session' = 'session') => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    setPdfLoading(true);
    setError('');
    setStatusMessage('');

    try {
      const extractedDocs = await extractPdfDocuments(files, documentType, runtimeConfig);

      if (!extractedDocs.length) return;
      const documentLabel = documentType === 'resume'
        ? 'Resume'
        : documentType === 'job-description'
          ? 'Job Description'
          : 'Session Document';
      replaceSessionDocuments(documentLabel, extractedDocs);
      const combinedText = extractedDocs.map((doc) => doc.text).join('\n\n');
      setPdfText(combinedText);
      if (documentLabel === 'Resume') {
        setPdfName(extractedDocs.map((doc) => doc.name).join(', '));
      }
      if (documentLabel === 'Job Description') setJobDescription('');
      setStatusMessage(`${extractedDocs.length} PDF document${extractedDocs.length > 1 ? 's were' : ' was'} added to session context.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPdfLoading(false);
      event.target.value = '';
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [replaceSessionDocuments]);

  const handleResumeUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    void handlePdfUpload(event, 'resume');
  }, [handlePdfUpload]);

  const handleJobDescriptionPdfUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    await handlePdfUpload(event, 'job-description');
  }, [handlePdfUpload]);

  const saveJobDescription = useCallback(() => {
    const text = jobDescription.trim();
    if (!text) return;

    const pastedDocument = createPastedDocument(jobDescription);
    if (!pastedDocument) return;
    setSessionDocuments((previous) => [
      ...previous.filter((document) => !document.name.startsWith('Job Description:')),
      pastedDocument,
    ]);
    setStatusMessage('Pasted job description added to session context.');
    setError('');
  }, [jobDescription]);

  const trainProfile = useCallback(() => {
    if (!sessionDocuments.length) {
      setError('Upload at least one readable PDF before creating a trained profile.');
      return;
    }

    const suggestedName = sessionDocuments[0]?.name.replace(/\.pdf$/i, '') || 'Profile';
    setProfileNameDraft(suggestedName);
    setProfileDialogOpen(true);
    setError('');
  }, [sessionDocuments]);

  const completeProfileTraining = useCallback(async (profileName: string) => {
    if (profileTraining) return;
    setProfileTraining(true);
    const trimmedName = profileName.trim();
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const context = sessionDocuments
        .map((doc) => `Document: ${doc.name}\n${doc.text}`)
        .join('\n\n');
      const summary = `Session context from ${sessionDocuments.length} document${sessionDocuments.length > 1 ? 's' : ''}.`;

      setTrainedProfiles((prev) => {
        const normalized = trimmedName.toLowerCase();
        const existingIndex = prev.findIndex((profile) => profile.name.toLowerCase() === normalized);
        const profile: TrainedProfile = {
          id: existingIndex >= 0 ? prev[existingIndex].id : crypto.randomUUID(),
          name: trimmedName,
          summary,
          context: truncateContextText(context, MAX_CONTEXT_CHARS),
          createdAt: Date.now(),
        };
        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = profile;
          return next;
        }
        return [profile, ...prev];
      });
      setStatusMessage(`Profile "${trimmedName}" is ready.`);
      setError('');
      setProfileDialogOpen(false);
      setProfileNameDraft('');
    } catch (err) {
      setError(`Training failed: ${(err as Error).message}`);
    } finally {
      setProfileTraining(false);
    }
  }, [profileTraining, sessionDocuments]);

  // --- Send a chat message ---

  const sendMessage = async (
    question = input.trim(),
    contextOverride?: string,
    modelInstruction = question,
    questionFinalizedAt = performance.now(),
    options: { preparedQuestion?: PreparedQuestion; duplicateChecked?: boolean; screenImage?: string } = {},
  ) => {
    const rawQuestion = question.trim();
    if (!rawQuestion) return;

    if (/^open\s+(to\s+)?(team|teams|microsoft\s+teams)\s*$/i.test(rawQuestion)) {
      setInput('');
      setError('');
      requestConfirmation({
        title: 'Open Microsoft Teams?',
        description: 'The local agent will open Microsoft Teams. It will not place a call or send a message.',
        confirmLabel: 'Open Teams',
        variant: 'primary',
        onConfirm: async () => {
          try {
            const response = await fetch(`${HTTP_URL}/api/agent/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ target: 'teams', confirmed: true }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Opening Teams was blocked. Enable Allow open Teams in AI Settings.');
            setMessages((prev) => [...prev,
              { role: 'user', content: rawQuestion },
              { role: 'assistant', content: 'Opening Microsoft Teams.' },
            ]);
          } catch (err) {
            setError((err as Error).message);
          }
        },
      });
      return;
    }

    if (/^call\s+(to\s+)?anurag\s*$/i.test(rawQuestion)) {
      setInput('');
      setError('');
      requestConfirmation({
        title: 'Open Microsoft Teams?',
        description: 'Teams will open so you can place the call yourself. The assistant will not call or message anyone automatically.',
        confirmLabel: 'Open Teams',
        variant: 'primary',
        onConfirm: async () => {
          try {
            const response = await fetch(`${HTTP_URL}/api/agent/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ target: 'teams', confirmed: true }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Opening Teams was blocked. Enable the Teams permission first.');
            setMessages((prev) => [...prev,
              { role: 'user', content: rawQuestion },
              { role: 'assistant', content: "Teams is open. I cannot place a call by display name alone. Confirm Anurag's Teams contact or click the call button in Teams." },
            ]);
          } catch (err) {
            setError((err as Error).message);
          }
        },
      });
      return;
    }

    return sendAssistantMessage(question, contextOverride, modelInstruction, questionFinalizedAt, options);
  };

  const chooseProvider = (value: ProviderId) => {
    if (editingProviderId) return;
    setProviderId(value);
    setProviderKey('');
    setProviderModel('');
    setProviderModelIsCustom(false);
    setProviderBaseURL(getProviderConfig(value)?.baseURL || '');
  };
  const providerModelChoices = providerId ? getModelsForProvider(providerId) : [];
  const isCustomProvider = providerId ? allowsCustomModel(providerId) : false;
  const providerModelError = providerId
    ? getProviderModelValidationError(providerId, providerModel)
      || (isProviderEndpointRequired(providerId)
        && !isValidCustomProviderEndpoint(providerBaseURL)
        ? 'Enter a valid HTTP(S) endpoint URL for this provider.'
        : null)
    : null;
  const editingProvider = configuredProviders.find((provider) => provider.id === editingProviderId);
  const providerFormDirty = !editingProvider || (
    providerLabel.trim() !== editingProvider.label
    || providerEnabled !== editingProvider.enabled
    || providerModel !== editingProvider.model
    || (providerBaseURL || '') !== (editingProvider.baseURL || '')
    || Boolean(providerKey.trim())
  );
  const canSaveProvider = !providerSaving
    && Boolean(providerId)
    && !providerModelError
    && providerFormDirty
    && (Boolean(providerKey.trim()) || Boolean(editingProvider));

  const loadConfiguredProviders = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(`${HTTP_URL}/api/settings/providers`, { signal });
    if (!response.ok) {
      throw new ProviderHydrationRequestError(
        `Could not load providers (HTTP ${response.status}).`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const data = await response.json();
    let providers = Array.isArray(data.providers) ? data.providers : [];
    const savedProviderSettings = readPersistedProviderSettings();
    const persistedSecrets = readPersistedProviderSecrets();
    const failedSecretRestores: string[] = [];

    // Rehydrate secrets into the backend process after a restart. The server
    // persists provider metadata only; the actual key remains in this client
    // store and is sent over the local settings request when available.
    for (const provider of providers) {
      const adapterType = provider.adapterType;
      const apiKey = adapterType
        ? getProviderSecret(persistedSecrets, String(provider.id || ''), adapterType)
        : '';
      if (!adapterType || !apiKey) continue;
      const hydrated = await fetch(`${HTTP_URL}/api/settings/providers/${encodeURIComponent(provider.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey }),
        signal,
      });
      const hydratedData = await hydrated.json();
      if (hydrated.ok && Array.isArray(hydratedData.providers)) {
        providers = hydratedData.providers;
        const providerId = String(provider.id || '');
        if (providerId) {
          Object.assign(
            persistedSecrets,
            setProviderSecret(persistedSecrets, providerId, adapterType, apiKey),
          );
          delete persistedSecrets[adapterType];
        }
      } else {
        if (hydrated.status === 408 || hydrated.status === 429 || hydrated.status >= 500) {
          throw new ProviderHydrationRequestError(
            `Could not restore a saved API key for ${provider.label} (HTTP ${hydrated.status}).`,
            true,
          );
        }
        failedSecretRestores.push(String(provider.label || adapterType));
        providers = providers.map((item: ConfiguredProvider) => item.id === provider.id
          ? { ...item, hasApiKey: false, status: 'UNCONFIGURED' }
          : item);
      }
    }

    setConfiguredProviders(providers);
    const activeProvider = typeof data.activeProvider === 'string'
      ? providers.find((provider: ConfiguredProvider) => provider.id === data.activeProvider)
      : undefined;
    setActiveProviderId(typeof data.activeProvider === 'string' ? data.activeProvider : null);
    if (typeof data.fallbackEnabled === 'boolean') setFallbackEnabled(data.fallbackEnabled);
    setSpeechProviderId(typeof data.sttProvider === 'string' ? data.sttProvider : '');
    setEffectiveSpeechProviderId(typeof data.effectiveSttProvider === 'string' ? data.effectiveSttProvider : '');
    if (providers.length === 0) {
      const savedProviderMetadata = savedProviderSettings.providers;
      const savedProviders = savedProviderMetadata.flatMap((saved) => {
        const adapterType = typeof saved.adapterType === 'string' ? saved.adapterType : '';
        const savedId = typeof saved.id === 'string' ? saved.id : '';
        const apiKey = adapterType ? getProviderSecret(persistedSecrets, savedId, adapterType) : '';
        if (!adapterType || !apiKey || !getProviderConfig(adapterType)) return [];
        return [{
          ...(savedId ? { providerId: savedId, createNew: true } : { createNew: true }),
          label: String(saved.label || adapterType),
          adapterType,
          apiKey,
          model: String(saved.model || getDefaultModel(adapterType)),
          baseURL: String(saved.baseURL || getProviderConfig(adapterType)?.baseURL || ''),
          enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
        }];
      });
      const restoredAdapters = new Set(savedProviders.map((provider) => provider.adapterType));
      const legacySavedProviders = getProviderIds().flatMap((name) => {
        const preset = getProviderConfig(name);
        if (!preset || !persistedSecrets[name] || restoredAdapters.has(name)) return [];
        return [{
          createNew: true,
          label: preset.displayName,
          adapterType: name,
          apiKey: persistedSecrets[name],
          model: preset.defaultModel,
          baseURL: preset.baseURL,
          enabled: true,
        }];
      });
      for (const provider of [...savedProviders, ...legacySavedProviders]) {
        const restored = await fetch(`${HTTP_URL}/api/settings/providers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(provider),
          signal,
        });
        const restoredData = await restored.json();
        if (!restored.ok) {
          if (restored.status === 408 || restored.status === 429 || restored.status >= 500) {
            throw new ProviderHydrationRequestError(
              `Could not restore a saved provider (${restored.status}).`,
              true,
            );
          }
          failedSecretRestores.push(provider.label);
          continue;
        }
        const savedProviderId = String(restoredData.provider?.id || '');
        if (savedProviderId) {
          Object.assign(
            persistedSecrets,
            setProviderSecret(persistedSecrets, savedProviderId, provider.adapterType, provider.apiKey),
          );
          delete persistedSecrets[provider.adapterType];
        }
      }
      const hydrated = await fetch(`${HTTP_URL}/api/settings/providers`, { signal });
      if (!hydrated.ok) {
        throw new ProviderHydrationRequestError(
          `Could not reload providers after credential restoration (HTTP ${hydrated.status}).`,
          hydrated.status === 408 || hydrated.status === 429 || hydrated.status >= 500,
        );
      }
      const hydratedData = await hydrated.json();
      const restoredProviders = Array.isArray(hydratedData.providers) ? hydratedData.providers : [];
      providers = restoredProviders;
      setConfiguredProviders(restoredProviders);
      setActiveProviderId(typeof hydratedData.activeProvider === 'string' ? hydratedData.activeProvider : null);
      if (typeof hydratedData.fallbackEnabled === 'boolean') setFallbackEnabled(hydratedData.fallbackEnabled);
      setSpeechProviderId(typeof hydratedData.sttProvider === 'string' ? hydratedData.sttProvider : '');
      setEffectiveSpeechProviderId(typeof hydratedData.effectiveSttProvider === 'string' ? hydratedData.effectiveSttProvider : '');
      const restoredActiveProvider = typeof hydratedData.activeProvider === 'string'
        ? restoredProviders.find((provider: ConfiguredProvider) => provider.id === hydratedData.activeProvider)
        : undefined;
      if (restoredProviders.length > 0) {
        const persisted = writePersistedProviderSettings(
          restoredActiveProvider?.adapterType || restoredProviders[0]?.adapterType || null,
          restoredProviders.map((provider: ConfiguredProvider) => ({
            id: provider.id,
            label: provider.label,
            adapterType: provider.adapterType,
            model: provider.model,
            baseURL: provider.baseURL || '',
            enabled: provider.enabled,
            priority: provider.priority,
            status: provider.status,
          })),
          persistedSecrets,
        );
        if (!persisted && restoredProviders.some((provider: ConfiguredProvider) => provider.hasApiKey)) {
          setError('Provider keys are available for this session but could not be saved for restart recovery.');
        }
      }
    } else {
      const persisted = writePersistedProviderSettings(
        activeProvider?.adapterType || providers[0]?.adapterType || null,
        providers.map((provider: ConfiguredProvider) => ({
          id: provider.id,
          label: provider.label,
          adapterType: provider.adapterType,
          model: provider.model,
          baseURL: provider.baseURL || '',
          enabled: provider.enabled,
          priority: provider.priority,
          status: provider.status,
        })),
        persistedSecrets,
      );
      if (!persisted && providers.some((provider: ConfiguredProvider) => provider.hasApiKey)) {
        setError('Provider keys are available for this session but could not be saved for restart recovery.');
      }
    }
    if (failedSecretRestores.length > 0) {
      setError(`Could not restore a saved API key for ${failedSecretRestores.join(', ')}. Re-enter the key in provider settings.`);
    }
  }, []);

  const refreshConfiguredProviders = useCallback(() => {
    if (providerHydrationPromiseRef.current) return providerHydrationPromiseRef.current;
    const controller = new AbortController();
    providerHydrationAbortControllerRef.current = controller;
    setProviderRefreshing(true);
    setError('');
    const hydration = retryProviderHydration(
      (signal) => loadConfiguredProviders(signal),
      { signal: controller.signal, delaysMs: runtimeConfig.providerHydration.retryDelaysMs },
    ).catch((err: unknown) => {
      setError(`Could not load providers: ${(err as Error).message}`);
      throw err;
    }).finally(() => {
      if (providerHydrationPromiseRef.current === hydration) {
        providerHydrationPromiseRef.current = null;
        providerHydrationAbortControllerRef.current = null;
        setProviderRefreshing(false);
      }
    });
    providerHydrationPromiseRef.current = hydration;
    return hydration;
  }, [loadConfiguredProviders]);

  useEffect(() => {
    void refreshConfiguredProviders().catch(() => undefined);
  }, [refreshConfiguredProviders, settingsOpen]);

  useEffect(() => () => {
    const controller = providerHydrationAbortControllerRef.current;
    providerHydrationPromiseRef.current = null;
    providerHydrationAbortControllerRef.current = null;
    controller?.abort();
  }, []);

  const saveConfiguredProvider = async () => {
    if (!providerId) {
      setError('Select a provider.');
      return;
    }
    const editingProvider = configuredProviders.find((provider) => provider.id === editingProviderId);
    if (!providerModel.trim() || (!editingProvider && !providerKey.trim())) {
      setError(editingProvider ? 'Model is required.' : 'API key and model are required.');
      return;
    }
    const modelError = providerModelError;
    if (modelError) {
      setError(modelError);
      return;
    }
    setProviderSaving(true);
    setError('');
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(editingProvider ? { providerId: editingProvider.id } : { createNew: true }),
          label: providerLabel || getProviderConfig(providerId)?.displayName || providerId,
          adapterType: providerId,
          apiKey: providerKey,
          model: providerModel,
          baseURL: providerBaseURL,
          enabled: providerEnabled,
          fallbackEnabled,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(providerResponseError(data, 'Could not save provider.'));
      if (providerKey.trim() && data.provider?.hasApiKey !== true) {
        throw new Error('Provider settings were not saved with the API key. The backend did not confirm the credential.');
      }
      const secrets = readPersistedProviderSecrets();
      const savedProviderId = String(data.provider?.id || '');
      if (!savedProviderId) throw new Error('Provider was saved but its instance ID was not returned.');
      if (providerKey.trim()) {
        Object.assign(secrets, setProviderSecret(secrets, savedProviderId, providerId, providerKey));
        delete secrets[providerId];
      }
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const activeProviderType = typeof data.activeProvider === 'string'
        ? providers.find((provider: ConfiguredProvider) => provider.id === data.activeProvider)?.adapterType || null
        : null;
      const persisted = writePersistedProviderSettings(activeProviderType, providers, secrets);
      setConfiguredProviders(providers);
      setActiveProviderId(typeof data.activeProvider === 'string' ? data.activeProvider : null);
      setSpeechProviderId(typeof data.sttProvider === 'string' ? data.sttProvider : '');
      setEffectiveSpeechProviderId(typeof data.effectiveSttProvider === 'string' ? data.effectiveSttProvider : '');
      setFallbackEnabled(typeof data.fallbackEnabled === 'boolean' ? data.fallbackEnabled : fallbackEnabled);
      resetProviderForm();
      setStatusMessage(persisted
        ? 'Provider saved.'
        : 'Provider is available for this session, but its key could not be saved for restart recovery.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(false);
    }
  };

  const editConfiguredProvider = (provider: ConfiguredProvider) => {
    setEditingProviderId(provider.id);
    setProviderId(provider.adapterType as ProviderId);
    setProviderModel(provider.model);
    setProviderModelIsCustom(
      allowsCustomModel(provider.adapterType)
      && !getModelsForProvider(provider.adapterType).some((model) => model.id === provider.model),
    );
    setProviderBaseURL(provider.baseURL || '');
    setProviderLabel(provider.label);
    setProviderEnabled(provider.enabled);
    setProviderKey('');
    setError('');
  };

  const cancelProviderEdit = () => {
    resetProviderForm();
    setError('');
  };

  const setConfiguredActiveProvider = async (provider: ConfiguredProvider) => {
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/active-provider`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: provider.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(providerResponseError(data, 'Could not activate provider.'));
      const providers = Array.isArray(data.providers) ? data.providers : configuredProviders;
      setConfiguredProviders(providers);
      setActiveProviderId(typeof data.activeProvider === 'string' ? data.activeProvider : null);
      const secrets = readPersistedProviderSecrets();
      writePersistedProviderSettings(provider.adapterType, providers, secrets);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const changeFallbackEnabled = async (enabled: boolean) => {
    setProviderSaving(true);
    setError('');
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/fallback`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(providerResponseError(data, 'Could not update provider fallback.'));
      setFallbackEnabled(data.fallbackEnabled === true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(false);
    }
  };

  const selfTestConfiguredProvider = async (provider: ConfiguredProvider) => {
    setSelfTestingProviderId(provider.id);
    setError('');
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/providers/self-test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider_id: provider.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(providerResponseError(data, 'Provider self-test failed.'));
      setConfiguredProviders((current) => current.map((item) => item.id === provider.id
        ? {
          ...item,
          status: String(data.status || item.status || 'UNKNOWN'),
          failureCategory: typeof data.failureCategory === 'string' ? data.failureCategory : undefined,
          failureDetails: data.failureDetails && typeof data.failureDetails === 'object'
            ? data.failureDetails
            : undefined,
          developerToolCallingVerified: data.toolCalling === true,
        }
        : item));
      if (data.status === 'READY') setStatusMessage(`${provider.label} self-test passed.`);
      else setError(data.failureDetails?.reason || data.configurationError?.message || data.error || `Self-test status: ${data.status || 'UNKNOWN'}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSelfTestingProviderId(null);
    }
  };

  const updateConfiguredProviderState = async (provider: ConfiguredProvider, changes: Partial<ConfiguredProvider>) => {
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/providers/${encodeURIComponent(provider.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(providerResponseError(data, 'Could not update provider.'));
      const secrets = readPersistedProviderSecrets();
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const activeProviderId = typeof data.activeProvider === 'string' ? data.activeProvider : null;
      const activeProviderType = providers.find((item: ConfiguredProvider) => item.id === activeProviderId)?.adapterType || null;
      writePersistedProviderSettings(activeProviderType, providers, secrets);
      setConfiguredProviders(providers);
      setActiveProviderId(activeProviderId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deleteConfiguredProvider = (provider: ConfiguredProvider) => {
    const deletingSpeechProvider = provider.id === effectiveSpeechProviderId;
    const suggestedSpeechProvider = configuredProviders.find((candidate) => (
      candidate.id !== provider.id
      && candidate.enabled
      && candidate.hasApiKey
      && candidate.capabilities?.stt
    ));
    const speechWarning = deletingSpeechProvider
      ? suggestedSpeechProvider
        ? ` ${provider.label} is currently used for Meeting transcription. After removal, automatic selection will use ${suggestedSpeechProvider.label}, the next eligible speech provider by priority.`
        : ` ${provider.label} is currently used for Meeting transcription. Meeting transcription will be unavailable until an eligible Groq, OpenAI, or Gemini provider is added.`
      : '';
    requestConfirmation({
      title: 'Remove provider?',
      description: `Remove "${provider.label}" from the runtime provider list?${speechWarning}`,
      confirmLabel: 'Remove provider',
      onConfirm: async () => {
        try {
          const response = await fetch(`${HTTP_URL}/api/settings/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Could not remove provider.');
          const secrets = readPersistedProviderSecrets();
          const updatedSecrets = removeProviderSecret(
            secrets,
            provider.id,
            provider.adapterType,
          );
          const providers = Array.isArray(data.providers) ? data.providers : [];
          const activeProviderId = typeof data.activeProvider === 'string' ? data.activeProvider : null;
          const activeProviderType = providers.find((item: ConfiguredProvider) => item.id === activeProviderId)?.adapterType || null;
          const persisted = writePersistedProviderSettings(activeProviderType, providers, updatedSecrets);
          setConfiguredProviders(providers);
          setActiveProviderId(activeProviderId);
          setSpeechProviderId(typeof data.sttProvider === 'string' ? data.sttProvider : '');
          setEffectiveSpeechProviderId(typeof data.effectiveSttProvider === 'string' ? data.effectiveSttProvider : '');
          if (!persisted) setError('Provider was removed, but its saved credential could not be cleared from browser storage.');
        } catch (err) {
          setError((err as Error).message);
        }
      },
    });
  };

  const changeSpeechProvider = async (selectedProviderId: string) => {
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/stt-provider`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: selectedProviderId || null }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(providerResponseError(data, 'Could not update speech provider.'));
      setSpeechProviderId(typeof data.sttProvider === 'string' ? data.sttProvider : '');
      setEffectiveSpeechProviderId(typeof data.effectiveSttProvider === 'string' ? data.effectiveSttProvider : '');
      setHealth((current) => current ? {
        ...current,
        sttProvider: typeof data.effectiveSttProvider === 'string' ? data.effectiveSttProvider : undefined,
        sttReady: Boolean(data.effectiveSttProvider),
      } : current);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const moveConfiguredProvider = async (provider: ConfiguredProvider, direction: -1 | 1) => {
    const index = configuredProviders.findIndex((item) => item.id === provider.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= configuredProviders.length) return;
    const ids = configuredProviders.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/providers/reorder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not reorder providers.');
      setConfiguredProviders(data.providers || []);
      setActiveProviderId(typeof data.activeProvider === 'string' ? data.activeProvider : activeProviderId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveAgentPermissions = async (nextPermissions = agentPermissions) => {
    const previousPermissions = agentPermissions;
    setAgentPermissions(nextPermissions);
    setAgentSaving(true);
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nextPermissions),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Permission update failed');
    } catch (err) {
      setAgentPermissions(previousPermissions);
      setError((err as Error).message);
    } finally {
      setAgentSaving(false);
    }
  };

  const loadAgentActivity = useCallback(async () => {
    try {
      const response = await fetch(`${HTTP_URL}/api/agent/activity`);
      const data = await response.json();
      if (response.ok) setAgentActivity(Array.isArray(data.activity) ? data.activity : []);
    } catch {
      // The log is optional; action controls remain available if it is offline.
    }
  }, []);

  const openConfiguration = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    void loadAgentActivity();
  }, [loadAgentActivity, settingsOpen]);

  const enableAllAgentPermissions = () => {
    requestConfirmation({
      title: 'Enable all allowed controls?',
      description: 'This enables every allow-listed desktop and browser control. Each external action will still require a separate confirmation.',
      confirmLabel: 'Enable controls',
      variant: 'primary',
      onConfirm: () => saveAgentPermissions(allAgentPermissions),
    });
  };

  const runAgentAction = (target: string) => {
    const label = agentPermissionOptions.find(([, , optionTarget]) => optionTarget === target)?.[1] || target;
    requestConfirmation({
      title: `Open ${label}?`,
      description: 'The desktop agent will open the selected application or URL. No message, call, purchase, or destructive action will be performed.',
      confirmLabel: 'Open',
      variant: 'primary',
      onConfirm: async () => {
        setAgentActionTarget(target);
        try {
          const response = await fetch(`${HTTP_URL}/api/agent/open`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target, url: agentUrl, confirmed: true }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Action blocked');
          await loadAgentActivity();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setAgentActionTarget(null);
        }
      },
    });
  };

  // --- PDF upload ---
  const removePdf = () => {
    requestRemoveResume();
  };

  const copyText = async (text: string, item: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedItem(item);
      window.setTimeout(() => setCopiedItem((current) => current === item ? '' : current), 1500);
    } catch {
      setError('Copy failed. Your browser did not allow clipboard access.');
    }
  };

  const copyConversation = () => {
    const text = messages.map((message) => `${message.role === 'user' ? 'You' : 'Assistant'}:\n${message.content}`).join('\n\n');
    if (text) void copyText(text, 'conversation');
  };

  const startNewChat = useCallback(() => {
    setMessages([]);
    setInput('');
    setError('');
    setActiveChatId(crypto.randomUUID());
    setHistoryOpen(false);
  }, [setInput, setMessages]);

  const openHistorySession = (session: ChatSession) => {
    const restoredMessages = session.messages.map((message) => ({ ...message, streaming: false }));
    if (session.mode === 'meeting') {
      setAppMode('meeting');
      meeting.restoreMeetingHistory(session);
    } else if (session.mode === 'developer') {
      setAppMode('developer');
      setActiveChatId(session.id.replace(/^coding-/, '').split('-turn-')[0] || crypto.randomUUID());
      setCodingRestoreRequest({ key: ++codingRestoreKeyRef.current, session });
    } else {
      setAppMode('assistant');
      setActiveChatId(session.id.split('-turn-')[0] || crypto.randomUUID());
      setMessages(restoredMessages);
    }
    setInput('');
    setError('');
    setHistoryOpen(false);
  };

  const deleteHistorySession = (sessionId: string) => {
    setChatHistory((previous) => removeHistorySession(previous, sessionId));
    if (sessionId === `meeting-${meetingController?.meetingConversationId}`) {
      meetingController?.clearMeetingHistory();
    }
    if (activeChatId === sessionId) {
      setMessages([]);
      setInput('');
      setError('');
      setActiveChatId(crypto.randomUUID());
    }
  };

  const requestDeleteHistorySession = (session: ChatSession) => {
    requestConfirmation({
      title: 'Delete this conversation?',
      description: 'This permanently removes the selected conversation from local history.',
      confirmLabel: 'Delete',
      onConfirm: () => deleteHistorySession(session.id),
    });
  };

  const requestDeleteAllHistory = useCallback(() => {
    if (chatHistory.length === 0) return;
    requestConfirmation({
      title: 'Delete all chat history?',
      description: 'This permanently removes every saved conversation from local history and clears the current chat.',
      confirmLabel: 'Delete all',
      onConfirm: () => {
        meetingController?.clearMeetingHistory();
        setChatHistory([]);
        setMessages([]);
        setInput('');
        setError('');
        setActiveChatId(crypto.randomUUID());
        setHistoryOpen(false);
      },
    });
  }, [chatHistory.length, meetingController, requestConfirmation, setInput, setMessages]);

  const filteredChatHistory = searchHistory(chatHistory, historySearch);
  const activeScreenReading = appMode === 'assistant' ? assistantScreenReading : appMode === 'meeting' ? meetingScreenReading : null;

  const requestClearChat = useCallback(() => {
    if (!messages.length) {
      startNewChat();
      return;
    }
    requestConfirmation({
      title: 'Clear chat?',
      description: 'This removes the current conversation from the visible chat and starts a new chat. Saved history is not deleted.',
      confirmLabel: 'Clear chat',
      onConfirm: startNewChat,
    });
  }, [messages.length, requestConfirmation, startNewChat]);

  const sessionActive = isRecording || isTranscribing || meetingChatBusy || meetingAnsweredSegments.length > 0 || ['question', 'thinking', 'answer'].includes(pipelineStatus);
  const statusPipeline = appMode === 'assistant'
    ? assistantPipelineStatus
    : appMode === 'meeting'
      ? pipelineStatus
      : appMode === 'general'
        ? generalBusy ? 'thinking' : 'ready'
        : codingBusy ? 'thinking' : 'ready';
  const statusLabel = statusPipeline === 'listening' ? 'Listening...' : statusPipeline === 'transcribing' ? 'Transcribing...' : statusPipeline === 'question' ? 'Question detected' : statusPipeline === 'thinking' ? 'Thinking...' : statusPipeline === 'answer' ? 'Answer ready' : statusPipeline === 'stopped' ? 'Stopped' : statusPipeline === 'error' ? 'Unable to connect' : 'Ready';
  const statusTone = statusPipeline === 'error' ? 'text-rose-300' : statusPipeline === 'answer' ? 'text-emerald-300' : 'text-sky-300';
  const pageTitle = appMode === 'assistant' ? 'AI Assistant' : appMode === 'meeting' ? 'Meeting AI Assistant' : appMode === 'developer' ? 'Coding Agent' : 'General Agent';

  const [fontScale, setFontScale] = useState(() => {
    const saved = Number(localStorage.getItem('ui-font-scale'));
    return Number.isFinite(saved) && saved >= 0.9 && saved <= 1.2 ? saved : 1;
  });

  useEffect(() => {
    localStorage.setItem('ui-font-scale', String(fontScale));
  }, [fontScale]);

  return (
    <div className="app-shell min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-slate-100" style={{ '--app-font-scale': fontScale } as CSSProperties}>
      <AppHeader>
          <div className="flex min-w-0 flex-[1_1_12rem] items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400"><Bot className="h-5 w-5 text-slate-950" /></div>
            <div className="min-w-0"><h1 className="break-words text-sm font-semibold">{pageTitle}</h1><p className={`truncate text-[11px] ${statusTone}`}>● {statusLabel}</p></div>
          </div>
          <div className="flex min-w-0 flex-[3_1_34rem] flex-wrap items-center justify-end gap-2">
            <ModeControls
              appMode={appMode}
              assistantMode={mode}
              disabled={false}
              onAppModeChange={setAppMode}
              onAssistantModeChange={setMode}
            />
            <OverlayButton visible={appMode === 'assistant' || appMode === 'meeting'} onClick={() => {
              if (window.electronAPI) {
                void window.electronAPI.toggleOverlay();
              } else {
                setError('Overlay mode is available in the Electron desktop app.');
              }
            }} />
            {(appMode === 'assistant' || appMode === 'meeting') && activeScreenReading && (
              <ScreenReadingToggle
                enabled={activeScreenReading.enabled}
                onClick={() => activeScreenReading.setEnabled(!activeScreenReading.enabled)}
              />
            )}
            {appMode === 'meeting' && sessionActive && <button type="button" onClick={() => setMeetingMenuOpen((open) => !open)} aria-expanded={meetingMenuOpen} className="ui-button border border-slate-700 text-slate-300 hover:border-emerald-400">⚙ Audio</button>}
            <div className={`${appMode === 'assistant' || appMode === 'meeting' ? '' : 'hidden'} relative`}>
              <ContextButton open={contextMenuOpen} onClick={() => (contextMenuOpen ? closeContextMenu() : openContextMenu())} />
              {contextMenuOpen && (
                <ContextPanel ref={contextMenuRef} onClose={closeContextMenu}>
                  {appMode === 'meeting' && (
                    <p className="mb-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] leading-relaxed text-sky-200">
                      Meeting questions use the selected domain, technical background, and uploaded documents. Screen-reading requests stay focused on the visible question.
                    </p>
                  )}
                  {mode === 'direct' && (sessionDocuments.length > 0 || activeProfile || domain || background.length > 0) && (
                    <p className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                      Interview context is attached to the next Direct mode request.
                    </p>
                  )}
                  <input ref={resumeFileInputRef} type="file" accept="application/pdf" onChange={handleResumeUpload} className="hidden" />
                  <input ref={jobDescriptionFileInputRef} type="file" accept="application/pdf" onChange={handleJobDescriptionPdfUpload} className="hidden" />
                  <div className="space-y-3">
                    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium text-slate-200">Resume / document</p>
                        <button type="button" onClick={() => resumeFileInputRef.current?.click()} disabled={pdfLoading} className="rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">
                          {pdfLoading ? 'Reading...' : 'Upload PDF'}
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{pdfName || 'No resume uploaded'}</p>
                        {pdfName && <button type="button" onClick={requestRemoveResume} disabled={pdfLoading} className="shrink-0 text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-40">Remove</button>}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium text-slate-200">Job Description</p>
                        <button type="button" onClick={() => jobDescriptionFileInputRef.current?.click()} disabled={pdfLoading} className="rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">
                          Upload PDF
                        </button>
                      </div>
                      <textarea id="job-description" value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="Paste the job description here..." rows={4} className="w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400" />
                      <div className="mt-2 flex items-center gap-2">
                        <button type="button" onClick={saveJobDescription} disabled={!jobDescription.trim()} className="rounded-md bg-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600 disabled:opacity-40">Add pasted text</button>
                        {sessionDocuments.some((document) => document.name.startsWith('Job Description:')) && <button type="button" onClick={requestRemoveJobDescription} disabled={pdfLoading} className="text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-40">Remove</button>}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                      <label htmlFor="interview-domain" className="block text-xs font-medium text-slate-200">Domain</label>
                      <p className="mb-2 text-[11px] text-slate-500">Primary interview domain</p>
                      <select
                        id="interview-domain"
                        value={domain ?? ''}
                        onChange={(event) => selectDomain(event.target.value)}
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400"
                      >
                        <option value="">No domain selected</option>
                        {INTERVIEW_DOMAIN_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <label htmlFor="technical-background-search" className="block text-xs font-medium text-slate-200">Background</label>
                          <p className="mb-2 text-[11px] text-slate-500">Technologies and topics to focus on</p>
                        </div>
                        {background.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setInterviewConfig((current) => ({ ...current, background: [] }))}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Clear all
                          </button>
                        )}
                      </div>
                      {background.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Selected technical background">
                          {background.map((technology) => (
                            <span key={technology} className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
                              {technology}
                              <button
                                type="button"
                                onClick={() => toggleBackground(technology)}
                                aria-label={`Remove ${technology}`}
                                className="rounded-full text-emerald-300 hover:text-white"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <input
                        id="technical-background-search"
                        value={backgroundSearch}
                        onChange={(event) => {
                          setBackgroundSearch(event.target.value);
                          setBackgroundOptionsOpen(true);
                        }}
                        onFocus={() => setBackgroundOptionsOpen(true)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setBackgroundOptionsOpen(false);
                        }}
                        placeholder="Search technologies..."
                        autoComplete="off"
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400"
                      />
                      {backgroundOptionsOpen && filteredBackgroundOptions.length > 0 && (
                        <div className="mt-1 max-h-36 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 p-1" role="listbox" aria-label="Technical background options">
                          {filteredBackgroundOptions.map((option) => (
                            <button
                              key={option}
                              type="button"
                              role="option"
                              aria-selected="false"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                toggleBackground(option);
                                setBackgroundSearch('');
                                setBackgroundOptionsOpen(true);
                              }}
                              className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-slate-300 hover:bg-slate-800 hover:text-emerald-200"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      )}
                      {backgroundOptionsOpen && backgroundSearch.trim() && filteredBackgroundOptions.length === 0 && (
                        <p className="mt-2 text-[11px] text-slate-500">No matching background option.</p>
                      )}
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                      <label htmlFor="interview-microphone" className="block text-xs font-medium text-slate-200">Audio</label>
                      <p className="mb-2 text-[11px] text-slate-500">Microphone</p>
                      <select
                        id="interview-microphone"
                        value={microphoneDeviceId ?? ''}
                        onChange={(event) => setInterviewConfig((current) => ({
                          ...current,
                          microphoneDeviceId: event.target.value || null,
                        }))}
                        disabled={microphoneUnavailable && microphoneDevices.length === 0}
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {microphoneDevices.length === 0 ? (
                          <option value="">Microphone unavailable</option>
                        ) : (
                          microphoneDevices.map((device) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {microphoneDisplayLabel(device)}
                            </option>
                          ))
                        )}
                      </select>
                      <p className="mt-2 text-[11px] text-slate-500">
                        {microphoneUnavailable ? 'Microphone unavailable. Check permission or connect a device.' : `Selected: ${selectedMicrophoneLabel}`}
                      </p>
                    </div>
                    {sessionDocuments.length > 0 && (
                      <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Session uploads</p>
                        <div className="space-y-1">
                          {sessionDocuments.map((document) => <p key={document.id} className="truncate text-[11px] text-slate-300">✓ {document.name}</p>)}
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <select value={activeProfileId ?? 'none'} onChange={(event) => setActiveProfileId(event.target.value === 'none' ? null : event.target.value)} className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400">
                        <option value="none">None (Normal)</option>
                        {trainedProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                      </select>
                      <button type="button" onClick={trainProfile} disabled={pdfLoading || profileTraining || sessionDocuments.length === 0} className="rounded-md bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40">{profileTraining ? 'Training...' : 'Train'}</button>
                    </div>
                    {activeProfile && (
                      <div className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-2">
                        <span className="truncate text-[11px] text-slate-300">Active: {activeProfile.name}</span>
                        <button type="button" onClick={() => deleteProfile(activeProfile.id)} className="ml-2 shrink-0 text-[11px] text-rose-300 hover:text-rose-200">Delete profile</button>
                      </div>
                    )}
                    {(sessionDocuments.length > 0 || activeProfile) && <button type="button" onClick={requestClearSessionContext} className="text-[11px] text-slate-400 hover:text-slate-200">Clear session upload</button>}
                  </div>
                </ContextPanel>
              )}
            </div>
            <SettingsButton onClick={openConfiguration} />
            <HistoryButton onClick={() => setHistoryOpen(true)} />
            <FontSizeControls value={fontScale} onChange={setFontScale} />
          </div>
      </AppHeader>
      {/* Header */}
      <header className="hidden border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative">
              <button
                onClick={() => setMeetingMenuOpen((open) => !open)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${isRecording ? 'border-rose-400/50 bg-rose-500/10 text-rose-300' : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500'}`}
                title="Meeting tools"
              >
                <Video className="h-4 w-4" />
                <span className="hidden sm:inline">Meetings</span>
                {isRecording && <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" />}
              </button>
              {meetingMenuOpen && (
                <div className="absolute left-0 top-11 z-20 max-h-[calc(100vh-5rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">Meeting capture</p>
                      <p className="text-xs text-slate-500">Listen and save searchable notes</p>
                    </div>
                    <span className={`text-xs ${pipelineStatus === 'listening' ? 'text-rose-300' : pipelineStatus === 'transcribing' ? 'text-amber-300' : pipelineStatus === 'thinking' ? 'text-blue-300' : pipelineStatus === 'answer' ? 'text-emerald-300' : 'text-slate-500'}`}>● {pipelineStatus === 'listening' ? 'Listening...' : pipelineStatus === 'transcribing' ? 'Transcribing...' : pipelineStatus === 'question' ? 'Question detected' : pipelineStatus === 'thinking' ? 'Thinking...' : pipelineStatus === 'answer' ? 'Answer ready' : 'Ready'}</span>
                  </div>
                  {transcripts.length > 0 && (
                    <div className="mb-3 border-b border-slate-800 pb-3">
                      <div className="mb-2 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5"><Search className="h-3.5 w-3.5 text-slate-500" /><input value={transcriptSearch} onChange={(event) => setTranscriptSearch(event.target.value)} placeholder="Search saved transcripts" className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-500" /></div>
                      <div className="max-h-20 space-y-1 overflow-y-auto">
                        {filteredTranscripts.map((item) => <button key={item.id} onClick={() => setInput(`Summarize the ${item.source} meeting and list the action items.`)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800"><span className="text-emerald-300">{item.source}</span> {item.text}</button>)}
                      </div>
                    </div>
                  )}
                  <div className="mb-3 flex gap-2">
                    {!isRecording && !isTranscribing ? (
                      <>
                        <button type="button" onClick={() => void testMeetingAudio()} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-emerald-500/40 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10"><MonitorUp className="h-3.5 w-3.5" /> {meetingAudioMode === 'microphone' ? 'Test Microphone' : meetingAudioMode === 'system' ? 'Test System Audio' : 'Test Both Sources'}</button>
                        <button type="button" onClick={() => void startMeetingCapture()} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-400"><MonitorUp className="h-3.5 w-3.5" /> Start Listening</button>
                      </>
                    ) : (
                      <button type="button" onClick={stopMeetingCapture} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-xs font-medium text-white hover:bg-slate-600"><Square className="h-3 w-3" /> Stop Listening</button>
                    )}
                    {liveTranscript && <button onClick={saveMeetingTranscript} className="rounded-lg border border-emerald-500/40 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-500/10">Save</button>}
                  </div>
                  <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Audio source</label>
                    <select value={meetingAudioMode} onChange={(event) => setMeetingAudioMode(event.target.value as MeetingAudioMode)} aria-label="Audio source" className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-200">
                      <option value="microphone">Microphone (spoken questions)</option>
                      <option value="system">System / Internal Audio (meeting sound)</option>
                      <option value="meeting">Microphone + System / Internal Audio</option>
                    </select>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Status</span>
                      <span className={audioStatus === 'disabled' ? 'text-slate-500' : 'text-emerald-300'}>● {audioStatus === 'testing' ? 'Testing system audio' : audioStatus === 'connected' ? 'Audio Connected' : 'Audio Disabled'}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Input device</span>
                      <span className="max-w-[11rem] truncate text-right text-slate-200">{displayedAudioSourceLabel}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Microphone</span>
                      <span className={`font-semibold ${microphoneStatus === 'connected' ? 'text-emerald-300' : 'text-slate-500'}`}>{microphoneStatus === 'connected' ? 'ON' : 'OFF'}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">System audio</span>
                      <span className={`font-semibold ${systemAudioStatus === 'connected' || systemAudioStatus === 'testing' ? 'text-emerald-300' : 'text-slate-500'}`}>
                        {systemAudioStatus === 'testing' ? 'TESTING' : systemAudioStatus === 'connected' ? 'ON' : 'OFF'}
                      </span>
                    </div>
                    <div>
                      <div className="mb-1 flex justify-between text-[10px] text-slate-500"><span>System audio level</span><span>{audioLevel}%</span></div>
                      <div className="flex h-2 gap-0.5" aria-label={`System audio level ${audioLevel}%`}>
                        {Array.from({ length: 10 }, (_, index) => <span key={index} className={`flex-1 rounded-sm ${audioLevel >= (index + 1) * 10 ? 'bg-emerald-400' : 'bg-slate-700'}`} />)}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Microphone is captured with permission for spoken questions. System audio is optional; choose a playback source in the operating-system capture dialog when available.</p>
                  {liveTranscript && <p className="mt-2 max-h-16 overflow-y-auto rounded-lg bg-slate-950/60 p-2 text-[11px] leading-relaxed text-slate-300">{liveTranscript}</p>}
                </div>
              )}
            </div>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Bot className="w-6 h-6 text-slate-900" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">AI Assistant</h1>
              {health && (
                <p className="text-xs text-slate-400">
                  {health.provider} · {health.model}
                </p>
              )}
            </div>
          </div>

          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {/* Connection indicator */}
            <div className="flex items-center gap-1.5 text-xs">
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-500'} animate-pulse`} />
              <span className={connected ? 'text-emerald-400' : 'text-slate-400'}>
                {connected ? 'Connected' : 'Offline'}
              </span>
            </div>

            {/* Mode toggle */}
            <div className="flex items-center bg-slate-800 rounded-lg p-0.5 border border-slate-700">
              <button
                onClick={() => setMode('direct')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${
                  mode === 'direct'
                    ? 'bg-emerald-500 text-slate-900'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                Direct
              </button>
              <button
                onClick={() => setMode('langchain')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${
                  mode === 'langchain'
                    ? 'bg-teal-500 text-slate-900'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <LinkIcon className="w-3.5 h-3.5" />
                LangChain
              </button>
            </div>
            <button
              type="button"
              onClick={openConfiguration}
              aria-label="Configuration"
              className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
              title="Configuration"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              onClick={() => setHistoryOpen(true)}
              className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
              title="Chat history"
            >
              <History className="h-4 w-4" />
            </button>
            <button
              onClick={() => setVoiceReplies((enabled) => !enabled)}
              className={`rounded-lg border p-2 ${voiceReplies ? 'border-emerald-400 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-800 text-slate-400'} hover:text-emerald-300`}
              title={voiceReplies ? 'Voice replies on' : 'Voice replies off'}
            >
              {voiceReplies ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      {statusMessage && appMode === 'assistant' && (
        <div className="mx-auto mt-3 w-full max-w-4xl rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200">
          {statusMessage}
        </div>
      )}

      <ContextInputDialog
        open={profileDialogOpen}
        title="Name this trained profile"
        description="Give this selected session context a reusable name. Cancel keeps the existing context unchanged."
        label="Profile name"
        initialValue={profileNameDraft}
        confirmLabel="Train profile"
        onCancel={() => {
          if (profileTraining) return;
          setProfileDialogOpen(false);
          setProfileNameDraft('');
        }}
        onConfirm={completeProfileTraining}
      />

      <ConfirmationDialog
        open={Boolean(confirmation)}
        title={confirmation?.title || ''}
        description={confirmation?.description || ''}
        confirmLabel={confirmation?.confirmLabel}
        variant={confirmation?.variant}
        onCancel={closeConfirmation}
        onConfirm={async () => {
          await confirmation?.onConfirm();
          setConfirmation(null);
        }}
      />

      {historyOpen && <ChatHistoryModal sessions={chatHistory} filteredSessions={filteredChatHistory} search={historySearch} copiedItem={copiedItem} hasCurrentMessages={messages.length > 0} historyRetention={historyRetention} onRetentionChange={changeHistoryRetention} onSearchChange={setHistorySearch} onClose={() => setHistoryOpen(false)} onNewChat={requestClearChat} onCopyChat={copyConversation} onDeleteAll={requestDeleteAllHistory} onOpenSession={openHistorySession} onDeleteSession={requestDeleteHistorySession} />}

      {settingsOpen && (
        <div
          className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-3 py-4 backdrop-blur-sm sm:px-4 sm:py-8"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !providerSaving && !agentSaving) setSettingsOpen(false);
          }}
        >
          <div
            className="my-auto max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-2xl sm:p-5 lg:p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="configuration-title"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between">
              <div>
                <h2 id="configuration-title" className="text-lg font-semibold">Configuration</h2>
                <p className="mt-1 text-xs text-slate-400">Choose a provider and connect its API key at runtime.</p>
              </div>
              <button type="button" onClick={() => { if (!providerSaving && !agentSaving) setSettingsOpen(false); }} disabled={providerSaving || agentSaving} aria-label="Close configuration" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"><X className="h-4 w-4" /></button>
            </div>
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-slate-700 bg-slate-800 p-1">
              <button type="button" onClick={() => setSettingsTab('providers')} className={`rounded-md px-3 py-2 text-xs font-medium ${settingsTab === 'providers' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>AI Providers</button>
              <button type="button" onClick={() => setSettingsTab('permissions')} className={`rounded-md px-3 py-2 text-xs font-medium ${settingsTab === 'permissions' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Permissions</button>
            </div>
            {settingsTab === 'providers' && (
              <>
            <ConfiguredProvidersPanel
              providers={configuredProviders}
              activeProviderId={activeProviderId}
              speechProviderId={speechProviderId}
              onSpeechProviderChange={(value) => void changeSpeechProvider(value)}
              selfTestingProviderId={selfTestingProviderId}
              providerRefreshing={providerRefreshing}
              onRefresh={() => void refreshConfiguredProviders()}
              onMove={(provider, direction) => void moveConfiguredProvider(provider, direction)}
              onToggle={(provider) => void updateConfiguredProviderState(provider, { enabled: !provider.enabled })}
              onRemove={(provider) => void deleteConfiguredProvider(provider)}
              onEdit={editConfiguredProvider}
              onSetActive={(provider) => void setConfiguredActiveProvider(provider)}
              onSelfTest={(provider) => void selfTestConfiguredProvider(provider)}
            />
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-xs font-medium text-slate-300">{editingProvider ? `Edit ${editingProvider.label}` : 'Add provider instance'}</label>
              {editingProvider && <button type="button" onClick={cancelProviderEdit} disabled={providerSaving} className="text-[11px] text-slate-400 hover:text-white">Cancel edit</button>}
            </div>
            <label className="mb-2 block text-[11px] font-medium text-slate-400">Provider</label>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {getProviderIds().map((id) => (
                <button type="button" key={id} disabled={Boolean(editingProvider) || providerSaving} onClick={() => chooseProvider(id as ProviderId)} className={`rounded-lg border px-2 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${providerId === id ? 'border-emerald-400 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500'}`}>
                  {getProviderConfig(id)?.displayName || id}
                </button>
              ))}
            </div>
            <label className="mb-2 block text-xs font-medium text-slate-300">Instance label</label>
            <input value={providerLabel} onChange={(event) => setProviderLabel(event.target.value)} placeholder="Label (for example: Backup provider)" disabled={providerSaving} className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50" />
            <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={providerEnabled} onChange={(event) => setProviderEnabled(event.target.checked)} disabled={providerSaving} className="h-4 w-4 accent-emerald-500" /> Enabled for requests</label>
            <label className="mb-2 block text-xs font-medium text-slate-300">API key</label>
            <input type="password" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder={editingProvider ? 'Leave blank to keep the current key' : 'Paste API key'} autoComplete="new-password" disabled={providerSaving} className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50" />
            <label className="mb-2 block text-xs font-medium text-slate-300">Model</label>
            <select
              value={providerModelIsCustom ? CUSTOM_PROVIDER_MODEL : providerModel}
              onChange={(event) => {
                const selectedModel = event.target.value;
                setProviderModelIsCustom(selectedModel === CUSTOM_PROVIDER_MODEL);
                setProviderModel(selectedModel === CUSTOM_PROVIDER_MODEL ? '' : selectedModel);
              }}
              disabled={!providerId || providerSaving}
              className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50"
            >
              <option value="" disabled>{providerId ? 'Select a model' : 'Select a provider first'}</option>
              {providerModelChoices.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
              {isCustomProvider && <option value={CUSTOM_PROVIDER_MODEL}>Custom model ID…</option>}
            </select>
            {providerModelIsCustom && (
              <input value={providerModel} onChange={(event) => setProviderModel(event.target.value)} placeholder="Enter a model ID for this provider" disabled={providerSaving} className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50" />
            )}
            {providerModelError && <p role="alert" className="mb-4 text-xs text-rose-300">{providerModelError}</p>}
            {providerId && isProviderEndpointConfigurable(providerId) && <>
              <label className="mb-2 block text-xs font-medium text-slate-300">Base URL {isProviderEndpointRequired(providerId) ? '(required)' : '(optional override)'}</label>
              <input value={providerBaseURL} onChange={(event) => setProviderBaseURL(event.target.value)} placeholder="https://api.example.com/v1" disabled={providerSaving} className="mb-5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50" />
            </>}
            <label className="mb-5 flex cursor-pointer items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5">
              <span><span className="block text-xs font-medium text-slate-200">Auto fallback</span><span className="block text-[11px] text-slate-500">Try another connected AI if quota or rate limit is reached</span></span>
              <input type="checkbox" checked={fallbackEnabled} onChange={(event) => void changeFallbackEnabled(event.target.checked)} disabled={providerSaving} className="h-4 w-4 accent-emerald-500 disabled:opacity-50" />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-500">The backend keeps keys in memory only. This desktop client stores a local recovery copy so it can rehydrate the key after a backend restart.</p>
              {!editingProvider && (providerId || providerKey || providerModel || providerLabel) ? (
                <button type="button" onClick={cancelProviderEdit} disabled={providerSaving} className="shrink-0 rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">Cancel</button>
              ) : null}
              <button type="button" onClick={() => void saveConfiguredProvider()} disabled={!canSaveProvider} className="flex shrink-0 items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">{providerSaving && <Loader2 className="h-4 w-4 animate-spin" />}{providerSaving ? 'Saving...' : editingProvider ? 'Save changes' : 'Add provider'}</button>
            </div>
              </>
            )}
            {settingsTab === 'permissions' && (
              <div>
                <p className="text-sm font-medium text-slate-200">Desktop permissions</p>
                <p className="mb-3 mt-1 text-[11px] text-slate-500">Only allow-listed apps and valid browser URLs can open. Every action requires a local confirmation; delete, password, arbitrary-command, shutdown, and system-change actions are blocked.</p>
                <button type="button" onClick={enableAllAgentPermissions} disabled={agentSaving} className="mb-3 w-full rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">{agentSaving ? 'Saving controls...' : 'Enable all allowed controls'}</button>
                <div className="space-y-2">
                  {agentPermissionOptions.map(([permission, label, target]) => (
                    <div key={permission} className="flex items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
                      <span className="text-xs text-slate-200">{label}</span>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => runAgentAction(target)} disabled={!agentPermissions[permission as keyof typeof agentPermissions] || agentActionTarget === target || agentSaving} className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-35">{agentActionTarget === target ? 'Opening...' : 'Open'}</button>
                        <input type="checkbox" checked={agentPermissions[permission as keyof typeof agentPermissions]} onChange={(event) => void saveAgentPermissions({ ...agentPermissions, [permission]: event.target.checked })} disabled={agentSaving} className="h-4 w-4 accent-emerald-500" />
                      </div>
                    </div>
                  ))}
                </div>
                <input value={agentUrl} onChange={(event) => setAgentUrl(event.target.value)} placeholder="https://example.com" className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-400" />
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">For Teams calls or messages, the agent can prepare a draft and open Teams, but it will not call or send without your confirmation.</p>
                <div className="mt-4 border-t border-slate-800 pt-3">
                  <div className="mb-2 flex items-center justify-between"><p className="text-xs font-medium text-slate-300">Recent agent activity</p><button type="button" onClick={() => void loadAgentActivity()} className="text-[11px] text-emerald-300 hover:text-emerald-200">Refresh</button></div>
                  {agentActivity.length === 0 ? <p className="text-[11px] text-slate-500">No actions requested in this server session.</p> : <div className="max-h-28 space-y-1 overflow-y-auto">{agentActivity.slice(0, 10).map((item) => <p key={item.id} className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400">{item.target} · {item.action} · {new Date(item.createdAt).toLocaleTimeString()}</p>)}</div>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <main className={`${appMode === 'assistant' ? 'hidden' : 'mx-auto flex min-h-[calc(100dvh-57px)] w-full max-w-3xl flex-col px-4 py-6'}`}>
        <GeneralAgentPage
          active={appMode === 'general'}
          providers={configuredProviders}
          onProviderStorageError={setError}
          onBusyChange={setGeneralBusy}
          onHistoryEntry={addGeneralHistoryEntry}
        />
        <CodingAgentPage
          active={appMode === 'developer'}
          defaultProvider={health ? { id: health.provider, label: health.provider, model: health.model } : null}
          providers={configuredProviders}
          onProviderStorageError={setError}
          restoreRequest={codingRestoreRequest}
          onBusyChange={setCodingBusy}
        />
        <MeetingAssistantPage
          active={appMode === 'meeting'}
          providers={configuredProviders}
          onProviderStorageError={setError}
          interviewConfig={interviewConfig}
          setInterviewConfig={setInterviewConfig}
          refreshConfiguredProviders={refreshConfiguredProviders}
          shouldAcceptQuestion={rememberAcceptedQuestion}
          requestContext={meetingRequestContext}
          onControllerChange={setMeetingController}
          onScreenReadingChange={setMeetingScreenReading}
          onHistoryEntry={addMeetingHistoryEntry}
          onClearHistory={clearMeetingHistory}
          onHistoryRetentionChange={changeHistoryRetention}
        />
      </main>

      {/* Main content */}
      {appMode === 'assistant' && <div className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-4">
        {/* PDF upload bar */}
        <div className="mb-4 space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handlePdfUpload}
            multiple
            className="hidden"
          />

          <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Context mode</p>
              <p className="text-sm font-medium text-slate-200">{mode === 'direct' ? 'Direct mode: selected session context is included when relevant' : 'LangChain mode: profile and session docs are included'}</p>
            </div>
            {mode === 'direct' && (sessionDocuments.length > 0 || !!activeProfile || !!domain || background.length > 0) && (
              <div className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-200">
                Context ready
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Trained profile</p>
              <div className="flex items-center gap-2">
                {activeProfile && (
                  <button
                    onClick={() => setProfilePreviewOpen((current) => !current)}
                    className="text-[11px] text-emerald-300 hover:text-emerald-200"
                  >
                    {profilePreviewOpen ? 'Hide preview' : 'Preview'}
                  </button>
                )}
                {activeProfile && (
                  <button
                    onClick={() => deleteProfile(activeProfile.id)}
                    className="text-[11px] text-rose-300 hover:text-rose-200"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={activeProfileId ?? 'none'}
                onChange={(event) => setActiveProfileId(event.target.value === 'none' ? null : event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-400"
              >
                <option value="none">No profile selected</option>
                {trainedProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
              <button
                onClick={trainProfile}
                disabled={pdfLoading || sessionDocuments.length === 0}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                Train
              </button>
            </div>
            {activeProfile && profilePreviewOpen && (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-[11px] leading-relaxed text-slate-300">
                <p className="mb-1 font-medium text-emerald-300">{activeProfile.name}</p>
                <p>{activeProfile.summary}</p>
              </div>
            )}
          </div>

          {pdfName ? (
            <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/20">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-200">{pdfName}</p>
                <p className="text-xs text-slate-400">
                  {pdfText.length.toLocaleString()} characters extracted — included in LangChain context
                </p>
              </div>
              <button
                onClick={removePdf}
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={pdfLoading}
              className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-dashed border-slate-600 bg-slate-800/40 px-4 py-3 text-sm text-slate-400 transition-all hover:border-emerald-500/50 hover:bg-slate-800/70 hover:text-slate-200 disabled:opacity-50"
            >
              {pdfLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Extracting text from PDF...
                </>
              ) : (
                <>
                  <FileText className="h-4 w-4" />
                  Upload PDF for context (optional)
                </>
              )}
            </button>
          )}

          {sessionDocuments.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {sessionDocuments.map((doc) => (
                <span key={doc.id} className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300">
                  {doc.name}
                </span>
              ))}
            </div>
          )}
          {sessionDocuments.length > 0 && (
            <button
              onClick={requestClearSessionContext}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Clear session documents
            </button>
          )}
        </div>

      </div>}
      <AssistantAgentPage
        active={appMode === 'assistant'}
        providers={configuredProviders}
        mode={mode}
        voiceReplies={voiceReplies}
        setError={setError}
        setStatus={setStatusMessage}
        requestContext={assistantRequestContext}
        onControllerChange={setAssistantController}
        onScreenReadingChange={setAssistantScreenReading}
        activeChatId={activeChatId}
        onHistoryEntries={addAssistantHistoryEntries}
        workspace={{
          error,
          copiedItem,
          scrollRef,
          onSend: () => void sendMessage(),
          onClearChat: requestClearChat,
          onCopyMessage: copyText,
          onSuggestion: setInput,
        }}
      />
    </div>
  );
}

export default App;