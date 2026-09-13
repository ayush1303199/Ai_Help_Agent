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
  return (
    <>
      <article className="flex-1 rounded-2xl border border-emerald-500/20 bg-slate-900/80 p-5 shadow-xl sm:p-7">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Question</p>
        <p className="mb-7 text-base text-slate-300">{lastQuestion || 'Waiting for the next detected question...'}</p>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">Answer</p>
        {lastAnswer ? <div className="space-y-4 text-lg leading-relaxed text-slate-100">{renderAnswerMarkdown(lastAnswer)}</div> : <p className="text-sm text-slate-500">{isThinking ? 'Generating answer...' : 'No answer yet.'}</p>}
      </article>
      {answeredSegments.length > 1 && <section className="mt-4 rounded-xl border border-slate-700 bg-slate-900/70 p-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Earlier answers</p>
        <div className="max-h-64 space-y-3 overflow-y-auto">
          {answeredSegments.slice(0, -1).reverse().map((segment, index) => (
            <article key={`${segment.question}-${index}`} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <p className="text-xs font-medium text-slate-400">{segment.question}</p>
              <div className="mt-2 text-sm leading-relaxed text-slate-300">{renderAnswerMarkdown(segment.answer)}</div>
            </article>
          ))}
        </div>
      </section>}
    </>
  );
}
