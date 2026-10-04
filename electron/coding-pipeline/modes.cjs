/**
 * Agent Operating Modes & Complexity Routing for Omni Coding Agent.
 * Enforces explicit operating modes (ASK, INVESTIGATE, PLAN, BUILD, VERIFY, AUTONOMOUS)
 * and complexity-based reasoning budgets (FAST, DEEP, PARALLEL).
 * Zero-hardcoding.
 */

const OPERATING_MODES = Object.freeze({
  ASK: 'ASK',
  INVESTIGATE: 'INVESTIGATE',
  PLAN: 'PLAN',
  BUILD: 'BUILD',
  VERIFY: 'VERIFY',
  AUTONOMOUS: 'AUTONOMOUS',
});

const MODE_SPECIFICATIONS = Object.freeze({
  ASK: {
    mode: 'ASK',
    description: 'Answering questions, code explanations, and architecture inquiries with codebase context. Read-only.',
    allowedLifecycleStates: ['queued', 'idle', 'reading', 'understanding', 'investigating', 'completed', 'cancelled'],
    canProposeChanges: false,
    canApplyChanges: false,
    canExecuteVerification: false,
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

function routeTaskMode({ goal = '', intent = '', userRequestedMode = null, explicitComplexity = null }) {
  let resolvedMode = OPERATING_MODES.AUTONOMOUS;

  if (userRequestedMode && OPERATING_MODES[userRequestedMode.toUpperCase()]) {
    resolvedMode = OPERATING_MODES[userRequestedMode.toUpperCase()];
  } else {
    const text = `${goal} ${intent}`.toLowerCase();
    if (text.includes('explain') || text.includes('how does') || text.includes('what is') || text.includes('where is')) {
      resolvedMode = OPERATING_MODES.ASK;
    } else if (
      text.includes('investigate') ||
      text.includes('diagnose') ||
      text.includes('find cause') ||
      text.includes('why is') ||
      text.includes('taking time') ||
      text.includes('take time') ||
      text.includes('slow') ||
      text.includes('bottleneck') ||
      text.includes('performance') ||
      text.includes('measure') ||
      text.includes('explain analyze') ||
      text.includes('run explain')
    ) {
      resolvedMode = OPERATING_MODES.INVESTIGATE;
    } else if (text.includes('plan') || text.includes('design') || text.includes('architect') || text.includes('roadmap')) {
      resolvedMode = OPERATING_MODES.PLAN;
    } else if (text.includes('test only') || text.includes('verify only') || text.includes('run tests') || text.includes('check build')) {
      resolvedMode = OPERATING_MODES.VERIFY;
    } else if (text.includes('fix') || text.includes('implement') || text.includes('refactor') || text.includes('add feature')) {
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
  };
}

module.exports = {
  OPERATING_MODES,
  MODE_SPECIFICATIONS,
  COMPLEXITY_LEVELS,
  routeTaskMode,
};
