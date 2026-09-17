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

export function createTaskRuntimeState(initial = {}) {
  const state = {
    phase: initial.phase || 'CREATED',
    taskState: initial.taskState || initial.phase || 'CREATED',
    planVersion: Number(initial.planVersion || 1),
    plan: initial.plan || null,
    taskGraph: initial.taskGraph || null,
    assumptions: Array.isArray(initial.assumptions) ? [...initial.assumptions] : [],
    observations: Array.isArray(initial.observations) ? [...initial.observations] : [],
    decisionLog: Array.isArray(initial.decisionLog) ? [...initial.decisionLog] : [],
    contextQuality: {
      candidateFiles: Array.isArray(initial?.contextQuality?.candidateFiles) ? [...initial.contextQuality.candidateFiles] : [],
      selectedFiles: Array.isArray(initial?.contextQuality?.selectedFiles) ? [...initial.contextQuality.selectedFiles] : [],
      usedFiles: Array.isArray(initial?.contextQuality?.usedFiles) ? [...initial.contextQuality.usedFiles] : [],
      irrelevantFiles: Array.isArray(initial?.contextQuality?.irrelevantFiles) ? [...initial.contextQuality.irrelevantFiles] : [],
      precision: Number(initial?.contextQuality?.precision || 0),
      recall: Number(initial?.contextQuality?.recall || 0),
      waste: Number(initial?.contextQuality?.waste || 0),
      selectionReason: initial?.contextQuality?.selectionReason || '',
    },
    metrics: {
      toolCalls: Number(initial?.metrics?.toolCalls || 0),
      usefulToolCalls: Number(initial?.metrics?.usefulToolCalls || 0),
      duplicateToolCalls: Number(initial?.metrics?.duplicateToolCalls || 0),
      unnecessaryToolCalls: Number(initial?.metrics?.unnecessaryToolCalls || 0),
      filesRead: Number(initial?.metrics?.filesRead || 0),
      filesChanged: Number(initial?.metrics?.filesChanged || 0),
      verificationRuns: Number(initial?.metrics?.verificationRuns || 0),
      repairAttempts: Number(initial?.metrics?.repairAttempts || 0),
      confidence: initial?.metrics?.confidence || 'LOW',
    },
    taskMemory: {
      goal: initial?.taskMemory?.goal || '',
      constraints: Array.isArray(initial?.taskMemory?.constraints) ? [...initial.taskMemory.constraints] : [],
      filesInspected: Array.isArray(initial?.taskMemory?.filesInspected) ? [...initial.taskMemory.filesInspected] : [],
      importantFindings: Array.isArray(initial?.taskMemory?.importantFindings) ? [...initial.taskMemory.importantFindings] : [],
      plannedChanges: Array.isArray(initial?.taskMemory?.plannedChanges) ? [...initial.taskMemory.plannedChanges] : [],
      proposalIds: Array.isArray(initial?.taskMemory?.proposalIds) ? [...initial.taskMemory.proposalIds] : [],
      verificationResults: Array.isArray(initial?.taskMemory?.verificationResults) ? [...initial.taskMemory.verificationResults] : [],
      failures: Array.isArray(initial?.taskMemory?.failures) ? [...initial.taskMemory.failures] : [],
      negativeFindings: Array.isArray(initial?.taskMemory?.negativeFindings) ? [...initial.taskMemory.negativeFindings] : [],
      repairRounds: Number(initial?.taskMemory?.repairRounds || 0),
    },
    history: Array.isArray(initial.history) ? [...initial.history] : [],
    lastUpdated: initial.lastUpdated || new Date().toISOString(),
  };

  return {
    ...state,
    setPhase(phase, detail = {}) {
      this.phase = phase;
      this.taskState = phase;
      const stamp = new Date().toISOString();
      this.history.push({ phase, at: stamp, ...detail });
      this.observations.push({ kind: phase, phase, at: stamp, eventType: 'PHASE_CHANGE', ...detail });
      if (this.history.length > 18) this.history.shift();
      if (this.observations.length > 24) this.observations.shift();
      this.lastUpdated = stamp;
      return this;
    },
    recordObservation(kind, detail = {}) {
      this.observations.push({ kind, at: new Date().toISOString(), ...detail });
      if (this.observations.length > 24) this.observations.shift();
      this.lastUpdated = new Date().toISOString();
      return this;
    },
    recordDecisionTelemetry(entry = {}) {
      const item = {
        taskId: entry.taskId || this.taskState || 'task',
        phase: entry.phase || this.phase || 'CREATED',
        tool: entry.tool || 'unknown',
        reasonCategory: entry.reasonCategory || 'GENERAL',
        targetScope: entry.targetScope || 'NARROW',
        resultClass: entry.resultClass || 'UNKNOWN',
        duration: Number(entry.duration || 0),
        nextPhase: entry.nextPhase || this.phase || 'CREATED',
        at: entry.at || new Date().toISOString(),
      };
      this.decisionLog.push(item);
      if (this.decisionLog.length > 32) this.decisionLog.shift();
      this.lastUpdated = item.at;
      return item;
    },
    recordToolDecision(decision = {}) {
      this.metrics.toolCalls = Number(this.metrics.toolCalls || 0) + 1;
      if (decision.useful) this.metrics.usefulToolCalls = Number(this.metrics.usefulToolCalls || 0) + 1;
      if (decision.duplicate) this.metrics.duplicateToolCalls = Number(this.metrics.duplicateToolCalls || 0) + 1;
      if (decision.unnecessary) this.metrics.unnecessaryToolCalls = Number(this.metrics.unnecessaryToolCalls || 0) + 1;
      this.observations.push({ kind: 'TOOL_DECISION', ...decision, at: new Date().toISOString() });
      if (this.observations.length > 24) this.observations.shift();
      this.lastUpdated = new Date().toISOString();
      return this;
    },
    recordContextSelection(selection = {}) {
      const candidateFiles = [...new Set((selection.candidateFiles || []).filter(Boolean))];
      const selectedFiles = [...new Set((selection.selectedFiles || []).filter(Boolean))];
      const usedFiles = [...new Set((selection.usedFiles || []).filter(Boolean))];
      const irrelevantFiles = [...new Set((selection.irrelevantFiles || []).filter(Boolean))];
      const precision = selectedFiles.length > 0 ? usedFiles.length / selectedFiles.length : 0;
      const recall = candidateFiles.length > 0 ? usedFiles.length / candidateFiles.length : 0;
      const waste = candidateFiles.length > 0 ? irrelevantFiles.length / candidateFiles.length : 0;
      this.contextQuality = { candidateFiles, selectedFiles, usedFiles, irrelevantFiles, precision, recall, waste, selectionReason: selection.selectionReason || '' };
      this.observations.push({ kind: 'CONTEXT_SELECTION', ...this.contextQuality, at: new Date().toISOString() });
      if (this.observations.length > 24) this.observations.shift();
      this.lastUpdated = new Date().toISOString();
      return this.contextQuality;
    },
    recordPlanRevision(reason, nextPlan, evidence = {}) {
      const previousVersion = this.planVersion;
      this.planVersion += 1;
      this.plan = nextPlan || this.plan;
      this.history.push({ phase: 'PLAN_REVISION', reason, at: new Date().toISOString(), previousPlanVersion: previousVersion, newPlanVersion: this.planVersion, evidenceCategory: evidence.evidenceCategory || 'UNKNOWN' });
      if (this.history.length > 18) this.history.shift();
      this.lastUpdated = new Date().toISOString();
      return { previousPlanVersion: previousVersion, newPlanVersion: this.planVersion, reason, plan: this.plan };
    },
    recordAssumption(kind, detail = {}) {
      const item = {
        kind: String(kind || 'UNKNOWN'),
        at: new Date().toISOString(),
        ...detail,
      };
      this.assumptions.push(item);
      if (this.assumptions.length > 16) this.assumptions.shift();
      this.lastUpdated = item.at;
      return item;
    },
    recordRepairAttempt(strategy, result = {}) {
      this.metrics.repairAttempts = Number(this.metrics.repairAttempts || 0) + 1;
      this.taskMemory.repairRounds = Number(this.taskMemory.repairRounds || 0) + 1;
      this.taskMemory.failures.push({ strategy, result, at: new Date().toISOString() });
      if (this.taskMemory.failures.length > 12) this.taskMemory.failures.shift();
      this.lastUpdated = new Date().toISOString();
      return this.metrics.repairAttempts;
    },
    summarize() {
      return {
        phase: this.phase,
        taskState: this.taskState,
        planVersion: this.planVersion,
        plan: this.plan,
        taskGraph: this.taskGraph,
        metrics: { ...this.metrics },
        taskMemory: { ...this.taskMemory },
        assumptions: [...this.assumptions],
        decisionLog: [...this.decisionLog].slice(-10),
        contextQuality: { ...this.contextQuality },
        observations: [...this.observations].slice(-10),
        history: [...this.history].slice(-10),
        lastUpdated: this.lastUpdated,
      };
    },
  };
}

export function resolveAgentMode(input, defaultMode = 'AGENT') {
  const text = normalized(input).toLowerCase();
  if (!text) return defaultMode;
  if (/\b(what is|what does|why does|where is|who is|show me|explain|summarize|walk me through|describe)\b/.test(text)) return 'ASK';
  if (/\b(plan|roadmap|outline|strategy|breakdown|design)\b/.test(text) && !/\b(fix|implement|add|update|change|modify|refactor)\b/.test(text)) return 'PLAN';
  return defaultMode;
}

export function createTaskMemory(initial = {}) {
  const memory = {
    goal: '',
    constraints: [],
    filesInspected: [],
    importantFindings: [],
    negativeFindings: [],
    plannedChanges: [],
    proposalIds: [],
    verificationResults: [],
    failures: [],
    repairRounds: 0,
    ...initial,
  };

  return {
    ...memory,
    recordFile(filePath) {
      if (!filePath) return this;
      const file = String(filePath);
      if (!this.filesInspected.includes(file)) this.filesInspected.push(file);
      return this;
    },
    addFinding(finding) {
      const cleaned = normalized(finding);
      if (!cleaned) return this;
      this.importantFindings.push(cleaned);
      return this;
    },
    addNegativeFinding(finding) {
      const cleaned = normalized(finding);
      if (!cleaned) return this;
      if (!this.negativeFindings.includes(cleaned)) this.negativeFindings.push(cleaned);
      return this;
    },
    setGoal(goal) {
      this.goal = normalized(goal || '');
      return this;
    },
    addConstraint(constraint) {
      const normalizedConstraint = normalized(constraint);
      if (!normalizedConstraint) return this;
      if (!this.constraints.includes(normalizedConstraint)) this.constraints.push(normalizedConstraint);
      return this;
    },
    recordProposal(proposalId) {
      if (!proposalId || this.proposalIds.includes(String(proposalId))) return this;
      this.proposalIds.push(String(proposalId));
      return this;
    },
    recordVerification(result) {
      this.verificationResults.push(result);
      return this;
    },
    recordFailure(failure) {
      this.failures.push(failure);
      return this;
    },
    incrementRepairRound() {
      this.repairRounds += 1;
      return this;
    },
    summarize() {
      return {
        goal: this.goal,
        constraints: [...this.constraints],
        filesInspected: [...this.filesInspected],
        importantFindings: [...this.importantFindings].slice(-8),
        negativeFindings: [...this.negativeFindings].slice(-8),
        plannedChanges: [...this.plannedChanges].slice(-8),
        proposalIds: [...this.proposalIds],
        verificationResults: [...this.verificationResults].slice(-8),
        failures: [...this.failures].slice(-8),
        repairRounds: this.repairRounds,
      };
    },
  };
}

export function buildTaskPlan(request, evidence = {}) {
  const classification = classifyDeveloperRequest(request);
  const terms = normalized(request).match(/[a-z][a-z0-9_-]{2,}/gi) || [];
  const uniqueTerms = [...new Set(terms.filter((term) => !['please', 'with', 'from', 'into', 'that', 'this', 'what', 'where', 'when', 'there', 'them', 'into'].includes(term.toLowerCase())))].slice(0, 5);
  const taskList = classification.writeRequired
    ? [
        'Inspect the likely implementation target and any direct dependencies.',
        'Confirm the root cause, affected behavior, and relevant tests.',
        'Draft a minimal multi-file proposal and validate the expected scope.',
        'Run the relevant verification script(s).',
        'If verification fails, diagnose, repair, and re-test with approval.',
      ]
    : [
        'Identify the relevant project files or symbols.',
        'Read the most relevant evidence only.',
        'Answer the question or describe the implementation.',
      ];

  return {
    mode: resolveAgentMode(request),
    goal: classification.writeRequired ? 'Fix or implement the requested change safely.' : 'Answer the developer question using repository evidence.',
    tasks: taskList,
    dependencies: taskList.map((_, index) => index === 0 ? [] : [taskList[index - 1]]),
    terms: uniqueTerms,
    evidence: {
      candidatePaths: [...new Set((evidence.candidatePaths || []).slice(0, 10))],
      filesRead: [...new Set((evidence.filesRead || []).slice(0, 10))],
    },
  };
}

export function revisePlanForEvidence(request, evidence = {}) {
  const basePlan = buildTaskPlan(request, evidence);
  const readFiles = Array.isArray(evidence.filesRead) ? evidence.filesRead : [];
  const configEvidence = readFiles.some((file) => /(?:config|env|settings|package|vite|tsconfig|webpack)/i.test(String(file)));
  const likelyConfigBug = configEvidence && /(?:config|env|timeout|port|secret|auth|credential|provider)/i.test(normalized(request));
  if (!likelyConfigBug) return { plan: basePlan, revised: false, planVersion: 1 };
  const revisedPlan = {
    ...basePlan,
    tasks: [
      'Confirm actual configuration or environment inputs involved in the bug.',
      'Validate the observed runtime behavior against configuration and failing tests.',
      'Apply the minimal code or config fix with explicit verification.',
      'Run targeted verification and check for regressions.',
    ],
    dependencies: [[], ['Confirm actual configuration or environment inputs involved in the bug.'], ['Validate the observed runtime behavior against configuration and failing tests.'], ['Apply the minimal code or config fix with explicit verification.']],
    revisionReason: 'Config or environment evidence narrowed the likely root cause away from the first implementation target.',
  };
  return { plan: revisedPlan, revised: true, planVersion: basePlan ? 2 : 1 };
}

export function summarizeToolEfficiency(runtime = {}) {
  const metrics = runtime.metrics || {};
  return {
    totalToolCalls: Number(metrics.toolCalls || 0),
    usefulToolCalls: Number(metrics.usefulToolCalls || 0),
    duplicateToolCalls: Number(metrics.duplicateToolCalls || 0),
    unnecessaryToolCalls: Number(metrics.unnecessaryToolCalls || 0),
    filesRead: Number(metrics.filesRead || 0),
    filesChanged: Number(metrics.filesChanged || 0),
    verificationRuns: Number(metrics.verificationRuns || 0),
    repairAttempts: Number(metrics.repairAttempts || 0),
  };
}

export function detectBadToolBehavior(decisionLog = []) {
  const duplicateToolCalls = [];
  const repeatedSearches = [];
  const repeatedReads = [];
  const invalidPhaseUsage = [];
  const seenKeys = new Map();

  for (const item of decisionLog) {
    const tool = String(item.tool || '');
    const phase = String(item.phase || '');
    const repeated = decisionLog.filter((entry) => String(entry.tool || '') === tool).length > 1;
    if (repeated && /(search_code|find_references|get_repository_map)/i.test(tool)) repeatedSearches.push(tool);
    if (repeated && /read_file/i.test(tool)) repeatedReads.push(tool);
    if (tool && /run_command|read_file/.test(tool) && /UNDERSTANDING|PROPOSING/.test(phase)) invalidPhaseUsage.push({ tool, phase });
    if (tool) {
      const key = `${item.tool}:${item.phase}:${item.targetScope}:${item.reasonCategory}`;
      const seen = seenKeys.get(key) || 0;
      if (seen > 0) duplicateToolCalls.push(key);
      seenKeys.set(key, seen + 1);
    }
  }

  return {
    duplicateToolCalls: [...new Set(duplicateToolCalls)],
    repeatedSearches: [...new Set(repeatedSearches)],
    repeatedReads: [...new Set(repeatedReads)],
    invalidPhaseUsage,
  };
}

export function calculateContextQuality({ candidateFiles = [], selectedFiles = [], usedFiles = [], irrelevantFiles = [] } = {}) {
  const candidate = [...new Set(candidateFiles.filter(Boolean))];
  const selected = [...new Set(selectedFiles.filter(Boolean))];
  const used = [...new Set(usedFiles.filter(Boolean))];
  const irrelevant = [...new Set(irrelevantFiles.filter(Boolean))];
  const precision = selected.length > 0 ? used.length / selected.length : 0;
  const recall = candidate.length > 0 ? used.length / candidate.length : 0;
  const waste = candidate.length > 0 ? irrelevant.length / candidate.length : 0;
  return { candidateFiles: candidate, selectedFiles: selected, usedFiles: used, irrelevantFiles: irrelevant, contextPrecision: Number(precision.toFixed(3)), contextRecall: Number(recall.toFixed(3)), contextWaste: Number(waste.toFixed(3)) };
}

export function evaluateCompletionState({ implemented = false, verificationStatus = null, repairAttempts = 0, changedFiles = [], taskState = 'CREATED' } = {}) {
  const shouldComplete = implemented && verificationStatus === 'PASS';
  if (shouldComplete) return { status: 'COMPLETED', confidence: 'HIGH' };
  if (verificationStatus === 'FAIL' || repairAttempts > 0) return { status: 'FAILED', confidence: 'MEDIUM' };
  if (taskState === 'BLOCKED') return { status: 'BLOCKED', confidence: 'LOW' };
  if (implemented && verificationStatus === 'NOT_AVAILABLE') return { status: 'COMPLETED_WITH_LIMITATIONS', confidence: 'MEDIUM' };
  if (changedFiles.length > 0 && verificationStatus === null) return { status: 'FAILED', confidence: 'LOW' };
  return { status: 'FAILED', confidence: 'LOW' };
}

export function createTaskGraph(taskPlan = {}) {
  const tasks = Array.isArray(taskPlan.tasks) ? taskPlan.tasks : [];
  return {
    goal: taskPlan.goal || 'Developer task',
    status: 'PENDING',
    tasks: tasks.map((task, index) => ({
      id: `task-${index + 1}`,
      label: task,
      status: index === 0 ? 'PENDING' : 'WAITING',
      dependsOn: index === 0 ? [] : [`task-${index}`],
    })),
  };
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
  const taskPlan = buildTaskPlan(request);
  const taskGraph = createTaskGraph(taskPlan);
  const runtimeState = createTaskRuntimeState({
    phase: 'UNDERSTANDING',
    taskState: 'UNDERSTANDING',
    plan: taskPlan,
    taskGraph,
    taskMemory: {
      goal: taskPlan.goal,
      constraints: ['read-only until explicit approval', 'respect project confinement'],
      filesInspected: [],
      importantFindings: [],
      plannedChanges: taskPlan.tasks,
      proposalIds: [],
      verificationResults: [],
      failures: [],
      repairRounds: 0,
    },
  });
  return {
    classification,
    initialSearches: initialSearches.slice(0, 6),
    maxFilesPerStep: 6,
    maxReadCharsPerStep: 24000,
    nextStep: classification.intent === 'QUESTION' ? 'ANSWER_FROM_CONTEXT' : 'SEARCH_RELEVANT_FILES',
    mode: resolveAgentMode(request),
    taskPlan,
    taskGraph,
    runtimeState: runtimeState.summarize(),
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
  const memory = createTaskMemory({
    goal: plan.taskPlan.goal,
    constraints: [
      'read-only until a validated proposal is explicitly approved',
      'do not guess target files or dependencies',
      'respect project-root confinement and allow-listed verification',
      'protect mode isolation between Developer, Assistant, and General Agent states',
      'never delete or destroy project history, files, branches, credentials, or user data',
    ],
  });
  const runtimeState = createTaskRuntimeState({
    phase: 'UNDERSTANDING',
    taskState: 'UNDERSTANDING',
    plan: plan.taskPlan,
    taskGraph: plan.taskGraph,
    taskMemory: memory.summarize(),
  });
  return [
    'Developer decision layer (read-only until a validated proposal is explicitly approved):',
    JSON.stringify({
      ...plan,
      taskMemory: memory.summarize(),
      runtimeState: runtimeState.summarize(),
    }),
    'Mode: ' + plan.mode,
    'Task plan: ' + JSON.stringify(plan.taskPlan),
    'Task state: ' + JSON.stringify(runtimeState.summarize()),
    'Developer Mode scope:',
    '- Read and inspect only the selected project/workspace.',
    '- Keep file operations confined to the selected project root and reject path traversal or absolute paths outside the root.',
    '- Treat the developer environment as read-only until there is a validated proposal and explicit approval.',
    '- Never modify, delete, or overwrite files, directories, branches, git history, credentials, secrets, logs, or backups.',
    '- Never use destructive cleanup or deletion as a workaround for any problem.',
    '- Before closing, restarting, or shutting down a running process, service, task, or connection, ask exactly: "Are you sure you want to close [process/task name]?" and continue only after explicit user confirmation: "yes".',
    '- Keep Assistant, Developer, and General Agent state isolated; do not leak mutable state or credentials between modes.',
    '- Only run allow-listed verification commands inside the selected project. Do not run arbitrary commands or commands that can mutate the project or system.',
    'For coding changes, search and read relevant files before proposing anything.',
    'Do not guess target files, symbols, dependencies, tests, or configuration. If evidence is missing, use another focused read step or ask a clarification.',
    'Never claim a change was applied. The current Developer Mode has no filesystem write capability.',
    'If the task requires a change, propose the minimal safe change only after evidence is sufficient and the user explicitly approves it.',
  ].join('\n');
}

export { INTENTS };
