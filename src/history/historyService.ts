export type HistoryMode = 'assistant' | 'developer' | 'general';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DeveloperPatchRecord {
  proposalId?: string;
  files: string[];
  state: string;
  appliedAt?: string;
  verification?: string;
}

export interface DeveloperSessionMetadata {
  projectRoot?: string | null;
  pendingPlan?: Record<string, unknown> | null;
  appliedPatchLog?: DeveloperPatchRecord[];
  providerNeutralSummary?: string;
  lastUsedProvider?: {
    id?: string;
    label?: string;
    model?: string;
    changedAt?: string;
  } | null;
}

export interface DeveloperConversationState extends DeveloperSessionMetadata {
  id: string;
  messages: HistoryMessage[];
  updatedAt: string;
}

export interface HistorySession {
  id: string;
  title: string;
  messages: HistoryMessage[];
  updatedAt: string;
  mode: HistoryMode;
  projectRoot?: string | null;
  pendingPlan?: Record<string, unknown> | null;
  appliedPatchLog?: DeveloperPatchRecord[];
  providerNeutralSummary?: string;
  lastUsedProvider?: DeveloperSessionMetadata['lastUsedProvider'];
}

const STORAGE_KEY = 'chat-history';
const DEVELOPER_STATE_STORAGE_KEY = 'coding-session-state';
const MAX_SESSIONS = 30;

function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<HistoryMessage>;
  return (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string';
}

function isHistorySession(value: unknown): value is HistorySession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<HistorySession>;
  return typeof session.id === 'string'
    && typeof session.title === 'string'
    && typeof session.updatedAt === 'string'
    && Array.isArray(session.messages)
    && session.messages.every(isHistoryMessage)
    && (session.mode === 'assistant' || session.mode === 'developer' || session.mode === 'general');
}

function isDeveloperConversationState(value: unknown): value is DeveloperConversationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<DeveloperConversationState>;
  return typeof state.id === 'string'
    && typeof state.updatedAt === 'string'
    && Array.isArray(state.messages)
    && state.messages.every(isHistoryMessage);
}

export function readHistory(): HistorySession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistorySession).slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

export function writeHistory(sessions: HistorySession[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
    return true;
  } catch {
    return false;
  }
}

export function readDeveloperConversationStates(): DeveloperConversationState[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DEVELOPER_STATE_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDeveloperConversationState).slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

export function writeDeveloperConversationStates(states: DeveloperConversationState[]): boolean {
  try {
    localStorage.setItem(DEVELOPER_STATE_STORAGE_KEY, JSON.stringify(states.slice(0, MAX_SESSIONS)));
    return true;
  } catch {
    return false;
  }
}

export function upsertDeveloperConversationState(
  states: DeveloperConversationState[],
  state: DeveloperConversationState,
): DeveloperConversationState[] {
  return [state, ...states.filter((item) => item.id !== state.id)].slice(0, MAX_SESSIONS);
}

export function upsertHistory(sessions: HistorySession[], session: HistorySession): HistorySession[] {
  return [session, ...sessions.filter((item) => item.id !== session.id)].slice(0, MAX_SESSIONS);
}

export function removeHistorySession(sessions: HistorySession[], sessionId: string): HistorySession[] {
  return sessions.filter((session) => session.id !== sessionId);
}

export function searchHistory(sessions: HistorySession[], query: string): HistorySession[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  return sessions.filter((session) => session.mode.includes(normalized)
    || session.title.toLowerCase().includes(normalized)
    || session.messages.some((message) => message.content.toLowerCase().includes(normalized)));
}

export function historyTitle(messages: HistoryMessage[]): string {
  const firstQuestion = messages.find((message) => message.role === 'user')?.content.trim() || 'New conversation';
  return firstQuestion.length > 52 ? `${firstQuestion.slice(0, 52)}…` : firstQuestion;
}

export function compactDeveloperSession(
  session: Pick<DeveloperConversationState, 'messages' | 'projectRoot' | 'pendingPlan' | 'appliedPatchLog' | 'providerNeutralSummary'>,
  options: { maxTokens?: number; lastMessageCount?: number } = {},
): {
  messages: HistoryMessage[];
  summary: string;
  projectRoot: string | null;
  pendingPlan: Record<string, unknown> | null;
  appliedPatchLog: DeveloperPatchRecord[];
  compacted: boolean;
  estimatedTokens: number;
} {
  const maxTokens = Math.max(512, Math.min(options.maxTokens || 6000, 12000));
  const lastMessageCount = Math.max(2, Math.min(options.lastMessageCount || 8, 20));
  const estimate = (value: string) => Math.ceil(value.length / 4);
  const rawMessages = session.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const rawTokens = rawMessages.reduce((total, message) => total + estimate(message.content), 0);
  const recent = rawMessages.slice(-lastMessageCount);
  const fallbackSummary = rawMessages
    .slice(0, -lastMessageCount)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')
    .slice(0, 12000);
  const summary = String(session.providerNeutralSummary || fallbackSummary || 'No earlier Coding Agent context.');
  const durableContext = [
    `Project root: ${session.projectRoot || 'not selected'}`,
    `Pending plan: ${JSON.stringify(session.pendingPlan || null)}`,
    `Applied patch log: ${JSON.stringify(session.appliedPatchLog || [])}`,
    `Session summary: ${summary}`,
  ].join('\n');
  const recentTokens = recent.reduce((total, message) => total + estimate(message.content), 0);
  const contextBudget = Math.max(64, maxTokens - recentTokens);
  const contextMessage: HistoryMessage = {
    role: 'assistant',
    content: `[CODING_SESSION_CONTEXT]\n${durableContext.slice(0, contextBudget * 4)}`,
  };
  let messages = [contextMessage, ...recent];
  if (messages.reduce((total, message) => total + estimate(message.content), 0) > maxTokens) {
    const recentBudget = Math.max(64, maxTokens - estimate(contextMessage.content));
    const recentChars = Math.max(1, recentBudget * 4);
    let remainingChars = recentChars;
    const boundedRecent = [...recent].reverse().map((message) => {
      const content = message.content.slice(Math.max(0, message.content.length - remainingChars));
      remainingChars -= content.length;
      return { ...message, content };
    }).reverse();
    messages = [contextMessage, ...boundedRecent];
  }
  let estimatedTokens = messages.reduce((total, message) => total + estimate(message.content), 0);
  while (estimatedTokens > maxTokens) {
    const last = messages[messages.length - 1];
    if (!last || last.content.length === 0) break;
    const overflow = estimatedTokens - maxTokens;
    last.content = last.content.slice(0, Math.max(0, last.content.length - (overflow * 4)));
    estimatedTokens = messages.reduce((total, message) => total + estimate(message.content), 0);
  }
  return {
    messages,
    summary,
    projectRoot: session.projectRoot || null,
    pendingPlan: session.pendingPlan || null,
    appliedPatchLog: session.appliedPatchLog || [],
    compacted: rawTokens > maxTokens,
    estimatedTokens,
  };
}
