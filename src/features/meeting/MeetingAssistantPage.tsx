import type { ReactNode } from 'react';

interface MeetingAssistantPageProps {
  children: ReactNode;
  setup: boolean;
}

export function MeetingAssistantPage({ children, setup }: MeetingAssistantPageProps) {
  if (setup) {
    return (
      <section className="m-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/80 p-6 shadow-2xl">
        {children}
      </section>
    );
  }

  return <section className="flex flex-1 flex-col">{children}</section>;
}
