import { useEffect, useRef } from 'react';
import { prepareTextRequest } from '../../audio/transcriptUtils';
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

function overlayPlainText(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOverlaySummary(answer: string) {
  const plainText = overlayPlainText(answer);
  if (!plainText) return '';
  const sentences = plainText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [plainText];
  return sentences.slice(0, 2).join(' ').trim();
}

function buildOverlayActionItems(answer: string) {
  const items = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return items.length ? items : ['No specific action items identified in this answer.'];
}

function buildOverlayAnalysis(question: string, answer: string) {
  const summary = buildOverlaySummary(answer);
  if (!summary) return '';
  const wordCount = overlayPlainText(answer).split(/\s+/).filter(Boolean).length;
  return [
    question ? `Question focus: ${question}` : '',
    `Response analysis: ${wordCount} words covering the requested topic.`,
    `Key point: ${summary}`,
  ].filter(Boolean).join('\n\n');
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
    channelRef.current?.postMessage({ type: 'state', ...stateRef.current });
  }, [messages, status]);

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
        channel.postMessage({ type: 'state', ...stateRef.current });
      }
      if (event.data?.type !== 'overlay-question') return;
      const question = typeof event.data.question === 'string'
        ? event.data.question.trim().slice(0, 2000)
        : '';
      if (!question) return;
      if (!active) {
        channel.postMessage({
          type: 'overlay-search-error',
          message: 'Switch to the AI Assistant page to use the Assistant overlay.',
        });
        return;
      }
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
