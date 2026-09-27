import type { ComponentProps } from 'react';
import { MeetingAssistantWorkspace } from './MeetingAssistantWorkspace';

interface MeetingAssistantPageProps {
  workspace: ComponentProps<typeof MeetingAssistantWorkspace>;
}

export function MeetingAssistantPage({ workspace }: MeetingAssistantPageProps) {
  return (
    <section className="m-auto flex w-full max-w-3xl flex-1 flex-col rounded-2xl border border-teal-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7">
      <div className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">Meeting Assistant</p>
        <h2 className="mt-1 text-xl font-semibold">Listen and get answers</h2>
        <p className="mt-2 text-xs text-slate-500">Meeting audio, transcription, and answers run in their own pipeline.</p>
      </div>
      <MeetingAssistantWorkspace {...workspace} />
    </section>
  );
}
