import { useEffect, useRef, useState } from 'react';
import { runtimeConfig } from '../../config/runtimeConfig';
import type { CodingConversationState, CodingPreference } from './codingSessionStore';
import type { CodingActivity } from './codingTransport';

function codingActivityLabel(item: CodingActivity): string {
  if (!('event' in item)) return item.phase;
  switch (item.activityType) {
    case 'SEARCHING': return 'Searching code';
    case 'READING_FILE': return 'Reading file';
    case 'DISCOVERING_REPOSITORY': return 'Discovering repository';
    case 'INSPECTING_SYMBOL': return 'Inspecting symbol';
    case 'TRACING_CALLER': return 'Tracing references';
    case 'VERIFYING': return 'Running verification';
    case 'INSPECTING_DATABASE':
      if (item.action.tool === 'discover_database_configuration') return 'Discovering database configuration';
      if (item.action.tool === 'DATABASE_CONNECT' || item.action.tool === 'DATABASE_CONNECT_TARGET') return 'Connecting to database';
      if (item.action.tool === 'DATABASE_LIST_TABLES') return 'Listing database tables';
      if (item.action.tool === 'DATABASE_DESCRIBE_TABLE') return 'Inspecting database schema';
      if (item.action.tool === 'DATABASE_QUERY' || item.action.tool === 'execute_sql') return 'Executing database query';
      return 'Inspecting database';
    default: return item.action.tool;
  }
}

function codingActivityStatus(item: Extract<CodingActivity, { event: 'activity_event' }>) {
  switch (item.status) {
    case 'STARTED': return { icon: '●', label: 'Running', className: 'text-sky-300' };
    case 'COMPLETED': return { icon: '✓', label: 'Completed', className: 'text-emerald-300' };
    case 'FAILED': return { icon: '✕', label: 'Failed', className: 'text-rose-300' };
    case 'UNVERIFIED': return { icon: '⚠', label: 'Unverified', className: 'text-amber-300' };
    case 'SKIPPED': return { icon: '⊘', label: 'Skipped', className: 'text-slate-400' };
    case 'CANCELLED': return { icon: '○', label: 'Cancelled', className: 'text-slate-400' };
  }
}

function CodingActivityEntry({ item }: { item: CodingActivity }) {
  if (!('event' in item)) {
    return <div className="text-[11px] text-slate-400">
      <p><span className="mr-2 font-semibold text-sky-300">{item.phase}</span>{item.message}</p>
      {item.plan && <div className="ml-2 mt-1 border-l border-slate-700 pl-2">
        <p>{String(item.plan.goal || '')}</p>
        {Array.isArray(item.plan.steps) && <ol className="mt-1 list-inside list-decimal">
          {item.plan.steps.map((step, stepIndex) => <li key={stepIndex}>{String(step)}</li>)}
        </ol>}
      </div>}
    </div>;
  }

  const result = item.result;
  const details = [
    result?.count !== undefined ? `${result.count} results` : undefined,
    result?.rowCount !== undefined ? `${result.rowCount} rows` : undefined,
    result?.lineCount !== undefined ? `${result.lineCount} lines` : undefined,
    result?.databaseType,
    result?.executionStatus,
    result?.exitCode !== undefined && result.exitCode !== null ? `exit ${result.exitCode}` : undefined,
  ].filter(Boolean);
  const status = codingActivityStatus(item);
  return <div className="text-[11px] text-slate-400">
    <p>
      <span className="mr-2 font-semibold text-sky-300">{codingActivityLabel(item)}</span>
      <span className={`mr-2 font-semibold ${status.className}`} aria-label={status.label}>
        {status.icon} {status.label}
      </span>
      {item.action.target && <span>{item.action.target}</span>}
    </p>
    {item.action.reason && <p className="ml-2 mt-1 text-slate-500">{item.action.reason}</p>}
    {details.length > 0 && <p className="ml-2 mt-1 text-slate-300">{details.join(' · ')}</p>}
    {result?.paths && result.paths.length > 0 && <ul className="ml-2 mt-1 list-inside list-disc">
      {result.paths.map((path) => <li key={path}>{path}</li>)}
    </ul>}
    {item.action.expectedEvidence && item.action.expectedEvidence.length > 0 && (
      <p className="ml-2 mt-1 text-slate-500">Evidence sought: {item.action.expectedEvidence.join(', ')}</p>
    )}
    {item.error?.message && <p className="ml-2 mt-1 text-rose-300">{item.error.message}</p>}
    {item.terminalizedLocally && <p className="ml-2 mt-1 text-amber-300">No terminal result was received.</p>}
  </div>;
}

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
  conversations: CodingConversationState[];
  activeConversationId: string;
  onRestoreConversation: (session: CodingConversationState) => void;
  onRequestDeleteConversation: (id: string) => void;
  onCopyMessages: (messages: CodingMessage[], key: string) => Promise<void>;
  copiedItem: string | null;
  codingPreferences: CodingPreference[];
  onToggleCodingPreference: (id: string) => void;
  onResetCodingPreferences: () => void;
}

function renderInlineMarkdown(text: string) {
  const normalized = text.replace(/\\([`*_#|>])/g, '$1');
  const parts = normalized.split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);

  return parts.map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) {
      return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline decoration-sky-500/50 underline-offset-2 hover:text-sky-200">{link[1]}</a>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="rounded bg-slate-800 px-1 py-0.5 text-sky-200">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

export function CodingMarkdown({ content }: { content: string }) {
  const normalizedContent = content
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\\([`*_#|>])/g, '$1')
    .replace(/(^|[ \t])```([\w-]*)[ \t]+(?!(?:#{1,6}\s|[-*]\s|$))/g, '$1\n```$2\n')
    .replace(/([^\n])```(?=[ \t]*(?:#{1,6}\s|[-*]\s|$))/g, '$1\n```\n')
    .replace(/[ \t]+(#{1,6}\s)/g, '\n$1')
    .replace(/[ \t]+(-\s+(?:\*\*|\[[ xX]\]))/g, '\n$1')
    .replace(/[ \t]+(>\s?)/g, '\n$1')
    .replace(/[ \t]*\|[ \t]*(?=\|)/g, ' | ');
  const lines = normalizedContent.split(/\r?\n/);
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      blocks.push(<pre key={`code-${index}`} className="overflow-x-auto rounded-md border border-slate-700 bg-slate-950 p-3 text-xs leading-relaxed text-slate-200"><code className={fence[1] ? `language-${fence[1]}` : undefined}>{code.join('\n')}</code></pre>);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const className = level <= 2 ? 'text-base font-semibold text-slate-100' : 'text-sm font-semibold text-slate-200';
      const children = renderInlineMarkdown(heading[2]);
      blocks.push(level === 1 ? <h1 key={index} className={className}>{children}</h1> : level === 2 ? <h2 key={index} className={className}>{children}</h2> : <h3 key={index} className={className}>{children}</h3>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`} className="list-disc space-y-1 pl-5">{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`} className="list-decimal space-y-1 pl-5">{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`} className="border-l-2 border-sky-500/50 pl-3 text-slate-400">{quote.map((item, quoteIndex) => <span key={quoteIndex} className="block">{renderInlineMarkdown(item)}</span>)}</blockquote>);
      continue;
    }

    const nextLine = lines[index + 1] || '';
    const tableSeparator = nextLine.trim().replace(/^\||\|$/g, '').split('|').map((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
    if (line.includes('|') && tableSeparator.length > 1 && tableSeparator.every(Boolean)) {
      const parseCells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const headers = parseCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(parseCells(lines[index]));
        index += 1;
      }
      blocks.push(
        <div key={`table-${index}`} className="overflow-x-auto rounded-md border border-slate-700">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-slate-800 text-slate-200">
              <tr>{headers.map((header, cellIndex) => <th key={cellIndex} className="border-b border-slate-700 px-3 py-2 font-semibold">{renderInlineMarkdown(header)}</th>)}</tr>
            </thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} className="odd:bg-slate-950/60 even:bg-slate-900/50">
              {headers.map((_, cellIndex) => <td key={cellIndex} className="border-t border-slate-800 px-3 py-2 align-top text-slate-300">{renderInlineMarkdown(row[cellIndex] || '')}</td>)}
            </tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} className="border-slate-700" />);
      index += 1;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^\s*(?:```|#{1,6}\s|[-*]\s+|\d+\.\s+|>)/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`p-${index}`} className="whitespace-pre-wrap break-words">{renderInlineMarkdown(paragraph.join('\n'))}</p>);
  }

  return <div className="space-y-2 text-sm leading-relaxed text-slate-100">{blocks}</div>;
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
  conversations,
  activeConversationId,
  onRestoreConversation,
  onRequestDeleteConversation,
  onCopyMessages,
  copiedItem,
  codingPreferences,
  onToggleCodingPreference,
  onResetCodingPreferences,
}: CodingAgentWorkspaceProps) {
  const isTrustedDesktop = Boolean(window.electronAPI);
  const canSelectProject = isTrustedDesktop || (
    window.location.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && window.location.port === String(runtimeConfig.services.devServer.port)
  );
  const proposalNeedsDecision = Boolean(proposal && ['awaiting_approval', 'approved', 'applying', 'verifying'].includes(proposal.state || ''));
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [copyError, setCopyError] = useState('');
  const lastConversationId = useRef(activeConversationId);
  const olderConversationStates = conversations
    .filter((conversation) => conversation.id !== activeConversationId && conversation.messages.length > 0)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visibleMessages = showAllMessages || messages.length <= 10 ? messages : messages.slice(-10);
  const hiddenMessageCount = messages.length - visibleMessages.length;
  useEffect(() => {
    if (lastConversationId.current === activeConversationId) return;
    lastConversationId.current = activeConversationId;
    setShowAllMessages(false);
  }, [activeConversationId]);
  const copyMessages = async (items: CodingMessage[], key: string) => {
    setCopyError('');
    try {
      await onCopyMessages(items, key);
    } catch {
      setCopyError('Copy failed. Clipboard access was denied by the browser.');
    }
    window.setTimeout(() => setCopyError(''), 2200);
    return key;
  };

  return (
    <>
      {errorMessage && <p role="alert" className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{errorMessage}</p>}
      {statusMessage && <p role="status" className="mb-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">{statusMessage}</p>}
      {!canSelectProject && (
        <p role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Project selection and Coding Agent access require the trusted desktop app. Open it to select a folder; browser folder picks cannot be attached.
        </p>
      )}
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
            {projectRoot || (!canSelectProject ? 'Open the trusted desktop app to select a project.' : projectStatus === 'SELECTING_PROJECT' ? 'Selecting folder…' : projectStatus === 'ATTACHING_PROJECT' ? 'Attaching project…' : 'Mention the project folder in chat for automatic discovery, or select it under Advanced.')}
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
                <button onClick={onSelectProject} disabled={!canSelectProject || busy || streaming} className="rounded-md border border-sky-500/50 px-2 py-1.5 text-[11px] text-sky-300 disabled:opacity-40">Select folder</button>
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

      {olderConversationStates.length > 0 && (
        <details className="mb-3 rounded-lg border border-slate-700 bg-slate-950/50">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-slate-300 hover:text-sky-200">
            Older Coding conversations <span className="text-slate-500">({olderConversationStates.length})</span>
          </summary>
          <div className="max-h-56 space-y-1 overflow-y-auto border-t border-slate-700 p-2">
            {olderConversationStates.map((conversation) => {
              const firstUserMessage = conversation.messages.find((message) => message.role === 'user')?.content || 'Empty conversation';
              return (
                <div key={conversation.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-800/70">
                  <button
                    type="button"
                    onClick={() => { setShowAllMessages(false); onRestoreConversation(conversation); }}
                    disabled={busy || streaming}
                    className="min-w-0 flex-1 text-left disabled:opacity-40"
                    title={firstUserMessage}
                  >
                    <span className="block truncate text-xs text-slate-200">{firstUserMessage.replace(/\s+/g, ' ')}</span>
                    <span className="mt-0.5 block text-[10px] text-slate-500">{new Date(conversation.updatedAt).toLocaleString()} · {conversation.messages.length} messages</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRequestDeleteConversation(conversation.id)}
                    disabled={busy || streaming}
                    className="shrink-0 rounded px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                    aria-label="Delete Coding conversation"
                  >
                    Delete
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">{messages.length ? `${messages.length} messages in this conversation` : 'New conversation'}</p>
        {messages.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void copyMessages(messages, 'coding-all'); }}
              className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-sky-500/60 hover:text-sky-200"
            >
              {copiedItem === 'coding-all' ? 'Copied Markdown' : 'Copy conversation'}
            </button>
            <button
              type="button"
              onClick={() => onRequestDeleteConversation(activeConversationId)}
              disabled={busy || streaming || proposalNeedsDecision}
              className="rounded-md border border-rose-500/30 px-2.5 py-1.5 text-[11px] text-rose-300 hover:border-rose-400/60 disabled:opacity-40"
              title={proposalNeedsDecision ? 'Finish the pending proposal before deleting this conversation.' : 'Delete this conversation'}
            >
              Delete conversation
            </button>
          </div>
        )}
      </div>
      {copyError && <p role="status" className="mb-2 text-[11px] text-rose-300">{copyError}</p>}

      <div className="flex-1 space-y-7 overflow-y-auto px-1 py-2 sm:px-3">
        {messages.length === 0 && <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">Describe a coding task and name its project. I’ll locate the project and inspect relevant files automatically; folder browsing remains optional under Advanced.</p>}
        {hiddenMessageCount > 0 && (
          <button type="button" onClick={() => setShowAllMessages(true)} className="mx-auto block rounded-md border border-slate-700 px-3 py-1.5 text-xs text-sky-300 hover:border-sky-500/50">
            Show {hiddenMessageCount} older messages
          </button>
        )}
        {visibleMessages.map((message) => {
          const messageIndex = messages.indexOf(message);
          const copyKey = `coding-message-${messageIndex}`;
          return <article key={message.requestId || `${message.role}-${messageIndex}`} className={message.role === 'user' ? 'ml-auto max-w-[88%] rounded-2xl border border-slate-700 bg-slate-800/80 px-4 py-3 sm:max-w-[78%]' : 'mr-auto w-full max-w-4xl py-1'}>
          <div className={`mb-2 flex items-center gap-2 ${message.role === 'user' ? 'justify-end' : ''}`}>
            {message.role === 'assistant' && <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full border border-sky-400/30 bg-sky-400/10 text-[10px] font-bold text-sky-200">AI</span>}
            <p className={`text-xs font-semibold ${message.role === 'user' ? 'text-slate-400' : 'text-sky-200'}`}>{message.role === 'user' ? 'You' : 'Coding Agent'}</p>
            {message.content && <button type="button" onClick={() => { void copyMessages([message], copyKey); }} className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:text-sky-200" aria-label={`Copy ${message.role} message`}>{copiedItem === copyKey ? 'Copied' : 'Copy Markdown'}</button>}
          </div>
          {message.content ? <CodingMarkdown content={message.content} /> : message.streaming && <p className="text-sm leading-relaxed text-slate-300">I’m understanding the request and inspecting the relevant files…</p>}
          {message.role === 'assistant' && messageIndex === messages.length - 1 && activity.length > 0 && <div className="mt-3 space-y-2 rounded-md border border-slate-700 bg-slate-900/70 p-2">
            {activity.map((item) => <CodingActivityEntry
              key={'event' in item ? `${item.executionId}:${item.activityId}` : item.id}
              item={item}
            />)}
          </div>}
        </article>;
        })}
        {showAllMessages && messages.length > 10 && (
          <button type="button" onClick={() => setShowAllMessages(false)} className="mx-auto block rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:text-sky-200">
            Collapse older messages
          </button>
        )}
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

      <div className="mt-4 flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-950/80 p-2 shadow-lg">
        <textarea value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSendMessage(); } }} placeholder="Ask about the project or describe a change…" rows={2} className="min-w-0 flex-1 resize-y bg-transparent px-2 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500" />
        <button onClick={onSendMessage} disabled={!input.trim() || streaming || busy || proposalNeedsDecision} title={proposalNeedsDecision ? 'Approve, apply, or reject the pending proposal first.' : undefined} className="rounded-xl bg-sky-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:opacity-40">{streaming || busy ? 'Working…' : 'Send'}</button>
      </div>
      {messages.length > 0 && <button onClick={onClearMessages} disabled={busy || streaming || proposalNeedsDecision} title={proposalNeedsDecision ? 'Finish the pending proposal before starting a new conversation.' : undefined} className="mt-2 self-start text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40">New Coding conversation</button>}
    </>
  );
}
