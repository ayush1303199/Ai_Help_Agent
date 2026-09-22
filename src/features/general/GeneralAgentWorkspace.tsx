import { Loader2 } from 'lucide-react';
import { renderAnswerMarkdown } from '../../ui/answerMarkdown';

interface GeneralAgentWorkspaceProps {
  generalTask: GeneralTaskState | null;
  generalGoal: string;
  generalClarification: string;
  generalFollowUp: string;
  generalBusy: boolean;
  generalTaskActive: boolean;
  onGoalChange: (value: string) => void;
  onClarificationChange: (value: string) => void;
  onFollowUpChange: (value: string) => void;
  onStartTask: () => void;
  onRetry: () => void;
  onRevise: () => void;
  onTogglePause: () => void;
  onStop: () => void;
  onNewTask: () => void;
  generalUserStatus: (task: GeneralTaskState) => string;
  generalUserProgressMessage: (message?: string | null) => string;
  generalUserFailureMessage: (category?: string | null) => string;
  generalSafeObservationSummary: (observation: Record<string, unknown> | null | undefined) => string;
}

export function GeneralAgentWorkspace({
  generalTask,
  generalGoal,
  generalClarification,
  generalFollowUp,
  generalBusy,
  generalTaskActive,
  onGoalChange,
  onClarificationChange,
  onFollowUpChange,
  onStartTask,
  onRetry,
  onRevise,
  onTogglePause,
  onStop,
  onNewTask,
  generalUserStatus,
  generalUserProgressMessage,
  generalUserFailureMessage,
  generalSafeObservationSummary,
}: GeneralAgentWorkspaceProps) {
  return (
    <>
      {!generalTask && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
          <textarea
            value={generalGoal}
            onChange={(event) => onGoalChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onStartTask(); } }}
            placeholder="Type naturally..."
            rows={3}
            className="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-400"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-slate-500">No external action is taken without your confirmation.</p>
            <button onClick={onStartTask} disabled={!generalGoal.trim() || generalBusy} className="flex items-center gap-2 rounded-md bg-violet-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-violet-400 disabled:opacity-40">{generalBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Send</button>
          </div>
        </div>
      )}
      {generalTask && (
        <div className="space-y-4">
          <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-100">{generalTask.goal}</p>
              </div>
            </div>
            <p className="mt-3 rounded-lg border border-violet-500/20 bg-slate-950/40 px-3 py-2 text-xs text-violet-100">{generalUserStatus(generalTask)}</p>
            {generalBusy && (
              <div className="mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-100">
                {generalUserProgressMessage(generalTask.progressMessage)}
              </div>
            )}
            {generalTask.assistantResponse?.status === 'COMPLETED' && generalTask.assistantResponse.content && (
              <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Live agent answer</p>
                  <span className="text-[10px] text-slate-500">
                    {generalTask.assistantResponse.evidenceAvailable ? 'Browser evidence captured' : 'No browser evidence'}
                  </span>
                </div>
                <div className="mt-2 text-sm leading-relaxed text-slate-100">
                  {renderAnswerMarkdown(generalTask.assistantResponse.content)}
                </div>
                <p className="mt-2 text-[10px] text-slate-500">Source: {generalTask.assistantResponse.evidenceAvailable ? 'Verified from the current page.' : 'Live provider response.'}</p>
              </div>
            )}
            {generalTask.providerError && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">The request was not completed</p>
                  <button onClick={onRetry} disabled={generalBusy} className="rounded-md border border-amber-300/50 px-2 py-1 text-[11px] text-amber-100 hover:bg-amber-500/10 disabled:opacity-40">Retry live agent</button>
                </div>
                <p className="mt-1">{generalUserFailureMessage(generalTask.providerError.category)}</p>
              </div>
            )}
            {generalTask.phase === 'WAITING_FOR_CONFIRMATION' && generalTask.pendingAction && (
              <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                <p className="font-medium">Confirmation required before this external action.</p>
                <p className="mt-1">Requested action: {generalTask.pendingAction.target}. Nothing was sent, booked, or purchased.</p>
              </div>
            )}
            {generalTask.lastObservation && (
              <div className="mt-3 rounded-lg border border-violet-500/20 bg-slate-950/40 p-3 text-xs text-slate-200">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-300">Page check</p>
                <p className="mt-2 text-sm text-slate-100">{generalSafeObservationSummary(generalTask.lastObservation)}</p>
              </div>
            )}
            {generalTask.missingInformation.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-200">Information needed before preparation</p>
                <div className="mt-2 space-y-1 text-[11px] text-amber-100">
                  {generalTask.missingInformation.map((item) => <p key={item.id}><span className="font-medium">{item.prompt}</span> <span className="text-amber-200/70">({item.reason})</span></p>)}
                </div>
                <div className="mt-3 flex gap-2">
                  <input value={generalClarification} onChange={(event) => onClarificationChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onRevise(); } }} placeholder="Add the missing detail..." className="min-w-0 flex-1 rounded-md border border-amber-500/30 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-300" />
                  <button onClick={onRevise} disabled={!generalClarification.trim() || generalBusy} className="rounded-md border border-amber-400/50 px-2 py-1.5 text-[11px] text-amber-100 disabled:opacity-40">Update plan</button>
                </div>
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <input value={generalFollowUp} onChange={(event) => onFollowUpChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onRevise(); } }} placeholder="Refine the task, e.g. prefer AC sleeper buses" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400" />
              <button onClick={onRevise} disabled={!generalFollowUp.trim() || generalBusy} className="rounded-md border border-violet-400/50 px-3 py-2 text-[11px] text-violet-100 disabled:opacity-40">Send</button>
            </div>
            {generalTask.pendingAction && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-100">
                <p className="font-medium">I’m ready to take the next safe step when you confirm it.</p>
                {generalTask.confirmationId && <p className="mt-1">Nothing has been sent or purchased yet.</p>}
              </div>
            )}
            {generalTask.executionActionId && (
              <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-[11px] text-slate-200">
                <p className="font-medium text-violet-200">I’m preparing the safest next step for this request.</p>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {!['COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(generalTask.phase) && <button onClick={onTogglePause} disabled={generalBusy} className="rounded-md border border-slate-600 px-3 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">{generalTask.paused ? 'Resume' : 'Pause'}</button>}
              {!['COMPLETED', 'CANCELLED'].includes(generalTask.phase) && <button onClick={onStop} disabled={generalBusy} className="rounded-md border border-rose-400/50 px-3 py-1.5 text-[11px] text-rose-200 disabled:opacity-40">Stop Agent</button>}
              {!generalTaskActive && <button onClick={onNewTask} disabled={generalBusy} className="rounded-md border border-slate-600 px-3 py-1.5 text-[11px] text-slate-300 disabled:opacity-40">New task</button>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
