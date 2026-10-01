import { useEffect, useRef, useState } from 'react';
import { runtimeConfig } from '../../config/runtimeConfig';
import { ConfirmationDialog } from '../../ui/ConfirmationDialog';
import { CodingAgentWorkspace } from './CodingAgentWorkspace';
import { useCodingAgentController } from './useCodingAgentController';

export interface CodingHistoryRestoreRequest {
  key: number;
  session: Parameters<ReturnType<typeof useCodingAgentController>['restoreHistory']>[0];
}

interface CodingAgentPageProps {
  active: boolean;
  defaultProvider: { id?: string; label?: string; model?: string } | null;
  providers: unknown[];
  onProviderStorageError: (message: string) => void;
  restoreRequest: CodingHistoryRestoreRequest | null;
  onBusyChange: (busy: boolean) => void;
}

export function CodingAgentPage({ active, restoreRequest, onBusyChange }: CodingAgentPageProps) {
  const controller = useCodingAgentController({
    maxContextChars: runtimeConfig.limits.maxContextChars,
    maxHistoryMessages: runtimeConfig.limits.maxChatHistoryMessages,
    maxMessageChars: runtimeConfig.limits.maxChatMessageChars,
  });
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const lastRestoreKey = useRef<number | null>(null);
  const restoreHistoryRef = useRef(controller.restoreHistory);
  restoreHistoryRef.current = controller.restoreHistory;
  const { workspace } = controller;

  useEffect(() => {
    onBusyChange(workspace.streaming);
  }, [onBusyChange, workspace.streaming]);

  useEffect(() => {
    if (!restoreRequest || lastRestoreKey.current === restoreRequest.key) return;
    lastRestoreKey.current = restoreRequest.key;
    restoreHistoryRef.current(restoreRequest.session);
  }, [restoreRequest]);

  return (
    <>
      <section hidden={!active} className={`${active ? 'flex' : 'hidden'} m-auto w-full max-w-3xl flex-1 flex-col rounded-2xl border border-sky-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7`}>
        <div className="mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">Developer Mode</p>
          <h2 className="mt-1 text-xl font-semibold">Coding assistant</h2>
          <p className="mt-2 text-xs text-slate-500">Read and search are automatic. Source writes happen only through a validated proposal after you explicitly approve it; verification uses allow-listed project scripts.</p>
          <p className="mt-2 text-xs text-slate-500">Coding follows the active global provider and model settings. The actual provider used appears after each response.</p>
        </div>
        <CodingAgentWorkspace
          {...workspace}
          onResetCodingPreferences={() => setConfirmationOpen(true)}
        />
      </section>
      <ConfirmationDialog
        open={confirmationOpen}
        title="Reset coding preferences?"
        description="This removes all saved Coding Agent style preferences. Conversation history and project files will not be changed."
        confirmLabel="Reset preferences"
        variant="danger"
        onCancel={() => setConfirmationOpen(false)}
        onConfirm={() => {
          workspace.onResetCodingPreferences();
          setConfirmationOpen(false);
        }}
      />
    </>
  );
}
