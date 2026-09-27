import type { ComponentProps } from 'react';
import { CodingAgentWorkspace } from './CodingAgentWorkspace';

interface CodingAgentPageProps {
  workspace: ComponentProps<typeof CodingAgentWorkspace>;
}

export function CodingAgentPage({ workspace }: CodingAgentPageProps) {
  return (
    <section className="m-auto flex w-full max-w-3xl flex-1 flex-col rounded-2xl border border-sky-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7">
      <div className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">Developer Mode</p>
        <h2 className="mt-1 text-xl font-semibold">Coding assistant</h2>
        <p className="mt-2 text-xs text-slate-500">Read and search are automatic. Source writes happen only through a validated proposal after you explicitly approve it; verification uses allow-listed project scripts.</p>
      </div>
      <CodingAgentWorkspace {...workspace} />
    </section>
  );
}
