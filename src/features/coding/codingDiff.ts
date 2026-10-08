export interface DeveloperDiffFile {
  path: string;
  sourcePath?: string;
  operation: 'create' | 'modify' | 'delete' | 'rename' | 'delete_directory';
  lines: string[];
}

export function parseUnifiedDiff(content: string): DeveloperDiffFile[] {
  const lines = content
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:diff|patch)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/);
  const files: DeveloperDiffFile[] = [];
  type DiffBuilder = { oldPath: string | null; newPath: string | null; renameFrom: string | null; renameTo: string | null; directoryDelete: string | null; lines: string[] };
  let current: DiffBuilder | null = null;
  const decodePath = (value: string | null, prefix: 'a' | 'b') => {
    if (!value || value === '/dev/null') return null;
    return value.startsWith(`${prefix}/`) ? value.slice(2) : value;
  };
  const newFile = (): DiffBuilder => ({ oldPath: null, newPath: null, renameFrom: null, renameTo: null, directoryDelete: null, lines: [] });
  const activeFile = () => {
    if (!current) current = newFile();
    return current;
  };
  const emitCurrent = () => {
    if (!current) return;
    const oldPath = current.renameFrom || decodePath(current.oldPath, 'a');
    const newPath = current.renameTo || decodePath(current.newPath, 'b');
    if (!oldPath && newPath && isSafeRelativePath(newPath)) {
      files.push({ path: newPath.replace(/\\/g, '/'), operation: 'create', lines: current.lines });
    } else if (oldPath && !newPath && isSafeRelativePath(oldPath)) {
      files.push({ path: oldPath.replace(/\\/g, '/'), operation: 'delete', lines: current.lines });
    } else if (oldPath && newPath && isSafeRelativePath(oldPath) && isSafeRelativePath(newPath)) {
      const operation = oldPath === newPath ? 'modify' : 'rename';
      files.push({
        path: newPath.replace(/\\/g, '/'),
        sourcePath: operation === 'rename' ? oldPath.replace(/\\/g, '/') : undefined,
        operation,
        lines: current.lines,
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (/^diff --git /.test(line)) {
      emitCurrent();
      current = newFile();
      continue;
    }
    const directoryDelete = line.match(/^\*\*\* Delete Directory: (.+)$/);
    if (directoryDelete) {
      emitCurrent();
      const file = newFile();
      file.directoryDelete = directoryDelete[1].trim();
      const relative = file.directoryDelete;
      if (isSafeRelativePath(relative)) files.push({ path: relative.replace(/\\/g, '/'), operation: 'delete_directory', lines: [] });
      current = null;
      continue;
    }
    const oldHeader = line.match(/^--- (.+?)(?:\t.*)?$/);
    if (oldHeader) {
      if (current && current.oldPath !== null) emitCurrent();
      activeFile().oldPath = oldHeader[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const newHeader = line.match(/^\+\+\+ (.+?)(?:\t.*)?$/);
    if (newHeader) {
      activeFile().newPath = newHeader[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const renameFrom = line.match(/^rename from (.+)$/);
    if (renameFrom) {
      activeFile().renameFrom = renameFrom[1].trim();
      continue;
    }
    const renameTo = line.match(/^rename to (.+)$/);
    if (renameTo) {
      activeFile().renameTo = renameTo[1].trim();
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
  emitCurrent();
  return files;
}

function isSafeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, '/');
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split('/').some((segment) => segment === '..' || segment === '.' || !segment || segment.includes(':') || /[. ]$/.test(segment));
}

export function validateUnifiedFile(lines: string[], original: string) {
  const source = original ? original.split(/\r?\n/) : [];
  let sourceIndex = 0;
  const hunkIndexes = lines.flatMap((line, index) => line.startsWith('@@') ? [index] : []);
  if (!hunkIndexes.length) return false;

  for (const hunkIndex of hunkIndexes) {
    const match = lines[hunkIndex].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) return false;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    if (start < sourceIndex || start > source.length) return false;
    sourceIndex = start;
    let consumed = 0;
    let produced = 0;

    for (const line of lines.slice(hunkIndex + 1)) {
      if (line.startsWith('@@')) break;
      if (line.startsWith(' ')) {
        if (source[sourceIndex] !== line.slice(1)) return false;
        sourceIndex += 1;
        consumed += 1;
        produced += 1;
      } else if (line.startsWith('-')) {
        if (source[sourceIndex] !== line.slice(1)) return false;
        sourceIndex += 1;
        consumed += 1;
      } else if (line.startsWith('+')) {
        produced += 1;
      }
    }
    if (oldCount !== consumed || newCount !== produced) return false;
  }
  return true;
}

export function isUnifiedDiffResponse(content: string) {
  if (/^\s*NO_CHANGES\s*$/i.test(content)) return true;
  return parseUnifiedDiff(content).some((file) => file.operation === 'delete_directory'
    || (file.operation === 'rename' && file.lines.length === 0)
    || file.lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)));
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
