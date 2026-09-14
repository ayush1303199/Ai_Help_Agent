const INTENTS = Object.freeze([
  'QUESTION', 'EXPLANATION', 'CODE_SEARCH', 'BUG_INVESTIGATION', 'BUG_FIX',
  'FEATURE_REQUEST', 'REFACTOR', 'OPTIMIZATION', 'TEST_REQUEST',
  'DOCUMENTATION', 'PROJECT_ANALYSIS', 'ARCHITECTURE_ANALYSIS',
  'CONFIGURATION_CHANGE', 'DEPENDENCY_CHANGE', 'MULTI_FILE_CHANGE',
]);

const WRITE_INTENTS = new Set([
  'BUG_FIX', 'FEATURE_REQUEST', 'REFACTOR', 'OPTIMIZATION',
  'DOCUMENTATION', 'CONFIGURATION_CHANGE', 'DEPENDENCY_CHANGE', 'MULTI_FILE_CHANGE',
]);

function normalized(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function classifyDeveloperRequest(input) {
  const text = normalized(input);
  const lower = text.toLowerCase();
  let intent = 'QUESTION';
  if (/\b(architecture|system design|dependencies flow)\b/.test(lower)) intent = 'ARCHITECTURE_ANALYSIS';
  else if (/\b(project|repository|repo) (overview|analysis|structure)\b/.test(lower)) intent = 'PROJECT_ANALYSIS';
  else if (/\b(config|configuration|environment variable)\b/.test(lower)) intent = 'CONFIGURATION_CHANGE';
  else if (/\b(dependenc|package|library)\b/.test(lower)) intent = 'DEPENDENCY_CHANGE';
  else if (/\bmulti[- ]file\b/.test(lower)) intent = 'MULTI_FILE_CHANGE';
  else if (/\b(explain|what does|how does|why does|walk me through)\b/.test(lower)) intent = 'EXPLANATION';
  else if (/\b(search|find|where is|locate)\b/.test(lower)) intent = 'CODE_SEARCH';
  else if (/\b(debug|investigate|trace|root cause)\b/.test(lower)) intent = 'BUG_INVESTIGATION';
  else if (/\b(fix|repair|resolve)\b/.test(lower)) intent = 'BUG_FIX';
  else if (/\b(test|tests|coverage)\b/.test(lower)) intent = 'TEST_REQUEST';
  else if (/\b(document|readme|docs)\b/.test(lower)) intent = 'DOCUMENTATION';
  else if (/\b(add|implement|create|introduce)\b/.test(lower)) intent = 'FEATURE_REQUEST';
  else if (/\b(refactor|restructure|clean up)\b/.test(lower)) intent = 'REFACTOR';
  else if (/\b(optimi[sz]e|faster|performance)\b/.test(lower)) intent = 'OPTIMIZATION';
  const writeRequired = WRITE_INTENTS.has(intent);
  const risk = /\b(credential|credentials|encryption|decrypt|destructive|mass data|bulk delete)\b/.test(lower)
    ? 'critical'
    : /\b(auth|authentication|authorization|payment|security|secret|delete|migration|production|database)\b/.test(lower)
      ? 'high'
      : writeRequired ? 'medium' : 'low';
  return { intent, scope: text.slice(0, 160), writeRequired, risk };
}

export function buildReadPlan(request) {
  const classification = classifyDeveloperRequest(request);
  const lower = normalized(request).toLowerCase();
  const initialSearches = [];
  const terms = lower.match(/[a-z][a-z0-9_-]{3,}/g) || [];
  for (const term of terms) {
    if (!['please', 'that', 'this', 'with', 'from', 'into', 'what', 'does', 'project'].includes(term) && !initialSearches.includes(term)) {
      initialSearches.push(term);
    }
  }
  if (classification.writeRequired && initialSearches.length === 0) initialSearches.push('src');
  return {
    classification,
    initialSearches: initialSearches.slice(0, 6),
    maxFilesPerStep: 6,
    maxReadCharsPerStep: 24000,
    nextStep: classification.intent === 'QUESTION' ? 'ANSWER_FROM_CONTEXT' : 'SEARCH_RELEVANT_FILES',
  };
}

export function evaluateUnderstanding({ request, evidence = {} }) {
  const classification = classifyDeveloperRequest(request);
  const targetIdentified = Boolean(evidence.targetIdentified);
  const behaviorLocated = Boolean(evidence.behaviorLocated);
  const dependenciesUnderstood = Boolean(evidence.dependenciesUnderstood);
  const testsLocated = Boolean(evidence.testsLocated);
  const scope = evaluateScope(evidence);
  const writeReady = !classification.writeRequired || (
    targetIdentified && behaviorLocated && dependenciesUnderstood && testsLocated && scope.state !== 'SCOPE_BLOCKED'
  );
  const state = !targetIdentified && classification.writeRequired
    ? 'INSUFFICIENT'
    : writeReady ? (dependenciesUnderstood ? 'SUFFICIENT' : 'PARTIAL') : 'PARTIAL';
  return {
    ...classification,
    targetIdentified,
    behaviorLocated,
    dependenciesUnderstood,
    testsLocated,
    scope,
    state,
    writeReady,
    decision: classification.writeRequired ? (writeReady ? 'WRITE_ALLOWED_TO_PROPOSE' : 'READ_MORE') : 'WRITE_NOT_REQUIRED',
  };
}

export function evaluateScope(evidence = {}) {
  const candidateFiles = [...new Set(evidence.candidatePaths || [])];
  const proposalFiles = [...new Set(evidence.proposalFiles || [])];
  const expectedFiles = Number.isInteger(evidence.expectedFiles)
    ? evidence.expectedFiles
    : candidateFiles.length > 0 ? 1 : 0;
  const actualFiles = proposalFiles.length;
  const scopeExpansion = actualFiles > expectedFiles;
  const scopeRisk = scopeExpansion && actualFiles > Math.max(expectedFiles + 2, 3) ? 'high' : scopeExpansion ? 'medium' : 'low';
  const state = scopeExpansion ? (actualFiles > Math.max(expectedFiles * 3, expectedFiles + 3) ? 'SCOPE_UNEXPECTED' : 'SCOPE_EXPANDED') : 'SCOPE_MATCH';
  return {
    expectedFiles,
    candidateFiles,
    proposalFiles,
    expectedScope: { files: expectedFiles },
    actualScope: { files: actualFiles },
    scopeExpansion,
    scopeRisk,
    state,
  };
}

export function clarificationDecision(evidence = {}) {
  const candidates = [...new Set(evidence.candidatePaths || [])];
  if (!evidence.ambiguous || candidates.length < 2) return null;
  return {
    decision: 'NEEDS_CLARIFICATION',
    reason: 'Multiple valid implementation targets were found.',
    candidates: candidates.slice(0, 8),
    question: 'Which implementation target should be changed?',
  };
}

export function updateEvidence(evidence, toolName, result) {
  const next = { ...evidence, filesRead: [...(evidence.filesRead || [])], searches: evidence.searches || 0 };
  if (!result?.ok) return next;
  if (toolName === 'read_file' && result.data?.path) {
    if (!next.filesRead.includes(result.data.path)) next.filesRead.push(result.data.path);
    next.targetIdentified = true;
    next.behaviorLocated = true;
    const path = String(result.data.path).toLowerCase();
    const content = String(result.data.content || '');
    next.dependenciesUnderstood = next.dependenciesUnderstood || /(?:package\.json|composer\.json|pom\.xml|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|tsconfig|config|import\s|require\()/i.test(path + '\n' + content);
    next.testsLocated = next.testsLocated || /(?:test|spec|__tests__)/i.test(path);
  }
  if (toolName === 'search_code' || toolName === 'search_symbols' || toolName === 'get_context') {
    next.searches += 1;
    const results = Array.isArray(result.data?.results)
      ? result.data.results
      : Array.isArray(result.data?.items) ? result.data.items : [];
    next.candidatePaths = [...new Set([...(next.candidatePaths || []), ...results.map((item) => item.path).filter(Boolean)])];
    next.targetIdentified = next.targetIdentified || results.length > 0;
    next.ambiguous = next.ambiguous || results.length > 1;
    next.testsLocated = next.testsLocated || results.some((item) => /(?:test|spec|__tests__)/i.test(item.path || ''));
    next.candidatePaths = [...new Set(next.candidatePaths)];
  }
  if (toolName === 'list_directory') next.structureInspected = true;
  return next;
}

export function evidenceContinuationPrompt(request, evidence) {
  const understanding = evaluateUnderstanding({ request, evidence });
  const clarification = clarificationDecision(evidence);
  if (clarification && evidence.searches > 1 && (evidence.filesRead || []).length >= 2) {
    return `${JSON.stringify(clarification)} Do not propose a change until the user selects a target.`;
  }
  if (understanding.writeRequired && !understanding.writeReady) {
    return `Evidence is ${understanding.state}. Continue focused read-only exploration before answering or proposing changes. Current evidence: ${JSON.stringify({
      filesRead: evidence.filesRead || [],
      candidatePaths: evidence.candidatePaths || [],
      targetIdentified: Boolean(evidence.targetIdentified),
      behaviorLocated: Boolean(evidence.behaviorLocated),
      dependenciesUnderstood: Boolean(evidence.dependenciesUnderstood),
      testsLocated: Boolean(evidence.testsLocated),
    })}. Read the most relevant candidate, dependency/configuration, and test files next. Do not claim readiness.`;
  }
  if (understanding.writeRequired && evidence.ambiguous && (evidence.filesRead || []).length === 0) {
    return 'Multiple candidate targets were found. Inspect enough candidates to determine whether one target is authoritative; if ambiguity remains, ask the user to clarify rather than proposing a change.';
  }
  return `Evidence state: ${understanding.state}. Stop reading unrelated files. Answer the user, or enter the existing proposal flow only if the evidence supports it.`;
}

export function developerDecisionPrompt(request) {
  const plan = buildReadPlan(request);
  return [
    'Developer decision layer (read-only until a validated proposal is explicitly approved):',
    JSON.stringify(plan),
    'For coding changes, search and read relevant files before proposing anything.',
    'Do not guess target files, symbols, dependencies, tests, or configuration. If evidence is missing, use another focused read step or ask a clarification.',
    'Never claim a change was applied. The current Developer Mode has no filesystem write capability.',
  ].join('\n');
}

export { INTENTS };
