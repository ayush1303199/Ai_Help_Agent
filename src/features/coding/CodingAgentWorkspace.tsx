import { renderAnswerMarkdown } from '../../ui/answerMarkdown';
import type { CodingPreference } from '../../history/historyService';

interface CodingMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  requestId?: string;
}

interface SearchResult {
  path: string;
  line: number;
  text: string;
}

interface DiffFile {
  path: string;
  lines: string[];
}

interface Proposal {
  id?: string;
  state?: string;
  lifecycleState?: string;
  files: DiffFile[];
  raw: string;
  searchedFiles: string[];
  verification?: {
    status?: string;
    reason?: string;
    attempts?: Array<{ check?: string; ok?: boolean; classification?: string; extracted?: { file?: string | null; line?: number | null } }>;
  } | null;
  error?: string | null;
  runtime?: {
    phase?: string;
    taskState?: string;
    planVersion?: number;
    history?: Array<{ phase?: string; message?: string; at?: string }>;
    metrics?: { filesRead?: number; filesChanged?: number; verificationRuns?: number; confidence?: string };
  } | null;
}

interface CodingAgentWorkspaceProps {
  messages: CodingMessage[];
  input: string;
  projectRoot: string | null;
  directory: Array<{ name: string; type: 'file' | 'directory' }>;
  path: string;
  filePath: string;
  fileContent: string;
  searchQuery: string;
  searchResults: SearchResult[];
  proposalSearchQuery: string;
  changeRequest: string;
  proposal: Proposal | null;
  busy: boolean;
  streaming: boolean;
  onInputChange: (value: string) => void;
  onProjectPathChange: (value: string) => void;
  onSearchQueryChange: (value: string) => void;
  onProposalSearchQueryChange: (value: string) => void;
  onChangeRequestChange: (value: string) => void;
  onSelectProject: () => void;
  onClearProject: () => void;
  onListDirectory: () => void;
  onReadFile: (path?: string) => void;
  onSearch: () => void;
  onGenerateProposal: () => void;
  onApproveProposal: () => void;
  onApplyProposal: () => void;
  onUndoProposal: () => void;
  onDiscardProposal: () => void;
  onSendMessage: () => void;
  onClearMessages: () => void;
  codingPreferences: CodingPreference[];
  onToggleCodingPreference: (id: string) => void;
  onResetCodingPreferences: () => void;
}

export function CodingAgentWorkspace({
  messages,
  input,
  projectRoot,
  directory,
  path,
  filePath,
  fileContent,
  searchQuery,
  searchResults,
  proposalSearchQuery,
  changeRequest,
  proposal,
  busy,
  streaming,
  onInputChange,
  onProjectPathChange,
  onSearchQueryChange,
  onProposalSearchQueryChange,
  onChangeRequestChange,
  onSelectProject,
  onClearProject,
  onListDirectory,
  onReadFile,
  onSearch,
  onGenerateProposal,
  onApproveProposal,
  onApplyProposal,
  onUndoProposal,
  onDiscardProposal,
  onSendMessage,
  onClearMessages,
  codingPreferences,
  onToggleCodingPreference,
  onResetCodingPreferences,
}: CodingAgentWorkspaceProps) {
  return (
    <>
      <div className="mb-5 rounded-xl border border-slate-700 bg-slate-800/50 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Project</p>
            <p className="truncate text-xs text-slate-300">{projectRoot || 'No project folder selected'}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={onSelectProject} disabled={busy || streaming} className="rounded-md border border-sky-500/50 px-2 py-1.5 text-[11px] text-sky-300 disabled:opacity-40">Select folder</button>
            {projectRoot && <button onClick={onClearProject} disabled={busy || streaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Clear</button>}
          </div>
        </div>
        {projectRoot && <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input value={path} onChange={(event) => onProjectPathChange(event.target.value)} placeholder="Relative path (.)" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
            <button onClick={onListDirectory} disabled={busy || streaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">List</button>
            <button onClick={() => onReadFile()} disabled={busy || streaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Read file</button>
          </div>
          {directory.length > 0 && <div className="max-h-32 overflow-y-auto rounded-md border border-slate-700 bg-slate-950 p-2">{directory.map((entry) => <button key={`${entry.type}-${entry.name}`} onClick={() => onProjectPathChange(path === '.' ? entry.name : `${path.replace(/[\\/]+$/, '')}/${entry.name}`)} className="block w-full truncate px-1 py-1 text-left text-[11px] text-slate-300 hover:text-sky-300">{entry.type === 'directory' ? '📁' : '📄'} {entry.name}</button>)}</div>}
          {filePath && <pre className="max-h-48 overflow-auto rounded-md border border-slate-700 bg-slate-950 p-2 text-[11px] leading-relaxed text-slate-300">{fileContent}</pre>}
          <div className="border-t border-slate-700 pt-2">
            <div className="flex gap-2">
              <input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onSearch(); } }} placeholder="Search filenames and code..." className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
              <button onClick={onSearch} disabled={busy || streaming || !searchQuery.trim()} className="rounded-md border border-sky-500/50 px-2 py-1.5 text-[11px] text-sky-300 disabled:opacity-40">Search</button>
            </div>
            {searchResults.length > 0 && <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-slate-700 bg-slate-950 p-2">{searchResults.map((result, index) => <button key={`${result.path}-${result.line}-${index}`} onClick={() => { onProjectPathChange(result.path); if (result.line > 0) onReadFile(result.path); }} className="block w-full truncate px-1 py-1 text-left text-[11px] text-slate-300 hover:text-sky-300">{result.path}{result.line > 0 ? `:${result.line}` : ''} · {result.text}</button>)}</div>}
          </div>
          <div className="border-t border-slate-700 pt-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Proposal-only code changes</p>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-500">Search and read context is captured twice before the assistant proposes a minimal patch. Nothing is written to disk.</p>
            <input value={proposalSearchQuery} onChange={(event) => onProposalSearchQueryChange(event.target.value)} placeholder="Search query for relevant files" className="mb-2 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
            <textarea value={changeRequest} onChange={(event) => onChangeRequestChange(event.target.value)} placeholder="Describe the code change to propose..." rows={3} className="w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
            <button onClick={onGenerateProposal} disabled={busy || streaming || !proposalSearchQuery.trim() || !changeRequest.trim()} className="mt-2 rounded-md border border-amber-500/50 px-2 py-1.5 text-[11px] text-amber-200 disabled:opacity-40">{busy ? 'Preparing proposal...' : 'Generate proposal'}</button>
          </div>
        </div>}
      </div>
      <section className="mb-5 rounded-xl border border-slate-700 bg-slate-800/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Coding preferences</p><p className="mt-1 text-[11px] text-slate-400">Only explicit recurring style corrections are remembered.</p></div>
          {codingPreferences.length > 0 && <button onClick={onResetCodingPreferences} className="text-[11px] text-rose-300 hover:text-rose-200">Reset all</button>}
        </div>
        {codingPreferences.length === 0 ? <p className="mt-2 text-xs text-slate-500">No saved preferences.</p> : <div className="mt-2 space-y-1">{codingPreferences.map((preference) => <label key={preference.id} className="flex items-start gap-2 text-xs text-slate-300"><input type="checkbox" checked={preference.enabled} onChange={() => onToggleCodingPreference(preference.id)} className="mt-0.5" /><span><span className="mr-2 text-[10px] uppercase text-sky-300">{preference.category}</span>{preference.text}</span></label>)}</div>}
      </section>
      {proposal && (
        <section className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-200">Proposed diff</p>
              <p className="mt-1 text-[11px] text-slate-400">State: {proposal.lifecycleState || proposal.state || 'pending'} · main process validates every file before writing.</p>
              {proposal.runtime && <p className="mt-1 text-[10px] text-emerald-300">Task phase: {proposal.runtime.phase || proposal.runtime.taskState || 'CREATED'} · plan v{proposal.runtime.planVersion || 1}</p>}
            </div>
            <div className="flex items-center gap-2">
              {proposal.state === 'awaiting_approval' && <button onClick={onApproveProposal} disabled={busy} className="rounded-md bg-amber-400 px-2 py-1 text-[11px] font-medium text-slate-950 disabled:opacity-40">Approve</button>}
              {proposal.state === 'approved' && <button onClick={onApplyProposal} disabled={busy} className="rounded-md bg-emerald-400 px-2 py-1 text-[11px] font-medium text-slate-950 disabled:opacity-40">Apply and verify</button>}
              {proposal.state === 'completed' && <button onClick={onUndoProposal} disabled={busy} className="rounded-md border border-rose-400/60 px-2 py-1 text-[11px] text-rose-200 disabled:opacity-40">Undo</button>}
              <button onClick={onDiscardProposal} className="text-[11px] text-slate-400 hover:text-slate-200">Reject / discard</button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Re-read files: {proposal.searchedFiles.join(', ')}</p>
          {proposal.runtime?.metrics && <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-slate-700 bg-slate-950 p-2 text-[10px] text-slate-400 sm:grid-cols-4">
            <span>Files read: {proposal.runtime.metrics.filesRead || 0}</span>
            <span>Files changed: {proposal.runtime.metrics.filesChanged || 0}</span>
            <span>Checks: {proposal.runtime.metrics.verificationRuns || 0}</span>
            <span>Confidence: {proposal.runtime.metrics.confidence || 'LOW'}</span>
          </div>}
          {proposal.runtime?.history && proposal.runtime.history.length > 0 && <div className="mt-3 rounded-md border border-slate-700 bg-slate-950 p-2">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agent activity</p>
            <div className="space-y-1.5">{proposal.runtime.history.slice(-8).map((event, index) => <div key={`${event.phase || 'event'}-${event.at || index}`} className="flex gap-2 text-[10px] text-slate-400">
              <span className="w-28 shrink-0 font-medium text-sky-300">{event.phase || 'EVENT'}</span>
              <span>{event.message || 'Lifecycle event recorded.'}</span>
            </div>)}</div>
          </div>}
          {proposal.files.length > 0 ? <div className="mt-3 space-y-3">{proposal.files.map((file) => <div key={file.path} className="overflow-hidden rounded-md border border-slate-700 bg-slate-950"><p className="border-b border-slate-700 px-2 py-1.5 text-xs font-medium text-slate-200">{file.path}</p><pre className="max-h-80 overflow-auto p-2 text-[11px] leading-relaxed text-slate-300">{file.lines.map((line, index) => <span key={`${file.path}-${index}`} className={`block ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-emerald-500/10 text-emerald-200' : line.startsWith('-') && !line.startsWith('---') ? 'bg-rose-500/10 text-rose-200' : 'text-slate-400'}`}>{line || ' '}</span>)}</pre></div>)}</div> : <pre className="mt-3 overflow-auto rounded-md border border-slate-700 bg-slate-950 p-2 text-[11px] text-slate-300">{proposal.raw || 'No safe changes proposed.'}</pre>}
          {proposal.verification && <div className={`mt-3 rounded-md border p-2 text-[11px] ${proposal.verification.status === 'PASS' || proposal.verification.status === 'NOT_AVAILABLE' ? 'border-emerald-500/30 text-emerald-200' : 'border-rose-500/30 text-rose-200'}`}><p>Verification: {proposal.verification.status || 'UNKNOWN'}</p>{proposal.verification.reason && <p className="mt-1 text-slate-400">{proposal.verification.reason}</p>}{proposal.verification.attempts?.filter((attempt) => !attempt.ok).map((attempt, index) => <p key={`${attempt.check || 'check'}-${index}`} className="mt-1 text-rose-200">{attempt.check || 'check'}: {attempt.classification || 'failed'}{attempt.extracted?.file ? ` · ${attempt.extracted.file}${attempt.extracted.line ? `:${attempt.extracted.line}` : ''}` : ''}</p>)}</div>}
          {proposal.error && <p className="mt-2 text-[11px] text-rose-300">{proposal.error}</p>}
        </section>
      )}
      <div className="flex-1 space-y-4 overflow-y-auto">
        {messages.length === 0 && <p className="rounded-lg border border-dashed border-slate-700 p-5 text-center text-sm text-slate-500">Ask a coding question to get started.</p>}
        {messages.map((message, index) => <article key={message.requestId || `${message.role}-${index}`} className={`rounded-xl border p-4 ${message.role === 'user' ? 'border-slate-700 bg-slate-800/60' : 'border-sky-500/20 bg-slate-950/60'}`}><p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{message.role === 'user' ? 'You' : 'Coding Agent'}</p>{message.role === 'assistant' ? <div className="text-sm leading-relaxed text-slate-100">{renderAnswerMarkdown(message.content || (message.streaming ? 'Thinking...' : 'No answer yet.'))}</div> : <p className="whitespace-pre-wrap text-sm text-slate-200">{message.content}</p>}</article>)}
      </div>
      <div className="mt-5 flex gap-2">
        <input value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSendMessage(); } }} placeholder="Ask a coding question..." className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-sky-400" />
        <button onClick={onSendMessage} disabled={!input.trim() || streaming || busy} className="rounded-lg bg-sky-500 px-4 text-sm font-medium text-slate-950 disabled:opacity-40">Send</button>
      </div>
      {messages.length > 0 && <button onClick={onClearMessages} className="mt-3 self-start text-xs text-slate-400 hover:text-slate-200">Clear coding conversation</button>}
    </>
  );
}
