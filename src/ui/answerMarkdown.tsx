import type { ReactNode } from 'react';

export function renderAnswerMarkdown(text: string): ReactNode[] {
  return splitFencedCode(normalizeEscapedFences(text)).reduce<ReactNode[]>((nodes, segment, index) => {
    if (segment.kind === 'code') {
      nodes.push(
        <pre key={`code-${index}`} className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-emerald-200">
          <code>{segment.content}</code>
        </pre>,
      );
    } else {
      nodes.push(...renderTextBlocks(segment.content, index));
    }
    return nodes;
  }, []);
}

interface MarkdownSegment {
  kind: 'text' | 'code';
  content: string;
}

const CODE_LANGUAGES = new Set([
  'bash', 'c', 'cpp', 'cs', 'css', 'go', 'html', 'java', 'javascript', 'js',
  'json', 'php', 'py', 'python', 'ruby', 'rust', 'sh', 'sql', 'text',
  'typescript', 'ts',
]);

function normalizeEscapedFences(text: string): string {
  return text.split('\\`').join('`');
}

function splitFencedCode(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  let codeStart = 0;
  let inlineCode = '';
  let inlineFence = false;
  let inCode = false;
  const fencePattern = /```/g;
  let match = fencePattern.exec(text);

  while (match) {
    if (!inCode) {
      const prose = text.slice(cursor, match.index);
      if (prose) segments.push({ kind: 'text', content: prose });

      const lineEnd = text.indexOf('\n', match.index + match[0].length);
      const nextFence = text.indexOf('```', match.index + match[0].length);
      inlineFence = nextFence >= 0 && (lineEnd < 0 || nextFence < lineEnd);
      if (inlineFence) {
        cursor = match.index + match[0].length;
        codeStart = cursor;
        inlineCode = '';
      } else {
        const info = text.slice(
          match.index + match[0].length,
          lineEnd < 0 ? text.length : lineEnd,
        ).trim();
        const [firstToken = '', ...inlineParts] = info.split(/\s+/);
        if (CODE_LANGUAGES.has(firstToken.toLowerCase())) {
          inlineCode = inlineParts.join(' ');
        } else {
          inlineCode = info;
        }
        cursor = lineEnd < 0 ? text.length : lineEnd + 1;
        codeStart = cursor;
      }
      inCode = true;
    } else {
      let body = text.slice(codeStart, match.index).replace(/\n$/, '');
      if (inlineFence) body = stripInlineLanguage(body);
      const content = [inlineCode, body].filter(Boolean).join(body ? '\n' : '');
      segments.push({ kind: 'code', content });
      cursor = match.index + match[0].length;
      inlineCode = '';
      inlineFence = false;
      inCode = false;
    }
    match = fencePattern.exec(text);
  }

  if (inCode) {
    let body = text.slice(codeStart).replace(/\n$/, '');
    if (inlineFence) body = stripInlineLanguage(body);
    segments.push({
      kind: 'code',
      content: [inlineCode, body].filter(Boolean).join(body ? '\n' : ''),
    });
  } else if (cursor < text.length) {
    segments.push({ kind: 'text', content: text.slice(cursor) });
  }
  return segments;
}

function stripInlineLanguage(code: string): string {
  const trimmed = code.trimStart();
  const separator = trimmed.search(/\s/);
  if (separator < 0) return CODE_LANGUAGES.has(trimmed.toLowerCase()) ? '' : trimmed;
  const language = trimmed.slice(0, separator).toLowerCase();
  return CODE_LANGUAGES.has(language) ? trimmed.slice(separator).trimStart() : trimmed;
}

function renderTextBlocks(text: string, keyPrefix: number): ReactNode[] {
  return text.split(/\n{2,}/).map((block, index) => {
    const trimmed = block.trim();
    if (!trimmed) return null;
    const lines = trimmed.split('\n');
    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      return <ul key={`${keyPrefix}-list-${index}`} className="list-disc space-y-1 pl-5">{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{formatInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>)}</ul>;
    }
    if (lines.every((line) => /^\d+\.\s+/.test(line))) {
      return <ol key={`${keyPrefix}-ordered-${index}`} className="list-decimal space-y-1 pl-5">{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{formatInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>)}</ol>;
    }
    if (/^#{1,3}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,3}\s+/, '');
      return <h3 key={`${keyPrefix}-heading-${index}`} className="text-lg font-semibold text-emerald-200">{formatInlineMarkdown(heading)}</h3>;
    }
    return <p key={`${keyPrefix}-paragraph-${index}`}>{formatInlineMarkdown(trimmed)}</p>;
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
