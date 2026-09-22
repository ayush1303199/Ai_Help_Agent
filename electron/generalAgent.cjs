const crypto = require('node:crypto');
const capabilityRegistry = require('./generalAgentCapabilities.cjs');
const planner = require('./generalAgentPlanner.cjs');
const execution = require('./generalAgentExecution.cjs');
const electronBrowser = require('./generalAgentElectronBrowser.cjs');

const PHASES = Object.freeze([
  'CREATED',
  'UNDERSTANDING',
  'PLANNING',
  'RESEARCHING',
  'NAVIGATING',
  'WAITING_FOR_LOGIN',
  'PREPARING_ACTION',
  'WAITING_FOR_CONFIRMATION',
  'EXECUTING',
  'VERIFYING',
  'WAITING_FOR_PROVIDER',
  'COMPLETED',
  'COMPLETED_WITH_LIMITATIONS',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
  'RECOVERING',
]);

const RISK_LEVELS = Object.freeze([
  'READ_ONLY',
  'LOW_RISK',
  'USER_DATA',
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL',
  'ACCOUNT_CHANGE',
  'DESTRUCTIVE',
]);

const CONFIRMATION_RISKS = new Set([
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL',
  'ACCOUNT_CHANGE',
  'DESTRUCTIVE',
]);

const TERMINAL_PHASES = new Set([
  'COMPLETED',
  'COMPLETED_WITH_LIMITATIONS',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
]);

const transitions = Object.freeze({
  CREATED: ['UNDERSTANDING', 'CANCELLED'],
  UNDERSTANDING: ['PLANNING', 'RESEARCHING', 'WAITING_FOR_LOGIN', 'CANCELLED', 'FAILED', 'BLOCKED'],
  PLANNING: ['RESEARCHING', 'NAVIGATING', 'PREPARING_ACTION', 'WAITING_FOR_LOGIN', 'WAITING_FOR_PROVIDER', 'COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'CANCELLED', 'FAILED', 'BLOCKED'],
  RESEARCHING: ['PLANNING', 'NAVIGATING', 'PREPARING_ACTION', 'VERIFYING', 'WAITING_FOR_LOGIN', 'WAITING_FOR_PROVIDER', 'COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'CANCELLED', 'FAILED', 'BLOCKED'],
  NAVIGATING: ['RESEARCHING', 'PLANNING', 'PREPARING_ACTION', 'WAITING_FOR_LOGIN', 'CANCELLED', 'FAILED', 'BLOCKED'],
  WAITING_FOR_LOGIN: ['PLANNING', 'RECOVERING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  PREPARING_ACTION: ['WAITING_FOR_CONFIRMATION', 'EXECUTING', 'CANCELLED', 'FAILED', 'BLOCKED'],
  WAITING_FOR_CONFIRMATION: ['EXECUTING', 'RECOVERING', 'CANCELLED', 'FAILED', 'BLOCKED'],
  EXECUTING: ['VERIFYING', 'RECOVERING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  VERIFYING: ['PLANNING', 'RESEARCHING', 'WAITING_FOR_PROVIDER', 'COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'RECOVERING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  WAITING_FOR_PROVIDER: ['RECOVERING', 'RESEARCHING', 'COMPLETED_WITH_LIMITATIONS', 'FAILED', 'CANCELLED', 'BLOCKED'],
  RECOVERING: ['PLANNING', 'RESEARCHING', 'WAITING_FOR_LOGIN', 'COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'CANCELLED', 'FAILED', 'BLOCKED'],
  COMPLETED: ['RECOVERING'],
  COMPLETED_WITH_LIMITATIONS: ['RECOVERING'],
  BLOCKED: ['RECOVERING'],
  FAILED: ['RECOVERING', 'CANCELLED'],
  CANCELLED: [],
});

const TOOL_REGISTRY = Object.freeze({
  navigate: { risk: 'READ_ONLY', keys: ['url'] },
  get_page: { risk: 'READ_ONLY', keys: [] },
  extract_text: { risk: 'READ_ONLY', keys: ['selector', 'maxChars'] },
  click: { risk: 'LOW_RISK', keys: ['target', 'label'] },
  type: { risk: 'USER_DATA', keys: ['target', 'text', 'fieldType'] },
  scroll: { risk: 'READ_ONLY', keys: ['direction', 'amount'] },
  go_back: { risk: 'READ_ONLY', keys: [] },
  wait: { risk: 'READ_ONLY', keys: ['milliseconds'] },
  screenshot: { risk: 'READ_ONLY', keys: [] },
  login_handoff: { risk: 'ACCOUNT_CHANGE', keys: ['reason'] },
  request_confirmation: { risk: 'READ_ONLY', keys: ['actionId', 'summary'] },
  verify_external_action: { risk: 'READ_ONLY', keys: ['actionId', 'evidence'] },
  stop_agent: { risk: 'READ_ONLY', keys: [] },
});

const DEFAULT_BOUNDS = Object.freeze({
  maxActions: 24,
  maxRetries: 3,
  maxNavigationDepth: 8,
  maxScreenshots: 8,
  maxExtractedChars: 12000,
  maxDurationMs: 15 * 60 * 1000,
  maxRecoveryAttempts: 2,
});

const sessions = new Map();
const tasks = new Map();
const browserAdapter = process.versions.electron
  ? electronBrowser.createElectronBrowserAdapter()
  : undefined;
const executionEngine = execution.createExecutionEngine({ browserAdapter });

function now() {
  return new Date().toISOString();
}

function progressMessage(task) {
  const missing = task.plan?.missingInformation?.[0];
  if (missing) return missing.prompt;
  if (task.providerError?.category === 'CONTEXT_TOO_LARGE' || task.providerError?.category === 'BLOCKED_CONTEXT_LIMIT') {
    return 'The request was too large even after one safe context reduction. Browser activity was stopped.';
  }
  if (task.providerError?.category === 'RATE_LIMIT') return 'Provider temporarily rate-limited. Please retry shortly.';
  if (task.providerError?.category === 'TOOL_COMPATIBILITY') return 'The selected model cannot use the required browsing operation right now.';
  if (task.providerError) return 'The live provider could not complete this step. Please retry.';
  if (task.paused) return 'Paused. Resume when you are ready.';
  if (task.phase === 'CREATED') return 'Ready to understand your request.';
  if (task.phase === 'UNDERSTANDING') return 'Understanding your request...';
  if (task.phase === 'PLANNING') {
    const nextAction = task.plan?.nextAction;
    if (nextAction === 'understand-goal') return 'Understanding your request...';
    if (nextAction === 'select-capabilities') return 'Ready to search for options.';
    if (nextAction === 'collect-evidence') return 'Searching for options...';
    if (nextAction === 'compare-options') return 'Comparing results...';
    if (nextAction === 'prepare-result') return 'Checking the best match...';
    if (nextAction === 'verify-result') return 'Verifying the result...';
    return task.plan?.structuredRequirements?.actionIntent === 'RESEARCH'
      ? 'Searching for options...'
      : 'Plan ready. Waiting for the next safe step.';
  }
  if (task.phase === 'RESEARCHING') return 'Collecting relevant information...';
  if (task.phase === 'NAVIGATING') return 'Opening the requested page...';
  if (task.phase === 'WAITING_FOR_LOGIN') return 'Waiting for you to complete login.';
  if (task.phase === 'PREPARING_ACTION') return 'Preparing the requested action...';
  if (task.phase === 'WAITING_FOR_CONFIRMATION') return 'Waiting for your confirmation before any external action.';
  if (task.phase === 'EXECUTING') return 'Executing the confirmed action...';
  if (task.phase === 'VERIFYING') return 'Verifying the result...';
  if (task.phase === 'WAITING_FOR_PROVIDER') return 'The provider is unavailable. Your task is preserved for retry.';
  if (task.phase === 'RECOVERING') return 'Recovering safely from the last step...';
  if (task.phase === 'COMPLETED') return 'Task completed.';
  if (task.phase === 'COMPLETED_WITH_LIMITATIONS') return 'Task completed with limitations.';
  if (task.phase === 'BLOCKED') return task.blockedReason || 'Task is blocked until it is safe to continue.';
  if (task.phase === 'FAILED') return 'The task failed safely.';
  if (task.phase === 'CANCELLED') return 'Task cancelled.';
  return 'Working on your request...';
}

function bounded(value, limit = 2000) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`;
}

function resolveMaybe(value, callback) {
  return value && typeof value.then === 'function' ? value.then(callback) : callback(value);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/password|passcode|otp|cvv|card(number)?|token|secret|cookie|authorization|credential|api.?key/i.test(key)) {
        return [key, '[REDACTED]'];
      }
      return [key, redact(item)];
    }));
  }
  if (value === null || value === undefined || typeof value !== 'string') return value;
  return bounded(value).replace(/(Bearer\s+[A-Za-z0-9._-]+|\b(?:password|passcode|otp|cvv|card(?:\s+number)?|token|secret|cookie|authorization|credential|api.?key)\b(?:\s+(?:is|are|equals)\s*|\s*[:=]\s*)\S+)/gi, '[REDACTED]');
}

function safeText(value, limit = 2000) {
  return bounded(redact(value), limit);
}

function assertOwner(task, owner) {
  if (!owner || task.sessionId !== owner.sessionId || task.ownerWebContentsId !== owner.ownerWebContentsId) {
    throw new Error('General task is not owned by this renderer session.');
  }
}

function assertTaskActive(task) {
  if (task.phase === 'CANCELLED') throw new Error('General task has been cancelled.');
  if (task.paused) throw new Error('General task is paused.');
  if (TERMINAL_PHASES.has(task.phase)) throw new Error(`General task is ${task.phase.toLowerCase()}.`);
}

function siteFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function validateUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A URL is required.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Only valid http and https URLs are allowed.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only credential-free http and https URLs are allowed.');
  }
  return parsed.toString();
}

function containsSensitiveField(value) {
  return /password|passcode|one[-\s]?time|otp|cvv|card(number)?|security code|token|secret|cookie|credential/i.test(String(value || ''));
}

function riskForAction(name, args = {}) {
  if (name === 'click') {
    const target = `${args.target || ''} ${args.label || ''}`;
    if (/(delete|remove|destroy|erase)/i.test(target)) return 'DESTRUCTIVE';
    if (/(buy|purchase|pay|checkout|book|reserve|flight)/i.test(target)) return 'FINANCIAL';
    if (/(send|publish|post|reply|comment|submit|share|message|email)/i.test(target)) return 'EXTERNAL_COMMUNICATION';
    if (/(login|sign[ -]?in|authorize|connect account|password)/i.test(target)) return 'ACCOUNT_CHANGE';
  }
  if (name === 'type' && containsSensitiveField(`${args.target || ''} ${args.fieldType || ''}`)) {
    return 'ACCOUNT_CHANGE';
  }
  return TOOL_REGISTRY[name]?.risk || 'READ_ONLY';
}

function validateToolCall(name, rawArgs = {}) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)) {
    throw new Error(`Unsupported General Agent tool: ${String(name)}.`);
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new Error('General Agent tool arguments must be an object.');
  }
  const definition = TOOL_REGISTRY[name];
  const args = { ...rawArgs };
  const unknownKeys = Object.keys(args).filter((key) => !definition.keys.includes(key));
  if (unknownKeys.length) throw new Error(`Unsupported arguments for ${name}: ${unknownKeys.join(', ')}.`);
  if (name === 'navigate') args.url = validateUrl(args.url);
  if (name === 'extract_text' && args.maxChars !== undefined) {
    args.maxChars = Math.max(1, Math.min(Number(args.maxChars) || 1, DEFAULT_BOUNDS.maxExtractedChars));
  }
  if (name === 'wait') {
    const milliseconds = Number(args.milliseconds);
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 30000) {
      throw new Error('Wait duration must be between 0 and 30000 milliseconds.');
    }
    args.milliseconds = Math.floor(milliseconds);
  }
  if (['click', 'type'].includes(name) && (typeof args.target !== 'string' || !args.target.trim())) {
    throw new Error(`${name} requires a structured target.`);
  }
  if (name === 'type') {
    if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('Type requires non-empty text.');
    if (containsSensitiveField(`${args.target} ${args.fieldType || ''}`)) {
      throw new Error('Sensitive fields must be completed directly by the user during login handoff.');
    }
  }
  return { name, args, riskLevel: riskForAction(name, args) };
}

function transition(task, next, detail = {}) {
  if (task.phase === next) return;
  if (!transitions[task.phase]?.includes(next)) {
    throw new Error(`Invalid General task transition: ${task.phase} -> ${next}.`);
  }
  const previous = task.phase;
  task.phase = next;
  task.updatedAt = now();
  task.history.push({ type: 'PHASE_CHANGE', from: previous, to: next, at: task.updatedAt, ...redact(detail) });
  if (task.history.length > 32) task.history.shift();
}

function block(task, reason) {
  task.blockedReason = safeText(reason);
  task.finalStatus = 'BLOCKED';
  if (!TERMINAL_PHASES.has(task.phase) || task.phase === 'BLOCKED') {
    if (task.phase !== 'BLOCKED') transition(task, 'BLOCKED', { reason: task.blockedReason });
  }
  return publicTask(task);
}

function assertBounds(task, counter) {
  if (Date.now() - task.startedAtMs > task.bounds.maxDurationMs) {
    throw new Error('General task duration limit reached.');
  }
  if (counter === 'action' && task.actionCount >= task.bounds.maxActions) {
    block(task, 'Maximum action limit reached.');
    throw new Error('General task action limit reached.');
  }
  if (counter === 'retry' && task.retryCount >= task.bounds.maxRetries) {
    block(task, 'Maximum retry limit reached.');
    throw new Error('General task retry limit reached.');
  }
  if (counter === 'navigation' && task.navigationDepth >= task.bounds.maxNavigationDepth) {
    block(task, 'Maximum navigation depth reached.');
    throw new Error('General task navigation limit reached.');
  }
  if (counter === 'screenshot' && task.screenshotCount >= task.bounds.maxScreenshots) {
    block(task, 'Maximum screenshot limit reached.');
    throw new Error('General task screenshot limit reached.');
  }
}

function createSession(ownerWebContentsId) {
  const sessionId = crypto.randomUUID();
  sessions.set(ownerWebContentsId, { sessionId, ownerWebContentsId, createdAt: now() });
  return sessionId;
}

function getSession(ownerWebContentsId) {
  if (!sessions.has(ownerWebContentsId)) return createSession(ownerWebContentsId);
  return sessions.get(ownerWebContentsId).sessionId;
}

function getPublicSession(ownerWebContentsId) {
  const sessionId = getSession(ownerWebContentsId);
  const sessionTasks = [...tasks.values()]
    .filter((task) => task.sessionId === sessionId && task.ownerWebContentsId === ownerWebContentsId)
    .map(publicTask);
  return { sessionId, taskIds: sessionTasks.map((task) => task.taskId), tasks: sessionTasks };
}

function normalizeList(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => safeText(item, 300)).filter(Boolean))].slice(0, limit);
}

function normalizeBounds(value) {
  const input = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_BOUNDS).map(([key, defaultValue]) => {
    const requested = Number(input[key]);
    const boundedValue = Number.isFinite(requested)
      ? Math.min(defaultValue, Math.max(1, Math.floor(requested)))
      : defaultValue;
    return [key, boundedValue];
  }));
}

function createTask(ownerWebContentsId, input = {}) {
  const goal = safeText(input.goal, 2000).trim();
  if (!goal) throw new Error('A General Agent task goal is required.');
  const sessionId = getSession(ownerWebContentsId);
  const taskId = crypto.randomUUID();
  const task = {
    taskId,
    sessionId,
    ownerWebContentsId,
    goal,
    requirements: normalizeList(input.requirements),
    constraints: normalizeList(input.constraints),
    phase: 'CREATED',
    currentSite: null,
    currentUrl: null,
    browserSessionId: null,
    pendingAction: null,
    riskLevel: 'READ_ONLY',
    confirmationId: null,
    authenticationState: 'NOT_REQUIRED',
    lastObservation: null,
    actionCount: 0,
    retryCount: 0,
    navigationDepth: 0,
    screenshotCount: 0,
    extractedChars: 0,
    recoveryAttempts: 0,
    taskMemory: {
      summary: null,
      references: [],
      referenceResolution: null,
      currentIntent: null,
      currentCapability: null,
      structuredRequirements: null,
      constraints: [],
      preferences: {},
      selectedReferences: [],
      resultSet: [],
      resultSetSummary: null,
      research: {
        searchQueries: [],
        candidates: [],
        outcome: 'NOT_VERIFIED',
        refinementLimit: 3,
      },
      lastRefinement: null,
      conversationSummary: '',
      pendingAction: null,
      riskLevel: 'READ_ONLY',
      confirmationState: 'NONE',
      completed: [],
      remaining: [goal],
      ruledOut: [],
      observations: [],
    },
    plan: null,
    structuredRequirements: null,
    handoff: null,
    planningStatus: 'NOT_STARTED',
    executionActionId: null,
    observationVersion: 0,
    finalStatus: null,
    blockedReason: null,
    assistantResponse: null,
    providerError: null,
    contextMetrics: null,
    paused: false,
    pausedFromPhase: null,
    history: [],
    bounds: normalizeBounds(input.bounds),
    startedAtMs: Date.now(),
    createdAt: now(),
    updatedAt: now(),
  };
  tasks.set(taskId, task);
  return publicTask(task);
}

function getTask(taskId, ownerWebContentsId) {
  const task = tasks.get(taskId);
  if (!task) throw new Error('Unknown General Agent task.');
  assertOwner(task, { sessionId: getSession(ownerWebContentsId), ownerWebContentsId });
  return task;
}

function startTask(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  if (task.phase !== 'CREATED') throw new Error(`General task cannot start from ${task.phase}.`);
  transition(task, 'UNDERSTANDING', { message: 'General task created.' });
  applyPlan(task, planner.buildPlan(task));
  transition(task, 'PLANNING', { message: 'Task was routed through the General capability registry.' });
  return publicTask(task);
}

function applyPlan(task, plan) {
  plan.version = (task.plan?.version || 0) + 1;
  task.plan = plan;
  task.structuredRequirements = plan.structuredRequirements || null;
  task.taskMemory.summary = plan.objective;
  task.taskMemory.references = plan.structuredRequirements?.references || [];
  task.taskMemory.currentIntent = plan.currentIntent || plan.intent || plan.structuredRequirements?.currentIntent || 'RESEARCH';
  task.taskMemory.currentCapability = plan.categories?.[0] || null;
  task.taskMemory.structuredRequirements = plan.structuredRequirements || null;
  task.taskMemory.constraints = [...task.constraints];
  task.taskMemory.preferences = plan.preferences || {};
  task.taskMemory.riskLevel = plan.riskLevel;
  task.taskMemory.confirmationState = task.confirmationId ? 'PENDING' : 'NONE';
  task.taskMemory.conversationSummary = [task.taskMemory.summary, ...task.requirements.slice(-3)].filter(Boolean).join(' ').slice(0, 1000);
  task.taskMemory.lastRefinement = plan.refinement || null;
  const food = isFoodResearchTask(task) ? plan.structuredRequirements?.domainRequirements?.food : null;
  if (food && task.taskMemory.research?.candidates?.length) {
    const candidates = planner.evaluateFoodCandidates(task.taskMemory.research.candidates, food);
    task.taskMemory.research.candidates = candidates;
    task.taskMemory.research.outcome = planner.foodResearchOutcome(candidates);
    task.taskMemory.resultSet = candidates.filter((candidate) => candidate.classification !== 'IRRELEVANT').slice(0, 12);
    task.taskMemory.resultSetSummary = {
      count: task.taskMemory.resultSet.length,
      matchedCount: candidates.filter((candidate) => candidate.classification === 'MATCH').length,
      partialCount: candidates.filter((candidate) => candidate.classification === 'PARTIAL_MATCH').length,
      outcome: task.taskMemory.research.outcome,
      source: 'UNTRUSTED_EXTERNAL_CONTENT',
      updatedAt: now(),
    };
  }

  task.planningStatus = plan.status;
  task.riskLevel = plan.riskLevel;
  task.taskMemory.remaining = plan.taskGraph.nodes
    .filter((node) => node.status !== 'READY')
    .map((node) => node.title)
    .slice(0, 12);
  task.updatedAt = now();
}

function adaptResearchPlan(task) {
  if (!task.plan || !task.lastObservation) return;
  const evidenceNode = task.plan.taskGraph.nodes.find((node) => node.id === 'collect-evidence');
  if (!evidenceNode) return;
  const requested = Number(task.structuredRequirements?.resultCount || 0);
  const observed = Array.isArray(task.taskMemory.resultSet) ? task.taskMemory.resultSet.length : 0;
  const needsMoreEvidence = requested > 0 && observed < requested;
  evidenceNode.status = needsMoreEvidence ? 'READY' : 'COMPLETED';
  const comparisonNode = task.plan.taskGraph.nodes.find((node) => node.id === 'compare-options');
  if (comparisonNode && !needsMoreEvidence) comparisonNode.status = 'READY';
  task.plan.nextAction = needsMoreEvidence
    ? 'collect-evidence'
    : comparisonNode ? 'compare-options' : 'prepare-result';
  task.plan.version = (task.plan.version || 0) + 1;
  task.taskMemory.lastRefinement = {
    reason: needsMoreEvidence
      ? `The latest observation contained ${observed} of ${requested} requested result(s); research continues.`
      : 'The latest observation satisfied the requested evidence target; the plan can synthesize the result.',
    observedResultCount: observed,
    requestedResultCount: requested || null,
    observationVersion: task.lastObservation.version,
    at: now(),
  };
  task.taskMemory.remaining = task.plan.taskGraph.nodes
    .filter((node) => ['READY', 'PENDING'].includes(node.status))
    .map((node) => node.title)
    .slice(0, 12);
  task.updatedAt = now();
}

function isFoodResearchTask(task) {
  const categories = Array.isArray(task?.plan?.categories) ? task.plan.categories : [];
  return categories.includes('FOOD_RESEARCH') || categories.includes('FOOD');
}

function refreshPlanReadiness(task) {
  if (!task.plan) return;
  for (const node of task.plan.taskGraph.nodes) {
    if (!['PENDING', 'BLOCKED'].includes(node.status)) continue;
    if (node.status === 'BLOCKED' && task.plan.missingInformation.length > 0) continue;
    const dependencies = node.dependsOn.map((id) => task.plan.taskGraph.nodes.find((candidate) => candidate.id === id));
    if (dependencies.every((dependency) => dependency && ['READY', 'COMPLETED'].includes(dependency.status))) {
      node.status = 'READY';
    }
  }
  task.plan.nextAction = task.plan.missingInformation.length
    ? 'ASK_FOR_REQUIRED_INFORMATION'
    : task.plan.taskGraph.nodes.find((node) => node.status === 'READY' || node.status === 'PENDING')?.id || task.plan.taskGraph.terminalNodeId;
}

function recordPlanProgress(task, action) {
  if (!task.plan) return;
  const external = CONFIRMATION_RISKS.has(action.riskLevel);
  const route = task.plan.taskGraph.nodes.find((node) => node.id === 'select-capabilities');
  if (route) route.status = 'COMPLETED';
  const targetId = external ? (action.verified ? 'verify-action' : 'execute-action') : 'collect-evidence';
  const target = task.plan.taskGraph.nodes.find((node) => node.id === targetId);
  if (target) target.status = action.verified ? 'COMPLETED' : 'READY';
  if (external && action.verified) {
    const executed = task.plan.taskGraph.nodes.find((node) => node.id === 'execute-action');
    if (executed) executed.status = 'COMPLETED';
  }
  refreshPlanReadiness(task);
}

function recordPlanPreparation(task, action) {
  if (!task.plan) return;
  const route = task.plan.taskGraph.nodes.find((node) => node.id === 'select-capabilities');
  if (route) route.status = 'COMPLETED';
  if (CONFIRMATION_RISKS.has(action.riskLevel)) {
    const preparation = task.plan.taskGraph.nodes.find((node) => node.id === 'prepare-action');
    if (preparation) preparation.status = 'COMPLETED';
  }
  refreshPlanReadiness(task);
}

function replanTask(taskId, ownerWebContentsId, input = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  const wasTerminal = TERMINAL_PHASES.has(task.phase);
  if (task.phase === 'CANCELLED') throw new Error('Cancelled General tasks cannot be replanned.');
  if (!wasTerminal && !['PLANNING', 'RECOVERING', 'VERIFYING'].includes(task.phase)) {
    throw new Error(`General task cannot be replanned from ${task.phase}.`);
  }
  if (wasTerminal) {
    transition(task, 'RECOVERING', { message: 'Follow-up request resumed the General task.' });
    task.finalStatus = null;
    task.blockedReason = null;
    task.providerError = null;
    task.assistantResponse = null;
    task.contextMetrics = null;
  }
  const followUp = typeof input.message === 'string' ? input.message : typeof input.text === 'string' ? input.text : '';
  const followUpIntent = followUp ? planner.classifyIntent(followUp) : null;
  if (followUpIntent === 'CANCEL') return stopTask(taskId, ownerWebContentsId);
  if (followUp) {
    const referenceResolution = planner.resolveReference(followUp, task.taskMemory.resultSet || []);
    if (referenceResolution.status !== 'NONE') {
      task.taskMemory.referenceResolution = referenceResolution;
      if (referenceResolution.status === 'RESOLVED') {
        task.taskMemory.selectedReferences = [{
          phrase: referenceResolution.phrase,
          index: referenceResolution.index,
          selectedAt: now(),
        }];
      }
    }
  }
  const requirements = normalizeList([
    ...(task.requirements || []),
    ...(Array.isArray(input.requirements) ? input.requirements : []),
    followUp,
  ]);
  const constraints = normalizeList([...(task.constraints || []), ...(Array.isArray(input.constraints) ? input.constraints : [])]);
  task.requirements = requirements;
  task.constraints = constraints;
  applyPlan(task, planner.buildPlan({
    ...task,
    requirements,
    constraints,
    latestText: followUp,
    previousStructuredRequirements: task.structuredRequirements,
    previousPreferences: task.taskMemory.preferences || {},
  }));
  if (task.taskMemory.referenceResolution && ['PENDING_CONTEXT', 'AMBIGUOUS', 'UNRESOLVED'].includes(task.taskMemory.referenceResolution.status)) {
    const referenceReason = task.taskMemory.referenceResolution.reason || 'Clarify which previous option you mean.';
    task.plan.missingInformation = [
      ...task.plan.missingInformation.filter((item) => item.id !== 'reference'),
      { id: 'reference', prompt: 'Which previous option should I use?', reason: referenceReason, requiredFor: 'PREPARE' },
    ];
    task.plan.nextAction = 'ASK_FOR_REQUIRED_INFORMATION';
    task.planningStatus = 'NEEDS_INFORMATION';
  }
  const requiresExternalConfirmation = Boolean(followUp)
    && task.plan.missingInformation.length === 0
    && (task.structuredRequirements?.actionIntent === 'EXECUTE'
      || CONFIRMATION_RISKS.has(task.riskLevel));
  if (requiresExternalConfirmation) {
    if (task.phase !== 'PLANNING') {
      transition(task, 'PLANNING', { message: 'External action requires an explicit confirmation gate.' });
    }
    prepareAction(taskId, ownerWebContentsId, 'click', {
      target: followUp,
      label: 'External action requested by the user.',
    });
    return publicTask(task);
  }
  if (task.phase !== 'PLANNING') transition(task, 'PLANNING', { message: 'General task plan was revised.' });
  else task.history.push({ type: 'PLAN_REVISED', at: now(), planVersion: task.plan.version });
  return publicTask(task);
}

function prepareDeveloperHandoff(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  if (!task.plan) throw new Error('General task must be planned before handoff.');
  const handoff = planner.summarizeForDeveloperHandoff(task.plan);
  task.handoff = { ...handoff, createdAt: now() };
  task.updatedAt = now();
  return { handoff: redact(task.handoff), task: publicTask(task) };
}

function getCapabilityCatalog() {
  return capabilityRegistry.getCapabilityCatalog();
}

function ensureBrowserSession(task) {
  if (task.browserSessionId) return executionEngine.getBrowserSession(task.browserSessionId, task.ownerWebContentsId, {
    generalSessionId: task.sessionId,
    taskId: task.taskId,
  });
  const browser = executionEngine.createBrowserSession(task.sessionId, task.taskId, task.ownerWebContentsId);
  task.browserSessionId = browser.sessionId;
  task.updatedAt = now();
  return executionEngine.getBrowserSession(browser.sessionId, task.ownerWebContentsId, {
    generalSessionId: task.sessionId,
    taskId: task.taskId,
  });
}

function closeTaskBrowser(task, ownerWebContentsId = task.ownerWebContentsId) {
  if (!task.browserSessionId || !executionEngine.sessions.has(task.browserSessionId)) {
    task.browserSessionId = null;
    return;
  }
  try {
    const closed = executionEngine.closeBrowserSession(task.browserSessionId, ownerWebContentsId, {
      generalSessionId: task.sessionId,
      taskId: task.taskId,
    });
    if (closed && typeof closed.then === 'function') closed.catch(() => undefined);
  } catch {
    // Terminal task state must not depend on renderer cleanup completing.
  }
  task.browserSessionId = null;
}

function publicExecutionAction(action) {
  const { owner, ...safeAction } = action;
  return redact(safeAction);
}

function taskTrace(task) {
  const executionAction = task.executionActionId
    ? executionEngine.actions.get(task.executionActionId)
    : null;
  const currentNode = task.plan?.taskGraph?.nodes.find((node) => node.id === task.plan.nextAction);
  const route = task.plan?.capabilityRoutes?.[0];
  const verificationState = executionAction?.state === 'SUCCEEDED' || task.lastObservation?.kind === 'ACTION_VERIFIED'
    ? 'VERIFIED'
    : executionAction?.state === 'VERIFYING' || task.phase === 'VERIFYING'
      ? 'PENDING'
      : executionAction?.state === 'FAILED' || executionAction?.state === 'BLOCKED' || task.lastObservation?.kind === 'ACTION_FAILED'
        ? 'FAILED'
        : 'NOT_STARTED';
  return {
    taskId: task.taskId,
    phase: task.phase,
    intent: task.plan?.currentIntent || task.plan?.intent || null,
    capability: executionAction?.capability || task.taskMemory.currentCapability || route?.capability || null,
    provider: executionAction?.provider || route?.providerCandidates?.[0]?.providerId || task.plan?.providers?.[0] || null,
    currentNode: currentNode?.id || null,
    action: executionAction?.operation || task.pendingAction?.tool || currentNode?.action || null,
    risk: executionAction?.riskLevel || task.riskLevel,
    confirmationState: task.confirmationId ? 'PENDING' : task.taskMemory.confirmationState,
    verificationState,
    failureClassification: executionAction?.failure?.classification || null,
    retryCount: task.retryCount + (executionAction?.retryCount || 0),
  };
}

function rememberExternalResults(task, results) {
  if (!Array.isArray(results)) return;
  const safeResults = results.slice(0, 12).map((result) => redact(result));
  const food = isFoodResearchTask(task) ? task.structuredRequirements?.domainRequirements?.food : null;
  if (food) {
    const existing = Array.isArray(task.taskMemory.research?.candidates)
      ? task.taskMemory.research.candidates
      : [];
    const candidates = planner.evaluateFoodCandidates([...existing, ...safeResults], food);
    task.taskMemory.research.candidates = candidates;
    task.taskMemory.research.outcome = planner.foodResearchOutcome(candidates);
    task.taskMemory.resultSet = candidates
      .filter((candidate) => candidate.classification !== 'IRRELEVANT')
      .slice(0, 12);
    task.taskMemory.resultSetSummary = {
      count: task.taskMemory.resultSet.length,
      matchedCount: candidates.filter((candidate) => candidate.classification === 'MATCH').length,
      partialCount: candidates.filter((candidate) => candidate.classification === 'PARTIAL_MATCH').length,
      outcome: task.taskMemory.research.outcome,
      source: 'UNTRUSTED_EXTERNAL_CONTENT',
      updatedAt: now(),
    };
    return;
  }
  const existing = Array.isArray(task.taskMemory.resultSet) ? task.taskMemory.resultSet : [];
  const merged = [...existing, ...safeResults];
  const identities = new Set();
  const normalized = merged.filter((result) => {
    const identity = String(result?.url || result?.title || result?.name || '').trim().toLowerCase();
    if (!identity || identities.has(identity)) return false;
    identities.add(identity);
    return true;
  }).slice(0, 12);
  task.taskMemory.resultSet = normalized;
  if (task.plan?.currentIntent === 'RESEARCH' || task.plan?.intent === 'RESEARCH') {
    task.taskMemory.research.candidates = normalized;
    task.taskMemory.research.outcome = normalized.length > 0 ? 'OBSERVED' : 'NOT_VERIFIED';
  }
  task.taskMemory.resultSetSummary = {
    count: normalized.length,
    source: 'UNTRUSTED_EXTERNAL_CONTENT',
    updatedAt: now(),
  };
}

function normalizeResearchPageCandidate(observation) {
  if (!observation || typeof observation !== 'object') return null;
  const url = String(observation.url || '').trim();
  const title = String(observation.title || '').trim();
  const visibleText = String(observation.visibleText || '').trim();
  if (!url || !title || !visibleText || /^https?:\/\/(?:www\.)?(?:google|bing|duckduckgo|search\.yahoo)\./i.test(url)) return null;
  if (/(?:[?&](?:q|query)=|\/search(?:\/|$))/i.test(url)) return null;
  let source = '';
  try {
    source = new URL(url).hostname;
  } catch {
    return null;
  }
  return {
    title: title.slice(0, 300),
    url: url.slice(0, 2048),
    snippet: visibleText.slice(0, 600),
    source,
    evidence: {
      title: title.slice(0, 300),
      pageText: visibleText.slice(0, 1200),
      observedAt: now(),
    },
    verificationStatus: 'OBSERVED_PAGE',
  };
}

function recordFoodSearchQuery(task, url) {
  const food = isFoodResearchTask(task) ? task.structuredRequirements?.domainRequirements?.food : null;
  if (!food) return null;
  const query = planner.extractSearchQueryFromUrl(url);
  if (!query) return null;
  if (!Array.isArray(task.taskMemory.research?.searchQueries)) task.taskMemory.research.searchQueries = [];
  if (!task.taskMemory.research.searchQueries.some((existing) => existing.toLowerCase() === query.toLowerCase())) {
    task.taskMemory.research.searchQueries.push(query);
  }
  return query;
}

function foodSearchLimitObservation(task, url, message) {
  return {
    url: url || task.currentUrl,
    title: '',
    visibleText: '',
    pageState: 'SEARCH_REFINEMENT_LIMIT',
    loginState: 'UNKNOWN',
    errorState: {
      code: 'SEARCH_REFINEMENT_LIMIT',
      message,
      retryable: false,
    },
    results: [],
    version: task.observationVersion,
  };
}

function extractModelResultSet(content) {
  const rows = [];
  const pattern = /\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/g;
  for (const match of String(content || '').matchAll(pattern)) {
    rows.push({
      index: Number(match[1]) - 1,
      title: safeText(match[2], 300),
      price: safeText(match[3], 80),
      availability: safeText(match[4], 120),
    });
    if (rows.length >= 12) break;
  }
  return rows.filter((row) => row.index >= 0);
}

function syncExecutionTask(task, action, observation = null) {
  if (TERMINAL_PHASES.has(task.phase)) return;
  task.executionActionId = action?.actionId || task.executionActionId;
  if (action?.state === 'WAITING_FOR_CONFIRMATION') task.taskMemory.confirmationState = 'PENDING';
  else if (action?.state === 'EXECUTING') task.taskMemory.confirmationState = 'CONFIRMED';
  else if (['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(action?.state)) task.taskMemory.confirmationState = 'NONE';
  if (observation) {
    task.observationVersion = Number.isInteger(observation.version) ? observation.version : task.observationVersion;
    task.lastObservation = {
      kind: 'BROWSER',
      url: observation.url || task.currentUrl,
      site: siteFromUrl(observation.url || task.currentUrl),
      text: observation.visibleText || '',
      title: observation.title || '',
      pageState: observation.pageState || 'UNKNOWN',
      loginState: observation.loginState || 'UNKNOWN',
      errorState: observation.errorState || null,
      contentTrust: 'UNTRUSTED_EXTERNAL_CONTENT',
      results: Array.isArray(observation.results) ? observation.results.slice(0, 12).map((result) => redact(result)) : [],
      interactiveElements: Array.isArray(observation.interactiveElements)
        ? observation.interactiveElements.slice(0, 100).map((element) => redact(element))
        : [],
      version: task.observationVersion,
      at: now(),
    };
    task.taskMemory.observations.push(task.lastObservation);
    if (task.taskMemory.observations.length > 12) task.taskMemory.observations.shift();
    recordFoodSearchQuery(task, observation.url);
    rememberExternalResults(task, observation.results);
    const pageCandidate = normalizeResearchPageCandidate(observation);
    if (pageCandidate) rememberExternalResults(task, [pageCandidate]);
    adaptResearchPlan(task);
    task.currentUrl = observation.url || task.currentUrl;
    task.currentSite = siteFromUrl(task.currentUrl);
  }
  task.updatedAt = now();
}

function createExecutionBrowserSession(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  const browser = ensureBrowserSession(task);
  return {
    browserSessionId: browser.sessionId,
    task: publicTask(task),
  };
}

function performBrowserOperation(taskId, ownerWebContentsId, operation, target = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  if (operation === 'navigate') {
    const requestedUrl = typeof target === 'string' ? target : target?.url;
    const query = planner.extractSearchQueryFromUrl(requestedUrl);
    const food = isFoodResearchTask(task) ? task.structuredRequirements?.domainRequirements?.food : null;
    if (food && query) {
      const queries = task.taskMemory.research?.searchQueries || [];
      if (queries.some((existing) => existing.toLowerCase() === query.toLowerCase())) {
        const observation = foodSearchLimitObservation(task, requestedUrl, 'This search was already checked. Use a different, more specific query.');
        return { observation: redact(observation), task: publicTask(task) };
      }
      if (queries.length >= 1 + Number(task.taskMemory.research?.refinementLimit || 3)) {
        const observation = foodSearchLimitObservation(task, requestedUrl, 'The bounded search refinement limit was reached. The available evidence is being reported without claiming an unverified match.');
        return { observation: redact(observation), task: publicTask(task) };
      }
    }
  }
  const browser = ensureBrowserSession(task);
  const observation = executionEngine.browserOperation(browser.sessionId, ownerWebContentsId, operation, target, {
    generalSessionId: task.sessionId,
    taskId: task.taskId,
  });
  return resolveMaybe(observation, (result) => {
    syncExecutionTask(task, null, result);
    return { observation: redact(result), task: publicTask(task) };
  });
}

function planExecutionAction(taskId, ownerWebContentsId, input = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  const browserOperations = new Set(['navigate', 'observe', 'click', 'type', 'scroll', 'wait', 'back', 'screenshot', 'closeSession']);
  const browserSessionId = input.browserSessionId || (browserOperations.has(input.operation) ? ensureBrowserSession(task).sessionId : null);
  const action = executionEngine.planAction({
    ...input,
    taskId: task.taskId,
    generalSessionId: task.sessionId,
    owner: ownerWebContentsId,
    browserSessionId,
    observationVersion: Number.isInteger(Number(input.observationVersion))
      ? Number(input.observationVersion)
      : task.observationVersion,
  });
  syncExecutionTask(task, action);
  return { action: publicExecutionAction(action), task: publicTask(task) };
}

function getExecutionAction(taskId, ownerWebContentsId, actionId) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId || action.generalSessionId !== task.sessionId) {
    throw new Error('Execution action is not part of this General task.');
  }
  return { action: publicExecutionAction(action), task: publicTask(task) };
}

function validateExecutionAction(taskId, ownerWebContentsId, actionId) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.validateAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  syncExecutionTask(task, action);
  return { action: publicExecutionAction(action), task: publicTask(task) };
}

function requestExecutionConfirmation(taskId, ownerWebContentsId, actionId) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  return { confirmation: redact(executionEngine.requestConfirmation(actionId, ownerWebContentsId)), task: publicTask(task) };
}

function confirmExecutionAction(taskId, ownerWebContentsId, actionId, confirmationId) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  const confirmed = executionEngine.confirmAction(actionId, confirmationId, ownerWebContentsId);
  syncExecutionTask(task, confirmed);
  return { action: publicExecutionAction(confirmed), task: publicTask(task) };
}

function executeExecutionAction(taskId, ownerWebContentsId, actionId) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  const executed = executionEngine.executeAction(actionId, ownerWebContentsId);
  return resolveMaybe(executed, (result) => {
    syncExecutionTask(task, result);
    return { action: publicExecutionAction(result), task: publicTask(task) };
  });
}

function observeExecutionAction(taskId, ownerWebContentsId, actionId) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  const observed = executionEngine.observeAction(actionId, ownerWebContentsId);
  return resolveMaybe(observed, (result) => {
    syncExecutionTask(task, result, result.observation);
    return { action: publicExecutionAction(result), task: publicTask(task) };
  });
}

function verifyExecutionAction(taskId, ownerWebContentsId, actionId, evidence = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  const verified = executionEngine.verifyAction(actionId, ownerWebContentsId, evidence);
  return resolveMaybe(verified, (result) => {
    syncExecutionTask(task, result);
    if (result.state === 'SUCCEEDED') {
      recordPlanProgress(task, { riskLevel: result.riskLevel, verified: true });
      task.taskMemory.completed.push(result.actionId);
    }
    return { action: publicExecutionAction(result), task: publicTask(task) };
  });
}

function recoverExecutionAction(taskId, ownerWebContentsId, actionId, options = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  const recovered = executionEngine.recoverAction(actionId, ownerWebContentsId, options);
  return resolveMaybe(recovered, (result) => {
    syncExecutionTask(task, result);
    return { action: publicExecutionAction(result), task: publicTask(task) };
  });
}

function cancelExecutionAction(taskId, ownerWebContentsId, actionId, reason) {
  const task = getTask(taskId, ownerWebContentsId);
  const action = executionEngine.getAction(actionId, ownerWebContentsId);
  if (action.taskId !== task.taskId) throw new Error('Execution action is not part of this General task.');
  const cancelled = executionEngine.cancelAction(actionId, ownerWebContentsId, reason);
  syncExecutionTask(task, cancelled);
  return { action: publicExecutionAction(cancelled), task: publicTask(task) };
}

function observe(taskId, ownerWebContentsId, observation = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  const url = observation.url ? validateUrl(observation.url) : task.currentUrl;
  if (url) {
    task.currentUrl = url;
    task.currentSite = siteFromUrl(url);
  }
  if (observation.kind === 'SCREENSHOT') assertBounds(task, 'screenshot');
  if (observation.kind === 'SCREENSHOT') task.screenshotCount += 1;
  const text = safeText(observation.text || observation.summary || '', observation.kind === 'PAGE' ? DEFAULT_BOUNDS.maxExtractedChars : 2000);
  if (observation.kind === 'PAGE') {
    task.extractedChars += text.length;
    if (task.extractedChars > task.bounds.maxExtractedChars) {
      return block(task, 'Maximum extracted page content reached.');
    }
  }
  const safeObservation = {
    kind: safeText(observation.kind || 'OBSERVATION', 80),
    url: task.currentUrl,
    site: task.currentSite,
    text,
    results: Array.isArray(observation.results) ? observation.results.slice(0, 12).map((result) => redact(result)) : [],
    contentTrust: 'UNTRUSTED_EXTERNAL_CONTENT',
    at: now(),
  };
  rememberExternalResults(task, observation.results);
  const pageCandidate = normalizeResearchPageCandidate(observation);
  if (pageCandidate) rememberExternalResults(task, [pageCandidate]);
  task.lastObservation = safeObservation;
  task.taskMemory.observations.push(safeObservation);
  if (task.taskMemory.observations.length > 12) task.taskMemory.observations.shift();
  recordFoodSearchQuery(task, task.currentUrl);
  task.updatedAt = now();
  return publicTask(task);
}

function recordModelResponse(taskId, ownerWebContentsId, input = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  if (TERMINAL_PHASES.has(task.phase) && input.status === 'ERROR' && task.phase !== 'CANCELLED') {
    transition(task, 'RECOVERING', { message: 'A provider response arrived after the previous model response.' });
    transition(task, 'PLANNING', { message: 'General task returned to planning for provider recovery.' });
    task.finalStatus = null;
    task.blockedReason = null;
  }
  assertTaskActive(task);
  const status = ['ERROR', 'PARTIAL'].includes(input.status) ? input.status : 'COMPLETED';
  let content = status !== 'ERROR' ? safeText(input.content || '', 8000) : '';
  const category = safeText(input.failureClassification || input.category || 'PROVIDER_ERROR', 80);
  const message = safeText(input.error || '', 500);
  task.contextMetrics = input.contextMetrics && typeof input.contextMetrics === 'object'
    ? redact(input.contextMetrics)
    : task.contextMetrics;
  task.assistantResponse = {
    status,
    content,
    provider: input.provider ? safeText(input.provider, 120) : null,
    model: input.model ? safeText(input.model, 160) : null,
    source: status === 'PARTIAL' ? 'BROWSER_EVIDENCE_FALLBACK' : 'LIVE_PROVIDER',
    evidenceAvailable: Boolean(task.lastObservation || task.taskMemory.resultSetSummary),
    requestId: input.requestId ? safeText(input.requestId, 100) : null,
    receivedAt: now(),
  };
  task.providerError = ['ERROR', 'PARTIAL'].includes(status)
    ? { category, message: message || 'The live provider could not complete this step.', at: now() }
    : null;
  task.history.push({
    type: status === 'ERROR' ? 'MODEL_ERROR' : status === 'PARTIAL' ? 'PARTIAL_EVIDENCE' : 'MODEL_RESPONSE',
    status,
    provider: task.assistantResponse.provider,
    model: task.assistantResponse.model,
    failureClassification: status === 'ERROR' ? category : null,
    at: task.assistantResponse.receivedAt,
  });
  if (task.history.length > 32) task.history.shift();
  if (status === 'COMPLETED' || status === 'PARTIAL') {
    const food = isFoodResearchTask(task) ? task.structuredRequirements?.domainRequirements?.food : null;
    const hasFoodResearchEvidence = Boolean(
      food
      && (
        task.taskMemory.research?.candidates?.length
        || task.taskMemory.research?.searchQueries?.length
      ),
    );
    if (hasFoodResearchEvidence) {
      const candidates = task.taskMemory.research?.candidates || [];
      task.taskMemory.research.outcome = planner.foodResearchOutcome(candidates);
      content = planner.formatFoodResearchResponse(food, candidates);
      task.assistantResponse.content = content;
    }
    const completedNodes = new Set(['select-capabilities', 'collect-evidence', 'compare-options', 'prepare-result', 'verify-result']);
    const extractedResults = extractModelResultSet(content);
    if (extractedResults.length > 0) {
      task.taskMemory.resultSet = extractedResults;
      task.taskMemory.resultSetSummary = {
        count: extractedResults.length,
        source: 'LIVE_PROVIDER_RESPONSE',
        updatedAt: now(),
      };
    }
    if (task.plan) {
      for (const node of task.plan.taskGraph.nodes) {
        if (completedNodes.has(node.id) && ['READY', 'PENDING'].includes(node.status)) node.status = 'COMPLETED';
      }
      task.plan.nextAction = task.plan.taskGraph.terminalNodeId;
      task.planningStatus = 'COMPLETED';
    }
    task.taskMemory.completed.push(`model-response:${task.assistantResponse.requestId || now()}`);
    task.taskMemory.remaining = [];
    task.finalStatus = status === 'PARTIAL'
      ? 'COMPLETED_WITH_LIMITATIONS'
      : hasFoodResearchEvidence
      ? task.taskMemory.research.outcome === 'MATCH' ? 'COMPLETED' : 'COMPLETED_WITH_LIMITATIONS'
      : task.lastObservation || task.taskMemory.resultSetSummary
        ? 'COMPLETED'
        : 'COMPLETED_WITH_LIMITATIONS';
    closeTaskBrowser(task);
    transition(task, task.finalStatus, { message: 'General Agent produced a final response.' });
  } else if (['CONTEXT_TOO_LARGE', 'BLOCKED_CONTEXT_LIMIT'].includes(category)) {
    task.finalStatus = 'BLOCKED';
    task.blockedReason = message || 'The provider rejected the request because its context limit was exceeded.';
    task.planningStatus = 'BLOCKED_CONTEXT_LIMIT';
    if (task.plan) {
      const current = task.plan.taskGraph.nodes.find((node) => node.id === task.plan.nextAction);
      if (current) current.status = 'BLOCKED';
      task.plan.nextAction = 'BLOCKED_CONTEXT_LIMIT';
      for (const node of task.plan.taskGraph.nodes) {
        if (['READY', 'PENDING'].includes(node.status)) node.status = 'BLOCKED';
      }
    }
    task.pendingAction = null;
    task.confirmationId = null;
    task.taskMemory.confirmationState = 'NONE';
    closeTaskBrowser(task, ownerWebContentsId);
    transition(task, 'BLOCKED', { reason: task.blockedReason, failureClassification: category });
  } else if (category === 'RATE_LIMIT' || category === 'TEMPORARILY_UNAVAILABLE') {
    task.finalStatus = null;
    task.planningStatus = 'WAITING_FOR_PROVIDER';
    task.providerError.retryable = true;
    if (task.plan) task.plan.nextAction = 'WAITING_FOR_PROVIDER';
    transition(task, 'WAITING_FOR_PROVIDER', {
      reason: message || 'The provider is temporarily unavailable.',
      failureClassification: category,
    });
  } else {
    task.finalStatus = 'FAILED';
    task.planningStatus = 'FAILED';
    if (task.plan) {
      const current = task.plan.taskGraph.nodes.find((node) => node.id === task.plan.nextAction);
      if (current) current.status = 'FAILED';
      task.plan.nextAction = 'FAILED';
      for (const node of task.plan.taskGraph.nodes) {
        if (['READY', 'PENDING'].includes(node.status)) node.status = 'BLOCKED';
      }
    }
    task.pendingAction = null;
    task.confirmationId = null;
    task.taskMemory.confirmationState = 'NONE';
    closeTaskBrowser(task, ownerWebContentsId);
    transition(task, 'FAILED', { reason: message || 'The live provider could not complete this step.', failureClassification: category });
  }
  task.updatedAt = now();
  return publicTask(task);
}

function prepareAction(taskId, ownerWebContentsId, name, rawArgs = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  assertBounds(task, 'action');
  const action = validateToolCall(name, rawArgs);
  if (CONFIRMATION_RISKS.has(action.riskLevel) && task.plan?.missingInformation?.length) {
    throw new Error(`Required information is missing before this action: ${task.plan.missingInformation.map((item) => item.prompt).join(' ')}`);
  }
  if (action.name === 'navigate') {
    assertBounds(task, 'navigation');
    const requestedSite = siteFromUrl(action.args.url);
    if (task.currentSite && requestedSite !== task.currentSite) task.navigationDepth += 1;
  } else if (task.currentSite && rawArgs.site && String(rawArgs.site).toLowerCase() !== task.currentSite) {
    throw new Error('Action target is outside the active site.');
  }
  if (action.name === 'login_handoff') {
    task.authenticationState = 'LOGIN_REQUIRED';
    task.pendingAction = null;
    task.confirmationId = null;
    task.taskMemory.confirmationState = 'NONE';
    transition(task, 'WAITING_FOR_LOGIN', { message: 'User login handoff required.' });
    return { requiresConfirmation: false, loginRequired: true, task: publicTask(task) };
  }
  task.pendingAction = {
    actionId: crypto.randomUUID(),
    tool: action.name,
    args: redact(action.args),
    riskLevel: action.riskLevel,
    target: safeText(action.args.target || action.args.url || action.name, 500),
    preparedAt: now(),
  };
  task.riskLevel = action.riskLevel;
  recordPlanPreparation(task, action);
  transition(task, 'PREPARING_ACTION', { actionId: task.pendingAction.actionId, tool: action.name, riskLevel: action.riskLevel });
  if (CONFIRMATION_RISKS.has(action.riskLevel)) {
    task.confirmationId = crypto.randomUUID();
    task.taskMemory.confirmationState = 'PENDING';
    transition(task, 'WAITING_FOR_CONFIRMATION', { confirmationId: task.confirmationId });
    return {
      requiresConfirmation: true,
      confirmation: {
        confirmationId: task.confirmationId,
        taskId: task.taskId,
        sessionId: task.sessionId,
        actionId: task.pendingAction.actionId,
        site: task.currentSite,
        target: task.pendingAction.target,
        riskLevel: task.riskLevel,
        summary: `Allow ${action.name} for ${task.pendingAction.target}?`,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
      task: publicTask(task),
    };
  }
  return { requiresConfirmation: false, task: publicTask(task) };
}

function beginAction(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  if (!task.pendingAction) throw new Error('No prepared General Agent action.');
  if (task.phase === 'WAITING_FOR_CONFIRMATION') throw new Error('Explicit confirmation is required before this action.');
  if (task.phase !== 'PREPARING_ACTION') throw new Error(`Action cannot start from ${task.phase}.`);
  assertBounds(task, 'action');
  task.actionCount += 1;
  task.pendingAction.startedAt = now();
  transition(task, 'EXECUTING', { actionId: task.pendingAction.actionId });
  return publicTask(task);
}

function confirmAction(taskId, ownerWebContentsId, confirmationId) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  if (task.phase !== 'WAITING_FOR_CONFIRMATION' || !task.confirmationId || confirmationId !== task.confirmationId) {
    throw new Error('Confirmation does not match the pending General Agent action.');
  }
  if (!task.pendingAction || Date.now() - Date.parse(task.pendingAction.preparedAt) > 5 * 60 * 1000) {
    task.confirmationId = null;
    throw new Error('Confirmation has expired.');
  }
  task.pendingAction.confirmedAt = now();
  task.pendingAction.confirmedBy = 'renderer-confirmation';
  task.confirmationId = null;
  task.taskMemory.confirmationState = 'CONFIRMED';
  if (task.plan) {
    const confirmationNode = task.plan.taskGraph.nodes.find((node) => node.id === 'request-confirmation');
    if (confirmationNode) confirmationNode.status = 'COMPLETED';
    refreshPlanReadiness(task);
  }
  assertBounds(task, 'action');
  task.actionCount += 1;
  transition(task, 'EXECUTING', { actionId: task.pendingAction.actionId, confirmed: true });
  return publicTask(task);
}

function completeAction(taskId, ownerWebContentsId, result = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  if (task.phase !== 'EXECUTING' || !task.pendingAction) throw new Error('No executing General Agent action.');
  task.pendingAction.result = redact({ ok: Boolean(result.ok), status: safeText(result.status || '', 300) });
  transition(task, 'VERIFYING', { actionId: task.pendingAction.actionId });
  return publicTask(task);
}

function verifyAction(taskId, ownerWebContentsId, evidence = {}) {
  const task = getTask(taskId, ownerWebContentsId);
  assertTaskActive(task);
  if (task.phase !== 'VERIFYING' || !task.pendingAction) throw new Error('No action is awaiting verification.');
  const text = safeText(evidence.evidence || evidence.text || evidence.status || '', 2000).trim();
  if (!text) throw new Error('External action verification requires observed evidence.');
  const verified = evidence.ok === true;
  const actionId = task.pendingAction.actionId;
  const pendingAction = task.pendingAction;
  task.lastObservation = { kind: verified ? 'ACTION_VERIFIED' : 'ACTION_FAILED', actionId, text, at: now() };
  task.taskMemory.observations.push(task.lastObservation);
  task.taskMemory.completed.push(actionId);
  task.pendingAction = null;
  task.taskMemory.confirmationState = 'NONE';
  task.riskLevel = 'READ_ONLY';
  recordPlanProgress(task, { riskLevel: pendingAction.riskLevel, verified });
  if (!verified) {
    task.finalStatus = 'FAILED';
    transition(task, 'FAILED', { actionId, evidence: text });
  } else {
    transition(task, 'PLANNING', { actionId, evidence: text });
  }
  return publicTask(task);
}

function requestLogin(taskId, ownerWebContentsId, reason = '') {
  return prepareAction(taskId, ownerWebContentsId, 'login_handoff', { reason: safeText(reason, 500) });
}

function completeLogin(taskId, ownerWebContentsId, status) {
  const task = getTask(taskId, ownerWebContentsId);
  if (task.phase !== 'WAITING_FOR_LOGIN') throw new Error('Login handoff is not pending.');
  if (!['LOGIN_SUCCESS', 'LOGIN_FAILED'].includes(status)) throw new Error('Invalid login handoff status.');
  task.authenticationState = status;
  task.lastObservation = { kind: status, at: now() };
  if (status === 'LOGIN_SUCCESS') {
    transition(task, 'PLANNING', { message: 'User completed login handoff.' });
  } else {
    task.finalStatus = 'FAILED';
    transition(task, 'FAILED', { message: 'User login handoff failed.' });
  }
  return publicTask(task);
}

function finishTask(taskId, ownerWebContentsId, status, evidence = '') {
  const task = getTask(taskId, ownerWebContentsId);
  if (!['COMPLETED', 'COMPLETED_WITH_LIMITATIONS'].includes(status)) {
    throw new Error('A General task can only be completed with an explicit completion status.');
  }
  if (!safeText(evidence, 2000).trim()) throw new Error('Completion requires evidence.');
  if (task.pendingAction || task.confirmationId) {
    throw new Error('A General task cannot complete with a pending or unconfirmed action.');
  }
  if (task.plan?.missingInformation?.length) {
    throw new Error(`A General task cannot complete while information is missing: ${task.plan.missingInformation.map((item) => item.prompt).join(' ')}`);
  }
  const hasObservedEvidence = task.taskMemory.observations.some((observation) => ['PAGE', 'BROWSER', 'ACTION_VERIFIED'].includes(observation.kind));
  if (!hasObservedEvidence) throw new Error('Task completion requires verified observation evidence.');
  if (!['PLANNING', 'RESEARCHING', 'VERIFYING'].includes(task.phase)) {
    throw new Error(`General task cannot complete from ${task.phase}.`);
  }
  task.finalStatus = status;
  task.lastObservation = { kind: 'TASK_COMPLETION_EVIDENCE', text: safeText(evidence), at: now() };
  transition(task, status, { evidence: task.lastObservation.text });
  return publicTask(task);
}

function pauseTask(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  if (TERMINAL_PHASES.has(task.phase)) throw new Error(`General task is ${task.phase.toLowerCase()}.`);
  task.paused = true;
  task.pausedFromPhase = task.phase;
  task.updatedAt = now();
  task.history.push({ type: 'PAUSED', phase: task.phase, at: task.updatedAt });
  return publicTask(task);
}

function resumeTask(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  if (!task.paused) return publicTask(task);
  task.paused = false;
  task.pausedFromPhase = null;
  task.updatedAt = now();
  task.history.push({ type: 'RESUMED', phase: task.phase, at: task.updatedAt });
  return publicTask(task);
}

function recoverTask(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  if (task.phase === 'CANCELLED') throw new Error('Cancelled General tasks cannot be recovered.');
  if (task.recoveryAttempts >= task.bounds.maxRecoveryAttempts) return block(task, 'Maximum recovery attempts reached.');
  task.recoveryAttempts += 1;
  task.retryCount += 1;
  if (task.phase !== 'RECOVERING') transition(task, 'RECOVERING', { attempt: task.recoveryAttempts });
  return publicTask(task);
}

function stopTask(taskId, ownerWebContentsId) {
  const task = getTask(taskId, ownerWebContentsId);
  if (TERMINAL_PHASES.has(task.phase)) return publicTask(task);
  if (task.phase !== 'CANCELLED') {
    task.pendingAction = null;
    task.confirmationId = null;
    closeTaskBrowser(task, ownerWebContentsId);
    task.taskMemory.confirmationState = 'CANCELLED';
    task.paused = false;
    task.finalStatus = 'CANCELLED';
    if (!TERMINAL_PHASES.has(task.phase)) transition(task, 'CANCELLED', { message: 'Stopped by the user.' });
  }
  return publicTask(task);
}

function releaseSession(ownerWebContentsId) {
  const session = sessions.get(ownerWebContentsId);
  if (!session) return;
  for (const task of tasks.values()) {
    if (task.ownerWebContentsId !== ownerWebContentsId || task.sessionId !== session.sessionId) continue;
    if (task.browserSessionId && executionEngine.sessions.has(task.browserSessionId)) {
      try {
        executionEngine.closeBrowserSession(task.browserSessionId, ownerWebContentsId, {
          generalSessionId: task.sessionId,
          taskId: task.taskId,
        });
      } catch {
        // Renderer cleanup is best-effort; ownership is still detached below.
      }
    }
    task.ownerWebContentsId = null;
    task.pendingAction = null;
    task.confirmationId = null;
    if (!TERMINAL_PHASES.has(task.phase)) transition(task, 'CANCELLED', { message: 'Renderer session closed.' });
  }
  sessions.delete(ownerWebContentsId);
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    goal: task.goal,
    requirements: [...task.requirements],
    constraints: [...task.constraints],
    phase: task.phase,
    currentSite: task.currentSite,
    currentUrl: task.currentUrl,
    browserSessionId: task.browserSessionId,
    pendingAction: task.pendingAction ? {
      actionId: task.pendingAction.actionId,
      tool: task.pendingAction.tool,
      args: redact(task.pendingAction.args),
      riskLevel: task.pendingAction.riskLevel,
      target: task.pendingAction.target,
      preparedAt: task.pendingAction.preparedAt,
      startedAt: task.pendingAction.startedAt || null,
      confirmedAt: task.pendingAction.confirmedAt || null,
      result: task.pendingAction.result || null,
    } : null,
    riskLevel: task.riskLevel,
    confirmationId: task.confirmationId,
    authenticationState: task.authenticationState,
    executionActionId: task.executionActionId,
    observationVersion: task.observationVersion,
    planningStatus: task.planningStatus,
    progressMessage: progressMessage(task),
    trace: taskTrace(task),
    structuredRequirements: task.structuredRequirements ? redact(task.structuredRequirements) : null,
    categories: task.plan ? [...task.plan.categories] : [],
    preferences: task.plan ? redact(task.plan.preferences) : {},
    missingInformation: task.plan ? redact(task.plan.missingInformation) : [],
    capabilityRoutes: task.plan ? redact(task.plan.capabilityRoutes) : [],
    providers: task.plan ? [...task.plan.providers] : [],
    plan: task.plan ? redact({
      version: task.plan.version,
      status: task.plan.status,
      nextAction: task.plan.nextAction,
      taskGraph: task.plan.taskGraph,
    }) : null,
    handoff: task.handoff ? redact(task.handoff) : null,
    lastObservation: task.lastObservation ? redact(task.lastObservation) : null,
    actionCount: task.actionCount,
    retryCount: task.retryCount,
    navigationDepth: task.navigationDepth,
    screenshotCount: task.screenshotCount,
    taskMemory: redact({
      summary: task.taskMemory.summary,
      references: task.taskMemory.references,
      referenceResolution: task.taskMemory.referenceResolution,
      currentIntent: task.taskMemory.currentIntent,
      currentCapability: task.taskMemory.currentCapability,
      structuredRequirements: task.taskMemory.structuredRequirements,
      constraints: task.taskMemory.constraints,
      preferences: task.taskMemory.preferences,
      selectedReferences: task.taskMemory.selectedReferences,
      resultSetSummary: task.taskMemory.resultSetSummary,
      research: task.taskMemory.research,
      lastRefinement: task.taskMemory.lastRefinement,
      conversationSummary: task.taskMemory.conversationSummary,
      pendingAction: task.pendingAction ? {
        actionId: task.pendingAction.actionId,
        tool: task.pendingAction.tool,
        target: task.pendingAction.target,
      } : null,
      riskLevel: task.taskMemory.riskLevel,
      confirmationState: task.confirmationId ? 'PENDING' : task.taskMemory.confirmationState,
      completed: task.taskMemory.completed,
      remaining: task.taskMemory.remaining,
      ruledOut: task.taskMemory.ruledOut,
      observations: task.taskMemory.observations.slice(-8),
    }),
    finalStatus: task.finalStatus,
    blockedReason: task.blockedReason,
    assistantResponse: task.assistantResponse ? redact(task.assistantResponse) : null,
    providerError: task.providerError ? redact(task.providerError) : null,
    contextMetrics: task.contextMetrics ? redact(task.contextMetrics) : null,
    paused: task.paused,
    bounds: { ...task.bounds },
    history: task.history.slice(-12).map(redact),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function resetForTest() {
  sessions.clear();
  tasks.clear();
  capabilityRegistry.getCapabilityRegistry().resetForTest();
  executionEngine.resetForTest();
}

module.exports = {
  PHASES,
  RISK_LEVELS,
  TOOL_REGISTRY,
  DEFAULT_BOUNDS,
  CAPABILITY_CATEGORIES: capabilityRegistry.CAPABILITY_CATEGORIES,
  PROVIDER_LIFECYCLES: capabilityRegistry.PROVIDER_LIFECYCLES,
  getCapabilityCatalog,
  getProviderCatalog: capabilityRegistry.getProviderCatalog,
  registerGeneralProvider: (definition) => capabilityRegistry.getCapabilityRegistry().registerProvider(definition),
  setGeneralProviderLifecycle: (providerId, lifecycle) => capabilityRegistry.getCapabilityRegistry().setProviderLifecycle(providerId, lifecycle),
  getSession,
  getPublicSession,
  createTask,
  getTask: (taskId, ownerWebContentsId) => publicTask(getTask(taskId, ownerWebContentsId)),
  startTask,
  createExecutionBrowserSession,
  performBrowserOperation,
  planExecutionAction,
  getExecutionAction,
  validateExecutionAction,
  requestExecutionConfirmation,
  confirmExecutionAction,
  executeExecutionAction,
  observeExecutionAction,
  verifyExecutionAction,
  recoverExecutionAction,
  cancelExecutionAction,
  replanTask,
  prepareDeveloperHandoff,
  observe,
  recordModelResponse,
  validateToolCall,
  prepareAction,
  beginAction,
  confirmAction,
  completeAction,
  verifyAction,
  requestLogin,
  completeLogin,
  finishTask,
  pauseTask,
  resumeTask,
  recoverTask,
  stopTask,
  releaseSession,
  resetForTest,
};
