export interface DeveloperDiffFile {
  path: string;
  lines: string[];
}

export function parseUnifiedDiff(content: string): DeveloperDiffFile[] {
  const lines = content
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:diff|patch)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/);
  const files: DeveloperDiffFile[] = [];
  let current: DeveloperDiffFile | null = null;

  for (const line of lines) {
    const fileHeader = line.match(/^\+\+\+ (.+?)(?:\t.*)?$/);
    if (fileHeader) {
      let path = fileHeader[1].trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
      path = path.replace(/^(?:[ab])\//, '');
      if (!path || path === '/dev/null' || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
        current = null;
        continue;
      }
      current = { path, lines: [] };
      files.push(current);
      continue;
    }
    if (current && (
      line.startsWith('@@')
      || line.startsWith('+')
      || line.startsWith('-')
      || line.startsWith(' ')
      || line === '\\ No newline at end of file'
    )) {
      current.lines.push(line);
    }
  }
  return files;
}

export function validateUnifiedFile(lines: string[], original: string) {
  const source = original.split(/\r?\n/);
  let sourceIndex = 0;
  const hunkIndexes = lines.flatMap((line, index) => line.startsWith('@@') ? [index] : []);
  if (!hunkIndexes.length) return false;

  for (const hunkIndex of hunkIndexes) {
    const match = lines[hunkIndex].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) return false;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    if (start < sourceIndex || start > source.length) return false;
    sourceIndex = start;
    let consumed = 0;

    for (const line of lines.slice(hunkIndex + 1)) {
      if (line.startsWith('@@')) break;
      if (line.startsWith(' ')) {
        if (source[sourceIndex] !== line.slice(1)) return false;
        sourceIndex += 1;
        consumed += 1;
      } else if (line.startsWith('-')) {
        if (source[sourceIndex] !== line.slice(1)) return false;
        sourceIndex += 1;
        consumed += 1;
      }
    }
    if (oldCount !== consumed) return false;
  }
  return true;
}

export function isUnifiedDiffResponse(content: string) {
  if (/^\s*NO_CHANGES\s*$/i.test(content)) return true;
  return parseUnifiedDiff(content).some((file) => file.lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)));
}

export function createUnvalidatedSuggestion(content: string) {
  const suggestion = content.trim().slice(0, 4000);
  return [
    'No validated diff was generated, so no proposal was created or applied.',
    '',
    '**Unvalidated model suggestion (not a proposal):**',
    suggestion || 'The model returned no usable text suggestion.',
  ].join('\n');
}
