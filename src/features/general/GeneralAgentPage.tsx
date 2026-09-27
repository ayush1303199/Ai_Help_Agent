import { useEffect } from 'react';
import { historyTitle, type HistorySession } from '../../history/historyService';
import { GeneralAgentWorkspace } from './GeneralAgentWorkspace';
import { useGeneralAgentController } from './useGeneralAgentController';

interface GeneralAgentPageProps {
  active: boolean;
  onBusyChange: (busy: boolean) => void;
  onHistoryEntry: (entry: HistorySession) => void;
}

export function GeneralAgentPage({ active, onBusyChange, onHistoryEntry }: GeneralAgentPageProps) {
  const controller = useGeneralAgentController();

  useEffect(() => {
    onBusyChange(controller.busy);
  }, [controller.busy, onBusyChange]);

  useEffect(() => {
    const response = controller.task?.assistantResponse;
    if (!controller.task || !response?.content || !['COMPLETED', 'COMPLETED_WITH_LIMITATIONS'].includes(controller.task.phase)) return;
    const messages: HistorySession['messages'] = [
      { role: 'user', content: controller.task.goal },
      { role: 'assistant', content: response.content },
    ];
    onHistoryEntry({
      id: `general-${controller.task.taskId}`,
      mode: 'general',
      title: historyTitle(messages),
      messages,
      updatedAt: new Date().toISOString(),
    });
  }, [controller.task, onHistoryEntry]);

  return (
    <section hidden={!active} className={`${active ? 'flex' : 'hidden'} m-auto w-full max-w-3xl flex-1 flex-col rounded-2xl border border-violet-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7`}>
      <div className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-300">General Agent</p>
        <h2 className="mt-1 text-xl font-semibold">What do you want me to do?</h2>
        <p className="mt-2 text-xs text-slate-500">Describe the outcome naturally. I will choose a bounded, read-only path and ask before any external action.</p>
      </div>
      <GeneralAgentWorkspace
        generalTask={controller.task}
        generalGoal={controller.goal}
        generalClarification={controller.clarification}
        generalFollowUp={controller.followUp}
        generalBusy={controller.busy}
        generalTaskActive={controller.taskActive}
        generalError={controller.error}
        generalStatusMessage={controller.statusMessage}
        onGoalChange={controller.setGoal}
        onClarificationChange={controller.setClarification}
        onFollowUpChange={controller.setFollowUp}
        onStartTask={() => void controller.startTask()}
        onRetry={() => void controller.retry()}
        onRevise={() => void controller.revise()}
        onTogglePause={() => void controller.togglePause()}
        onStop={() => void controller.stop()}
        onNewTask={controller.newTask}
      />
    </section>
  );
}
