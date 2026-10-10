import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeConfig } from '../../config/runtimeConfig';
import { authenticatedBackendFetch } from '../../config/backendAuth';
import { ConfirmationDialog } from '../../ui/ConfirmationDialog';
import { CodingAgentWorkspace } from './CodingAgentWorkspace';
import { useCodingAgentController } from './useCodingAgentController';

export interface CodingHistoryRestoreRequest {
  key: number;
  session: Parameters<ReturnType<typeof useCodingAgentController>['restoreHistory']>[0];
}

interface CodingAcceptancePreflight {
  ready: boolean;
  canRunProjectCommands: boolean;
  providerConfigured: boolean;
  projectAttached: boolean;
  projectStatus: string;
  sandbox: {
    available: boolean;
    verified: boolean;
    platformRecognized: boolean;
    platform: string;
    reason: string | null;
  };
  blockers: Array<{ code: string; message: string }>;
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
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  const [acceptancePreflight, setAcceptancePreflight] = useState<CodingAcceptancePreflight | null>(null);
  const [acceptancePreflightBusy, setAcceptancePreflightBusy] = useState(false);
  const acceptancePreflightRequest = useRef(false);
  const lastRestoreKey = useRef<number | null>(null);
  const restoreHistoryRef = useRef(controller.restoreHistory);
  restoreHistoryRef.current = controller.restoreHistory;
  const { workspace } = controller;

  const refreshAcceptancePreflight = useCallback(async () => {
    if (acceptancePreflightRequest.current) return;
    acceptancePreflightRequest.current = true;
    setAcceptancePreflightBusy(true);
    try {
      const preflight = window.electronAPI?.getDeveloperAcceptancePreflight
        ? await window.electronAPI.getDeveloperAcceptancePreflight()
        : await (async () => {
          const response = await authenticatedBackendFetch(
            `${runtimeConfig.httpUrl}/api/coding/acceptance-preflight`,
          );
          if (!response.ok) throw new Error(`Readiness endpoint returned HTTP ${response.status}.`);
          return response.json() as Promise<CodingAcceptancePreflight>;
        })();
      setAcceptancePreflight(preflight);
    } catch (error) {
      setAcceptancePreflight({
        ready: false,
        canRunProjectCommands: false,
        providerConfigured: false,
        projectAttached: false,
        projectStatus: 'PREFLIGHT_FAILED',
        sandbox: {
          available: false,
          verified: false,
          platformRecognized: false,
          platform: 'unknown',
          reason: null,
        },
        blockers: [{
          code: 'preflight_failed',
          message: `Read-only readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
      });
    } finally {
      acceptancePreflightRequest.current = false;
      setAcceptancePreflightBusy(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refreshAcceptancePreflight();
  }, [active, refreshAcceptancePreflight]);

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
      <section hidden={!active} className={`${active ? 'flex' : 'hidden'} m-auto w-full max-w-5xl flex-1 flex-col rounded-2xl border border-sky-500/20 bg-slate-900/80 p-4 shadow-xl sm:p-6`}>
        <div className="mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">Developer Mode</p>
          <h2 className="mt-1 text-xl font-semibold">Coding assistant</h2>
          <p className="mt-2 text-xs text-slate-500">Read and search are automatic. Source writes happen only through a validated proposal after you explicitly approve it; project verification stays disabled until OS process isolation is verified.</p>
          <p className="mt-2 text-xs text-slate-500">Coding follows the active global provider and model settings. The actual provider used appears after each response.</p>
        </div>
        <CodingAgentWorkspace
          {...workspace}
          acceptancePreflight={acceptancePreflight}
          acceptancePreflightBusy={acceptancePreflightBusy}
          onRefreshAcceptancePreflight={() => void refreshAcceptancePreflight()}
          copiedItem={copiedItem}
          onCopyMessages={async (messages, key) => {
            const markdown = key === 'coding-all'
              ? messages.map((message) => `## ${message.role === 'user' ? 'You' : 'Coding Agent'}\n\n${message.content}`).join('\n\n---\n\n')
              : messages[0]?.content || '';
            await navigator.clipboard.writeText(markdown);
            setCopiedItem(key);
            window.setTimeout(() => setCopiedItem((current) => current === key ? null : current), 1800);
          }}
          onRequestDeleteConversation={setDeleteConversationId}
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
      <ConfirmationDialog
        open={deleteConversationId !== null}
        title="Delete Coding conversation?"
        description="This permanently removes the selected Coding conversation from this device. Project files and applied changes will not be affected."
        confirmLabel="Delete conversation"
        variant="danger"
        onCancel={() => setDeleteConversationId(null)}
        onConfirm={() => {
          if (deleteConversationId) workspace.onDeleteConversation(deleteConversationId);
          setDeleteConversationId(null);
        }}
      />
    </>
  );
}
