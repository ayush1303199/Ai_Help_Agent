import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Copy,
  FileText,
  History,
  Link as LinkIcon,
  Loader2,
  Mic,
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

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

type Mode = 'direct' | 'langchain';

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

interface SpeechRecognitionResultLike extends ArrayLike<{ transcript: string }> {
  isFinal: boolean;
}

interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: SpeechRecognitionResultEvent) => void;
  onerror: (event: { error?: string }) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const meetingSources = [
  { name: 'Zoom', color: 'bg-blue-500', note: 'Use microphone capture' },
  { name: 'Google Meet', color: 'bg-emerald-500', note: 'Use microphone capture' },
  { name: 'Teams', color: 'bg-indigo-500', note: 'Use microphone capture' },
  { name: 'Webex', color: 'bg-cyan-500', note: 'Use microphone capture' },
  { name: 'CoderPad', color: 'bg-orange-500', note: 'Use microphone capture' },
  { name: 'More', color: 'bg-slate-600', note: 'Choose a meeting source' },
];

const HTTP_URL = 'http://localhost:3001';
const WS_URL = 'ws://localhost:3002';
const MAX_CHAT_HISTORY_MESSAGES = 8;
const MAX_CHAT_MESSAGE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 9000;
// A short pause feels natural in a conversation while avoiding a long delay
// before the live assistant can start answering.
const BROWSER_VOICE_SILENCE_MS = 1800;
const ELECTRON_VOICE_SILENCE_MS = 1800;
const PDF_UPLOAD_TIMEOUT_MS = 20000;
const AI_SYSTEM_PROMPT =
  'You are a concise AI software-engineering assistant. Use only the project context, code, documents, and conversation supplied by the user. ' +
  'Do not claim to access files, repositories, services, credentials, or test results that were not provided. ' +
  'When enough context is supplied, answer directly; otherwise ask for the smallest useful missing detail. ' +
  'For general conversation, respond naturally and briefly.';

function compactMessageContent(content: string) {
  if (content.length <= MAX_CHAT_MESSAGE_CHARS) return content;
  return `${content.slice(0, MAX_CHAT_MESSAGE_CHARS)}\n[Earlier content omitted for speed]`;
}

function chatTitle(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim() || 'New conversation';
  return firstUserMessage.length > 52 ? `${firstUserMessage.slice(0, 52)}…` : firstUserMessage;
}

function isVoiceAssistantRequest(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  if (/^(ok|okay|thanks?|thank you|welcome|yes|yeah|yep|no|nope|bye|goodbye|hi|hello|hey|um|uh|hmm)[?]?$/.test(normalized)) return false;

  // A completed spoken sentence is intentional input, even without a question word.
  return normalized.split(' ').length >= 2;
}

function voiceSafeText(text: string) {
  return text
    .replace(/(^|\s)(thank you|thanks|you're welcome|you are welcome)[.!]?($|\s)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const providerPresets = {
  groq: { label: 'Groq', model: 'openai/gpt-oss-20b', baseURL: 'https://api.groq.com/openai/v1' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
  anthropic: { label: 'Claude (Anthropic)', model: 'claude-3-5-haiku-latest', baseURL: 'https://api.anthropic.com/v1' },
  deepseek: { label: 'DeepSeek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' },
  openrouter: { label: 'OpenRouter', model: 'openai/gpt-4o-mini', baseURL: 'https://openrouter.ai/api/v1' },
  llama: { label: 'Llama / Together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', baseURL: 'https://api.together.xyz/v1' },
  mistral: { label: 'Mistral', model: 'mistral-small-latest', baseURL: 'https://api.mistral.ai/v1' },
  gemini: { label: 'Gemini gateway', model: 'gemini-2.0-flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  xai: { label: 'xAI Grok', model: 'grok-3-mini', baseURL: 'https://api.x.ai/v1' },
  perplexity: { label: 'Perplexity', model: 'sonar', baseURL: 'https://api.perplexity.ai' },
  fireworks: { label: 'Fireworks', model: 'accounts/fireworks/models/llama-v3p1-8b-instruct', baseURL: 'https://api.fireworks.ai/inference/v1' },
  cerebras: { label: 'Cerebras', model: 'llama-3.3-70b', baseURL: 'https://api.cerebras.ai/v1' },
  cohere: { label: 'Cohere', model: 'command-r7b-12-2024', baseURL: 'https://api.cohere.com/compatibility/v1' },
  custom: { label: 'Custom OpenAI-compatible', model: '', baseURL: '' },
} as const;
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
  const [activeChatId, setActiveChatId] = useState(() => crypto.randomUUID());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedItem, setCopiedItem] = useState('');
  const [chatStreaming, setChatStreaming] = useState(false);
  const [draftImproving, setDraftImproving] = useState(false);
  const [mode, setMode] = useState<Mode>('direct');
  const [pdfText, setPdfText] = useState('');
  const [pdfName, setPdfName] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState<{ provider: string; model: string } | null>(null);
  const [meetingSource, setMeetingSource] = useState('Zoom');
  const [meetingMenuOpen, setMeetingMenuOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isLiveAnswering, setIsLiveAnswering] = useState(false);
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const liveAnsweringRef = useRef(false);
  const liveQuestionRef = useRef('');
  const voiceBufferRef = useRef('');
  const streamBufferRef = useRef('');
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRequestInFlightRef = useRef(false);
  const lastLiveQuestionRef = useRef('');
  const realtimeUploadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const realtimeAnswerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const electronTranscriptionBusyRef = useRef(false);
  const electronPendingSegmentsRef = useRef<Blob[]>([]);
  const electronSilenceMonitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const electronAudioContextRef = useRef<AudioContext | null>(null);
  const chatRequestIdRef = useRef('');
  const draftImproveRequestIdRef = useRef('');

  // --- Auto-scroll to bottom on new content ---
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const flushStreamBuffer = useCallback(() => {
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
  }, []);

  useEffect(() => () => {
    if (streamFlushTimerRef.current) clearTimeout(streamFlushTimerRef.current);
  }, []);

  useEffect(() => {
    localStorage.setItem('meeting-transcripts', JSON.stringify(transcripts));
  }, [transcripts]);

  useEffect(() => {
    localStorage.setItem('chat-history', JSON.stringify(chatHistory));
  }, [chatHistory]);

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

  const handleWsMessage = useCallback((data: string) => {
    const msg = JSON.parse(data);
    const isDraftImprove = msg.requestId && msg.requestId === draftImproveRequestIdRef.current;
    const isCurrentChat = msg.requestId && msg.requestId === chatRequestIdRef.current;

    if (!isDraftImprove && !isCurrentChat) return;

    if (msg.type === 'token') {
      if (isDraftImprove) return;
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
      streamBufferRef.current += msg.content;
      if (!streamFlushTimerRef.current) {
        // Keep React updates batched without adding a visible delay after the
        // server has already batched the provider's token chunks.
        streamFlushTimerRef.current = setTimeout(flushStreamBuffer, 16);
      }
    } else if (msg.type === 'done') {
      if (isDraftImprove) {
        setInput(String(msg.content || '').trim());
        setDraftImproving(false);
        draftImproveRequestIdRef.current = '';
        return;
      }
      flushStreamBuffer();
      liveRequestInFlightRef.current = false;
      setChatStreaming(false);
      chatRequestIdRef.current = '';
      if (voiceReplies && typeof window !== 'undefined' && 'speechSynthesis' in window && msg.content) {
        if (voiceBufferRef.current.trim()) {
          const speakableText = voiceSafeText(voiceBufferRef.current);
          if (speakableText) window.speechSynthesis.speak(new SpeechSynthesisUtterance(speakableText));
        }
        voiceBufferRef.current = '';
      }
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          last.streaming = false;
        }
        return [...next];
      });
    } else if (msg.type === 'error') {
      if (isDraftImprove) {
        setDraftImproving(false);
        draftImproveRequestIdRef.current = '';
        setError(msg.message);
        return;
      }
      flushStreamBuffer();
      liveRequestInFlightRef.current = false;
      setChatStreaming(false);
      chatRequestIdRef.current = '';
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant' && last.streaming) {
          last.content = `Error: ${msg.message}`;
          last.streaming = false;
        }
        return [...next];
      });
      setError(msg.message);
    }
  }, [flushStreamBuffer, voiceReplies]);

  // --- Send a chat message ---
  const sendMessage = async (question = input.trim(), contextOverride?: string, modelInstruction = question) => {
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

    const userMsg: Message = { role: 'user', content: question };
    const assistantMsg: Message = { role: 'assistant', content: '', streaming: true };
    const requestId = crypto.randomUUID();

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setError('');
    setChatStreaming(true);
    chatRequestIdRef.current = requestId;

    try {
      const ws = await ensureWs();
      ws.onmessage = (e) => handleWsMessage(e.data);
      // Renamed from `chatHistory` to avoid shadowing the `chatHistory`
      // state (saved chat sessions) declared above.
      const conversationHistory = [...messages, { ...userMsg, content: modelInstruction }]
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-MAX_CHAT_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: compactMessageContent(m.content) }));

      ws.send(JSON.stringify({
        type: 'chat',
        requestId,
        mode,
        messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...conversationHistory],
        // Archived transcripts remain available in the UI; only the current one is chat context.
        pdfContext: (contextOverride || [pdfText, liveTranscript].filter(Boolean).join('\n\n')).slice(-MAX_CONTEXT_CHARS),
      }));
    } catch (err) {
      liveRequestInFlightRef.current = false;
      setChatStreaming(false);
      chatRequestIdRef.current = '';
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          last.content = `Connection error: ${(err as Error).message}`;
          last.streaming = false;
        }
        return [...next];
      });
    }
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
    if (isLiveAnswering) {
      setIsLiveAnswering(false);
      liveAnsweringRef.current = false;
      if (realtimeUploadTimerRef.current) clearInterval(realtimeUploadTimerRef.current);
      realtimeUploadTimerRef.current = null;
      if (electronSilenceMonitorRef.current) clearInterval(electronSilenceMonitorRef.current);
      electronSilenceMonitorRef.current = null;
      void electronAudioContextRef.current?.close();
      electronAudioContextRef.current = null;
      electronPendingSegmentsRef.current = [];
      if (realtimeAnswerTimerRef.current) clearTimeout(realtimeAnswerTimerRef.current);
      realtimeAnswerTimerRef.current = null;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      liveQuestionRef.current = '';
      // Explicitly stop the Electron mic recorder instead of relying on the
      // implicit stop triggered by ending the underlying tracks below.
      recorderRef.current?.stop();
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setIsRecording(false);
      return;
    }
    recorderRef.current?.stop();
    setIsRecording(false);
  };

  const startElectronMicrophone = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      const segment = chunks.splice(0, chunks.length);
      if (liveAnsweringRef.current) recorder.start();
      if (!segment.length) return;
      const blob = new Blob(segment, { type: recorder.mimeType || 'audio/webm' });
      if (electronTranscriptionBusyRef.current) {
        electronPendingSegmentsRef.current.push(blob);
        return;
      }

      const transcribeSegment = async (audio: Blob): Promise<void> => {
        electronTranscriptionBusyRef.current = true;
        setIsTranscribing(true);
        const formData = new FormData();
        formData.append('file', audio, 'live-segment.webm');
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const response = await fetch(`${HTTP_URL}/api/transcribe-audio`, { method: 'POST', body: formData, signal: controller.signal });
          clearTimeout(timeout);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Transcription failed');
          const text = String(data.text || '').trim();
          if (!text || liveRequestInFlightRef.current) return;
          const question = `${liveQuestionRef.current} ${text}`.replace(/\s+/g, ' ').trim();
          setLiveTranscript(question);
          liveQuestionRef.current = question;
          if (realtimeAnswerTimerRef.current) clearTimeout(realtimeAnswerTimerRef.current);
          realtimeAnswerTimerRef.current = setTimeout(() => {
            const completedQuestion = liveQuestionRef.current.trim();
            const normalized = completedQuestion.toLowerCase().replace(/\s+/g, ' ');
            if (!completedQuestion || !liveAnsweringRef.current || liveRequestInFlightRef.current) return;
            if (!isVoiceAssistantRequest(completedQuestion)) {
              liveQuestionRef.current = '';
              return;
            }
            if (normalized === lastLiveQuestionRef.current) return;
            liveQuestionRef.current = '';
            setLiveTranscript('');
            liveRequestInFlightRef.current = true;
            lastLiveQuestionRef.current = normalized;
            void sendMessage(completedQuestion, completedQuestion, `Answer briefly and directly: ${completedQuestion}`);
          }, ELECTRON_VOICE_SILENCE_MS);
        } catch (error) {
          setError(`Live transcription failed: ${(error as Error).message}`);
        } finally {
          electronTranscriptionBusyRef.current = false;
          setIsTranscribing(false);
          const pending = electronPendingSegmentsRef.current.shift();
          if (pending && liveAnsweringRef.current) void transcribeSegment(pending);
        }
      };

      void transcribeSegment(blob);
    };
    recorder.start();
    recorderRef.current = recorder;
    liveAnsweringRef.current = true;
    setIsLiveAnswering(true);
    setIsRecording(true);
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    electronAudioContextRef.current = audioContext;
    const audioSamples = new Uint8Array(analyser.fftSize);
    let lastSpeechAt = Date.now();
    let heardSpeech = false;
    electronSilenceMonitorRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(audioSamples);
      let volume = 0;
      for (const sample of audioSamples) volume += Math.abs(sample - 128);
      volume /= audioSamples.length;
      if (volume > 2) {
        heardSpeech = true;
        lastSpeechAt = Date.now();
      } else if (heardSpeech && Date.now() - lastSpeechAt >= ELECTRON_VOICE_SILENCE_MS && recorder.state === 'recording') {
        heardSpeech = false;
        recorder.stop();
      }
    }, 100);
  };

  const startRealtimeMicrophone = async () => {
    setError('');
    try {
      if (navigator.userAgent.includes('Electron')) {
        await startElectronMicrophone();
        return;
      }
      const browserWindow = window as unknown as {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
      };
      const SpeechRecognition = browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition;
      if (!SpeechRecognition) throw new Error('Live microphone needs Chrome or Edge.');

      const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = microphoneStream;
      void ensureWs().catch(() => undefined);
      liveQuestionRef.current = '';
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      const finalSpeech = { value: '' };
      recognition.onresult = (event) => {
        let interim = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) finalSpeech.value = `${finalSpeech.value} ${result[0].transcript}`.trim();
          else interim += result[0].transcript;
        }
        liveQuestionRef.current = `${finalSpeech.value} ${interim}`.trim();
        setLiveTranscript(liveQuestionRef.current);
        if (realtimeAnswerTimerRef.current) clearTimeout(realtimeAnswerTimerRef.current);
        realtimeAnswerTimerRef.current = setTimeout(() => {
          const question = finalSpeech.value.trim();
          const normalized = question.toLowerCase().replace(/\s+/g, ' ');
          if (!question || !liveAnsweringRef.current || liveRequestInFlightRef.current) return;
          if (!isVoiceAssistantRequest(question)) {
            finalSpeech.value = '';
            liveQuestionRef.current = '';
            return;
          }
          if (normalized === lastLiveQuestionRef.current) return;
          finalSpeech.value = '';
          liveQuestionRef.current = '';
          setLiveTranscript('');
          liveRequestInFlightRef.current = true;
          lastLiveQuestionRef.current = normalized;
          void sendMessage(question, question, `Answer briefly and directly: ${question}`);
        }, BROWSER_VOICE_SILENCE_MS);
      };
      recognition.onerror = (event) => setError(`Live listening error: ${event.error || 'unknown'}. Check microphone permission.`);
      recognition.onend = () => {
        if (recognitionRef.current && liveAnsweringRef.current) {
          try { recognition.start(); } catch { /* already restarting */ }
        }
      };
      recognitionRef.current = recognition;
      liveAnsweringRef.current = true;
      setIsLiveAnswering(true);
      setIsRecording(true);
      recognition.start();
    } catch (err) {
      setError(`Live microphone permission failed: ${(err as Error).message}`);
    }
  };

  const recordAudioStream = (stream: MediaStream, cleanup: () => void) => {
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      cleanup();
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      streamRef.current = null;
      if (chunks.length === 0) return;

      setIsTranscribing(true);
      try {
        const formData = new FormData();
        formData.append('file', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), 'meeting.webm');
        const response = await fetch(`${HTTP_URL}/api/transcribe-audio`, { method: 'POST', body: formData });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Transcription failed');
        const transcript = String(data.text || '').trim();
        if (!transcript) throw new Error('No speech was found in the meeting audio.');
        setLiveTranscript(transcript);
        setTranscripts((current) => [{
          id: crypto.randomUUID(),
          source: meetingSource,
          text: transcript,
          createdAt: new Date().toISOString(),
        }, ...current]);
        await sendMessage('Answer the latest meeting question using the meeting transcript. Give a direct, concise answer.', transcript);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsTranscribing(false);
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    setLiveTranscript('');
    setIsRecording(true);
  };

  const startMeetingCapture = async () => {
    setError('');
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('This browser does not support screen-audio sharing. Use Chrome or Edge.');
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (displayStream.getAudioTracks().length === 0) {
        displayStream.getTracks().forEach((track) => track.stop());
        throw new Error('No shared audio selected. Choose a tab or window and enable Share audio.');
      }

      recordAudioStream(new MediaStream(displayStream.getAudioTracks()), () => {
        displayStream.getTracks().forEach((track) => track.stop());
      });
    } catch (err) {
      setError(`Screen audio permission failed: ${(err as Error).message}`);
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

  // --- PDF upload ---
  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPdfLoading(true);
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    // Added a timeout (matching /api/transcribe-audio) so a slow/hung server
    // doesn't leave the UI stuck on "Extracting text from PDF..." forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PDF_UPLOAD_TIMEOUT_MS);

    try {
      const res = await fetch(`${HTTP_URL}/api/extract-pdf`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Upload failed');
      }

      const data = await res.json();
      setPdfText(data.text);
      setPdfName(file.name);
    } catch (err) {
      const isTimeout = (err as Error).name === 'AbortError';
      setError(`PDF upload failed: ${isTimeout ? 'request timed out' : (err as Error).message}`);
    } finally {
      clearTimeout(timeout);
      setPdfLoading(false);
    }
  };

  const removePdf = () => {
    setPdfText('');
    setPdfName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-md sticky top-0 z-10">
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
                    <span className={`text-xs ${isRecording ? 'text-rose-300' : isTranscribing ? 'text-amber-300' : 'text-slate-500'}`}>{isRecording ? 'Listening' : isTranscribing ? 'Transcribing...' : 'Ready'}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {meetingSources.map((source) => (
                      <button
                        key={source.name}
                        onClick={() => setMeetingSource(source.name)}
                        className={`rounded-lg border px-2 py-2 text-center ${meetingSource === source.name ? 'border-emerald-400 bg-emerald-400/10' : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'}`}
                      >
                        <span className={`mx-auto mb-1 flex h-7 w-7 items-center justify-center rounded-md ${source.color}`}><Video className="h-3.5 w-3.5 text-white" /></span>
                        <span className="block truncate text-[11px] text-slate-200">{source.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-2">
                    {!isRecording && !isTranscribing ? (
                      <>
                        <button onClick={startRealtimeMicrophone} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-rose-500 px-3 py-2 text-xs font-medium text-white hover:bg-rose-400"><Mic className="h-3.5 w-3.5" /> Live microphone</button>
                        <button onClick={startMeetingCapture} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-400"><MonitorUp className="h-3.5 w-3.5" /> Screen audio</button>
                      </>
                    ) : (
                      <button onClick={stopMeetingCapture} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-xs font-medium text-white hover:bg-slate-600"><Square className="h-3 w-3" /> Stop listening</button>
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

      {/* Main content */}
      <div className="mx-auto flex min-h-[calc(100dvh-73px)] max-w-4xl min-w-0 flex-col px-3 py-4 sm:px-4 sm:py-6">
        {/* PDF upload bar */}
        <div className="mb-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handlePdfUpload}
            className="hidden"
          />
          {pdfName ? (
            <div className="flex items-center gap-3 bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{pdfName}</p>
                <p className="text-xs text-slate-400">
                  {pdfText.length.toLocaleString()} characters extracted — sent as context
                </p>
              </div>
              <button
                onClick={removePdf}
                className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={pdfLoading}
              className="w-full flex items-center justify-center gap-2.5 bg-slate-800/40 hover:bg-slate-800/70 border border-dashed border-slate-600 hover:border-emerald-500/50 rounded-xl px-4 py-3 text-sm text-slate-400 hover:text-slate-200 transition-all disabled:opacity-50"
            >
              {pdfLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Extracting text from PDF...
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4" />
                  Upload PDF for context (optional)
                </>
              )}
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