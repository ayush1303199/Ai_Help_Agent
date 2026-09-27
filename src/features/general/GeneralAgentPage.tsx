import type { ComponentProps } from 'react';
import { GeneralAgentWorkspace } from './GeneralAgentWorkspace';

interface GeneralAgentPageProps {
  workspace: ComponentProps<typeof GeneralAgentWorkspace>;
}

export function GeneralAgentPage({ workspace }: GeneralAgentPageProps) {
  return (
    <section className="m-auto flex w-full max-w-3xl flex-1 flex-col rounded-2xl border border-violet-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7">
      <div className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-300">General Agent</p>
        <h2 className="mt-1 text-xl font-semibold">What do you want me to do?</h2>
        <p className="mt-2 text-xs text-slate-500">Describe the outcome naturally. I will choose a bounded, read-only path and ask before any external action.</p>
      </div>
      <GeneralAgentWorkspace {...workspace} />
    </section>
  );
}
