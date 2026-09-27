import { useEffect, type ComponentProps } from 'react';
import { runtimeConfig } from '../../config/runtimeConfig';
import { AssistantAgentWorkspace } from './AssistantAgentWorkspace';
import { AssistantOverlayBridge } from './AssistantOverlayBridge';
import {
  useAssistantAgentController,
  type AssistantAgentControllerOptions,
} from './useAssistantAgentController';

type AssistantWorkspaceProps = ComponentProps<typeof AssistantAgentWorkspace>;
type AssistantController = ReturnType<typeof useAssistantAgentController>;

export type AssistantControllerSnapshot = AssistantController;

interface AssistantAgentPageProps {
  active: boolean;
  mode: string;
  voiceReplies: boolean;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  buildChatRequest: AssistantAgentControllerOptions['buildChatRequest'];
  workspace: Omit<AssistantWorkspaceProps, 'messages' | 'input' | 'draftImproving' | 'chatStreaming' | 'onInputChange' | 'onImproveDraft'>;
  onControllerChange: (controller: AssistantControllerSnapshot) => void;
}

export function AssistantAgentPage({
  active,
  mode,
  voiceReplies,
  setError,
  setStatus,
  buildChatRequest,
  workspace,
  onControllerChange,
}: AssistantAgentPageProps) {
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
    buildChatRequest,
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

  return (
    <section hidden={!active} className={`${active ? 'flex' : 'hidden'} mx-auto min-h-[calc(100dvh-73px)] w-full max-w-4xl min-w-0 flex-col px-3 py-4 sm:px-4 sm:py-6`}>
      <AssistantAgentWorkspace
        {...workspace}
        messages={messages}
        input={input}
        draftImproving={draftImproving}
        chatStreaming={chatStreaming}
        onInputChange={setInput}
        onSend={workspace.onSend}
        onImproveDraft={() => void improveDraft()}
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
