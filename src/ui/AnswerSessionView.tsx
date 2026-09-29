import { renderAnswerMarkdown } from './answerMarkdown';

interface AnswerSegment {
  question: string;
  answer: string;
}

interface AnswerSessionViewProps {
  lastQuestion: string;
  lastAnswer: string;
  isThinking: boolean;
  answeredSegments: AnswerSegment[];
}

export function AnswerSessionView({ lastQuestion, lastAnswer, isThinking, answeredSegments }: AnswerSessionViewProps) {
  const latestAnsweredSegment = answeredSegments[answeredSegments.length - 1];
  const latestIsInHistory = latestAnsweredSegment
    && latestAnsweredSegment.question === lastQuestion
    && latestAnsweredSegment.answer === lastAnswer;
  const conversation = latestIsInHistory || !lastQuestion
    ? answeredSegments
    : [...answeredSegments, { question: lastQuestion, answer: lastAnswer }];
  const displayedConversation = [...conversation].reverse();

  return (
    <section aria-label="Meeting questions and answers" className="flex-1 rounded-2xl border border-emerald-500/20 bg-slate-900/80 p-4 shadow-xl sm:p-5">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Questions &amp; answers</p>
      {displayedConversation.length > 0 ? (
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {displayedConversation.map((segment, index) => (
            <article key={`${segment.question}-${index}`} className="rounded-xl border border-slate-700/80 bg-slate-950/50 p-4">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-sky-300">Question</p>
              <p className="text-sm leading-relaxed text-slate-200">{segment.question}</p>
              <p className="mb-1 mt-4 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Answer</p>
              {segment.answer
                ? <div className="space-y-3 text-base leading-relaxed text-slate-100">{renderAnswerMarkdown(segment.answer)}</div>
                : <p className="text-sm text-slate-500">{isThinking ? 'Generating answer...' : 'No answer yet.'}</p>}
            </article>
          ))}
        </div>
      ) : (
        <p className="py-4 text-sm text-slate-500">Waiting for the next detected question...</p>
      )}
    </section>
  );
}
