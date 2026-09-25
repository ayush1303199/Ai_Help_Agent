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

export type CodingPreferenceCategory = 'naming' | 'indentation' | 'comments' | 'error-handling' | 'testing' | 'other';

export interface CodingPreference {
  id: string;
  category: CodingPreferenceCategory;
  text: string;
  enabled: boolean;
  source: 'user_correction';
  createdAt: string;
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
const CODING_PREFERENCES_STORAGE_KEY = 'coding-preferences-v1';
const MAX_SESSIONS = 30;
const MAX_CODING_PREFERENCES = 20;

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

function sanitizePreferenceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!text || /(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+|api[_-]?key|password|secret|token|credential|\.env|\/(?:users|home)\/|[A-Za-z]:\\)/i.test(text)) return null;
  if (/[{};]|```|<script|function\s*\(|=>/i.test(text)) return null;
  return text;
}

function isCodingPreference(value: unknown): value is CodingPreference {
  if (!value || typeof value !== 'object') return false;
  const preference = value as Partial<CodingPreference>;
  return typeof preference.id === 'string'
    && typeof preference.text === 'string'
    && ['naming', 'indentation', 'comments', 'error-handling', 'testing', 'other'].includes(preference.category || '')
    && typeof preference.enabled === 'boolean'
    && preference.source === 'user_correction'
    && typeof preference.createdAt === 'string'
    && typeof preference.updatedAt === 'string';
}

export function readCodingPreferences(): CodingPreference[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CODING_PREFERENCES_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(isCodingPreference).slice(0, MAX_CODING_PREFERENCES) : [];
  } catch {
    return [];
  }
}

export function writeCodingPreferences(preferences: CodingPreference[]): boolean {
  try {
    localStorage.setItem(CODING_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences.slice(0, MAX_CODING_PREFERENCES)));
    return true;
  } catch {
    return false;
  }
}

export function extractCodingPreference(input: string): Pick<CodingPreference, 'category' | 'text'> | null {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!/(?:\balways\b|\bhamesha\b|\bfuture\s+(?:mein|me)\b|\bfrom now on\b|\bprefer\b|\bmujhe pasand\b|\bchahiye\b.*\baage\b|\bainda\b)/i.test(normalized)) return null;
  const text = sanitizePreferenceText(normalized);
  if (!text) return null;
  const lower = text.toLowerCase();
  const category: CodingPreferenceCategory = /camelcase|pascalcase|snake.?case|kebab.?case|naming|naam/i.test(lower) ? 'naming'
    : /indent|spaces?|tabs?/i.test(lower) ? 'indentation'
      : /comment|tippani/i.test(lower) ? 'comments'
        : /error.?handling|exception|try.?catch/i.test(lower) ? 'error-handling'
          : /test|testing|verify|validation/i.test(lower) ? 'testing' : 'other';
  return { category, text };
}

export function upsertCodingPreference(preferences: CodingPreference[], input: Pick<CodingPreference, 'category' | 'text'>): CodingPreference[] {
  const text = sanitizePreferenceText(input.text);
  if (!text) return preferences;
  const existing = preferences.find((item) => item.category === input.category && item.text.toLowerCase() === text.toLowerCase());
  const timestamp = new Date().toISOString();
  if (existing) return preferences.map((item) => item.id === existing.id ? { ...item, text, enabled: true, updatedAt: timestamp } : item);
  return [{ id: `coding-preference-${Date.now()}`, category: input.category, text, enabled: true, source: 'user_correction' as const, createdAt: timestamp, updatedAt: timestamp }, ...preferences].slice(0, MAX_CODING_PREFERENCES);
}

export function codingPreferenceContext(preferences: CodingPreference[]): string {
  return preferences.filter((preference) => preference.enabled).map((preference) => `- [${preference.category}] ${preference.text}`).join('\n').slice(0, 2400);
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
