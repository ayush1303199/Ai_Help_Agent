const MAX_SUMMARY_CHARS = 280;
const MAX_INSIGHT_ITEMS = 3;

function splitAnswer(answer: string) {
  const codeBlocks: string[] = [];
  const prose = answer.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    codeBlocks.push(code.trim());
    return ' ';
  });
  const listItems: string[] = [];
  const text = prose
    .split(/\r?\n/)
    .map((line) => {
      const item = line.trim().match(/^(?:[-*•]|\d+[.)])\s+(.+)$/)?.[1];
      if (item) listItems.push(item);
      if (item || /^\s{0,3}#{1,6}\s+/.test(line)) return ' ';
      return line;
    })
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanListItems = listItems
    .map((item) => item.replace(/[`*_>#]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
  return { text, sentences, listItems: cleanListItems, prose, hasCode: codeBlocks.some(Boolean) };
}

function limitInsight(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const prefix = normalized.slice(0, maxChars - 1);
  const sentenceEnd = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '));
  if (sentenceEnd >= maxChars * 0.55) return `${prefix.slice(0, sentenceEnd + 1).trim()}…`;
  const wordEnd = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, wordEnd > 0 ? wordEnd : prefix.length).trimEnd()}…`;
}

export function buildOverlaySummary(answer: string) {
  const { text, sentences, listItems, hasCode } = splitAnswer(answer);
  if (!text && !listItems.length) return hasCode ? 'A code solution is provided.' : '';

  let summary: string;
  if (text) {
    summary = sentences.slice(0, 2).join(' ');
  } else {
    const firstItems = listItems.slice(0, 2).join('; ');
    const ending = /[.!?]$/.test(firstItems) ? '' : '.';
    summary = listItems.length > 1
      ? `The answer outlines ${listItems.length} steps: ${firstItems}${ending}`
      : firstItems;
  }
  if (hasCode && text) summary = `${summary} Includes a code example.`;
  return limitInsight(summary, MAX_SUMMARY_CHARS);
}

export function buildOverlayActionItems(answer: string) {
  const { prose } = splitAnswer(answer);
  const items = prose
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*{1,2}(?=\d+[.)])/u, ''))
    .filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/\*{1,2}/g, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return items.length ? items : ['No specific action items identified in this answer.'];
}

export function buildOverlayAnalysis(question: string, answer: string) {
  const { text, listItems, hasCode } = splitAnswer(answer);
  if (!text && !listItems.length && !hasCode) return '';

  const responseType = hasCode
    ? listItems.length ? 'Code solution with steps' : 'Code solution'
    : listItems.length ? 'Step-by-step answer' : 'Explanation';
  const keyPoints = listItems.length
    ? listItems.slice(0, MAX_INSIGHT_ITEMS)
    : text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean).slice(0, 2) || [];
  return [
    question.trim() ? `Question focus: ${question.trim()}` : '',
    `Response type: ${responseType}.`,
    keyPoints.length ? `Key points:\n${keyPoints.map((point) => `- ${point}`).join('\n')}` : '',
    hasCode && !text ? 'The answer consists of a runnable code example.' : '',
  ].filter(Boolean).join('\n\n');
}
