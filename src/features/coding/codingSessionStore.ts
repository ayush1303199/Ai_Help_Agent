import { runtimeConfig } from '../../config/runtimeConfig';

export interface CodingHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CodingPatchRecord {
  proposalId?: string;
  files: string[];
  state: string;
  appliedAt?: string;
  verification?: string;
}

export interface CodingConversationState {
  id: string;
  messages: CodingHistoryMessage[];
  updatedAt: string;
  projectRoot?: string | null;
  pendingPlan?: Record<string, unknown> | null;
  appliedPatchLog?: CodingPatchRecord[];
  providerNeutralSummary?: string;
  lastUsedProvider?: { id?: string; label?: string; model?: string; changedAt?: string } | null;
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

const SESSION_KEY = 'coding-session-state';
const PREFERENCES_KEY = 'coding-preferences-v1';
const MAX_SESSIONS = runtimeConfig.codingSession.maxSessions;
const MAX_PREFERENCES = runtimeConfig.codingSession.maxPreferences;

function isMessage(value: unknown): value is CodingHistoryMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CodingHistoryMessage>;
  return (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string';
}

function isConversation(value: unknown): value is CodingConversationState {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CodingConversationState>;
  return typeof item.id === 'string'
    && typeof item.updatedAt === 'string'
    && Array.isArray(item.messages)
    && item.messages.every(isMessage);
}

function sanitizePreferenceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, runtimeConfig.codingSession.maxPreferenceChars);
  if (!text || /(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+|api[_-]?key|password|secret|token|credential|\.env|\/(?:users|home)\/|[A-Za-z]:\\)/i.test(text)) return null;
  if (/[{};]|```|<script|function\s*\(|=>/i.test(text)) return null;
  return text;
}

export function readCodingConversationStates(): CodingConversationState[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(isConversation).slice(0, MAX_SESSIONS) : [];
  } catch {
    return [];
  }
}

export function writeCodingConversationStates(states: CodingConversationState[]): boolean {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(states.slice(0, MAX_SESSIONS)));
    return true;
  } catch {
    return false;
  }
}

export function upsertCodingConversationState(
  states: CodingConversationState[],
  state: CodingConversationState,
): CodingConversationState[] {
  return [state, ...states.filter((item) => item.id !== state.id)].slice(0, MAX_SESSIONS);
}

export function readCodingPreferences(): CodingPreference[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is CodingPreference => {
      if (!value || typeof value !== 'object') return false;
      const item = value as Partial<CodingPreference>;
      return typeof item.id === 'string'
        && typeof item.text === 'string'
        && ['naming', 'indentation', 'comments', 'error-handling', 'testing', 'other'].includes(item.category || '')
        && typeof item.enabled === 'boolean'
        && item.source === 'user_correction'
        && typeof item.createdAt === 'string'
        && typeof item.updatedAt === 'string';
    }).slice(0, MAX_PREFERENCES);
  } catch {
    return [];
  }
}

export function writeCodingPreferences(preferences: CodingPreference[]): boolean {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences.slice(0, MAX_PREFERENCES)));
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

export function upsertCodingPreference(
  preferences: CodingPreference[],
  input: Pick<CodingPreference, 'category' | 'text'>,
): CodingPreference[] {
  const text = sanitizePreferenceText(input.text);
  if (!text) return preferences;
  const existing = preferences.find((item) => item.category === input.category && item.text.toLowerCase() === text.toLowerCase());
  const timestamp = new Date().toISOString();
  if (existing) return preferences.map((item) => item.id === existing.id ? { ...item, text, enabled: true, updatedAt: timestamp } : item);
  return [{
    id: `coding-preference-${Date.now()}`,
    category: input.category,
    text,
    enabled: true,
    source: 'user_correction' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  }, ...preferences].slice(0, MAX_PREFERENCES);
}

export function codingPreferenceContext(preferences: CodingPreference[]): string {
  return preferences.filter((preference) => preference.enabled)
    .map((preference) => `- [${preference.category}] ${preference.text}`).join('\n').slice(0, runtimeConfig.codingSession.maxPreferenceContextChars);
}

export function compactCodingConversation(
  session: Pick<CodingConversationState, 'messages' | 'projectRoot' | 'pendingPlan' | 'appliedPatchLog' | 'providerNeutralSummary'>,
  options: { maxTokens?: number; lastMessageCount?: number } = {},
) {
  const {
    minContextTokens, defaultContextTokens, maxContextTokens,
    minRecentMessages, defaultRecentMessages, maxRecentMessages,
    maxStoredContextChars, minContextBudgetTokens,
  } = runtimeConfig.codingSession;
  const maxTokens = Math.max(minContextTokens, Math.min(options.maxTokens || defaultContextTokens, maxContextTokens));
  const lastMessageCount = Math.max(minRecentMessages, Math.min(options.lastMessageCount || defaultRecentMessages, maxRecentMessages));
  const estimate = (value: string) => Math.ceil(value.length / 4);
  const rawMessages = session.messages.map((message) => ({ role: message.role, content: message.content }));
  const rawTokens = rawMessages.reduce((total, message) => total + estimate(message.content), 0);
  const recent = rawMessages.slice(-lastMessageCount);
  const summary = String(session.providerNeutralSummary || rawMessages
    .slice(0, -lastMessageCount)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n').slice(0, maxStoredContextChars) || 'No earlier Coding Agent context.');
  const durableContext = [
    `Project root: ${session.projectRoot || 'not selected'}`,
    `Pending plan: ${JSON.stringify(session.pendingPlan || null)}`,
    `Applied patch log: ${JSON.stringify(session.appliedPatchLog || [])}`,
    `Session summary: ${summary}`,
  ].join('\n');
  const contextBudget = Math.max(minContextBudgetTokens, maxTokens - recent.reduce((total, message) => total + estimate(message.content), 0));
  const contextMessage: CodingHistoryMessage = {
    role: 'assistant',
    content: `[CODING_SESSION_CONTEXT]\n${durableContext.slice(0, contextBudget * 4)}`,
  };
  const messages = [contextMessage, ...recent];
  let estimatedTokens = messages.reduce((total, message) => total + estimate(message.content), 0);
  while (estimatedTokens > maxTokens) {
    const last = messages[messages.length - 1];
    if (!last || !last.content.length) break;
    last.content = last.content.slice(0, Math.max(0, last.content.length - (estimatedTokens - maxTokens) * 4));
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
