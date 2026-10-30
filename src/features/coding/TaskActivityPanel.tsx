import { useState, useEffect, useMemo, useCallback } from 'react';

export interface TaskSummaryItem {
  taskId: string;
  title: string;
  status: string;
  terminalStatus?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  projectRoot?: string | null;
  eventCount: number;
  error?: string | null;
}

export interface TaskEventItem {
  sequence: number;
  type: string;
  timestamp: string;
  status?: string;
  operation?: string;
  command?: string;
  exitCode?: number | null;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  proposalId?: string;
  diffExcerpt?: string;
  filesModified?: string[];
  decision?: string;
  reason?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface TaskDetailRecord extends TaskSummaryItem {
  proposal?: Record<string, unknown> | null;
  diffExcerpt?: string | null;
  filesModified: string[];
  testResults: unknown[];
  repairHistory: unknown[];
  verificationEvidence: unknown[];
  events: TaskEventItem[];
}

interface TaskActivityPanelProps {
  projectRoot: string | null;
  activeTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
}

function formatDuration(ms?: number | null): string {
  if (typeof ms !== 'number' || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

function statusBadgeClasses(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'FAILED':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    case 'BLOCKED':
    case 'BLOCKED_ISOLATION':
    case 'NOT_CONFIGURED':
    case 'TEST_NOT_CONFIGURED':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'CANCELLED':
    case 'KILLED':
      return 'bg-slate-500/20 text-slate-400 border-slate-500/40';
    case 'INTERRUPTED':
      return 'bg-purple-500/20 text-purple-300 border-purple-500/40';
    case 'WAITING_FOR_APPROVAL':
    case 'AWAITING_APPROVAL':
      return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40 animate-pulse';
    case 'RUNNING':
    case 'STARTED':
    case 'APPLYING':
    case 'VERIFYING':
    case 'INSPECTING':
      return 'bg-sky-500/20 text-sky-300 border-sky-500/40 animate-pulse';
    default:
      return 'bg-slate-800 text-slate-300 border-slate-700';
  }
}

export function TaskActivityPanel({ projectRoot, activeTaskId, onSelectTask }: TaskActivityPanelProps) {
  const [tasks, setTasks] = useState<TaskSummaryItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(activeTaskId || null);
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetailRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [expandedEvents, setExpandedEvents] = useState<Record<number, boolean>>({});

  const isIpcAvailable = typeof window !== 'undefined' && Boolean(window.electronAPI?.listDeveloperTaskHistory);

  const fetchTaskList = useCallback(async () => {
    if (!window.electronAPI?.listDeveloperTaskHistory) {
      setError('Task history IPC is not available in this environment. Persistent task records are maintained by the desktop application.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.listDeveloperTaskHistory({
        projectRoot: projectRoot || undefined,
        status: statusFilter !== 'ALL' ? statusFilter : undefined,
        search: searchQuery.trim() || undefined,
        limit: 50,
      });
      if (res && Array.isArray(res.tasks)) {
        setTasks(res.tasks);
        if (selectedTaskId && !res.tasks.some((t) => t.taskId === selectedTaskId)) {
          // Keep current selection
        } else if (!selectedTaskId && res.tasks.length > 0) {
          setSelectedTaskId(res.tasks[0].taskId);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectRoot, statusFilter, searchQuery, selectedTaskId]);

  const fetchTaskDetail = useCallback(async (taskId: string) => {
    if (!window.electronAPI?.getDeveloperTaskHistory) return;
    try {
      const detail = await window.electronAPI.getDeveloperTaskHistory(taskId);
      if (detail) {
        setSelectedTaskDetail(detail as TaskDetailRecord);
      }
    } catch (err) {
      console.error('[TaskActivityPanel] Detail error:', err);
    }
  }, []);

  useEffect(() => {
    void fetchTaskList();
  }, [fetchTaskList]);

  useEffect(() => {
    if (activeTaskId) {
      setSelectedTaskId(activeTaskId);
    }
  }, [activeTaskId]);

  useEffect(() => {
    if (selectedTaskId) {
      void fetchTaskDetail(selectedTaskId);
    } else {
      setSelectedTaskDetail(null);
    }
  }, [selectedTaskId, fetchTaskDetail]);

  // Subscribe to live task events from Electron IPC
  useEffect(() => {
    const unsubTaskEvent = window.electronAPI?.onDeveloperTaskEvent?.((data) => {
      if (!data?.taskId) return;
      // Refresh list or update currently selected task
      void fetchTaskList();
      if (selectedTaskId === data.taskId) {
        void fetchTaskDetail(data.taskId);
      }
    });

    const unsubActivity = window.electronAPI?.onDeveloperActivity?.(() => {
      // Periodically refresh on activity
      if (selectedTaskId) {
        void fetchTaskDetail(selectedTaskId);
      }
    });

    return () => {
      unsubTaskEvent?.();
      unsubActivity?.();
    };
  }, [selectedTaskId, fetchTaskList, fetchTaskDetail]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== 'ALL' && t.status !== statusFilter && t.terminalStatus !== statusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return t.taskId.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
      }
      return true;
    });
  }, [tasks, statusFilter, searchQuery]);

  const toggleEventExpanded = (seq: number) => {
    setExpandedEvents((prev) => ({ ...prev, [seq]: !prev[seq] }));
  };

  return (
    <section aria-label="Task Activity and Persistent Logs" className="rounded-lg border border-slate-700 bg-slate-950/60 p-4 font-sans text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-sky-200">Task Activity & Execution History</h2>
          <p className="text-[11px] text-slate-400">
            Persistent, chronological execution records, real stdout/stderr excerpts, and verified approval lifecycles.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchTaskList()}
            disabled={loading}
            className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-sky-500 hover:text-sky-200 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : '↻ Refresh History'}
          </button>
        </div>
      </div>

      {error && (
        <div
          role={isIpcAvailable ? 'alert' : 'status'}
          className={`mb-3 rounded border p-2 text-xs ${
            isIpcAvailable
              ? 'border-rose-500/40 bg-rose-950/40 text-rose-300'
              : 'border-slate-700/80 bg-slate-900/60 text-slate-400'
          }`}
        >
          {error}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Filter by Task ID or Title…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="min-w-[200px] flex-1 rounded border border-slate-800 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-sky-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-300 outline-none focus:border-sky-500"
        >
          <option value="ALL">All Statuses</option>
          <option value="RUNNING">Running / Active</option>
          <option value="WAITING_FOR_APPROVAL">Waiting Approval</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed</option>
          <option value="BLOCKED">Blocked</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="INTERRUPTED">Interrupted</option>
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left Column: Task History List */}
        <div className="lg:col-span-4 max-h-[500px] overflow-y-auto rounded border border-slate-800/80 bg-slate-900/40 p-2 space-y-2">
          {filteredTasks.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-500">
              {tasks.length === 0 ? 'No persistent task history recorded yet.' : 'No tasks match current filter.'}
            </div>
          ) : (
            filteredTasks.map((t) => {
              const isSelected = t.taskId === selectedTaskId;
              return (
                <div
                  key={t.taskId}
                  onClick={() => {
                    setSelectedTaskId(t.taskId);
                    onSelectTask?.(t.taskId);
                  }}
                  className={`cursor-pointer rounded border p-2 text-left transition-colors ${
                    isSelected
                      ? 'border-sky-500 bg-sky-950/30'
                      : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-mono font-semibold ${statusBadgeClasses(t.status)}`}>
                      {t.status}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500">
                      {formatDuration(t.durationMs) || new Date(t.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs font-medium text-slate-200">{t.title}</p>
                  <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-slate-400">
                    <span title={t.taskId} className="truncate max-w-[130px]">ID: {t.taskId}</span>
                    <span>{t.eventCount} events</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Column: Detailed Chronological Timeline & Evidence */}
        <div className="lg:col-span-8 max-h-[500px] overflow-y-auto rounded border border-slate-800/80 bg-slate-900/40 p-3">
          {!selectedTaskDetail ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Select a task from the history list to inspect its chronological log, test runs, and verification evidence.
            </div>
          ) : (
            <div className="space-y-3">
              {/* Task Header */}
              <div className="border-b border-slate-800 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-2 py-0.5 text-[10px] font-mono font-semibold ${statusBadgeClasses(selectedTaskDetail.status)}`}>
                      {selectedTaskDetail.status}
                    </span>
                    <h3 className="text-xs font-semibold text-sky-200">{selectedTaskDetail.title}</h3>
                  </div>
                  <span className="font-mono text-[10px] text-slate-400">
                    Started: {new Date(selectedTaskDetail.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-4 font-mono text-[10px] text-slate-400">
                  <span>Task ID: <code className="text-slate-300">{selectedTaskDetail.taskId}</code></span>
                  {selectedTaskDetail.durationMs && <span>Duration: {formatDuration(selectedTaskDetail.durationMs)}</span>}
                  {selectedTaskDetail.projectRoot && <span>Project: {selectedTaskDetail.projectRoot}</span>}
                </div>
                {selectedTaskDetail.error && (
                  <div className="mt-2 rounded border border-rose-500/30 bg-rose-950/20 p-2 text-xs text-rose-300">
                    <strong>Error:</strong> {selectedTaskDetail.error}
                  </div>
                )}
              </div>

              {/* Proposal and Applied Files Summary */}
              {selectedTaskDetail.filesModified && selectedTaskDetail.filesModified.length > 0 && (
                <div className="rounded border border-slate-800 bg-slate-950/40 p-2 text-xs">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Modified Files:</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selectedTaskDetail.filesModified.map((f) => (
                      <span key={f} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Chronological Event Log Stream */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Chronological Event Stream ({selectedTaskDetail.events.length})
                </h4>
                {selectedTaskDetail.events.map((ev) => {
                  const isExpanded = expandedEvents[ev.sequence] ?? false;
                  const hasDetails = ev.command || ev.stdoutExcerpt || ev.stderrExcerpt || ev.diffExcerpt || ev.error;
                  return (
                    <div
                      key={ev.sequence}
                      className="rounded border border-slate-800/80 bg-slate-950/60 p-2 text-xs font-mono"
                    >
                      <div className="flex items-center justify-between text-[10px] text-slate-500">
                        <span className="text-sky-300 font-semibold">
                          #{ev.sequence} [{ev.type}]
                        </span>
                        <span>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                      </div>

                      {ev.reason && (
                        <p className="mt-0.5 text-slate-300 text-[11px] font-sans">{ev.reason}</p>
                      )}

                      {ev.command && (
                        <div className="mt-1 rounded bg-black/40 p-1 text-[10px] text-slate-300">
                          <span className="text-slate-500">$ </span>
                          <span className="text-emerald-400">{ev.command}</span>
                          {ev.exitCode !== undefined && ev.exitCode !== null && (
                            <span className={`ml-2 rounded px-1 text-[9px] ${ev.exitCode === 0 ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'}`}>
                              exit {ev.exitCode}
                            </span>
                          )}
                        </div>
                      )}

                      {ev.decision && (
                        <div className="mt-1 text-[11px] font-sans">
                          <strong>Decision:</strong>{' '}
                          <span className={ev.decision === 'APPROVED' ? 'text-emerald-400' : 'text-rose-400'}>
                            {ev.decision}
                          </span>
                        </div>
                      )}

                      {hasDetails && (
                        <div className="mt-1">
                          <button
                            type="button"
                            onClick={() => toggleEventExpanded(ev.sequence)}
                            className="text-[10px] text-sky-400 hover:underline"
                          >
                            {isExpanded ? 'Hide output ▲' : 'Show output / details ▼'}
                          </button>
                          {isExpanded && (
                            <div className="mt-1 max-h-40 overflow-auto rounded bg-black/60 p-2 text-[10px] space-y-1">
                              {ev.stdoutExcerpt && (
                                <div>
                                  <span className="text-slate-500">[stdout]</span>
                                  <pre className="whitespace-pre-wrap text-slate-300">{ev.stdoutExcerpt}</pre>
                                </div>
                              )}
                              {ev.stderrExcerpt && (
                                <div>
                                  <span className="text-rose-400">[stderr]</span>
                                  <pre className="whitespace-pre-wrap text-rose-300">{ev.stderrExcerpt}</pre>
                                </div>
                              )}
                              {ev.diffExcerpt && (
                                <div>
                                  <span className="text-slate-500">[diff]</span>
                                  <pre className="whitespace-pre-wrap text-sky-200">{ev.diffExcerpt}</pre>
                                </div>
                              )}
                              {ev.error && (
                                <div className="text-rose-400">
                                  <strong>Error:</strong> {ev.error}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
