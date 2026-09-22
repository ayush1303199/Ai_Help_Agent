import type { AppMode, AssistantMode } from '../../app/appTypes';

interface ModeControlsProps {
  appMode: AppMode;
  assistantMode: AssistantMode;
  disabled: boolean;
  onAppModeChange: (mode: AppMode) => void;
  onAssistantModeChange: (mode: AssistantMode) => void;
}

export function ModeControls({
  appMode,
  assistantMode,
  disabled,
  onAppModeChange,
  onAssistantModeChange,
}: ModeControlsProps) {
  return (
    <>
      <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800 p-0.5" aria-label="Application mode">
        <ModeButton active={appMode === 'assistant'} activeClass="bg-emerald-500 text-slate-950" disabled={disabled} onClick={() => onAppModeChange('assistant')}>AI Assistant</ModeButton>
        <ModeButton active={appMode === 'developer'} activeClass="bg-sky-500 text-slate-950" disabled={disabled} onClick={() => onAppModeChange('developer')}>Developer</ModeButton>
        <ModeButton active={appMode === 'general'} activeClass="bg-violet-500 text-slate-950" disabled={disabled} onClick={() => onAppModeChange('general')}>General</ModeButton>
      </div>
      <div className={`${appMode === 'assistant' ? '' : 'hidden'} flex items-center rounded-lg border border-slate-700 bg-slate-800 p-0.5`} aria-label="AI mode">
        <ModeButton active={assistantMode === 'direct'} activeClass="bg-emerald-500 text-slate-950" onClick={() => onAssistantModeChange('direct')}>Direct</ModeButton>
        <ModeButton active={assistantMode === 'langchain'} activeClass="bg-teal-500 text-slate-950" onClick={() => onAssistantModeChange('langchain')}>LangChain</ModeButton>
      </div>
    </>
  );
}

interface ModeButtonProps {
  active: boolean;
  activeClass: string;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}

function ModeButton({ active, activeClass, disabled = false, onClick, children }: ModeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${active ? activeClass : 'text-slate-400 hover:text-slate-200'} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {children}
    </button>
  );
}
