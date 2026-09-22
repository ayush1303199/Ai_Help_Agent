import type { ReactNode } from 'react';

interface GeneralAgentPageProps {
  children: ReactNode;
}

export function GeneralAgentPage({ children }: GeneralAgentPageProps) {
  return (
    <section className="m-auto flex w-full max-w-3xl flex-1 flex-col rounded-2xl border border-violet-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7">
      {children}
    </section>
  );
}
