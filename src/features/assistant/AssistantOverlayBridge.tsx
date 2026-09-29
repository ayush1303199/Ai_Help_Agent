import { useEffect, useRef } from 'react';
import { prepareTextRequest } from '../../audio/transcriptUtils';
import { runtimeConfig } from '../../config/runtimeConfig';
import {
  buildOverlayActionItems,
  buildOverlayAnalysis,
  buildOverlaySummary,
} from '../overlay/overlayAnswerInsights';
import type { AssistantMessage, AssistantSendOptions } from './useAssistantAgentController';

type AssistantStatus = 'ready' | 'thinking' | 'answer' | 'error';
type SendAssistantMessage = (
  question?: string,
  contextOverride?: string,
  modelInstruction?: string,
  questionFinalizedAt?: number,
  options?: AssistantSendOptions,
) => Promise<void>;

interface AssistantOverlayState {
  answer: string;
  question: string;
  analysis: string;
  summary: string;
  actionItems: string[];
  status: AssistantStatus;
}

interface AssistantOverlayBridgeProps {
  active: boolean;
  messages: AssistantMessage[];
  status: AssistantStatus;
  chatStreaming: boolean;
  sendMessage: SendAssistantMessage;
}

export function AssistantOverlayBridge({
  active,
  messages,
  status,
  chatStreaming,
  sendMessage,
}: AssistantOverlayBridgeProps) {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef<AssistantOverlayState>({
    answer: '',
    question: '',
    analysis: '',
    summary: '',
    actionItems: [],
    status: 'ready',
  });

  useEffect(() => {
    const answer = [...messages].reverse().find((message) => message.role === 'assistant')?.content || '';
    const question = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
    stateRef.current = {
      answer,
      question,
      analysis: buildOverlayAnalysis(question, answer),
      summary: buildOverlaySummary(answer),
      actionItems: answer ? buildOverlayActionItems(answer) : [],
      status,
    };
    if (active) channelRef.current?.postMessage({ type: 'state', ...stateRef.current });
  }, [active, messages, status]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel('meeting-ai-overlay');
    } catch {
      return;
    }
    channelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type === 'overlay-ready') {
        if (active) channel.postMessage({ type: 'state', ...stateRef.current });
        return;
      }
      if (event.data?.type !== 'overlay-question') return;
      if (!active) return;
      const question = typeof event.data.question === 'string'
        ? event.data.question.trim().slice(0, runtimeConfig.overlay.questionMaxChars)
        : '';
      if (!question) return;
      if (chatStreaming) {
        channel.postMessage({
          type: 'overlay-search-error',
          message: 'Please wait for the current AI answer to finish.',
        });
        return;
      }
      void sendMessage(question, undefined, question, performance.now(), {
        preparedQuestion: prepareTextRequest(question),
      });
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [active, chatStreaming, sendMessage]);

  return null;
}
