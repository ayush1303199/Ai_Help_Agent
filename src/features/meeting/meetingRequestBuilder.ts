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
        content: screenImage
          ? [
            { type: 'text', text: `${question}\n\nRead the attached shared-screen image. Identify any visible interview or meeting question and answer it directly. If no question is visible, say so.` },
            { type: 'image_url', image_url: { url: screenImage } },
          ]
          : `CURRENT QUESTION:\n${question}\n\nTASK:\nAnswer this question directly. Stay on topic, preserve its terminology, and ask one concise clarification only if it is genuinely ambiguous.`,
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
