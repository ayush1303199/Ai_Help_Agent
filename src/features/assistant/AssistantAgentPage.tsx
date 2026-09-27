import type { ComponentProps } from 'react';
import { AssistantAgentWorkspace } from './AssistantAgentWorkspace';

interface AssistantAgentPageProps {
  workspace: ComponentProps<typeof AssistantAgentWorkspace>;
}

export function AssistantAgentPage({ workspace }: AssistantAgentPageProps) {
  return (
    <section className="mx-auto flex min-h-[calc(100dvh-73px)] w-full max-w-4xl min-w-0 flex-col px-3 py-4 sm:px-4 sm:py-6">
      <AssistantAgentWorkspace {...workspace} />
    </section>
  );
}
