/**
 * codingDiffEngine.cjs
 * 
 * Reusable Minimal Diff Engine & Diff Verification for AI Coding Agent.
 * Milestone V17: Generic across languages; verifies minimality, source evidence grounding,
 * hunk integrity, baseline hash validity, and scope boundaries.
 */

const crypto = require('node:crypto');

const DIFF_OUTCOMES = Object.freeze({
  NO_CHANGE_REQUIRED: 'NO_CHANGE_REQUIRED',
  MINIMAL_DIFF_VALID: 'MINIMAL_DIFF_VALID',
  DIFF_REQUIRES_REVIEW: 'DIFF_REQUIRES_REVIEW',
  DIFF_INVALID: 'DIFF_INVALID',
  SOURCE_EVIDENCE_INSUFFICIENT: 'SOURCE_EVIDENCE_INSUFFICIENT',
});

function computeSha256(content) {
  if (typeof content !== 'string') return null;
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function isSafeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split('/').some((segment) => segment === '..' || segment === '.' || !segment || segment.includes(':') || /[. ]$/.test(segment));
}

function parseUnifiedDiff(content) {
  const lines = String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:diff|patch)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/);

  const files = [];
  let current = null;

  const decodePath = (value, prefix) => {
    if (!value || value === '/dev/null') return null;
    return value.startsWith(`${prefix}/`) ? value.slice(2) : value;
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
      current = { oldPath: null, newPath: null, renameFrom: null, renameTo: null, lines: [] };
      continue;
    }
    const oldHeader = line.match(/^--- (.+?)(?:\t.*)?$/);
    if (oldHeader) {
      if (current && current.oldPath !== null) emitCurrent();
      if (!current) current = { oldPath: null, newPath: null, renameFrom: null, renameTo: null, lines: [] };
      current.oldPath = oldHeader[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const newHeader = line.match(/^\+\+\+ (.+?)(?:\t.*)?$/);
    if (newHeader) {
      if (!current) current = { oldPath: null, newPath: null, renameFrom: null, renameTo: null, lines: [] };
      current.newPath = newHeader[1].trim().replace(/^["']|["']$/g, '');
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

/**
 * Validates unified diff hunks against the original file content.
 */
function validateHunksAgainstOriginal(diffLines, originalContent) {
  if (typeof originalContent !== 'string') return { valid: true };
  const source = originalContent ? originalContent.split(/\r?\n/) : [];
  let sourceIndex = 0;
  const hunkIndexes = diffLines.flatMap((line, index) => line.startsWith('@@') ? [index] : []);
  if (!hunkIndexes.length) return { valid: false, error: 'No hunk headers found.' };

  for (const hunkIndex of hunkIndexes) {
    const match = diffLines[hunkIndex].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) return { valid: false, error: `Malformed hunk header: ${diffLines[hunkIndex]}` };
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    if (start < 0 || start > source.length) {
      return { valid: false, error: `Hunk target line ${oldStart} exceeds source boundary (0-${source.length})` };
    }
    sourceIndex = start;
    let consumed = 0;
    let produced = 0;

    for (const line of diffLines.slice(hunkIndex + 1)) {
      if (line.startsWith('@@')) break;
      if (line.startsWith(' ')) {
        if (sourceIndex >= source.length || source[sourceIndex] !== line.slice(1)) {
          return { valid: false, error: `Context line mismatch at line ${sourceIndex + 1}: expected "${line.slice(1)}", got "${source[sourceIndex]}"` };
        }
        sourceIndex += 1;
        consumed += 1;
        produced += 1;
      } else if (line.startsWith('-')) {
        if (sourceIndex >= source.length || source[sourceIndex] !== line.slice(1)) {
          return { valid: false, error: `Deletion line mismatch at line ${sourceIndex + 1}: expected "${line.slice(1)}", got "${source[sourceIndex]}"` };
        }
        sourceIndex += 1;
        consumed += 1;
      } else if (line.startsWith('+')) {
        produced += 1;
      }
    }
    if (oldCount !== consumed || newCount !== produced) {
      return { valid: false, error: `Hunk line count mismatch: expected -${oldCount},+${newCount}; got -${consumed},+${produced}` };
    }
  }
  return { valid: true };
}

/**
 * check_diff evaluates a proposed patch or change against the original file content/hash,
 * source evidence, target scope, and expected behavior.
 */
function check_diff({
  filePath = '',
  originalContent = null,
  originalHash = null,
  proposedPatch = '',
  proposedContent = null,
  inspectedFiles = [],
  evidence = [],
  expectedBehavior = '',
  targetScope = [],
  rootCauseSummary = '',
  rationale = '',
  allowFullRewrite = false,
} = {}) {
  const normFilePath = normalizePath(filePath);
  const warnings = [];

  // 1. File Path Safety and Validation
  if (!filePath || typeof filePath !== 'string' || !isSafeRelativePath(filePath)) {
    return {
      outcome: DIFF_OUTCOMES.DIFF_INVALID,
      isValid: false,
      filePath,
      rejectionReason: `Invalid or unsafe file path: ${filePath}`,
      reviewWarnings: ['File path is invalid or attempts path traversal.'],
    };
  }

  // 2. Scope validation
  if (Array.isArray(targetScope) && targetScope.length > 0) {
    const normScope = targetScope.map(normalizePath);
    const inScope = normScope.some((s) => normFilePath === s || normFilePath.startsWith(s.endsWith('/') ? s : `${s}/`));
    if (!inScope) {
      return {
        outcome: DIFF_OUTCOMES.DIFF_INVALID,
        isValid: false,
        filePath,
        rejectionReason: `Target file [${filePath}] is outside the target scope [${targetScope.join(', ')}].`,
        reviewWarnings: ['File is outside intended target scope.'],
      };
    }
  }

  // 3. Grounding in Stage 3 Inspected Files
  let resolvedOriginal = originalContent;
  if (Array.isArray(inspectedFiles) && inspectedFiles.length > 0) {
    const inspectedEntry = inspectedFiles.find((f) => normalizePath(typeof f === 'string' ? f : f?.path) === normFilePath);
    if (!inspectedEntry) {
      return {
        outcome: DIFF_OUTCOMES.SOURCE_EVIDENCE_INSUFFICIENT,
        isValid: false,
        filePath,
        rejectionReason: `Scope violation: targetFile [${filePath}] was not inspected in investigation evidence.`,
        reviewWarnings: ['File was not inspected before patch proposal.'],
      };
    }
    if (resolvedOriginal === null && inspectedEntry && typeof inspectedEntry.content === 'string') {
      resolvedOriginal = inspectedEntry.content;
    }
  }

  // 4. Evidence sufficiency
  const evidenceList = Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []);
  const hasEvidence = evidenceList.length > 0
    || (Array.isArray(inspectedFiles) && inspectedFiles.length > 0)
    || Boolean(rootCauseSummary && rootCauseSummary.trim());

  if (!hasEvidence) {
    return {
      outcome: DIFF_OUTCOMES.SOURCE_EVIDENCE_INSUFFICIENT,
      isValid: false,
      filePath,
      rejectionReason: 'No source evidence, inspected files, or root cause summary provided to substantiate this patch.',
      reviewWarnings: ['Insufficient source evidence.'],
    };
  }

  // 5. Baseline Hash and Content Verification
  const computedHash = computeSha256(resolvedOriginal);
  if (originalHash && computedHash) {
    if (originalHash.toLowerCase() !== computedHash.toLowerCase()) {
      return {
        outcome: DIFF_OUTCOMES.DIFF_INVALID,
        isValid: false,
        filePath,
        originalHash,
        computedHash,
        rejectionReason: `Original file content hash mismatch (stale baseline). Expected: ${originalHash}, actual: ${computedHash}`,
        reviewWarnings: ['Stale baseline hash detected.'],
      };
    }
  }

  // 6. No Changes Check
  const patchTrimmed = String(proposedPatch || '').trim();
  if (
    /^\s*NO_CHANGES\s*$/i.test(patchTrimmed)
    || (resolvedOriginal !== null && proposedContent !== null && resolvedOriginal === proposedContent)
    || (patchTrimmed === '' && proposedContent === null)
  ) {
    return {
      outcome: DIFF_OUTCOMES.NO_CHANGE_REQUIRED,
      isValid: true,
      filePath,
      originalHash: computedHash || originalHash || null,
      originalContent: resolvedOriginal,
      proposedPatch: patchTrimmed,
      linesAdded: 0,
      linesRemoved: 0,
      linesChanged: 0,
      hunks: [],
      sourceEvidence: evidenceList,
      rootCauseSummary,
      rationale: rationale || rootCauseSummary,
      expectedBehavior,
      rejectionReason: null,
      reviewWarnings: [],
    };
  }

  // 7. Parse and Validate Unified Diff Hunks
  const diffLines = patchTrimmed.split(/\r?\n/);
  const hunkHeaders = diffLines.filter((l) => l.startsWith('@@'));
  if (hunkHeaders.length === 0 && proposedContent === null) {
    return {
      outcome: DIFF_OUTCOMES.DIFF_INVALID,
      isValid: false,
      filePath,
      rejectionReason: 'Malformed diff: missing unified diff hunk headers (@@ -start,count +start,count @@).',
      reviewWarnings: ['No unified diff hunks found.'],
    };
  }

  // Count added/removed lines
  let linesAdded = 0;
  let linesRemoved = 0;
  const addedLines = [];
  const removedLines = [];

  for (const line of diffLines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      linesAdded++;
      addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      linesRemoved++;
      removedLines.push(line.slice(1));
    }
  }

  if (linesAdded === 0 && linesRemoved === 0 && proposedContent === null) {
    return {
      outcome: DIFF_OUTCOMES.NO_CHANGE_REQUIRED,
      isValid: true,
      filePath,
      originalHash: computedHash || originalHash || null,
      originalContent: resolvedOriginal,
      proposedPatch: patchTrimmed,
      linesAdded: 0,
      linesRemoved: 0,
      linesChanged: 0,
      hunks: [],
      sourceEvidence: evidenceList,
      rootCauseSummary,
      rationale: rationale || rootCauseSummary,
      expectedBehavior,
      rejectionReason: null,
      reviewWarnings: [],
    };
  }

  // Validate hunk alignment against original content if available
  if (resolvedOriginal !== null && hunkHeaders.length > 0) {
    const hunkValidation = validateHunksAgainstOriginal(diffLines, resolvedOriginal);
    if (!hunkValidation.valid) {
      return {
        outcome: DIFF_OUTCOMES.DIFF_INVALID,
        isValid: false,
        filePath,
        originalHash: computedHash || originalHash || null,
        rejectionReason: `Diff validation failed: ${hunkValidation.error}`,
        reviewWarnings: [hunkValidation.error],
      };
    }
  }

  // 8. Minimality vs Whole-File Rewrite Evaluation
  const totalLinesChanged = linesAdded + linesRemoved;
  if (resolvedOriginal !== null) {
    const originalLines = resolvedOriginal.split(/\r?\n/);
    const totalOriginalLines = originalLines.length;

    // Detect excessive whole-file replacement when file is non-trivial
    if (totalOriginalLines >= 15 && !allowFullRewrite) {
      const removalRatio = linesRemoved / totalOriginalLines;
      const additionRatio = linesAdded / totalOriginalLines;
      if (removalRatio >= 0.7 && additionRatio >= 0.7) {
        warnings.push(`Patch replaces ${Math.round(removalRatio * 100)}% of the file (${linesRemoved}/${totalOriginalLines} lines). Prefer a minimal, localized patch.`);
      }
    }

    // Formatting-only churn check
    if (linesAdded > 0 && linesRemoved > 0 && Math.abs(linesAdded - linesRemoved) <= 2) {
      const addedText = addedLines.map((l) => l.trim()).join('');
      const removedText = removedLines.map((l) => l.trim()).join('');
      if (addedText === removedText && addedText.length > 0) {
        warnings.push('Patch appears to be whitespace or formatting churn without behavioral change.');
      }
    }
  }

  // Suspicious debug artifacts check
  for (const line of addedLines) {
    if (/\b(?:debugger|console\.log\(["']test)\b/i.test(line) || /\/\/\s*TODO\s*remove/i.test(line)) {
      warnings.push(`Patch contains possible debug or temporary code: ${line.trim()}`);
    }
  }

  // Check expected behavior requirement
  if (!expectedBehavior || !expectedBehavior.trim()) {
    warnings.push('No expectedBehavior statement provided to describe the intended outcome.');
  }

  // Determine outcome: if warnings present, flag for review; otherwise minimal diff valid
  const outcome = warnings.length > 0
    ? DIFF_OUTCOMES.DIFF_REQUIRES_REVIEW
    : DIFF_OUTCOMES.MINIMAL_DIFF_VALID;

  return {
    outcome,
    isValid: true,
    filePath,
    originalHash: computedHash || originalHash || null,
    originalContent: resolvedOriginal,
    proposedPatch: patchTrimmed,
    linesAdded,
    linesRemoved,
    linesChanged: totalLinesChanged,
    hunks: hunkHeaders,
    sourceEvidence: evidenceList,
    rootCauseSummary: rootCauseSummary || '',
    rationale: rationale || rootCauseSummary || '',
    expectedBehavior: expectedBehavior || '',
    rejectionReason: null,
    reviewWarnings: warnings,
  };
}

module.exports = {
  check_diff,
  checkDiff: check_diff,
  computeSha256,
  parseUnifiedDiff,
  validateHunksAgainstOriginal,
  DIFF_OUTCOMES,
};
