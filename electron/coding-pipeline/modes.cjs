/**
 * Agent Operating Modes & Complexity Routing for Omni Coding Agent.
 * Enforces explicit operating modes (ASK, INVESTIGATE, PLAN, BUILD, VERIFY, AUTONOMOUS)
 * and complexity-based reasoning budgets (FAST, DEEP, PARALLEL).
 * Zero-hardcoding.
 */

const OPERATING_MODES = Object.freeze({
  AUDIT: 'AUDIT',
  ASK: 'ASK',
  INVESTIGATE: 'INVESTIGATE',
  PLAN: 'PLAN',
  BUILD: 'BUILD',
  VERIFY: 'VERIFY',
  AUTONOMOUS: 'AUTONOMOUS',
});

const MODE_SPECIFICATIONS = Object.freeze({
  AUDIT: {
    mode: 'AUDIT',
    description: 'Read-only repository audit & preservation inspection. Proposals, file writes, and Git mutations are strictly blocked.',
    allowedLifecycleStates: ['queued', 'idle', 'reading', 'understanding', 'investigating', 'completed', 'cancelled'],
    canProposeChanges: false,
    canApplyChanges: false,
    canExecuteVerification: false,
    canMutateGit: false,
    defaultComplexity: 'FAST',
    maxToolBudget: 15,
  },
  ASK: {
    mode: 'ASK',
    description: 'Answering questions, code explanations, and architecture inquiries with codebase context. Read-only.',
    allowedLifecycleStates: ['queued', 'idle', 'reading', 'understanding', 'investigating', 'completed', 'cancelled'],
    canProposeChanges: false,
    canApplyChanges: false,
    canExecuteVerification: false,
    canMutateGit: false,
    defaultComplexity: 'FAST',
    maxToolBudget: 5,
  },
  INVESTIGATE: {
    mode: 'INVESTIGATE',
    description: 'In-depth diagnostics, stack trace analysis, and root cause discovery. Read-only.',
    allowedLifecycleStates: ['queued', 'idle', 'reading', 'understanding', 'planning', 'discovering', 'investigating', 'completed', 'cancelled', 'paused', 'failed'],
    canProposeChanges: false,
    canApplyChanges: false,
    canExecuteVerification: true, // safe test run for repro
    canMutateGit: false,
    defaultComplexity: 'DEEP',
    maxToolBudget: 25,
  },
  PLAN: {
    mode: 'PLAN',
    description: 'Generates structured implementation plan, target file breakdown, and risk assessment without editing files.',
    allowedLifecycleStates: ['queued', 'idle', 'reading', 'understanding', 'planning', 'discovering', 'investigating', 'completed', 'cancelled'],
    canProposeChanges: true, // generates plan artifact, not code patch
    canApplyChanges: false,
    canExecuteVerification: false,
    canMutateGit: false,
    defaultComplexity: 'DEEP',
    maxToolBudget: 15,
  },
  BUILD: {
    mode: 'BUILD',
    description: 'Implementation mode: creates proposal, diff, awaits approval, and applies atomically with snapshot rollback.',
    allowedLifecycleStates: ['queued', 'idle', 'reading', 'understanding', 'planning', 'discovering', 'investigating', 'planning_change', 'proposal_ready', 'awaiting_approval', 'approved', 'applying', 'executing', 'verifying', 'completed', 'recovering', 'cancelled'],
    canProposeChanges: true,
    canApplyChanges: true, // requires user approval
    canExecuteVerification: true,
    defaultComplexity: 'DEEP',
    maxToolBudget: 35,
  },
  VERIFY: {
    mode: 'VERIFY',
    description: 'Executes test, lint, typecheck, build, and browser verification battery to validate system health.',
    allowedLifecycleStates: ['queued', 'idle', 'verifying', 'testing', 'completed', 'recovering', 'cancelled'],
    canProposeChanges: false,
    canApplyChanges: false,
    canExecuteVerification: true,
    canMutateGit: false,
    defaultComplexity: 'FAST',
    maxToolBudget: 10,
  },
  AUTONOMOUS: {
    mode: 'AUTONOMOUS',
    description: 'Full autonomous engineering lifecycle: Discover -> Investigate -> Plan -> Propose -> Gate -> Apply -> Verify -> Heal.',
    allowedLifecycleStates: [
      'queued', 'idle', 'reading', 'understanding', 'planning', 'discovering',
      'investigating', 'planning_change', 'proposal_ready', 'awaiting_approval',
      'approved', 'applying', 'executing', 'testing', 'recovering', 'verifying',
      'completed', 'paused', 'blocked', 'cancelled', 'failed', 'budget_exhausted', 'needs_user'
    ],
    canProposeChanges: true,
    canApplyChanges: true, // gated by approval
    canExecuteVerification: true,
    defaultComplexity: 'DEEP',
    maxToolBudget: 50,
  },
});

const COMPLEXITY_LEVELS = Object.freeze({
  FAST: {
    level: 'FAST',
    reasoningRounds: 2,
    maxContextFiles: 3,
    toolCallBudget: 5,
    parallelizationAllowed: false,
    contradictionDetection: 'standard',
  },
  DEEP: {
    level: 'DEEP',
    reasoningRounds: 10,
    maxContextFiles: 20,
    toolCallBudget: 30,
    parallelizationAllowed: true,
    contradictionDetection: 'exhaustive',
  },
  PARALLEL: {
    level: 'PARALLEL',
    reasoningRounds: 6,
    maxContextFiles: 30,
    toolCallBudget: 40,
    parallelizationAllowed: true,
    maxSubtasks: 6,
    contradictionDetection: 'exhaustive',
  },
});

function hasConcreteCreationDirective(text) {
  return /\b(?:build|create|implement|scaffold|generate|add|update|modify)\b[\s\S]{0,180}\b(?:feature|endpoint|route|api|model|schema|page|component|form|service|application|project|system|module)\b/i.test(text);
}

function explicitlyRequestsNoChanges(text) {
  return /\b(?:do\s+not|don't|dont|never)\s+(?:(?:just|only|actually|any)\s+){0,2}(?:modify|change|edit|write|apply|implement|fix|repair|patch|add|create|refactor|update|remove|delete|touch)\b/i.test(text)
    || /\bwithout\s+(?:(?:just|only|actually|any)\s+)?(?:modifying|changing|editing|writing|applying|implementing|fixing|repairing|patching|adding|creating|refactoring|updating|removing|deleting|touching)\b/i.test(text)
    || /\bwithout\s+making\s+(?:(?:any|code|file|source)\s+)*(?:changes?|modifications?|edits?|writes?|patches?)\b/i.test(text)
    || /\bno\s+(?:(?:code|file|source)\s+)?(?:changes?|modifications?|edits?|writes?|patches?)\b/i.test(text);
}

function startsWithDiagnosticInquiry(text) {
  return /^\s*(?:(?:please\s+)?(?:investigate|diagnose|debug|audit|trace|explain)\b|why\b|how\b|what\s+(?:happened|caused|is\s+wrong)\b|find\s+(?:the\s+)?(?:cause|root\s+cause)\b)/i.test(text);
}

function routeTaskMode({ goal = '', intent = '', userRequestedMode = null, explicitComplexity = null }) {
  let resolvedMode = OPERATING_MODES.AUTONOMOUS;
  const text = `${goal} ${intent}`.trim();
  const explicitMode = typeof userRequestedMode === 'string'
    ? OPERATING_MODES[userRequestedMode.toUpperCase()]
    : null;

  if (explicitMode === OPERATING_MODES.AUDIT) {
    resolvedMode = explicitMode;
  } else if (hasConcreteCreationDirective(text)
    && !startsWithDiagnosticInquiry(text)
    && !explicitlyRequestsNoChanges(text)) {
    resolvedMode = OPERATING_MODES.AUTONOMOUS;
  } else if (explicitMode) {
    resolvedMode = explicitMode;
  } else {
    const textLower = text.toLowerCase();

    // 1. Detect clear actionable requests first (e.g. "Fix the audit logging bug", "Implement an audit service", "Add tests for audit events")
    const isActionDirective = /^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:fix|repair|patch|implement|add|create|refactor|update|modify|change|remove|delete|write|build|resolve)\b/i.test(text);

    // 2. Detect explicit read-only audit requests (e.g. "Perform a read-only audit", "Audit the repository without modifying files")
    const isExplicitAudit = /^(?:run|perform|do|conduct|execute)\s+(?:an?\s+)?(?:read-only\s+|preservation\s+|security\s+)?audit\b/i.test(text)
      || /\b(?:read-only|preservation)\s+audit\b/i.test(text)
      || /\b(?:security|compliance)\s+audit\b/i.test(text)
      || /^(?:audit|inspect)\s+(?:the\s+)?(?:codebase|repo|repository|project|worktree|modules?|controllers?|files?)\b/i.test(text)
      || (/\b(?:audit|inspect)\b/i.test(text) && /\b(?:without\s+(?:modifying|changing|editing|writing|applying)|read-only|no\s+changes?)\b/i.test(text));

    // 3. Detect conversational explanations and questions
    const isQuestionOrExplanation = /^(?:what\s+(?:is|are|does|do|happens)|how\s+(?:does|do|can|is|are)|why\s+(?:is|does|do)|where\s+(?:is|can)|explain|describe|show\s+me|tell\s+me\s+about|help\s+me\s+understand)\b/i.test(text);
    const isActionableCreation = hasConcreteCreationDirective(text) && !startsWithDiagnosticInquiry(text);

    const isExplicitNoChange = /\b(?:do\s+not|don't|dont|never)\s+(?:(?:just|only|actually|any)\s+){0,2}(?:modify|change|edit|write|apply|implement|fix|repair|patch|add|create|refactor|update|remove|delete|touch)\b/i.test(text)
      || /\bwithout\s+(?:(?:just|only|actually|any)\s+)?(?:modifying|changing|editing|writing|applying|implementing|fixing|repairing|patching|adding|creating|refactoring|updating|removing|deleting|touching)\b/i.test(text)
      || /\b(?:do\s+not|don't|dont)\s+(?:want|need|expect)\s+(?:any\s+)?(?:code\s+)?(?:changes?|modifications?|edits?|patches?)\b/i.test(text)
      || /\b(?:do\s+not|don't|dont|never)\s+(?:make|apply)\s+(?:any\s+)?(?:code\s+)?changes?(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(text)
      || /\bwithout\s+making\s+(?:any\s+)?(?:code\s+)?changes?(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(text)
      || /\bno\s+(?:(?:code|file|source)\s+)?(?:changes?|modifications?|edits?|writes?|patches?)(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(text);
    const hasInvestigationIntent = /\b(?:investigate|diagnose|find\s+(?:the\s+)?cause|root\s+cause|why|failing|fails|failed|broken|error|bug|bottleneck|performance)\b/i.test(text);
    const hasVerificationIntent = /\b(?:test\s+only|verify\s+only|run\s+tests|check\s+build|verification)\b/i.test(text);
    const hasPlanningIntent = /\b(?:plan|design|architect|roadmap)\b/i.test(text);

    if (isExplicitNoChange) {
      if (isExplicitAudit) {
        resolvedMode = OPERATING_MODES.AUDIT;
      } else if (isQuestionOrExplanation) {
        resolvedMode = OPERATING_MODES.ASK;
      } else if (hasInvestigationIntent) {
        resolvedMode = OPERATING_MODES.INVESTIGATE;
      } else if (hasVerificationIntent) {
        resolvedMode = OPERATING_MODES.VERIFY;
      } else if (hasPlanningIntent) {
        resolvedMode = OPERATING_MODES.PLAN;
      } else {
        resolvedMode = OPERATING_MODES.ASK;
      }
    } else if (isActionDirective) {
      resolvedMode = OPERATING_MODES.AUTONOMOUS;
    } else if (isExplicitAudit) {
      resolvedMode = OPERATING_MODES.AUDIT;
    } else if (isQuestionOrExplanation) {
      resolvedMode = OPERATING_MODES.ASK;
    } else if (isActionableCreation) {
      resolvedMode = OPERATING_MODES.AUTONOMOUS;
    } else if (
      textLower.includes('investigate') ||
      textLower.includes('diagnose') ||
      textLower.includes('find cause') ||
      textLower.includes('why is') ||
      textLower.includes('taking time') ||
      textLower.includes('take time') ||
      textLower.includes('slow') ||
      textLower.includes('bottleneck') ||
      textLower.includes('performance') ||
      textLower.includes('measure') ||
      textLower.includes('explain analyze') ||
      textLower.includes('run explain')
    ) {
      resolvedMode = OPERATING_MODES.INVESTIGATE;
    } else if (textLower.includes('plan') || textLower.includes('design') || textLower.includes('architect') || textLower.includes('roadmap')) {
      resolvedMode = OPERATING_MODES.PLAN;
    } else if (textLower.includes('test only') || textLower.includes('verify only') || textLower.includes('run tests') || textLower.includes('check build')) {
      resolvedMode = OPERATING_MODES.VERIFY;
    } else if (/\b(?:fix|implement|refactor|add|create|update|patch|resolve)\b/i.test(textLower)) {
      resolvedMode = OPERATING_MODES.AUTONOMOUS;
    }
  }

  const modeSpec = MODE_SPECIFICATIONS[resolvedMode];

  let complexity = explicitComplexity || modeSpec.defaultComplexity;
  if (!COMPLEXITY_LEVELS[complexity]) {
    complexity = modeSpec.defaultComplexity;
  }

  // Auto-escalate complexity if multi-file or cross-module terms are detected
  const goalLower = goal.toLowerCase();
  if (complexity === 'FAST' && (goalLower.includes('across') || goalLower.includes('everywhere') || goalLower.includes('all files') || goalLower.includes('refactor'))) {
    complexity = 'DEEP';
  }

  const complexitySpec = COMPLEXITY_LEVELS[complexity];

  return {
    mode: resolvedMode,
    specification: modeSpec,
    complexity,
    complexitySpec,
    effectiveToolBudget: Math.min(modeSpec.maxToolBudget, complexitySpec.toolCallBudget),
    canPropose: modeSpec.canProposeChanges,
    canApply: modeSpec.canApplyChanges,
    canVerify: modeSpec.canExecuteVerification,
    canMutateGit: modeSpec.canMutateGit !== false,
  };
}

module.exports = {
  OPERATING_MODES,
  MODE_SPECIFICATIONS,
  COMPLEXITY_LEVELS,
  routeTaskMode,
};
