import { useCallback, useEffect, type ComponentProps } from 'react';
import { runtimeConfig } from '../../config/runtimeConfig';
import { AssistantAgentWorkspace } from './AssistantAgentWorkspace';
import { AssistantOverlayBridge } from './AssistantOverlayBridge';
import { AgentProviderSelect } from '../provider-selection/AgentProviderSelect';
import { useAgentProviderSelection, type AgentProviderOption } from '../provider-selection/useAgentProviderSelection';
import { useScreenReader } from '../screen-reading/useScreenReader';
import { historyTitle, type HistorySession } from '../../history/historyService';
import {
  useAssistantAgentController,
} from './useAssistantAgentController';
import {
  buildAssistantChatRequest,
  type AssistantRequestBuilderArgs,
  type AssistantRequestContext,
} from './assistantRequestBuilder';

type AssistantWorkspaceProps = ComponentProps<typeof AssistantAgentWorkspace>;
type AssistantController = ReturnType<typeof useAssistantAgentController>;

export type AssistantControllerSnapshot = AssistantController;

interface AssistantAgentPageProps {
  active: boolean;
  activeChatId: string;
  providers: AgentProviderOption[];
  mode: string;
  voiceReplies: boolean;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  requestContext: AssistantRequestContext;
  workspace: Omit<AssistantWorkspaceProps, 'messages' | 'input' | 'draftImproving' | 'chatStreaming' | 'onInputChange' | 'onImproveDraft' | 'screenReading' | 'screenReadingEnabled' | 'onReadScreen'>;
  onControllerChange: (controller: AssistantControllerSnapshot) => void;
  onScreenReadingChange: (state: Pick<ReturnType<typeof useScreenReader>, 'enabled' | 'setEnabled'>) => void;
  onHistoryEntries: (conversationId: string, entries: HistorySession[]) => void;
}

export function AssistantAgentPage({
  active,
  activeChatId,
  providers,
  mode,
  voiceReplies,
  setError,
  setStatus,
  requestContext,
  workspace,
  onControllerChange,
  onScreenReadingChange,
  onHistoryEntries,
}: AssistantAgentPageProps) {
  const { providerId, setProviderId } = useAgentProviderSelection('assistant', providers, setError);
  const buildSelectedChatRequest = useCallback((
    ...args: AssistantRequestBuilderArgs
  ) => ({
      ...buildAssistantChatRequest(requestContext, ...args),
      ...(providerId ? { providerId } : {}),
    }),
    [providerId, requestContext],
  );
  const {
    messages,
    setMessages,
    input,
    setInput,
    chatStreaming,
    pipelineStatus,
    draftImproving,
    connected,
    sendMessage,
    improveDraft,
    lastQuestion,
  } = useAssistantAgentController({
    mode,
    input: '',
    maxHistoryMessages: runtimeConfig.limits.maxChatHistoryMessages,
    maxMessageChars: runtimeConfig.limits.maxChatMessageChars,
    setError,
    setStatus,
    voiceReplies,
    buildChatRequest: buildSelectedChatRequest,
  });
  const onScreenReadError = useCallback((message: string) => setError(message), [setError]);
  const screenReader = useScreenReader({
    storageKey: 'assistant-screen-reading-enabled',
    disabled: !active || chatStreaming,
    onError: onScreenReadError,
    onScreenCaptured: async (image) => {
      await sendMessage(
        'Read the visible question on my shared screen and answer it.',
        undefined,
        undefined,
        undefined,
        { duplicateChecked: true, screenImage: image },
      );
    },
  });

  useEffect(() => {
    onControllerChange({
      messages,
      setMessages,
      input,
      setInput,
      chatStreaming,
      pipelineStatus,
      draftImproving,
      connected,
      sendMessage,
      improveDraft,
      lastQuestion,
    });
  }, [
    messages,
    setMessages,
    input,
    setInput,
    chatStreaming,
    pipelineStatus,
    draftImproving,
    connected,
    sendMessage,
    improveDraft,
    lastQuestion,
    onControllerChange,
  ]);

  useEffect(() => {
    onScreenReadingChange({ enabled: screenReader.enabled, setEnabled: screenReader.setEnabled });
  }, [onScreenReadingChange, screenReader.enabled, screenReader.setEnabled]);

  useEffect(() => {
    if (!messages.length || messages.some((message) => message.streaming)) return;
    const entries: HistorySession[] = [];
    for (let index = 0; index < messages.length - 1; index += 1) {
      const user = messages[index];
      const assistant = messages[index + 1];
      if (user.role !== 'user' || assistant.role !== 'assistant' || !assistant.content.trim()) continue;
      const savedMessages = [
        { role: 'user' as const, content: user.content },
        { role: 'assistant' as const, content: assistant.content },
      ];
      entries.push({
        id: `${activeChatId}-turn-${index}`,
        mode: 'assistant',
        title: historyTitle(savedMessages),
        messages: savedMessages,
        updatedAt: new Date().toISOString(),
      });
      index += 1;
    }
    if (entries.length) onHistoryEntries(activeChatId, entries);
  }, [activeChatId, messages, onHistoryEntries]);

  return (
    <section hidden={!active} className={`${active ? 'flex' : 'hidden'} mx-auto min-h-[calc(100dvh-73px)] w-full max-w-4xl min-w-0 flex-col px-3 py-4 sm:px-4 sm:py-6`}>
      <AgentProviderSelect agentId="assistant" providers={providers} value={providerId} onChange={setProviderId} />
      <AssistantAgentWorkspace
        {...workspace}
        messages={messages}
        input={input}
        draftImproving={draftImproving}
        chatStreaming={chatStreaming}
        onInputChange={setInput}
        onSend={workspace.onSend}
        onImproveDraft={() => void improveDraft()}
        screenReading={screenReader.screenReading}
        screenReadingEnabled={screenReader.enabled}
        onReadScreen={() => void screenReader.readScreen()}
      />
      <AssistantOverlayBridge
        active={active}
        messages={messages}
        status={pipelineStatus}
        chatStreaming={chatStreaming}
        sendMessage={sendMessage}
      />
    </section>
  );
}
