import { Bot, Copy, Loader2, Send, Sparkles, Trash2, User } from 'lucide-react';
import type { RefObject } from 'react';
import type { AssistantMessage } from './useAssistantAgentController';
import { ScreenReadingButton } from '../screen-reading/ScreenReadingButton';

interface AssistantAgentWorkspaceProps {
  messages: AssistantMessage[];
  input: string;
  error: string;
  draftImproving: boolean;
  chatStreaming: boolean;
  copiedItem: string;
  scrollRef: RefObject<HTMLDivElement>;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onImproveDraft: () => void;
  onClearChat: () => void;
  onCopyMessage: (content: string, id: string) => void;
  onSuggestion: (value: string) => void;
  screenReading: boolean;
  screenReadingEnabled: boolean;
  onReadScreen: () => void;
}

export function AssistantAgentWorkspace({
  messages,
  input,
  error,
  draftImproving,
  chatStreaming,
  copiedItem,
  scrollRef,
  onInputChange,
  onSend,
  onImproveDraft,
  onClearChat,
  onCopyMessage,
  onSuggestion,
  screenReading,
  screenReadingEnabled,
  onReadScreen,
}: AssistantAgentWorkspaceProps) {
  return (
    <>
      {error && (
        <div role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          <span aria-hidden="true">!</span>
          {error}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400/20 to-teal-500/20">
              <Bot className="h-8 w-8 text-emerald-400" />
            </div>
            <h2 className="mb-2 text-xl font-semibold">Ask me anything</h2>
            <p className="max-w-md text-slate-400">
              Upload a PDF and ask questions about it, or just start chatting. Responses stream in real time.
            </p>
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => onSuggestion('Summarize the key points of a good code review process.')} className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-700">
                Code review tips
              </button>
              <button type="button" onClick={() => onSuggestion('Explain how WebSocket streaming works in simple terms.')} className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-700">
                How WebSocket works
              </button>
            </div>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={message.requestId || `${message.role}-${index}`} className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {message.role === 'assistant' && (
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500">
                <Bot className="h-5 w-5 text-slate-900" />
              </div>
            )}
            <div className={`max-w-[75%] rounded-2xl px-4 py-3 ${message.role === 'user' ? 'rounded-tr-sm bg-emerald-600 text-white' : 'rounded-tl-sm border border-slate-700 bg-slate-800 text-slate-100'}`}>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {message.content || (message.streaming ? '' : '(empty)')}
                {message.streaming && !message.content && <span className="ml-1 inline-flex gap-1" aria-label="Assistant is responding"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:150ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:300ms]" /></span>}
                {message.streaming && message.content && <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-emerald-400 align-middle" />}
              </p>
              <button type="button" onClick={() => onCopyMessage(message.content, `message-${index}`)} disabled={!message.content} className={`mt-2 flex items-center gap-1 text-[11px] disabled:opacity-40 ${message.role === 'user' ? 'text-emerald-100/80 hover:text-white' : 'text-slate-400 hover:text-emerald-300'}`} title="Copy message">
                <Copy className="h-3 w-3" />{copiedItem === `message-${index}` ? 'Copied' : 'Copy'}
              </button>
            </div>
            {message.role === 'user' && (
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-700">
                <User className="h-5 w-5 text-slate-300" />
              </div>
            )}
          </div>
        ))}
        <ScreenReadingButton
          chatStreaming={chatStreaming}
          onReadScreen={onReadScreen}
          screenReading={screenReading}
          enabled={screenReadingEnabled}
        />
      </div>
      <div className="mt-4 flex items-end gap-2">
        <button type="button" onClick={onClearChat} className="flex-shrink-0 rounded-xl border border-slate-700 bg-slate-800 p-3 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200" title="Clear chat">
          <Trash2 className="h-5 w-5" />
        </button>
        <div className="flex flex-1 items-end gap-2">
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
            rows={1}
            className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 transition-all focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            style={{ maxHeight: '120px' }}
          />
          <button type="button" onClick={onImproveDraft} disabled={!input.trim() || draftImproving || chatStreaming} className="flex-shrink-0 rounded-xl border border-slate-700 bg-slate-800 p-3 text-emerald-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40" title="Improve draft with AI">
            {draftImproving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
          </button>
          <button type="button" onClick={onSend} disabled={!input.trim() || chatStreaming || draftImproving} className="flex-shrink-0 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 p-3 text-slate-900 shadow-lg shadow-emerald-500/20 transition-all hover:from-emerald-400 hover:to-teal-500 disabled:cursor-not-allowed disabled:opacity-40">
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>
    </>
  );
}
