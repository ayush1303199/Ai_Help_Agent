import { useCallback, useEffect, useRef, useState } from 'react';
import {
  prepareQuestion,
  prepareTextRequest,
  questionFingerprintForComparison,
  voiceSafeText,
  type PreparedQuestion,
} from '../../audio/transcriptUtils';
import {
  AssistantAgentTransport,
  type AssistantChatMessage,
  type AssistantChatRequest,
} from './assistantTransport';

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  requestId?: string;
}

export interface AssistantSendOptions {
  preparedQuestion?: PreparedQuestion;
  duplicateChecked?: boolean;
  screenImage?: string;
}

export interface AssistantAgentControllerOptions {
  mode: string;
  input: string;
  maxHistoryMessages: number;
  maxMessageChars: number;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  voiceReplies: boolean;
  buildChatRequest: (
    question: string,
    history: AssistantChatMessage[],
    screenImage?: string,
    contextOverride?: string,
  ) => AssistantChatRequest;
  onAnswer?: (question: string, answer: string) => void;
}

function userFailureMessage(error: unknown): string {
  const failure = error as { failureClassification?: string; message?: string };
  if (failure.failureClassification === 'RATE_LIMIT') {
    return 'The AI provider is temporarily rate-limited. Your question was not completed; please retry shortly.';
  }
  if (failure.failureClassification === 'CONTEXT_TOO_LARGE' || failure.failureClassification === 'BLOCKED_CONTEXT_LIMIT') {
    return 'This question included too much context. The request was not completed.';
  }
  if (failure.failureClassification === 'NETWORK_ERROR' || failure.failureClassification === 'CAPACITY_ERROR') {
    return 'The AI provider is temporarily unavailable. Your question was not completed.';
  }
  return failure.message || 'The AI provider could not complete this request. I am not claiming the task is complete.';
}

function compactMessageContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[Earlier content omitted for speed]`;
}

function inputQualityMessage(classification: PreparedQuestion['qualityClassification']) {
  if (classification === 'INCOMPLETE') return 'Please finish the request before sending it.';
  if (classification === 'FILLER' || classification === 'REPEATED_NOISE' || classification === 'NOT_A_QUESTION') {
    return 'I did not detect a complete request.';
  }
  return '';
}

export function useAssistantAgentController({
  mode,
  input,
  maxHistoryMessages,
  maxMessageChars,
  setError,
  setStatus,
  voiceReplies,
  buildChatRequest,
  onAnswer,
}: AssistantAgentControllerOptions) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState<'ready' | 'thinking' | 'answer' | 'error'>('ready');
  const [draftImproving, setDraftImproving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [assistantInput, setAssistantInput] = useState(input);
  const transportRef = useRef<AssistantAgentTransport | null>(null);
  const pendingRequestIdsRef = useRef(new Set<string>());
  const acceptedQuestionsRef = useRef(new Map<string, string>());
  const acceptedHistoryRef = useRef<string[]>([]);
  const voiceBufferRef = useRef('');
  const lastQuestionRef = useRef('');

  useEffect(() => {
    const transport = new AssistantAgentTransport({ onConnectionChange: setConnected });
    transportRef.current = transport;
    transport.warm();
    return () => {
      transport.close();
      transportRef.current = null;
    };
  }, []);

  const releaseAcceptedQuestion = useCallback((requestId: string) => {
    const fingerprint = acceptedQuestionsRef.current.get(requestId);
    if (!fingerprint) return;
    acceptedQuestionsRef.current.delete(requestId);
    acceptedHistoryRef.current = acceptedHistoryRef.current.filter((item) => item !== fingerprint);
  }, []);

  const rememberAcceptedQuestion = useCallback((question: string) => {
    const fingerprint = questionFingerprintForComparison(question);
    if (!fingerprint || acceptedHistoryRef.current.includes(fingerprint)) return false;
    acceptedHistoryRef.current = [...acceptedHistoryRef.current, fingerprint].slice(-5);
    return true;
  }, []);

  const appendToken = useCallback((requestId: string, content: string) => {
    if (voiceReplies && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      voiceBufferRef.current += content;
      const sentenceMatch = voiceBufferRef.current.match(/^(.+?[.!?])(?:\s|$)/s);
      if (sentenceMatch) {
        const sentence = sentenceMatch[1].trim();
        voiceBufferRef.current = voiceBufferRef.current.slice(sentenceMatch[0].length);
        const speakable = voiceSafeText(sentence);
        if (speakable) window.speechSynthesis.speak(new SpeechSynthesisUtterance(speakable));
      }
    }
    setMessages((current) => current.map((message) => (
      message.requestId === requestId
        ? { ...message, content: `${message.content}${content}` }
        : message
    )));
  }, [voiceReplies]);

  const completeRequest = useCallback((requestId: string, content: string, question: string) => {
    setMessages((current) => current.map((message) => (
      message.requestId === requestId
        ? { ...message, content: content || message.content, streaming: false }
        : message
    )));
    pendingRequestIdsRef.current.delete(requestId);
    releaseAcceptedQuestion(requestId);
    setChatStreaming(pendingRequestIdsRef.current.size > 0);
    setPipelineStatus('answer');
    if (voiceReplies && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const speakable = voiceSafeText(voiceBufferRef.current);
      if (speakable) window.speechSynthesis.speak(new SpeechSynthesisUtterance(speakable));
      voiceBufferRef.current = '';
    }
    onAnswer?.(question, content);
  }, [onAnswer, releaseAcceptedQuestion, voiceReplies]);

  const sendMessage = useCallback(async (
    question = assistantInput.trim(),
    contextOverride?: string,
    _modelInstruction = question,
    _questionFinalizedAt = performance.now(),
    options: AssistantSendOptions = {},
  ) => {
    void _modelInstruction;
    void _questionFinalizedAt;
    const rawQuestion = question.trim();
    if (!rawQuestion) return;
    const preparedQuestion = options.preparedQuestion
      || (question === assistantInput.trim() ? prepareTextRequest(rawQuestion) : prepareQuestion(rawQuestion));
    if (!preparedQuestion.acceptedQuestion) {
      setStatus(inputQualityMessage(preparedQuestion.qualityClassification));
      return;
    }
    const canonicalQuestion = preparedQuestion.acceptedQuestion;
    if (!options.duplicateChecked && !rememberAcceptedQuestion(canonicalQuestion)) {
      setStatus('This question was already submitted recently.');
      return;
    }
    setStatus('');
    const requestId = crypto.randomUUID();
    const history = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-maxHistoryMessages)
      .map((message): AssistantChatMessage => ({
        role: message.role,
        content: compactMessageContent(message.content, maxMessageChars),
      }));
    setMessages((current) => [
      ...current,
      { role: 'user', content: canonicalQuestion },
      { role: 'assistant', content: '', streaming: true, requestId },
    ]);
    setAssistantInput('');
    setError('');
    setPipelineStatus('thinking');
    setChatStreaming(true);
    pendingRequestIdsRef.current.add(requestId);
    acceptedQuestionsRef.current.set(requestId, questionFingerprintForComparison(canonicalQuestion));
    lastQuestionRef.current = canonicalQuestion;
    try {
      const transport = transportRef.current;
      if (!transport) throw new Error('The Assistant transport is unavailable.');
      const request = buildChatRequest(canonicalQuestion, history, options.screenImage, contextOverride);
      const result = await transport.send(
        { ...request, requestId },
        { onToken: (content) => appendToken(requestId, content) },
      );
      completeRequest(requestId, result.content, canonicalQuestion);
    } catch (failure) {
      pendingRequestIdsRef.current.delete(requestId);
      releaseAcceptedQuestion(requestId);
      setChatStreaming(pendingRequestIdsRef.current.size > 0);
      const message = userFailureMessage(failure);
      setMessages((current) => current.map((item) => (
        item.requestId === requestId
          ? {
            ...item,
            content: `${(failure as { remote?: boolean }).remote ? 'Error' : 'Connection error'}: ${message}`,
            streaming: false,
          }
          : item
      )));
      setError(message);
      setPipelineStatus('error');
    }
  }, [
    appendToken,
    assistantInput,
    buildChatRequest,
    completeRequest,
    messages,
    maxHistoryMessages,
    maxMessageChars,
    rememberAcceptedQuestion,
    releaseAcceptedQuestion,
    setError,
    setStatus,
  ]);

  const improveDraft = useCallback(async () => {
    const draft = assistantInput.trim();
    if (!draft || draftImproving || chatStreaming) return;
    const requestId = crypto.randomUUID();
    setDraftImproving(true);
    setError('');
    try {
      const transport = transportRef.current;
      if (!transport) throw new Error('The Assistant transport is unavailable.');
      const result = await transport.send({
        requestId,
        mode,
        messages: [{
          role: 'user',
          content: `Rewrite the following draft to be clear, concise, and natural. Preserve its meaning. Reply with only the improved text.\n\nDRAFT:\n${draft}`,
        }],
        pdfContext: '',
      });
      setAssistantInput(result.content.trim());
      setPipelineStatus('answer');
      setDraftImproving(false);
    } catch (failure) {
      setDraftImproving(false);
      setError(`Could not improve the draft: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }, [assistantInput, chatStreaming, draftImproving, mode, setError]);

  return {
    messages,
    setMessages,
    input: assistantInput,
    setInput: setAssistantInput,
    chatStreaming,
    pipelineStatus,
    draftImproving,
    connected,
    sendMessage,
    improveDraft,
    lastQuestion: lastQuestionRef.current,
  };
}
