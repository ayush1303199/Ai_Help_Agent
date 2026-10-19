const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { authorizeAppOwnedMutation } = require('./appOwnedPersistence.cjs');
const {
  getWorkItemPlanDigest,
  issueHostFileObservation,
  verifyWorkItemEvidence,
} = require('./coding-pipeline/workItemVerificationContract.cjs');
const { developer: developerSettings } = require('../src/config/runtimeSettings.json');
if (!Number.isSafeInteger(developerSettings.maxVerificationAttempts) || developerSettings.maxVerificationAttempts < 1) {
  throw new Error('Developer maxVerificationAttempts must be a positive safe integer.');
}
const { taskOrchestrator } = require('./coding-pipeline/orchestrator.cjs');
const { artifactEngine, ARTIFACT_TYPES } = require('./coding-pipeline/artifacts.cjs');
const { devServerManager } = require('./coding-pipeline/environment.cjs');
const { browserVerifier } = require('./coding-pipeline/browserVerifier.cjs');
const { multiRepoCoordinator } = require('./coding-pipeline/multiRepo.cjs');
const { verificationOrchestrator } = require('./coding-pipeline/verificationOrchestrator.cjs');
const { skillSystem } = require('./coding-pipeline/skillSystem.cjs');
const { mcpToolAdapter } = require('./coding-pipeline/mcpAdapter.cjs');
const { routeTaskMode, OPERATING_MODES, MODE_SPECIFICATIONS, COMPLEXITY_LEVELS } = require('./coding-pipeline/modes.cjs');
const { classifyDatabaseRequestIntent, discoverDatabaseConfig } = require('./databaseDiscovery.cjs');
const { dirtyWorktreeProtector } = require('./coding-pipeline/dirtyWorktree.cjs');
const {
  correctnessOracle,
  patchQualityEngine,
  diffReviewer,
  mutationHarness,
  defectClassifier,
  edgeCaseValidator,
  blindnessGuard,
  workerConflictAdjudicator,
  realityLevelEvaluator,
  businessRevalidationEngine,
} = require('./coding-pipeline/correctnessEngine.cjs');
const {
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_LIKELY,
  CLASSIFICATION_UNVERIFIED,
  CLASSIFICATION_NOT_A_BUG,
  VALID_CLASSIFICATIONS,
  VALID_SUBTASK_STATUSES,
  VALID_HYPOTHESIS_STATUSES,
  LEGAL_SUBTASK_TRANSITIONS,
  LEGAL_HYPOTHESIS_TRANSITIONS,
  classifyDefect,
  maskNonCodeSource,
  traceExecutionFlow,
  validateEvidenceReport,
  validatePatchScope,
  enforceApprovalGate,
  analyzeTaskRequirements,
  planProgressiveSearch,
  discoverProjectArchitecture,
  executeToolWithSafeguards,
  manageRepairLoop,
  createTaskPlan,
  advanceTaskPlan,
  invalidateCompletedWorkItems,
} = require('./coding-pipeline/investigationWorkflowContract.cjs');
const developerFiles = require('./developerFiles.cjs');
const { readProjectMetadata } = require('./developerIndex.cjs');
const { detectProject } = require('./coding-pipeline/detect/projectDetector.cjs');
const featureOwnership = require('../server/src/coding_feature_ownership.json');

function detectSourceLanguage(filePath, content = '') {
  const norm = String(filePath || '').toLowerCase().replace(/\\/g, '/');
  if (norm.endsWith('.php')) return 'php';
  if (norm.endsWith('.js') || norm.endsWith('.cjs') || norm.endsWith('.mjs') || norm.endsWith('.jsx')) return 'javascript';
  if (norm.endsWith('.ts') || norm.endsWith('.tsx')) return 'typescript';
  if (norm.endsWith('.py')) return 'python';
  if (norm.endsWith('.go')) return 'go';
  if (norm.endsWith('.java')) return 'java';
  if (norm.endsWith('.rb')) return 'ruby';

  const source = String(content || '');
  if (/^<\?php|\bnamespace\s+[A-Za-z0-9_\\]+;|\buse\s+[A-Za-z0-9_\\]+;/i.test(source)) return 'php';
  if (/^from\s+\w+\s+import|\bdef\s+\w+\s*\(.*?\):/m.test(source)) return 'python';
  if (/^(?:import|export)\s+.*?\s+from\s+['"]|const\s+\w+\s*=\s*require\(/m.test(source)) return 'javascript';
  if (/^package\s+[a-z0-9_]+/m.test(source)) return 'go';

  return 'unknown';
}

const STATES = Object.freeze([
  'idle', 'reading', 'understanding', 'proposal_ready', 'awaiting_approval',
  'approved', 'applying', 'verifying', 'completed', 'recovering', 'failed',
  'cancelled', 'undone', 'paused', 'executing', 'blocked',
]);
// Internal states are intentionally stable; these aliases make the contract
// readable to callers that use the lifecycle terminology from the design.
const STATE_ALIASES = Object.freeze({
  proposal_ready: 'PROPOSING',
  awaiting_approval: 'WAITING_FOR_APPROVAL',
  applying: 'VERIFYING_APPLY',
  verifying: 'RUNNING_CHECKS',
  completed: 'OBSERVING',
  recovering: 'DIAGNOSING',
  failed: 'FIX_PROPOSING',
  undone: 'RETESTING',
  paused: 'PAUSED',
  executing: 'EXECUTING',
  blocked: 'BLOCKED',
});
const transitions = {
  idle: ['reading', 'proposal_ready', 'cancelled'],
  reading: ['understanding', 'proposal_ready', 'completed', 'failed', 'cancelled'],
  understanding: ['proposal_ready', 'reading', 'completed', 'failed', 'cancelled'],
  proposal_ready: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'verifying', 'failed', 'cancelled'],
  approved: ['applying', 'executing', 'failed', 'cancelled'],
  applying: ['verifying', 'recovering', 'failed', 'cancelled'],
  executing: ['verifying', 'recovering', 'failed', 'cancelled'],
  verifying: ['completed', 'recovering', 'failed', 'cancelled'],
  completed: ['undone', 'reading', 'cancelled'],
  recovering: ['verifying', 'awaiting_approval', 'failed', 'cancelled'],
  failed: ['reading', 'proposal_ready', 'recovering', 'verifying', 'cancelled'],
  paused: ['reading', 'understanding', 'proposal_ready', 'applying', 'verifying', 'cancelled'],
  blocked: ['reading', 'understanding', 'proposal_ready', 'cancelled'],
  cancelled: [],
  undone: ['reading', 'cancelled'],
};
const EXECUTION_OWNED_STATES = new Set(['applying', 'verifying', 'recovering']);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SENSITIVE_PATH_PATTERN = /(?:^|[\\/])(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.config|id_rsa(?:\..*)?|[^\\/]+\.(?:pem|key|p12|pfx|crt|cer|der))$/i;
const SENSITIVE_DIRECTORY_NAMES = new Set(['.ssh', '.aws', '.azure', '.config', '.gnupg', '.kube', '.docker']);
const SENSITIVE_FILE_NAME_PATTERN = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|\.git-credentials|\.netrc|netrc|\.npmrc|\.pypirc)$/i;
const MAX_MUTATION_FILE_BYTES = 2 * 1024 * 1024;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const CONVERSATION_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
const WORKFLOW_CONTINUATION_TTL_MS = 30 * 60 * 1000;
const MAX_WORKFLOW_CONTINUATIONS = 128;
const VERIFICATION_FAILURE_STATUSES = new Set([
  'BLOCKED',
  'UNCERTAIN',
  'NOT_ESTABLISHED',
  'UNVERIFIED',
  'CODE_FAILURE',
  'COMMAND_NOT_AVAILABLE',
  'NOT_AVAILABLE',
  'CANCELLED',
  'TIMEOUT',
  'ENVIRONMENT_FAILURE',
  'DEPENDENCY_FAILURE',
  'PROVIDER_FAILURE',
  'SKIPPED',
  'VERIFICATION_UNAVAILABLE',
]);
const NON_PASS_EVIDENCE_STATES = new Set(['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED']);
const GATE_FAILURE_STATUSES = new Set(['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED']);
const registry = new Map();
const sessions = new Map();
const conversationTurns = new Map();
const workflowContinuations = new Map();
let locked = false;
let lockDepth = 0;
let lockOwnerTurnId = null;
let journalPath = null;
let auditPath = null;
let durabilityRoot = null;
let journalQueue = Promise.resolve();
let auditQueue = Promise.resolve();
let journalError = null;
let auditError = null;
let eventSequence = 0;

function now() { return new Date().toISOString(); }
function storeWorkflowContinuation(token, state) {
  const currentTime = Date.now();
  for (const [existingToken, existingState] of workflowContinuations) {
    if (!existingState.running && existingState.expiresAt <= currentTime) {
      workflowContinuations.delete(existingToken);
    }
  }
  if (workflowContinuations.size >= MAX_WORKFLOW_CONTINUATIONS) {
    const evictable = [...workflowContinuations.entries()].find(([, item]) => !item.running);
    if (!evictable) return false;
    workflowContinuations.delete(evictable[0]);
  }
  workflowContinuations.set(token, state);
  return true;
}
function bounded(value, limit = developerSettings.maxSummaryChars) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`;
}
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/api.?key|token|secret|password|authorization|credential/i.test(key)) return [key, '[REDACTED]'];
      return [key, redact(item)];
    }));
  }
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  return bounded(value).replace(/(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi, '[REDACTED]');
}
function journalTask(task) {
  return {
    ...task,
    raw: undefined,
    ownerWebContentsId: undefined,
    error: bounded(task.error, 1000),
    progress: redact(task.progress),
    verification: sanitizeVerificationSnapshot(task.verification),
    outcome: redact(task.outcome),
    checkpoint: task.checkpoint || null,
    risk: task.risk || null,
    selfReview: task.selfReview || null,
    findings: Array.isArray(task.findings) ? task.findings.slice(0, 50) : [],
    evidence: Array.isArray(task.evidence) ? task.evidence.slice(0, 50) : [],
    hypotheses: Array.isArray(task.hypotheses) ? task.hypotheses.slice(0, 20) : [],
    rejectedHypotheses: Array.isArray(task.rejectedHypotheses) ? task.rejectedHypotheses.slice(0, 20) : [],
  };
}
async function renameWithRetry(source, target, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      const retryable = ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code);
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
function persistJournal(reason = 'mutation') {
  const targetPath = journalPath;
  if (!targetPath) return journalQueue;
  journalQueue = journalQueue.then(async () => {
    const payload = JSON.stringify({ version: 1, updatedAt: now(), reason, lastEventSequence: eventSequence, tasks: [...registry.values()].map(journalTask) }, null, 2);
    const temp = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await authorizeAppOwnedMutation({
      root: durabilityRoot,
      target: durabilityRoot,
      resource: 'app-state',
      operation: 'write',
    });
    await fs.mkdir(durabilityRoot, { recursive: true });
    try {
      await authorizeAppOwnedMutation({
        root: durabilityRoot,
        target: temp,
        resource: 'app-state',
        operation: 'write',
      });
      await fs.writeFile(temp, payload, 'utf8');
      await authorizeAppOwnedMutation({
        root: durabilityRoot,
        target: targetPath,
        resource: 'app-state',
        operation: 'replace',
      });
      await renameWithRetry(temp, targetPath);
    } finally {
      await authorizeAppOwnedMutation({
        root: durabilityRoot,
        target: temp,
        resource: 'app-state',
        operation: 'remove',
      });
      await fs.rm(temp, { force: true });
    }
  }).catch((error) => { journalError = error; });
  return journalQueue;
}
function auditEvent(type, task, details = {}) {
  const targetPath = auditPath;
  if (!targetPath) return auditQueue;
  const event = redact({
    sequence: ++eventSequence, at: now(), type,
    taskId: task?.taskId || details.taskId || null,
    sessionId: task?.sessionId || details.sessionId || null,
    requestId: details.requestId || null, proposalId: details.proposalId || null,
    transactionId: task?.transactionId || details.transactionId || null,
    attempt: details.attempt || null, details: { ...details, requestId: undefined, proposalId: undefined, transactionId: undefined, taskId: undefined, sessionId: undefined },
  });
  auditQueue = auditQueue.then(async () => {
    await authorizeAppOwnedMutation({
      root: durabilityRoot,
      target: targetPath,
      resource: 'audit',
      operation: 'append',
    });
    await fs.mkdir(durabilityRoot, { recursive: true });
    await fs.appendFile(targetPath, `${JSON.stringify(event)}\n`, 'utf8');
  }).catch((error) => { auditError = error; });
  return auditQueue;
}
function recordMutation(task, type, details) {
  persistJournal(type);
  auditEvent(type, task, details);
}
function transition(task, next, { syncConversationTurn = true } = {}) {
  if (!transitions[task.state]?.includes(next)) throw new Error(`Invalid task transition: ${task.state} -> ${next}`);
  const previous = task.state;
  task.state = next; task.updatedAt = now();
  recordMutation(task, 'state_transition', { from: previous, to: next });
  if (syncConversationTurn && task.conversationTurnId) {
    const turn = conversationTurns.get(task.conversationTurnId);
    if (turn && turn.ownerWebContentsId === task.ownerWebContentsId) {
      turn.state = next;
      turn.updatedAt = task.updatedAt;
      recordMutation(turn, 'conversation_state_transition', { from: previous, to: next });
    }
  }
}
function assertConversationOwner(turn, owner) {
  if (!turn || !owner || turn.sessionId !== owner.sessionId || turn.ownerWebContentsId !== owner.ownerWebContentsId) {
    throw new Error('Coding conversation turn is not owned by this renderer session.');
  }
}
function protectedFeatureForPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const roots = featureOwnership.protectedFeatureRoots || {};
  const matches = Object.entries(roots)
    .flatMap(([feature, paths]) => paths
      .filter((prefix) => {
        const normalizedPrefix = String(prefix).replace(/\\/g, '/').toLowerCase();
        return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
      })
      .map((prefix) => ({ feature, length: String(prefix).length })))
    .sort((a, b) => b.length - a.length);
  return matches[0]?.feature || 'shared';
}
function featuresForChanges(changes) {
  return [...new Set((changes || []).flatMap((change) => [
    change.path,
    change.sourcePath,
  ]).filter(Boolean).map(protectedFeatureForPath).filter(Boolean))].sort();
}
function beginConversationTurn({ root, scope = '.', request, sessionId, ownerWebContentsId, parentAuthorizationContext = null, operatingMode = null }) {
  if (!sessionId || ownerWebContentsId === undefined) throw new Error('Developer session ownership is required.');
  if (typeof request !== 'string' || !request.trim()) throw new Error('Coding request must be a non-empty string.');
  if (request.length > developerSettings.maxRequestChars) {
    throw new Error(
      `Coding request is too long (${request.length} characters; maximum ${developerSettings.maxRequestChars}). Shorten the current request or start a new Coding conversation.`,
    );
  }
  const canonicalRoot = path.resolve(root);
  const requestDigest = hash(request);
  if (parentAuthorizationContext && (
    parentAuthorizationContext.sessionId !== sessionId
    || parentAuthorizationContext.ownerWebContentsId !== ownerWebContentsId
    || !samePath(parentAuthorizationContext.root, canonicalRoot)
    || !Array.isArray(parentAuthorizationContext.authorizedFeatures)
  )) {
    throw new Error('Inherited Coding authorization does not match this project session.');
  }
  const turnId = crypto.randomUUID();
  const expiresAt = parentAuthorizationContext?.expiresAt
    || new Date(Date.now() + CONVERSATION_AUTHORIZATION_TTL_MS).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new Error('Inherited Coding request authorization has expired; start a new request.');
  }

  const modeRouting = routeTaskMode({
    goal: request,
    userRequestedMode: operatingMode || parentAuthorizationContext?.operatingMode,
  });

  const authorizationContext = Object.freeze(parentAuthorizationContext
    ? {
        taskId: parentAuthorizationContext.taskId,
        turnId,
        expiresAt,
        requestHash: parentAuthorizationContext.requestHash,
        requestSummary: parentAuthorizationContext.requestSummary,
        root: canonicalRoot,
        scope,
        sessionId,
        ownerWebContentsId,
        operatingMode: modeRouting.mode,
        authorizedFeatures: Object.freeze([...parentAuthorizationContext.authorizedFeatures]),
      }
    : {
        taskId: turnId,
        turnId,
        expiresAt,
        requestHash: requestDigest,
        requestSummary: request.slice(0, 512),
        root: canonicalRoot,
        scope,
        sessionId,
        ownerWebContentsId,
        operatingMode: modeRouting.mode,
        authorizedFeatures: Object.freeze(['coding', 'shared']),
      });
  const turn = {
    turnId, sessionId, ownerWebContentsId, root, scope, request,
    requestHash: requestDigest,
    requestSummary: request.slice(0, 512),
    expiresAt,
    operatingMode: modeRouting.mode,
    modeRouting,
    authorizationContext,
    state: 'reading', createdAt: now(), updatedAt: now(),
  };
  conversationTurns.set(turn.turnId, turn);
  recordMutation(turn, 'conversation_turn_started', { scope });
  return { turnId: turn.turnId, state: turn.state, sessionId: turn.sessionId, operatingMode: turn.operatingMode };
}
async function inspectDatabaseRequest({ root, request, contextMessages = [], sessionId, ownerWebContentsId }) {
  const intents = classifyDatabaseRequestIntent(request, contextMessages);
  const localConfigurationRequest = intents.includes('DATABASE_CONFIGURATION')
    && !intents.includes('DATABASE_CURRENT_TARGET');
  const credentialStatusRequest = intents.includes('DATABASE_CREDENTIAL_REQUEST');
  if (!localConfigurationRequest && !credentialStatusRequest) {
    return { ok: true, handled: false, intents, data: null, error: null };
  }
  if (!root || !sessionId || ownerWebContentsId === undefined || sessions.get(ownerWebContentsId) !== sessionId) {
    return {
      ok: false,
      handled: true,
      intents,
      data: null,
      error: { code: 'DEVELOPER_OWNERSHIP_REQUIRED', message: 'An owned, attached Developer project session is required.' },
    };
  }
  const owner = { sessionId, ownerWebContentsId };
  const turn = beginConversationTurn({ root, request, ...owner });
  try {
    advanceConversationTurn(turn.turnId, 'understanding', owner, { phase: 'database_configuration' });
    const requestedFile = request.match(/(?:^|[\s"'`])((?:[\w.-]+[\\/])*[\w.-]+\.php)\b/i)?.[1] || null;
    const data = await discoverDatabaseConfig(root, requestedFile, ownerWebContentsId);
    if (credentialStatusRequest) {
      const configuration = data.configuration || {};
      data.report = [
        '## Database credential status (source configuration)',
        '',
        `**Username:** ${configuration.username || 'NOT_RESOLVED'}`,
        `**Password:** ${configuration.password ? '[REDACTED]' : 'NOT_CONFIGURED'}`,
        `**Credential source:** ${data.configFile?.path || 'NOT_FOUND'}`,
        `**Live database:** ${data.live?.status || 'NOT_VERIFIED'}`,
        '**Note:** This reports configured values only; live runtime identity was not verified.',
      ].join('\n');
    }
    recordConversationFindings(turn.turnId, [{
      kind: 'database_configuration',
      requestedFile: data.requestedFile,
      configFile: data.configFile,
      status: data.status,
      liveStatus: data.live.status,
      credentialStatus: credentialStatusRequest ? 'REDACTED' : undefined,
    }], owner);
    advanceConversationTurn(turn.turnId, 'completed', owner, { phase: 'database_configuration', fileCount: data.configFile ? 1 : 0 });
    return { ok: true, handled: true, intents, turnId: turn.turnId, data, error: null };
  } catch (error) {
    advanceConversationTurn(turn.turnId, 'failed', owner, { phase: 'database_configuration' });
    return {
      ok: false,
      handled: true,
      intents,
      turnId: turn.turnId,
      data: null,
      error: { code: 'DATABASE_DISCOVERY_FAILED', message: bounded(error?.message || error, 500) },
    };
  }
}
function recordConversationFindings(turnId, findings, owner) {
  const turn = conversationTurns.get(turnId);
  assertConversationOwner(turn, owner);
  turn.findings = Array.isArray(findings) ? [...findings] : [findings];
  turn.updatedAt = now();
  recordMutation(turn, 'conversation_findings_recorded', { findingsCount: turn.findings.length });
  return { turnId, findingsCount: turn.findings.length };
}
function getConversationTurn(turnId, owner) {
  const turn = conversationTurns.get(turnId);
  assertConversationOwner(turn, owner);
  return { ...turn };
}
function validateConversationToolContext(turnId, owner, root, scope) {
  const turn = conversationTurns.get(turnId);
  assertConversationOwner(turn, owner);
  if (turn.state !== 'understanding'
    || !samePath(turn.root, root)
    || turn.scope !== scope
    || turn.authorizationContext?.turnId !== turnId
    || turn.authorizationContext?.ownerWebContentsId !== owner.ownerWebContentsId
    || turn.authorizationContext?.sessionId !== owner.sessionId) {
    throw new Error('Coding tool call is not bound to the active project conversation.');
  }
  return {
    taskId: turn.authorizationContext.taskId,
    turnId,
    requestHash: turn.authorizationContext.requestHash,
    root: turn.authorizationContext.root,
    scope: turn.authorizationContext.scope,
  };
}
function advanceConversationTurn(turnId, next, owner, details = {}) {
  const turn = conversationTurns.get(turnId);
  assertConversationOwner(turn, owner);
  const allowed = {
    reading: ['understanding', 'completed', 'failed', 'cancelled', 'blocked'],
    understanding: ['proposal_ready', 'completed', 'failed', 'cancelled', 'blocked'],
    proposal_ready: ['awaiting_approval', 'failed', 'cancelled'],
    awaiting_approval: ['approved', 'failed', 'cancelled'],
    approved: ['applying', 'failed', 'cancelled'],
    applying: ['verifying', 'recovering', 'failed', 'cancelled'],
    verifying: ['completed', 'recovering', 'failed', 'cancelled'],
    recovering: ['failed', 'verifying', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
    blocked: [],
  };
  if (!allowed[turn.state]?.includes(next)) throw new Error(`Invalid conversation transition: ${turn.state} -> ${next}`);
  const previous = turn.state;
  turn.state = next;
  turn.updatedAt = now();
  recordMutation(turn, 'conversation_state_transition', {
    from: previous, to: next, phase: details.phase, fileCount: details.fileCount,
  });
  return { turnId: turn.turnId, state: turn.state, updatedAt: turn.updatedAt };
}
function assertOwner(task, owner) {
  if (!owner && (task.ownerWebContentsId === null || task.ownerWebContentsId === undefined)) {
    return;
  }
  if (!owner || task.sessionId !== owner.sessionId || task.ownerWebContentsId !== owner.ownerWebContentsId) {
    throw new Error('Developer task is not owned by this renderer session.');
  }
}
async function acquireLock(turnId = null) {
  if (locked) {
    if (turnId && lockOwnerTurnId === turnId) {
      lockDepth += 1;
      return () => {
        lockDepth -= 1;
        if (lockDepth === 0) {
          locked = false;
          lockOwnerTurnId = null;
        }
      };
    }
    throw new Error('Another Developer task is already applying.');
  }
  locked = true;
  lockDepth = 1;
  lockOwnerTurnId = turnId || null;
  return () => {
    lockDepth -= 1;
    if (lockDepth === 0) {
      locked = false;
      lockOwnerTurnId = null;
    }
  };
}
function createSession(ownerWebContentsId) {
  const sessionId = crypto.randomUUID();
  sessions.set(ownerWebContentsId, sessionId);
  return sessionId;
}
function getSession(ownerWebContentsId) {
  if (!sessions.has(ownerWebContentsId)) return createSession(ownerWebContentsId);
  return sessions.get(ownerWebContentsId);
}
function configureDurability({ journalFile, auditFile }) {
  journalPath = journalFile || null;
  auditPath = auditFile || null;
  if (journalPath && auditPath && path.dirname(path.resolve(journalPath)) !== path.dirname(path.resolve(auditPath))) {
    throw new Error('Developer journal and audit files must share one application-owned storage directory.');
  }
  durabilityRoot = journalPath ? path.dirname(path.resolve(journalPath)) : auditPath ? path.dirname(path.resolve(auditPath)) : null;
  return { journalPath, auditPath };
}
async function flushDurability() {
  await Promise.all([journalQueue, auditQueue]);
  if (journalError) throw new Error(`Developer journal write failed: ${journalError.message}`);
  if (auditError) throw new Error(`Developer audit write failed: ${auditError.message}`);
}
async function loadJournal() {
  if (!journalPath) return { loaded: 0, reconciled: 0 };
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { loaded: 0, reconciled: 0 };
    throw error;
  }
  let reconciled = 0;
  for (const saved of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
    if (!saved?.taskId || !saved?.sessionId || !saved?.workspace?.root) continue;
    const task = { ...saved, ownerWebContentsId: null };
    if (['applying', 'verifying', 'recovering'].includes(task.state)) {
      task.state = 'failed';
      task.outcome = 'STARTUP_RECONCILIATION';
      task.error = 'Interrupted task requires safe review before resuming.';
      task.progress = { phase: 'reconcile', message: 'Interrupted task reconciled to safe review state.', at: now() };
      reconciled += 1;
    }
    registry.set(task.taskId, task);
  }
  eventSequence = Number(parsed.lastEventSequence || eventSequence);
  if (reconciled) await persistJournal('startup_reconciliation');
  return { loaded: registry.size, reconciled };
}
function resumeSession(ownerWebContentsId, sessionId) {
  if (typeof sessionId !== 'string' || ![...registry.values()].some((task) => task.sessionId === sessionId)) {
    throw new Error('Developer session cannot be resumed.');
  }
  sessions.set(ownerWebContentsId, sessionId);
  for (const task of registry.values()) if (task.sessionId === sessionId) task.ownerWebContentsId = ownerWebContentsId;
  for (const turn of conversationTurns.values()) if (turn.sessionId === sessionId) turn.ownerWebContentsId = ownerWebContentsId;
  const task = [...registry.values()].find((item) => item.sessionId === sessionId);
  recordMutation(task, 'session_resumed', { ownerWebContentsId });
  return sessionId;
}
function releaseSession(ownerWebContentsId) {
  cancelSession(ownerWebContentsId);
  for (const turn of conversationTurns.values()) {
    if (turn.ownerWebContentsId === ownerWebContentsId && !['completed', 'failed', 'cancelled'].includes(turn.state)) {
      turn.state = 'cancelled';
      turn.updatedAt = now();
      recordMutation(turn, 'conversation_turn_cancelled', {});
    }
  }
  sessions.delete(ownerWebContentsId);
}
function cancelSession(ownerWebContentsId) {
  const sessionId = sessions.get(ownerWebContentsId);
  for (const task of registry.values()) {
    if (task.sessionId === sessionId && !['completed', 'undone', 'failed', 'cancelled'].includes(task.state)) {
      task.cancelRequested = true;
      if (!EXECUTION_OWNED_STATES.has(task.state)) transition(task, 'cancelled');
      recordMutation(task, 'cancelled', {});
    }
  }
  for (const turn of conversationTurns.values()) {
    if ((turn.ownerWebContentsId === ownerWebContentsId || turn.sessionId === sessionId) && !['completed', 'failed', 'cancelled'].includes(turn.state)) {
      turn.state = 'cancelled';
      turn.updatedAt = now();
      recordMutation(turn, 'conversation_turn_cancelled', {});
    }
  }
}
function progress(task, phase, message) {
  task.progress = { phase, message, at: now() };
  recordMutation(task, 'progress', { phase, message });
}
function runtimeState(task) {
  const state = task.runtime || {
    phase: 'CREATED',
    taskState: 'CREATED',
    planVersion: 1,
    plan: null,
    taskGraph: null,
    assumptions: [],
    observations: [],
    metrics: { toolCalls: 0, usefulToolCalls: 0, duplicateToolCalls: 0, unnecessaryToolCalls: 0, filesRead: 0, filesChanged: 0, verificationRuns: 0, repairAttempts: 0, confidence: 'LOW' },
    taskMemory: { goal: '', constraints: [], filesInspected: [], importantFindings: [], plannedChanges: [], proposalIds: [], verificationResults: [], failures: [], repairRounds: 0 },
    history: [],
    lastUpdated: now(),
  };
  state.lastUpdated = now();
  return {
    phase: state.phase || 'CREATED',
    taskState: state.taskState || state.phase || 'CREATED',
    planVersion: Number(state.planVersion || 1),
    plan: state.plan || null,
    taskGraph: state.taskGraph || null,
    assumptions: Array.isArray(state.assumptions) ? [...state.assumptions] : [],
    observations: Array.isArray(state.observations) ? [...state.observations].slice(-developerSettings.maxStateHistoryEntries) : [],
    metrics: { ...state.metrics },
    taskMemory: { ...state.taskMemory },
    history: Array.isArray(state.history) ? [...state.history].slice(-developerSettings.maxStateHistoryEntries) : [],
    lastUpdated: state.lastUpdated,
  };
}
function publicTask(task) {
  return {
    id: task.taskId, taskId: task.taskId, sessionId: task.sessionId, state: task.state,
    lifecycleState: STATE_ALIASES[task.state] || task.state.toUpperCase(),
    proposalId: task.proposalId || task.taskId,
    workspace: task.workspace, files: (task.files || []).map(({ operation, path, sourcePath, hash: fileHash }) => ({ operation, path, sourcePath: sourcePath || null, hash: fileHash })),
    targetFiles: (task.files || []).map(({ path }) => path),
    snapshotHashes: (task.before || []).map(({ path, hash: fileHash }) => ({ path, hash: fileHash })),
    approval: task.approval ? {
      approvedAt: task.approval.approvedAt,
      expiresAt: task.approval.expiresAt,
      manifestHash: task.approval.manifestHash,
      actor: task.approval.actor,
    } : null,
    manifestHash: task.manifestHash || null,
    progress: task.progress, verification: sanitizeVerificationSnapshot(task.verification), verificationScript: task.verificationScript || null,
    verificationScripts: task.verificationScripts || [],
    evidence: Array.isArray(task.evidence) ? redact(task.evidence).slice(-50) : [],
    scope: task.scope || '.',
    taskPlan: task.taskPlan ? redact(task.taskPlan) : null,
    outcome: task.outcome || null, error: task.error || null,
    runtime: runtimeState(task),
    durability: { journalError: journalError?.message || null, auditError: auditError?.message || null },
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}
function inside(root, target) {
  const compareRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const compareTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const rel = path.relative(compareRoot, compareTarget);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function samePath(first, second) {
  const resolvedFirst = path.resolve(first);
  const resolvedSecond = path.resolve(second);
  return process.platform === 'win32'
    ? resolvedFirst.toLowerCase() === resolvedSecond.toLowerCase()
    : resolvedFirst === resolvedSecond;
}
function isReservedWindowsName(segment) {
  return /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(segment);
}
function isSensitiveMutationPath(relative) {
  return SENSITIVE_PATH_PATTERN.test(relative) || relative.replace(/\\/g, '/').split('/').some((part) => {
    const normalized = part.toLowerCase();
    return normalized === '.git' || SENSITIVE_DIRECTORY_NAMES.has(normalized) || SENSITIVE_FILE_NAME_PATTERN.test(part);
  });
}
async function safePath(root, relative, { allowMissing = false, allowDirectory = false } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Proposal paths must be relative.');
  const clean = relative.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/.test(part) || isReservedWindowsName(part))) {
    throw new Error('Proposal path traversal is denied.');
  }
  if (isSensitiveMutationPath(clean)) throw new Error('Sensitive files cannot be changed by the Coding Agent.');
  const projectRoot = await fs.realpath(root);
  const target = path.resolve(projectRoot, ...clean.split('/'));
  if (!inside(projectRoot, target)) throw new Error('Proposal path is outside the selected project.');
  let cursor = projectRoot;
  let missing = false;
  for (const segment of clean.split('/')) {
    cursor = path.join(cursor, segment);
    if (missing) continue;
    let stat;
    try { stat = await fs.lstat(cursor); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing = true;
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error('Symlink proposal targets are denied.');
  }
  if (missing && !allowMissing) throw new Error('Proposal target does not exist.');
  if (!missing) {
    const real = await fs.realpath(target);
    if (!inside(projectRoot, real)) throw new Error('Proposal path is outside the selected project.');
    const stat = await fs.lstat(real);
    if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) throw new Error('Only regular files and explicitly targeted directories are allowed.');
    return { relative: clean, target: real, exists: true, isDirectory: stat.isDirectory(), parentExists: true };
  }
  let existingParent = path.dirname(target);
  while (true) {
    try {
      existingParent = await fs.realpath(existingParent);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existingParent);
      if (parent === existingParent) throw error;
      existingParent = parent;
    }
  }
  if (!inside(projectRoot, existingParent)) throw new Error('Proposal path is outside the selected project.');
  let parentExists = false;
  try {
    const realParent = await fs.realpath(path.dirname(target));
    parentExists = inside(projectRoot, realParent);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { relative: clean, target, exists: false, isDirectory: false, parentExists };
}
async function snapshotTarget(root, relative) {
  const safe = await safePath(root, relative, { allowMissing: true, allowDirectory: true });
  if (!safe.exists) return { path: safe.relative, exists: false, type: 'missing', hash: hash('MISSING') };
  if (!safe.isDirectory) {
    const stat = await fs.stat(safe.target);
    if (stat.size > MAX_MUTATION_FILE_BYTES) throw new Error(`Mutation target exceeds the ${MAX_MUTATION_FILE_BYTES / 1024 / 1024} MiB text-file safety limit.`);
    const bytes = await fs.readFile(safe.target);
    const content = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error('Binary or invalid UTF-8 files cannot be changed by a text proposal.');
    }
    return { path: safe.relative, exists: true, type: 'file', hash: hash(bytes), content };
  }
  const entries = [];
  let totalBytes = 0;
  const visit = async (directory, prefix) => {
    const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error('Directory mutations containing symlinks are denied.');
      const relativeChild = prefix ? `${prefix}/${child.name}` : child.name;
      const childPath = path.join(directory, child.name);
      if (relativeChild.split('/').some((part) => isReservedWindowsName(part))) {
        throw new Error(`Directory mutation contains a reserved Windows device name: ${relativeChild}.`);
      }
      if (isSensitiveMutationPath(relativeChild)) {
        throw new Error(`Directory mutation includes a protected path: ${relativeChild}.`);
      }
      if (child.isDirectory()) {
        entries.push({ path: relativeChild, type: 'directory' });
        await visit(childPath, relativeChild);
      } else if (child.isFile()) {
        const content = await fs.readFile(childPath);
        totalBytes += content.length;
        if (totalBytes > 50 * 1024 * 1024) throw new Error('Directory mutation exceeds the 50 MiB snapshot safety limit.');
        entries.push({ path: relativeChild, type: 'file', contentBase64: content.toString('base64'), hash: hash(content) });
      } else {
        throw new Error('Unsupported filesystem entry in a directory mutation.');
      }
      if (entries.length > 5000) throw new Error('Directory mutation exceeds the 5000-entry safety limit.');
    }
  };
  await visit(safe.target, '');
  return { path: safe.relative, exists: true, type: 'directory', entries, hash: hash(JSON.stringify(entries)) };
}
async function snapshot(root, relative) {
  const state = await snapshotTarget(root, relative);
  if (!state.exists || state.type !== 'file') throw new Error('A regular file is required for this operation.');
  return state;
}
function parsePatch(raw) {
  if (typeof raw !== 'string' || raw.length > developerSettings.proposalMaxBytes) throw new Error('Proposal is invalid or too large.');
  if (/^\s*NO_CHANGES\s*$/i.test(raw)) return [];
  const lines = raw.replace(/^```(?:diff|patch)?\s*/i, '').replace(/\s*```\s*$/, '').split(/\r?\n/);
  const files = [];
  let current = null;
  const startFile = () => {
    if (current) files.push(current);
    current = { oldHeader: null, newHeader: null, renameFrom: null, renameTo: null, directoryDelete: null, lines: [] };
  };
  for (const line of lines) {
    if (/^diff --git /.test(line)) { if (current) startFile(); else startFile(); continue; }
    const directoryDelete = line.match(/^\*\*\* Delete Directory: (.+)$/);
    if (directoryDelete) {
      startFile();
      current.directoryDelete = directoryDelete[1].trim();
      files.push(current);
      current = null;
      continue;
    }
    const oldHeader = line.match(/^--- (.+?)(?:\t.*)?$/);
    if (oldHeader) {
      if (!current || current.oldHeader !== null) startFile();
      current.oldHeader = oldHeader[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const newHeader = line.match(/^\+\+\+ (.+?)(?:\t.*)?$/);
    if (newHeader) {
      if (!current) startFile();
      current.newHeader = newHeader[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const renameFrom = line.match(/^rename from (.+)$/);
    if (renameFrom) { if (!current) startFile(); current.renameFrom = renameFrom[1].trim(); continue; }
    const renameTo = line.match(/^rename to (.+)$/);
    if (renameTo) { if (!current) startFile(); current.renameTo = renameTo[1].trim(); continue; }
    if (current && (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '\\ No newline at end of file')) current.lines.push(line);
  }
  if (current) files.push(current);
  const decodePath = (value, prefix) => {
    if (!value || value === '/dev/null') return null;
    if (value.startsWith(`${prefix}/`)) return value.slice(prefix.length + 1);
    return value;
  };
  const normalized = files.map((file) => {
    if (file.directoryDelete) {
      return { operation: 'delete_directory', path: file.directoryDelete.replace(/\\/g, '/'), sourcePath: null, lines: [] };
    }
    const sourcePath = file.renameFrom || decodePath(file.oldHeader, 'a');
    const targetPath = file.renameTo || decodePath(file.newHeader, 'b');
    let operation;
    if (file.renameFrom || file.renameTo) operation = 'rename';
    else if (!sourcePath && targetPath) operation = 'create';
    else if (sourcePath && !targetPath) operation = 'delete';
    else if (sourcePath && targetPath && sourcePath !== targetPath) operation = 'rename';
    else operation = 'modify';
    const changePath = operation === 'delete' ? sourcePath : targetPath;
    if (!changePath || (operation === 'rename' && !sourcePath)) throw new Error('Proposal contains an invalid file path header.');
    if (!file.lines.some((line) => line.startsWith('@@')) && !(operation === 'rename' && file.lines.length === 0)) {
      throw new Error('Proposal must include a valid unified diff hunk.');
    }
    return { operation, path: changePath.replace(/\\/g, '/'), sourcePath: operation === 'rename' ? sourcePath.replace(/\\/g, '/') : null, lines: file.lines };
  });
  if (!normalized.length) throw new Error('Proposal must be a unified diff.');
  return normalized;
}
function applyFilePatch(original, lines) {
  if (!Array.isArray(lines) || !lines.some((line) => line.startsWith('@@'))) {
    throw new Error('Proposal must include a valid unified diff hunk.');
  }
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = original.length === 0 || /(?:\r\n|\n)$/.test(original);
  const source = original ? original.split(/\r?\n/) : [];
  if (hadTrailingNewline && source.at(-1) === '') source.pop();
  const output = []; let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) throw new Error('Invalid patch hunk header.');
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] || 1);
    let start = oldCount === 0 ? oldStart : oldStart - 1;

    if (start < cursor) {
      throw new Error('Overlapping patch hunks are not permitted.');
    }

    const hunkExpected = [];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('@@'); j += 1) {
      const line = lines[j];
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ') || line.startsWith('-')) {
        hunkExpected.push(line.slice(1));
      }
    }

    const matchesAt = (pos, allowTrim = true) => {
      if (pos < cursor || pos + hunkExpected.length > source.length) return false;
      for (let k = 0; k < hunkExpected.length; k += 1) {
        const srcLine = source[pos + k];
        const expLine = hunkExpected[k];
        if (srcLine === expLine) continue;
        if (allowTrim && srcLine !== undefined && srcLine.trimEnd() === expLine.trimEnd()) continue;
        return false;
      }
      return true;
    };

    if (oldCount > 0 && hunkExpected.length > 0) {
      const minOffset = Math.max(cursor, start - 3);
      const maxOffset = Math.min(source.length - hunkExpected.length, start + 3);
      const exactCandidates = [];
      const trimmedCandidates = [];

      for (let offset = minOffset; offset <= maxOffset; offset += 1) {
        if (matchesAt(offset, false)) {
          exactCandidates.push(offset);
        } else if (matchesAt(offset, true)) {
          trimmedCandidates.push(offset);
        }
      }

      if (exactCandidates.length === 1) {
        start = exactCandidates[0];
      } else if (exactCandidates.length > 1) {
        throw new Error('Ambiguous patch target: multiple matching locations found.');
      } else if (trimmedCandidates.length === 1) {
        start = trimmedCandidates[0];
      } else if (trimmedCandidates.length > 1) {
        throw new Error('Ambiguous patch target: multiple matching locations found with whitespace tolerance.');
      } else {
        throw new Error('Patch context does not match.');
      }
    } else if (oldCount === 0) {
      if (start > source.length) {
        throw new Error('Patch insertion target is out of bounds.');
      }
    } else if (oldCount > 0 && hunkExpected.length === 0) {
      throw new Error('Invalid patch hunk: no context or deletion lines in hunk.');
    }

    output.push(...source.slice(cursor, start));
    cursor = start;
    let consumed = 0;
    let produced = 0;
    for (i += 1; i < lines.length && !lines[i].startsWith('@@'); i += 1) {
      const line = lines[i];
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ')) {
        const expected = line.slice(1);
        const matches = source[cursor] === expected || (source[cursor] !== undefined && source[cursor].trimEnd() === expected.trimEnd());
        if (!matches) throw new Error('Patch context does not match.');
        output.push(source[cursor++]);
        consumed += 1;
        produced += 1;
      } else if (line.startsWith('-')) {
        const expected = line.slice(1);
        const matches = source[cursor] === expected || (source[cursor] !== undefined && source[cursor].trimEnd() === expected.trimEnd());
        if (!matches) throw new Error('Patch removal does not match.');
        cursor += 1;
        consumed += 1;
      } else if (line.startsWith('+')) {
        output.push(line.slice(1));
        produced += 1;
      } else {
        throw new Error('Invalid patch hunk.');
      }
    }
    if (oldCount !== consumed && Math.abs(oldCount - consumed) > 1) {
      throw new Error('Patch hunk line count is invalid.');
    }
    i -= 1;
  }
  output.push(...source.slice(cursor));
  const content = output.join(newline);
  const result = hadTrailingNewline && content ? `${content}${newline}` : content;
  const resultBytes = Buffer.from(result, 'utf8');
  if (resultBytes.length > MAX_MUTATION_FILE_BYTES) {
    throw new Error(`Proposed text file exceeds the ${MAX_MUTATION_FILE_BYTES / 1024 / 1024} MiB safety limit.`);
  }
  if (resultBytes.includes(0) || resultBytes.toString('utf8') !== result) {
    throw new Error('Binary or invalid UTF-8 content cannot be written by a text proposal.');
  }
  return result;
}

function proposalManifestHash(task) {
  return hash(JSON.stringify({
    proposalId: task.proposalId,
    root: task.root,
    scope: task.scope,
    authorizationContext: task.authorizationContext,
    requestedFeatures: task.requestedFeatures,
    authorizedFeatures: task.authorizedFeatures || null,
    diffHash: typeof task.raw === 'string' ? hash(task.raw) : task.manifestDiffHash,
    files: task.files.map((file) => ({
      operation: file.operation,
      sourcePath: file.sourcePath || null,
      path: file.path,
      content: file.content ?? null,
      hash: file.hash,
    })),
    before: task.before.map(({ path: targetPath, exists, type, hash: snapshotHash }) => ({
      path: targetPath,
      exists,
      type,
      hash: snapshotHash,
    })),
    after: task.after.map(({ path: targetPath, exists, type, hash: snapshotHash }) => ({
      path: targetPath,
      exists,
      type,
      hash: snapshotHash,
    })),
    taskPlanDigest: task.taskPlan ? getWorkItemPlanDigest(task.taskPlan) : null,
  }));
}

function assessTaskRisk({ files = [], root = '' }) {
  const reasons = [];
  let score = 10;
  const paths = (files || []).map((f) => (typeof f === 'string' ? f : f?.path || ''));

  for (const filePath of paths) {
    if (SENSITIVE_PATH_PATTERN.test(filePath) || /(?:secret|password|credential|token|api[_-]?key)/i.test(filePath)) {
      reasons.push(`Sensitive security/credential path touched: ${filePath}`);
      score += 80;
    }
    if (/(?:migration|schema\.sql|database\.ya?ml|docker-compose)/i.test(filePath)) {
      reasons.push(`Infrastructure or database schema touched: ${filePath}`);
      score += 40;
    }
  }

  if (paths.length > 5) {
    reasons.push(`Broad blast radius: ${paths.length} files modified`);
    score += 35;
  } else if (paths.length >= 2) {
    reasons.push(`Multi-file modification: ${paths.length} files modified`);
    score += 15;
  }

  let level = 'LOW';
  if (score >= 80) level = 'CRITICAL';
  else if (score >= 50) level = 'HIGH';
  else if (score >= 25) level = 'MEDIUM';

  return {
    level,
    score: Math.min(score, 100),
    reasons,
    blastRadius: paths.length,
    evaluatedAt: now(),
  };
}

function selfReviewPatch(rawPatch) {
  const issues = [];
  if (!rawPatch || typeof rawPatch !== 'string' || !rawPatch.trim()) {
    return { approved: false, issues: ['Patch is empty or invalid.'], risk: 'CRITICAL', fileCount: 0 };
  }

  let parsedFiles = [];
  try {
    parsedFiles = parsePatch(rawPatch);
  } catch (err) {
    return { approved: false, issues: [`Malformed patch syntax: ${err.message}`], risk: 'CRITICAL', fileCount: 0 };
  }

  if (parsedFiles.length === 0) {
    issues.push('No valid file changes found in patch.');
  }

  for (const file of parsedFiles) {
    if (isSensitiveMutationPath(file.path)) {
      issues.push(`Forbidden file in patch: ${file.path}`);
    }
    const additions = file.lines.filter((l) => l.startsWith('+')).length;
    const deletions = file.lines.filter((l) => l.startsWith('-')).length;
    if (additions === 0 && deletions === 0 && file.operation !== 'delete_directory' && file.operation !== 'rename') {
      issues.push(`Empty file hunk for: ${file.path}`);
    }
  }

  const approved = issues.length === 0;
  const risk = issues.some((i) => i.includes('Forbidden')) ? 'CRITICAL' : issues.length > 0 ? 'HIGH' : 'LOW';

  return {
    approved,
    issues,
    risk,
    fileCount: parsedFiles.length,
    reviewedAt: now(),
  };
}

function classifyVerificationFailure(stdout = '', stderr = '', exitCode = 1) {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  let category = 'runtime_issue';
  let suggestedRecovery = 'Inspect error logs and check execution arguments.';

  if (/syntaxerror|parse\s*error|unexpected\s+token|indentationerror/i.test(combined)) {
    category = 'implementation_defect';
    suggestedRecovery = 'Fix syntax or parse error in modified source lines.';
  } else if (/assertionerror|assert\.ok|expected.*to\s+equal|failed\s+test|\b1\s+failed\b|\bfail\b/i.test(combined)) {
    category = 'test_defect';
    suggestedRecovery = 'Inspect test assertion mismatch and verify expected contract.';
  } else if (/timed?\s*out|operation\s+timed\s+out|sigterm|sigkill/i.test(combined)) {
    category = 'timeout';
    suggestedRecovery = 'Increase execution timeout or reduce scope of checks.';
  } else if (/cannot\s+find\s+module|no\s+such\s+file|module\s+not\s+found|import\s+error|modulenotfounderror/i.test(combined)) {
    category = 'dependency_issue';
    suggestedRecovery = 'Verify dependencies and import paths in target project.';
  } else if (/permission\s+denied|eacces|eperm|econnrefused|connection\s+refused/i.test(combined)) {
    category = 'environment_issue';
    suggestedRecovery = 'Check filesystem permissions or environment service availability.';
  } else if (/socket\s+hang\s+up|econnreset|flaky/i.test(combined)) {
    category = 'flaky_failure';
    suggestedRecovery = 'Retry transient network/socket operation.';
  } else if (/invalid\s+json|yaml\s+parse|configuration\s+error/i.test(combined)) {
    category = 'configuration_issue';
    suggestedRecovery = 'Validate syntax of project configuration files.';
  }

  return {
    category,
    classification: category.toUpperCase(),
    exitCode,
    message: bounded(stderr || stdout || 'Unknown failure', 500),
    suggestedRecovery,
    classifiedAt: now(),
  };
}

function saveTaskCheckpoint(taskId, phase, data = {}, owner) {
  const task = getTask(taskId, owner);
  task.checkpoint = {
    phase: phase || task.state,
    at: now(),
    data: redact(data),
  };
  task.updatedAt = now();
  recordMutation(task, 'task_checkpoint', { phase: task.checkpoint.phase });
  return { taskId: task.taskId, checkpoint: task.checkpoint };
}

function restoreTaskCheckpoint(taskId, targetPhase, owner) {
  const task = getTask(taskId, owner);
  if (!task.checkpoint) {
    throw new Error(`Task ${taskId} has no saved checkpoint to restore.`);
  }
  task.state = task.checkpoint.phase || 'proposal_ready';
  task.updatedAt = now();
  recordMutation(task, 'task_checkpoint_restored', { restoredPhase: task.state });
  return publicTask(task);
}

function pauseTask(taskId, owner) {
  const task = getTask(taskId, owner);
  task.paused = true;
  saveTaskCheckpoint(taskId, task.state, { pausedAt: now() }, owner);
  recordMutation(task, 'task_paused', { at: now() });
  return publicTask(task);
}

function resumeTask(taskId, targetPhase, owner) {
  const task = getTask(taskId, owner);
  task.paused = false;
  if (targetPhase && task.checkpoint) {
    task.state = targetPhase;
  }
  task.updatedAt = now();
  recordMutation(task, 'task_resumed', { phase: task.state });
  return publicTask(task);
}

function cancelTask(taskId, owner, { syncConversationTurn = true } = {}) {
  const task = getTask(taskId, owner);
  if (['completed', 'failed', 'cancelled'].includes(task.state)) {
    return { ...publicTask(task), cancellationAccepted: false };
  }
  task.cancelRequested = true;
  const executionOwnsRecovery = EXECUTION_OWNED_STATES.has(task.state);
  if (!executionOwnsRecovery && transitions[task.state]?.includes('cancelled')) {
    transition(task, 'cancelled', { syncConversationTurn });
  } else if (!executionOwnsRecovery) {
    task.state = 'cancelled';
    task.updatedAt = now();
    recordMutation(task, 'task_cancelled', { at: now() });
  }
  return { ...publicTask(task), cancellationAccepted: true };
}

async function createProposal({
  root: inputRoot, raw, expectedSnapshots = [], sessionId, ownerWebContentsId,
  workspace = {}, verificationScript = null, verificationScripts = [], scope = '.', conversationTurnId = null,
  taskPlan = null,
}) {
  if (!sessionId || ownerWebContentsId === undefined) throw new Error('Developer session ownership is required.');
  if (!conversationTurnId) throw new Error('A request-bound Coding conversation turn is required to register a proposal.');
  const root = await fs.realpath(inputRoot);
  const scopePath = scope && scope !== '.' ? scope : '';
  if (path.isAbsolute(scopePath) || scopePath.replace(/\\/g, '/').split('/').some((segment) => segment === '..')) {
    throw new Error('Proposal scope must remain inside the selected project.');
  }
  const scopeRoot = path.resolve(root, ...scopePath.replace(/\\/g, '/').split('/').filter(Boolean));
  if (!inside(root, scopeRoot)) throw new Error('Proposal scope must remain inside the selected project.');
  const turn = conversationTurns.get(conversationTurnId);
  assertConversationOwner(turn, { sessionId, ownerWebContentsId });
  if (turn.operatingMode === 'AUDIT' || turn.authorizationContext?.operatingMode === 'AUDIT') {
    throw new Error('Operation denied: cannot create proposals in read-only AUDIT mode.');
  }
  if (!['understanding', 'proposal_ready', 'recovering', 'applying'].includes(turn.state) || !samePath(await fs.realpath(turn.root), root) || turn.scope !== scope
    || !Number.isFinite(Date.parse(turn.authorizationContext?.expiresAt || ''))
    || Date.parse(turn.authorizationContext.expiresAt) <= Date.now()
    || turn.authorizationContext?.turnId !== turn.turnId
    || turn.authorizationContext?.sessionId !== sessionId
    || turn.authorizationContext?.ownerWebContentsId !== ownerWebContentsId
    || !/^[a-f0-9]{64}$/.test(turn.authorizationContext?.requestHash || '')) {
    throw new Error('Coding conversation is not ready to register a request-bound proposal for this project scope.');
  }
  if (verificationScript !== null) commandPolicy(verificationScript);
  const requestedScripts = [
    ...(Array.isArray(verificationScripts) ? verificationScripts : []),
    ...(verificationScript ? [verificationScript] : []),
  ];
  const safeVerificationScripts = [...new Set(requestedScripts.map((script) => commandPolicy(script).script))];
  const authorizationContext = Object.freeze({
    ...turn.authorizationContext,
    root,
    scope: scope || '.',
    authorizedFeatures: Object.freeze([...turn.authorizationContext.authorizedFeatures]),
  });
  const files = parsePatch(raw); const unique = new Set(); const before = []; const changes = [];
  for (const file of files) {
    const mutationPaths = file.sourcePath ? [file.sourcePath, file.path] : [file.path];
    for (const mutationPath of mutationPaths) {
      const uniquePath = process.platform === 'win32' ? mutationPath.toLowerCase() : mutationPath;
      if (unique.has(uniquePath)) throw new Error('Proposal contains duplicate or overlapping files.');
      unique.add(uniquePath);
      const scopedTarget = path.resolve(root, ...mutationPath.replace(/\\/g, '/').split('/'));
      if (!inside(scopeRoot, scopedTarget)) throw new Error(`Proposal target is outside the approved scope: ${mutationPath}.`);
    }
    if (file.operation === 'delete_directory' && path.resolve(root, file.path.replace(/\\/g, '/')) === scopeRoot) {
      throw new Error('Deleting the entire approved proposal scope is not permitted.');
    }
    const sourcePath = file.sourcePath || file.path;
    const sourceState = await snapshotTarget(root, sourcePath);
    const expected = expectedSnapshots.find((item) => {
      const expectedPath = item.path.replace(/\\/g, '/');
      return process.platform === 'win32'
        ? expectedPath.toLowerCase() === sourceState.path.toLowerCase()
        : expectedPath === sourceState.path;
    });
    if (expected && expected.hash !== sourceState.hash) throw new Error(`Snapshot is stale for ${sourceState.path}.`);
    if (file.operation === 'create' && sourceState.exists) throw new Error(`Create target already exists: ${sourcePath}.`);
    if (file.operation === 'create' && !(await safePath(root, file.path, { allowMissing: true })).parentExists) {
      throw new Error(`Create target parent does not exist: ${path.dirname(file.path)}.`);
    }
    if (file.operation === 'rename') {
      const destination = await snapshotTarget(root, file.path);
      if (destination.exists) throw new Error(`Rename target already exists: ${file.path}.`);
      if (!(await safePath(root, file.path, { allowMissing: true })).parentExists) {
        throw new Error(`Rename target parent does not exist: ${path.dirname(file.path)}.`);
      }
      before.push(sourceState, destination);
    } else {
      before.push(sourceState);
    }
    let content = null;
    if (file.operation === 'delete_directory') {
      const directory = await snapshotTarget(root, file.path);
      if (!directory.exists || directory.type !== 'directory') throw new Error(`Directory delete target is not a directory: ${file.path}.`);
    } else if (file.operation === 'delete') {
      if (!sourceState.exists || sourceState.type !== 'file') throw new Error(`Delete target is not a regular file: ${sourcePath}.`);
      const after = applyFilePatch(sourceState.content, file.lines);
      if (after !== '') throw new Error(`File deletion patch does not remove all content from ${sourcePath}.`);
    } else if (file.operation === 'rename') {
      if (!sourceState.exists || sourceState.type !== 'file') throw new Error(`Rename source is not a regular file: ${sourcePath}.`);
      content = file.lines.length ? applyFilePatch(sourceState.content, file.lines) : sourceState.content;
    } else if (file.operation === 'create') {
      if (sourceState.exists) throw new Error(`Create target already exists: ${sourcePath}.`);
      content = applyFilePatch('', file.lines);
    } else {
      if (!sourceState.exists || sourceState.type !== 'file') throw new Error(`Modify target is not a regular file: ${sourcePath}.`);
      content = applyFilePatch(sourceState.content, file.lines);
      if (content === sourceState.content) throw new Error(`Proposal has no change for ${sourcePath}.`);
    }
    if (file.operation !== 'delete' && file.operation !== 'delete_directory') {
      changes.push({ operation: file.operation, path: file.path, sourcePath: file.sourcePath, hash: hash(content), content });
    } else {
      changes.push({ operation: file.operation, path: file.path, sourcePath: file.sourcePath, hash: hash(file.operation === 'delete' ? 'MISSING' : 'MISSING') });
    }
  }
  const requestedFeatures = featuresForChanges(changes);
  const after = [];
  for (const change of changes) {
    if (change.operation === 'rename') after.push({ path: change.sourcePath, exists: false, type: 'missing', hash: hash('MISSING') });
    after.push(change.operation === 'delete' || change.operation === 'delete_directory'
      ? { path: change.path, exists: false, type: 'missing', hash: hash('MISSING') }
      : { path: change.path, exists: true, type: 'file', hash: change.hash });
  }
  const task = {
    taskId: crypto.randomUUID(), sessionId, ownerWebContentsId, root,
    conversationTurnId,
    operatingMode: turn.operatingMode || authorizationContext?.operatingMode || 'AUTONOMOUS',
    authorizationContext,
    requestedFeatures,
    authorizedFeatures: null,
    scope: scope || '.',
    taskPlan,
    proposalId: crypto.randomUUID(),
    workspace: { root, name: workspace.name || path.basename(root), branch: workspace.branch || null },
    raw, files: changes, before, after,
    verificationScript: safeVerificationScripts[0] || null,
    verificationScripts: safeVerificationScripts,
    state: 'proposal_ready', progress: { phase: 'proposal', message: 'Validated proposal.', at: now() },
    runtime: {
      phase: 'PROPOSING',
      taskState: 'PROPOSING',
      planVersion: 1,
      plan: { goal: turn.request, tasks: ['Inspect relevant files', 'Validate proposed change', 'Await approval', 'Apply and verify'] },
      taskGraph: null,
      assumptions: [],
      observations: [{ kind: 'PROPOSAL_CREATED', files: changes.map((entry) => entry.path) }],
      metrics: { toolCalls: 0, usefulToolCalls: 0, duplicateToolCalls: 0, unnecessaryToolCalls: 0, filesRead: before.length, filesChanged: changes.length, verificationRuns: 0, repairAttempts: 0, confidence: 'MEDIUM' },
      taskMemory: { goal: turn.request, constraints: ['read-only until explicit approval', 'project-root confinement'], filesInspected: before.map((entry) => entry.path), importantFindings: [], plannedChanges: ['validated proposal', 'approval gate'], proposalIds: [], verificationResults: [], failures: [], repairRounds: 0 },
      history: [{ phase: 'PROPOSING', at: now(), message: 'Validated proposal ready for approval.' }],
      lastUpdated: now(),
    },
    risk: assessTaskRisk({ files: changes, root }),
    selfReview: selfReviewPatch(raw),
    security: inspectPatchSecurity(raw),
    artifacts: [],
    checkpoint: {
      phase: 'awaiting_approval',
      at: now(),
      data: { fileCount: changes.length, risk: assessTaskRisk({ files: changes, root }).level },
    },
    findings: [],
    evidence: [],
    hypotheses: [],
    rejectedHypotheses: [],
    subtasks: [],
    testPlan: safeVerificationScripts,
    testResults: [],
    blocker: null,
    nextAction: 'AWAIT_USER_APPROVAL',
    createdAt: now(), updatedAt: now(),
  };
  task.manifestDiffHash = hash(raw);
  task.manifestHash = proposalManifestHash(task);
  if (conversationTurnId) {
    const turn = conversationTurns.get(conversationTurnId);
    turn.state = 'proposal_ready';
    turn.updatedAt = now();
    recordMutation(turn, 'conversation_state_transition', { from: 'understanding', to: 'proposal_ready', fileCount: changes.length });
  }
  registry.set(task.taskId, task); recordMutation(task, 'proposal_registered', { proposalId: task.proposalId });
  taskOrchestrator.createTask({
    taskId: task.taskId,
    sessionId,
    ownerWebContentsId,
    goal: turn.request,
    workspace: root,
    repository: path.basename(root),
  });
  try {
    artifactEngine.createArtifact({
      taskId: task.taskId,
      type: ARTIFACT_TYPES.IMPLEMENTATION_PLAN,
      content: task.runtime?.plan,
      phase: 'proposal_ready',
    });
    artifactEngine.createArtifact({
      taskId: task.taskId,
      type: ARTIFACT_TYPES.PATCH_PROPOSAL,
      content: raw,
      phase: 'proposal_ready',
    });
    task.artifacts = artifactEngine.getArtifacts(task.taskId);
  } catch {}
  transition(task, 'awaiting_approval'); return publicTask(task);
}
function getTask(taskId, owner) { const task = registry.get(taskId); if (!task) throw new Error('Unknown Developer task.'); assertOwner(task, owner); return task; }
function assertTaskAuthorization(task) {
  const context = task.authorizationContext;
  const turn = conversationTurns.get(task.conversationTurnId);
  if (!context || !turn) {
    throw new Error('Request-bound authorization is missing or no longer matches this turn.');
  }
  if (context.taskId !== turn.authorizationContext?.taskId
    || context.turnId !== task.conversationTurnId
    || context.requestHash !== turn.authorizationContext?.requestHash
    || context.expiresAt !== turn.authorizationContext?.expiresAt
    || !Number.isFinite(Date.parse(context.expiresAt || ''))
    || Date.parse(context.expiresAt) <= Date.now()
    || turn.state === 'cancelled'
    || context.sessionId !== task.sessionId
    || context.ownerWebContentsId !== task.ownerWebContentsId
    || !samePath(context.root || '', task.root)
    || context.scope !== task.scope
    || !Array.isArray(context.authorizedFeatures)
    || !/^[a-f0-9]{64}$/.test(context.requestHash || '')) {
    throw new Error('Request-bound Coding authorization is invalid, stale, or mismatched.');
  }
  return context;
}
function getTaskMutationContext(taskId, owner) {
  const task = getTask(taskId, owner);
  assertTaskAuthorization(task);
  return {
    root: task.root,
    scope: task.scope,
    affectedPaths: [...new Set((task.before || []).map((item) => item.path))],
    requestedFeatures: [...(task.requestedFeatures || [])],
    authorizedFeatures: [...(task.approval?.authorizedFeatures || [])],
    requestBinding: {
      taskId: task.authorizationContext.taskId,
      turnId: task.authorizationContext.turnId,
      requestHash: task.authorizationContext.requestHash,
      root: task.authorizationContext.root,
      scope: task.authorizationContext.scope,
      authorizedFeatures: [...(task.approval?.authorizedFeatures || [])],
    },
  };
}
function getProposalAuthorizationContext(taskId, owner) {
  const task = getTask(taskId, owner);
  assertTaskAuthorization(task);
  return {
    proposalId: task.proposalId,
    requestSummary: task.authorizationContext.requestSummary,
    requestedFeatures: [...(task.requestedFeatures || [])],
    authorizedFeatures: [...task.authorizationContext.authorizedFeatures],
    changedPaths: [...new Set((task.files || []).flatMap((file) => [file.path, file.sourcePath]).filter(Boolean))],
  };
}
function approve(taskId, owner, featureAuthorization = null) {
  const task = getTask(taskId, owner);
  if (task.state !== 'awaiting_approval') throw new Error('Only a proposal awaiting approval can be approved.');
  assertTaskAuthorization(task);
  if (task.manifestHash !== proposalManifestHash(task)) throw new Error('Proposal manifest changed before approval.');
  const requiredFeatures = featuresForChanges(task.files);
  const baselineFeatures = task.authorizationContext?.authorizedFeatures;
  if (!Array.isArray(baselineFeatures)
    || task.authorizationContext?.taskId !== (conversationTurns.get(task.conversationTurnId)?.authorizationContext?.taskId)
    || task.authorizationContext?.turnId !== task.conversationTurnId
    || task.authorizationContext?.sessionId !== task.sessionId
    || task.authorizationContext?.ownerWebContentsId !== task.ownerWebContentsId
    || !samePath(task.authorizationContext?.root || '', task.root)
    || task.authorizationContext?.scope !== task.scope
    || !/^[a-f0-9]{64}$/.test(task.authorizationContext?.requestHash || '')) {
    throw new Error('Request-bound authorization is missing or no longer matches this proposal.');
  }
  const additionalFeatures = requiredFeatures.filter((feature) => !baselineFeatures.includes(feature));
  let authorizedFeatures = [...baselineFeatures];
  if (additionalFeatures.length) {
    const suppliedFeatures = featureAuthorization?.authorizedFeatures;
    if (featureAuthorization?.source !== 'main-process-feature-confirmation'
      || featureAuthorization?.proposalId !== task.proposalId
      || !Array.isArray(suppliedFeatures)
      || additionalFeatures.some((feature) => !suppliedFeatures.includes(feature))) {
      throw new Error(`This proposal crosses the authorized feature scope (${additionalFeatures.join(', ')}); explicit main-process confirmation is required.`);
    }
    authorizedFeatures = [...new Set([...authorizedFeatures, ...suppliedFeatures])].sort();
  }
  task.authorizedFeatures = authorizedFeatures;
  task.manifestHash = proposalManifestHash(task);
  const approvalBinding = {
    runId: task.taskId,
    providerId: 'human-approval-record',
    providerConfigRevision: 'approval-default',
    approvedSnapshotDigest: task.manifestHash || `${task.taskId}-snapshot`,
    approvedManifestDigest: task.manifestHash || `${task.taskId}-manifest`,
    verificationPlanDigest: task.verificationPlanHash || task.manifestHash || `${task.taskId}-verification-plan`,
    workerIdentity: task.sessionId || task.ownerWebContentsId || task.taskId,
    evidenceTimestamp: now(),
    evidenceExpiry: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    provenance: 'human-approval-only',
    trustClass: 'UNTRUSTED',
  };
  task.approval = {
    approvedAt: now(),
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    proposalId: task.proposalId,
    manifestHash: task.manifestHash,
    consumedAt: null,
    actor: 'renderer-session',
    authorizedFeatures: [...authorizedFeatures],
    approvedSnapshotDigest: approvalBinding.approvedSnapshotDigest,
    approvedManifestDigest: approvalBinding.approvedManifestDigest,
    verificationPlanDigest: approvalBinding.verificationPlanDigest,
    providerConfigRevision: approvalBinding.providerConfigRevision,
    providerId: approvalBinding.providerId,
    workerIdentity: approvalBinding.workerIdentity,
    evidenceTimestamp: approvalBinding.evidenceTimestamp,
    evidenceExpiry: approvalBinding.evidenceExpiry,
    provenance: approvalBinding.provenance,
    trustClass: approvalBinding.trustClass,
  };
  task.runtime = task.runtime || {};
  task.runtime.phase = 'AWAITING_APPROVAL';
  task.runtime.taskState = 'AWAITING_APPROVAL';
  task.runtime.history = [...(task.runtime.history || []), { phase: 'AWAITING_APPROVAL', at: now(), message: 'User approved the proposal.' }].slice(-developerSettings.maxStateHistoryEntries);
  task.runtime.lastUpdated = now();
  transition(task, 'approved');
  recordMutation(task, 'proposal_approved', { proposalId: task.proposalId || taskId, actor: task.approval.actor });
  return publicTask(task);
}
function reject(taskId, owner) {
  const task = getTask(taskId, owner);
  if (task.state !== 'awaiting_approval') throw new Error('Only a proposal awaiting approval can be rejected.');
  task.runtime = task.runtime || {};
  task.runtime.phase = 'CANCELLED';
  task.runtime.taskState = 'CANCELLED';
  task.runtime.history = [...(task.runtime.history || []), { phase: 'CANCELLED', at: now(), message: 'User rejected the proposal.' }].slice(-developerSettings.maxStateHistoryEntries);
  task.runtime.lastUpdated = now();
  transition(task, 'cancelled');
  recordMutation(task, 'proposal_rejected', { proposalId: task.proposalId || taskId });
  return publicTask(task);
}
async function authorizeMutation(
  task,
  authorize,
  operation,
  paths,
  { rollback = false, deleteConfirmationRequired = operation === 'delete' || operation === 'delete_directory' } = {},
) {
  if (typeof authorize !== 'function') throw new Error('The authoritative file mutation policy is unavailable.');
  const requestContext = assertTaskAuthorization(task);
  if (!task.approval || task.approval.manifestHash !== proposalManifestHash(task)) {
    throw new Error('The approved proposal no longer matches its request-bound authorization manifest.');
  }
  const targets = [...new Set(paths)];
  const requiredFeatures = featuresForChanges(targets.map((targetPath) => ({ path: targetPath })));
  const authorizedFeatures = task.approval.authorizedFeatures;
  if (!Array.isArray(authorizedFeatures)
    || requiredFeatures.some((feature) => !authorizedFeatures.includes(feature))) {
    throw new Error('Mutation target exceeds the explicitly authorized feature scope.');
  }
  const result = await authorize({
    taskId: task.taskId,
    operation,
    paths: targets,
    proposalApproved: Boolean(task.approval),
    deleteConfirmationRequired,
    rollback,
    requestBinding: {
      taskId: requestContext.taskId,
      turnId: requestContext.turnId,
      requestHash: requestContext.requestHash,
      root: requestContext.root,
      scope: requestContext.scope,
      authorizedFeatures: [...authorizedFeatures],
    },
  });
  if (!result || result.allowed !== true) {
    task.evidence = [...(task.evidence || []), {
      kind: 'POLICY_GATE',
      operation,
      paths: targets,
      decision: 'BLOCK',
      reason: result?.reason || 'Policy Gate unavailable or denied.',
      at: now(),
    }].slice(-50);
    recordMutation(task, 'policy_gate_denied', { operation, paths: targets, reason: result?.reason || 'Policy Gate unavailable or denied.' });
    throw new Error(result?.reason || 'The authoritative file mutation policy denied or could not authorize this operation.');
  }
  task.evidence = [...(task.evidence || []), {
    kind: 'POLICY_GATE',
    operation,
    paths: targets,
    decision: 'ALLOW',
    at: now(),
  }].slice(-50);
  recordMutation(task, 'policy_gate_allowed', { operation, paths: targets });
}
async function writeContentAtomically(
  task,
  relative,
  content,
  authorize,
  operation,
  expectedSnapshot = null,
  { rollback = false } = {},
) {
  if (!task || typeof authorize !== 'function') {
    throw new Error('The authoritative file mutation policy is unavailable.');
  }
  if (task.operatingMode === 'AUDIT' || task.authorizationContext?.operatingMode === 'AUDIT') {
    throw new Error('Operation denied: cannot write files in read-only AUDIT mode.');
  }
  const safe = await safePath(task.root, relative, { allowMissing: true });
  if (!safe.parentExists) throw new Error('Mutation target parent no longer exists.');
  const initialSnapshot = await snapshotTarget(task.root, relative);
  if (expectedSnapshot && initialSnapshot.hash !== expectedSnapshot.hash) {
    throw new Error('File changed while mutation approval was pending.');
  }
  await authorizeMutation(task, authorize, operation, [relative], { rollback });
  if ((await snapshotTarget(task.root, relative)).hash !== initialSnapshot.hash) {
    throw new Error('File changed while mutation approval was pending.');
  }
  const temp = `${safe.target}.developer-${task.taskId}.tmp`;
  let handle;
  let createdTemp = false;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    createdTemp = true;
    await handle.writeFile(content, typeof content === 'string' ? 'utf8' : undefined);
    await handle.close();
    handle = null;
    if ((await snapshotTarget(task.root, relative)).hash !== initialSnapshot.hash) {
      throw new Error('File changed during mutation; stale diff rejected.');
    }
    await renameWithRetry(temp, safe.target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (createdTemp) await fs.rm(temp, { force: true });
  }
}
async function applyChanges(task, authorize) {
  if (task.operatingMode === 'AUDIT' || task.authorizationContext?.operatingMode === 'AUDIT') {
    throw new Error('Operation denied: cannot apply changes in read-only AUDIT mode.');
  }
  for (const change of task.files) {
    const operation = change.operation || 'modify';
    if (operation === 'delete' || operation === 'delete_directory') continue;
    const paths = change.sourcePath ? [change.sourcePath, change.path] : [change.path];
    await authorizeMutation(task, authorize, operation, paths);
  }
  if (task.cancelRequested) throw Object.assign(new Error('Developer task was cancelled before file mutation.'), { cancelled: true });
  const current = await Promise.all(task.before.map((item) => snapshotTarget(task.root, item.path)));
  if (current.some((item, index) => item.hash !== task.before[index].hash)) {
    throw new Error('Files changed while mutation approval was pending.');
  }
  for (const change of task.files) {
    const sourcePath = change.sourcePath || change.path;
    if (change.operation === 'delete' || change.operation === 'delete_directory') {
      const safe = await safePath(task.root, change.path, { allowDirectory: change.operation === 'delete_directory' });
      const expectedSnapshot = task.before.find((item) => samePath(item.path, change.path));
      if (!expectedSnapshot) throw new Error(`Mutation snapshot is missing for ${change.path}.`);
      await authorizeMutation(task, authorize, change.operation, [change.path]);
      if ((await snapshotTarget(task.root, change.path)).hash !== expectedSnapshot.hash) {
        throw new Error('File changed while deletion approval was pending.');
      }
      const confirmedTarget = await safePath(task.root, change.path, {
        allowDirectory: change.operation === 'delete_directory',
      });
      await fs.rm(confirmedTarget.target, { recursive: change.operation === 'delete_directory', force: false });
    } else if (change.operation === 'rename') {
      const targetSnapshot = task.before.find((item) => samePath(item.path, change.path));
      if (!targetSnapshot) throw new Error(`Mutation snapshot is missing for ${change.path}.`);
      await writeContentAtomically(task, change.path, change.content, authorize, 'rename', targetSnapshot);
      const source = await safePath(task.root, sourcePath);
      const sourceSnapshot = task.before.find((item) => samePath(item.path, sourcePath));
      if (!sourceSnapshot) throw new Error(`Rename source snapshot is missing for ${sourcePath}.`);
      if ((await snapshotTarget(task.root, sourcePath)).hash !== sourceSnapshot.hash) {
        throw new Error('File changed during mutation; stale diff rejected.');
      }
      await authorizeMutation(task, authorize, 'delete', [sourcePath], {
        deleteConfirmationRequired: true,
      });
      if ((await snapshotTarget(task.root, sourcePath)).hash !== sourceSnapshot.hash) {
        throw new Error('Rename source changed while deletion approval was pending.');
      }
      const confirmedSource = await safePath(task.root, sourcePath);
      await fs.rm(confirmedSource.target);
    } else {
      const expectedSnapshot = task.before.find((item) => samePath(item.path, change.path));
      if (!expectedSnapshot) throw new Error(`Mutation snapshot is missing for ${change.path}.`);
      await writeContentAtomically(task, change.path, change.content, authorize, change.operation || 'modify', expectedSnapshot);
    }
  }
  const resulting = await Promise.all(task.after.map((item) => snapshotTarget(task.root, item.path)));
  if (resulting.some((item, index) => item.hash !== task.after[index].hash)) throw new Error('Post-apply verification failed.');
}
async function restoreSnapshot(task, snapshotState, authorize, { rollback = false, expectedCurrentSnapshot } = {}) {
  const safe = await safePath(task.root, snapshotState.path, { allowMissing: true, allowDirectory: true });
  const current = await snapshotTarget(task.root, snapshotState.path);
  if (expectedCurrentSnapshot && current.hash !== expectedCurrentSnapshot.hash) {
    throw new Error('Rollback target changed while recovery approval was pending.');
  }
  if (!snapshotState.exists) {
    if (safe.exists) {
      const operation = current.type === 'directory' ? 'delete_directory' : 'delete';
      await authorizeMutation(task, authorize, operation, [snapshotState.path], {
        rollback,
        deleteConfirmationRequired: true,
      });
      if ((await snapshotTarget(task.root, snapshotState.path)).hash !== current.hash) {
        throw new Error('Rollback deletion target changed after confirmation.');
      }
      const confirmedTarget = await safePath(task.root, snapshotState.path, { allowDirectory: current.type === 'directory' });
      await fs.rm(confirmedTarget.target, { recursive: current.type === 'directory', force: false });
    }
    return;
  }
  if (snapshotState.type === 'directory') {
    if (safe.exists) {
      await authorizeMutation(task, authorize, 'delete_directory', [snapshotState.path], {
        rollback,
        deleteConfirmationRequired: true,
      });
      if ((await snapshotTarget(task.root, snapshotState.path)).hash !== current.hash) {
        throw new Error('Rollback directory changed after deletion confirmation.');
      }
      const confirmedTarget = await safePath(task.root, snapshotState.path, { allowDirectory: true });
      await fs.rm(confirmedTarget.target, { recursive: true, force: false });
    }
    await authorizeMutation(task, authorize, 'undo', [snapshotState.path], { rollback });
    const creationTarget = await safePath(task.root, snapshotState.path, { allowMissing: true, allowDirectory: true });
    if (creationTarget.exists) throw new Error('Rollback directory target reappeared after authorization.');
    await fs.mkdir(creationTarget.target, { recursive: true });
    for (const entry of snapshotState.entries) {
      const entryPath = `${snapshotState.path}/${entry.path}`;
      const child = await safePath(task.root, entryPath, { allowMissing: true });
      if (entry.type === 'directory') {
        await authorizeMutation(task, authorize, 'undo', [entryPath], { rollback });
        await fs.mkdir(child.target, { recursive: true });
      } else {
        await writeContentAtomically(
          task,
          entryPath,
          Buffer.from(entry.contentBase64, 'base64'),
          authorize,
          'undo',
          null,
          { rollback },
        );
      }
    }
  } else {
    await writeContentAtomically(
      task,
      snapshotState.path,
      snapshotState.content,
      authorize,
      'undo',
      current,
      { rollback },
    );
  }
}
async function restoreBeforeSnapshot(task, authorize, { rollback = false } = {}) {
  for (const item of task.before) {
    const current = await snapshotTarget(task.root, item.path);
    if (current.hash === item.hash) continue;
    await restoreSnapshot(task, item, authorize, {
      rollback,
      expectedCurrentSnapshot: current,
    });
  }
  const restored = await Promise.all(task.before.map((item) => snapshotTarget(task.root, item.path)));
  if (restored.some((item, index) => item.hash !== task.before[index].hash)) throw new Error('Rollback verification failed.');
}

async function verifyDelegatedWorkItems(task, attemptId) {
  const plan = task.taskPlan;
  if (!plan || plan.schemaVersion !== 2 || !Array.isArray(plan.workItems)) return;
  const context = {
    sessionId: task.sessionId,
    projectRoot: task.root,
    proposalId: task.proposalId,
    scope: task.scope || '.',
    attemptId,
    completedEvidence: [
      'APPROVED_SCOPE_PROPOSAL',
      'EXPLICIT_APPROVAL',
      'VERIFICATION_PASS',
      'PRESERVATION_AUDIT',
    ],
  };
  for (const item of plan.workItems) {
    if (item.status === 'COMPLETED' || item.status === 'SKIPPED') continue;
    const dependenciesSatisfied = (item.dependsOn || []).every((dependencyId) => (
      plan.workItems.find((candidate) => candidate.id === dependencyId)?.status === 'COMPLETED'
    ));
    const evidence = [];
    for (const criterion of item.verificationCriteria || []) {
      if (criterion.type !== 'FILE_SHA256') continue;
      const approvedTarget = task.after.find((entry) => samePath(entry.path, criterion.path));
      const proposedTarget = task.files.find((entry) => samePath(entry.path, criterion.path));
      if (!approvedTarget || !proposedTarget || !approvedTarget.exists
        || approvedTarget.hash !== criterion.sha256
        || !inside(task.root, path.resolve(task.root, ...criterion.path.replace(/\\/g, '/').split('/')))) {
        continue;
      }
      const observed = await snapshotTarget(task.root, criterion.path);
      const issued = issueHostFileObservation({
        plan,
        item,
        context,
        criterion,
        observed: { path: criterion.path, sha256: observed.hash, exists: observed.exists },
      });
      if (issued) evidence.push(issued);
    }
    const result = verifyWorkItemEvidence({
      plan,
      itemId: item.id,
      context,
      evidence,
      verificationPassed: task.verification?.ok === true,
      dependenciesSatisfied,
    });
    item.verificationResult = result;
    if (result.status === 'SATISFIED') {
      if (item.status === 'DELEGATED') {
        advanceTaskPlan(plan, { workItemId: item.id, status: 'IN_PROGRESS' });
      }
      advanceTaskPlan(plan, {
        workItemId: item.id,
        status: 'COMPLETED',
        evidence: result,
      });
    }
  }
}

async function apply(taskId, owner, verifyRunner, expectedRoot = null, authorize = null, verificationAttempt = 1, onActivity = () => {}) {
  const task = getTask(taskId, owner);
  if (task.operatingMode === 'AUDIT' || task.authorizationContext?.operatingMode === 'AUDIT') {
    throw new Error('Operation denied: cannot apply changes in read-only AUDIT mode.');
  }
  if (task.approval?.consumedAt) throw new Error('Proposal approval has already been used.');
  if (task.state !== 'approved') throw new Error('Proposal must be approved exactly once.');
  if (!task.approval) throw new Error('Proposal approval is missing.');
  if (expectedRoot && !samePath(await fs.realpath(expectedRoot), task.root)) throw new Error('The selected project changed after this proposal was created.');
  const release = await acquireLock(task.conversationTurnId);
  if (task.approval?.consumedAt) {
    release();
    throw new Error('Proposal approval has already been used.');
  }
  task.approval.consumedAt = now();
  recordMutation(task, 'proposal_approval_consumed', { proposalId: task.proposalId });
  if (task.approval.proposalId !== task.proposalId) {
    release();
    throw new Error('Proposal approval does not match this proposal.');
  }
  const approvalExpiry = Date.parse(task.approval.expiresAt);
  if (!Number.isFinite(approvalExpiry) || approvalExpiry <= Date.now()) {
    release();
    throw new Error('Proposal approval has expired.');
  }
  if (task.approval.manifestHash !== proposalManifestHash(task)) {
    release();
    throw new Error('Proposal manifest changed after approval.');
  }
  task.transactionId = crypto.randomUUID();
  let patchApplied = false;
  let writeStarted = false;
  let applyStarted = false;
  let applyTerminal = false;
  let verificationTerminal = false;
  const notifyActivity = (phase, status, details = {}) => {
    try {
      onActivity({ phase, status, ...details });
    } catch {
      console.warn('Could not publish Developer activity event.');
    }
  };
  recordMutation(task, 'transaction_started', { transactionId: task.transactionId });
  notifyActivity('proposal_transaction', 'STARTED');
  try {
    await multiRepoCoordinator.captureBaselineSnapshot(task.taskId, task.root);
    transition(task, 'applying');
    task.runtime = task.runtime || {};
    task.runtime.phase = 'APPLYING';
    task.runtime.taskState = 'APPLYING';
    task.runtime.history = [...(task.runtime.history || []), { phase: 'APPLYING', at: now(), message: 'Applying validated patch.' }].slice(-developerSettings.maxStateHistoryEntries);
    task.runtime.lastUpdated = now();
    progress(task, 'apply', 'Applying validated patch.');
    applyStarted = true;
    notifyActivity('proposal_apply', 'STARTED');
    const current = await Promise.all(task.before.map((item) => snapshotTarget(task.root, item.path)));
    if (current.some((item, index) => item.hash !== task.before[index].hash)) throw new Error('Files changed after approval.');
    if (task.cancelRequested) {
      transition(task, 'cancelled');
      applyTerminal = true;
      notifyActivity('proposal_apply', 'CANCELLED', { executed: false });
      notifyActivity('proposal_transaction', 'CANCELLED', { executed: false });
      return publicTask(task);
    }
    writeStarted = true;
    await applyChanges(task, authorize);
    patchApplied = true;
    applyTerminal = true;
    notifyActivity('proposal_apply', 'COMPLETED', { executed: true });
    if (task.cancelRequested) throw Object.assign(new Error('Developer task was cancelled before verification.'), { cancelled: true });
    transition(task, 'verifying');
    task.runtime = task.runtime || {};
    task.runtime.phase = 'VERIFYING';
    task.runtime.taskState = 'VERIFYING';
    task.runtime.history = [...(task.runtime.history || []), { phase: 'VERIFYING', at: now(), message: 'Running approved verification.' }].slice(-developerSettings.maxStateHistoryEntries);
    task.runtime.lastUpdated = now();
    progress(task, 'verify', 'Running approved verification.');
    notifyActivity('verification', 'STARTED');
    {
      let result;
      try {
        result = verifyRunner
          ? await verifyRunner()
          : {
            ok: false,
            status: 'UNVERIFIED',
            executed: false,
            exitCode: null,
            reason: 'No verification runner was provided.',
            attempts: [],
          };
      } catch (error) {
        result = verificationFailureFromError(error);
      }
      const verificationAttempts = Array.isArray(result?.attempts) ? result.attempts : [];
      const verificationPassed = isSuccessfulVerificationResult(result, verificationAttempts);
      const reportedVerificationStatus = normalizeVerificationStatus(result, verificationPassed) || 'UNVERIFIED';
      task.verification = verificationSnapshot(result, reportedVerificationStatus, verificationAttempts, verificationPassed);
      const verificationStatus = verificationPassed
        ? 'COMPLETED'
        : ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(reportedVerificationStatus)
          ? reportedVerificationStatus
          : result?.skipped === true
          ? 'SKIPPED'
          : result?.cancelled === true
            ? 'CANCELLED'
            : result?.executed === true && Number.isInteger(result.exitCode)
              ? 'FAILED'
              : 'UNVERIFIED';
      verificationTerminal = true;
      notifyActivity('verification', verificationStatus, {
        executed: result?.executed === true,
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
        evidenceState: ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(result?.evidenceState)
          ? result.evidenceState
          : undefined,
      });
      task.evidence = [...(task.evidence || []), {
        kind: 'VERIFICATION',
        status: reportedVerificationStatus,
        evidenceState: ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(result?.evidenceState)
          ? result.evidenceState
          : null,
        checks: verificationAttempts.map((attempt) => ({
          check: attempt?.check || attempt?.script || null,
          ok: isSuccessfulVerificationAttempt(attempt),
          classification: attempt?.classification || null,
          extracted: attempt?.extracted || null,
        })),
        at: now(),
      }].slice(-50);
      if (!result?.ok && result?.status === 'CODE_FAILURE') {
        const failedChecks = verificationAttempts.filter((attempt) => !isSuccessfulVerificationAttempt(attempt));
        task.evidence = [...task.evidence, {
          kind: 'DIAGNOSIS',
          status: result.classification || result.status,
          checks: failedChecks.map((attempt) => ({
            check: attempt?.check || attempt?.script || null,
            ok: false,
            classification: attempt?.classification || result.classification || null,
            extracted: attempt?.extracted || null,
          })),
          at: now(),
        }].slice(-50);
        recordMutation(task, 'verification_diagnosed', {
          transactionId: task.transactionId,
          classification: result.classification || result.status,
          checks: failedChecks.map((attempt) => ({
            check: attempt?.check || attempt?.script || null,
            classification: attempt?.classification || result.classification || null,
            file: attempt?.extracted?.file || null,
            line: attempt?.extracted?.line || null,
          })),
        });
      }
      task.runtime.metrics = {
        ...(task.runtime.metrics || {}),
        verificationRuns: Number(task.runtime.metrics?.verificationRuns || 0) + verificationAttempts.length,
      };
      recordMutation(task, 'verification_recorded', {
        transactionId: task.transactionId, attempt: verificationAttempt,
        result: reportedVerificationStatus,
        evidenceState: ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(result?.evidenceState)
          ? result.evidenceState
          : null,
        checks: verificationAttempts.map((attempt) => ({
          check: attempt?.check || attempt?.script || null,
          ok: isSuccessfulVerificationAttempt(attempt),
          classification: attempt?.classification || null,
        })),
      });
      if (task.cancelRequested || result?.cancelled) {
        throw Object.assign(new Error('Developer task was cancelled during verification.'), { cancelled: true });
      }
      if (!verificationPassed) {
        const failureState = reportedVerificationStatus;
        task.verification = { ...task.verification, status: failureState, ok: false };
        throw new Error(
          failureState === 'UNVERIFIED'
            ? 'Verification did not produce an executed passing result with exit code 0.'
            : `Verification failed (${result.failure || 'verification'}).`,
        );
      }
    }
    await verifyDelegatedWorkItems(task, crypto.randomUUID());
    if (task.state !== 'completed') transition(task, 'completed');
    task.runtime = task.runtime || {};
    task.runtime.phase = 'COMPLETED';
    task.runtime.taskState = 'COMPLETED';
    task.runtime.metrics = { ...(task.runtime.metrics || {}), confidence: 'HIGH' };
    task.runtime.history = [...(task.runtime.history || []), { phase: 'COMPLETED', at: now(), message: 'Apply and verification completed.' }].slice(-developerSettings.maxStateHistoryEntries);
    task.runtime.lastUpdated = now();
    progress(task, 'complete', 'Apply and verification completed.');
    notifyActivity('proposal_transaction', 'COMPLETED', { executed: true });
    try {
      artifactEngine.createArtifact({
        taskId: task.taskId,
        type: ARTIFACT_TYPES.TEST_REPORT,
        content: task.verification || { status: 'PASS' },
        phase: 'completed',
      });
      artifactEngine.createArtifact({
        taskId: task.taskId,
        type: ARTIFACT_TYPES.FINAL_SUMMARY,
        content: {
          taskId: task.taskId,
          root: task.root,
          files: task.files.map((f) => f.path),
          verification: task.verification,
          completedAt: now(),
        },
        phase: 'completed',
      });
      task.artifacts = artifactEngine.getArtifacts(task.taskId);
    } catch {}
    return publicTask(task);
  } catch (error) {
    task.error = error.message;
    if (!applyTerminal && applyStarted) {
      applyTerminal = true;
      notifyActivity(
        'proposal_apply',
        error.cancelled ? 'CANCELLED' : 'FAILED',
        patchApplied ? { executed: true } : {},
      );
    }
    if (!verificationTerminal && task.state === 'verifying') {
      verificationTerminal = true;
      notifyActivity('verification', error.cancelled ? 'CANCELLED' : 'UNVERIFIED', {
        executed: false,
        exitCode: null,
      });
    }
    if (patchApplied || writeStarted || task.state === 'verifying') {
      invalidateCompletedWorkItems(task.taskPlan, 'Proposal rollback invalidated item-specific observations.');
      if (task.state !== 'recovering') transition(task, 'recovering');
      progress(task, 'recover', 'Apply failed; verifying rollback state.');
      notifyActivity('rollback', 'STARTED');
      try {
        await restoreBeforeSnapshot(task, authorize, { rollback: true });
        notifyActivity('rollback', 'COMPLETED', { executed: true });
      } catch (rollbackError) {
        task.error = `Rollback verification failed: ${rollbackError.message}`;
        notifyActivity('rollback', 'FAILED', { executed: true });
      }
    }
    const terminalState = error.cancelled ? 'cancelled' : 'failed';
    if (task.state !== terminalState) transition(task, terminalState);
    task.runtime = task.runtime || {};
    task.runtime.phase = terminalState.toUpperCase();
    task.runtime.taskState = terminalState.toUpperCase();
    task.runtime.history = [
      ...(task.runtime.history || []),
      {
        phase: terminalState.toUpperCase(),
        at: now(),
        message: String(task.error || '').startsWith('Rollback verification failed:')
          ? 'Apply failed and rollback verification is incomplete.'
          : error.message,
      },
    ].slice(-developerSettings.maxStateHistoryEntries);
    task.runtime.lastUpdated = now();
    task.updatedAt = now();
    recordMutation(task, 'transaction_failed', { transactionId: task.transactionId, error: error.message });
    notifyActivity(
      'proposal_transaction',
      task.state === 'cancelled'
        ? 'CANCELLED'
        : task.state === 'failed'
          ? 'FAILED'
          : 'UNVERIFIED',
      {});
    error.taskSnapshot = publicTask(task);
    throw error;
  } finally { release(); }
}
async function undo(taskId, owner, authorize, explicitlyApproved = false) {
  const task = getTask(taskId, owner);
  if (task.state !== 'completed') throw new Error('Only a completed proposal can be undone.');
  if (!explicitlyApproved) throw new Error('Undo requires a separate explicit user approval.');
  if (typeof authorize !== 'function') throw new Error('The authoritative file mutation policy is unavailable.');
  const release = await acquireLock(task.conversationTurnId);
  task.transactionId = crypto.randomUUID();
  recordMutation(task, 'undo_started', { transactionId: task.transactionId });
  try {
    const current = await Promise.all(task.after.map((item) => snapshotTarget(task.root, item.path)));
    if (current.some((item, index) => item.hash !== task.after[index].hash)) throw new Error('Undo refused: files changed after apply.');
    await restoreBeforeSnapshot(task, authorize);
    invalidateCompletedWorkItems(task.taskPlan, 'Approved proposal undo invalidated item-specific observations.');
    transition(task, 'undone'); progress(task, 'undo', 'Undo completed and verified.'); recordMutation(task, 'undo_completed', { transactionId: task.transactionId }); return publicTask(task);
  } finally { release(); }
}
function classifyFailure(result) {
  if (result?.cancelled) return 'cancelled';
  if (result?.timedOut) return 'timeout'; if (result?.error) return 'spawn';
  if (/permission|access denied/i.test(`${result?.stderr || ''}`)) return 'permission';
  if (/not found|missing|undefined/i.test(`${result?.stderr || ''}`)) return 'missing_dependency';
  if (/syntax|type error|compile/i.test(`${result?.stderr || ''}`)) return 'compile';
  return result?.exitCode === 0 ? 'success' : (Number.isInteger(result?.exitCode) ? 'exit' : 'verification');
}
function classifyFailureCategory(result) {
  if (result?.cancelled) return 'CANCELLED';
  if (result?.timedOut) return 'TIMEOUT';
  const text = `${result?.stderr || ''}\n${result?.stdout || ''}\n${result?.error || ''}`;
  if (/provider|quota|rate.?limit|429|503|high demand|service unavailable/i.test(text)) return 'PROVIDER_FAILURE';
  if (result?.spawnError || result?.error) {
    return /not found|enoent|cannot find/i.test(text) ? 'COMMAND_NOT_AVAILABLE' : 'ENVIRONMENT_FAILURE';
  }
  if (/module not found|cannot find module|dependency|package.*missing/i.test(text)) return 'DEPENDENCY_FAILURE';
  if (/permission|access denied|eacces/i.test(text)) return 'ENVIRONMENT_FAILURE';
  if (/syntax|type error|compile|ts\d{3,4}|failed|failure/i.test(text) || Number.isInteger(result?.exitCode)) return 'CODE_FAILURE';
  return result?.ok ? null : 'ENVIRONMENT_FAILURE';
}
function isOptionalBoolean(value) {
  return value === undefined || value === null || typeof value === 'boolean';
}
function normalizeVerificationStatus(result, passed) {
  if (GATE_FAILURE_STATUSES.has(result?.status)) return result.status;
  if (result?.executionBlocked === true) return 'BLOCKED';
  if (GATE_FAILURE_STATUSES.has(result?.evidenceState)) return result.evidenceState;
  if (VERIFICATION_FAILURE_STATUSES.has(result?.status)) return result.status;
  if (result?.skipped === true) return 'SKIPPED';
  if (passed) return 'PASS';
  if (result?.status !== undefined) return 'UNVERIFIED';
  if (result?.error || result?.spawnError === true) return undefined;
  if (result?.executed === true && Number.isInteger(result.exitCode) && result.exitCode !== 0) return undefined;
  return 'UNVERIFIED';
}
function isSuccessfulVerificationAttempt(attempt) {
  return Boolean(attempt)
    && typeof attempt === 'object'
    && !Array.isArray(attempt)
    && attempt.ok === true
    && attempt.executed === true
    && attempt.exitCode === 0
    && (typeof attempt.check === 'string' && attempt.check.trim()
      || typeof attempt.script === 'string' && attempt.script.trim())
    && (attempt.status === undefined || attempt.status === 'PASS')
    && isOptionalBoolean(attempt.skipped)
    && attempt.skipped !== true
    && isOptionalBoolean(attempt.success)
    && attempt.success !== false
    && isOptionalBoolean(attempt.executionBlocked)
    && attempt.executionBlocked !== true
    && (attempt.evidenceState === undefined || attempt.evidenceState === null)
    && isOptionalBoolean(attempt.cancelled)
    && attempt.cancelled !== true
    && isOptionalBoolean(attempt.timedOut)
    && attempt.timedOut !== true
    && !attempt.error
    && !attempt.failure;
}
function isSuccessfulVerificationResult(result, attempts) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.ok !== true
    || result.status !== 'PASS'
    || result.executed !== true
    || result.exitCode !== 0
    || !isOptionalBoolean(result.skipped)
    || result.skipped === true
    || !isOptionalBoolean(result.success)
    || result.success === false
    || !isOptionalBoolean(result.executionBlocked)
    || result.executionBlocked === true
    || (result.evidenceState !== undefined && result.evidenceState !== null)
    || !isOptionalBoolean(result.cancelled)
    || result.cancelled === true
    || !isOptionalBoolean(result.timedOut)
    || result.timedOut === true
    || result.error
    || result.failure
    || !Array.isArray(attempts)
    || attempts.length === 0
    || !attempts.every(isSuccessfulVerificationAttempt)) return false;
  if (result.checks !== undefined) {
    if (!Array.isArray(result.checks) || result.checks.length !== attempts.length) return false;
    if (result.checks.some((check, index) => (
      typeof check !== 'string'
      || check !== (attempts[index].check || attempts[index].script)
    ))) return false;
  }
  return true;
}
function sanitizeVerificationSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attempts = Array.isArray(value.attempts) ? value.attempts.map((attempt) => ({
    check: typeof attempt?.check === 'string' ? redact(attempt.check) : null,
    script: typeof attempt?.script === 'string' ? redact(attempt.script) : null,
    ok: isSuccessfulVerificationAttempt(attempt),
    executed: attempt?.executed === true,
    exitCode: Number.isInteger(attempt?.exitCode) ? attempt.exitCode : null,
    classification: typeof attempt?.classification === 'string' ? redact(attempt.classification) : null,
    stderr: typeof attempt?.stderr === 'string' ? redact(attempt.stderr) : (attempt?.extracted?.message ? redact(attempt.extracted.message) : null),
    stdout: typeof attempt?.stdout === 'string' ? redact(attempt.stdout) : null,
    extracted: attempt?.extracted && typeof attempt.extracted === 'object'
      ? redact(attempt.extracted)
      : null,
  })) : [];
  const checks = Array.isArray(value.checks)
    ? value.checks.filter((check) => typeof check === 'string').map(redact)
    : attempts.map((attempt) => attempt.check || attempt.script).filter(Boolean);
  const evidenceState = NON_PASS_EVIDENCE_STATES.has(value.evidenceState) ? value.evidenceState : null;
  const passed = value.ok === true
    && value.status === 'PASS'
    && value.executed === true
    && value.exitCode === 0
    && isSuccessfulVerificationResult(value, value.attempts);
  const status = normalizeVerificationStatus(value, passed) || 'UNVERIFIED';
  return {
    status,
    ok: passed,
    executed: value.executed === true,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    reason: typeof value.reason === 'string'
      ? redact(value.reason)
      : typeof value.error === 'string' ? redact(value.error) : null,
    failure: typeof value.failure === 'string' ? redact(value.failure) : null,
    classification: typeof value.classification === 'string' ? redact(value.classification) : null,
    evidenceState,
    attempts,
    checks,
  };
}
function verificationSnapshot(result, status, attempts, passed) {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  return sanitizeVerificationSnapshot({
    ...source,
    status,
    ok: passed,
    attempts,
    checks: Array.isArray(source.checks) ? source.checks : undefined,
  });
}
function normalizeCommandResult(result) {
  const hasRecord = Boolean(result) && typeof result === 'object' && !Array.isArray(result);
  const statusKnown = !hasRecord
    || typeof result.status !== 'string'
    || result.status === 'PASS'
    || VERIFICATION_FAILURE_STATUSES.has(result.status);
  const ok = hasRecord
    && result.ok === true
    && result.executed === true
    && result.exitCode === 0
    && statusKnown
    && (result.status === undefined || result.status === 'PASS')
    && isOptionalBoolean(result.skipped)
    && result.skipped !== true
    && isOptionalBoolean(result.success)
    && result.success !== false
    && isOptionalBoolean(result.executionBlocked)
    && result.executionBlocked !== true
    && (result.evidenceState === undefined || result.evidenceState === null)
    && isOptionalBoolean(result.cancelled)
    && result.cancelled !== true
    && isOptionalBoolean(result.timedOut)
    && result.timedOut !== true
    && !result.error
    && !result.failure;
  return { ok, script: String(result?.script || ''), exitCode: result?.exitCode ?? null,
    stdout: String(result?.stdout || ''), stderr: String(result?.stderr || ''), durationMs: Number(result?.durationMs || 0),
    reason: result?.reason ? String(result.reason).slice(0, 500) : null,
    failure: ok ? null : classifyFailure({ ...result, ok: false }),
    classification: ok ? null : classifyFailureCategory({ ...result, ok: false }),
    cancelled: Boolean(result?.cancelled),
    executed: result?.executed === true,
    status: normalizeVerificationStatus(result, ok),
    evidenceState: NON_PASS_EVIDENCE_STATES.has(result?.evidenceState) ? result.evidenceState : undefined,
    executionBlocked: result?.executionBlocked === true,
    runtimeEvidence: result?.runtimeEvidence || null,
  };
}
function commandPolicy(script) {
  const allowed = new Set([
    'lint', 'typecheck', 'test', 'build', 'check', 'validate', 'verify', 'phpunit', 'composer-test', 'php-lint',
    'maven-test', 'maven-build', 'gradle-test', 'gradle-build', 'go-test', 'go-vet', 'go-build', 'ruby-test', 'ruby-lint',
    'dotnet-test', 'dotnet-build', 'cargo-test', 'cargo-clippy', 'cargo-build', 'python-test', 'python-lint',
    'vitest', 'jest', 'pytest', 'format:check', 'test:unit', 'test:e2e',
  ]);
  if (typeof script !== 'string' || !allowed.has(script)) throw new Error('Verification command is not permitted.');
  return { script, approvalRequired: true, arbitraryShell: false };
}
async function executeVerificationLoop({ run, maxAttempts = 2, diagnose = () => null, onProgress = () => {} }) {
  if (typeof run !== 'function') throw new Error('Verification runner is required.');
  const attempts = Math.max(1, Math.min(2, Number(maxAttempts) || 1));
  const observations = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    onProgress({ phase: 'verify', attempt });
    let rawResult;
    try {
      rawResult = await run(attempt);
    } catch (error) {
      rawResult = verificationFailureFromError(error);
    }
    const result = normalizeCommandResult(rawResult);
    observations.push(result);
    if (result.ok) return { ok: true, status: 'PASS', executed: true, exitCode: 0, attempts: observations };
    if (isGateOrUnverifiedResult(result)) {
      return {
        ok: false,
        status: result.status || result.evidenceState || 'UNVERIFIED',
        evidenceState: result.evidenceState,
        attempts: observations,
        reason: result.reason,
      };
    }
    const diagnosis = diagnose(result);
    if (attempt < attempts && diagnosis?.retryable) {
      onProgress({ phase: 'recover', attempt, diagnosis });
      continue;
    }
    return { ok: false, attempts: observations, diagnosis: diagnosis || { kind: result.failure } };
  }
  return { ok: false, attempts: observations };
}
function selectVerificationChecks(packageJson, requested = []) {
  const scripts = packageJson?.scripts || packageJson?.packageScripts || {};
  const names = Array.isArray(requested) && requested.length ? requested : ['test', 'typecheck', 'lint'];
  const matched = [...new Set(names)].filter((name) => {
    try { commandPolicy(name); } catch { return false; }
    return typeof scripts[name] === 'string' && scripts[name].trim();
  });
  if (matched.length > 0) return matched;
  if (packageJson?.hasPhpUnitConfig || packageJson?.frameworks?.includes('yii2')) {
    return ['phpunit'].filter((cmd) => { try { commandPolicy(cmd); return true; } catch { return false; } });
  }
  if (packageJson?.frameworks?.includes('django') || packageJson?.languages?.includes('python')) {
    return ['python-test'].filter((cmd) => { try { commandPolicy(cmd); return true; } catch { return false; } });
  }
  if (packageJson?.languages?.includes('go')) {
    return ['go-test'].filter((cmd) => { try { commandPolicy(cmd); return true; } catch { return false; } });
  }
  if (packageJson?.languages?.includes('rust')) {
    return ['cargo-test'].filter((cmd) => { try { commandPolicy(cmd); return true; } catch { return false; } });
  }
  return [];
}
function extractFailure(result) {
  const text = `${result?.stderr || ''}\n${result?.stdout || ''}\n${result?.error || ''}`;

  // Ecosystem-specific pattern matching
  const tsMatch = text.match(/(?:^|\s)([a-zA-Z0-9_./\\-]+\.(?:ts|tsx|js|jsx)):(\d+)(?::(\d+))?\s*(?:-\s*error\s*(TS\d+)?:?\s*(.+))?/i);
  const pyMatch = text.match(/File "([^"]+\.py)", line (\d+)(?:, in (\w+))?\s*(?:\r?\n\s*(?:[^\n]+\r?\n\s*)?([A-Za-z0-9_]+Error:\s*.+))?/i)
    || text.match(/FAILED\s+([a-zA-Z0-9_./\\-]+\.py)::(\w+)\s*-\s*(.+)/i);
  const phpMatch = text.match(/(?:in|on line)\s+([a-zA-Z0-9_./\\-]+\.php)(?::|\s+on\s+line\s+)(\d+)/i)
    || text.match(/([a-zA-Z0-9_./\\-]+\.php):(\d+)/i);
  const testMatch = text.match(/●\s+([^\r\n]+)/i)
    || text.match(/(?:FAIL|failed|failing)\s+test\s+["'`]?([^"'`\r\n]+)["'`]?/i)
    || text.match(/(?:FAIL|failed|failing)\s+["'`]?([^"'`\r\n]+)["'`]?/i);

  const location = text.match(/(?:^|\s)([^ \r\n:]+\.[a-zA-Z0-9]{1,6}):(\d+)(?::(\d+))?(?:\s|$)/)
    || text.match(/(?:^|\s)((?:[a-zA-Z0-9_.-]+[/\\])+[a-zA-Z0-9_.-]+):(\d+)(?::(\d+))?(?:\s|$)/);

  const candidateFile = tsMatch?.[1] || pyMatch?.[1] || phpMatch?.[1] || location?.[1] || null;
  const isKeyword = !candidateFile
    || /^(?:error|warning|info|failed|status|exit|code|time|line|col)$/i.test(candidateFile)
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidateFile)
    || /\.\d+$/.test(candidateFile);
  const file = isKeyword ? null : candidateFile;
  const line = file ? (tsMatch?.[2] ? Number(tsMatch[2]) : (pyMatch?.[2] ? Number(pyMatch[2]) : (phpMatch?.[2] ? Number(phpMatch[2]) : (location ? Number(location[2]) : null)))) : null;
  const column = file ? (tsMatch?.[3] ? Number(tsMatch[3]) : (location?.[3] ? Number(location[3]) : null)) : null;
  const test = testMatch?.[1]?.trim() || null;

  const messageLine = text.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^npm (?:error|warn)/i.test(l) && !/^yarn /i.test(l) && !/^(?:>|Exit code:)/i.test(l)) || '';
  const rawMessage = (tsMatch?.[5] || pyMatch?.[4] || pyMatch?.[3] || messageLine).slice(0, 1000);
  const message = redact(rawMessage);

  return {
    file,
    line,
    column,
    test,
    message,
  };
}
function normalizeObservation(result, check = result?.script || '') {
  const normalized = normalizeCommandResult(result);
  return {
    ...normalized,
    check,
    extracted: extractFailure(normalized),
  };
}
function verificationFailureFromError(error, script = '') {
  const executionBlocked = error?.executionBlocked === true;
  const status = executionBlocked
    ? GATE_FAILURE_STATUSES.has(error?.executionStatus) ? error.executionStatus : 'BLOCKED'
    : 'UNVERIFIED';
  const evidenceState = executionBlocked && NON_PASS_EVIDENCE_STATES.has(error?.evidenceState)
    ? error.evidenceState
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    script,
    status,
    executionBlocked,
    evidenceState,
    executed: false,
    exitCode: null,
    error: message,
    reason: message,
  };
}
function isGateOrUnverifiedResult(result) {
  return ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED', 'UNVERIFIED', 'VERIFICATION_UNAVAILABLE', 'SKIPPED'].includes(result?.status)
    || NON_PASS_EVIDENCE_STATES.has(result?.evidenceState)
    || result?.executionBlocked === true;
}
function diagnoseObservation(observation, metadata = {}) {
  const environment = new Set(['ENVIRONMENT_FAILURE', 'DEPENDENCY_FAILURE', 'COMMAND_NOT_AVAILABLE', 'TIMEOUT']);
  const classification = observation.classification || classifyFailureCategory(observation);
  const location = observation.extracted;
  const text = `${observation?.stderr || ''}\n${observation?.stdout || ''}\n${observation?.error || ''}`;
  let hypothesis = null;
  if (/TS2304|Cannot find name/i.test(text)) {
    hypothesis = `Hypothesis: Identifier not found in ${location?.file || 'code'}${location?.line ? `:${location.line}` : ''}. Likely a missing import or undeclared variable.`;
  } else if (/TS2322|Type .* is not assignable/i.test(text)) {
    hypothesis = `Hypothesis: Type mismatch in ${location?.file || 'code'}${location?.line ? `:${location.line}` : ''}. The provided type does not conform to the expected signature.`;
  } else if (/TS2339|Property .* does not exist/i.test(text)) {
    hypothesis = `Hypothesis: Property access error in ${location?.file || 'code'}${location?.line ? `:${location.line}` : ''}. Property is missing on the target type.`;
  } else if (/AssertionError|Expected .* got/i.test(text)) {
    hypothesis = `Hypothesis: Test assertion failure in ${location?.file || 'test'}${location?.line ? `:${location.line}` : ''}. Output value diverged from test expectation.`;
  } else if (/SyntaxError|parse error/i.test(text)) {
    hypothesis = `Hypothesis: Syntax parsing error in ${location?.file || 'code'}${location?.line ? `:${location.line}` : ''}. Check for unclosed brackets or invalid syntax.`;
  } else if (location?.file) {
    hypothesis = `Hypothesis: Verification failure in ${location.file}${location.line ? `:${location.line}` : ''}: ${(location.message || '').slice(0, 150)}`;
  } else {
    hypothesis = 'Hypothesis: General verification failure observed without a uniquely resolved source location.';
  }

  return {
    taskId: metadata.taskId || null,
    attempt: metadata.attempt || 1,
    check: observation.check,
    classification,
    environmentFailure: environment.has(classification),
    location,
    hypothesis: redact(hypothesis),
    runtimeEvidence: observation.runtimeEvidence || null,
    context: { workspace: metadata.workspace || null, branch: metadata.branch || null },
  };
}
async function runVerificationChecks({ checks, runCheck, isCancelled = () => false, onProgress = () => {} }) {
  if (typeof runCheck !== 'function') throw new Error('Verification runner is required.');
  const selectedChecks = [...new Set(checks || [])].map((check) => commandPolicy(check).script);
  if (!selectedChecks.length) {
    return {
      ok: false,
      status: 'UNVERIFIED',
      executed: false,
      exitCode: null,
      skipped: true,
      checks: [],
      attempts: [],
      reason: 'No allow-listed verification script is available.',
    };
  }
  const attempts = [];
  for (const check of selectedChecks) {
    if (isCancelled()) return { ok: false, status: 'CANCELLED', cancelled: true, checks: selectedChecks, attempts };
    onProgress({ phase: 'verify', check });
    let rawResult;
    try {
      rawResult = await runCheck(check);
    } catch (error) {
      rawResult = verificationFailureFromError(error, check);
    }
    const result = normalizeObservation(rawResult, check);
    attempts.push(result);
    if (!result.ok) {
      return {
        ok: false,
        status: result.status || (result.executed && Number.isInteger(result.exitCode)
          ? (result.classification || 'CODE_FAILURE')
          : 'UNVERIFIED'),
        evidenceState: result.evidenceState,
        executed: result.executed,
        exitCode: result.exitCode,
        reason: result.reason || null,
        failure: result.failure,
        classification: result.classification,
        checks: selectedChecks,
        attempts,
        diagnosis: diagnoseObservation(result),
      };
    }
  }
  return {
    ok: true,
    status: 'PASS',
    executed: attempts.length > 0 && attempts.every((attempt) => attempt.executed === true),
    exitCode: attempts.at(-1)?.exitCode ?? null,
    checks: selectedChecks,
    attempts,
  };
}
function updateLoopTask(taskId, owner, state, phase, message, outcome = null) {
  if (!taskId) return null;
  const task = getTask(taskId, owner);
  if (state && task.state !== state) transition(task, state);
  progress(task, phase, message);
  if (outcome) {
    task.outcome = outcome.status || outcome;
    if (outcome.error) task.error = outcome.error;
  }
  return task;
}
async function runEngineeringLoop({
  taskId, owner, checks, runCheck, proposeFix, approveFix, applyFix,
  maxAttempts = 2, onProgress = () => {}, isCancelled = () => false,
}) {
  if (typeof runCheck !== 'function' || typeof proposeFix !== 'function' || typeof approveFix !== 'function' || typeof applyFix !== 'function') {
    throw new Error('Engineering loop requires safe check, proposal, approval, and apply callbacks.');
  }
  const selectedChecks = [...new Set(checks || [])].map((check) => commandPolicy(check).script);
  if (!selectedChecks.length) throw new Error('No safe verification checks selected.');
  const observations = []; let previousSignature = null; let fixes = 0;
  const task = taskId ? getTask(taskId, owner) : null;
  for (let attempt = 1; attempt <= Math.max(1, Math.min(3, Number(maxAttempts) || 1)); attempt += 1) {
    if (isCancelled()) {
      const outcome = { status: 'CANCELLED' };
      return { ...outcome, attempts: observations };
    }
    if (task) updateLoopTask(taskId, owner, 'verifying', 'running_checks', 'Running approved verification checks.');
    onProgress({ phase: 'running_checks', attempt, checks: selectedChecks });
    const results = [];
    for (const check of selectedChecks) {
      let rawResult;
      try {
        rawResult = await runCheck(check, attempt);
      } catch (error) {
        rawResult = verificationFailureFromError(error, check);
      }
      const observation = normalizeObservation(rawResult, check);
      results.push(observation); observations.push(observation);
      if (!observation.ok) break;
    }
    const failure = results.find((result) => !result.ok);
    if (!failure) {
      const outcome = { status: 'PASS' };
      if (task) updateLoopTask(taskId, owner, 'completed', 'complete', 'Checks passed.', outcome);
      return { ...outcome, attempts: observations, fixes };
    }
    const diagnosis = diagnoseObservation(failure, { taskId, attempt });
    onProgress({ phase: 'observing', attempt, observation: failure });
    if (isGateOrUnverifiedResult(failure)) {
      const outcome = {
        status: failure.status || failure.evidenceState || 'UNVERIFIED',
        evidenceState: failure.evidenceState,
        error: failure.reason || 'Verification status is blocked or not established.',
      };
      if (task) updateLoopTask(taskId, owner, 'failed', 'verification_unavailable', outcome.error, outcome);
      return { ...outcome, attempts: observations, diagnosis, fixes };
    }
    if (diagnosis.environmentFailure) {
      const outcome = { status: 'ENVIRONMENT_FAILURE', error: 'Verification could not run in the current environment.' };
      if (task) updateLoopTask(taskId, owner, 'failed', 'environment_failure', outcome.error, outcome);
      return { ...outcome, attempts: observations, diagnosis, fixes };
    }
    const signature = JSON.stringify({ failure: failure.failure, extracted: failure.extracted });
    if (signature === previousSignature) {
      const outcome = { status: 'NO_PROGRESS', error: 'Repeated verification failure produced no progress.' };
      if (task) updateLoopTask(taskId, owner, 'failed', 'no_progress', outcome.error, outcome);
      return { ...outcome, attempts: observations, diagnosis, fixes };
    }
    previousSignature = signature;
    if (attempt >= Math.max(1, Math.min(3, Number(maxAttempts) || 1))) {
      const outcome = { status: 'MAX_ATTEMPTS', error: 'Maximum engineering-loop attempts reached.' };
      if (task) updateLoopTask(taskId, owner, 'failed', 'max_attempts', outcome.error, outcome);
      return { ...outcome, attempts: observations, diagnosis, fixes };
    }
    if (task) updateLoopTask(taskId, owner, 'recovering', 'diagnosing', 'Diagnosing the failed check.');
    onProgress({ phase: 'diagnosing', attempt, diagnosis });
    const proposal = await proposeFix({ taskId, owner, diagnosis, observation: failure, attempt });
    const proposalId = proposal?.taskId || proposal?.id;
    if (!proposalId || !registry.has(proposalId)) {
      const outcome = { status: 'NO_PROGRESS', error: 'No approved fix proposal was registered.' };
      if (task) updateLoopTask(taskId, owner, 'failed', 'no_progress', outcome.error, outcome);
      return { ...outcome, attempts: observations, diagnosis, fixes };
    }
    if (isCancelled()) {
      const repairTask = registry.get(proposalId);
      if (repairTask && !['completed', 'undone', 'failed', 'cancelled'].includes(repairTask.state)) {
        cancelTask(proposalId, owner, { syncConversationTurn: false });
      }
      const outcome = { status: 'CANCELLED' };
      return { ...outcome, attempts: observations, diagnosis, fixes };
    }
    if (task) progress(task, 'repair_waiting_for_approval', 'Waiting for approval of the registered fix proposal.');
    onProgress({ phase: 'waiting_for_approval', attempt, proposalId });
    await approveFix(proposalId, owner);
    if (isCancelled()) {
      const repairTask = registry.get(proposalId);
      if (repairTask && !['completed', 'undone', 'failed', 'cancelled'].includes(repairTask.state)) {
        cancelTask(proposalId, owner, { syncConversationTurn: false });
      }
      const outcome = { status: 'CANCELLED' };
      return { ...outcome, attempts: observations, diagnosis, fixes };
    }
    if (task) progress(task, 'repair_approved', 'Fix proposal approved; applying the separately authorized repair proposal.');
    fixes += 1;
    onProgress({ phase: 'applying_fix', attempt, proposalId });
    await applyFix(proposalId, owner);
    if (task) updateLoopTask(taskId, owner, 'verifying', 'retesting', 'Retesting after the approved fix.');
    onProgress({ phase: 'retesting', attempt: attempt + 1 });
  }
  return { status: 'MAX_ATTEMPTS', attempts: observations, fixes };
}

async function executeAutonomousCodingWorkflow(input) {
  const continuationToken = input?.continuationToken;
  if (!continuationToken) {
    return executeAutonomousCodingWorkflowStage(input, null);
  }
  const saved = workflowContinuations.get(continuationToken);
  if (!saved || saved.expiresAt <= Date.now()) {
    workflowContinuations.delete(continuationToken);
    throw new Error('The investigation continuation is missing or expired; start a new request.');
  }
  const root = await fs.realpath(input.root);
  if (saved.running
    || saved.sessionId !== input.sessionId
    || saved.ownerWebContentsId !== input.ownerWebContentsId
    || !samePath(saved.root, root)
    || saved.scope !== (input.scope || '.')
    || saved.requestHash !== hash(String(input.userRequest || ''))) {
    throw new Error('The investigation continuation does not match this request, project, or renderer session.');
  }
  saved.running = true;
  try {
    return await executeAutonomousCodingWorkflowStage(input, saved);
  } finally {
    saved.running = false;
  }
}

async function executeAutonomousCodingWorkflowStage({
  userRequest,
  root: inputRoot,
  scope = '.',
  sessionId,
  ownerWebContentsId,
  autoRepairEnabled = false,
  maxRepairAttempts = 2,
  onProgress = () => {},
  runCheck = null,
  assessFindingRelevance = null,
  requestApproval = null,
  tools = null,
  isCancelled = () => false,
}, continuation = null) {
  if (!sessionId || ownerWebContentsId === undefined) {
    throw new Error('Developer session ownership is required.');
  }
  const root = await fs.realpath(inputRoot);
  const owner = { sessionId, ownerWebContentsId };
  const fileReader = tools?.readFile || ((p, range) => developerFiles.readFile(p, ownerWebContentsId, range));
  const fileSearcher = tools?.searchCode || ((q, s) => developerFiles.searchCode(q, ownerWebContentsId, s));

  // STAGE 1: UNDERSTAND
  onProgress({
    phase: continuation ? 'INVESTIGATE_RESUME' : 'UNDERSTAND',
    message: continuation ? 'Resuming the bounded investigation from saved evidence.' : 'Analyzing task requirements and ambiguity.',
  });
  const taskOperatingMode = tools?.operatingMode || null;
  const modeRouting = continuation?.modeRouting
    || routeTaskMode({ goal: userRequest, userRequestedMode: taskOperatingMode });
  const requirementsAnalysis = continuation?.requirementsAnalysis || analyzeTaskRequirements(userRequest);
  if (requirementsAnalysis.needsClarification) {
    const taskPlan = createTaskPlan({
      userRequest,
      requirements: requirementsAnalysis,
      operatingMode: modeRouting.mode,
      complexity: modeRouting.complexity,
      capabilities: {
        canPropose: modeRouting.canPropose,
        canApply: modeRouting.canApply,
        canVerify: modeRouting.canVerify,
      },
    });
    return {
      outcome: 'CLARIFICATION_REQUIRED',
      phase: 'UNDERSTAND',
      requirements: requirementsAnalysis,
      clarificationPrompt: requirementsAnalysis.clarificationPrompt,
      filesModified: [],
      taskPlan,
    };
  }

  // STAGE 2: DISCOVER
  onProgress({ phase: 'DISCOVER', message: 'Discovering project architecture and conventions.' });
  const metadata = continuation?.metadata || await readProjectMetadata(root);
  const detected = continuation?.detected || await detectProject(root);
  const projectArch = continuation?.projectArch || discoverProjectArchitecture({ ...metadata, ...detected });
  const detectedChecks = selectVerificationChecks({ ...metadata, ...detected });
  const selectedChecks = continuation?.selectedChecks || ((Array.isArray(tools?.checks) && tools.checks.length > 0)
    ? tools.checks
    : (detectedChecks.length > 0 ? detectedChecks : (typeof runCheck === 'function' ? ['test'] : [])));
  const effectiveAutoRepair = Boolean(autoRepairEnabled || tools?.autoRepairEnabled);
  const effectiveMaxRepairAttempts = Math.max(1, Math.min(3, Number(tools?.maxRepairAttempts || maxRepairAttempts) || 2));
  const taskPlan = continuation?.taskPlan || createTaskPlan({
    userRequest,
    projectArch,
    requirements: requirementsAnalysis,
    operatingMode: modeRouting.mode,
    complexity: modeRouting.complexity,
    capabilities: {
      canPropose: modeRouting.canPropose,
      canApply: modeRouting.canApply,
      canVerify: modeRouting.canVerify,
      approvalAvailable: typeof requestApproval === 'function',
      verificationAvailable: typeof runCheck === 'function' && selectedChecks.length > 0,
    },
  });
  const turn = continuation?.turn || beginConversationTurn({
    root, request: userRequest, sessionId, ownerWebContentsId, scope, operatingMode: modeRouting.mode,
  });
  const cancelledResult = (phase, taskId = null) => {
    if (continuation?.token) workflowContinuations.delete(continuation.token);
    const activeStage = taskPlan.subtasks.find((item) => item.status === 'IN_PROGRESS');
    if (activeStage) {
      advanceTaskPlan(taskPlan, {
        subtaskId: activeStage.id,
        status: 'CANCELLED',
        outcome: 'Cancellation requested; no later stage may proceed.',
      });
    }
    for (const workItem of taskPlan.workItems || []) {
      if (!['COMPLETED', 'SKIPPED', 'DELEGATED', 'CANCELLED'].includes(workItem.status)) {
        advanceTaskPlan(taskPlan, {
          workItemId: workItem.id,
          status: 'CANCELLED',
          outcome: 'The owning workflow was cancelled.',
        });
      }
    }
    const currentTurnState = conversationTurns.get(turn.turnId)?.state;
    if (!['completed', 'failed', 'cancelled'].includes(currentTurnState)) {
      advanceConversationTurn(turn.turnId, 'cancelled', owner, { phase: 'workflow_cancelled' });
    }
    return {
      outcome: 'CANCELLED',
      phase,
      taskId,
      turnId: turn.turnId,
      taskPlan,
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
      message: 'The workflow was cancelled; no verified completion is claimed.',
    };
  };
  const makePlanEvidence = (stageId, types, details = {}) => {
    const priorEvidence = Object.fromEntries(taskPlan.subtasks
      .filter((item) => item.status === 'COMPLETED' && item.evidence)
      .map((item) => [item.id, item.evidence]));
    const allTypes = [...new Set([
      ...Object.values(priorEvidence).flatMap((item) => item.types || []),
      ...types,
    ])];
    const evidence = {
      ...details,
      types,
      provenance: 'HOST_OBSERVED',
      evidenceByStage: priorEvidence,
    };
    const linkedItems = (taskPlan.workItems || []).filter((item) => item.stageId === stageId);
    if (linkedItems.length > 0) {
      evidence.workItems = linkedItems.map((item) => ({
        id: item.id,
        evidence: {
          ...details,
          types: allTypes,
          objective: item.objective,
          provenance: 'HOST_OBSERVED',
          evidenceByStage: { ...priorEvidence, [stageId]: { types, ...details } },
        },
      }));
    }
    return evidence;
  };
  const unresolvedObjectiveTaskState = (phase) => createTaskState({
    status: 'INCOMPLETE',
    phase,
    reason: 'The workflow evidence confirms its lifecycle stages, but a trusted item-specific objective verifier is not established.',
  });
  const delegateWorkItems = (reason) => {
    for (const workItem of taskPlan.workItems || []) {
      if (['COMPLETED', 'SKIPPED', 'DELEGATED', 'CANCELLED'].includes(workItem.status)) continue;
      advanceTaskPlan(taskPlan, {
        workItemId: workItem.id,
        status: 'DELEGATED',
        outcome: reason,
        evidence: {
          types: ['STANDARD_PROPOSAL_HANDOFF'],
          objective: workItem.objective,
          provenance: 'HOST_WORKFLOW_ROUTER',
          reason,
        },
      });
    }
  };

  // STAGE 3: INVESTIGATE
  onProgress({ phase: 'INVESTIGATE', message: 'Investigating relevant files and tracing execution flow.' });
  if (!continuation) {
    advanceConversationTurn(turn.turnId, 'understanding', owner, { phase: 'investigating' });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-1',
      status: 'IN_PROGRESS',
    });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-1',
      status: 'COMPLETED',
      outcome: 'Task requirements and architecture boundaries analyzed from request and discovered project metadata.',
      evidence: makePlanEvidence('ST-1', ['REQUIREMENTS_ANALYSIS', 'PROJECT_DISCOVERY'], {
        requirementCount: requirementsAnalysis.explicitRequirements.length,
        ecosystem: projectArch?.ecosystem || 'UNKNOWN',
        requestHash: hash(String(userRequest)),
      }),
    });
  }
  advanceTaskPlan(taskPlan, {
    subtaskId: 'ST-2',
    status: 'IN_PROGRESS',
  });

  const searchTerms = continuation?.searchTerms || [...new Set(requirementsAnalysis.domainTerms || [])];
  const sessionSearches = continuation?.sessionSearches || [];
  const candidateFiles = continuation?.candidateFiles || new Map();
  const candidateReferences = continuation?.candidateReferences || new Map();
  const inspectionEvidence = continuation?.inspectionEvidence || [];
  const inspectedFiles = continuation?.inspectedFiles || [];
  const confirmedDefects = continuation?.confirmedDefects || [];
  const objectiveAssessments = continuation?.objectiveAssessments || [];
  const searchFailures = continuation?.searchFailures || [];
  const readFailures = continuation?.readFailures || [];
  const readPaths = continuation?.readPaths || new Set();
  const readAttempts = continuation?.readAttempts || new Map();
  const recoveryEvents = continuation?.recoveryEvents || [];
  const originalObjective = continuation?.originalObjective || {
    request: userRequest,
    scope,
    acceptanceCriteria: [...(requirementsAnalysis.acceptanceCriteria || [])],
  };
  const createTaskState = ({ status, phase = 'INVESTIGATE', reason = null, nextAction = null } = {}) => ({
    objective: {
      request: originalObjective.request,
      scope: originalObjective.scope,
      acceptanceCriteria: [...originalObjective.acceptanceCriteria],
    },
    status,
    phase,
    evidence: {
      searches: sessionSearches.map((search) => ({
        query: search.query,
        status: search.status,
        attempts: search.attempts || 1,
        resultCount: search.resultCount,
      })),
      inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
      inspectionEvidence: inspectionEvidence.map((entry) => ({
        path: entry.path,
        sourceHash: entry.sourceHash,
        lineRange: entry.lineRange,
        reference: entry.reference,
        executionFlow: entry.executionFlow,
      })),
      findings: confirmedDefects.map((finding) => ({
        filePath: finding.filePath,
        symbol: finding.symbol,
        lines: finding.lines,
        classification: finding.classification,
        isConfirmed: finding.isConfirmed,
      })),
      objectiveAssessments: objectiveAssessments.map((assessment) => ({ ...assessment })),
    },
    recoveries: recoveryEvents.map((event) => ({ ...event })),
    unresolvedQuestions: reason ? [reason] : [],
    nextAction,
  });
  const searchState = continuation || {
    root,
    scope,
    sessionId,
    ownerWebContentsId,
    requestHash: hash(String(userRequest)),
    requirementsAnalysis,
    modeRouting,
    metadata,
    detected,
    projectArch,
    selectedChecks,
    taskPlan,
    turn,
    searchTerms,
    sessionSearches,
    candidateFiles,
    candidateReferences,
    inspectionEvidence,
    inspectedFiles,
    confirmedDefects,
    searchFailures,
    readFailures,
    readPaths,
    readAttempts,
    recoveryEvents,
    originalObjective,
    searchIndex: 0,
    readCount: 0,
    expiresAt: Date.now() + WORKFLOW_CONTINUATION_TTL_MS,
    running: true,
  };
  const searchesPerStage = Math.max(1, Number(developerSettings.investigationSearchesPerStage) || 6);
  const maxSearches = Math.max(searchesPerStage, Number(developerSettings.investigationMaxSearches) || 24);
  const searchEnd = Math.min(searchTerms.length, searchState.searchIndex + searchesPerStage, maxSearches);

  for (; searchState.searchIndex < searchEnd; searchState.searchIndex += 1) {
    if (isCancelled()) return cancelledResult('INVESTIGATE');
    const term = searchTerms[searchState.searchIndex];
    const searchPlan = planProgressiveSearch({ query: term, scope, sessionSearches });
    if (!searchPlan.isDuplicate) {
      onProgress({
        phase: 'SEARCH',
        message: `Searching project evidence (${searchState.searchIndex + 1} of ${searchTerms.length} request terms).`,
      });
      const searchRecord = {
        query: term,
        scope,
        status: 'RUNNING',
        attempts: 0,
        resultCount: 0,
        candidates: [],
      };
      sessionSearches.push(searchRecord);
      let recoveryReason = null;
      try {
        let searchResult;
        let searchCompleted = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          searchRecord.attempts = attempt;
          try {
            searchResult = await fileSearcher(term, scope);
            searchCompleted = true;
            break;
          } catch (error) {
            const retryable = error?.code === 'EBUSY'
              || /resource\s+locked|temporarily\s+unavailable/i.test(error instanceof Error ? error.message : String(error));
            const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
            if (attempt !== 1 || !retryable || isCancelled()) {
              if (attempt > 1 && retryable) {
                recoveryEvents.push({
                  operation: 'search_code',
                  query: term,
                  status: 'FAILED',
                  attempts: attempt,
                  reason: errorMessage,
                  objectiveStatus: 'IN_PROGRESS',
                });
              }
              throw error;
            }
            recoveryReason = errorMessage;
            searchRecord.retryReason = errorMessage;
          }
        }
        if (isCancelled()) return cancelledResult('INVESTIGATE');
        if (!searchCompleted) throw new Error('Project search did not return a result.');
        const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
        searchRecord.status = 'COMPLETED';
        searchRecord.resultCount = results.length;
        searchRecord.truncated = searchResult?.truncated === true;
        searchRecord.stopReason = typeof searchResult?.stopReason === 'string' ? searchResult.stopReason : null;
        searchRecord.candidates = results.slice(0, 20).flatMap((res) => (
          res?.path
            ? [{
                path: res.path,
                line: Number.isInteger(res.line) ? res.line : null,
                score: Number.isFinite(res.score) ? res.score : null,
                matchType: typeof res.matchType === 'string' ? res.matchType : null,
              }]
            : []
        ));
        if (recoveryReason) {
          recoveryEvents.push({
            operation: 'search_code',
            query: term,
            status: 'RECOVERED',
            attempts: searchRecord.attempts,
            reason: recoveryReason,
            resultCount: results.length,
            objectiveStatus: 'IN_PROGRESS',
          });
        }
        for (const res of results) {
          if (!res || typeof res.path !== 'string' || !res.path) continue;
          candidateFiles.set(
            res.path,
            (candidateFiles.get(res.path) || 0) + (Number.isFinite(res.score) ? res.score : 1),
          );
          if (Number.isInteger(res.line) && res.line > 0) {
            const prior = candidateReferences.get(res.path);
            if (!prior || (Number.isFinite(res.score) ? res.score : 1) > prior.score) {
              candidateReferences.set(res.path, {
                line: res.line,
                score: Number.isFinite(res.score) ? res.score : 1,
                matchType: typeof res.matchType === 'string' ? res.matchType : null,
              });
            }
          }
        }
      } catch (error) {
        searchRecord.status = 'FAILED';
        searchRecord.reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        searchFailures.push({
          query: term,
          reason: searchRecord.reason,
        });
      }
    }
  }

  // Read and inspect candidate files
  const buildSourceEvidenceForAssessment = () => {
    const latestByPath = new Map();
    for (const entry of [...inspectionEvidence].reverse()) {
      if (!latestByPath.has(entry.path)) latestByPath.set(entry.path, entry);
    }
    const evidence = [...latestByPath.values()].map((entry) => {
      const file = [...inspectedFiles].reverse().find((item) => item.path === entry.path);
      const content = file?.content || '';
      const lines = content.split(/\r?\n/);
      const sourceStart = Number.isInteger(entry.lineRange?.startLine) ? entry.lineRange.startLine : 1;
      const matchingFindings = confirmedDefects.filter((finding) => finding.filePath === entry.path);
      const findingLines = matchingFindings
        .map((finding) => Number(String(finding.lines).split('-')[0]))
        .filter(Number.isInteger);
      const focusLine = findingLines.length
        ? Math.min(...findingLines)
        : sourceStart;
      const localStart = Math.max(0, focusLine - sourceStart - 16);
      const localEnd = Math.min(lines.length, localStart + 40);
      const excerpt = lines.slice(localStart, localEnd)
        .map((line, lineIndex) => `${sourceStart + localStart + lineIndex}: ${line.slice(0, 500)}`)
        .join('\n')
        .slice(0, 1000);
      return {
        evidenceId: `source-${hash(`${entry.path}:${entry.sourceHash}`).slice(0, 16)}`,
        path: entry.path,
        sourceHash: entry.sourceHash,
        lineRange: entry.lineRange,
        executionFlow: entry.executionFlow,
        excerpt,
      };
    });
    return evidence;
  };
  const assessObjectiveFindings = async () => {
    if (typeof assessFindingRelevance !== 'function') {
      throw new Error('The trusted configured-provider relevance assessor is unavailable.');
    }
    const sourceEvidence = buildSourceEvidenceForAssessment();
    const sourceById = new Map(sourceEvidence.map((item) => [item.evidenceId, item]));
    const findingIds = new Map();
    const findings = confirmedDefects.map((finding, index) => {
      const findingId = `finding-${index + 1}`;
      const source = sourceEvidence.find((item) => item.path === finding.filePath);
      if (!source || !source.sourceHash || !source.excerpt) {
        throw new Error(`Source evidence for ${finding.filePath} is unavailable for relevance assessment.`);
      }
      findingIds.set(findingId, finding);
      return {
        findingId,
        filePath: finding.filePath,
        symbol: finding.symbol,
        lines: finding.lines,
        classification: finding.classification,
        codeSnippet: finding.codeSnippet,
        controlFlow: finding.controlFlow,
        expected: finding.expected,
        observed: finding.observed,
        sourceEvidenceId: source.evidenceId,
      };
    });
    const response = await assessFindingRelevance({
      objective: {
        request: originalObjective.request,
        scope: originalObjective.scope,
        acceptanceCriteria: [...originalObjective.acceptanceCriteria],
      },
      findings,
      sourceEvidence,
    });
    const records = response?.findings;
    if (!Array.isArray(records) || records.length !== findings.length) {
      throw new Error('The configured-provider relevance assessment did not cover every finding.');
    }
    const decisions = new Set(['SUPPORTED', 'UNRELATED', 'INSUFFICIENT', 'CONTRADICTED']);
    const seen = new Set();
    return records.map((record) => {
      const finding = findingIds.get(record?.findingId);
      const refs = record?.evidenceIds;
      const contradictions = record?.contradictionEvidenceIds;
      const assumptions = record?.unresolvedAssumptions;
      if (
        !finding
        || seen.has(record.findingId)
        || !decisions.has(record.decision)
        || typeof record.relationship !== 'string'
        || !record.relationship.trim()
        || !Array.isArray(refs)
        || !refs.length
        || refs.some((id) => !sourceById.has(id))
        || !Array.isArray(contradictions)
        || !Array.isArray(assumptions)
        || assumptions.some((item) => typeof item !== 'string')
        || contradictions.some((id) => !sourceById.has(id) || !refs.includes(id))
        || (record.decision === 'CONTRADICTED' && !contradictions.length)
      ) {
        throw new Error('The configured-provider relevance assessment was malformed or cited unknown evidence.');
      }
      const findingSource = sourceEvidence.find((item) => item.path === finding.filePath);
      if (!refs.includes(findingSource.evidenceId)) {
        throw new Error(`The relevance assessment omitted source evidence for ${finding.filePath}.`);
      }
      const findingStart = Number(String(finding.lines).split('-')[0]);
      if (
        Number.isInteger(findingStart)
        && findingSource.lineRange?.complete !== true
        && (
          findingStart < findingSource.lineRange?.startLine
          || findingStart > findingSource.lineRange?.endLine
        )
      ) {
        throw new Error(`The relevance assessment source range does not contain finding line ${findingStart}.`);
      }
      seen.add(record.findingId);
      return {
        findingId: record.findingId,
        filePath: finding.filePath,
        decision: record.decision,
        relationship: record.relationship.trim().slice(0, 1200),
        evidenceIds: [...new Set(refs)],
        contradictionEvidenceIds: [...new Set(contradictions)],
        unresolvedAssumptions: [...new Set(assumptions)].slice(0, 8),
        provenance: record.provenance || 'UNTRUSTED_PROVIDER_ASSESSMENT',
      };
    });
  };
  const storeObjectiveAssessments = (assessments) => {
    const latestByFinding = new Map(
      objectiveAssessments.map((assessment) => [assessment.findingId, assessment]),
    );
    for (const assessment of assessments) latestByFinding.set(assessment.findingId, assessment);
    objectiveAssessments.splice(0, objectiveAssessments.length, ...latestByFinding.values());
  };
  const incompleteRelevanceResult = (reason, assessments = []) => {
    storeObjectiveAssessments(assessments);
    const remainingCandidates = [...candidateFiles.keys()].filter((candidatePath) => (
      !readPaths.has(candidatePath) && (readAttempts.get(candidatePath) || 0) < 2
    ));
    const pendingSearch = searchState.searchIndex < searchTerms.length && searchState.searchIndex < maxSearches;
    const canResume = (remainingCandidates.length > 0 || pendingSearch)
      && searchState.readCount < maxReads;
    const nextAction = remainingCandidates.length > 0
      ? { tool: 'read_file', path: remainingCandidates[0], reason: 'Inspect another ranked source candidate before deciding whether the finding affects the requested outcome.' }
      : pendingSearch
        ? { tool: 'search_code', query: searchTerms[searchState.searchIndex], reason: 'Gather another distinct source reference before assessing the finding relationship.' }
        : { tool: 'request_clarification', question: reason };
    const taskState = createTaskState({
      status: 'INCOMPLETE',
      phase: 'INVESTIGATE',
      reason,
      nextAction,
    });
    const continuationToken = canResume ? crypto.randomUUID() : null;
    if (canResume) {
      searchState.goal = originalObjective.request;
      searchState.unresolvedQuestions = [reason];
      searchState.nextAction = nextAction;
      searchState.running = false;
      searchState.expiresAt = Date.now() + WORKFLOW_CONTINUATION_TTL_MS;
      searchState.token = continuationToken;
      if (!storeWorkflowContinuation(continuationToken, searchState)) {
        searchState.token = null;
      }
    }
    if (!searchState.token && continuation?.token) workflowContinuations.delete(continuation.token);
    if (!searchState.token) {
      advanceConversationTurn(turn.turnId, 'failed', owner, { phase: 'relevance_incomplete', nextAction });
    }
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-2',
      status: 'BLOCKED',
      outcome: reason,
      hypothesisId: 'H1',
      hypothesisStatus: 'UNVERIFIED',
      evidence: objectiveAssessments.map((item) => item.evidenceIds).flat().join(', ') || reason,
    });
    return {
      outcome: 'INVESTIGATION_INCOMPLETE',
      phase: 'INVESTIGATE',
      turnId: turn.turnId,
      architecture: projectArch,
      taskPlan,
      inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
      inspectionEvidence: [...inspectionEvidence],
      findings: confirmedDefects,
      taskState,
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
      reason,
      nextAction,
      continuation: searchState.token
        ? {
            status: 'READY_TO_RESUME',
            token: searchState.token,
            goal: originalObjective.request,
            inspectionEvidence: [...inspectionEvidence],
            taskState,
            unresolvedQuestions: [reason],
            nextAction,
          }
        : {
            status: 'NEEDS_CLARIFICATION',
            goal: originalObjective.request,
            inspectionEvidence: [...inspectionEvidence],
            taskState,
            unresolvedQuestions: [reason],
            nextAction,
          },
      message: 'No proposal was created because the source evidence does not establish a sufficiently supported relationship to the original objective.',
    };
  };
  const rankedCandidates = [...candidateFiles.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([candidatePath]) => candidatePath)
    .filter((candidatePath) => !readPaths.has(candidatePath) && (readAttempts.get(candidatePath) || 0) < 2);
  const readsPerStage = Math.max(1, Number(developerSettings.investigationReadsPerStage) || 8);
  const maxReads = Math.max(readsPerStage, Number(developerSettings.investigationMaxReads) || 32);
  const readEnd = Math.min(rankedCandidates.length, readsPerStage, Math.max(0, maxReads - searchState.readCount));
  for (const candidatePath of rankedCandidates.slice(0, readEnd)) {
    if (isCancelled()) return cancelledResult('INVESTIGATE');
    searchState.readCount += 1;
    readAttempts.set(candidatePath, (readAttempts.get(candidatePath) || 0) + 1);
    onProgress({
      phase: 'READ',
      message: `Inspecting relevant project file ${searchState.readCount} of ${maxReads}.`,
    });
    try {
      const reference = candidateReferences.get(candidatePath);
      const alreadyInspectedRegion = inspectionEvidence.some((entry) => (
        entry.path === candidatePath && entry.lineRange?.complete === false
      ));
      const requestedRange = reference && !alreadyInspectedRegion && readAttempts.get(candidatePath) === 1
        ? { startLine: Math.max(1, reference.line - 20), endLine: reference.line + 20 }
        : undefined;
      const fileData = await fileReader(candidatePath, requestedRange);
      if (isCancelled()) return cancelledResult('INVESTIGATE');
      if (!fileData || typeof fileData.content !== 'string') {
        throw new Error('Source retrieval returned no text content.');
      }
      const lineRange = fileData.lineRange && typeof fileData.lineRange === 'object'
        ? {
            startLine: Number.isInteger(fileData.lineRange.startLine) ? fileData.lineRange.startLine : null,
            endLine: Number.isInteger(fileData.lineRange.endLine) ? fileData.lineRange.endLine : null,
            totalLines: Number.isInteger(fileData.lineRange.totalLines) ? fileData.lineRange.totalLines : null,
            complete: fileData.lineRange.complete === true,
          }
        : {
            startLine: 1,
            endLine: fileData.content.split(/\r?\n/).length,
            totalLines: fileData.content.split(/\r?\n/).length,
            complete: true,
          };
      readPaths.add(candidatePath);
      if (!lineRange.complete) readPaths.delete(candidatePath);
      inspectedFiles.push({ path: candidatePath, content: fileData.content, lineRange });

      // Trace architectural execution flow
      const trace = traceExecutionFlow({
        route: candidatePath,
        controllerFile: candidatePath,
        controllerContent: fileData.content,
      });
      inspectionEvidence.push({
        path: candidatePath,
        sourceHash: hash(fileData.content),
        lineRange,
        reference: reference || null,
        executionFlow: { ...trace.layers, traceComplete: lineRange.complete },
      });

      // Inspect for common code defects across ecosystems
      const lines = fileData.content.split(/\r?\n/);
      const executableLines = maskNonCodeSource(fileData.content, candidatePath).split(/\r?\n/);
      lines.forEach((line, lineIdx) => {
        if (/die\(|var_dump\(|dd\(|print_r\(|debugger;|console\.trace\(|breakpoint\(|import pdb;\s*pdb\.set_trace\(\)/i.test(executableLines[lineIdx] || '')) {
          confirmedDefects.push(classifyDefect({
            filePath: candidatePath,
            symbol: 'debug_probe',
            lines: `${lineRange.startLine + lineIdx}`,
            codeSnippet: line.trim(),
            controlFlow: 'Debug probe or terminating exit statement left in production code',
            expected: 'Structured response returned to caller without terminating process',
            observed: line.trim(),
            evidenceType: 'STATIC_INSPECTION_CONFIRMED',
          }));
        }
      });

      if (lineRange.complete && trace.layers.hasTransaction && trace.layers.transactionRollbacksInCatch === false) {
        confirmedDefects.push(classifyDefect({
          filePath: candidatePath,
          symbol: trace.layers.controller || 'action',
          lines: `${lineRange.startLine}-${lineRange.endLine}`,
          codeSnippet: '// Missing rollback in catch block',
          controlFlow: 'Transaction opened with beginTransaction() but not rolled back in exception catch block',
          expected: 'Transaction rolled back before returning or exiting catch block',
          observed: 'No rollBack() statement in catch block',
          evidenceType: 'CONTROL_FLOW_CONFIRMED',
        }));
      }
    } catch (error) {
      readFailures.push({
        path: candidatePath,
        reason: error instanceof Error ? error.message : String(error),
        attempts: readAttempts.get(candidatePath),
      });
    }
  }

  if (isCancelled()) return cancelledResult('INVESTIGATE');
  recordConversationFindings(turn.turnId, confirmedDefects, owner);

  if (confirmedDefects.length === 0) {
    const remainingCandidates = [...candidateFiles.keys()].filter((candidatePath) => (
      !readPaths.has(candidatePath) && (readAttempts.get(candidatePath) || 0) < 2
    ));
    const pendingSearch = searchState.searchIndex < searchTerms.length && searchState.searchIndex < maxSearches;
    const pendingRead = remainingCandidates.length > 0 && searchState.readCount < maxReads;
    const unresolvedReadFailures = readFailures.filter((failure) => !readPaths.has(failure.path));
    const repeatedReadFailure = unresolvedReadFailures.some((failure) => failure.attempts >= 2);
    let canResume = (pendingSearch || pendingRead) && !repeatedReadFailure;
    const latestInspectionByPath = new Map();
    for (const entry of [...inspectionEvidence].reverse()) {
      if (!latestInspectionByPath.has(entry.path)) latestInspectionByPath.set(entry.path, entry);
    }
    const incompleteRead = [...latestInspectionByPath.values()].find((entry) => entry.lineRange?.complete === false);
    const nextStep = pendingRead
      ? {
          tool: 'read_file',
          path: remainingCandidates[0],
          reason: incompleteRead?.path === remainingCandidates[0]
            ? 'A targeted source region was inspected; retrieve the full source before drawing a no-defect conclusion.'
            : 'The current bounded stage ended before all ranked candidates were inspected.',
        }
      : pendingSearch
        ? {
            tool: 'search_code',
            query: searchTerms[searchState.searchIndex],
            reason: 'Additional distinct request terms remain for the next bounded investigation stage.',
          }
        : searchFailures.length
          || unresolvedReadFailures.length
          || sessionSearches.some((search) => search.truncated)
          || searchState.searchIndex < searchTerms.length
          || remainingCandidates.length > 0
          ? {
              tool: 'list_directory',
              path: projectArch.recommendedScope || '.',
              reason: 'Search or source inspection was incomplete; choose a narrower scope or query before drawing a conclusion.',
            }
          : incompleteRead
            ? {
                tool: 'read_file',
                path: incompleteRead.path,
                reason: 'The available source read was targeted or incomplete; no absence-of-defect conclusion is supported.',
              }
          : inspectionEvidence.length === 0
            ? {
                tool: 'list_directory',
                path: projectArch.recommendedScope || '.',
                reason: 'No relevant source was successfully inspected; discover the actual project layout and choose a narrower query.',
              }
            : null;
    if (nextStep) {
      const taskState = createTaskState({
        status: 'INCOMPLETE',
        reason: nextStep.reason,
        nextAction: nextStep,
      });
      const continuationToken = canResume ? crypto.randomUUID() : null;
      if (canResume) {
        searchState.goal = originalObjective.request;
        searchState.unresolvedQuestions = [nextStep.reason];
        searchState.nextAction = nextStep;
        searchState.running = false;
        searchState.expiresAt = Date.now() + WORKFLOW_CONTINUATION_TTL_MS;
        searchState.token = continuationToken;
        canResume = storeWorkflowContinuation(continuationToken, searchState);
      }
      if (!canResume) {
        if (continuation?.token) workflowContinuations.delete(continuation.token);
        advanceConversationTurn(turn.turnId, 'failed', owner, {
          phase: 'investigation_incomplete',
          nextStep,
        });
      }
      advanceTaskPlan(taskPlan, {
        subtaskId: 'ST-2',
        status: 'BLOCKED',
        outcome: 'Investigation incomplete - insufficient evidence or unexamined sources.',
        hypothesisId: 'H1',
        hypothesisStatus: 'UNVERIFIED',
        evidence: nextStep.reason,
      });
      return {
        outcome: 'INVESTIGATION_INCOMPLETE',
        phase: 'INVESTIGATE',
        turnId: turn.turnId,
        architecture: projectArch,
        taskPlan,
        inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
        inspectionEvidence: [...inspectionEvidence],
        searchFailures,
        readFailures,
        taskState,
        findings: [],
        filesModified: [],
        codeApplied: false,
        codeVerified: false,
        continuation: canResume
          ? {
              status: 'READY_TO_RESUME',
              token: continuationToken,
              searchesCompleted: sessionSearches,
              filesInspected: [...readPaths],
              goal: originalObjective.request,
              inspectionEvidence: [...inspectionEvidence],
              taskState,
              unresolvedQuestions: [nextStep.reason],
              nextAction: nextStep,
              nextStep,
            }
          : {
              status: 'NEEDS_NARROWER_REQUEST',
              searchesCompleted: sessionSearches,
              filesInspected: [...new Set(inspectionEvidence.map((entry) => entry.path))],
              goal: originalObjective.request,
              inspectionEvidence: [...inspectionEvidence],
              taskState,
              unresolvedQuestions: [nextStep.reason],
              nextAction: nextStep,
              nextStep,
            },
        message: 'The investigation is incomplete; no root cause or absence-of-defect claim is supported by the inspected evidence.',
      };
    }

    if (continuation?.token) workflowContinuations.delete(continuation.token);
    if (modeRouting.mode === 'AUDIT') {
      onProgress({ phase: 'AUDIT', message: 'Read-only audit completed; no changes proposed or applied.' });
      advanceConversationTurn(turn.turnId, 'blocked', owner, { phase: 'objective_coverage_not_established' });
      advanceTaskPlan(taskPlan, {
        subtaskId: 'ST-2',
        status: 'COMPLETED',
        outcome: `Inspected ${inspectedFiles.length} file(s); 0 defects found.`,
        hypothesisId: 'H1',
        hypothesisStatus: 'REFUTED',
        evidence: makePlanEvidence('ST-2', ['SOURCE_INSPECTION'], {
          inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
          sourceEvidence: inspectionEvidence.map((entry) => ({
            path: entry.path,
            sourceHash: entry.sourceHash,
            lineRange: entry.lineRange,
          })),
          conclusion: 'No supported defect was established in the inspected sources.',
        }),
      });
      advanceTaskPlan(taskPlan, {
        subtaskId: 'ST-6',
        status: 'IN_PROGRESS',
      });
      advanceTaskPlan(taskPlan, {
        subtaskId: 'ST-6',
        status: 'COMPLETED',
        outcome: 'Read-only audit completed with 0 findings; repository preserved.',
        evidence: makePlanEvidence('ST-6', ['PRESERVATION_AUDIT'], {
          preserved: true,
          modifiedFiles: [],
        }),
      });
      return {
        outcome: 'AUDIT_COMPLETED',
        phase: 'AUDIT',
        turnId: turn.turnId,
        architecture: projectArch,
        taskPlan,
        inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
        inspectionEvidence: [...inspectionEvidence],
        findings: [],
        taskState: unresolvedObjectiveTaskState('AUDIT'),
        filesModified: [],
        codeApplied: false,
        codeVerified: false,
        readOnlyPreserved: true,
        message: 'The read-only audit completed with zero modifications, but request completion remains unverified because no trusted item-specific objective verifier is available.',
      };
    }

    if (modeRouting.canApply === true) {
      const reason = 'No recognized defect was established. This bounded repair workflow cannot safely synthesize a feature or general implementation; continue through the standard Coding Agent proposal flow instead of treating the request as a bug fix.';
      const nextAction = {
        tool: 'standard_coding_proposal',
        reason: 'Prepare a task-specific proposal from the inspected source using the normal Coding Agent proposal and approval path.',
      };
      advanceTaskPlan(taskPlan, {
        subtaskId: 'ST-2',
        status: 'COMPLETED',
        outcome: `Inspected ${inspectedFiles.length} file(s); no recognized defect established for the requested implementation.`,
        hypothesisId: 'H1',
        hypothesisStatus: 'REFUTED',
        evidence: makePlanEvidence('ST-2', ['SOURCE_INSPECTION'], {
          inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
          sourceEvidence: inspectionEvidence.map((entry) => ({
            path: entry.path,
            sourceHash: entry.sourceHash,
            lineRange: entry.lineRange,
          })),
          conclusion: 'The bounded repair workflow cannot establish a supported defect.',
        }),
      });
      advanceConversationTurn(turn.turnId, 'failed', owner, { phase: 'implementation_required' });
      advanceTaskPlan(taskPlan, {
        subtaskId: 'ST-3',
        status: 'BLOCKED',
        outcome: reason,
      });
      delegateWorkItems(reason);
      return {
        outcome: 'IMPLEMENTATION_REQUIRED',
        phase: 'PLAN',
        turnId: turn.turnId,
        architecture: projectArch,
        taskPlan,
        inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
        inspectionEvidence: [...inspectionEvidence],
        findings: [],
        taskState: createTaskState({
          status: 'INCOMPLETE',
          phase: 'PLAN',
          reason,
          nextAction,
        }),
        filesModified: [],
        codeApplied: false,
        codeVerified: false,
        reason,
        nextAction,
      };
    }

    advanceConversationTurn(turn.turnId, 'blocked', owner, { phase: 'objective_coverage_not_established' });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-2',
      status: 'COMPLETED',
      outcome: `Inspected ${inspectedFiles.length} file(s); 0 defects found.`,
      hypothesisId: 'H1',
      hypothesisStatus: 'REFUTED',
      evidence: makePlanEvidence('ST-2', ['SOURCE_INSPECTION'], {
        inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
        sourceEvidence: inspectionEvidence.map((entry) => ({
          path: entry.path,
          sourceHash: entry.sourceHash,
          lineRange: entry.lineRange,
        })),
        conclusion: 'No supported defect was established in the inspected sources.',
      }),
    });
    return {
      outcome: 'NO_DEFECT_FOUND',
      phase: 'INVESTIGATE',
      turnId: turn.turnId,
      architecture: projectArch,
      taskPlan,
      inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
      inspectionEvidence: [...inspectionEvidence],
      findings: [],
      taskState: unresolvedObjectiveTaskState('INVESTIGATE'),
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
      message: 'No supported defect pattern was found in the inspected files. The investigation stage ended, but the request remains incomplete because no trusted item-specific objective verifier is available; unexamined or runtime defects are not ruled out.',
    };
  }

  // Inspection confirmed defects
  if (continuation?.token) workflowContinuations.delete(continuation.token);
  if (isCancelled()) return cancelledResult('PLAN');
  // Strict Read-Only / Audit Enforcement: Forbid proposals, writes, and git mutations
  if (modeRouting.mode === 'AUDIT') {
    onProgress({ phase: 'AUDIT', message: 'Read-only audit completed; no changes proposed or applied.' });
    advanceConversationTurn(turn.turnId, 'blocked', owner, { phase: 'objective_coverage_not_established' });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-2',
      status: 'COMPLETED',
      outcome: `Inspected ${inspectedFiles.length} file(s); ${confirmedDefects.length} supported finding(s) retained for read-only audit.`,
      evidence: makePlanEvidence('ST-2', ['SOURCE_INSPECTION'], {
        inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
        sourceEvidence: inspectionEvidence.map((entry) => ({
          path: entry.path,
          sourceHash: entry.sourceHash,
          lineRange: entry.lineRange,
        })),
      }),
    });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-6',
      status: 'IN_PROGRESS',
    });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-6',
      status: 'COMPLETED',
      outcome: `Read-only audit completed with ${confirmedDefects.length} finding(s); repository preserved.`,
      evidence: makePlanEvidence('ST-6', ['PRESERVATION_AUDIT'], {
        preserved: true,
        modifiedFiles: [],
      }),
    });
    return {
      outcome: 'AUDIT_COMPLETED',
      phase: 'AUDIT',
      turnId: turn.turnId,
      architecture: projectArch,
      taskPlan,
      inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
      inspectionEvidence: [...inspectionEvidence],
      findings: confirmedDefects,
      taskState: unresolvedObjectiveTaskState('AUDIT'),
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
      readOnlyPreserved: true,
      message: `The read-only audit retained ${confirmedDefects.length} finding(s) and made zero modifications, but request completion remains unverified because no trusted item-specific objective verifier is available.`,
    };
  }

  if (modeRouting.canApply === false) {
    const outcome = modeRouting.mode === 'INVESTIGATE'
      ? 'INVESTIGATION_COMPLETED'
      : 'READ_ONLY_COMPLETED';
    onProgress({
      phase: modeRouting.mode,
      message: `Read-only ${modeRouting.mode.toLowerCase()} completed with ${confirmedDefects.length} supported finding(s).`,
    });
    advanceConversationTurn(turn.turnId, 'blocked', owner, { phase: 'objective_coverage_not_established' });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-2',
      status: 'COMPLETED',
      outcome: `Inspected ${inspectedFiles.length} file(s); ${confirmedDefects.length} supported finding(s) retained for read-only analysis.`,
      evidence: makePlanEvidence('ST-2', ['SOURCE_INSPECTION'], {
        inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
        sourceEvidence: inspectionEvidence.map((entry) => ({
          path: entry.path,
          sourceHash: entry.sourceHash,
          lineRange: entry.lineRange,
        })),
      }),
    });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-6',
      status: 'IN_PROGRESS',
    });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-6',
      status: 'COMPLETED',
      outcome: `Read-only ${modeRouting.mode.toLowerCase()} completed with ${confirmedDefects.length} supported finding(s); no changes were proposed or applied.`,
      evidence: makePlanEvidence('ST-6', ['PRESERVATION_AUDIT'], {
        preserved: true,
        modifiedFiles: [],
      }),
    });
    return {
      outcome,
      phase: modeRouting.mode,
      turnId: turn.turnId,
      architecture: projectArch,
      taskPlan,
      inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
      inspectionEvidence: [...inspectionEvidence],
      findings: confirmedDefects,
      taskState: unresolvedObjectiveTaskState(modeRouting.mode),
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
      readOnlyPreserved: true,
      message: `Read-only ${modeRouting.mode.toLowerCase()} completed with ${confirmedDefects.length} supported finding(s); no changes were proposed or applied. Request completion remains unverified because no trusted item-specific objective verifier is available.`,
    };
  }

  let assessments;
  try {
    assessments = await assessObjectiveFindings();
  } catch (error) {
    if (isCancelled()) return cancelledResult('INVESTIGATE');
    return incompleteRelevanceResult(
      `Objective-to-finding relevance could not be established: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (isCancelled()) return cancelledResult('INVESTIGATE');
  const supportedFindingIds = new Set(
    assessments
      .filter((item) => item.decision === 'SUPPORTED' && item.unresolvedAssumptions.length === 0)
      .map((item) => item.findingId)
  );
  const objectiveRelevantDefects = confirmedDefects.filter((_finding, index) => (
    supportedFindingIds.has(`finding-${index + 1}`)
  ));
  if (objectiveRelevantDefects.length === 0) {
    const reason = assessments.every((item) => item.decision === 'UNRELATED')
      ? 'The configured provider assessed the inspected findings as unrelated, but no independent source-level causal proof is available; inspect additional references or clarify the target behavior.'
      : 'The available source evidence and cited assessment do not establish a supported relationship between any finding and the requested outcome.';
    return incompleteRelevanceResult(reason, assessments);
  }
  storeObjectiveAssessments(assessments);
  advanceTaskPlan(taskPlan, {
    subtaskId: 'ST-2',
    status: 'COMPLETED',
    outcome: `Inspected ${inspectedFiles.length} file(s); source-cited relevance supports ${objectiveRelevantDefects.length} finding(s).`,
    hypothesisId: 'H1',
    hypothesisStatus: 'SUPPORTED',
    evidence: makePlanEvidence('ST-2', ['SOURCE_INSPECTION'], {
      inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
      sourceEvidence: inspectionEvidence.map((entry) => ({
        path: entry.path,
        sourceHash: entry.sourceHash,
        lineRange: entry.lineRange,
      })),
      supportedFindingIds: [...supportedFindingIds],
      findingEvidence: objectiveRelevantDefects.map((finding) => ({
        filePath: finding.filePath,
        symbol: finding.symbol,
        lines: finding.lines,
      })),
    }),
  });

  if (taskPlan.workItems.length > 1) {
    const reason = 'The request contains multiple explicit work items; the bounded single-defect repair path will not apply a partial proposal. Continue through the standard Coding Agent proposal workflow.';
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-3',
      status: 'BLOCKED',
      outcome: reason,
    });
    delegateWorkItems(reason);
    return {
      outcome: 'IMPLEMENTATION_REQUIRED',
      phase: 'PLAN',
      turnId: turn.turnId,
      architecture: projectArch,
      taskPlan,
      inspectedFiles: [...new Set(inspectionEvidence.map((entry) => entry.path))],
      inspectionEvidence: [...inspectionEvidence],
      findings: objectiveRelevantDefects,
      taskState: createTaskState({
        status: 'INCOMPLETE',
        phase: 'PLAN',
        reason,
        nextAction: {
          tool: 'standard_coding_proposal',
          reason: 'Prepare one proposal that explicitly covers every listed user requirement.',
        },
      }),
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
      reason,
      nextAction: {
        tool: 'standard_coding_proposal',
        reason: 'Prepare one proposal that explicitly covers every listed user requirement.',
      },
    };
  }

  // STAGE 4: PLAN
  onProgress({ phase: 'PLAN', message: 'Generating scoped patch proposal and capturing baseline.' });
  advanceTaskPlan(taskPlan, {
    subtaskId: 'ST-3',
    status: 'IN_PROGRESS',
  });
  const targetFile = objectiveRelevantDefects[0].filePath;
  const originalFile = inspectedFiles.find((f) => f.path === targetFile);
  if (!originalFile) {
    advanceConversationTurn(turn.turnId, 'failed', owner, { phase: 'planning_failed' });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-3',
      status: 'FAILED',
      outcome: `Could not retrieve original content for target file: ${targetFile}`,
    });
    return {
      outcome: 'PLANNING_FAILED',
      phase: 'PLAN',
      turnId: turn.turnId,
      taskPlan,
      error: `Could not retrieve original content for target file: ${targetFile}`,
      filesModified: [],
    };
  }

  const targetLanguage = detectSourceLanguage(targetFile, originalFile.content);

  // Construct minimal, language- and scope-safe fix patch
  let patchedContent = originalFile.content;
  let patchSynthesized = false;
  let abstentionReason = null;

  // 1. Safe debug probe removal (do NOT treat general logging as defect)
  if (objectiveRelevantDefects.some((d) => d.symbol === 'debug_probe')) {
    if (targetLanguage === 'php') {
      const beforeProbe = patchedContent;
      patchedContent = patchedContent
        .replace(/\s*var_dump\([^)]*\);?/g, '')
        .replace(/\s*die\([^)]*\);?/g, '')
        .replace(/\s*print_r\([^)]*\);?/g, '')
        .replace(/\s*dd\([^)]*\);?/g, '');
      if (patchedContent !== beforeProbe) patchSynthesized = true;
    } else if (targetLanguage === 'javascript' || targetLanguage === 'typescript') {
      const beforeProbe = patchedContent;
      patchedContent = patchedContent.replace(/\s*debugger;?/g, '');
      if (patchedContent !== beforeProbe) patchSynthesized = true;
    } else if (targetLanguage === 'python') {
      const beforeProbe = patchedContent;
      patchedContent = patchedContent
        .replace(/\s*breakpoint\(\);?/g, '')
        .replace(/\s*(?:import\s+pdb;\s*)?pdb\.set_trace\(\);?/g, '');
      if (patchedContent !== beforeProbe) patchSynthesized = true;
    } else {
      abstentionReason = `Cannot safely repair debug probe in unsupported or ambiguous language: ${targetLanguage}`;
    }
  }

  // 2. Safe transaction rollback insertion (never inject PHP into non-PHP, never assume transaction variable)
  if (objectiveRelevantDefects.some((d) => d.controlFlow?.includes('Transaction opened') || d.controlFlow?.includes('transaction'))) {
    if (targetLanguage === 'php') {
      const txVarMatch = originalFile.content.match(/\$([A-Za-z0-9_]+)\s*=\s*(?:[A-Za-z0-9_\\$:\->]+\s*->\s*)?beginTransaction\s*\(/i);
      const hasCatchBlock = /catch\s*\([^)]+\)\s*\{[\s\S]*?(?:\n\s*return\b|\n\s*throw\b|\n\s*\})/i.test(originalFile.content);

      if (txVarMatch && hasCatchBlock) {
        const txVarName = txVarMatch[1];
        const beforeTx = patchedContent;
        patchedContent = patchedContent.replace(
          /(catch\s*\([^)]+\)\s*\{)([\s\S]*?)(\n\s*return\b|\n\s*throw\b|\n\s*\})/,
          `$1$2\n            $${txVarName}->rollBack();$3`
        );
        if (patchedContent !== beforeTx) patchSynthesized = true;
      } else if (!txVarMatch) {
        abstentionReason = 'Cannot safely synthesize rollback: transaction variable assignment ($var = ...->beginTransaction()) was not found in target PHP scope.';
      } else {
        abstentionReason = 'Cannot safely synthesize rollback: no standard catch block found in target PHP scope.';
      }
    } else {
      abstentionReason = `Cannot safely synthesize transaction rollback for non-PHP or unverified transaction semantics in language: ${targetLanguage}`;
    }
  }

  // If no safe patch could be constructed or if an abstention condition was met
  if (!patchSynthesized || patchedContent === originalFile.content || abstentionReason) {
    const finalReason = abstentionReason || 'Planning abstained: No safe, language-appropriate patch transformation could be synthesized with verified scope.';
    onProgress({ phase: 'PLAN_ABSTAINED', message: finalReason });
    advanceConversationTurn(turn.turnId, 'failed', owner, { phase: 'planning_abstained', reason: finalReason });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-3',
      status: 'ABSTAINED',
      outcome: finalReason,
    });
    return {
      outcome: 'PLANNING_ABSTAINED',
      phase: 'PLAN',
      turnId: turn.turnId,
      taskPlan,
      reason: finalReason,
      targetLanguage,
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
    };
  }

  const normTarget = targetFile.replace(/\\/g, '/');
  const sourceLines = originalFile.content ? originalFile.content.split(/\r?\n/) : [];
  if (originalFile.content.endsWith('\n') && sourceLines.at(-1) === '') sourceLines.pop();
  const patchedLines = patchedContent ? patchedContent.split(/\r?\n/) : [];
  if (patchedContent.endsWith('\n') && patchedLines.at(-1) === '') patchedLines.pop();

  const rawPatch = [
    `--- a/${normTarget}`,
    `+++ b/${normTarget}`,
    `@@ -1,${sourceLines.length} +1,${patchedLines.length} @@`,
    ...sourceLines.map((l) => `-${l}`),
    ...patchedLines.map((l) => `+${l}`),
    '',
  ].join('\n');

  const beforeSnapshot = await snapshotTarget(root, targetFile);
  const patchScope = validatePatchScope({
    targetFiles: [targetFile],
    acceptanceCriteria: requirementsAnalysis.acceptanceCriteria,
  });

  const task = await createProposal({
    root,
    raw: rawPatch,
    expectedSnapshots: [beforeSnapshot],
    sessionId,
    ownerWebContentsId,
    scope,
    conversationTurnId: turn.turnId,
  });
  if (isCancelled()) {
    cancelTask(task.taskId, owner);
    return cancelledResult('APPROVE', task.taskId);
  }
  advanceTaskPlan(taskPlan, {
    subtaskId: 'ST-3',
    status: 'COMPLETED',
    outcome: `Target patch prepared for ${targetFile}.`,
    evidence: makePlanEvidence('ST-3', ['APPROVED_SCOPE_PROPOSAL'], {
      proposalId: task.taskId,
      targetFile,
      snapshotHash: beforeSnapshot.hash,
      acceptanceCriteria: [...requirementsAnalysis.acceptanceCriteria],
    }),
  });

  // STAGE 5: APPROVE
  onProgress({ phase: 'APPROVE', message: 'Enforcing proposal approval gate.' });
  advanceTaskPlan(taskPlan, {
    subtaskId: 'ST-4',
    status: 'IN_PROGRESS',
  });
  let userApproved = false;
  if (typeof requestApproval === 'function') {
    userApproved = await requestApproval({ taskId: task.taskId, proposal: task, patchScope, diff: rawPatch });
  }
  if (isCancelled()) {
    cancelTask(task.taskId, owner);
    return cancelledResult('APPROVE', task.taskId);
  }
  if (typeof requestApproval !== 'function') {
    advanceConversationTurn(turn.turnId, 'failed', owner, { phase: 'approval_required' });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-4',
      status: 'BLOCKED',
      outcome: 'An explicit user approval callback is required before applying the proposal.',
    });
    return {
      outcome: 'APPROVAL_REQUIRED',
      phase: 'APPROVE',
      taskId: task.taskId,
      turnId: turn.turnId,
      taskPlan,
      reason: 'An explicit user approval callback is required before applying the proposal.',
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
    };
  }

  const gateResult = enforceApprovalGate({
    originalProposalTargets: [targetFile],
    attemptedMutationTargets: task.files.map((f) => f.path),
    operationType: 'APPLY_PATCH',
    userApproved,
  });

  if (!gateResult.allowed) {
    reject(task.taskId, owner);
    const currentTurnState = conversationTurns.get(turn.turnId)?.state;
    if (!['completed', 'failed', 'cancelled'].includes(currentTurnState)) {
      advanceConversationTurn(turn.turnId, 'cancelled', owner, { phase: 'approval_rejected' });
    }
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-4',
      status: 'BLOCKED',
      outcome: gateResult.rejectionReason,
    });
    return {
      outcome: 'APPROVAL_REJECTED',
      phase: 'APPROVE',
      taskId: task.taskId,
      turnId: turn.turnId,
      taskPlan,
      reason: gateResult.rejectionReason,
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
    };
  }

  await approve(task.taskId, owner);
  advanceTaskPlan(taskPlan, {
    subtaskId: 'ST-4',
    status: 'COMPLETED',
    outcome: 'Explicit user approval verified; baseline snapshot captured.',
    evidence: makePlanEvidence('ST-4', ['EXPLICIT_APPROVAL'], {
      proposalId: task.taskId,
      approved: true,
      approvedTargets: [targetFile],
    }),
  });

  // STAGE 6: IMPLEMENT & STAGE 7: TEST
  onProgress({ phase: 'IMPLEMENT', message: 'Applying minimal authorized patch.' });
  advanceTaskPlan(taskPlan, {
    subtaskId: 'ST-5',
    status: 'IN_PROGRESS',
  });
  await captureWorktreeBaseline(task.taskId, root, [targetFile]);
  const authorizeFn = tools?.authorizeMutation || (async (req) => {
    if (req?.proposalApproved) return { allowed: true };
    return { allowed: false, reason: 'Proposal mutation requires approval.' };
  });

  let testOutcome = { status: 'NOT_RUN' };
  const verifyRunner = typeof runCheck === 'function' && selectedChecks.length > 0
    ? async () => {
        onProgress({ phase: 'TEST', message: 'Running safe verification checks.' });
        const loopResult = await runEngineeringLoop({
          taskId: task.taskId,
          owner,
          checks: selectedChecks,
          runCheck,
          proposeFix: async ({ taskId: loopTaskId, owner: loopOwner, diagnosis, observation, attempt }) => {
            if (!effectiveAutoRepair) return null;
            const repairGov = manageRepairLoop({
              approvedTargets: [targetFile],
              attemptCount: attempt - 1,
              maxAttempts: effectiveMaxRepairAttempts,
              autoRepairEnabled: effectiveAutoRepair,
              lastVerificationResult: observation,
              proposedMutationTargets: [targetFile],
            });
            if (!repairGov.allowRepair) {
              onProgress({ phase: 'REPAIR_HALTED', reason: repairGov.reason });
              return null;
            }

            const failureEvidence = {
              exitCode: observation.exitCode ?? 1,
              stderr: observation.stderr || '',
              stdout: observation.stdout || '',
              extracted: observation.extracted || '',
              command: observation.command || '',
            };

            if (typeof tools?.repairHandler === 'function') {
              const customRepair = await tools.repairHandler({
                targetFile,
                originalContent: originalFile.content,
                currentPatch: rawPatch,
                failure: failureEvidence,
                attempt,
              });
              if (!customRepair || !customRepair.patch || customRepair.patch === rawPatch) {
                // Must be a meaningfully different patch; prevent duplicate/repeated failing actions
                return null;
              }
              const repairSnapshot = await snapshotTarget(root, targetFile);
              const repairProposal = await createProposal({
                root,
                raw: customRepair.patch,
                expectedSnapshots: [repairSnapshot],
                sessionId,
                ownerWebContentsId,
                scope,
                conversationTurnId: turn.turnId,
              });
              return repairProposal;
            }
            return null;
          },
          approveFix: async (proposalId, loopOwner) => {
            // Require explicit user approval for repair proposals!
            if (typeof requestApproval === 'function') {
              const repairTask = getTask(proposalId, loopOwner);
              const approved = await requestApproval({
                taskId: proposalId,
                proposal: repairTask,
                isRepair: true,
                patchScope: [targetFile],
                diff: repairTask?.raw,
              });
              if (!approved) return false;
            }
            await approve(proposalId, loopOwner);
            return true;
          },
          applyFix: async (proposalId, loopOwner) => {
            await apply(
              proposalId,
              loopOwner,
              async () => ({
                ok: true,
                status: 'PASS',
                executed: true,
                exitCode: 0,
                attempts: [{ ok: true, executed: true, exitCode: 0, check: selectedChecks[0] || 'test' }],
              }),
              root,
              authorizeFn
            );
          },
          maxAttempts: effectiveAutoRepair ? effectiveMaxRepairAttempts : 1,
          onProgress: (p) => onProgress({ phase: 'TEST_LOOP', ...p }),
          isCancelled: () => isCancelled() || conversationTurns.get(turn.turnId)?.state === 'cancelled',
        });
        testOutcome = loopResult;
        const finalCheckCount = selectedChecks.length || 1;
        const attemptsToReport = loopResult.status === 'PASS'
          ? (Array.isArray(loopResult.attempts) ? loopResult.attempts.slice(-finalCheckCount) : [])
          : (loopResult.attempts || []);
        const lastReportedAttempt = attemptsToReport.at(-1);
        return {
          ok: loopResult.status === 'PASS',
          status: loopResult.status,
          executed: attemptsToReport.some((attempt) => attempt?.executed === true),
          exitCode: loopResult.status === 'PASS'
            ? 0
            : lastReportedAttempt?.executed === true && Number.isInteger(lastReportedAttempt.exitCode)
              ? lastReportedAttempt.exitCode
              : null,
          cancelled: loopResult.status === 'CANCELLED',
          attempts: attemptsToReport,
        };
      }
    : (async () => {
        testOutcome = { status: 'VERIFICATION_UNAVAILABLE', reason: 'No test runner provided or offline.' };
        return {
          ok: false,
          status: 'UNVERIFIED',
          executed: false,
          exitCode: null,
          reason: testOutcome.reason,
          attempts: [],
        };
      });

  try {
    await apply(task.taskId, owner, verifyRunner, root, authorizeFn);
  } catch (error) {
    const taskState = getTaskForTest(task.taskId);
    const wasCancelled = error?.cancelled === true
      || taskState?.cancelRequested === true
      || taskState?.state === 'cancelled';
    const failedDuringImplement = !testOutcome || testOutcome.status === 'NOT_RUN';
    const rollbackFailed = Boolean(taskState?.error?.includes('Rollback verification failed'));
    const verificationStatus = wasCancelled
      ? 'CANCELLED'
      : failedDuringImplement
        ? 'NOT_RUN'
        : testOutcome.status;
    const verificationBlocked = ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(verificationStatus);
    const outcome = wasCancelled
      ? 'CANCELLED'
      : failedDuringImplement
        ? 'APPLY_FAILED'
        : verificationBlocked
          ? 'VERIFICATION_BLOCKED'
        : (verificationStatus === 'VERIFICATION_UNAVAILABLE' || testOutcome?.status === 'VERIFICATION_UNAVAILABLE')
          ? 'VERIFICATION_UNAVAILABLE'
          : (verificationStatus === 'SKIPPED' || testOutcome?.status === 'SKIPPED')
            ? 'SKIPPED'
            : 'TEST_FAILED';
    const phase = wasCancelled ? 'CANCELLED' : failedDuringImplement ? 'IMPLEMENT' : 'VERIFY';
    const currentTurnState = conversationTurns.get(turn.turnId)?.state;
    if (!['completed', 'failed', 'cancelled'].includes(currentTurnState)) {
      advanceConversationTurn(turn.turnId, outcome === 'CANCELLED' ? 'cancelled' : 'failed', owner, {
        phase: outcome.toLowerCase(),
      });
    }
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-5',
      status: verificationBlocked ? 'BLOCKED' : 'FAILED',
      outcome: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome,
      phase,
      taskId: task.taskId,
      turnId: turn.turnId,
      taskPlan,
      verificationStatus,
      codeApplied: rollbackFailed,
      codeVerified: false,
      filesModified: rollbackFailed ? task.files.map((f) => f.path) : [],
      rollbackFailed,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // STAGE 8-11: DIAGNOSE & REPAIR summary
  if (testOutcome.status !== 'PASS' && testOutcome.status !== 'VERIFICATION_UNAVAILABLE') {
    const repairGov = manageRepairLoop({
      approvedTargets: [targetFile],
      attemptCount: testOutcome.fixes || 0,
      maxAttempts: effectiveMaxRepairAttempts,
      autoRepairEnabled: effectiveAutoRepair,
      lastVerificationResult: testOutcome,
      proposedMutationTargets: [targetFile],
    });

    if (!repairGov.allowRepair) {
      onProgress({ phase: 'REPAIR_HALTED', reason: repairGov.reason });
    }
  }

  // STAGE 12: AUDIT & REPORT
  onProgress({ phase: 'AUDIT', message: 'Auditing modified files and verifying worktree preservation.' });
  const auditResult = await verifyDirtyWorktreePreserved(task.taskId, [targetFile]);
  const isPassing = testOutcome.status === 'PASS';
  if (isPassing) {
    const finalVerificationAttempts = Array.isArray(testOutcome.attempts)
      ? testOutcome.attempts.slice(-Math.max(1, selectedChecks.length))
      : [];
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-5',
      status: 'COMPLETED',
      outcome: 'Verification tests passed truthfully.',
      evidence: makePlanEvidence('ST-5', ['VERIFICATION_PASS'], {
        status: 'PASS',
        exitCode: 0,
        isPassing: true,
        executed: finalVerificationAttempts.length > 0
          && finalVerificationAttempts.every((attempt) => attempt?.executed === true && attempt?.exitCode === 0),
        attempts: finalVerificationAttempts,
        proposalId: task.taskId,
        checkResults: selectedChecks,
        provenance: 'AUTHORIZED_VERIFICATION_RUNNER',
      }),
    });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-6',
      status: 'IN_PROGRESS',
    });
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-6',
      status: 'COMPLETED',
      outcome: `Preservation audit verified; files modified: ${task.files.map((f) => f.path).join(', ')}.`,
      evidence: makePlanEvidence('ST-6', ['PRESERVATION_AUDIT'], {
        preserved: auditResult?.ok === true,
        modifiedFiles: task.files.map((file) => file.path),
        auditResult,
      }),
    });
  } else {
    advanceTaskPlan(taskPlan, {
      subtaskId: 'ST-5',
      status: 'FAILED',
      outcome: `Verification status: ${testOutcome.status}`,
    });
  }
  const currentTurn = conversationTurns.get(turn.turnId);
  const workItemCoverageEstablished = taskPlan.workItems.every((item) => (
    item.status === 'COMPLETED' || item.status === 'SKIPPED'
  ));
  const outcome = isPassing && !workItemCoverageEstablished
    ? 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'
    : isPassing
      ? 'SUCCESS'
      : testOutcome.status === 'VERIFICATION_UNAVAILABLE'
        ? 'VERIFICATION_UNAVAILABLE'
        : 'TEST_FAILED';
  if (currentTurn && currentTurn.state !== 'completed') {
    advanceConversationTurn(turn.turnId, outcome === 'SUCCESS' ? 'completed' : outcome === 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED' ? 'blocked' : 'failed', owner, {
      phase: outcome === 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'
        ? 'item_coverage_not_established'
        : isPassing ? 'completed' : (testOutcome.status || 'unverified').toLowerCase(),
      fileCount: task.files.length,
    });
  }

  return {
    outcome,
    phase: isPassing ? 'AUDIT' : 'VERIFY',
    taskId: task.taskId,
    turnId: turn.turnId,
    taskPlan,
    filesModified: task.files.map((f) => f.path),
    codeApplied: true,
    codeVerified: isPassing,
    verificationStatus: testOutcome.status,
    worktreeAudit: auditResult,
    requirements: requirementsAnalysis,
    message: outcome === 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'
      ? 'The approved proposal was applied and verification passed, but trusted item-specific evidence did not establish that every request objective was satisfied. The task plan remains blocked.'
      : isPassing ? 'The approved proposal was applied and verification passed.' : 'Verification did not pass.',
  };
}

function getTaskForTest(taskId) { return registry.get(taskId); }
function isCancellationRequested(taskId, owner) {
  const task = getTask(taskId, owner);
  return Boolean(task.cancelRequested);
}
function steerTask(taskId, { action, direction, newGoal }, owner) {
  const task = getTask(taskId, owner);
  if (action === 'pause') {
    return pauseTask(taskId, owner);
  }
  if (action === 'resume') {
    return resumeTask(taskId, null, owner);
  }
  if (action === 'change_direction' && newGoal) {
    saveTaskCheckpoint(taskId, 'pre_steering', { oldGoal: task.goal }, owner);
    task.goal = newGoal;
    task.updatedAt = now();
    recordMutation(task, 'task_steered', { newGoal, direction });
    return publicTask(task);
  }
  return publicTask(task);
}

function forkTask(taskId, strategyName, owner) {
  const task = getTask(taskId, owner);
  return taskOrchestrator.forkTask(taskId, strategyName);
}

function createTaskArtifact({ taskId, type, content, phase, sourceEvidence }, owner) {
  const task = getTask(taskId, owner);
  const artifact = artifactEngine.createArtifact({
    taskId,
    type,
    content,
    phase: phase || task.state,
    sourceEvidence,
  });
  task.artifacts = artifactEngine.getArtifacts(taskId);
  return artifact;
}

function getTaskArtifacts(taskId, owner) {
  getTask(taskId, owner);
  return artifactEngine.getArtifacts(taskId);
}

async function verifyTaskBrowser(taskId, options = {}, owner) {
  const task = getTask(taskId, owner);
  const result = await browserVerifier.verifyEndpoint(options);
  if (result.ok) {
    createTaskArtifact({
      taskId,
      type: ARTIFACT_TYPES.BROWSER_EVIDENCE,
      content: result,
      phase: 'browser_verify',
    }, owner);
  }
  return result;
}

async function manageDevServer(taskId, action, projectRoot, owner) {
  const task = getTask(taskId, owner);
  const approvedRoot = await fs.realpath(task.root);
  if (projectRoot && (await fs.realpath(projectRoot)) !== approvedRoot) {
    throw new Error('Dev server project root does not match the approved task project.');
  }
  if (action === 'start') {
    return devServerManager.startDevServer(taskId, approvedRoot);
  }
  if (action === 'stop') {
    return devServerManager.stopDevServer(taskId);
  }
  return devServerManager.getActiveServer(taskId);
}

function inspectPatchSecurity(rawPatch) {
  return verificationOrchestrator.inspectSecurityGates(rawPatch);
}

function listSkills() {
  return skillSystem.listSkills();
}

function getSkill(id) {
  return skillSystem.getSkill(id);
}

function assignTaskSkill(taskId, skillId, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.assignSkill(taskId, skillId);
}

function setTaskOperatingMode(taskId, mode, complexity, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.setOperatingMode(taskId, mode, complexity);
}

function listMcpTools() {
  return mcpToolAdapter.listTools();
}

async function invokeTaskMcpTool(taskId, toolName, params, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.invokeMcpTool(taskId, toolName, params);
}

function getOperatingModes() {
  return OPERATING_MODES;
}

function getComplexityLevels() {
  return COMPLEXITY_LEVELS;
}

function configureCheckpointStorageRoot(root) {
  taskOrchestrator.setCheckpointStorageRoot(root);
}

async function saveTaskCheckpointToDisk(taskId, milestone = 'generic', owner) {
  getTask(taskId, owner);
  return taskOrchestrator.saveCheckpointToDisk(taskId, milestone);
}

async function restoreTaskFromDisk(taskId, owner, expectedRoot) {
  if (!owner?.sessionId || !Number.isInteger(owner.ownerWebContentsId)) {
    throw new Error('Developer session ownership is required to restore a checkpoint.');
  }
  if (typeof expectedRoot !== 'string' || !expectedRoot) {
    throw new Error('The selected project root is required to restore a checkpoint.');
  }
  const restored = await taskOrchestrator.restoreTaskFromDisk(taskId, owner.sessionId, expectedRoot);
  restored.ownerWebContentsId = owner.ownerWebContentsId;
  if (restored && restored.taskId && !registry.has(restored.taskId)) {
    registry.set(restored.taskId, {
      taskId: restored.taskId,
      sessionId: owner.sessionId,
      ownerWebContentsId: owner.ownerWebContentsId,
      state: restored.state || 'idle',
      targets: restored.targets || [],
      files: (restored.targets || []).map((t) => ({ path: t, hash: '' })),
      before: [],
      findings: restored.findings || [],
      hypotheses: restored.hypotheses || [],
      rejectedHypotheses: restored.rejectedHypotheses || [],
      approvalState: restored.approvalState || 'UNAPPROVED',
      plan: restored.plan || [],
      workspace: { root: restored.workspace || '.' },
      createdAt: restored.createdAt || now(),
      updatedAt: restored.updatedAt || now(),
    });
  }
  return restored;
}

async function validateTaskContextFreshness(taskId, targetSnapshots = [], owner) {
  getTask(taskId, owner);
  return taskOrchestrator.validateContextFreshness(taskId, targetSnapshots);
}

function refuteTaskHypothesis(taskId, text, evidence = {}, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.refuteHypothesis(taskId, text, evidence);
}

function getMultiRepoRollbackPlan(taskId, owner) {
  getTask(taskId, owner);
  return multiRepoCoordinator.getRollbackPlan(taskId);
}

async function rollbackMultiRepo(taskId, owner, authorize) {
  const task = getTask(taskId, owner);
  if (!task.root) throw new Error('Multi-repository rollback has no approved project root.');
  if (typeof authorize !== 'function') {
    throw new Error('Multi-repository rollback requires the authoritative mutation policy.');
  }
  const result = await multiRepoCoordinator.rollbackMultiRepoChanges(taskId, authorize);
  recordMutation(task, 'multi_repo_rollback_completed', {
    rolledBackRepos: result.rolledBackRepos,
  });
  return result;
}

function getTaskHeartbeat(taskId, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.getTaskHeartbeat(taskId);
}

function handleClientDisconnect(taskId, clientId, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.handleClientDisconnect(taskId, clientId);
}

function handleClientReconnect(taskId, clientId, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.handleClientReconnect(taskId, clientId);
}

function replayTaskEvents(taskId, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.replayTaskEvents(taskId);
}

async function executeParallelWorkers(taskId, workerConfigs, workerRunnerFn, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.executeParallelWorkers(taskId, workerConfigs, workerRunnerFn);
}

function cancelWorker(taskId, workerId, reason, owner) {
  getTask(taskId, owner);
  return taskOrchestrator.cancelWorker(taskId, workerId, reason);
}

async function captureWorktreeBaseline(taskId, repoRoot, files = []) {
  return dirtyWorktreeProtector.capturePreExistingBaseline(taskId, repoRoot, files);
}

async function verifyDirtyWorktreePreserved(taskId, agentFiles = []) {
  return dirtyWorktreeProtector.verifyDirtyWorktreePreserved(taskId, agentFiles);
}

function calculateAgentDelta(preSnapshots = [], postSnapshots = []) {
  return dirtyWorktreeProtector.calculateAgentDelta(preSnapshots, postSnapshots);
}

function defineHiddenContract(taskId, contract, owner) {
  getTask(taskId, owner);
  return correctnessOracle.defineHiddenContract(taskId, contract);
}

async function evaluateIndependentCorrectness(taskId, patchPayload, workspaceContext, owner) {
  getTask(taskId, owner);
  return correctnessOracle.evaluateIndependentCorrectness(taskId, patchPayload, workspaceContext);
}

function evaluatePatchQuality(diffText, modifiedFiles, targetScope) {
  return patchQualityEngine.evaluatePatchQuality(diffText, modifiedFiles, targetScope);
}

function reviewDiffIndependently(diffText, taskGoal, modifiedFiles) {
  return diffReviewer.reviewDiffIndependently(diffText, taskGoal, modifiedFiles);
}

async function verifyMutationTest(buggyRunnerFn, repairedRunnerFn, mutationFn, testRunnerFn, context) {
  const baseline = await mutationHarness.verifyBuggyBaselineFails(buggyRunnerFn, context);
  const mutation = await mutationHarness.verifyMutationCatchesFault(repairedRunnerFn, mutationFn, testRunnerFn, context);
  return { baseline, mutation };
}

function diagnoseFailureType(errorOutput, exitCode, environmentState) {
  return defectClassifier.diagnoseFailureType(errorOutput, exitCode, environmentState);
}

function inspectEdgeCasesAndContract(symbolInfo, preInterface, postInterface) {
  const edgeCases = edgeCaseValidator.identifyEdgeCaseRequirements(symbolInfo);
  const contract = edgeCaseValidator.verifyContractPreservation(symbolInfo?.name || 'unknown', preInterface, postInterface);
  return { edgeCases, contract };
}

function verifyTaskBlindness(taskId, owner) {
  const task = getTask(taskId, owner);
  const hiddenContract = correctnessOracle._hiddenContracts?.get(taskId) || null;
  return blindnessGuard.verifyTaskBlindness(task, hiddenContract);
}

function attemptOracleDiscovery(taskId) {
  return blindnessGuard.attemptOracleDiscovery(taskId, {
    getTask: (id) => publicTask(getTask(id)),
  });
}

function adjudicateWorkerConflict(workerA, workerB, repositoryEvidence) {
  return workerConflictAdjudicator.adjudicateConflict(workerA, workerB, repositoryEvidence);
}

function classifyRealityLevel(executionTrace) {
  return realityLevelEvaluator.classifyRealityLevel(executionTrace);
}

function revalidateBusinessTask(taskDef) {
  return businessRevalidationEngine.revalidateTask(taskDef);
}

function redlineBusinessClaim(claim) {
  return businessRevalidationEngine.redlineClaim(claim);
}

function resetForTest() {
  registry.clear(); sessions.clear(); conversationTurns.clear(); locked = false; lockDepth = 0; lockOwnerTurnId = null; journalError = null; auditError = null;
  journalQueue = Promise.resolve(); auditQueue = Promise.resolve();
}

module.exports = {
  STATES, STATE_ALIASES, transitions, createSession, getSession, cancelSession, beginConversationTurn, inspectDatabaseRequest, advanceConversationTurn, recordConversationFindings, getConversationTurn, validateConversationToolContext, createProposal, approve, reject, apply, undo,
  getTask: (id, owner) => publicTask(getTask(id, owner)), getTaskForTest, getTaskMutationContext, getProposalAuthorizationContext, normalizeCommandResult,
  classifyFailure, classifyFailureCategory, commandPolicy, selectVerificationChecks, extractFailure, normalizeObservation,
  diagnoseObservation, executeVerificationLoop, runVerificationChecks, runEngineeringLoop, isCancellationRequested,
  verificationFailureFromError,
  configureDurability, loadJournal,
  flushDurability, resumeSession, releaseSession, resetForTest, parsePatch, applyFilePatch,
  assessTaskRisk, selfReviewPatch, classifyVerificationFailure,
  saveTaskCheckpoint, restoreTaskCheckpoint, pauseTask, resumeTask, cancelTask,
  steerTask, forkTask, createTaskArtifact, getTaskArtifacts, verifyTaskBrowser, manageDevServer, inspectPatchSecurity,
  listSkills, getSkill, assignTaskSkill, setTaskOperatingMode, listMcpTools, invokeTaskMcpTool, getOperatingModes, getComplexityLevels,
  configureCheckpointStorageRoot, saveTaskCheckpointToDisk, restoreTaskFromDisk,
  validateTaskContextFreshness, refuteTaskHypothesis,
  getMultiRepoRollbackPlan, rollbackMultiRepo,
  getTaskHeartbeat, handleClientDisconnect, handleClientReconnect, replayTaskEvents,
  executeParallelWorkers, cancelWorker,
  captureWorktreeBaseline, verifyDirtyWorktreePreserved, calculateAgentDelta,
  defineHiddenContract, evaluateIndependentCorrectness, evaluatePatchQuality, reviewDiffIndependently,
  verifyMutationTest, diagnoseFailureType, inspectEdgeCasesAndContract,
  verifyTaskBlindness, attemptOracleDiscovery, adjudicateWorkerConflict, classifyRealityLevel,
  CLASSIFICATION_CONFIRMED, CLASSIFICATION_LIKELY, CLASSIFICATION_UNVERIFIED, CLASSIFICATION_NOT_A_BUG,
  VALID_SUBTASK_STATUSES, VALID_HYPOTHESIS_STATUSES, LEGAL_SUBTASK_TRANSITIONS, LEGAL_HYPOTHESIS_TRANSITIONS,
  classifyDefect, traceExecutionFlow, validateEvidenceReport, validatePatchScope, enforceApprovalGate,
  analyzeTaskRequirements, planProgressiveSearch, discoverProjectArchitecture, executeToolWithSafeguards, manageRepairLoop,
  createTaskPlan,
  advanceTaskPlan,
  detectSourceLanguage,
  executeAutonomousCodingWorkflow, isSuccessfulVerificationResult, isSuccessfulVerificationAttempt, normalizeVerificationStatus,
};
