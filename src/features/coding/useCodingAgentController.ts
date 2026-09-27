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

export interface CodingMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  requestId?: string;
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
  provider: { id?: string; label?: string; model?: string } | null;
  providerId: string | null;
  maxContextChars: number;
  maxHistoryMessages: number;
  maxMessageChars: number;
}

function compactMessageContent(content: string, maxChars: number) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[Earlier content omitted for speed]`;
}

function extractCodingProjectName(request: string): string | null {
  const beforeProject = request.match(/(?:^|[\s"'`])([A-Za-z0-9][A-Za-z0-9._-]{1,127})\s+project\b/i);
  const afterProject = request.match(/\bproject\s+([A-Za-z0-9][A-Za-z0-9._-]{1,127})\b/i);
  return beforeProject?.[1] || afterProject?.[1] || null;
}

async function hashDeveloperContent(content: string) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function useCodingAgentController({
  provider,
  providerId,
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
  const [projectRoot, setProjectRoot] = useState<string | null>(() => savedConversation?.projectRoot || null);
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
    let projectContinuation: string | null = null;
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
      if (!projectName) {
        appendDiscoveryReply('Tell me the project folder name in your message and I’ll look for it in the configured developer folders. You can also choose it under Advanced > Select folder.');
        return;
      }
      setBusy(true);
      try {
        if (!window.electronAPI) throw new Error('Coding project discovery is available in the desktop app.');
        const discovery = await window.electronAPI.discoverDeveloperProject(projectName);
        if (!discovery.projectRoot) {
          setProjectCandidates(discovery.matches);
          appendDiscoveryReply(`I found more than one folder named "${projectName}". Which one should I use?\n${discovery.matches.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`);
          return;
        }
        setProjectCandidates([]);
        currentProjectRoot = discovery.projectRoot;
        if (projectName !== extractCodingProjectName(question)) {
          const originalRequest = [...messages].reverse().find((message) =>
            message.role === 'user' && extractCodingProjectName(message.content),
          );
          if (originalRequest) {
            projectContinuation = `${originalRequest.content}\n\nThe user selected project root: ${currentProjectRoot}. Continue this request and inspect files automatically.`;
          }
        }
        setProjectRoot(currentProjectRoot);
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
    const currentProvider = provider ? { ...provider, changedAt: new Date().toISOString() } : null;
    if (currentProvider && lastProvider && (currentProvider.id !== lastProvider.id || currentProvider.model !== lastProvider.model)) {
      onStatus('Coding session context restored after provider switch.');
    }
    if (currentProvider) setLastProvider(currentProvider);
    setMessages((previous) => [...previous, userMessage, assistantMessage]);
    setInput('');
    setActivity([]);
    setStreaming(true);
    try {
      const transport = transportRef.current;
      if (!transport) throw new Error('Coding Agent transport is unavailable.');
      await transport.send(requestId, conversationHistory, currentScope, providerId, {
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
              if (!turnId || !window.electronAPI) throw new Error('Coding conversation ownership was lost.');
              if (typeof result.provider === 'string' || typeof result.model === 'string') {
                setLastProvider({
                  id: result.provider || undefined,
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
                const latestFiles = await Promise.all(files.map(async (file) => ({
                  path: file.path,
                  content: (await window.electronAPI!.readDeveloperFile(file.path)).content,
                })));
                const snapshots = await Promise.all(latestFiles.map(async (file) => ({
                  path: file.path,
                  hash: await hashDeveloperContent(file.content),
                })));
                if (latestFiles.some((file) => file.content !== sources.get(file.path))) {
                  throw new Error('A file changed after it was inspected. Please send the request again so the proposal uses fresh context.');
                }
                const registered = await window.electronAPI.createDeveloperProposal(result.content, snapshots, null, path, turnId);
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
                  message: result.filesRead.length ? `Read ${result.filesRead.map((file) => file.path).join(', ')}.` : 'No project files were needed for this response.',
                }].slice(-8));
                await transport.markTurn(turnId, 'completed', 'completed', result.filesRead.length);
                setMessages((previous) => previous.map((message) => message.requestId === requestId
                  ? { ...message, content: result.content, streaming: false }
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
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const projectOwnershipLost = errorMessage.includes('Developer project is not owned by this renderer session.');
      const turnId = turnIdsRef.current.get(requestId);
      if (turnId && transportRef.current) {
        await transportRef.current.markTurn(turnId, 'failed', 'transport_error').catch(() => undefined);
      }
      turnIdsRef.current.delete(requestId);
      setStreaming(false);
      if (projectOwnershipLost) {
        setProjectRoot(null);
        setDirectory([]);
        setPath('.');
        setInput(question);
        onError('Project access expired for this desktop window. Select the project folder again under Advanced, then resend your question.');
      }
      setMessages((previous) => previous.map((message) => message.requestId === requestId
        ? {
          ...message,
          content: projectOwnershipLost
            ? 'This project is no longer attached to the current desktop window. Select its folder again, then resend your question.'
            : `Connection error: ${errorMessage}`,
          streaming: false,
        }
        : message));
    }
  };

  const selectProject = async () => {
    if (!window.electronAPI || busy || streaming) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.chooseDeveloperProject();
      if (result.projectRoot) {
        setProjectRoot(result.projectRoot);
        setProjectCandidates([]);
        setPath('.');
        setFileContent('');
        setFilePath('');
        setDirectory(await window.electronAPI.listDeveloperDirectory('.'));
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const clearProject = async () => {
    if (!window.electronAPI || busy || streaming) return;
    setBusy(true);
    try {
      await window.electronAPI.clearDeveloperProject();
      setProjectRoot(null);
      setProjectCandidates([]);
      setDirectory([]);
      setPath('.');
      setFileContent('');
      setFilePath('');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const listDirectory = async () => {
    if (!window.electronAPI || !projectRoot || busy || streaming) return;
    setBusy(true);
    try {
      setDirectory(await window.electronAPI.listDeveloperDirectory(path || '.'));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (requestedPath = path) => {
    if (!window.electronAPI || !projectRoot || !requestedPath || busy || streaming) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.readDeveloperFile(requestedPath);
      setFilePath(result.path);
      setFileContent(result.content);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const searchCode = async () => {
    if (!window.electronAPI || !projectRoot || !searchQuery.trim() || busy || streaming) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.searchDeveloperCode(searchQuery, path);
      setSearchResults(result.results);
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

  return {
    workspace: {
      messages, input, projectRoot, directory, path, filePath, fileContent, searchQuery, searchResults,
      proposal, activity, busy, streaming, errorMessage, statusMessage, onInputChange: setInput, onProjectPathChange: setPath,
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
