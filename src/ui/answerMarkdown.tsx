import type { ReactNode } from 'react';

export function renderAnswerMarkdown(text: string): ReactNode[] {
  return text.split(/\n{2,}/).map((block, index) => {
    const trimmed = block.trim();
    if (!trimmed) return null;
    if (/^```/.test(trimmed)) {
      return <pre key={index} className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-emerald-200"><code>{trimmed.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')}</code></pre>;
    }
    const lines = trimmed.split('\n');
    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      return <ul key={index} className="list-disc space-y-1 pl-5">{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{formatInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>)}</ul>;
    }
    if (lines.every((line) => /^\d+\.\s+/.test(line))) {
      return <ol key={index} className="list-decimal space-y-1 pl-5">{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{formatInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>)}</ol>;
    }
    if (/^#{1,3}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,3}\s+/, '');
      return <h3 key={index} className="text-lg font-semibold text-emerald-200">{formatInlineMarkdown(heading)}</h3>;
    }
    return <p key={index}>{formatInlineMarkdown(trimmed)}</p>;
  });
}

export function formatInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index} className="rounded bg-slate-950 px-1.5 py-0.5 text-emerald-200">{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}
