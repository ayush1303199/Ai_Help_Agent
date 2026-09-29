import {
  createCanonicalInterviewContext,
  type InterviewContextConfig,
} from '../../ai/interviewContext';
import { buildCanonicalInterviewSystemPrompt } from '../../ai/interviewSystemPrompt';
import { resolveContext, type ContextDocument, type ContextProfile } from '../../context/contextResolver';
import type { MeetingChatMessage, MeetingChatRequest } from './meetingTransport';

export interface MeetingRequestContext {
  mode: string;
  sessionDocuments: ContextDocument[];
  activeProfile: ContextProfile | null;
  interviewConfig: InterviewContextConfig;
  microphoneDevicePresent: boolean;
  contextCharBudget: number;
  maxHistoryMessages: number;
  maxContextChars: number;
}

export type MeetingRequestBuilderArgs = [
  question: string,
  history: MeetingChatMessage[],
  screenImage?: string,
];

export function buildMeetingChatRequest(
  context: MeetingRequestContext,
  question: string,
  history: MeetingChatMessage[],
  screenImage?: string,
): MeetingChatRequest {
  if (screenImage) {
    return {
      mode: context.mode,
      messages: [
        {
          role: 'system',
          content: 'Scan the full screenshot top-to-bottom and left-to-right; identify visible questions, not unrelated interface text. Start with "Transcribed question:" and copy every clearly visible question exactly. Check every digit, operator, identifier, list item, duplicate, and item order against the screenshot before answering; never guess or silently correct unclear text. Do not omit a clearly visible question: when there are multiple distinct questions, list and answer each separately in the same order. For code, use a programming language explicitly requested in the question; if none is specified, consistently use Python. For each coding question, give one complete, runnable solution in its own fenced code block. Put the opening and closing triple-backtick fences on separate lines; do not escape or inline the fences, and keep all code inside them. Before responding, check spelling, syntax, indentation, and entry-point names. For a simple request, prefer the shortest clear complete program; do not add functions, exception handling, or a main guard unless requested or needed. Keep explanations brief.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: screenImage } },
          ],
        },
      ],
    };
  }

  const resolvedContext = resolveContext({
    mode: context.mode as 'direct' | 'langchain',
    sessionDocuments: context.sessionDocuments,
    activeProfile: context.activeProfile,
    contextCharBudget: context.contextCharBudget,
    profileCharBudget: context.contextCharBudget,
  });
  const { domain, background } = context.interviewConfig;
  const interviewContextActive = Boolean(resolvedContext.trim() || domain || background.length);
  const directModeContextInstruction = context.mode === 'direct' && interviewContextActive
    ? '\n\nDIRECT MODE ACTIVE CONTEXT:\nThe request includes the selected Resume, Job Description, profile, interview domain, and technical background when available. Use Resume/profile evidence for personal claims, Job Description for role requirements, and domain/background as interview focus only. Answer in first person as the user when the question is about their qualifications or introduction. Never switch to a generic ChatGPT identity.'
    : '';

  return {
    mode: context.mode,
    messages: [
      {
        role: 'system',
        content: `${buildCanonicalInterviewSystemPrompt(createCanonicalInterviewContext({
          currentQuestion: question,
          hasCandidateContext: Boolean(resolvedContext.trim()),
          domain,
          background,
        }))}${directModeContextInstruction}`,
      },
      ...history.slice(-context.maxHistoryMessages),
      {
        role: 'user',
        content: `CURRENT QUESTION:\n${question}\n\nTASK:\nAnswer this question directly. Stay on topic, preserve its terminology, and ask one concise clarification only if it is genuinely ambiguous.`,
      },
    ],
    interviewContext: {
      domain,
      background,
      microphoneConfigured: Boolean(context.interviewConfig.microphoneDeviceId),
      microphoneDevicePresent: context.microphoneDevicePresent,
    },
    pdfContext: resolvedContext.slice(-context.maxContextChars),
  };
}
