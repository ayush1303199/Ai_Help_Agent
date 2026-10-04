import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeConfig } from '../../config/runtimeConfig';
import { createUnvalidatedSuggestion, parseUnifiedDiff, validateUnifiedFile, type DeveloperDiffFile } from './codingDiff';
import { CodingAgentTransport, type CodingActivity, type CodingTransportResult } from './codingTransport';
import {
  codingPreferenceContext,
  compactCodingConversation,
  extractCodingPreference,
  readCodingConversationStates,
  readCodingPreferences,
  upsertCodingConversationState,
  upsertCodingPreference,
  writeCodingConversationStates,
  writeCodingPreferences,
  type CodingConversationState,
  type CodingPatchRecord,
  type CodingPreference,
} from './codingSessionStore';

export type ProjectLifecycleState =
  | 'NO_PROJECT'
  | 'SELECTING_PROJECT'
  | 'ATTACHING_PROJECT'
  | 'PROJECT_ATTACHED'
  | 'PROJECT_UNAVAILABLE'
  | 'PROJECT_MISSING'
  | 'PROJECT_DETACHED'
  | 'ATTACH_FAILED';

export interface CodingMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  requestId?: string;
  performanceEvidence?: Record<string, unknown> | null;
}

interface DeveloperSnapshot {
  path: string;
  hash: string;
}

interface DeveloperSearchResult {
  path: string;
  line: number;
  text: string;
  matchType: 'filename' | 'content' | 'scope-fallback';
}

interface CodingProposal {
  id?: string;
  state?: string;
  lifecycleState?: string;
  files: DeveloperDiffFile[];
  raw: string;
  searchedFiles: string[];
  snapshots: DeveloperSnapshot[];
  verification?: {
    status?: string;
    classification?: string;
    reason?: string;
    attempts?: Array<{ check?: string; ok?: boolean; classification?: string; extracted?: { file?: string | null; line?: number | null; message?: string } }>;
  } | null;
  outcome?: string | null;
  error?: string | null;
  runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null;
}

interface CodingControllerOptions {
  maxContextChars: number;
  maxHistoryMessages: number;
  maxMessageChars: number;
}

function compactMessageContent(content: string, maxChars: number) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[Earlier content omitted for speed]`;
}

export const PROJECT_NAME_BLACKLIST = new Set([
  'the', 'a', 'an', 'this', 'that', 'it', 'its', 'my', 'your', 'our', 'all', 'any',
  'faq', 'table', 'tables', 'database', 'db', 'query', 'queries', 'sql', 'mysql',
  'postgres', 'postgresql', 'sqlite', 'oracle', 'mongo', 'mongodb', 'redis',
  'code-level', 'code_level', 'measured', 'unverified', 'partial', 'explain', 'analyze',
  'timing', 'latency', 'performance', 'bottleneck', 'select', 'insert', 'update',
  'delete', 'from', 'where', 'join', 'group', 'order', 'limit', 'match', 'against',
  'index', 'indexes', 'indexed', 'unindexed', 'slow', 'fast', 'count', 'sum', 'avg',
  'controller', 'model', 'service', 'repository', 'view', 'component', 'helper',
  'function', 'method', 'class', 'symbol', 'file', 'files', 'folder', 'folders',
  'project', 'repo', 'repository', 'workspace', 'app', 'application', 'code', 'source',
  'fix', 'patch', 'proposal', 'diff', 'solution', 'problem', 'issue', 'bug', 'error',
  'test', 'tests', 'testing', 'check', 'measure', 'measurement', 'evidence', 'summary',
  'report', 'task', 'step', 'steps', 'status', 'state', 'session', 'turn', 'request',
]);

export function extractCodingProjectCandidates(request: string): string[] {
  const candidates: string[] = [];
  const add = (candidate: string | undefined | null) => {
    if (!candidate) return;
    const clean = candidate.trim().replace(/^['"`<([{\\]+|['"`>)\]}\\.,;:]+$/g, '');
    const low = clean.toLowerCase();
    if (
      clean
      && clean.length >= 2
      && clean.length <= 128
      && !PROJECT_NAME_BLACKLIST.has(low)
      && !low.includes('code-level')
      && !low.includes('code_level')
      && !candidates.includes(clean)
    ) {
      candidates.push(clean);
    }
  };

  const explicitAfter = request.match(/(?:^|[\s"'`])([A-Za-z0-9][A-Za-z0-9._-]{1,127})\s+(?:project|repo|repository|workspace|folder|app)\b/i);
  add(explicitAfter?.[1]);
  const explicitBefore = request.match(/\b(?:project|repo|repository|workspace|folder|app)\s+([A-Za-z0-9][A-Za-z0-9._-]{1,127})\b/i);
  add(explicitBefore?.[1]);

  const prepositionMatch = request.match(/\b(?:in|for|inside|under|within|on|open|select|use|switch\s+to)\s+([A-Za-z0-9][A-Za-z0-9._-]{1,127})\b/i);
  add(prepositionMatch?.[1]);
  const hinglishKeMein = request.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{1,127})\s+(?:ke|mein|me|ka|ki)\b/i);
  add(hinglishKeMein?.[1]);

  const quoted = request.match(/[`"']([A-Za-z0-9][A-Za-z0-9._-]{1,127})[`"']/g);
  if (quoted) {
    for (const q of quoted) {
      add(q.replace(/[`"']/g, ''));
    }
  }

  const compoundNames = request.match(/\b([a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)+)\b/g);
  if (compoundNames) {
    for (const name of compoundNames) {
      add(name);
    }
  }

  const fileNames = request.match(/\b([A-Za-z0-9_-]+\.(?:php|ts|tsx|js|jsx|py|java|go|rb|cs|rs|json|ya?ml|html|css|vue|c|cpp|h))\b/gi);
  if (fileNames) {
    for (const fn of fileNames) {
      add(fn);
    }
  }

  return candidates;
}

export function extractCodingProjectName(request: string): string | null {
  const candidates = extractCodingProjectCandidates(request);
  return candidates[0] || null;
}

async function hashDeveloperContent(content: string) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function persistStoredProjectRoot(root: string | null): void {
  try {
    if (root) {
      localStorage.setItem('ai_help_agent_coding_project_root', root);
    } else {
      localStorage.removeItem('ai_help_agent_coding_project_root');
    }
  } catch {
    // Local storage unavailable in this environment
  }
}

function readStoredProjectRoot(): string | null {
  try {
    return localStorage.getItem('ai_help_agent_coding_project_root');
  } catch {
    return null;
  }
}

export function useCodingAgentController({
  maxContextChars,
  maxHistoryMessages,
  maxMessageChars,
}: CodingControllerOptions) {
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [conversationStates, setConversationStates] = useState<CodingConversationState[]>(readCodingConversationStates);
  const [conversationId, setConversationId] = useState<string>(() => {
    try { return localStorage.getItem('coding-active-session-v1') || crypto.randomUUID(); } catch { return crypto.randomUUID(); }
  });
  const savedConversation = conversationStates.find((session) => session.id === conversationId);
  const [messages, setMessages] = useState<CodingMessage[]>(() => savedConversation?.messages || []);
  const [activity, setActivity] = useState<CodingActivity[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [projectRoot, setProjectRoot] = useState<string | null>(() => readStoredProjectRoot() || savedConversation?.projectRoot || null);
  const [projectLifecycleState, setProjectLifecycleState] = useState<ProjectLifecycleState>(() => {
    const saved = readStoredProjectRoot() || savedConversation?.projectRoot;
    return saved ? 'PROJECT_ATTACHED' : 'NO_PROJECT';
  });
  const [projectCandidates, setProjectCandidates] = useState<string[]>([]);
  const [directory, setDirectory] = useState<Array<{ name: string; type: 'file' | 'directory' }>>([]);
  const [path, setPath] = useState('.');
  const [fileContent, setFileContent] = useState('');
  const [filePath, setFilePath] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DeveloperSearchResult[]>([]);
  const [appliedPatchLog, setAppliedPatchLog] = useState<CodingPatchRecord[]>(() => savedConversation?.appliedPatchLog || []);
  const [lastProvider, setLastProvider] = useState<{ id?: string; label?: string; model?: string; changedAt?: string } | null>(null);
  const [preferences, setPreferences] = useState<CodingPreference[]>(readCodingPreferences);
  const [proposal, setProposal] = useState<CodingProposal | null>(null);
  const [busy, setBusy] = useState(false);

  const transportRef = useRef<CodingAgentTransport | null>(null);
  const turnIdsRef = useRef(new Map<string, string>());
  const onError = useCallback((message: string) => {
    setErrorMessage(message);
    setStatusMessage('');
  }, []);
  const onStatus = useCallback((message: string) => {
    setStatusMessage(message);
    setErrorMessage('');
  }, []);

  useEffect(() => {
    const transport = new CodingAgentTransport();
    transportRef.current = transport;
    return () => {
      transport.close();
      transportRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const syncInitialProjectState = async () => {
      const getSavedRoot = () => readStoredProjectRoot() || savedConversation?.projectRoot || null;

      if (window.electronAPI?.getDeveloperProjectState) {
        try {
          const state = await window.electronAPI.getDeveloperProjectState();
          if (!active) return;
          if (state.status === 'PROJECT_ATTACHED' && state.projectRoot) {
            setProjectRoot(state.projectRoot);
            setProjectLifecycleState('PROJECT_ATTACHED');
            persistStoredProjectRoot(state.projectRoot);
            try {
              const listing = await window.electronAPI.listDeveloperDirectory('.');
              if (active) setDirectory(listing);
            } catch {
              // Retain current directory state
            }
          } else if (state.status === 'PROJECT_MISSING') {
            setProjectRoot(null);
            setProjectLifecycleState('PROJECT_MISSING');
            persistStoredProjectRoot(null);
            setDirectory([]);
            onError('The selected project folder could not be found on disk (PROJECT_MISSING).');
          } else if (state.status === 'PROJECT_DETACHED') {
            setProjectRoot(null);
            setProjectLifecycleState('PROJECT_DETACHED');
            persistStoredProjectRoot(null);
            setDirectory([]);
          } else {
            const savedRoot = getSavedRoot();
            if (savedRoot) {
              try {
                const attached = await window.electronAPI.attachDeveloperProject(savedRoot);
                if (!active) return;
                if (attached.status === 'PROJECT_ATTACHED' && attached.projectRoot) {
                  setProjectRoot(attached.projectRoot);
                  setProjectLifecycleState('PROJECT_ATTACHED');
                  persistStoredProjectRoot(attached.projectRoot);
                  const listing = await window.electronAPI.listDeveloperDirectory('.');
                  if (active) setDirectory(listing);
                } else if (attached.status === 'PROJECT_MISSING') {
                  setProjectRoot(null);
                  setProjectLifecycleState('PROJECT_MISSING');
                  persistStoredProjectRoot(null);
                  setDirectory([]);
                  onError('The selected project folder could not be found on disk (PROJECT_MISSING).');
                } else {
                  setProjectLifecycleState('NO_PROJECT');
                }
              } catch {
                setProjectLifecycleState('NO_PROJECT');
              }
            } else {
              setProjectLifecycleState('NO_PROJECT');
            }
          }
        } catch {
          setProjectLifecycleState('NO_PROJECT');
        }
      } else {
        try {
          const res = await fetch('http://localhost:3001/api/coding/project-state');
          if (!active) return;
          if (res.ok) {
            const state = await res.json();
            if (state.status === 'PROJECT_ATTACHED' && state.projectRoot) {
              setProjectRoot(state.projectRoot);
              setProjectLifecycleState('PROJECT_ATTACHED');
              persistStoredProjectRoot(state.projectRoot);
              try {
                const dirRes = await fetch('http://localhost:3001/api/coding/directory?path=' + encodeURIComponent('.'));
                if (dirRes.ok && active) setDirectory(await dirRes.json());
              } catch {
                // Retain current directory state
              }
            } else if (state.status === 'PROJECT_MISSING') {
              setProjectRoot(null);
              setProjectLifecycleState('PROJECT_MISSING');
              persistStoredProjectRoot(null);
              setDirectory([]);
              onError('The selected project folder could not be found on disk (PROJECT_MISSING).');
            } else if (state.status === 'PROJECT_DETACHED') {
              setProjectRoot(null);
              setProjectLifecycleState('PROJECT_DETACHED');
              persistStoredProjectRoot(null);
              setDirectory([]);
            } else {
              const savedRoot = getSavedRoot();
              if (savedRoot) {
                try {
                  const attachRes = await fetch('http://localhost:3001/api/coding/project-attach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectRoot: savedRoot }),
                  });
                  if (attachRes.ok && active) {
                    const attached = await attachRes.json();
                    if (attached.status === 'PROJECT_ATTACHED' && attached.projectRoot) {
                      setProjectRoot(attached.projectRoot);
                      setProjectLifecycleState('PROJECT_ATTACHED');
                      persistStoredProjectRoot(attached.projectRoot);
                      const dirRes = await fetch('http://localhost:3001/api/coding/directory?path=' + encodeURIComponent('.'));
                      if (dirRes.ok && active) setDirectory(await dirRes.json());
                    } else {
                      setProjectLifecycleState('NO_PROJECT');
                    }
                  } else {
                    setProjectLifecycleState('NO_PROJECT');
                  }
                } catch {
                  setProjectLifecycleState('NO_PROJECT');
                }
              } else {
                setProjectLifecycleState('NO_PROJECT');
              }
            }
          } else {
            setProjectLifecycleState('NO_PROJECT');
          }
        } catch {
          setProjectLifecycleState('NO_PROJECT');
        }
      }
    };
    void syncInitialProjectState();
    return () => { active = false; };
  }, [onError, savedConversation?.projectRoot]);

  useEffect(() => {
    if (!writeCodingPreferences(preferences)) onError('Coding preferences could not be saved because browser storage is full or unavailable.');
  }, [onError, preferences]);

  useEffect(() => {
    try {
      localStorage.setItem('coding-active-session-v1', conversationId);
    } catch {
      onError('The active Coding conversation could not be saved because browser storage is unavailable.');
    }
  }, [conversationId, onError]);

  useEffect(() => {
    if (!writeCodingConversationStates(conversationStates)) {
      onError('Coding session context could not be saved because browser storage is full or unavailable.');
    }
  }, [conversationStates, onError]);

  useEffect(() => {
    if (messages.some((message) => message.streaming)) return;
    const sessionState: CodingConversationState = {
      id: conversationId,
      messages: messages.map(({ role, content }) => ({ role, content })),
      updatedAt: new Date().toISOString(),
      projectRoot,
      pendingPlan: proposal?.runtime ? { ...proposal.runtime } : null,
      appliedPatchLog,
      providerNeutralSummary: compactCodingConversation({
        messages: messages.map(({ role, content }) => ({ role, content })),
        projectRoot,
        pendingPlan: proposal?.runtime ? { ...proposal.runtime } : null,
        appliedPatchLog,
      }).summary,
      lastUsedProvider: lastProvider,
    };
    setConversationStates((previous) => upsertCodingConversationState(previous, sessionState));
  }, [appliedPatchLog, conversationId, lastProvider, messages, projectRoot, proposal]);

  const sendMessage = async () => {
    const question = input.trim();
    if (!question || streaming || busy) return;
    let currentProjectRoot = projectRoot;
    let currentScope = path;
    const projectContinuation: string | null = null;
    if (!currentProjectRoot) {
      currentProjectRoot = readStoredProjectRoot() || savedConversation?.projectRoot || null;
      if (!currentProjectRoot) {
        try {
          if (window.electronAPI?.getDeveloperProjectState) {
            const auth = await window.electronAPI.getDeveloperProjectState();
            if (auth?.projectRoot) currentProjectRoot = auth.projectRoot;
          } else {
            const res = await fetch('http://127.0.0.1:3001/api/coding/project-state');
            if (res.ok) {
              const st = await res.json();
              if (st.projectRoot && st.attached) currentProjectRoot = st.projectRoot;
            }
          }
        } catch {
          // ignore
        }
      }
      if (currentProjectRoot) {
        setProjectRoot(currentProjectRoot);
        setProjectLifecycleState('PROJECT_ATTACHED');
        persistStoredProjectRoot(currentProjectRoot);
      }
    }
    if (!currentProjectRoot) {
      const appendDiscoveryReply = (content: string) => {
        setMessages((previous) => [...previous, { role: 'user', content: question }, { role: 'assistant', content }]);
        setInput('');
      };
      let projectName = extractCodingProjectName(question);
      if (projectCandidates.length > 0) {
        const choice = question.match(/^\s*(?:(?:use|choose|select)\s+)?(\d+)\s*\.?\s*$/i);
        const selected = choice
          ? projectCandidates[Number(choice[1]) - 1]
          : projectCandidates.find((candidate) => question.toLowerCase().includes(candidate.toLowerCase()));
        if (!selected) {
          appendDiscoveryReply(`Please reply with a listed number or paste the exact folder path so I can use the right project:\n${projectCandidates.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`);
          return;
        }
        projectName = selected;
      }
      const candidateList = projectCandidates.length > 0 && projectName ? [projectName] : extractCodingProjectCandidates(question);
      if (candidateList.length === 0) {
        candidateList.push('*');
      }
      setBusy(true);
      try {
        let discovery: { projectRoot: string | null; matches: string[] } | null = null;
        let matchedCandidate = '';
        for (const candidate of candidateList) {
          try {
            let result: { projectRoot: string | null; matches: string[] } | null = null;
            if (window.electronAPI) {
              result = await window.electronAPI.discoverDeveloperProject(candidate);
            } else {
              const res = await fetch('http://127.0.0.1:3001/api/coding/project-discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: candidate }),
              });
              if (res.ok) result = await res.json();
            }
            if (result?.projectRoot) {
              discovery = result;
              matchedCandidate = candidate;
              break;
            }
            if (!discovery && result && result.matches.length > 0) {
              discovery = result;
              matchedCandidate = candidate;
            }
          } catch {
            // Check next candidate
          }
        }
        if (!discovery || !discovery.projectRoot) {
          const matches = discovery?.matches || [];
          if (matches.length > 0) {
            setProjectCandidates(matches);
            appendDiscoveryReply(`I found more than one project matching "${matchedCandidate || candidateList[0]}". Which one should I use?\n${matches.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`);
          } else {
            appendDiscoveryReply(`Could not find a project matching "${candidateList.join(', ')}". Tell me the project folder name or choose it under Advanced > Select folder.`);
          }
          return;
        }
        setProjectCandidates([]);
        currentProjectRoot = discovery.projectRoot;
        setProjectRoot(currentProjectRoot);
        setProjectLifecycleState('PROJECT_ATTACHED');
        persistStoredProjectRoot(currentProjectRoot);
        currentScope = '.';
        setPath('.');
      } catch (error) {
        setProjectCandidates([]);
        appendDiscoveryReply(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setBusy(false);
      }
    }

    const detectedPreference = extractCodingPreference(question);
    if (detectedPreference) {
      setPreferences((previous) => upsertCodingPreference(previous, detectedPreference));
      onStatus('Coding preference saved for future Coding Agent sessions.');
    }
    const requestId = crypto.randomUUID();
    const userMessage: CodingMessage = { role: 'user', content: question };
    const assistantMessage: CodingMessage = { role: 'assistant', content: '', streaming: true, requestId };
    const compactedSession = compactCodingConversation({
      messages: [...messages.filter((message) => !message.streaming), userMessage]
        .map((message) => ({ role: message.role, content: compactMessageContent(message.content, maxMessageChars) })),
      projectRoot: currentProjectRoot,
      pendingPlan: proposal?.runtime ? { ...proposal.runtime } : null,
      appliedPatchLog,
      providerNeutralSummary: savedConversation?.providerNeutralSummary,
    }, {
      maxTokens: Math.max(512, Math.floor(maxContextChars / 4)),
      lastMessageCount: maxHistoryMessages,
    });
    const conversationHistory = compactedSession.messages.map((message) => ({ role: message.role, content: message.content }));
    if (projectContinuation) conversationHistory[conversationHistory.length - 1] = { role: 'user', content: projectContinuation };
    const preferencesContext = codingPreferenceContext(preferences);
    if (preferencesContext) conversationHistory.unshift({ role: 'assistant', content: `[CODING_STYLE_PREFERENCES]\n${preferencesContext}` });
    setMessages((previous) => [...previous, userMessage, assistantMessage]);
    setInput('');
    setActivity([]);
    setStreaming(true);
    try {
      const transport = transportRef.current;
      if (!transport) throw new Error('Coding Agent transport is unavailable.');
      await transport.send(requestId, conversationHistory, currentScope, {
        onStart: (turnId, root, scope) => {
          turnIdsRef.current.set(requestId, turnId);
          setProjectRoot(root);
          setPath(scope);
          setActivity([{ phase: 'reading', message: 'I’m starting from the project context and will find relevant files automatically.' }]);
        },
        onActivity: (entry) => setActivity((previous) => [...previous, entry].slice(-8)),
        onToken: () => undefined,
        onDone: (result: CodingTransportResult) => {
          void (async () => {
            try {
              const turnId = turnIdsRef.current.get(requestId);
              if (!turnId) throw new Error('Coding conversation ownership was lost: active turn not found.');
              if (typeof result.provider === 'string' || typeof result.model === 'string') {
                if (lastProvider && (lastProvider.id !== result.providerId || lastProvider.model !== result.model)) {
                  onStatus('Coding session context restored after provider switch.');
                }
                onStatus(
                  `Coding used ${result.provider || 'the configured provider'}`
                  + `${result.model ? ` (${result.model})` : ''}`
                  + `${result.providerId ? `, instance ${result.providerId}` : ''}`
                  + `${result.fallback ? ' via the globally enabled fallback' : ''}.`,
                );
                setLastProvider({
                  id: result.providerId || undefined,
                  label: result.provider || undefined,
                  model: result.model || undefined,
                  changedAt: new Date().toISOString(),
                });
              }
              if (result.proposalRequired) {
                setActivity((previous) => [...previous, {
                  phase: 'files_read',
                  message: result.filesRead.length ? `Read ${result.filesRead.map((file) => file.path).join(', ')}.` : 'No project files were read.',
                }].slice(-8));
                if (/^\s*NO_CHANGES\s*$/i.test(result.content)) {
                  await transport.markTurn(turnId, 'completed', 'no_changes', result.filesRead.length);
                  setMessages((previous) => previous.map((message) => message.requestId === requestId
                    ? { ...message, content: 'I inspected the relevant project context, but could not identify a safe change to propose.', streaming: false }
                    : message));
                  return;
                }
                const files = parseUnifiedDiff(result.content);
                if (!files.length) {
                  await transport.markTurn(turnId, 'completed', 'proposal_format_fallback', result.filesRead.length);
                  setMessages((previous) => previous.map((message) => message.requestId === requestId
                    ? { ...message, content: createUnvalidatedSuggestion(result.content), streaming: false }
                    : message));
                  return;
                }
                const sources = new Map(result.filesRead.map((file) => [file.path, file.content]));
                const unexpected = files.filter((file) => !sources.has(file.path));
                if (unexpected.length) throw new Error(`The proposal references files that were not read: ${unexpected.map((file) => file.path).join(', ')}`);
                if (files.some((file) => !validateUnifiedFile(file.lines, sources.get(file.path) || ''))) {
                  throw new Error('The proposed diff does not match the inspected file contents.');
                }
                const latestFiles = await Promise.all(files.map(async (file) => {
                  if (window.electronAPI) {
                    return {
                      path: file.path,
                      content: (await window.electronAPI.readDeveloperFile(file.path)).content,
                    };
                  }
                  const res = await fetch(`http://127.0.0.1:3001/api/coding/read-file?path=${encodeURIComponent(file.path)}`);
                  if (!res.ok) throw new Error(`Could not read file for proposal verification: ${file.path}`);
                  const data = await res.json();
                  return { path: file.path, content: data.content };
                }));
                const snapshots = await Promise.all(latestFiles.map(async (file) => ({
                  path: file.path,
                  hash: await hashDeveloperContent(file.content),
                })));
                if (latestFiles.some((file) => file.content !== sources.get(file.path))) {
                  throw new Error('A file changed after it was inspected. Please send the request again so the proposal uses fresh context.');
                }
                const registered = window.electronAPI
                  ? await window.electronAPI.createDeveloperProposal(result.content, snapshots, null, path, turnId)
                  : {
                      id: `proposal-${Date.now()}`,
                      state: 'awaiting_approval',
                      lifecycleState: 'WAITING_FOR_APPROVAL',
                      runtime: null,
                    };
                setProposal({
                  id: registered.id,
                  state: registered.state,
                  lifecycleState: registered.lifecycleState,
                  files,
                  raw: result.content,
                  searchedFiles: result.filesRead.map((file) => file.path),
                  snapshots,
                  verification: null,
                  outcome: null,
                  error: null,
                  runtime: registered.runtime || null,
                });
                setMessages((previous) => previous.map((message) => message.requestId === requestId
                  ? { ...message, content: `I inspected ${result.filesRead.length} file${result.filesRead.length === 1 ? '' : 's'} and prepared a proposal for your review. Nothing has been written.`, streaming: false }
                  : message));
              } else {
                setActivity((previous) => [...previous, {
                  phase: 'files_read',
                  message: result.filesRead.length
                    ? `Read ${result.filesRead.map((file) => file.path).join(', ')}.`
                    : (result.readOnly || result.status === 'INVESTIGATION_COMPLETE')
                    ? 'Investigated relevant project files.'
                    : 'No project files were needed for this response.',
                }].slice(-8));
                await transport.markTurn(turnId, 'completed', result.status || 'completed', result.filesRead.length);
                setMessages((previous) => previous.map((message) => message.requestId === requestId
                  ? { ...message, content: result.content, streaming: false, performanceEvidence: result.performanceEvidence }
                  : message));
              }
            } catch (error) {
              const turnId = turnIdsRef.current.get(requestId);
              if (turnId) await transport.markTurn(turnId, 'failed', 'proposal_validation').catch(() => undefined);
              setMessages((previous) => previous.map((message) => message.requestId === requestId
                ? { ...message, content: `I could not safely finish this request: ${error instanceof Error ? error.message : String(error)}`, streaming: false }
                : message));
            } finally {
              turnIdsRef.current.delete(requestId);
              setStreaming(false);
              setBusy(false);
            }
          })();
        },
        onError: (error) => {
          const turnId = turnIdsRef.current.get(requestId);
          if (turnId) void transport.markTurn(turnId, 'failed', 'provider_or_tool_error').catch(() => undefined);
          turnIdsRef.current.delete(requestId);
          setMessages((previous) => previous.map((message) => message.requestId === requestId
            ? { ...message, content: `I could not complete this request: ${error.message}`, streaming: false }
            : message));
          setStreaming(false);
          setBusy(false);
        },
      }, conversationId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isMissing = errorMessage.includes('PROJECT_MISSING') || errorMessage.includes('does not exist on disk');
      const isDetached = errorMessage.includes('PROJECT_DETACHED') || errorMessage.includes('is detached');
      const isNotAttached = errorMessage.includes('PROJECT_NOT_ATTACHED') || errorMessage.includes('not owned by this renderer session') || errorMessage.includes('No project folder selected');
      const isStale = errorMessage.includes('PROJECT_STALE');
      const isToolSchemaMissing = errorMessage.includes('TOOL_SCHEMA_MISSING') || errorMessage.includes('was not in request.tools');

      const turnId = turnIdsRef.current.get(requestId);
      if (turnId && transportRef.current) {
        await transportRef.current.markTurn(turnId, 'failed', 'transport_error').catch(() => undefined);
      }
      turnIdsRef.current.delete(requestId);
      setStreaming(false);

      let userFacingError = `Connection error: ${errorMessage}`;
      if (isMissing) {
        setProjectRoot(null);
        setDirectory([]);
        setPath('.');
        setInput(question);
        userFacingError = 'The project folder could not be found on disk (PROJECT_MISSING). Select an existing folder under Advanced.';
        onError(userFacingError);
      } else if (isDetached) {
        setProjectRoot(null);
        setDirectory([]);
        setPath('.');
        setInput(question);
        userFacingError = 'The project was detached (PROJECT_DETACHED). Select a folder under Advanced, then resend your question.';
        onError(userFacingError);
      } else if (isNotAttached) {
        setProjectRoot(null);
        setDirectory([]);
        setPath('.');
        setInput(question);
        userFacingError = 'No project is currently attached to this desktop window (PROJECT_NOT_ATTACHED). Select a folder under Advanced, then resend your question.';
        onError(userFacingError);
      } else if (isStale) {
        userFacingError = 'Project session was stale (PROJECT_STALE). Authoritative project state reconciled; please resend.';
        onError(userFacingError);
      } else if (isToolSchemaMissing) {
        userFacingError = 'Coding Agent tool contract failure: tool schema was missing from provider request (TOOL_SCHEMA_MISSING).';
        onError(userFacingError);
      }

      setMessages((previous) => previous.map((message) => message.requestId === requestId
        ? {
          ...message,
          content: userFacingError,
          streaming: false,
        }
        : message));
    }
  };

  const selectProject = async () => {
    if (busy || streaming) return;
    if (!window.electronAPI) {
      setBusy(true);
      setProjectLifecycleState('SELECTING_PROJECT');
      try {
        let selectedPath: string | null = null;
        let pickerUsed = false;
        let pickedName = '';
        const picker = (window as unknown as {
          showDirectoryPicker?: (opts?: unknown) => Promise<{
            name: string;
            keys?: () => AsyncIterable<string>;
          }>;
        }).showDirectoryPicker;

        if (typeof picker === 'function') {
          try {
            const handle = await picker({ mode: 'read' });
            if (handle?.name) {
              pickerUsed = true;
              pickedName = handle.name;
              setProjectLifecycleState('ATTACHING_PROJECT');
              const signatures: string[] = [];
              try {
                if (typeof handle.keys === 'function') {
                  let count = 0;
                  for await (const key of handle.keys()) {
                    signatures.push(key);
                    count++;
                    if (count >= 20) break;
                  }
                }
              } catch {
                // Directory handle iteration not supported in this browser
              }
              const res = await fetch('http://localhost:3001/api/coding/project-discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: handle.name, signatures }),
              });
              if (res.ok) {
                const discovery = await res.json();
                if (discovery.projectRoot) {
                  selectedPath = discovery.projectRoot;
                } else if (discovery.matches?.length === 1) {
                  selectedPath = discovery.matches[0];
                } else if (discovery.matches?.length > 1) {
                  setProjectCandidates(discovery.matches);
                  setProjectLifecycleState('SELECTING_PROJECT');
                  onStatus(`Found multiple projects matching "${handle.name}". Select one candidate under Advanced.`);
                  return;
                }
              }
            }
          } catch (pickerErr) {
            if ((pickerErr as Error)?.name === 'AbortError') {
              setProjectLifecycleState(projectRoot ? 'PROJECT_ATTACHED' : 'NO_PROJECT');
              return;
            }
          }
        }
        if (!selectedPath) {
          const stateRes = await fetch('http://localhost:3001/api/coding/project-state');
          if (stateRes.ok) {
            const state = await stateRes.json();
            if (state.status === 'PROJECT_ATTACHED' && state.projectRoot) {
              selectedPath = state.projectRoot;
            }
          }
        }
        if (selectedPath) {
          setProjectLifecycleState('ATTACHING_PROJECT');
          const attachRes = await fetch('http://localhost:3001/api/coding/project-attach', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectRoot: selectedPath }),
          });
          if (attachRes.ok) {
            const attached = await attachRes.json();
            setProjectRoot(attached.projectRoot);
            setProjectLifecycleState('PROJECT_ATTACHED');
            persistStoredProjectRoot(attached.projectRoot);
            setProjectCandidates([]);
            setPath('.');
            setFileContent('');
            setFilePath('');
            const dirRes = await fetch('http://localhost:3001/api/coding/directory?path=' + encodeURIComponent('.'));
            if (dirRes.ok) setDirectory(await dirRes.json());
            onStatus(`Connected to project: ${attached.projectRoot}`);
            return;
          } else {
            const err = await attachRes.json().catch(() => ({ detail: '' }));
            setProjectLifecycleState('ATTACH_FAILED');
            onError(`Project attachment failed (ATTACH_FAILED): ${err.detail || 'Could not attach path'}`);
            return;
          }
        }
        if (pickerUsed) {
          setProjectLifecycleState('ATTACH_FAILED');
          onError(`Could not locate project directory "${pickedName}" on the local host. Ensure the backend has access to this folder.`);
          return;
        }
        setProjectLifecycleState('NO_PROJECT');
        onError('Select folder using the directory picker or attach a project in the desktop app.');
      } catch (error) {
        setProjectLifecycleState('ATTACH_FAILED');
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    setProjectLifecycleState('SELECTING_PROJECT');
    try {
      const result = await window.electronAPI.chooseDeveloperProject();
      if (result.canceled) {
        setProjectLifecycleState(projectRoot ? 'PROJECT_ATTACHED' : 'NO_PROJECT');
        return;
      }
      if (result.projectRoot) {
        setProjectRoot(result.projectRoot);
        setProjectLifecycleState('PROJECT_ATTACHED');
        persistStoredProjectRoot(result.projectRoot);
        setProjectCandidates([]);
        setPath('.');
        setFileContent('');
        setFilePath('');
        setDirectory(await window.electronAPI.listDeveloperDirectory('.'));
        onStatus(`Connected to project: ${result.projectRoot}`);
      }
    } catch (error) {
      setProjectLifecycleState('ATTACH_FAILED');
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const attachProjectByPath = async (targetPath: string) => {
    if (!targetPath || busy || streaming) return;
    setBusy(true);
    setProjectLifecycleState('ATTACHING_PROJECT');
    try {
      if (window.electronAPI) {
        const attached = await window.electronAPI.attachDeveloperProject(targetPath);
        if (attached.status === 'PROJECT_ATTACHED' && attached.projectRoot) {
          setProjectRoot(attached.projectRoot);
          setProjectLifecycleState('PROJECT_ATTACHED');
          persistStoredProjectRoot(attached.projectRoot);
          setProjectCandidates([]);
          setPath('.');
          setFileContent('');
          setFilePath('');
          setDirectory(await window.electronAPI.listDeveloperDirectory('.'));
          onStatus(`Connected to project: ${attached.projectRoot}`);
        } else if (attached.status === 'PROJECT_MISSING') {
          setProjectLifecycleState('PROJECT_MISSING');
          onError('The selected project folder could not be found on disk (PROJECT_MISSING).');
        } else {
          setProjectLifecycleState('ATTACH_FAILED');
          onError(`Project attachment failed (ATTACH_FAILED): ${attached.reason || 'Could not attach'}`);
        }
      } else {
        const attachRes = await fetch('http://localhost:3001/api/coding/project-attach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectRoot: targetPath }),
        });
        if (attachRes.ok) {
          const attached = await attachRes.json();
          setProjectRoot(attached.projectRoot);
          setProjectLifecycleState('PROJECT_ATTACHED');
          persistStoredProjectRoot(attached.projectRoot);
          setProjectCandidates([]);
          setPath('.');
          setFileContent('');
          setFilePath('');
          const dirRes = await fetch('http://localhost:3001/api/coding/directory?path=' + encodeURIComponent('.'));
          if (dirRes.ok) setDirectory(await dirRes.json());
          onStatus(`Connected to project: ${attached.projectRoot}`);
        } else {
          const err = await attachRes.json().catch(() => ({ detail: '' }));
          setProjectLifecycleState('ATTACH_FAILED');
          onError(`Project attachment failed (ATTACH_FAILED): ${err.detail || 'Could not attach path'}`);
        }
      }
    } catch (err) {
      setProjectLifecycleState('ATTACH_FAILED');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clearProject = async () => {
    if (busy || streaming) return;
    setBusy(true);
    try {
      if (window.electronAPI) {
        await window.electronAPI.clearDeveloperProject();
      } else {
        await fetch('http://localhost:3001/api/coding/project-clear', { method: 'POST' });
      }
      setProjectRoot(null);
      setProjectLifecycleState('PROJECT_DETACHED');
      persistStoredProjectRoot(null);
      setProjectCandidates([]);
      setDirectory([]);
      setPath('.');
      setFileContent('');
      setFilePath('');
      onStatus('Project detached.');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const listDirectory = async () => {
    if (!projectRoot || busy || streaming) return;
    setBusy(true);
    try {
      if (window.electronAPI) {
        setDirectory(await window.electronAPI.listDeveloperDirectory(path || '.'));
      } else {
        const res = await fetch('http://localhost:3001/api/coding/directory?path=' + encodeURIComponent(path || '.'));
        if (!res.ok) throw new Error(`Directory listing failed: HTTP ${res.status}`);
        setDirectory(await res.json());
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (requestedPath = path) => {
    if (!projectRoot || !requestedPath || busy || streaming) return;
    setBusy(true);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.readDeveloperFile(requestedPath);
        setFilePath(result.path);
        setFileContent(result.content);
      } else {
        const res = await fetch('http://localhost:3001/api/coding/read-file?path=' + encodeURIComponent(requestedPath));
        if (!res.ok) throw new Error(`Reading file failed: HTTP ${res.status}`);
        const result = await res.json();
        setFilePath(result.path);
        setFileContent(result.content);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const searchCode = async () => {
    if (!projectRoot || !searchQuery.trim() || busy || streaming) return;
    setBusy(true);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.searchDeveloperCode(searchQuery, path);
        setSearchResults(result.results);
      } else {
        const res = await fetch('http://localhost:3001/api/coding/search-code?query=' + encodeURIComponent(searchQuery) + '&scope=' + encodeURIComponent(path || '.'));
        if (!res.ok) throw new Error(`Searching code failed: HTTP ${res.status}`);
        const result = await res.json();
        setSearchResults(result.results);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const approveProposal = async () => {
    if (!proposal?.id || !window.electronAPI) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.approveDeveloperProposal(proposal.id);
      setProposal((current) => current ? { ...current, state: result.state, lifecycleState: result.lifecycleState } : current);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const rejectProposal = async () => {
    if (!proposal?.id || !window.electronAPI) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.rejectDeveloperProposal(proposal.id);
      setProposal((current) => current ? {
        ...current,
        state: result.state,
        lifecycleState: result.lifecycleState,
        runtime: result.runtime || current.runtime,
      } : current);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal?.id || !window.electronAPI) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.applyDeveloperProposal(proposal.id);
      if (result.state === 'completed') {
        setAppliedPatchLog((previous) => [...previous, {
          proposalId: proposal.id,
          files: proposal.files.map((file) => file.path),
          state: result.state,
          appliedAt: new Date().toISOString(),
          verification: result.verification?.status,
        }]);
      }
      setProposal((current) => current ? {
        ...current,
        state: result.state,
        lifecycleState: result.lifecycleState,
        verification: result.verification,
        outcome: result.outcome,
        error: result.error,
      } : current);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const undoProposal = async () => {
    if (!proposal?.id || !window.electronAPI) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.undoDeveloperProposal(proposal.id);
      setProposal((current) => current ? { ...current, state: result.state } : current);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const togglePreference = (id: string) => {
    setPreferences((previous) => previous.map((preference) => preference.id === id
      ? { ...preference, enabled: !preference.enabled, updatedAt: new Date().toISOString() }
      : preference));
  };

  const clearPreferences = () => setPreferences([]);

  const clearMessages = () => {
    setMessages([]);
    setInput('');
    setActivity([]);
    setProjectCandidates([]);
    setConversationStates((previous) => [{
      id: conversationId,
      messages: messages.map(({ role, content }) => ({ role, content })),
      updatedAt: new Date().toISOString(),
      projectRoot,
      pendingPlan: proposal?.runtime ? { ...proposal.runtime } : null,
      appliedPatchLog,
    }, ...previous.filter((session) => session.id !== conversationId)].slice(0, runtimeConfig.codingSession.maxSessions));
    setConversationId(crypto.randomUUID());
    setProposal(null);
    setPath('.');
  };

  const restoreHistory = (session: {
    id: string;
    messages: CodingMessage[];
    projectRoot?: string | null;
    appliedPatchLog?: CodingPatchRecord[];
    lastUsedProvider?: { id?: string; label?: string; model?: string; changedAt?: string } | null;
  }) => {
    const restored = session.messages.map((message) => ({ ...message, streaming: false }));
    setMessages(restored);
    setConversationId(session.id.replace(/^coding-/, '').split('-turn-')[0] || crypto.randomUUID());
    const conversationState = conversationStates.find((state) => state.id === session.id.replace(/-turn-\d+$/, ''));
    setProjectRoot(conversationState?.projectRoot || session.projectRoot || null);
    setAppliedPatchLog(conversationState?.appliedPatchLog || session.appliedPatchLog || []);
    setLastProvider(conversationState?.lastUsedProvider || session.lastUsedProvider || null);
    setInput('');
  };

  const taskStatus = proposal?.runtime?.taskState?.toLowerCase()
    || proposal?.state
    || (streaming ? 'running' : busy ? 'working' : 'idle');

  const pauseTask = useCallback(async () => {
    if (!proposal?.id || !window.electronAPI?.pauseDeveloperTask) return;
    try {
      await window.electronAPI.pauseDeveloperTask(proposal.id);
      onStatus('Task paused.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError, onStatus, proposal?.id]);

  const resumeTask = useCallback(async (targetPhase?: string) => {
    if (!proposal?.id || !window.electronAPI?.resumeDeveloperTask) return;
    try {
      await window.electronAPI.resumeDeveloperTask(proposal.id, targetPhase);
      onStatus('Task resumed.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError, onStatus, proposal?.id]);

  const steerTask = useCallback(async (direction: string) => {
    if (!proposal?.id || !window.electronAPI?.steerDeveloperTask) return;
    try {
      await window.electronAPI.steerDeveloperTask(proposal.id, { action: 'change_direction', direction });
      onStatus(`Task steered: ${direction}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError, onStatus, proposal?.id]);

  const setTaskMode = useCallback(async (mode: string, complexity?: string) => {
    if (!proposal?.id || !window.electronAPI?.setDeveloperTaskMode) return;
    try {
      await window.electronAPI.setDeveloperTaskMode(proposal.id, mode, complexity);
      onStatus(`Mode set to ${mode}${complexity ? ` (${complexity})` : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError, onStatus, proposal?.id]);

  const assignTaskSkill = useCallback(async (skillId: string) => {
    if (!proposal?.id || !window.electronAPI?.assignDeveloperTaskSkill) return;
    try {
      await window.electronAPI.assignDeveloperTaskSkill(proposal.id, skillId);
      onStatus(`Skill assigned: ${skillId}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError, onStatus, proposal?.id]);

  return {
    workspace: {
      messages, input, projectRoot, projectStatus: projectLifecycleState, projectCandidates,
      onSelectCandidate: (candidate: string) => void attachProjectByPath(candidate),
      onAttachProjectByPath: (targetPath: string) => void attachProjectByPath(targetPath),
      directory, path, filePath, fileContent, searchQuery, searchResults,
      proposal, activity, busy, streaming, errorMessage, statusMessage, taskStatus,
      onPauseTask: () => void pauseTask(), onResumeTask: (phase?: string) => void resumeTask(phase),
      onSteerTask: (dir: string) => void steerTask(dir),
      onSetTaskMode: (mode: string, complexity?: string) => void setTaskMode(mode, complexity),
      onAssignTaskSkill: (skillId: string) => void assignTaskSkill(skillId),
      onInputChange: setInput, onProjectPathChange: setPath,
      onSearchQueryChange: setSearchQuery, onSelectProject: () => void selectProject(),
      onClearProject: () => void clearProject(), onListDirectory: () => void listDirectory(),
      onReadFile: (requestedPath?: string) => void readFile(requestedPath), onSearch: () => void searchCode(),
      onApproveProposal: () => void approveProposal(), onRejectProposal: () => void rejectProposal(),
      onApplyProposal: () => void applyProposal(), onUndoProposal: () => void undoProposal(),
      onSendMessage: () => void sendMessage(), onClearMessages: clearMessages,
      codingPreferences: preferences, onToggleCodingPreference: togglePreference,
      onResetCodingPreferences: clearPreferences,
    },
    restoreHistory,
  };
}
