export type HistoryMode = 'assistant' | 'developer' | 'general';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HistorySession {
  id: string;
  title: string;
  messages: HistoryMessage[];
  updatedAt: string;
  mode: HistoryMode;
}

const STORAGE_KEY = 'chat-history';
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
