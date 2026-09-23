import { Search, X } from 'lucide-react';
import type { HistorySession } from '../../history/historyService';

interface ChatHistoryModalProps {
  sessions: HistorySession[];
  filteredSessions: HistorySession[];
  search: string;
  copiedItem: string;
  hasCurrentMessages: boolean;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onNewChat: () => void;
  onCopyChat: () => void;
  onDeleteAll: () => void;
  onOpenSession: (session: HistorySession) => void;
  onDeleteSession: (session: HistorySession) => void;
}

export function ChatHistoryModal({
  sessions,
  filteredSessions,
  search,
  copiedItem,
  hasCurrentMessages,
  onSearchChange,
  onClose,
  onNewChat,
  onCopyChat,
  onDeleteAll,
  onOpenSession,
  onDeleteSession,
}: ChatHistoryModalProps) {
  const preview = (session: HistorySession, role: 'user' | 'assistant') => {
    const message = [...session.messages].reverse().find((item) => item.role === role)?.content.trim() || '';
    if (!message) return role === 'user' ? 'No question saved' : 'No AI response saved';
    return message.length > 110 ? `${message.slice(0, 110)}…` : message;
  };

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-3 py-4 backdrop-blur-sm sm:px-4 sm:py-8" role="presentation" onMouseDown={onClose}>
      <div className="my-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-2xl sm:p-5" role="dialog" aria-modal="true" aria-label="Chat history" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Chat history</h2>
            <p className="text-xs text-slate-400">Saved locally on this device</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close chat history" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search all conversations..." className="min-w-0 flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-500" />
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" onClick={onNewChat} className="flex-1 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-emerald-400">New chat</button>
          <button type="button" onClick={onCopyChat} disabled={!hasCurrentMessages} className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:border-emerald-400 disabled:opacity-40">{copiedItem === 'conversation' ? 'Copied' : 'Copy chat'}</button>
          <button type="button" onClick={onDeleteAll} disabled={!sessions.length} className="rounded-lg border border-rose-500/50 px-3 py-2 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-40">Delete all</button>
        </div>
        {sessions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">Completed conversations appear here.</p>
        ) : filteredSessions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">No matching conversation.</p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {filteredSessions.map((session) => (
              <div key={session.id} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 hover:border-emerald-400">
                <button type="button" onClick={() => onOpenSession(session)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm text-slate-200">{session.title}</span>
                  <span className="mt-1 block text-[11px] uppercase text-slate-500">{session.mode} · {new Date(session.updatedAt).toLocaleString()}</span>
                  <span className="mt-2 block truncate text-[11px] text-slate-400"><strong className="text-slate-300">You:</strong> {preview(session, 'user')}</span>
                  <span className="block truncate text-[11px] text-emerald-200/80"><strong className="text-emerald-300">AI:</strong> {preview(session, 'assistant')}</span>
                </button>
                <button type="button" onClick={() => onDeleteSession(session)} aria-label={`Delete ${session.title}`} className="shrink-0 rounded-md px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10 hover:text-rose-200">Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
