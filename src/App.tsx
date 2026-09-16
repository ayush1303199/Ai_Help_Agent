import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Copy,
  FileText,
  History,
  Link as LinkIcon,
  Loader2,
  MonitorUp,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  User,
  Video,
  Volume2,
  VolumeX,
  X,
  Zap
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanTranscript, detectQuestion, voiceSafeText } from './audio/transcriptUtils';
import { resolveContext, truncateContextText } from './context/contextResolver';
import { renderAnswerMarkdown } from './ui/answerMarkdown';
import { AnswerSessionView } from './ui/AnswerSessionView';
import { ConfiguredProvidersPanel } from './ui/ConfiguredProvidersPanel';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  requestId?: string;
}
interface RequestTiming {
  questionFinalizedAt: number;
  sendMessageCalledAt: number;
}

type Mode = 'direct' | 'langchain';
type AppMode = 'assistant' | 'developer' | 'general';

interface MeetingTranscript {
  id: string;
  source: string;
  text: string;
  createdAt: string;
}

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
}

interface SessionDocument {
  id: string;
  name: string;
  text: string;
  uploadedAt: number;
}

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
}

interface DeveloperSearchResult {
  path: string;
  line: number;
  text: string;
  matchType: 'filename' | 'content';
}

interface DeveloperDiffFile {
  path: string;
  lines: string[];
}

interface DeveloperSnapshot {
  path: string;
  hash: string;
}

async function hashDeveloperContent(content: string) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseUnifiedDiff(content: string): DeveloperDiffFile[] {
  const lines = content
    .replace(/^```(?:diff|patch)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/);
  const files: DeveloperDiffFile[] = [];
  let current: DeveloperDiffFile | null = null;

  for (const line of lines) {
    const fileHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) {
      const normalizedPath = fileHeader[1].replace(/\\/g, '/');
      if (!normalizedPath || normalizedPath.startsWith('/') || normalizedPath.split('/').includes('..')) {
        continue;
      }
      current = { path: normalizedPath, lines: [] };
      files.push(current);
      continue;
    }
    if (current && (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      current.lines.push(line);
    }
  }
  return files;
}

function validateUnifiedFile(lines: string[], original: string) {
  const source = original.split(/\r?\n/);
  let sourceIndex = 0;
  const hunkIndexes = lines.flatMap((line, index) => line.startsWith('@@') ? [index] : []);
  for (const hunkIndex of hunkIndexes) {
    const hunk = lines[hunkIndex];
    const match = hunk.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!match) return false;
    const oldCount = match[0].match(/^@@ -\d+(?:,(\d+))?/);
    const start = Number(match[1]) - 1;
    if (start < sourceIndex || start > source.length) return false;
    sourceIndex = start;
    let consumed = 0;
    for (const line of lines.slice(hunkIndex + 1)) {
      if (line.startsWith('@@')) break;
      if (line.startsWith(' ')) {
        if (source[sourceIndex] !== line.slice(1)) return false;
        sourceIndex += 1;
        consumed += 1;
      } else if (line.startsWith('-')) {
        if (source[sourceIndex] !== line.slice(1)) return false;
        sourceIndex += 1;
        consumed += 1;
      } else if (line.startsWith('+') || line === '\\ No newline at end of file') {
        continue;
      }
    }
    if (oldCount && Number(oldCount[1] || 1) !== consumed) return false;
  }
  return hunkIndexes.length > 0;
}

const HTTP_URL = 'http://localhost:3001';
const WS_URL = 'ws://localhost:3002';
const MAX_CHAT_HISTORY_MESSAGES = 8;
const MAX_CHAT_MESSAGE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 9000;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const PDF_CONTEXT_BUDGET_RATIO = 0.65;
const PDF_CONTEXT_CHAR_BUDGET = Math.floor(MAX_CONTEXT_CHARS * PDF_CONTEXT_BUDGET_RATIO);
// The active capture path is system audio only; microphone access is never
// requested. Transcription begins only after the user stops listening.
const PDF_UPLOAD_TIMEOUT_MS = 20000;
const SYSTEM_AUDIO_SILENCE_MS = 1000;
const SYSTEM_AUDIO_LEVEL_THRESHOLD = 2;
const AI_SYSTEM_PROMPT = `You are a helpful AI voice assistant.

Your primary job is to accurately process the user's speech and respond only to what the user actually says.

Voice-to-text rules:
- Preserve the user's original meaning. Never invent words, requests, questions, or intentions.
- Ignore background noise, random sounds, and incomplete audio when they contain no meaningful speech.
- If the speech is unclear, ask the user to repeat it instead of guessing.
- Wait until the user has finished speaking before responding.
- Do not add unrelated phrases such as "Thank you", "Enjoy your meal", "Have a nice day", or "You're welcome" unless the user's actual words require that response.
- Do not repeat the same response unnecessarily.

Conversation behavior:
- "Introduce yourself" -> "Hi, I'm your AI voice assistant. I can help you with questions, information, coding, and everyday tasks. How can I help you today?"
- "Hello" -> "Hi! How can I help you?"
- "Thank you" -> "You're welcome!"
- Unclear speech -> "Sorry, I didn't catch that. Could you please repeat?"

First determine the user's intent, then provide the shortest useful response. Do not treat every voice input as a request for a long answer. Always prioritize the user's actual spoken words over assumptions.

For coding and other typed requests, remain accurate and concise. Use only the project context, code, documents, and conversation supplied by the user. Do not claim to access files, repositories, services, credentials, or test results that were not provided.`;

function compactMessageContent(content: string) {
  if (content.length <= MAX_CHAT_MESSAGE_CHARS) return content;
  return `${content.slice(0, MAX_CHAT_MESSAGE_CHARS)}\n[Earlier content omitted for speed]`;
}

function chatTitle(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim() || 'New conversation';
  return firstUserMessage.length > 52 ? `${firstUserMessage.slice(0, 52)}…` : firstUserMessage;
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

const providerPresets = {
  groq: { label: 'Groq', model: 'openai/gpt-oss-20b', baseURL: 'https://api.groq.com/openai/v1' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
  anthropic: { label: 'Claude (Anthropic)', model: 'claude-3-5-haiku-latest', baseURL: 'https://api.anthropic.com/v1' },
  deepseek: { label: 'DeepSeek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' },
  openrouter: { label: 'OpenRouter', model: 'openai/gpt-4o-mini', baseURL: 'https://openrouter.ai/api/v1' },
  llama: { label: 'Llama / Together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', baseURL: 'https://api.together.xyz/v1' },
  mistral: { label: 'Mistral', model: 'mistral-small-latest', baseURL: 'https://api.mistral.ai/v1' },
  gemini: { label: 'Gemini', model: 'gemini-3.6-flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  xai: { label: 'xAI Grok', model: 'grok-3-mini', baseURL: 'https://api.x.ai/v1' },
  perplexity: { label: 'Perplexity', model: 'sonar', baseURL: 'https://api.perplexity.ai' },
  fireworks: { label: 'Fireworks', model: 'accounts/fireworks/models/llama-v3p1-8b-instruct', baseURL: 'https://api.fireworks.ai/inference/v1' },
  cerebras: { label: 'Cerebras', model: 'llama-3.3-70b', baseURL: 'https://api.cerebras.ai/v1' },
  cohere: { label: 'Cohere', model: 'command-r7b-12-2024', baseURL: 'https://api.cohere.com/compatibility/v1' },
  custom: { label: 'Custom OpenAI-compatible', model: '', baseURL: '' },
} as const;
const PERSISTED_PROVIDER_STORAGE_KEY = 'ai-help-agent-provider-settings-v1';
const PERSISTED_PROVIDER_SECRET_KEY = 'ai-help-agent-provider-secrets-v1';

function readPersistedProviderSettings() {
  try {
    const raw = localStorage.getItem(PERSISTED_PROVIDER_STORAGE_KEY);
    if (!raw) return { activeProvider: null as string | null, providers: [] as Array<Record<string, string | boolean | number>> };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { activeProvider: null, providers: [] };
    const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
    return { activeProvider: typeof parsed.activeProvider === 'string' ? parsed.activeProvider : null, providers };
  } catch {
    return { activeProvider: null, providers: [] as Array<Record<string, string | boolean | number>> };
  }
}

function readPersistedProviderSecrets() {
  try {
    const raw = localStorage.getItem(PERSISTED_PROVIDER_SECRET_KEY);
    if (!raw) return {} as Record<string, string>;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {} as Record<string, string>;
  }
}

function writePersistedProviderSettings(activeProvider: string | null, providers: Array<{ label: string; adapterType: string; model: string; baseURL?: string; enabled: boolean; priority: number; status?: string; }>, secrets: Record<string, string>) {
  try {
    localStorage.setItem(PERSISTED_PROVIDER_STORAGE_KEY, JSON.stringify({ activeProvider, providers }));
    localStorage.setItem(PERSISTED_PROVIDER_SECRET_KEY, JSON.stringify(secrets));
  } catch {
    // Ignore storage issues. Provider configuration still remains in the app's
    // live server state when the browser can write local storage again.
  }
}
type ProviderId = keyof typeof providerPresets;

const defaultAgentPermissions = { openTeams: false, openBrowser: false, openCamera: false, openChrome: false, openVSCode: false, openDesktop: false, openSourceTree: false, openSqlServer: false, openNotepad: false, openSublime: false };
const allAgentPermissions = { openTeams: true, openBrowser: true, openCamera: true, openChrome: true, openVSCode: true, openDesktop: true, openSourceTree: true, openSqlServer: true, openNotepad: true, openSublime: true };
const agentPermissionOptions = [
  ['openCamera', 'Camera', 'camera'], ['openChrome', 'Chrome', 'chrome'], ['openVSCode', 'VS Code', 'vscode'], ['openDesktop', 'Desktop / File Explorer', 'desktop'], ['openSourceTree', 'SourceTree', 'sourcetree'], ['openSqlServer', 'SQL Server Management Studio', 'sqlserver'], ['openNotepad', 'Notepad', 'notepad'], ['openSublime', 'Sublime Text', 'sublime'], ['openTeams', 'Microsoft Teams', 'teams'], ['openBrowser', 'Browser URL', 'browser'],
] as const;

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatSession[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('chat-history') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [activeChatId, setActiveChatId] = useState<string>(() => crypto.randomUUID());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedItem, setCopiedItem] = useState('');
  const [chatStreaming, setChatStreaming] = useState(false);
  const [developerMessages, setDeveloperMessages] = useState<Message[]>([]);
  const [developerInput, setDeveloperInput] = useState('');
  const [developerStreaming, setDeveloperStreaming] = useState(false);
  const [developerProjectRoot, setDeveloperProjectRoot] = useState<string | null>(null);
  const [developerDirectory, setDeveloperDirectory] = useState<Array<{ name: string; type: 'file' | 'directory' }>>([]);
  const [developerPath, setDeveloperPath] = useState('.');
  const [developerFileContent, setDeveloperFileContent] = useState('');
  const [developerFilePath, setDeveloperFilePath] = useState('');
  const [developerSearchQuery, setDeveloperSearchQuery] = useState('');
  const [developerSearchResults, setDeveloperSearchResults] = useState<DeveloperSearchResult[]>([]);
  const [developerProposalSearchQuery, setDeveloperProposalSearchQuery] = useState('');
  const [developerChangeRequest, setDeveloperChangeRequest] = useState('');
  const [developerProposal, setDeveloperProposal] = useState<{
    id?: string;
    state?: string;
    lifecycleState?: string;
    files: DeveloperDiffFile[];
    raw: string;
    searchedFiles: string[];
    snapshots: DeveloperSnapshot[];
    verification?: { status?: string; classification?: string; reason?: string; attempts?: Array<{ check?: string; ok?: boolean; classification?: string; extracted?: { file?: string | null; line?: number | null; message?: string } }> } | null;
    outcome?: string | null;
    error?: string | null;
    runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null;
  } | null>(null);
  const [developerBusy, setDeveloperBusy] = useState(false);
  const [generalGoal, setGeneralGoal] = useState('');
  const [generalClarification, setGeneralClarification] = useState('');
  const [generalFollowUp, setGeneralFollowUp] = useState('');
  const [generalTask, setGeneralTask] = useState<GeneralTaskState | null>(null);
  const [generalBusy, setGeneralBusy] = useState(false);
  const [generalBrowserUrl, setGeneralBrowserUrl] = useState('');
  const [generalExecutionAction, setGeneralExecutionAction] = useState<GeneralExecutionAction | null>(null);
  const [generalConfirmation, setGeneralConfirmation] = useState<Record<string, unknown> | null>(null);
  const [generalVerificationEvidence, setGeneralVerificationEvidence] = useState('');
  const [appMode, setAppMode] = useState<AppMode>('assistant');
  const [draftImproving, setDraftImproving] = useState(false);
  const [mode, setMode] = useState<Mode>('direct');
  const [pdfText, setPdfText] = useState('');
  const [pdfName, setPdfName] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [health, setHealth] = useState<{ provider: string; model: string } | null>(null);
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
  const [meetingSource] = useState('System Audio');
  const [meetingMenuOpen, setMeetingMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [jobDescription, setJobDescription] = useState('');
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [audioSourceLabel, setAudioSourceLabel] = useState('Not connected');
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioStatus, setAudioStatus] = useState<'disabled' | 'connected' | 'testing'>('disabled');
  const [pipelineStatus, setPipelineStatus] = useState<'ready' | 'listening' | 'transcribing' | 'question' | 'thinking' | 'answer' | 'error' | 'stopped'>('ready');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [transcripts, setTranscripts] = useState<MeetingTranscript[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('meeting-transcripts') || '[]');
    } catch {
      return [];
    }
  });
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'providers' | 'permissions'>('providers');
  const [providerId, setProviderId] = useState<ProviderId>('groq');
  const [providerKey, setProviderKey] = useState('');
  const [providerModel, setProviderModel] = useState<string>(providerPresets.groq.model);
  const [providerBaseURL, setProviderBaseURL] = useState<string>(providerPresets.groq.baseURL);
  const [providerSaving, setProviderSaving] = useState(false);
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([]);
  const [providerLabel, setProviderLabel] = useState('');
  const [providerEnabled, setProviderEnabled] = useState(true);
  const [fallbackEnabled, setFallbackEnabled] = useState(true);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [agentPermissions, setAgentPermissions] = useState(defaultAgentPermissions);
  const [agentUrl, setAgentUrl] = useState('https://teams.microsoft.com');
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const wsConnectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeFileInputRef = useRef<HTMLInputElement>(null);
  const jobDescriptionFileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const voiceBufferRef = useRef('');
  const streamBufferRef = useRef('');
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestStreamBuffersRef = useRef(new Map<string, string>());
  const requestStreamFlushTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingChatRequestIdsRef = useRef(new Set<string>());
  const pendingDeveloperRequestIdsRef = useRef(new Set<string>());
  const developerStreamBuffersRef = useRef(new Map<string, string>());
  const developerStreamFlushTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingDeveloperProposalRequestIdsRef = useRef(new Set<string>());
  const developerProposalBuffersRef = useRef(new Map<string, string>());
  const developerProposalFilesRef = useRef(new Map<string, string[]>());
  const developerProposalSnapshotsRef = useRef(new Map<string, DeveloperSnapshot[]>());
  const developerProposalSourcesRef = useRef(new Map<string, Map<string, string>>());
  const completedDeveloperToolResultsRef = useRef(new Map<string, unknown>());
  const liveRequestInFlightRef = useRef(false);
  const electronAudioContextRef = useRef<AudioContext | null>(null);
  const audioLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentSilenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentAudioContextRef = useRef<AudioContext | null>(null);
  const segmentHeardAudioRef = useRef(false);
  const captureActiveRef = useRef(false);
  const pendingSegmentQueueRef = useRef<Blob[]>([]);
  const segmentProcessorActiveRef = useRef(false);
  const lastProcessedTranscriptRef = useRef('');
  const requestInProgressRef = useRef(false);
  const chatRequestIdRef = useRef('');
  const draftImproveRequestIdRef = useRef('');
  const overlayChannelRef = useRef<BroadcastChannel | null>(null);
  const overlayStateRef = useRef({ answer: '', status: pipelineStatus });
  const requestTimingRef = useRef(new Map<string, RequestTiming>());

  // --- Auto-scroll to bottom on new content ---
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    overlayStateRef.current = {
      answer: [...messages].reverse().find((message) => message.role === 'assistant')?.content || '',
      status: pipelineStatus,
    };
    overlayChannelRef.current?.postMessage({ type: 'state', ...overlayStateRef.current });
  }, [messages, pipelineStatus]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('meeting-ai-overlay');
    overlayChannelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type === 'overlay-ready') {
        channel.postMessage({ type: 'state', ...overlayStateRef.current });
      }
    };
    return () => {
      channel.close();
      overlayChannelRef.current = null;
    };
  }, []);

  const flushStreamBuffer = useCallback((requestId?: string, fallbackContent = '') => {
    if (!requestId) {
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      const content = streamBufferRef.current;
      streamBufferRef.current = '';
      if (!content) return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant' && last.streaming) last.content += content;
        return next;
      });
      return;
    }
    const timer = requestStreamFlushTimersRef.current.get(requestId);
    if (timer) {
      clearTimeout(timer);
      requestStreamFlushTimersRef.current.delete(requestId);
    }
    const content = requestStreamBuffersRef.current.get(requestId) || fallbackContent;
    requestStreamBuffersRef.current.delete(requestId);
    if (!content) return;
    setMessages((prev) => {
      const next = [...prev];
      const message = next.find((item) => item.role === 'assistant' && item.requestId === requestId);
      if (message && message.streaming) message.content += content;
      return next;
    });
  }, []);

  const flushDeveloperStreamBuffer = useCallback((requestId: string, fallbackContent = '') => {
    const timer = developerStreamFlushTimersRef.current.get(requestId);
    if (timer) {
      clearTimeout(timer);
      developerStreamFlushTimersRef.current.delete(requestId);
    }
    const content = developerStreamBuffersRef.current.get(requestId) || fallbackContent;
    developerStreamBuffersRef.current.delete(requestId);
    if (!content) return;
    setDeveloperMessages((previous) => {
      const next = [...previous];
      const message = next.find((item) => item.role === 'assistant' && item.requestId === requestId);
      if (message && message.streaming) message.content += content;
      return next;
    });
  }, []);

  useEffect(() => () => {
    if (streamFlushTimerRef.current) clearTimeout(streamFlushTimerRef.current);
    requestStreamFlushTimersRef.current.forEach((timer) => clearTimeout(timer));
  }, []);

  useEffect(() => {
    localStorage.setItem('meeting-transcripts', JSON.stringify(transcripts));
  }, [transcripts]);

  useEffect(() => {
    localStorage.setItem('chat-history', JSON.stringify(chatHistory));
  }, [chatHistory]);

  useEffect(() => {
    const secretMap = readPersistedProviderSecrets();
    if (configuredProviders.length > 0) {
      writePersistedProviderSettings(providerId, configuredProviders.map((provider) => ({
        id: provider.id,
        label: provider.label,
        adapterType: provider.adapterType,
        model: provider.model,
        baseURL: provider.baseURL || '',
        enabled: provider.enabled,
        priority: provider.priority,
        status: provider.status || 'unknown',
      })), secretMap);
      return;
    }
    const { activeProvider } = readPersistedProviderSettings();
    if (activeProvider) {
      setProviderId(activeProvider as ProviderId);
    }
  }, [configuredProviders, providerId]);

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

  // Save only completed turns, so streaming tokens never cause storage writes.
  useEffect(() => {
    if (messages.length === 0 || messages.some((message) => message.streaming)) return;
    const savedMessages = messages.map(({ role, content }) => ({ role, content }));
    setChatHistory((previous) => [
      { id: activeChatId, title: chatTitle(savedMessages), messages: savedMessages, updatedAt: new Date().toISOString() },
      ...previous.filter((session) => session.id !== activeChatId),
    ].slice(0, 30));
  }, [activeChatId, messages]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    fetch(`${HTTP_URL}/api/settings/providers`)
      .then((response) => response.json())
      .then((data) => setConfiguredProviders(Array.isArray(data.providers) ? data.providers : []))
      .catch((err) => setError(`Could not load providers: ${(err as Error).message}`));
  }, [settingsOpen]);

  // --- Fetch health info on mount ---
  useEffect(() => {
    fetch(`${HTTP_URL}/api/health`)
      .then((r) => r.json())
      .then((data) => setHealth({ provider: data.provider, model: data.model }))
      .catch(() => setError('Cannot reach the AI server. Is it running on port 3001?'));
  }, []);

  // --- WebSocket connection ---
  // Reuses an in-flight CONNECTING socket instead of racing to open a second
  // one — avoids orphaned sockets, wasted handshakes, and messages being
  // sent on/received from the wrong socket.
  const ensureWs = useCallback((): Promise<WebSocket> => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return Promise.resolve(wsRef.current);
    }
    if (wsRef.current?.readyState === WebSocket.CONNECTING && wsConnectPromiseRef.current) {
      return wsConnectPromiseRef.current;
    }

    const connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError('');
        resolve(ws);
      };

      ws.onclose = () => {
        setConnected(false);
        wsConnectPromiseRef.current = null;
      };
      ws.onerror = () => {
        setConnected(false);
        wsConnectPromiseRef.current = null;
        reject(new Error('WebSocket connection failed. Is the WS server running on port 3002?'));
      };
    });

    wsConnectPromiseRef.current = connectPromise;
    return connectPromise;
  }, []);

  // Warm the chat socket before the first user message.
  useEffect(() => {
    void ensureWs().catch(() => undefined);
  }, [ensureWs]);

  const activeProfile = trainedProfiles.find((profile) => profile.id === activeProfileId) ?? null;

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

  const deleteProfile = useCallback((profileId: string) => {
    const profile = trainedProfiles.find((item) => item.id === profileId);
    if (profile && !window.confirm(`Delete trained profile "${profile.name}"?`)) return;
    setTrainedProfiles((prev) => prev.filter((profile) => profile.id !== profileId));
    setActiveProfileId((current) => (current === profileId ? null : current));
    setProfilePreviewOpen(false);
    setStatusMessage('Profile deleted.');
  }, [trainedProfiles]);

  const handlePdfUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>, documentLabel = 'Session Document') => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    setPdfLoading(true);
    setError('');
    setStatusMessage('');

    try {
      const extractedDocs: SessionDocument[] = [];
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) {
          throw new Error('Only PDF files can be uploaded to the context area.');
        }
        if (file.size > MAX_PDF_SIZE) {
          throw new Error(`${file.name} is larger than the 20MB PDF limit.`);
        }

        const formData = new FormData();
        formData.append('file', file);
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), PDF_UPLOAD_TIMEOUT_MS);
        const response = await fetch(`${HTTP_URL}/api/extract-pdf`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });
        window.clearTimeout(timeout);

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || `Failed to extract ${file.name}.`);
        }

        const extractedText = typeof data.text === 'string' ? data.text : '';
        if (!extractedText.trim()) {
          throw new Error(`${file.name} was not readable as text. Try a different PDF or an OCR-enabled file.`);
        }

        extractedDocs.push({
          id: crypto.randomUUID(),
          name: `${documentLabel}: ${file.name}`,
          text: extractedText,
          uploadedAt: Date.now(),
        });
      }

      if (!extractedDocs.length) return;
      setSessionDocuments((prev) => [...prev, ...extractedDocs]);
      const combinedText = extractedDocs.map((doc) => doc.text).join('\n\n');
      setPdfText(combinedText);
      if (documentLabel === 'Resume') {
        setPdfName(extractedDocs.map((doc) => doc.name).join(', '));
      }
      setStatusMessage(`${extractedDocs.length} PDF document${extractedDocs.length > 1 ? 's were' : ' was'} added to session context.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPdfLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const handleResumeUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    void handlePdfUpload(event, 'Resume');
  }, [handlePdfUpload]);

  const handleJobDescriptionPdfUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    await handlePdfUpload(event, 'Job Description');
  }, [handlePdfUpload]);

  const saveJobDescription = useCallback(() => {
    const text = jobDescription.trim();
    if (!text) return;

    setSessionDocuments((previous) => [
      ...previous.filter((document) => !document.name.startsWith('Job Description: Pasted')),
      {
        id: crypto.randomUUID(),
        name: 'Job Description: Pasted text',
        text,
        uploadedAt: Date.now(),
      },
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
    const profileName = window.prompt('Name this trained profile', suggestedName);
    if (!profileName || !profileName.trim()) return;

    const trimmedName = profileName.trim();
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
  }, [sessionDocuments]);

  const handleWsMessage = useCallback((data: string) => {
    const msg = JSON.parse(data);
    const isDraftImprove = msg.requestId && msg.requestId === draftImproveRequestIdRef.current;
    const isCurrentChat = msg.requestId && pendingChatRequestIdsRef.current.has(msg.requestId);
    const isDeveloperChat = msg.requestId && pendingDeveloperRequestIdsRef.current.has(msg.requestId);
    const isDeveloperProposal = msg.requestId && pendingDeveloperProposalRequestIdsRef.current.has(msg.requestId);

    if (!isDraftImprove && !isCurrentChat && !isDeveloperChat && !isDeveloperProposal) return;

    if (msg.type === 'decision' && isDeveloperChat) {
      const decision = msg.decision;
      if (decision?.decision === 'NEEDS_CLARIFICATION') {
        setDeveloperMessages((previous) => [...previous, {
          role: 'assistant',
          content: `${decision.question}\n\nCandidates:\n${decision.candidates.map((candidate: string) => `- ${candidate}`).join('\n')}`,
          streaming: false,
          requestId: String(msg.requestId),
        }]);
      }
      return;
    }

    if (msg.type === 'tool_call') {
      const requestId = String(msg.requestId);
      const toolCallId = String(msg.toolCallId);
      const resultKey = `${requestId}:${toolCallId}`;
      const cachedResult = completedDeveloperToolResultsRef.current.get(resultKey);
      const args = msg.arguments && typeof msg.arguments === 'object' ? msg.arguments : {};
      const sendToolResult = (result: unknown, error?: unknown) => {
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const normalized = error
          ? { ok: false, tool: msg.name, error: { code: error instanceof Error && /outside|relative|project/i.test(error.message) ? 'PATH_OUTSIDE_PROJECT' : 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
          : { ok: true, tool: msg.name, data: result };
        completedDeveloperToolResultsRef.current.set(resultKey, normalized);
        socket.send(JSON.stringify({
          type: 'tool_result',
          requestId,
          toolCallId,
          result: normalized,
        }));
      };
      if (cachedResult) {
        const socket = wsRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'tool_result', requestId, toolCallId, result: cachedResult }));
        }
        return;
      }
      void (async () => {
        try {
          if (!window.electronAPI || !developerProjectRoot) throw new Error('Select a project before using developer tools.');
          if (msg.name === 'list_directory') sendToolResult(await window.electronAPI.listDeveloperDirectory(String(args.relativePath || '.')));
          else if (msg.name === 'read_file') sendToolResult(await window.electronAPI.readDeveloperFile(String(args.relativePath || '')));
          else if (msg.name === 'search_code') sendToolResult(await window.electronAPI.searchDeveloperCode(String(args.query || '')));
          else if (msg.name === 'search_symbols') sendToolResult(await window.electronAPI.searchDeveloperSymbols(String(args.query || '').slice(0, 200)));
          else if (msg.name === 'get_repository_map') sendToolResult(await window.electronAPI.getDeveloperRepositoryMap());
          else if (msg.name === 'find_references') sendToolResult(await window.electronAPI.findDeveloperReferences(String(args.query || '').slice(0, 200)));
          else if (msg.name === 'get_context') sendToolResult(await window.electronAPI.assembleDeveloperContext({ query: String(args.query || '').slice(0, 200), maxTokens: args.maxTokens }));
          else if (msg.name === 'run_command') sendToolResult(await window.electronAPI.runDeveloperVerification(String(args.script || '')));
          else throw new Error(`Unsupported developer tool: ${String(msg.name)}`);
        } catch (error) {
          sendToolResult(null, error);
        }
      })();
      return;
    }
    if (msg.type === 'token') {
      if (isDraftImprove) return;
      if (isDeveloperProposal) {
        const requestId = String(msg.requestId);
        developerProposalBuffersRef.current.set(requestId, `${developerProposalBuffersRef.current.get(requestId) || ''}${msg.content}`);
        return;
      }
      if (isDeveloperChat) {
        const requestId = String(msg.requestId);
        developerStreamBuffersRef.current.set(requestId, `${developerStreamBuffersRef.current.get(requestId) || ''}${msg.content}`);
        if (!developerStreamFlushTimersRef.current.has(requestId)) {
          developerStreamFlushTimersRef.current.set(requestId, setTimeout(() => flushDeveloperStreamBuffer(requestId), 16));
        }
        return;
      }
      if (voiceReplies && typeof window !== 'undefined' && 'speechSynthesis' in window) {
        voiceBufferRef.current += msg.content;
        const sentenceMatch = voiceBufferRef.current.match(/^(.+?[.!?])(?:\s|$)/s);
        if (sentenceMatch) {
          const sentence = sentenceMatch[1].trim();
          voiceBufferRef.current = voiceBufferRef.current.slice(sentenceMatch[0].length);
          const speakableSentence = voiceSafeText(sentence);
          if (speakableSentence) window.speechSynthesis.speak(new SpeechSynthesisUtterance(speakableSentence));
        }
      }
      const requestId = String(msg.requestId);
      requestStreamBuffersRef.current.set(requestId, `${requestStreamBuffersRef.current.get(requestId) || ''}${msg.content}`);
      if (!requestStreamFlushTimersRef.current.has(requestId)) {
      // Keep React updates batched without adding a visible delay after the
      // server has already batched the provider's token chunks.
      requestStreamFlushTimersRef.current.set(requestId, setTimeout(() => flushStreamBuffer(requestId), 16));
      }
    } else if (msg.type === 'done') {
      if (isDeveloperProposal) {
        const requestId = String(msg.requestId);
        const responseText = String(msg.content || developerProposalBuffersRef.current.get(requestId) || '');
        const files = parseUnifiedDiff(responseText);
        const searchedFiles = developerProposalFilesRef.current.get(requestId) || [];
        const sources = developerProposalSourcesRef.current.get(requestId) || new Map();
        const unexpectedFiles = files.filter((file) => !searchedFiles.includes(file.path));
        if (!files.length && responseText.trim() !== 'NO_CHANGES') {
          developerProposalBuffersRef.current.delete(requestId);
          developerProposalFilesRef.current.delete(requestId);
          developerProposalSnapshotsRef.current.delete(requestId);
          developerProposalSourcesRef.current.delete(requestId);
          pendingDeveloperProposalRequestIdsRef.current.delete(requestId);
          setDeveloperBusy(false);
          setError('The assistant returned an invalid proposal. Expected a unified diff or NO_CHANGES.');
          return;
        }
        if (unexpectedFiles.length > 0) {
          developerProposalBuffersRef.current.delete(requestId);
          developerProposalFilesRef.current.delete(requestId);
          developerProposalSnapshotsRef.current.delete(requestId);
          developerProposalSourcesRef.current.delete(requestId);
          pendingDeveloperProposalRequestIdsRef.current.delete(requestId);
          setDeveloperBusy(false);
          setError(`The proposal referenced files that were not re-read: ${unexpectedFiles.map((file) => file.path).join(', ')}`);
          return;
        }
        if (files.some((file) => !validateUnifiedFile(file.lines, sources.get(file.path) || ''))) {
          developerProposalBuffersRef.current.delete(requestId);
          developerProposalFilesRef.current.delete(requestId);
          developerProposalSnapshotsRef.current.delete(requestId);
          developerProposalSourcesRef.current.delete(requestId);
          pendingDeveloperProposalRequestIdsRef.current.delete(requestId);
          setDeveloperBusy(false);
          setError('The proposal could not be validated against the current file contents.');
          return;
        }
        const snapshots = developerProposalSnapshotsRef.current.get(requestId) || [];
        void window.electronAPI?.createDeveloperProposal(responseText, snapshots).then((registered) => {
          setDeveloperProposal({ id: registered.id, state: registered.state, lifecycleState: registered.lifecycleState, files, raw: responseText, searchedFiles, snapshots, verification: null, outcome: null, error: null, runtime: registered.runtime || null });
        }).catch((error) => setError((error as Error).message));
        developerProposalBuffersRef.current.delete(requestId);
        developerProposalFilesRef.current.delete(requestId);
        developerProposalSnapshotsRef.current.delete(requestId);
        developerProposalSourcesRef.current.delete(requestId);
        pendingDeveloperProposalRequestIdsRef.current.delete(requestId);
        setDeveloperBusy(false);
        return;
      }
      if (isDeveloperChat) {
        const requestId = String(msg.requestId);
        const responseText = String(msg.content || '');
        console.log(`[DEVELOPER] Response received request=${requestId} length=${responseText.length}`);
        flushDeveloperStreamBuffer(requestId, responseText);
        pendingDeveloperRequestIdsRef.current.delete(requestId);
        setDeveloperStreaming(pendingDeveloperRequestIdsRef.current.size > 0);
        setDeveloperMessages((previous) => previous.map((message) =>
          message.requestId === requestId
            ? { ...message, content: responseText || message.content, streaming: false }
            : message,
        ));
        return;
      }
      const timing = requestTimingRef.current.get(msg.requestId);
      const parsedAt = performance.now();
      const responseText = String(msg.content || '');
      const answerText = responseText || requestStreamBuffersRef.current.get(String(msg.requestId)) || '';
      console.log(`[LLM] Response received request=${msg.requestId}`);
      console.log(`[ANSWER] request=${msg.requestId}`, answerText.slice(0, 160));
      console.log(`[TIMING] Provider response received at: ${new Date().toISOString()} request=${msg.requestId} provider=${msg.timing?.providerRequestMs ?? 'unknown'}ms`);
      console.log(`[TIMING] Answer parsed/formatted at: ${new Date().toISOString()} request=${msg.requestId} elapsed=${timing ? Math.round(parsedAt - timing.sendMessageCalledAt) : 'unknown'}ms`);
      setPipelineStatus('answer');
      if (isDraftImprove) {
        setInput(String(msg.content || '').trim());
        setDraftImproving(false);
        draftImproveRequestIdRef.current = '';
        return;
      }
      flushStreamBuffer(String(msg.requestId), responseText);
      pendingChatRequestIdsRef.current.delete(String(msg.requestId));
      liveRequestInFlightRef.current = false;
      setChatStreaming(pendingChatRequestIdsRef.current.size > 0);
      if (chatRequestIdRef.current === msg.requestId) chatRequestIdRef.current = '';
      if (voiceReplies && typeof window !== 'undefined' && 'speechSynthesis' in window && msg.content) {
        if (voiceBufferRef.current.trim()) {
          const speakableText = voiceSafeText(voiceBufferRef.current);
          if (speakableText) window.speechSynthesis.speak(new SpeechSynthesisUtterance(speakableText));
        }
        voiceBufferRef.current = '';
      }
      setMessages((prev) => {
        const next = [...prev];
        const message = next.find((item) => item.role === 'assistant' && item.requestId === msg.requestId);
        if (message) {
          if (responseText) message.content = responseText;
          message.streaming = false;
        }
        return [...next];
      });
      if (timing) {
        console.log(`[TIMING] TOTAL pending until React render request=${msg.requestId} question-to-parse=${Math.round(parsedAt - timing.questionFinalizedAt)}ms`);
        requestAnimationFrame(() => {
          const renderedAt = performance.now();
          console.log(`[TIMING] Answer rendered in UI at: ${new Date().toISOString()} request=${msg.requestId}`);
          console.log(`[TIMING] TOTAL: question-finalized → answer-rendered = ${Math.round(renderedAt - timing.questionFinalizedAt)}ms request=${msg.requestId}`);
        });
      }
      requestTimingRef.current.delete(msg.requestId);
    } else if (msg.type === 'error') {
      if (isDeveloperProposal) {
        developerProposalBuffersRef.current.delete(String(msg.requestId));
        developerProposalFilesRef.current.delete(String(msg.requestId));
        developerProposalSnapshotsRef.current.delete(String(msg.requestId));
        developerProposalSourcesRef.current.delete(String(msg.requestId));
        pendingDeveloperProposalRequestIdsRef.current.delete(String(msg.requestId));
        setDeveloperBusy(false);
        setError(`Could not generate proposal: ${msg.message}`);
        return;
      }
      if (isDeveloperChat) {
        const requestId = String(msg.requestId);
        pendingDeveloperRequestIdsRef.current.delete(requestId);
        flushDeveloperStreamBuffer(requestId);
        setDeveloperStreaming(pendingDeveloperRequestIdsRef.current.size > 0);
        setDeveloperMessages((previous) => previous.map((message) =>
          message.requestId === requestId
            ? { ...message, content: `Error: ${msg.message}`, streaming: false }
            : message,
        ));
        return;
      }
      if (isDraftImprove) {
        setDraftImproving(false);
        draftImproveRequestIdRef.current = '';
        setError(msg.message);
        return;
      }
      pendingChatRequestIdsRef.current.delete(String(msg.requestId));
      flushStreamBuffer(String(msg.requestId));
      liveRequestInFlightRef.current = false;
      setChatStreaming(pendingChatRequestIdsRef.current.size > 0);
      if (chatRequestIdRef.current === msg.requestId) chatRequestIdRef.current = '';
      setMessages((prev) => {
        const next = [...prev];
        const message = next.find((item) => item.role === 'assistant' && item.requestId === msg.requestId);
        if (message && message.streaming) {
          message.content = `Error: ${msg.message}`;
          message.streaming = false;
        }
        return [...next];
      });
      setError(msg.message);
      setPipelineStatus('error');
    }
  }, [developerProjectRoot, flushDeveloperStreamBuffer, flushStreamBuffer, voiceReplies]);

  // --- Send a chat message ---
  const sendMessage = async (question = input.trim(), contextOverride?: string, modelInstruction = question, questionFinalizedAt = performance.now()) => {
    if (!question) return;

    if (/^open\s+(to\s+)?(team|teams|microsoft\s+teams)\s*$/i.test(question)) {
      setInput('');
      setError('');
      if (!window.confirm('Open Microsoft Teams?')) return;
      try {
        const response = await fetch(`${HTTP_URL}/api/agent/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'teams', confirmed: true }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Opening Teams was blocked. Enable Allow open Teams in AI Settings.');
        setMessages((prev) => [...prev,
          { role: 'user', content: question },
          { role: 'assistant', content: 'Opening Microsoft Teams.' },
        ]);
      } catch (err) {
        setError((err as Error).message);
      }
      return;
    }

    if (/^call\s+(to\s+)?anurag\s*$/i.test(question)) {
      setInput('');
      setError('');
      if (!window.confirm('Open Microsoft Teams? The agent will not place a call or send a message.')) return;
      try {
        const response = await fetch(`${HTTP_URL}/api/agent/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'teams', confirmed: true }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Opening Teams was blocked. Enable the Teams permission first.');
        setMessages((prev) => [...prev,
          { role: 'user', content: question },
          { role: 'assistant', content: 'Teams is open. I cannot place a call by display name alone. Confirm Anurag\'s Teams contact or click the call button in Teams.' },
        ]);
      } catch (err) {
        setError((err as Error).message);
      }
      return;
    }

    const requestId = crypto.randomUUID();
    const userMsg: Message = { role: 'user', content: question };
    const assistantMsg: Message = { role: 'assistant', content: '', streaming: true, requestId };
    const sendMessageCalledAt = performance.now();
    requestTimingRef.current.set(requestId, { questionFinalizedAt, sendMessageCalledAt });
    console.log(`[TIMING] sendMessage() called at: ${new Date().toISOString()} request=${requestId}`);

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setError('');
    setChatStreaming(true);
    chatRequestIdRef.current = requestId;
    pendingChatRequestIdsRef.current.add(requestId);

    try {
      const ws = await ensureWs();
      ws.onmessage = (e) => handleWsMessage(e.data);
      // Renamed from `chatHistory` to avoid shadowing the `chatHistory`
      // state (saved chat sessions) declared above.
      const conversationHistory = [...messages, { ...userMsg, content: modelInstruction }]
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-MAX_CHAT_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: compactMessageContent(m.content) }));
      const contextStartedAt = performance.now();
      const resolvedContext = contextOverride !== undefined
        ? contextOverride
        : resolveContext({
          mode,
          sessionDocuments,
          activeProfile,
          contextCharBudget: PDF_CONTEXT_CHAR_BUDGET,
          profileCharBudget: PDF_CONTEXT_CHAR_BUDGET,
        });
      console.log(`[TIMING] Context resolved at: ${new Date().toISOString()} request=${requestId} elapsed=${Math.round(performance.now() - contextStartedAt)}ms chars=${resolvedContext.length}`);

      ws.send(JSON.stringify({
        type: 'chat',
        requestId,
        mode,
        messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...conversationHistory],
        // Archived transcripts remain available in the UI; only the current one is chat context.
        pdfContext: resolvedContext.slice(-MAX_CONTEXT_CHARS),
      }));
    } catch (err) {
      pendingChatRequestIdsRef.current.delete(requestId);
      liveRequestInFlightRef.current = false;
      setChatStreaming(pendingChatRequestIdsRef.current.size > 0);
      if (chatRequestIdRef.current === requestId) chatRequestIdRef.current = '';
      setPipelineStatus('error');
      setMessages((prev) => {
        const next = [...prev];
        const message = next.find((item) => item.role === 'assistant' && item.requestId === requestId);
        if (message) {
          message.content = `Connection error: ${(err as Error).message}`;
          message.streaming = false;
        }
        return [...next];
      });
    }
  };

  const sendDeveloperMessage = async () => {
    const question = developerInput.trim();
    if (!question || developerStreaming || developerBusy) return;
    if (/^(?:please\s+)?(?:apply|save|write|update|modify|make)\b.*(?:change|patch|file|it|this)/i.test(question)
      || /^(?:go ahead and )?(?:apply|save|write)\b/i.test(question)) {
      setDeveloperMessages((previous) => [
        ...previous,
        { role: 'user', content: question },
        { role: 'assistant', content: 'Proposal only — applying changes is not available from chat. Use the Apply action on a validated proposal.' },
      ]);
      setDeveloperInput('');
      return;
    }

    const requestId = crypto.randomUUID();
    const userMsg: Message = { role: 'user', content: question };
    const assistantMsg: Message = { role: 'assistant', content: '', streaming: true, requestId };
    const conversationHistory = [...developerMessages, userMsg]
      .slice(-MAX_CHAT_HISTORY_MESSAGES)
      .map((message) => ({ role: message.role, content: compactMessageContent(message.content) }));

    setDeveloperMessages((previous) => [...previous, userMsg, assistantMsg]);
    setDeveloperInput('');
    setDeveloperStreaming(true);
    pendingDeveloperRequestIdsRef.current.add(requestId);

    try {
      const ws = await ensureWs();
      ws.onmessage = (event) => handleWsMessage(event.data);
      ws.send(JSON.stringify({
        type: 'chat',
        requestId,
        mode: 'developer',
        developer: true,
        messages: [
          {
            role: 'system',
            content: 'You are a software development assistant. Help the user understand and debug the selected project. You may use the supplied read-only developer tools to inspect it. Never modify files, run commands, open applications, or claim to have done so. Prefer the smallest necessary inspection and then answer accurately.',
          },
          ...conversationHistory,
        ],
        pdfContext: '',
      }));
    } catch (err) {
      pendingDeveloperRequestIdsRef.current.delete(requestId);
      setDeveloperStreaming(false);
      setDeveloperMessages((previous) => previous.map((message) =>
        message.requestId === requestId
          ? { ...message, content: `Connection error: ${(err as Error).message}`, streaming: false }
          : message,
      ));
    }
  };

  const chooseDeveloperProject = async () => {
    if (!window.electronAPI || developerBusy || developerStreaming) {
      if (!window.electronAPI) setError('Project access is available in the Electron desktop app.');
      return;
    }
    setDeveloperBusy(true);
    try {
      const result = await window.electronAPI.chooseDeveloperProject();
      if (!result.canceled) {
        setDeveloperProjectRoot(result.projectRoot);
        setDeveloperPath('.');
        setDeveloperFileContent('');
        setDeveloperFilePath('');
        setDeveloperDirectory(await window.electronAPI.listDeveloperDirectory('.'));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeveloperBusy(false);
    }
  };

  const clearDeveloperProject = async () => {
    if (!window.electronAPI || developerBusy || developerStreaming) return;
    setDeveloperBusy(true);
    try {
      await window.electronAPI.clearDeveloperProject();
      setDeveloperProjectRoot(null);
      setDeveloperDirectory([]);
      setDeveloperPath('.');
      setDeveloperFileContent('');
      setDeveloperFilePath('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeveloperBusy(false);
    }
  };

  const listDeveloperDirectory = async () => {
    if (!window.electronAPI || !developerProjectRoot || developerBusy || developerStreaming) return;
    setDeveloperBusy(true);
    try {
      setDeveloperDirectory(await window.electronAPI.listDeveloperDirectory(developerPath || '.'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeveloperBusy(false);
    }
  };

  const readDeveloperFile = async (requestedPath = developerPath) => {
    if (!window.electronAPI || !developerProjectRoot || !requestedPath || developerBusy || developerStreaming) return;
    setDeveloperBusy(true);
    try {
      const result = await window.electronAPI.readDeveloperFile(requestedPath);
      setDeveloperFilePath(result.path);
      setDeveloperFileContent(result.content);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeveloperBusy(false);
    }
  };

  const searchDeveloperCode = async () => {
    if (!window.electronAPI || !developerProjectRoot || !developerSearchQuery.trim() || developerBusy || developerStreaming) return;
    setDeveloperBusy(true);
    try {
      const result = await window.electronAPI.searchDeveloperCode(developerSearchQuery);
      setDeveloperSearchResults(result.results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeveloperBusy(false);
    }
  };

  const generateDeveloperProposal = async () => {
    const request = developerChangeRequest.trim();
    const searchQuery = developerProposalSearchQuery.trim();
    if (!window.electronAPI || !developerProjectRoot || !request || !searchQuery || developerBusy || developerStreaming) return;

    setDeveloperBusy(true);
    setError('');
    setDeveloperProposal(null);
    try {
      const search = await window.electronAPI.searchDeveloperCode(searchQuery);
      const paths = [...new Set(search.results.map((result) => result.path))].slice(0, 6);
      if (!paths.length) throw new Error('No relevant files were found. Refine the search query before generating a proposal.');

      const initialFiles = await Promise.all(paths.map(async (path) => ({
        path,
        content: (await window.electronAPI!.readDeveloperFile(path)).content,
      })));
      const initialSnapshots = await Promise.all(initialFiles.map(async ({ path, content }) => ({ path, hash: await hashDeveloperContent(content) })));
      const snapshot = initialFiles
        .map(({ path, content }) => `FILE: ${path}\n${content.slice(0, 24000)}`)
        .join('\n\n');

      // Re-read immediately before generation so the proposal is based on the
      // latest safe, project-root-confined file contents.
      const latestFiles = await Promise.all(paths.map(async (path) => ({
        path,
        content: (await window.electronAPI!.readDeveloperFile(path)).content,
      })));
      const latestSnapshots = await Promise.all(latestFiles.map(async ({ path, content }) => ({ path, hash: await hashDeveloperContent(content) })));
      if (initialSnapshots.some((snapshot, index) => snapshot.hash !== latestSnapshots[index]?.hash)) {
        throw new Error('The file changed while the proposal was being prepared. Please retry.');
      }
      const latestSnapshot = latestFiles
        .map(({ path, content }) => `FILE: ${path}\n${content.slice(0, 24000)}`)
        .join('\n\n');

      const requestId = crypto.randomUUID();
      pendingDeveloperProposalRequestIdsRef.current.add(requestId);
      developerProposalFilesRef.current.set(requestId, paths);
      developerProposalSnapshotsRef.current.set(requestId, latestSnapshots);
      developerProposalSourcesRef.current.set(requestId, new Map(latestFiles.map(({ path, content }) => [path, content])));
      const ws = await ensureWs();
      ws.onmessage = (event) => handleWsMessage(event.data);
      ws.send(JSON.stringify({
        type: 'chat',
        requestId,
        mode: 'direct',
        messages: [{
          role: 'system',
          content: 'You generate read-only code change proposals. Return only a minimal unified diff. Never claim to apply changes, run commands, or access files beyond the supplied snapshots. Use exact relative paths from the snapshots. Include --- a/path, +++ b/path, and @@ hunks. If no safe change is needed, return NO_CHANGES.',
        }, {
          role: 'user',
          content: `Change request:\n${request}\n\nInitial search snapshot:\n${snapshot}\n\nLatest re-read snapshot (authoritative):\n${latestSnapshot}`,
        }],
        pdfContext: '',
      }));
    } catch (err) {
      setDeveloperBusy(false);
      setError((err as Error).message);
    }
  };

  const approveDeveloperProposal = async () => {
    if (!developerProposal?.id || !window.electronAPI) return;
    setDeveloperBusy(true);
    try {
      const result = await window.electronAPI.approveDeveloperProposal(developerProposal.id);
      setDeveloperProposal((current) => current ? { ...current, state: result.state, lifecycleState: result.lifecycleState } : current);
    } catch (error) { setError((error as Error).message); } finally { setDeveloperBusy(false); }
  };

  const applyDeveloperProposal = async () => {
    if (!developerProposal?.id || !window.electronAPI) return;
    setDeveloperBusy(true);
    try {
      const result = await window.electronAPI.applyDeveloperProposal(developerProposal.id);
      setDeveloperProposal((current) => current ? {
        ...current,
        state: result.state,
        lifecycleState: result.lifecycleState,
        verification: result.verification,
        outcome: result.outcome,
        error: result.error,
      } : current);
    } catch (error) { setError((error as Error).message); } finally { setDeveloperBusy(false); }
  };

  const undoDeveloperProposal = async () => {
    if (!developerProposal?.id || !window.electronAPI) return;
    setDeveloperBusy(true);
    try {
      const result = await window.electronAPI.undoDeveloperProposal(developerProposal.id);
      setDeveloperProposal((current) => current ? { ...current, state: result.state } : current);
    } catch (error) { setError((error as Error).message); } finally { setDeveloperBusy(false); }
  };

  const improveDraft = async () => {
    const draft = input.trim();
    if (!draft || draftImproving || chatStreaming) return;

    const requestId = crypto.randomUUID();
    draftImproveRequestIdRef.current = requestId;
    setDraftImproving(true);
    setError('');
    try {
      const ws = await ensureWs();
      ws.onmessage = (event) => handleWsMessage(event.data);
      ws.send(JSON.stringify({
        type: 'chat',
        requestId,
        mode,
        messages: [{
          role: 'user',
          content: `Rewrite the following draft to be clear, concise, and natural. Preserve its meaning. Reply with only the improved text.\n\nDRAFT:\n${draft}`,
        }],
        pdfContext: '',
      }));
    } catch (err) {
      draftImproveRequestIdRef.current = '';
      setDraftImproving(false);
      setError(`Could not improve the draft: ${(err as Error).message}`);
    }
  };

  const stopMeetingCapture = () => {
    captureActiveRef.current = false;
    if (segmentSilenceTimerRef.current) clearInterval(segmentSilenceTimerRef.current);
    segmentSilenceTimerRef.current = null;
    void segmentAudioContextRef.current?.close();
    segmentAudioContextRef.current = null;
    recorderRef.current?.stop();
    setIsRecording(false);
    setPipelineStatus('stopped');
  };

  const monitorSystemAudio = (stream: MediaStream) => {
    const audioContext = new AudioContext();
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
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error('No system audio source selected. Choose a tab, window, or screen and enable Share audio.');
    }
    displayStream.getVideoTracks().forEach((track) => track.stop());
    const systemStream = new MediaStream(audioTracks);
    const sourceLabel = audioTracks[0].label || 'Selected system audio';
    setAudioSourceLabel(sourceLabel);
    setAudioStatus('connected');
    monitorSystemAudio(systemStream);
    return systemStream;
  };

  const recordAudioStream = (stream: MediaStream, cleanup: () => void) => {
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const processSegment = async (segment: Blob) => {
      const segmentId = crypto.randomUUID();
      setIsTranscribing(true);
      setPipelineStatus('transcribing');
      console.log('[CAPTURE] Silence/end-of-utterance detected — flushing segment');
      console.log(`[STT] Request started segment=${segmentId}`);
      try {
        const formData = new FormData();
        console.log(`[AUDIO] Audio chunk size: ${segment.size} bytes`);
        formData.append('file', segment, 'meeting.webm');
        const response = await fetch(`${HTTP_URL}/api/transcribe-audio`, { method: 'POST', body: formData });
        let data: { text?: unknown; error?: string } = {};
        try {
          data = await response.json();
        } catch {
          if (!response.ok) throw new Error(`Transcription failed with HTTP ${response.status}.`);
        }
        if (!response.ok) {
          console.warn(`[STT] Failure segment=${segmentId} status=${response.status}`);
          throw new Error(data.error || `Transcription failed with HTTP ${response.status}.`);
        }
        const transcript = cleanTranscript(String(data.text || ''));
        console.log(`[STT] Success segment=${segmentId} transcriptLength=${transcript.length}`);
        console.log(`[STT] Final transcript: "${transcript}"`);
        if (!transcript) throw new Error('No speech detected.');
        const detected = detectQuestion(transcript);
        if (!detected.isQuestion || !detected.question) {
          setPipelineStatus('ready');
          setError('No complete question or request detected.');
          return;
        }
        const normalized = detected.question.toLowerCase().replace(/\s+/g, ' ');
        if (normalized === lastProcessedTranscriptRef.current) return;
        lastProcessedTranscriptRef.current = normalized;
        setPipelineStatus('question');
        console.log('[QUESTION] Question detected');
        setLiveTranscript(transcript);
        setTranscripts((current) => [{
          id: crypto.randomUUID(),
          source: meetingSource,
          text: transcript,
          createdAt: new Date().toISOString(),
        }, ...current]);
        setPipelineStatus('thinking');
        console.log('[LLM] Sending text to LLM');
        const questionFinalizedAt = performance.now();
        console.log(`[TIMING] Question finalized at: ${new Date().toISOString()}`);
        await sendMessage(detected.question, '', detected.question, questionFinalizedAt);
      } catch (err) {
        console.warn(`[STT] Segment discarded segment=${segmentId}`);
        setError((err as Error).message.includes('Transcription')
          ? 'Speech-to-text failed. Please try speaking again.'
          : (err as Error).message);
      } finally {
        setIsTranscribing(false);
      }
    };

    const processPendingSegments = async () => {
      if (segmentProcessorActiveRef.current) return;
      segmentProcessorActiveRef.current = true;
      requestInProgressRef.current = true;
      try {
        while (pendingSegmentQueueRef.current.length > 0) {
          const nextSegment = pendingSegmentQueueRef.current.shift();
          if (nextSegment) await processSegment(nextSegment);
        }
      } finally {
        requestInProgressRef.current = false;
        segmentProcessorActiveRef.current = false;
        if (captureActiveRef.current) setPipelineStatus('listening');
      }
    };

    recorder.onstop = () => {
      const segment = chunks.splice(0, chunks.length);
      segmentHeardAudioRef.current = false;
      if (captureActiveRef.current) {
        recorder.start();
        console.log('[CAPTURE] Utterance segment started');
      } else {
        cleanup();
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        streamRef.current = null;
        void electronAudioContextRef.current?.close();
        electronAudioContextRef.current = null;
        if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
        audioLevelTimerRef.current = null;
        setAudioLevel(0);
        setAudioStatus('disabled');
        setPipelineStatus('stopped');
      }
      if (segment.length > 0) {
        pendingSegmentQueueRef.current.push(new Blob(segment, { type: recorder.mimeType || 'audio/webm' }));
        void processPendingSegments();
      }
    };
    recorder.start();
    captureActiveRef.current = true;
    console.log('[CAPTURE] Utterance segment started');
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
        segmentHeardAudioRef.current = true;
        lastAudioAt = Date.now();
      } else if (segmentHeardAudioRef.current && Date.now() - lastAudioAt >= SYSTEM_AUDIO_SILENCE_MS) {
        console.log('[CAPTURE] Silence/end-of-utterance detected — flushing segment');
        recorder.stop();
      }
    }, 100);
  };

  const startMeetingCapture = async () => {
    setError('');
    setStatusMessage('Opening the system-audio source selector...');
    try {
      const systemStream = await requestSystemAudioStream();
      recordAudioStream(systemStream, () => {
        systemStream.getTracks().forEach((track) => track.stop());
      });
      setStatusMessage('System audio connected. Listening is ready.');
    } catch (err) {
      setAudioStatus('disabled');
      setAudioSourceLabel('Not connected');
      setError(systemAudioErrorMessage(err, 'capture'));
      setStatusMessage('');
    }
  };

  const testSystemAudio = async () => {
    setError('');
    setStatusMessage('Opening the system-audio source selector...');
    let stream: MediaStream | null = null;
    try {
      stream = await requestSystemAudioStream();
      setAudioStatus('testing');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        setError('System audio test passed. Only the selected system-audio source was received; microphone capture was not requested.');
      }
    } catch (err) {
      setAudioStatus('disabled');
      setAudioSourceLabel('Not connected');
      setError(systemAudioErrorMessage(err, 'test'));
      setStatusMessage('');
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      void electronAudioContextRef.current?.close();
      electronAudioContextRef.current = null;
      if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
      audioLevelTimerRef.current = null;
      setAudioLevel(0);
      if (!isRecording) setAudioStatus('disabled');
      if (!isRecording && !error) setStatusMessage('');
    }
  };

  const saveMeetingTranscript = () => {
    if (!liveTranscript.trim()) {
      setError('No transcript text has been captured yet.');
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

  const chooseProvider = (value: ProviderId) => {
    setProviderId(value);
    setProviderModel(providerPresets[value].model);
    setProviderBaseURL(providerPresets[value].baseURL);
  };

  const refreshConfiguredProviders = async () => {
    const response = await fetch(`${HTTP_URL}/api/settings/providers`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load providers.');
    const providers = Array.isArray(data.providers) ? data.providers : [];
    setConfiguredProviders(providers);
    if (providers.length === 0) {
      const persistedSecrets = readPersistedProviderSecrets();
      const savedProviders = Object.entries(providerPresets).filter(([name]) => Boolean(persistedSecrets[name])).map(([name, preset]) => ({
        label: preset.label,
        adapterType: name,
        apiKey: persistedSecrets[name],
        model: preset.model,
        baseURL: preset.baseURL,
        enabled: true,
      }));
      for (const provider of savedProviders) {
        await fetch(`${HTTP_URL}/api/settings/providers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(provider),
        });
      }
      const hydrated = await fetch(`${HTTP_URL}/api/settings/providers`);
      const hydratedData = await hydrated.json();
      if (hydrated.ok) setConfiguredProviders(Array.isArray(hydratedData.providers) ? hydratedData.providers : []);
    }
  };

  const saveConfiguredProvider = async () => {
    if (!providerKey.trim() || !providerModel.trim()) {
      setError('API key and model are required.');
      return;
    }
    setProviderSaving(true);
    setError('');
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: providerLabel || providerPresets[providerId].label,
          adapterType: providerId,
          apiKey: providerKey,
          model: providerModel,
          baseURL: providerBaseURL,
          enabled: providerEnabled,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save provider.');
      const secrets = readPersistedProviderSecrets();
      secrets[providerId] = providerKey;
      writePersistedProviderSettings(providerId, data.providers || [], secrets);
      setConfiguredProviders(data.providers || []);
      setProviderKey('');
      setProviderLabel('');
      setStatusMessage('Provider saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(false);
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
      if (!response.ok) throw new Error(data.error || 'Could not update provider.');
      const secrets = readPersistedProviderSecrets();
      if (changes.model && provider.adapterType && !provider.hasApiKey && typeof (changes as { apiKey?: string }).apiKey === 'string') {
        secrets[provider.adapterType] = (changes as { apiKey?: string }).apiKey as string;
      }
      writePersistedProviderSettings(providerId, data.providers || [], secrets);
      setConfiguredProviders(data.providers || []);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deleteConfiguredProvider = async (provider: ConfiguredProvider) => {
    if (!window.confirm(`Remove provider "${provider.label}"?`)) return;
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not remove provider.');
      const secrets = readPersistedProviderSecrets();
      delete secrets[provider.adapterType];
      writePersistedProviderSettings(providerId, data.providers || [], secrets);
      setConfiguredProviders(data.providers || []);
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
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveProviderSettings = async () => {
    if (!providerKey.trim() || !providerModel.trim()) {
      setError('API key and model are required.');
      return;
    }
    setProviderSaving(true);
    setError('');
    try {
      const response = await fetch(`${HTTP_URL}/api/settings/provider`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey: providerKey, model: providerModel, baseURL: providerBaseURL, fallbackEnabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Provider setup failed');
      const secrets = readPersistedProviderSecrets();
      secrets[providerId] = providerKey;
      writePersistedProviderSettings(providerId, configuredProviders.length > 0 ? configuredProviders : [{
        id: `provider-${providerId}`,
        label: providerPresets[providerId].label,
        adapterType: providerId,
        model: providerModel,
        baseURL: providerBaseURL,
        enabled: true,
        priority: 1,
        status: 'unknown',
      }], secrets);
      setHealth({ provider: data.provider, model: data.model });
      setProviderKey('');
      setSettingsOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(false);
    }
  };

  const saveAgentPermissions = async (nextPermissions = agentPermissions) => {
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
      setError((err as Error).message);
    } finally {
      setAgentSaving(false);
    }
  };

  const loadAgentActivity = async () => {
    try {
      const response = await fetch(`${HTTP_URL}/api/agent/activity`);
      const data = await response.json();
      if (response.ok) setAgentActivity(Array.isArray(data.activity) ? data.activity : []);
    } catch {
      // The log is optional; action controls remain available if it is offline.
    }
  };

  const enableAllAgentPermissions = () => {
    if (!window.confirm('Enable every allowed app and browser action? Each action will still require confirmation before it runs.')) return;
    void saveAgentPermissions(allAgentPermissions);
  };

  const runAgentAction = async (target: string) => {
    const label = agentPermissionOptions.find(([, , optionTarget]) => optionTarget === target)?.[1] || target;
    if (!window.confirm(`Open ${label}?`)) return;
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
    }
  };

  const startGeneralTask = async () => {
    const goal = generalGoal.trim();
    if (!goal || generalBusy || generalTaskActive) return;
    if (!window.electronAPI) {
      setError('General Agent tasks require the Electron desktop app.');
      return;
    }
    setGeneralBusy(true);
    setError('');
    try {
      const created = await window.electronAPI.createGeneralTask({ goal });
      const started = await window.electronAPI.startGeneralTask(created.taskId);
      setGeneralTask(started);
      setGeneralExecutionAction(null);
      setGeneralConfirmation(null);
      setGeneralVerificationEvidence('');
      setGeneralClarification('');
      setGeneralFollowUp('');
      setGeneralGoal('');
      setStatusMessage('General Agent task is ready for a browser plan.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const stopGeneralTask = async () => {
    if (!window.electronAPI || !generalTask || generalBusy) return;
    setGeneralBusy(true);
    try {
      setGeneralTask(await window.electronAPI.stopGeneralTask(generalTask.taskId));
      setStatusMessage('General Agent stopped. No pending action will continue.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const reviseGeneralTask = async (message?: string) => {
    const clarification = (message || generalClarification || generalFollowUp).trim();
    if (!window.electronAPI || !generalTask || !clarification || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      setGeneralTask(await window.electronAPI.replanGeneralTask(generalTask.taskId, { message: clarification }));
      setGeneralClarification('');
      setGeneralFollowUp('');
      setStatusMessage('General Agent plan updated with your clarification.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const toggleGeneralPause = async () => {
    if (!window.electronAPI || !generalTask || generalBusy) return;
    setGeneralBusy(true);
    try {
      const next = generalTask.paused
        ? await window.electronAPI.resumeGeneralTask(generalTask.taskId)
        : await window.electronAPI.pauseGeneralTask(generalTask.taskId);
      setGeneralTask(next);
      setStatusMessage(next.paused ? 'General Agent paused.' : 'General Agent resumed.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const createGeneralBrowserSession = async () => {
    if (!window.electronAPI || !generalTask || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      const response = await window.electronAPI.createGeneralBrowserSession(generalTask.taskId);
      setGeneralTask(response.task);
      setStatusMessage(`Isolated browser session ${response.browserSessionId} is ready.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const performGeneralBrowserOperation = async (operation: string, target: Record<string, unknown> | string = {}) => {
    if (!window.electronAPI || !generalTask || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      const response = await window.electronAPI.generalBrowserOperation(generalTask.taskId, operation, target);
      setGeneralTask(response.task);
      setStatusMessage(`Browser ${operation} completed at observation ${String(response.observation.version || response.task.observationVersion)}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const refreshGeneralExecutionAction = async () => {
    if (!window.electronAPI || !generalTask?.executionActionId || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      const response = await window.electronAPI.getGeneralExecutionAction(generalTask.taskId, generalTask.executionActionId);
      setGeneralExecutionAction(response.action);
      setGeneralTask(response.task);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const validateGeneralExecutionAction = async () => {
    if (!window.electronAPI || !generalTask?.executionActionId || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      const response = await window.electronAPI.validateGeneralExecutionAction(generalTask.taskId, generalTask.executionActionId);
      setGeneralExecutionAction(response.action);
      setGeneralTask(response.task);
      setStatusMessage(response.action.state === 'WAITING_FOR_CONFIRMATION' ? 'Action is waiting for your confirmation.' : 'Action validated and ready to execute.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const requestGeneralExecutionConfirmation = async () => {
    if (!window.electronAPI || !generalTask?.executionActionId || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      const response = await window.electronAPI.requestGeneralExecutionConfirmation(generalTask.taskId, generalTask.executionActionId);
      setGeneralConfirmation(response.confirmation);
      setGeneralTask(response.task);
      const action = await window.electronAPI.getGeneralExecutionAction(generalTask.taskId, generalTask.executionActionId);
      setGeneralExecutionAction(action.action);
      setStatusMessage('Action prepared. Review the details before confirming.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const confirmGeneralExecutionAction = async () => {
    const confirmationId = generalConfirmation?.confirmationId;
    if (!window.electronAPI || !generalTask?.executionActionId || typeof confirmationId !== 'string' || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      const response = await window.electronAPI.confirmGeneralExecutionAction(generalTask.taskId, generalTask.executionActionId, confirmationId);
      setGeneralExecutionAction(response.action);
      setGeneralTask(response.task);
      setGeneralConfirmation(null);
      setStatusMessage('Action confirmed. Execution remains under your control.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGeneralBusy(false);
    }
  };

  const runGeneralExecutionStep = async (step: 'execute' | 'observe' | 'verify' | 'recover') => {
    if (!window.electronAPI || !generalTask?.executionActionId || generalBusy) return;
    setGeneralBusy(true);
    setError('');
    try {
      const actionId = generalTask.executionActionId;
      const response = step === 'execute'
        ? await window.electronAPI.executeGeneralExecutionAction(generalTask.taskId, actionId)
        : step === 'observe'
          ? await window.electronAPI.observeGeneralExecutionAction(generalTask.taskId, actionId)
          : step === 'verify'
            ? await window.electronAPI.verifyGeneralExecutionAction(generalTask.taskId, actionId, { evidence: generalVerificationEvidence.trim() })
            : await window.electronAPI.recoverGeneralExecutionAction(generalTask.taskId, actionId);
      setGeneralExecutionAction(response.action);
      setGeneralTask(response.task);
      if (step === 'verify') setStatusMessage(response.action.state === 'SUCCEEDED' ? 'Action verified successfully.' : 'Verification completed with limitations.');
    } catch (err) {
      setError((err as Error).message);
      try {
        const latest = await window.electronAPI.getGeneralExecutionAction(generalTask.taskId, generalTask.executionActionId);
        setGeneralExecutionAction(latest.action);
        setGeneralTask(latest.task);
      } catch (refreshError) {
        setError(`${(err as Error).message} ${(refreshError as Error).message}`);
      }
    } finally {
      setGeneralBusy(false);
    }
  };

  // --- PDF upload ---
  const removePdf = () => {
    setPdfText('');
    setPdfName('');
    setSessionDocuments([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStatusMessage('Session document cleared.');
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

  const startNewChat = () => {
    setMessages([]);
    setInput('');
    setError('');
    setActiveChatId(crypto.randomUUID());
    setHistoryOpen(false);
  };

  const openHistorySession = (session: ChatSession) => {
    setActiveChatId(session.id);
    setMessages(session.messages.map((message) => ({ ...message, streaming: false })));
    setInput('');
    setError('');
    setHistoryOpen(false);
  };

  const clearChat = () => {
    startNewChat();
  };

  const sessionActive = isRecording || isTranscribing || chatStreaming || messages.length > 0 || pipelineStatus === 'question' || pipelineStatus === 'thinking' || pipelineStatus === 'answer';
  const generalTaskActive = Boolean(generalTask && !['COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(generalTask.phase));
  const lastQuestion = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  const lastAnswer = [...messages].reverse().find((message) => message.role === 'assistant')?.content || '';
  const answeredSegments = messages.reduce<Array<{ question: string; answer: string }>>((segments, message, index) => {
    if (message.role !== 'user') return segments;
    const answer = messages[index + 1];
    if (answer?.role === 'assistant' && answer.content && !answer.streaming) {
      segments.push({ question: message.content, answer: answer.content });
    }
    return segments;
  }, []);
  const statusLabel = pipelineStatus === 'listening' ? 'Listening...' : pipelineStatus === 'transcribing' ? 'Transcribing...' : pipelineStatus === 'question' ? 'Question detected' : pipelineStatus === 'thinking' ? 'Thinking...' : pipelineStatus === 'answer' ? 'Answer ready' : pipelineStatus === 'stopped' ? 'Stopped' : 'Ready';
  const statusTone = pipelineStatus === 'error' ? 'text-rose-300' : pipelineStatus === 'answer' ? 'text-emerald-300' : 'text-sky-300';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800/80 bg-slate-950/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400"><Bot className="h-5 w-5 text-slate-950" /></div>
            <div><h1 className="text-sm font-semibold">Meeting AI Assistant</h1><p className={`text-[11px] ${statusTone}`}>● {statusLabel}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800 p-0.5" aria-label="Application mode">
              <button
                onClick={() => { if (!isRecording && !isTranscribing && !chatStreaming && !developerStreaming && !generalTaskActive && !generalBusy) setAppMode('assistant'); }}
                disabled={isRecording || isTranscribing || chatStreaming || developerStreaming || generalTaskActive || generalBusy}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${appMode === 'assistant' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                AI Assistant
              </button>
              <button
                onClick={() => { if (!isRecording && !isTranscribing && !chatStreaming && !developerStreaming && !generalTaskActive && !generalBusy) setAppMode('developer'); }}
                disabled={isRecording || isTranscribing || chatStreaming || developerStreaming || generalTaskActive || generalBusy}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${appMode === 'developer' ? 'bg-sky-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                Developer
              </button>
              <button
                onClick={() => { if (!isRecording && !isTranscribing && !chatStreaming && !developerStreaming && !generalTaskActive && !generalBusy) setAppMode('general'); }}
                disabled={isRecording || isTranscribing || chatStreaming || developerStreaming || generalTaskActive || generalBusy}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${appMode === 'general' ? 'bg-violet-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                General
              </button>
            </div>
            <div className={`${appMode === 'assistant' ? '' : 'hidden'} flex items-center rounded-lg border border-slate-700 bg-slate-800 p-0.5`} aria-label="AI mode">
              <button
                onClick={() => setMode('direct')}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${mode === 'direct' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}
              >
                Direct
              </button>
              <button
                onClick={() => setMode('langchain')}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${mode === 'langchain' ? 'bg-teal-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}
              >
                LangChain
              </button>
            </div>
            <button
              onClick={() => {
                if (window.electronAPI) {
                  void window.electronAPI.toggleOverlay();
                } else {
                  setError('Overlay mode is available in the Electron desktop app.');
                }
              }}
              className={`${appMode === 'assistant' ? '' : 'hidden'} rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-400`}
              title="Open transparent answer overlay"
            >
              Overlay
            </button>
            {appMode === 'assistant' && sessionActive && <button onClick={() => setMeetingMenuOpen((open) => !open)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-400">⚙ Audio</button>}
            <div className={`${appMode === 'assistant' ? '' : 'hidden'} relative`}>
              <button
                onClick={() => setContextMenuOpen((open) => !open)}
                className={`rounded-lg border px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-400 ${contextMenuOpen ? 'border-emerald-400 bg-emerald-500/10' : 'border-slate-700'}`}
              >
                Context
              </button>
              {contextMenuOpen && (
                <div className="absolute right-0 top-11 z-20 max-h-[calc(100vh-5rem)] w-[min(23rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Session context</p>
                      <p className="text-xs text-slate-500">Resume and job description context</p>
                    </div>
                    <button onClick={() => setContextMenuOpen(false)} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200" aria-label="Close context panel"><X className="h-4 w-4" /></button>
                  </div>
                  {mode === 'direct' && (sessionDocuments.length > 0 || activeProfile) && (
                    <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                      This context is available but not used while in Direct mode.
                    </p>
                  )}
                  <input ref={resumeFileInputRef} type="file" accept="application/pdf" onChange={handleResumeUpload} className="hidden" />
                  <input ref={jobDescriptionFileInputRef} type="file" accept="application/pdf" onChange={handleJobDescriptionPdfUpload} className="hidden" />
                  <div className="space-y-3">
                    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium text-slate-200">Resume / document</p>
                        <button onClick={() => resumeFileInputRef.current?.click()} disabled={pdfLoading} className="rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">
                          {pdfLoading ? 'Reading...' : 'Upload PDF'}
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">{pdfName || 'No resume uploaded'}</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium text-slate-200">Job Description</p>
                        <button onClick={() => jobDescriptionFileInputRef.current?.click()} disabled={pdfLoading} className="rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">
                          Upload PDF
                        </button>
                      </div>
                      <textarea value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="Paste the job description here..." rows={4} className="w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400" />
                      <button onClick={saveJobDescription} disabled={!jobDescription.trim()} className="mt-2 rounded-md bg-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600 disabled:opacity-40">Add pasted text</button>
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
                      <button onClick={trainProfile} disabled={pdfLoading || sessionDocuments.length === 0} className="rounded-md bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40">Train</button>
                    </div>
                    {activeProfile && (
                      <div className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-2">
                        <span className="truncate text-[11px] text-slate-300">Active: {activeProfile.name}</span>
                        <button onClick={() => deleteProfile(activeProfile.id)} className="ml-2 shrink-0 text-[11px] text-rose-300 hover:text-rose-200">Delete profile</button>
                      </div>
                    )}
                    {(sessionDocuments.length > 0 || activeProfile) && <button onClick={clearSessionContext} className="text-[11px] text-slate-400 hover:text-slate-200">Clear session upload</button>}
                  </div>
                </div>
              )}
            </div>
            <button onClick={() => { setSettingsOpen(true); void loadAgentActivity(); }} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-emerald-400" title="Settings"><Settings className="h-4 w-4" /></button>
            <button onClick={() => setHistoryOpen(true)} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-emerald-400" title="History"><History className="h-4 w-4" /></button>
          </div>
        </div>
      </header>
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
                  <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Audio source</label>
                    <select defaultValue="system" aria-label="Audio source" className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-200">
                      <option value="system">System / Internal Audio</option>
                    </select>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Status</span>
                      <span className={audioStatus === 'disabled' ? 'text-slate-500' : 'text-emerald-300'}>● {audioStatus === 'testing' ? 'Testing system audio' : audioStatus === 'connected' ? 'System Audio Connected' : 'System Audio Disabled'}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Input device</span>
                      <span className="max-w-[11rem] truncate text-right text-slate-200">{audioSourceLabel}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Microphone</span>
                      <span className="font-semibold text-emerald-300">OFF</span>
                    </div>
                    <div>
                      <div className="mb-1 flex justify-between text-[10px] text-slate-500"><span>System audio level</span><span>{audioLevel}%</span></div>
                      <div className="flex h-2 gap-0.5" aria-label={`System audio level ${audioLevel}%`}>
                        {Array.from({ length: 10 }, (_, index) => <span key={index} className={`flex-1 rounded-sm ${audioLevel >= (index + 1) * 10 ? 'bg-emerald-400' : 'bg-slate-700'}`} />)}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-slate-500">SYSTEM AUDIO ONLY. Choose a playback source in the operating-system capture dialog. The physical microphone is never requested or sent to speech-to-text.</p>
                  <div className="mt-3 flex gap-2">
                    {!isRecording && !isTranscribing ? (
                      <>
                        <button onClick={() => void testSystemAudio()} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-emerald-500/40 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10"><MonitorUp className="h-3.5 w-3.5" /> Test Audio</button>
                        <button onClick={() => void startMeetingCapture()} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-400"><MonitorUp className="h-3.5 w-3.5" /> Start Listening</button>
                      </>
                    ) : (
                      <button onClick={stopMeetingCapture} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-xs font-medium text-white hover:bg-slate-600"><Square className="h-3 w-3" /> Stop Listening</button>
                    )}
                    {liveTranscript && <button onClick={saveMeetingTranscript} className="rounded-lg border border-emerald-500/40 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-500/10">Save</button>}
                  </div>
                  {liveTranscript && <p className="mt-2 max-h-16 overflow-y-auto rounded-lg bg-slate-950/60 p-2 text-[11px] leading-relaxed text-slate-300">{liveTranscript}</p>}
                  {transcripts.length > 0 && (
                    <div className="mt-3 border-t border-slate-800 pt-3">
                      <div className="mb-2 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5"><Search className="h-3.5 w-3.5 text-slate-500" /><input value={transcriptSearch} onChange={(event) => setTranscriptSearch(event.target.value)} placeholder="Search saved transcripts" className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-500" /></div>
                      <div className="max-h-20 space-y-1 overflow-y-auto">
                        {filteredTranscripts.map((item) => <button key={item.id} onClick={() => setInput(`Summarize the ${item.source} meeting and list the action items.`)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800"><span className="text-emerald-300">{item.source}</span> {item.text}</button>)}
                      </div>
                    </div>
                  )}
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
              onClick={() => { setSettingsOpen(true); void loadAgentActivity(); }}
              className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
              title="AI provider settings"
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

      {statusMessage && (
        <div className="mx-auto mt-3 w-full max-w-4xl rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200">
          {statusMessage}
        </div>
      )}

      {historyOpen && (
        <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-3 py-4 backdrop-blur-sm sm:px-4 sm:py-8" onMouseDown={() => setHistoryOpen(false)}>
          <div className="my-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-2xl sm:p-5" role="dialog" aria-modal="true" aria-label="Chat history" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Chat history</h2><p className="text-xs text-slate-400">Saved locally on this device</p></div><button onClick={() => setHistoryOpen(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"><X className="h-4 w-4" /></button></div>
            <div className="mb-3 flex gap-2"><button onClick={startNewChat} className="flex-1 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400">New chat</button><button onClick={copyConversation} disabled={!messages.length} className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:border-emerald-400 disabled:opacity-40">{copiedItem === 'conversation' ? 'Copied' : 'Copy chat'}</button></div>
            {chatHistory.length === 0 ? <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">Completed conversations appear here.</p> : <div className="max-h-80 space-y-2 overflow-y-auto">{chatHistory.map((session) => <button key={session.id} onClick={() => openHistorySession(session)} className="block w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-left hover:border-emerald-400"><span className="block truncate text-sm text-slate-200">{session.title}</span><span className="mt-1 block text-[11px] text-slate-500">{new Date(session.updatedAt).toLocaleString()}</span></button>)}</div>}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-3 py-4 backdrop-blur-sm sm:px-4 sm:py-8"
          role="presentation"
          onMouseDown={() => setSettingsOpen(false)}
        >
          <div
            className="my-auto max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-2xl sm:p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between">
              <div>
                <h2 id="settings-title" className="text-lg font-semibold">AI provider settings</h2>
                <p className="mt-1 text-xs text-slate-400">Choose a provider and connect its API key at runtime.</p>
              </div>
              <button onClick={() => setSettingsOpen(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <div className="mb-5 grid grid-cols-2 rounded-lg border border-slate-700 bg-slate-800 p-1">
              <button onClick={() => setSettingsTab('providers')} className={`rounded-md px-3 py-2 text-xs font-medium ${settingsTab === 'providers' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>AI Providers</button>
              <button onClick={() => setSettingsTab('permissions')} className={`rounded-md px-3 py-2 text-xs font-medium ${settingsTab === 'permissions' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}>Permissions</button>
            </div>
            {settingsTab === 'providers' && (
              <>
            <ConfiguredProvidersPanel
              providers={configuredProviders}
              providerLabel={providerLabel}
              providerEnabled={providerEnabled}
              providerSaving={providerSaving}
              onRefresh={() => void refreshConfiguredProviders()}
              onMove={(provider, direction) => void moveConfiguredProvider(provider, direction)}
              onToggle={(provider) => void updateConfiguredProviderState(provider, { enabled: !provider.enabled })}
              onRemove={(provider) => void deleteConfiguredProvider(provider)}
              onProviderLabelChange={setProviderLabel}
              onProviderEnabledChange={setProviderEnabled}
              onAdd={() => void saveConfiguredProvider()}
            />
            <label className="mb-2 block text-xs font-medium text-slate-300">Provider integrations</label>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(providerPresets).map(([id, preset]) => (
                <button key={id} onClick={() => chooseProvider(id as ProviderId)} className={`rounded-lg border px-2 py-2 text-left text-xs transition-colors ${providerId === id ? 'border-emerald-400 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500'}`}>
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="mb-2 block text-xs font-medium text-slate-300">API key</label>
            <input type="password" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder="Paste API key" autoComplete="off" className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400" />
            <label className="mb-2 block text-xs font-medium text-slate-300">Model</label>
            <input value={providerModel} onChange={(event) => setProviderModel(event.target.value)} placeholder="Model ID" className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400" />
            <label className="mb-2 block text-xs font-medium text-slate-300">Base URL</label>
            <input value={providerBaseURL} onChange={(event) => setProviderBaseURL(event.target.value)} placeholder="https://api.example.com/v1" className="mb-5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400" />
            <label className="mb-5 flex cursor-pointer items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5">
              <span><span className="block text-xs font-medium text-slate-200">Auto fallback</span><span className="block text-[11px] text-slate-500">Try another connected AI if quota or rate limit is reached</span></span>
              <input type="checkbox" checked={fallbackEnabled} onChange={(event) => setFallbackEnabled(event.target.checked)} className="h-4 w-4 accent-emerald-500" />
            </label>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] leading-relaxed text-slate-500">The key is sent to the local server and is not saved in browser storage.</p>
              <button onClick={saveProviderSettings} disabled={providerSaving} className="flex shrink-0 items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">{providerSaving && <Loader2 className="h-4 w-4 animate-spin" />} Connect</button>
            </div>
              </>
            )}
            {settingsTab === 'permissions' && (
              <div>
                <p className="text-sm font-medium text-slate-200">Desktop permissions</p>
                <p className="mb-3 mt-1 text-[11px] text-slate-500">Only allow-listed apps and valid browser URLs can open. Every action requires a local confirmation; delete, password, arbitrary-command, shutdown, and system-change actions are blocked.</p>
                <button onClick={enableAllAgentPermissions} disabled={agentSaving} className="mb-3 w-full rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">Enable all allowed controls</button>
                <div className="space-y-2">
                  {agentPermissionOptions.map(([permission, label, target]) => (
                    <div key={permission} className="flex items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
                      <span className="text-xs text-slate-200">{label}</span>
                      <div className="flex items-center gap-2">
                        <button onClick={() => void runAgentAction(target)} disabled={!agentPermissions[permission as keyof typeof agentPermissions]} className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-35">Open</button>
                        <input type="checkbox" checked={agentPermissions[permission as keyof typeof agentPermissions]} onChange={(event) => void saveAgentPermissions({ ...agentPermissions, [permission]: event.target.checked })} disabled={agentSaving} className="h-4 w-4 accent-emerald-500" />
                      </div>
                    </div>
                  ))}
                </div>
                <input value={agentUrl} onChange={(event) => setAgentUrl(event.target.value)} placeholder="https://example.com" className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-400" />
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">For Teams calls or messages, the agent can prepare a draft and open Teams, but it will not call or send without your confirmation.</p>
                <div className="mt-4 border-t border-slate-800 pt-3">
                  <div className="mb-2 flex items-center justify-between"><p className="text-xs font-medium text-slate-300">Recent agent activity</p><button onClick={() => void loadAgentActivity()} className="text-[11px] text-emerald-300 hover:text-emerald-200">Refresh</button></div>
                  {agentActivity.length === 0 ? <p className="text-[11px] text-slate-500">No actions requested in this server session.</p> : <div className="max-h-28 space-y-1 overflow-y-auto">{agentActivity.slice(0, 10).map((item) => <p key={item.id} className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400">{item.target} · {item.action} · {new Date(item.createdAt).toLocaleTimeString()}</p>)}</div>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <main className="mx-auto flex min-h-[calc(100dvh-57px)] w-full max-w-3xl flex-col px-4 py-6">
        {appMode === 'general' ? (
          <section className="m-auto flex w-full max-w-3xl flex-1 flex-col rounded-2xl border border-violet-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7">
            <div className="mb-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-300">General Agent Mode</p>
              <h2 className="mt-1 text-xl font-semibold">External task runtime</h2>
              <p className="mt-2 text-xs text-slate-500">Create a bounded task before browser tools are enabled. This runtime has its own session, task state, action limits, confirmation records, and login handoff status.</p>
            </div>
            {!generalTask && (
              <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">New task</p>
                <textarea
                  value={generalGoal}
                  onChange={(event) => setGeneralGoal(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void startGeneralTask(); } }}
                  placeholder="Example: Compare three JavaScript courses without purchasing anything."
                  rows={3}
                  className="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-400"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-500">No browser session or external action is created until this task starts.</p>
                  <button onClick={() => void startGeneralTask()} disabled={!generalGoal.trim() || generalBusy} className="rounded-md bg-violet-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-violet-400 disabled:opacity-40">{generalBusy ? 'Starting...' : 'Start task'}</button>
                </div>
              </div>
            )}
            {generalTask && (
              <div className="space-y-4">
                <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-200">Current task</p>
                      <p className="mt-1 text-sm text-slate-100">{generalTask.goal}</p>
                    </div>
                    <span className="shrink-0 rounded-full border border-violet-500/40 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-violet-200">{generalTask.phase}</span>
                  </div>
                  <p className="mt-3 rounded-lg border border-violet-500/20 bg-slate-950/40 px-3 py-2 text-xs text-violet-100">{generalTask.progressMessage}</p>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                    <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Risk</p><p className="mt-1 text-slate-200">{generalTask.riskLevel}</p></div>
                    <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Site</p><p className="mt-1 truncate text-slate-200">{generalTask.currentSite || 'Not selected'}</p></div>
                    <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Actions</p><p className="mt-1 text-slate-200">{generalTask.actionCount} / {generalTask.bounds.maxActions}</p></div>
                    <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Login</p><p className="mt-1 text-slate-200">{generalTask.authenticationState}</p></div>
                  </div>
                  <details className="mt-3 rounded-lg border border-slate-700 bg-slate-950/20 p-3">
                    <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-slate-400">Show parsed request details</summary>
                  {generalTask.categories.length > 0 && (
                    <div className="mt-3 rounded-lg border border-violet-500/20 bg-slate-950/40 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-300">Routed capabilities</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {generalTask.categories.map((category) => <span key={category} className="rounded-full border border-slate-700 px-2 py-1 text-[10px] text-slate-300">{category}</span>)}
                      </div>
                    </div>
                  )}
                  {generalTask.structuredRequirements && (
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                      <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Route</p><p className="mt-1 text-slate-200">{generalTask.structuredRequirements.origin || 'Unknown'} → {generalTask.structuredRequirements.destination || 'Unknown'}</p></div>
                      <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Travel date</p><p className="mt-1 text-slate-200">{generalTask.structuredRequirements.travelDate || 'Not specified'}</p></div>
                      <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Objective</p><p className="mt-1 text-slate-200">{generalTask.structuredRequirements.resultCount || 0} options · {generalTask.structuredRequirements.optimization}</p></div>
                      <div className="rounded-lg bg-slate-950/50 p-2"><p className="text-slate-500">Policy</p><p className="mt-1 text-slate-200">{generalTask.structuredRequirements.executionPolicy} · Booking/payment blocked</p></div>
                    </div>
                  )}
                  <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/40 p-2 text-[10px]">
                    <p className="font-semibold uppercase tracking-wider text-slate-500">Runtime trace</p>
                    <p className="mt-1 text-slate-400">{generalTask.trace.phase} · {generalTask.trace.intent || 'PENDING'} · {generalTask.trace.capability || 'UNROUTED'} · {generalTask.trace.provider || 'NO_PROVIDER'}</p>
                    <p className="mt-1 text-slate-500">Node: {generalTask.trace.currentNode || 'NONE'} · Action: {generalTask.trace.action || 'NONE'} · Confirmation: {generalTask.trace.confirmationState} · Verification: {generalTask.trace.verificationState}</p>
                  </div>
                  </details>
                  {generalTask.missingInformation.length > 0 && (
                    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-200">Information needed before preparation</p>
                      <div className="mt-2 space-y-1 text-[11px] text-amber-100">
                        {generalTask.missingInformation.map((item) => <p key={item.id}><span className="font-medium">{item.prompt}</span> <span className="text-amber-200/70">({item.reason})</span></p>)}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <input value={generalClarification} onChange={(event) => setGeneralClarification(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void reviseGeneralTask(); } }} placeholder="Add the missing detail..." className="min-w-0 flex-1 rounded-md border border-amber-500/30 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-300" />
                        <button onClick={() => void reviseGeneralTask()} disabled={!generalClarification.trim() || generalBusy} className="rounded-md border border-amber-400/50 px-2 py-1.5 text-[11px] text-amber-100 disabled:opacity-40">Update plan</button>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <input value={generalFollowUp} onChange={(event) => setGeneralFollowUp(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void reviseGeneralTask(); } }} placeholder="Refine the task, e.g. prefer AC sleeper buses" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400" />
                    <button onClick={() => void reviseGeneralTask()} disabled={!generalFollowUp.trim() || generalBusy} className="rounded-md border border-violet-400/50 px-3 py-2 text-[11px] text-violet-100 disabled:opacity-40">Send</button>
                  </div>
                  <details className="mt-3 rounded-lg border border-slate-700 bg-slate-950/20 p-3">
                    <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-slate-400">Show browser and execution details</summary>
                  {generalTask.plan && (
                    <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/30 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Task graph</p>
                        <span className="text-[10px] text-slate-500">{generalTask.planningStatus}</span>
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {generalTask.plan.taskGraph.nodes.map((node) => <div key={node.id} className="flex items-center gap-2 text-[11px]"><span className={`h-1.5 w-1.5 rounded-full ${node.status === 'READY' ? 'bg-emerald-400' : node.status === 'BLOCKED' ? 'bg-amber-400' : 'bg-slate-600'}`} /><span className="text-slate-300">{node.title}</span><span className="ml-auto text-[10px] text-slate-600">{node.status}</span></div>)}
                      </div>
                    </div>
                  )}
                  <div className="mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-300">Isolated browser</p>
                      <span className="text-[10px] text-slate-500">{generalTask.browserSessionId ? 'Session active' : 'No session'}</span>
                    </div>
                    {!generalTask.browserSessionId ? (
                      <button onClick={() => void createGeneralBrowserSession()} disabled={generalBusy} className="mt-2 rounded-md border border-sky-400/40 px-2.5 py-1.5 text-[11px] text-sky-100 disabled:opacity-40">Create browser session</button>
                    ) : (
                      <>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <input value={generalBrowserUrl} onChange={(event) => setGeneralBrowserUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void performGeneralBrowserOperation('navigate', { url: generalBrowserUrl }); } }} placeholder="https://example.com" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-sky-300" />
                          <button onClick={() => void performGeneralBrowserOperation('navigate', { url: generalBrowserUrl })} disabled={!generalBrowserUrl.trim() || generalBusy} className="rounded-md border border-sky-400/40 px-2.5 py-1.5 text-[11px] text-sky-100 disabled:opacity-40">Navigate</button>
                          <button onClick={() => void performGeneralBrowserOperation('observe')} disabled={generalBusy} className="rounded-md border border-slate-600 px-2.5 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Observe</button>
                        </div>
                        {generalTask.lastObservation && (
                          <div className="mt-3 rounded-md border border-slate-700 bg-slate-950/60 p-2 text-[11px]">
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-400">
                              <span>{String(generalTask.lastObservation.title || 'Untitled page')}</span>
                              <span>v{String(generalTask.lastObservation.version || generalTask.observationVersion)}</span>
                              <span>Login: {String(generalTask.lastObservation.loginState || 'UNKNOWN')}</span>
                              <span>Page: {String(generalTask.lastObservation.pageState || 'UNKNOWN')}</span>
                            </div>
                            <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-slate-300">{String(generalTask.lastObservation.text || 'No visible text returned.')}</p>
                            {Boolean(generalTask.lastObservation.errorState) && <p className="mt-2 text-amber-200">Intervention required: {String((generalTask.lastObservation.errorState as Record<string, unknown>).message || 'The page reported an error.')}</p>}
                            {generalTask.lastObservation.loginState === 'LOGIN_REQUIRED' && <button onClick={() => void performGeneralBrowserOperation('takeover')} disabled={generalBusy} className="mt-2 rounded-md border border-amber-400/50 px-2.5 py-1.5 text-[11px] text-amber-100 disabled:opacity-40">Open for user takeover</button>}
                            {Array.isArray(generalTask.lastObservation.interactiveElements) && generalTask.lastObservation.interactiveElements.length > 0 && (
                              <p className="mt-2 text-slate-500">Interactive elements: {generalTask.lastObservation.interactiveElements.slice(0, 12).map((element) => {
                                const item = element as Record<string, unknown>;
                                return String(item.label || item.id || 'unnamed');
                              }).join(' · ')}</p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {generalTask.pendingAction && (
                    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-100">
                      <p>Pending {generalTask.pendingAction.tool} · {generalTask.pendingAction.riskLevel}</p>
                      {generalTask.confirmationId && <p className="mt-1">Waiting for a confirmation bound to this task and action.</p>}
                    </div>
                  )}
                  {generalTask.executionActionId && (
                    <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold uppercase tracking-wider text-emerald-300">Prepared action</p>
                        <button onClick={() => void refreshGeneralExecutionAction()} disabled={generalBusy} className="text-slate-400 hover:text-slate-200 disabled:opacity-40">Refresh</button>
                      </div>
                      {generalExecutionAction ? (
                        <>
                          <p className="mt-2 text-slate-200">{generalExecutionAction.capability} · {generalExecutionAction.provider} · {generalExecutionAction.operation}</p>
                          <p className="mt-1 text-slate-400">Target: {typeof generalExecutionAction.target === 'string' ? generalExecutionAction.target : JSON.stringify(generalExecutionAction.target)}</p>
                          <p className="mt-1 text-slate-400">State: {generalExecutionAction.state} · Risk: {generalExecutionAction.riskLevel}</p>
                          <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-slate-950/70 p-2 text-[10px] text-slate-500">{JSON.stringify(generalExecutionAction.arguments, null, 2)}</pre>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {generalExecutionAction.state === 'PLANNED' && <button onClick={() => void validateGeneralExecutionAction()} disabled={generalBusy} className="rounded border border-slate-600 px-2 py-1 text-slate-300 disabled:opacity-40">Validate</button>}
                            {generalExecutionAction.state === 'WAITING_FOR_CONFIRMATION' && <button onClick={() => void requestGeneralExecutionConfirmation()} disabled={generalBusy} className="rounded border border-amber-400/50 px-2 py-1 text-amber-100 disabled:opacity-40">Show confirmation</button>}
                            {generalExecutionAction.state === 'EXECUTING' && <button onClick={() => void runGeneralExecutionStep('execute')} disabled={generalBusy} className="rounded border border-amber-400/50 px-2 py-1 text-amber-100 disabled:opacity-40">Execute</button>}
                            {generalExecutionAction.state === 'OBSERVING' && <button onClick={() => void runGeneralExecutionStep('observe')} disabled={generalBusy} className="rounded border border-sky-400/50 px-2 py-1 text-sky-100 disabled:opacity-40">Observe result</button>}
                            {generalExecutionAction.state === 'VERIFYING' && (
                              <>
                                <input value={generalVerificationEvidence} onChange={(event) => setGeneralVerificationEvidence(event.target.value)} placeholder="Verification evidence (optional)" className="min-w-[180px] flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] text-slate-200 outline-none" />
                                <button onClick={() => void runGeneralExecutionStep('verify')} disabled={generalBusy} className="rounded border border-emerald-400/50 px-2 py-1 text-emerald-100 disabled:opacity-40">Verify</button>
                              </>
                            )}
                            {['FAILED', 'BLOCKED'].includes(generalExecutionAction.state) && <button onClick={() => void runGeneralExecutionStep('recover')} disabled={generalBusy} className="rounded border border-amber-400/50 px-2 py-1 text-amber-100 disabled:opacity-40">Recover</button>}
                          </div>
                          {generalConfirmation && (
                            <div className="mt-3 rounded border border-amber-400/40 bg-amber-500/10 p-2 text-amber-100">
                              <p className="font-medium">Confirmation required</p>
                              <p className="mt-1">{String(generalConfirmation.summary || 'Review this action before it runs.')}</p>
                              <button onClick={() => void confirmGeneralExecutionAction()} disabled={generalBusy} className="mt-2 rounded border border-amber-300/60 px-2 py-1 text-amber-50 disabled:opacity-40">Confirm action</button>
                            </div>
                          )}
                          {generalExecutionAction.failure && <p className="mt-2 text-rose-200">Failure: {String(generalExecutionAction.failure.message || generalExecutionAction.failure.classification || 'Execution failed.')}</p>}
                          {generalExecutionAction.verification && <p className="mt-2 text-emerald-200">Verification evidence recorded.</p>}
                        </>
                      ) : <p className="mt-2 text-slate-500">Load the current action to review its lifecycle.</p>}
                    </div>
                  )}
                  </details>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {!['COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(generalTask.phase) && <button onClick={() => void toggleGeneralPause()} disabled={generalBusy} className="rounded-md border border-slate-600 px-3 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">{generalTask.paused ? 'Resume' : 'Pause'}</button>}
                    {!['COMPLETED', 'CANCELLED'].includes(generalTask.phase) && <button onClick={() => void stopGeneralTask()} disabled={generalBusy} className="rounded-md border border-rose-400/50 px-3 py-1.5 text-[11px] text-rose-200 disabled:opacity-40">Stop Agent</button>}
                    {!generalTaskActive && <button onClick={() => { setGeneralTask(null); setGeneralExecutionAction(null); setGeneralConfirmation(null); setGeneralVerificationEvidence(''); setGeneralClarification(''); setGeneralFollowUp(''); }} disabled={generalBusy} className="rounded-md border border-slate-600 px-3 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">New task</button>}
                  </div>
                </div>
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Runtime boundary</p>
                  <ul className="mt-3 space-y-2 text-sm text-slate-300">
                    <li>• General state is separate from Assistant audio/STT state.</li>
                    <li>• Developer project, proposal, approval, and filesystem state are not available here.</li>
                    <li>• Browser tools will use structured actions, bounded sessions, and confirmation before external effects.</li>
                  </ul>
                </div>
              </div>
            )}
          </section>
        ) : appMode === 'developer' ? (
          <section className="m-auto flex w-full max-w-3xl flex-1 flex-col rounded-2xl border border-sky-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7">
            <div className="mb-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">Developer Mode</p>
              <h2 className="mt-1 text-xl font-semibold">Coding assistant</h2>
              <p className="mt-2 text-xs text-slate-500">Read and search are automatic. Source writes happen only through a validated proposal after you explicitly approve it; verification uses allow-listed project scripts.</p>
            </div>
            <div className="mb-5 rounded-xl border border-slate-700 bg-slate-800/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Project</p>
                  <p className="truncate text-xs text-slate-300">{developerProjectRoot || 'No project folder selected'}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button onClick={() => void chooseDeveloperProject()} disabled={developerBusy || developerStreaming} className="rounded-md border border-sky-500/50 px-2 py-1.5 text-[11px] text-sky-300 disabled:opacity-40">Select folder</button>
                  {developerProjectRoot && <button onClick={() => void clearDeveloperProject()} disabled={developerBusy || developerStreaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Clear</button>}
                </div>
              </div>
              {developerProjectRoot && <div className="mt-3 space-y-2">
                <div className="flex gap-2">
                  <input value={developerPath} onChange={(event) => setDeveloperPath(event.target.value)} placeholder="Relative path (.)" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
                  <button onClick={() => void listDeveloperDirectory()} disabled={developerBusy || developerStreaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">List</button>
                  <button onClick={() => void readDeveloperFile()} disabled={developerBusy || developerStreaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Read file</button>
                </div>
                {developerDirectory.length > 0 && <div className="max-h-32 overflow-y-auto rounded-md border border-slate-700 bg-slate-950 p-2">{developerDirectory.map((entry) => <button key={`${entry.type}-${entry.name}`} onClick={() => setDeveloperPath(developerPath === '.' ? entry.name : `${developerPath.replace(/[\\/]+$/, '')}/${entry.name}`)} className="block w-full truncate px-1 py-1 text-left text-[11px] text-slate-300 hover:text-sky-300">{entry.type === 'directory' ? '📁' : '📄'} {entry.name}</button>)}</div>}
                {developerFilePath && <pre className="max-h-48 overflow-auto rounded-md border border-slate-700 bg-slate-950 p-2 text-[11px] leading-relaxed text-slate-300">{developerFileContent}</pre>}
                <div className="border-t border-slate-700 pt-2">
                  <div className="flex gap-2">
                    <input value={developerSearchQuery} onChange={(event) => setDeveloperSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchDeveloperCode(); } }} placeholder="Search filenames and code..." className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
                    <button onClick={() => void searchDeveloperCode()} disabled={developerBusy || developerStreaming || !developerSearchQuery.trim()} className="rounded-md border border-sky-500/50 px-2 py-1.5 text-[11px] text-sky-300 disabled:opacity-40">Search</button>
                  </div>
                  {developerSearchResults.length > 0 && <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-slate-700 bg-slate-950 p-2">{developerSearchResults.map((result, index) => <button key={`${result.path}-${result.line}-${index}`} onClick={() => { setDeveloperPath(result.path); if (result.line > 0) void readDeveloperFile(result.path); }} className="block w-full truncate px-1 py-1 text-left text-[11px] text-slate-300 hover:text-sky-300">{result.path}{result.line > 0 ? `:${result.line}` : ''} · {result.text}</button>)}</div>}
                </div>
                <div className="border-t border-slate-700 pt-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Proposal-only code changes</p>
                  <p className="mb-2 text-[11px] leading-relaxed text-slate-500">Search and read context is captured twice before the assistant proposes a minimal patch. Nothing is written to disk.</p>
                  <input
                    value={developerProposalSearchQuery}
                    onChange={(event) => setDeveloperProposalSearchQuery(event.target.value)}
                    placeholder="Search query for relevant files"
                    className="mb-2 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400"
                  />
                  <textarea
                    value={developerChangeRequest}
                    onChange={(event) => setDeveloperChangeRequest(event.target.value)}
                    placeholder="Describe the code change to propose..."
                    rows={3}
                    className="w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400"
                  />
                  <button
                    onClick={() => void generateDeveloperProposal()}
                    disabled={developerBusy || developerStreaming || !developerProposalSearchQuery.trim() || !developerChangeRequest.trim()}
                    className="mt-2 rounded-md border border-amber-500/50 px-2 py-1.5 text-[11px] text-amber-200 disabled:opacity-40"
                  >
                    {developerBusy ? 'Preparing proposal...' : 'Generate proposal'}
                  </button>
                </div>
              </div>}
            </div>
            {developerProposal && (
              <section className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-200">Proposed diff</p>
                    <p className="mt-1 text-[11px] text-slate-400">State: {developerProposal.lifecycleState || developerProposal.state || 'pending'} · main process validates every file before writing.</p>
                    {developerProposal.runtime && (
                      <p className="mt-1 text-[10px] text-emerald-300">Task phase: {developerProposal.runtime.phase || developerProposal.runtime.taskState || 'CREATED'} · plan v{developerProposal.runtime.planVersion || 1}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {developerProposal.state === 'awaiting_approval' && <button onClick={() => void approveDeveloperProposal()} disabled={developerBusy} className="rounded-md bg-amber-400 px-2 py-1 text-[11px] font-medium text-slate-950 disabled:opacity-40">Approve</button>}
                    {developerProposal.state === 'approved' && <button onClick={() => void applyDeveloperProposal()} disabled={developerBusy} className="rounded-md bg-emerald-400 px-2 py-1 text-[11px] font-medium text-slate-950 disabled:opacity-40">Apply and verify</button>}
                    {developerProposal.state === 'completed' && <button onClick={() => void undoDeveloperProposal()} disabled={developerBusy} className="rounded-md border border-rose-400/60 px-2 py-1 text-[11px] text-rose-200 disabled:opacity-40">Undo</button>}
                    <button onClick={() => setDeveloperProposal(null)} className="text-[11px] text-slate-400 hover:text-slate-200">Discard</button>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">Re-read files: {developerProposal.searchedFiles.join(', ')}</p>
                {developerProposal.files.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {developerProposal.files.map((file) => (
                      <div key={file.path} className="overflow-hidden rounded-md border border-slate-700 bg-slate-950">
                        <p className="border-b border-slate-700 px-2 py-1.5 text-xs font-medium text-slate-200">{file.path}</p>
                        <pre className="max-h-80 overflow-auto p-2 text-[11px] leading-relaxed text-slate-300">{file.lines.map((line, index) => <span key={`${file.path}-${index}`} className={`block ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-emerald-500/10 text-emerald-200' : line.startsWith('-') && !line.startsWith('---') ? 'bg-rose-500/10 text-rose-200' : 'text-slate-400'}`}>{line || ' '}</span>)}</pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <pre className="mt-3 overflow-auto rounded-md border border-slate-700 bg-slate-950 p-2 text-[11px] text-slate-300">{developerProposal.raw || 'No safe changes proposed.'}</pre>
                )}
                {developerProposal.verification && (
                  <div className={`mt-3 rounded-md border p-2 text-[11px] ${developerProposal.verification.status === 'PASS' || developerProposal.verification.status === 'NOT_AVAILABLE' ? 'border-emerald-500/30 text-emerald-200' : 'border-rose-500/30 text-rose-200'}`}>
                    <p>Verification: {developerProposal.verification.status || 'UNKNOWN'}</p>
                    {developerProposal.verification.reason && <p className="mt-1 text-slate-400">{developerProposal.verification.reason}</p>}
                    {developerProposal.verification.attempts?.filter((attempt) => !attempt.ok).map((attempt, index) => (
                      <p key={`${attempt.check || 'check'}-${index}`} className="mt-1 text-rose-200">
                        {attempt.check || 'check'}: {attempt.classification || 'failed'}{attempt.extracted?.file ? ` · ${attempt.extracted.file}${attempt.extracted.line ? `:${attempt.extracted.line}` : ''}` : ''}
                      </p>
                    ))}
                  </div>
                )}
                {developerProposal.error && <p className="mt-2 text-[11px] text-rose-300">{developerProposal.error}</p>}
              </section>
            )}
            <div className="flex-1 space-y-4 overflow-y-auto">
              {developerMessages.length === 0 && <p className="rounded-lg border border-dashed border-slate-700 p-5 text-center text-sm text-slate-500">Ask a coding question to get started.</p>}
              {developerMessages.map((message, index) => (
                <article key={message.requestId || `${message.role}-${index}`} className={`rounded-xl border p-4 ${message.role === 'user' ? 'border-slate-700 bg-slate-800/60' : 'border-sky-500/20 bg-slate-950/60'}`}>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{message.role === 'user' ? 'You' : 'Developer assistant'}</p>
                  {message.role === 'assistant' ? <div className="text-sm leading-relaxed text-slate-100">{renderAnswerMarkdown(message.content || (message.streaming ? 'Thinking...' : 'No answer yet.'))}</div> : <p className="whitespace-pre-wrap text-sm text-slate-200">{message.content}</p>}
                </article>
              ))}
            </div>
            <div className="mt-5 flex gap-2">
              <input value={developerInput} onChange={(event) => setDeveloperInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendDeveloperMessage(); } }} placeholder="Ask a coding question..." className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-sky-400" />
              <button onClick={() => void sendDeveloperMessage()} disabled={!developerInput.trim() || developerStreaming || developerBusy} className="rounded-lg bg-sky-500 px-4 text-sm font-medium text-slate-950 disabled:opacity-40">Send</button>
            </div>
            {developerMessages.length > 0 && <button onClick={() => { setDeveloperMessages([]); setDeveloperInput(''); }} className="mt-3 self-start text-xs text-slate-400 hover:text-slate-200">Clear developer conversation</button>}
          </section>
        ) : !sessionActive ? (
          <section className="m-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/80 p-6 shadow-2xl">
            <div className="mb-6 text-center"><h2 className="text-2xl font-semibold">Meeting AI Assistant</h2><p className="mt-2 text-sm text-slate-400">Listen to internal system audio and get concise answers.</p></div>
            <div className="space-y-4">
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">Audio source<select defaultValue="system" aria-label="Audio source" className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200"><option value="system">System / Internal Audio</option></select></label>
              <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm"><div className="flex justify-between"><span className="text-slate-400">Device</span><span className="max-w-[12rem] truncate text-slate-200">{audioSourceLabel}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Audio status</span><span className="text-emerald-300">● {audioStatus === 'testing' ? 'Testing' : audioStatus === 'connected' ? 'Connected' : 'Ready'}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Microphone</span><span className="font-semibold text-emerald-300">OFF</span></div><div className="mt-3"><div className="mb-1 flex justify-between text-[11px] text-slate-500"><span>System audio level</span><span>{audioLevel}%</span></div><div className="flex h-2 gap-1">{Array.from({ length: 10 }, (_, index) => <span key={index} className={`flex-1 rounded ${audioLevel >= (index + 1) * 10 ? 'bg-emerald-400' : 'bg-slate-700'}`} />)}</div></div></div>
              <p className="text-center text-[11px] text-slate-500">SYSTEM AUDIO ONLY · Physical microphone is never requested.</p>
              <div className="flex gap-2"><button onClick={() => void testSystemAudio()} className="flex-1 rounded-lg border border-emerald-500/40 px-3 py-2.5 text-sm text-emerald-300 hover:bg-emerald-500/10">Test Audio</button><button onClick={() => void startMeetingCapture()} className="flex-1 rounded-lg bg-emerald-500 px-3 py-2.5 text-sm font-medium text-slate-950 hover:bg-emerald-400">Start Listening</button></div>
              {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-relaxed text-rose-300"><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
            </div>
          </section>
        ) : (
          <section className="flex flex-1 flex-col">
            {meetingMenuOpen && <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900 p-4 text-xs"><div className="flex justify-between"><span className="text-slate-400">Audio source</span><span>System / Internal Audio</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Device</span><span className="max-w-[14rem] truncate">{audioSourceLabel}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Microphone</span><span className="text-emerald-300">OFF</span></div><button onClick={stopMeetingCapture} className="mt-3 rounded-lg border border-slate-600 px-3 py-2 text-slate-300 hover:border-rose-400">Stop Listening</button></div>}
            <div className="mb-5 text-center"><p className={`text-sm font-medium ${statusTone}`}>● {statusLabel}</p><p className="mt-2 text-xs text-slate-500">{pipelineStatus === 'listening' ? 'Listening for a question' : pipelineStatus === 'thinking' ? 'Generating answer...' : 'Your answer will appear below'}</p></div>
            <div className="mb-4"><p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-500">Last heard</p><p className="truncate text-sm text-slate-300">{liveTranscript || 'Waiting for speech...'}</p></div>
            <AnswerSessionView lastQuestion={lastQuestion} lastAnswer={lastAnswer} isThinking={pipelineStatus === 'thinking'} answeredSegments={answeredSegments} />
            <div className="mt-4 flex items-center justify-between"><button onClick={() => setTranscriptOpen((open) => !open)} className="text-xs text-emerald-300 hover:text-emerald-200">{transcriptOpen ? 'Hide full transcript' : 'View full transcript'}</button><button onClick={stopMeetingCapture} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-rose-400">Stop Listening</button></div>
            {transcriptOpen && <div className="mt-3 max-h-48 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm leading-relaxed text-slate-300">{liveTranscript || 'No transcript captured yet.'}</div>}
            {error && <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
            <div className="mt-5 flex gap-2"><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Ask a text question..." className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400" /><button onClick={() => void sendMessage()} disabled={!input.trim() || chatStreaming} className="rounded-lg bg-emerald-500 px-4 text-sm font-medium text-slate-950 disabled:opacity-40">Send</button></div>
          </section>
        )}
      </main>

      {/* Main content */}
      <div className="hidden mx-auto flex min-h-[calc(100dvh-73px)] max-w-4xl min-w-0 flex-col px-3 py-4 sm:px-4 sm:py-6">
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
              <p className="text-sm font-medium text-slate-200">{mode === 'direct' ? 'Direct mode: profile and PDF context are ignored' : 'LangChain mode: profile and session docs are included'}</p>
            </div>
            {mode === 'direct' && (sessionDocuments.length > 0 || !!activeProfile) && (
              <div className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-200">
                Context unavailable
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
              onClick={clearSessionContext}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Clear session documents
            </button>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-3 flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2.5 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Chat messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-1">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-400/20 to-teal-500/20 flex items-center justify-center mb-4">
                <Bot className="w-8 h-8 text-emerald-400" />
              </div>
              <h2 className="text-xl font-semibold mb-2">Ask me anything</h2>
              <p className="text-slate-400 max-w-md">
                Upload a PDF and ask questions about it, or just start chatting.
                Responses stream in real-time via WebSocket.
              </p>
              <div className="mt-6 flex gap-2">
                <button
                  onClick={() => setInput('Summarize the key points of a good code review process.')}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-300 transition-colors"
                >
                  Code review tips
                </button>
                <button
                  onClick={() => setInput('Explain how WebSocket streaming works in simple terms.')}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-300 transition-colors"
                >
                  How WebSocket works
                </button>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-5 h-5 text-slate-900" />
                </div>
              )}
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                  msg.role === 'user'
                    ? 'bg-emerald-600 text-white rounded-tr-sm'
                    : 'bg-slate-800 text-slate-100 rounded-tl-sm border border-slate-700'
                }`}
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {msg.content || (msg.streaming ? '' : '(empty)')}
                  {msg.streaming && !msg.content && (
                    <span className="inline-flex gap-1 ml-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </span>
                  )}
                  {msg.streaming && msg.content && (
                    <span className="inline-block w-1.5 h-4 bg-emerald-400 ml-0.5 animate-pulse align-middle" />
                  )}
                </p>
                <button onClick={() => void copyText(msg.content, `message-${i}`)} disabled={!msg.content} className={`mt-2 flex items-center gap-1 text-[11px] ${msg.role === 'user' ? 'text-emerald-100/80 hover:text-white' : 'text-slate-400 hover:text-emerald-300'} disabled:opacity-40`} title="Copy message"><Copy className="h-3 w-3" />{copiedItem === `message-${i}` ? 'Copied' : 'Copy'}</button>
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center flex-shrink-0">
                  <User className="w-5 h-5 text-slate-300" />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Input bar */}
        <div className="mt-4 flex gap-2 items-end">
          <button
            onClick={clearChat}
            className="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors flex-shrink-0"
            title="Clear chat"
          >
            <Trash2 className="w-5 h-5" />
          </button>
          <div className="flex-1 flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
              rows={1}
              className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 resize-none transition-all"
              style={{ maxHeight: '120px' }}
            />
            <button
              onClick={() => void improveDraft()}
              disabled={!input.trim() || draftImproving || chatStreaming}
              className="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              title="Improve draft with AI"
            >
              {draftImproving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
            </button>
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || chatStreaming || draftImproving}
              className="p-3 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-slate-900 hover:from-emerald-400 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0 shadow-lg shadow-emerald-500/20"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;