import type { CodingPreference } from './codingSessionStore';
import type { CodingActivity } from './codingTransport';

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
  projectStatus?: string;
  projectCandidates?: string[];
  directory: Array<{ name: string; type: 'file' | 'directory' }>;
  path: string;
  filePath: string;
  fileContent: string;
  searchQuery: string;
  searchResults: SearchResult[];
  proposal: Proposal | null;
  activity: CodingActivity[];
  busy: boolean;
  streaming: boolean;
  errorMessage?: string;
  statusMessage?: string;
  onInputChange: (value: string) => void;
  onProjectPathChange: (value: string) => void;
  onSearchQueryChange: (value: string) => void;
  onSelectProject: () => void;
  onSelectCandidate?: (candidate: string) => void;
  onAttachProjectByPath?: (targetPath: string) => void;
  onClearProject: () => void;
  onListDirectory: () => void;
  onReadFile: (path?: string) => void;
  onSearch: () => void;
  onApproveProposal: () => void;
  onRejectProposal: () => void;
  onApplyProposal: () => void;
  onUndoProposal: () => void;
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
  projectStatus,
  projectCandidates = [],
  directory,
  path,
  filePath,
  fileContent,
  searchQuery,
  searchResults,
  proposal,
  activity,
  busy,
  streaming,
  errorMessage,
  statusMessage,
  onInputChange,
  onProjectPathChange,
  onSearchQueryChange,
  onSelectProject,
  onSelectCandidate,
  onClearProject,
  onListDirectory,
  onReadFile,
  onSearch,
  onApproveProposal,
  onRejectProposal,
  onApplyProposal,
  onUndoProposal,
  onSendMessage,
  onClearMessages,
  codingPreferences,
  onToggleCodingPreference,
  onResetCodingPreferences,
}: CodingAgentWorkspaceProps) {
  const proposalNeedsDecision = Boolean(proposal && ['awaiting_approval', 'approved', 'applying', 'verifying'].includes(proposal.state || ''));

  return (
    <>
      {errorMessage && <p role="alert" className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{errorMessage}</p>}
      {statusMessage && <p role="status" className="mb-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">{statusMessage}</p>}
      <header className="mb-4 flex items-center justify-between gap-3 border-b border-slate-700 pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">Coding Agent</p>
            {projectStatus && projectStatus !== 'NO_PROJECT' && (
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider ${
                projectStatus === 'PROJECT_ATTACHED'
                  ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : projectStatus === 'PROJECT_MISSING' || projectStatus === 'ATTACH_FAILED'
                  ? 'border border-rose-500/40 bg-rose-500/10 text-rose-300'
                  : projectStatus === 'PROJECT_DETACHED'
                  ? 'border border-amber-500/40 bg-amber-500/10 text-amber-300'
                  : 'border border-sky-500/40 bg-sky-500/10 text-sky-300'
              }`}>
                {projectStatus}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-slate-400">
            {projectRoot || (projectStatus === 'SELECTING_PROJECT' ? 'Selecting folder…' : projectStatus === 'ATTACHING_PROJECT' ? 'Attaching project…' : 'Mention the project folder in chat for automatic discovery, or select it under Advanced.')}
          </p>
          {projectRoot && <p className="mt-1 text-[11px] text-sky-300">Scope: {path || '.'}</p>}
        </div>
        <details className="relative shrink-0">
          <summary className="cursor-pointer list-none rounded-md border border-slate-600 px-3 py-2 text-xs text-slate-300 hover:border-sky-400">
            Advanced
          </summary>
          <div className="absolute right-0 z-20 mt-2 max-h-[70vh] w-[min(92vw,34rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Project tools</p>
                <p className="truncate text-xs text-slate-300">{projectRoot || 'No project selected'}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button onClick={onSelectProject} disabled={busy || streaming} className="rounded-md border border-sky-500/50 px-2 py-1.5 text-[11px] text-sky-300 disabled:opacity-40">Select folder</button>
                {projectRoot && <button onClick={onClearProject} disabled={busy || streaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Clear</button>}
              </div>
            </div>
            {projectCandidates.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">Matching projects found</p>
                <p className="mt-1 text-xs text-amber-200/80">Click a project folder to attach it to the Coding Agent:</p>
                <div className="mt-2 space-y-1">
                  {projectCandidates.map((cand) => (
                    <button
                      key={cand}
                      onClick={() => onSelectCandidate?.(cand)}
                      disabled={busy || streaming}
                      className="block w-full truncate rounded-md bg-slate-950 px-2 py-1.5 text-left text-xs text-sky-300 hover:bg-slate-800 disabled:opacity-40"
                    >
                      📁 {cand}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {projectRoot && <div className="mt-3 space-y-3">
              <div className="flex gap-2">
                <input value={path} onChange={(event) => onProjectPathChange(event.target.value)} placeholder="Optional relative scope (.)" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
                <button onClick={onListDirectory} disabled={busy || streaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">List</button>
                <button onClick={() => onReadFile()} disabled={busy || streaming} className="rounded-md border border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Read file</button>
              </div>
              {directory.length > 0 && <div className="max-h-32 overflow-y-auto rounded-md border border-slate-700 bg-slate-950 p-2">{directory.map((entry) => <button key={`${entry.type}-${entry.name}`} onClick={() => { const nextPath = path === '.' ? entry.name : `${path.replace(/[\\/]+$/, '')}/${entry.name}`; if (entry.type === 'directory') onProjectPathChange(nextPath); else onReadFile(nextPath); }} className="block w-full truncate px-1 py-1 text-left text-[11px] text-slate-300 hover:text-sky-300">{entry.type === 'directory' ? '📁' : '📄'} {entry.name}</button>)}</div>}
              {filePath && <pre className="max-h-40 overflow-auto rounded-md border border-slate-700 bg-slate-950 p-2 text-[11px] leading-relaxed text-slate-300">{fileContent}</pre>}
              <div className="flex gap-2">
                <input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onSearch(); } }} placeholder="Manual filename/code search" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-400" />
                <button onClick={onSearch} disabled={busy || streaming || !searchQuery.trim()} className="rounded-md border border-sky-500/50 px-2 py-1.5 text-[11px] text-sky-300 disabled:opacity-40">Search</button>
              </div>
              {searchResults.length > 0 && <div className="max-h-32 overflow-y-auto rounded-md border border-slate-700 bg-slate-950 p-2">{searchResults.map((result, index) => <button key={`${result.path}-${result.line}-${index}`} onClick={() => onReadFile(result.path)} className="block w-full truncate px-1 py-1 text-left text-[11px] text-slate-300 hover:text-sky-300">{result.path}{result.line > 0 ? `:${result.line}` : ''} · {result.text}</button>)}</div>}
            </div>}
            <div className="mt-4 border-t border-slate-700 pt-3">
              <div className="flex items-center justify-between gap-2">
                <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Coding preferences</p><p className="mt-1 text-[11px] text-slate-400">Only explicit recurring style corrections are remembered.</p></div>
                {codingPreferences.length > 0 && <button onClick={onResetCodingPreferences} className="text-[11px] text-rose-300 hover:text-rose-200">Reset all</button>}
              </div>
              {codingPreferences.length === 0 ? <p className="mt-2 text-xs text-slate-500">No saved preferences.</p> : <div className="mt-2 space-y-1">{codingPreferences.map((preference) => <label key={preference.id} className="flex items-start gap-2 text-xs text-slate-300"><input type="checkbox" checked={preference.enabled} onChange={() => onToggleCodingPreference(preference.id)} className="mt-0.5" /><span><span className="mr-2 text-[10px] uppercase text-sky-300">{preference.category}</span>{preference.text}</span></label>)}</div>}
            </div>
          </div>
        </details>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto">
        {messages.length === 0 && <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">Describe a coding task and name its project. I’ll locate the project and inspect relevant files automatically; folder browsing remains optional under Advanced.</p>}
        {messages.map((message, index) => <article key={message.requestId || `${message.role}-${index}`} className={`rounded-xl border p-4 ${message.role === 'user' ? 'border-slate-700 bg-slate-800/60' : 'border-sky-500/20 bg-slate-950/60'}`}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{message.role === 'user' ? 'You' : 'Coding Agent'}</p>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">{message.content || (message.streaming ? 'I’m understanding the request and inspecting the relevant files…' : '')}</p>
          {message.role === 'assistant' && index === messages.length - 1 && activity.length > 0 && <div className="mt-3 space-y-2 rounded-md border border-slate-700 bg-slate-900/70 p-2">
            {activity.slice(-8).map((item, activityIndex) => <div key={`${item.phase}-${activityIndex}`} className="text-[11px] text-slate-400"><p><span className="mr-2 font-semibold text-sky-300">{item.phase}</span>{item.message}</p>{item.plan && <div className="ml-2 mt-1 border-l border-slate-700 pl-2"><p>{String(item.plan.goal || '')}</p>{Array.isArray(item.plan.steps) && <ol className="mt-1 list-inside list-decimal">{item.plan.steps.map((step, stepIndex) => <li key={stepIndex}>{String(step)}</li>)}</ol>}</div>}</div>)}
          </div>}
        </article>)}
      {proposal && <article className="rounded-xl border border-sky-500/20 bg-slate-950/60 p-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Coding Agent</p>
        <p className="mb-3 text-sm leading-relaxed text-slate-100">Here is the proposed change for review. Nothing is written until you approve it.</p>
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-200">Proposed diff · {proposal.state === 'cancelled' ? 'rejected' : proposal.lifecycleState || proposal.state || 'pending'}</p>
            <p className="mt-1 text-[11px] text-slate-400">Reviewed files: {proposal.searchedFiles.join(', ')}</p>
            {proposal.runtime && <p className="mt-1 text-[10px] text-emerald-300">Pipeline: {proposal.runtime.phase || proposal.runtime.taskState || 'proposal'} · plan v{proposal.runtime.planVersion || 1}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {proposal.state === 'awaiting_approval' && <button onClick={onApproveProposal} disabled={busy} className="rounded-md bg-amber-400 px-2.5 py-1.5 text-[11px] font-medium text-slate-950 disabled:opacity-40">Approve</button>}
            {proposal.state === 'approved' && <button onClick={onApplyProposal} disabled={busy} className="rounded-md bg-emerald-400 px-2.5 py-1.5 text-[11px] font-medium text-slate-950 disabled:opacity-40">Apply and verify</button>}
            {proposal.state === 'completed' && <button onClick={onUndoProposal} disabled={busy} className="rounded-md border border-rose-400/60 px-2.5 py-1.5 text-[11px] text-rose-200 disabled:opacity-40">Undo</button>}
            {proposal.state === 'awaiting_approval' && <button onClick={onRejectProposal} disabled={busy} className="rounded-md border border-slate-600 px-2.5 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">Reject</button>}
          </div>
        </div>
        {proposal.runtime?.metrics && <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-slate-700 bg-slate-950 p-2 text-[10px] text-slate-400 sm:grid-cols-4">
          <span>Files read: {proposal.runtime.metrics.filesRead || 0}</span><span>Files changed: {proposal.runtime.metrics.filesChanged || 0}</span><span>Checks: {proposal.runtime.metrics.verificationRuns || 0}</span><span>Confidence: {proposal.runtime.metrics.confidence || 'LOW'}</span>
        </div>}
        {proposal.files.length > 0 ? <div className="mt-3 space-y-3">{proposal.files.map((file) => <div key={file.path} className="overflow-hidden rounded-md border border-slate-700 bg-slate-950"><p className="border-b border-slate-700 px-2 py-1.5 text-xs font-medium text-slate-200">{file.path}</p><pre className="max-h-80 overflow-auto p-2 text-[11px] leading-relaxed">{file.lines.map((line, lineIndex) => <span key={`${file.path}-${lineIndex}`} className={`block ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-emerald-500/10 text-emerald-200' : line.startsWith('-') && !line.startsWith('---') ? 'bg-rose-500/10 text-rose-200' : 'text-slate-400'}`}>{line || ' '}</span>)}</pre></div>)}</div> : <pre className="mt-3 overflow-auto rounded-md border border-slate-700 bg-slate-950 p-2 text-[11px] text-slate-300">{proposal.raw || 'No safe changes proposed.'}</pre>}
        {proposal.verification && <div className={`mt-3 rounded-md border p-2 text-[11px] ${proposal.verification.status === 'PASS' || proposal.verification.status === 'NOT_AVAILABLE' ? 'border-emerald-500/30 text-emerald-200' : 'border-rose-500/30 text-rose-200'}`}><p>Verification: {proposal.verification.status || 'UNKNOWN'}</p>{proposal.verification.reason && <p className="mt-1 text-slate-400">{proposal.verification.reason}</p>}{proposal.verification.attempts?.filter((attempt) => !attempt.ok).map((attempt, attemptIndex) => <p key={`${attempt.check || 'check'}-${attemptIndex}`} className="mt-1 text-rose-200">{attempt.check || 'check'}: {attempt.classification || 'failed'}{attempt.extracted?.file ? ` · ${attempt.extracted.file}${attempt.extracted.line ? `:${attempt.extracted.line}` : ''}` : ''}</p>)}</div>}
        {proposal.error && <p className="mt-2 text-[11px] text-rose-300">{proposal.error}</p>}
        </section>
      </article>}
      </div>

      <div className="mt-4 flex items-end gap-2">
        <textarea value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSendMessage(); } }} placeholder="Describe what to fix, explain, or improve…" rows={2} className="min-w-0 flex-1 resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-sky-400" />
        <button onClick={onSendMessage} disabled={!input.trim() || streaming || busy || proposalNeedsDecision} title={proposalNeedsDecision ? 'Approve, apply, or reject the pending proposal first.' : undefined} className="rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-slate-950 disabled:opacity-40">{streaming || busy ? 'Working…' : 'Send'}</button>
      </div>
      {messages.length > 0 && <button onClick={onClearMessages} disabled={busy || streaming || proposalNeedsDecision} title={proposalNeedsDecision ? 'Finish the pending proposal before starting a new conversation.' : undefined} className="mt-2 self-start text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40">New Coding conversation</button>}
    </>
  );
}
