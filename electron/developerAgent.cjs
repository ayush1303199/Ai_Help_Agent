const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { developer: developerSettings } = require('../src/config/runtimeSettings.json');
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
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SENSITIVE_PATH_PATTERN = /(?:^|[\\/])(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.config|id_rsa(?:\..*)?|[^\\/]+\.(?:pem|key|p12|pfx|crt|cer|der))$/i;
const registry = new Map();
const sessions = new Map();
const conversationTurns = new Map();
let locked = false;
let journalPath = null;
let auditPath = null;
let journalQueue = Promise.resolve();
let auditQueue = Promise.resolve();
let journalError = null;
let auditError = null;
let eventSequence = 0;

function now() { return new Date().toISOString(); }
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
  return bounded(value).replace(/(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi, '[REDACTED]');
}
function journalTask(task) {
  return {
    ...task,
    raw: undefined,
    ownerWebContentsId: undefined,
    error: bounded(task.error, 1000),
    progress: redact(task.progress),
    verification: redact(task.verification),
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
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.writeFile(temp, payload, 'utf8');
      await renameWithRetry(temp, targetPath);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
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
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, `${JSON.stringify(event)}\n`, 'utf8');
  }).catch((error) => { auditError = error; });
  return auditQueue;
}
function recordMutation(task, type, details) {
  persistJournal(type);
  auditEvent(type, task, details);
}
function transition(task, next) {
  if (!transitions[task.state]?.includes(next)) throw new Error(`Invalid task transition: ${task.state} -> ${next}`);
  const previous = task.state;
  task.state = next; task.updatedAt = now();
  recordMutation(task, 'state_transition', { from: previous, to: next });
  if (task.conversationTurnId) {
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
function beginConversationTurn({ root, scope = '.', request, sessionId, ownerWebContentsId }) {
  if (!sessionId || ownerWebContentsId === undefined) throw new Error('Developer session ownership is required.');
  if (typeof request !== 'string' || !request.trim()) throw new Error('Coding request must be a non-empty string.');
  if (request.length > developerSettings.maxRequestChars) {
    throw new Error(
      `Coding request is too long (${request.length} characters; maximum ${developerSettings.maxRequestChars}). Shorten the current request or start a new Coding conversation.`,
    );
  }
  const turn = {
    turnId: crypto.randomUUID(), sessionId, ownerWebContentsId, root, scope,
    state: 'reading', createdAt: now(), updatedAt: now(),
  };
  conversationTurns.set(turn.turnId, turn);
  recordMutation(turn, 'conversation_turn_started', { scope });
  return { turnId: turn.turnId, state: turn.state, sessionId: turn.sessionId };
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
function advanceConversationTurn(turnId, next, owner, details = {}) {
  const turn = conversationTurns.get(turnId);
  assertConversationOwner(turn, owner);
  const allowed = {
    reading: ['understanding', 'completed', 'failed', 'cancelled'],
    understanding: ['proposal_ready', 'completed', 'failed', 'cancelled'],
    proposal_ready: ['awaiting_approval', 'failed', 'cancelled'],
    awaiting_approval: ['approved', 'failed', 'cancelled'],
    approved: ['applying', 'failed', 'cancelled'],
    applying: ['verifying', 'recovering', 'failed', 'cancelled'],
    verifying: ['completed', 'recovering', 'failed', 'cancelled'],
    recovering: ['failed', 'verifying', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
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
async function acquireLock() {
  if (locked) throw new Error('Another Developer task is already applying.');
  locked = true;
  return () => { locked = false; };
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
      if (task.state !== 'applying' && task.state !== 'verifying') transition(task, 'cancelled');
      recordMutation(task, 'cancelled', {});
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
    workspace: task.workspace, files: (task.files || []).map(({ path, hash: fileHash }) => ({ path, hash: fileHash })),
    targetFiles: (task.files || []).map(({ path }) => path),
    snapshotHashes: (task.before || []).map(({ path, hash: fileHash }) => ({ path, hash: fileHash })),
    approval: task.approval ? { approvedAt: task.approval.approvedAt, actor: task.approval.actor } : null,
    progress: task.progress, verification: task.verification || null, verificationScript: task.verificationScript || null,
    verificationScripts: task.verificationScripts || [],
    scope: task.scope || '.',
    outcome: task.outcome || null, error: task.error || null,
    runtime: runtimeState(task),
    durability: { journalError: journalError?.message || null, auditError: auditError?.message || null },
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
async function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Proposal paths must be relative.');
  const clean = relative.replace(/\\/g, '/');
  if (clean.split('/').includes('..') || clean.startsWith('/')) throw new Error('Proposal path traversal is denied.');
  if (SENSITIVE_PATH_PATTERN.test(clean)) throw new Error('Sensitive files cannot be changed by the Coding Agent.');
  const target = path.resolve(root, clean);
  let entry;
  try { entry = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entry?.isSymbolicLink()) throw new Error('Symlink proposal targets are denied.');
  const real = await fs.realpath(target).catch((error) => { throw new Error(error.code === 'ENOENT' ? 'Proposal files must already exist.' : error.message); });
  if (!inside(root, real)) throw new Error('Proposal path is outside the selected project.');
  const stat = await fs.lstat(real);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Symlink and non-file proposal targets are denied.');
  return { relative: clean, target: real };
}
async function snapshot(root, relative) {
  const safe = await safePath(root, relative);
  const content = await fs.readFile(safe.target, 'utf8');
  return { path: safe.relative, hash: hash(content), content };
}
function parsePatch(raw) {
  if (typeof raw !== 'string' || raw.length > developerSettings.proposalMaxBytes) throw new Error('Proposal is invalid or too large.');
  if (/^\s*NO_CHANGES\s*$/i.test(raw)) return [];
  const lines = raw.replace(/^```(?:diff|patch)?\s*/i, '').replace(/\s*```\s*$/, '').split(/\r?\n/);
  const files = []; let current;
  for (const line of lines) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) { current = { path: header[1], lines: [] }; files.push(current); }
    else if (current && (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '\\ No newline at end of file')) current.lines.push(line);
  }
  if (!files.length || files.some((file) => !file.lines.some((line) => line.startsWith('@@')))) throw new Error('Proposal must be a unified diff.');
  return files;
}
function applyFilePatch(original, lines) {
  const source = original.split(/\r?\n/); const output = []; let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/);
    if (!header) continue;
    const start = Number(header[1]) - 1;
    if (start < cursor || start > source.length) throw new Error('Patch context is stale.');
    output.push(...source.slice(cursor, start)); cursor = start; let consumed = 0;
    for (i += 1; i < lines.length && !lines[i].startsWith('@@'); i += 1) {
      const line = lines[i];
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ')) { if (source[cursor] !== line.slice(1)) throw new Error('Patch context does not match.'); output.push(source[cursor++]); consumed += 1; }
      else if (line.startsWith('-')) { if (source[cursor] !== line.slice(1)) throw new Error('Patch removal does not match.'); cursor += 1; consumed += 1; }
      else if (line.startsWith('+')) output.push(line.slice(1)); else throw new Error('Invalid patch hunk.');
    }
    if (Number(header[2] || 1) !== consumed) throw new Error('Patch hunk line count is invalid.');
    i -= 1;
  }
  output.push(...source.slice(cursor));
  return output.join('\n');
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
    if (SENSITIVE_PATH_PATTERN.test(file.path)) {
      issues.push(`Forbidden file in patch: ${file.path}`);
    }
    const additions = file.lines.filter((l) => l.startsWith('+')).length;
    const deletions = file.lines.filter((l) => l.startsWith('-')).length;
    if (additions === 0 && deletions === 0) {
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

function cancelTask(taskId, owner) {
  const task = getTask(taskId, owner);
  task.cancelRequested = true;
  if (transitions[task.state]?.includes('cancelled')) {
    transition(task, 'cancelled');
  } else {
    task.state = 'cancelled';
    task.updatedAt = now();
    recordMutation(task, 'task_cancelled', { at: now() });
  }
  return publicTask(task);
}

async function createProposal({
  root: inputRoot, raw, expectedSnapshots = [], sessionId, ownerWebContentsId,
  workspace = {}, verificationScript = null, verificationScripts = [], scope = '.', conversationTurnId = null,
}) {
  if (!sessionId || ownerWebContentsId === undefined) throw new Error('Developer session ownership is required.');
  const root = await fs.realpath(inputRoot);
  if (conversationTurnId) {
    const turn = conversationTurns.get(conversationTurnId);
    assertConversationOwner(turn, { sessionId, ownerWebContentsId });
    if (turn.state !== 'understanding' || await fs.realpath(turn.root) !== root || turn.scope !== scope) {
      throw new Error('Coding conversation is not ready to register a proposal for this project scope.');
    }
  }
  if (verificationScript !== null) commandPolicy(verificationScript);
  const requestedScripts = [
    ...(Array.isArray(verificationScripts) ? verificationScripts : []),
    ...(verificationScript ? [verificationScript] : []),
  ];
  const safeVerificationScripts = [...new Set(requestedScripts.map((script) => commandPolicy(script).script))];
  const files = parsePatch(raw); const unique = new Set(); const before = []; const changes = [];
  for (const file of files) {
    if (unique.has(file.path)) throw new Error('Proposal contains duplicate files.');
    unique.add(file.path);
    const current = await snapshot(root, file.path);
    const expected = expectedSnapshots.find((item) => item.path.replace(/\\/g, '/') === current.path);
    if (expected && expected.hash !== current.hash) throw new Error(`Snapshot is stale for ${current.path}.`);
    const after = applyFilePatch(current.content, file.lines);
    if (after === current.content) throw new Error(`Proposal has no change for ${current.path}.`);
    before.push({ path: current.path, hash: current.hash, content: current.content });
    changes.push({ path: current.path, hash: hash(after), content: after });
  }
  const task = {
    taskId: crypto.randomUUID(), sessionId, ownerWebContentsId, root,
    conversationTurnId,
    scope: scope || '.',
    proposalId: crypto.randomUUID(),
    workspace: { root, name: workspace.name || path.basename(root), branch: workspace.branch || null },
    raw, files: changes, before,
    verificationScript: safeVerificationScripts[0] || null,
    verificationScripts: safeVerificationScripts,
    state: 'proposal_ready', progress: { phase: 'proposal', message: 'Validated proposal.', at: now() },
    runtime: {
      phase: 'PROPOSING',
      taskState: 'PROPOSING',
      planVersion: 1,
      plan: { goal: 'Validate and propose a minimal safe code change.', tasks: ['Inspect relevant files', 'Validate proposed change', 'Await approval', 'Apply and verify'] },
      taskGraph: null,
      assumptions: [],
      observations: [{ kind: 'PROPOSAL_CREATED', files: changes.map((entry) => entry.path) }],
      metrics: { toolCalls: 0, usefulToolCalls: 0, duplicateToolCalls: 0, unnecessaryToolCalls: 0, filesRead: before.length, filesChanged: changes.length, verificationRuns: 0, repairAttempts: 0, confidence: 'MEDIUM' },
      taskMemory: { goal: 'Validate and propose a minimal safe code change.', constraints: ['read-only until explicit approval', 'project-root confinement'], filesInspected: before.map((entry) => entry.path), importantFindings: [], plannedChanges: ['validated proposal', 'approval gate'], proposalIds: [], verificationResults: [], failures: [], repairRounds: 0 },
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
    goal: task.runtime?.plan?.goal || 'Validate and propose a minimal safe code change.',
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
function approve(taskId, owner) {
  const task = getTask(taskId, owner);
  if (task.state !== 'awaiting_approval') throw new Error('Only a proposal awaiting approval can be approved.');
  task.approval = { approvedAt: now(), actor: 'renderer-session' };
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
async function writeAndVerify(task, files) {
  const written = [];
  const temporary = [];
  try {
    for (const file of files) {
      const safe = await safePath(task.root, file.path);
      const temp = `${safe.target}.developer-${task.taskId}.tmp`;
      temporary.push(temp);
      await fs.writeFile(temp, file.content, 'utf8');
      await fs.rename(temp, safe.target); written.push(file);
    }
    const resulting = await Promise.all(files.map((file) => snapshot(task.root, file.path)));
    if (resulting.some((item, index) => item.hash !== files[index].hash)) throw new Error('Post-apply verification failed.');
  } catch (error) {
    await Promise.all(temporary.map((temp) => fs.rm(temp, { force: true }).catch(() => {})));
    for (const file of written) {
      const safe = await safePath(task.root, file.path);
      const original = task.before.find((item) => item.path === file.path);
      const rollbackTemp = `${safe.target}.developer-rollback-${task.taskId}.tmp`;
      try {
        await fs.writeFile(rollbackTemp, original.content, 'utf8');
        await fs.rename(rollbackTemp, safe.target);
      } finally {
        await fs.rm(rollbackTemp, { force: true }).catch(() => {});
      }
    }
    const restored = await Promise.all(written.map((file) => snapshot(task.root, file.path)));
    if (restored.some((item, index) => item.hash !== task.before.find((before) => before.path === written[index].path).hash)) {
      throw new Error(`Apply failed and rollback verification failed: ${error.message}`);
    }
    throw error;
  }
}
async function restoreBeforeSnapshot(task) {
  const temporary = [];
  try {
    for (const file of task.before) {
      const safe = await safePath(task.root, file.path);
      const temp = `${safe.target}.developer-recovery-${task.taskId}.tmp`;
      temporary.push(temp);
      await fs.writeFile(temp, file.content, 'utf8');
      await fs.rename(temp, safe.target);
    }
    const restored = await Promise.all(task.before.map((item) => snapshot(task.root, item.path)));
    if (restored.some((item, index) => item.hash !== task.before[index].hash)) {
      throw new Error('Rollback verification failed.');
    }
  } finally {
    await Promise.all(temporary.map((temp) => fs.rm(temp, { force: true }).catch(() => {})));
  }
}
async function apply(taskId, owner, verifyRunner, expectedRoot = null) {
  const task = getTask(taskId, owner);
  if (task.state !== 'approved') throw new Error('Proposal must be approved exactly once.');
  if (expectedRoot && (await fs.realpath(expectedRoot)) !== task.root) throw new Error('The selected project changed after this proposal was created.');
  const release = await acquireLock();
  task.transactionId = crypto.randomUUID();
  let patchApplied = false;
  let writeStarted = false;
  recordMutation(task, 'transaction_started', { transactionId: task.transactionId });
  try {
    await multiRepoCoordinator.captureBaselineSnapshot(task.taskId, task.root);
    transition(task, 'applying');
    task.runtime = task.runtime || {};
    task.runtime.phase = 'APPLYING';
    task.runtime.taskState = 'APPLYING';
    task.runtime.history = [...(task.runtime.history || []), { phase: 'APPLYING', at: now(), message: 'Applying validated patch.' }].slice(-developerSettings.maxStateHistoryEntries);
    task.runtime.lastUpdated = now();
    progress(task, 'apply', 'Applying validated patch.');
    const current = await Promise.all(task.before.map((item) => snapshot(task.root, item.path)));
    if (current.some((item, index) => item.hash !== task.before[index].hash)) throw new Error('Files changed after approval.');
    if (task.cancelRequested) { transition(task, 'cancelled'); return publicTask(task); }
    writeStarted = true;
    await writeAndVerify(task, task.files);
    patchApplied = true;
    if (task.cancelRequested) throw Object.assign(new Error('Developer task was cancelled before verification.'), { cancelled: true });
    transition(task, 'verifying');
    task.runtime = task.runtime || {};
    task.runtime.phase = 'VERIFYING';
    task.runtime.taskState = 'VERIFYING';
    task.runtime.history = [...(task.runtime.history || []), { phase: 'VERIFYING', at: now(), message: 'Running approved verification.' }].slice(-developerSettings.maxStateHistoryEntries);
    task.runtime.lastUpdated = now();
    progress(task, 'verify', 'Running approved verification.');
    if (verifyRunner) {
      const result = await verifyRunner();
      task.verification = result;
      recordMutation(task, 'verification_recorded', {
        transactionId: task.transactionId, attempt: 1,
        result: result?.status || result?.failure || (result?.ok ? 'pass' : 'failure'),
      });
      if (task.cancelRequested || result?.cancelled) {
        throw Object.assign(new Error('Developer task was cancelled during verification.'), { cancelled: true });
      }
      if (!result?.ok) throw new Error(`Verification failed (${result.failure || 'verification'}).`);
    }
    transition(task, 'completed');
    task.runtime = task.runtime || {};
    task.runtime.phase = 'COMPLETED';
    task.runtime.taskState = 'COMPLETED';
    task.runtime.metrics = { ...(task.runtime.metrics || {}), verificationRuns: Number(task.runtime.metrics?.verificationRuns || 0) + 1, confidence: 'HIGH' };
    task.runtime.history = [...(task.runtime.history || []), { phase: 'COMPLETED', at: now(), message: 'Apply and verification completed.' }].slice(-developerSettings.maxStateHistoryEntries);
    task.runtime.lastUpdated = now();
    progress(task, 'complete', 'Apply and verification completed.');
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
    if (patchApplied || writeStarted || task.state === 'verifying') {
      task.state = 'recovering'; task.updatedAt = now(); progress(task, 'recover', 'Apply failed; verifying rollback state.');
      try {
        await restoreBeforeSnapshot(task);
      } catch (rollbackError) {
        task.error = `Rollback verification failed: ${rollbackError.message}`;
      }
      task.state = error.cancelled ? 'cancelled' : 'failed'; task.updatedAt = now();
    }
    task.updatedAt = now();
    recordMutation(task, 'transaction_failed', { transactionId: task.transactionId, error: error.message });
    error.taskSnapshot = publicTask(task);
    throw error;
  } finally { release(); }
}
async function undo(taskId, owner) {
  const task = getTask(taskId, owner);
  if (task.state !== 'completed') throw new Error('Only a completed proposal can be undone.');
  const release = await acquireLock();
  task.transactionId = crypto.randomUUID();
  recordMutation(task, 'undo_started', { transactionId: task.transactionId });
  try {
    const current = await Promise.all(task.files.map((item) => snapshot(task.root, item.path)));
    if (current.some((item, index) => item.hash !== task.files[index].hash)) throw new Error('Undo refused: files changed after apply.');
    await writeAndVerify(task, task.before.map((item) => ({ path: item.path, hash: item.hash, content: item.content })));
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
function normalizeCommandResult(result) {
  return { ok: Boolean(result?.ok), script: String(result?.script || ''), exitCode: result?.exitCode ?? null,
    stdout: String(result?.stdout || ''), stderr: String(result?.stderr || ''), durationMs: Number(result?.durationMs || 0),
    reason: result?.reason ? String(result.reason).slice(0, 500) : null,
    failure: result?.ok ? null : classifyFailure(result),
    classification: result?.ok ? null : classifyFailureCategory(result),
    cancelled: Boolean(result?.cancelled),
    runtimeEvidence: result?.runtimeEvidence || null,
  };
}
function commandPolicy(script) {
  const allowed = new Set(['lint', 'typecheck', 'test', 'build', 'check', 'validate', 'verify', 'phpunit', 'composer-test', 'php-lint',
    'maven-test', 'maven-build', 'gradle-test', 'gradle-build', 'go-test', 'go-vet', 'go-build', 'ruby-test', 'ruby-lint',
    'dotnet-test', 'dotnet-build', 'cargo-test', 'cargo-clippy', 'cargo-build', 'python-test', 'python-lint']);
  if (typeof script !== 'string' || !allowed.has(script)) throw new Error('Verification command is not permitted.');
  return { script, approvalRequired: true, arbitraryShell: false };
}
async function executeVerificationLoop({ run, maxAttempts = 2, diagnose = () => null, onProgress = () => {} }) {
  if (typeof run !== 'function') throw new Error('Verification runner is required.');
  const attempts = Math.max(1, Math.min(2, Number(maxAttempts) || 1));
  const observations = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    onProgress({ phase: 'verify', attempt });
    const result = normalizeCommandResult(await run(attempt));
    observations.push(result);
    if (result.ok) return { ok: true, attempts: observations };
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
  const scripts = packageJson?.scripts || {};
  const names = Array.isArray(requested) && requested.length ? requested : ['test', 'typecheck', 'lint'];
  return [...new Set(names)].filter((name) => {
    try { commandPolicy(name); } catch { return false; }
    return typeof scripts[name] === 'string' && scripts[name].trim();
  });
}
function extractFailure(result) {
  const text = `${result?.stderr || ''}
${result?.stdout || ''}`;
  const location = text.match(/(?:^|\s)([^ \r\n:]+):(\d+)(?::(\d+))?(?:\s|$)/);
  const test = text.match(/(?:FAIL|failed|failing)\s+(?:test\s+)?["'`]?([^"'`\r\n]+)["'`]?/i);
  const message = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/^npm (?:error|warn)/i.test(line)) || '';
  return {
    file: location?.[1] || null,
    line: location ? Number(location[2]) : null,
    column: location?.[3] ? Number(location[3]) : null,
    test: test?.[1]?.trim() || null,
    message: message.slice(0, 1000),
  };
}
function normalizeObservation(result, check = result?.script || '') {
  const normalized = normalizeCommandResult(result);
  return { ...normalized, check, failure: normalized.failure, extracted: extractFailure(normalized) };
}
function diagnoseObservation(observation, metadata = {}) {
  const environment = new Set(['ENVIRONMENT_FAILURE', 'DEPENDENCY_FAILURE', 'COMMAND_NOT_AVAILABLE', 'TIMEOUT']);
  return {
    taskId: metadata.taskId || null,
    attempt: metadata.attempt || 1,
    check: observation.check,
    classification: observation.classification || classifyFailureCategory(observation),
    environmentFailure: environment.has(observation.classification || classifyFailureCategory(observation)),
    location: observation.extracted,
    runtimeEvidence: observation.runtimeEvidence || null,
    context: { workspace: metadata.workspace || null, branch: metadata.branch || null },
  };
}
async function runVerificationChecks({ checks, runCheck, isCancelled = () => false, onProgress = () => {} }) {
  if (typeof runCheck !== 'function') throw new Error('Verification runner is required.');
  const selectedChecks = [...new Set(checks || [])].map((check) => commandPolicy(check).script);
  if (!selectedChecks.length) {
    return { ok: true, status: 'NOT_AVAILABLE', skipped: true, checks: [], attempts: [] };
  }
  const attempts = [];
  for (const check of selectedChecks) {
    if (isCancelled()) return { ok: false, status: 'CANCELLED', cancelled: true, checks: selectedChecks, attempts };
    onProgress({ phase: 'verify', check });
    const result = normalizeObservation(await runCheck(check), check);
    attempts.push(result);
    if (!result.ok) {
      return {
        ok: false,
        status: result.classification || 'CODE_FAILURE',
        failure: result.failure,
        classification: result.classification,
        checks: selectedChecks,
        attempts,
        diagnosis: diagnoseObservation(result),
      };
    }
  }
  return { ok: true, status: 'PASS', checks: selectedChecks, attempts };
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
      if (task) updateLoopTask(taskId, owner, 'cancelled', 'cancelled', 'Engineering loop cancelled.', outcome);
      return { ...outcome, attempts: observations };
    }
    if (task) updateLoopTask(taskId, owner, 'verifying', 'running_checks', 'Running approved verification checks.');
    onProgress({ phase: 'running_checks', attempt, checks: selectedChecks });
    const results = [];
    for (const check of selectedChecks) {
      const observation = normalizeObservation(await runCheck(check, attempt), check);
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
    if (task) updateLoopTask(taskId, owner, 'awaiting_approval', 'waiting_for_approval', 'Waiting for approval of the registered fix proposal.');
    onProgress({ phase: 'waiting_for_approval', attempt, proposalId });
    await approveFix(proposalId, owner);
    if (task) {
      updateLoopTask(taskId, owner, 'approved', 'approved', 'Fix proposal approved.');
      updateLoopTask(taskId, owner, 'applying', 'applying_fix', 'Applying the approved fix proposal.');
    }
    fixes += 1;
    onProgress({ phase: 'applying_fix', attempt, proposalId });
    await applyFix(proposalId, owner);
    if (task) updateLoopTask(taskId, owner, 'verifying', 'retesting', 'Retesting after the approved fix.');
    onProgress({ phase: 'retesting', attempt: attempt + 1 });
  }
  return { status: 'MAX_ATTEMPTS', attempts: observations, fixes };
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
  getTask(taskId, owner);
  if (action === 'start') {
    return devServerManager.startDevServer(taskId, projectRoot);
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

async function saveTaskCheckpointToDisk(taskId, filePath, milestone = 'generic', owner) {
  getTask(taskId, owner);
  return taskOrchestrator.saveCheckpointToDisk(taskId, filePath, milestone);
}

async function restoreTaskFromDisk(filePath) {
  const restored = await taskOrchestrator.restoreTaskFromDisk(filePath);
  if (restored && restored.taskId && !registry.has(restored.taskId)) {
    registry.set(restored.taskId, {
      taskId: restored.taskId,
      sessionId: restored.sessionId || 'restored-session',
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
      ownerWebContentsId: null,
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

async function rollbackMultiRepo(taskId) {
  return multiRepoCoordinator.rollbackMultiRepoChanges(taskId);
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
  registry.clear(); sessions.clear(); conversationTurns.clear(); locked = false; journalError = null; auditError = null;
  journalQueue = Promise.resolve(); auditQueue = Promise.resolve();
}

module.exports = {
  STATES, STATE_ALIASES, transitions, createSession, getSession, cancelSession, beginConversationTurn, inspectDatabaseRequest, advanceConversationTurn, recordConversationFindings, getConversationTurn, createProposal, approve, reject, apply, undo,
  getTask: (id, owner) => publicTask(getTask(id, owner)), getTaskForTest, normalizeCommandResult,
  classifyFailure, classifyFailureCategory, commandPolicy, selectVerificationChecks, extractFailure, normalizeObservation,
  diagnoseObservation, executeVerificationLoop, runVerificationChecks, runEngineeringLoop, isCancellationRequested,
  configureDurability, loadJournal,
  flushDurability, resumeSession, releaseSession, resetForTest, parsePatch, applyFilePatch,
  assessTaskRisk, selfReviewPatch, classifyVerificationFailure,
  saveTaskCheckpoint, restoreTaskCheckpoint, pauseTask, resumeTask, cancelTask,
  steerTask, forkTask, createTaskArtifact, getTaskArtifacts, verifyTaskBrowser, manageDevServer, inspectPatchSecurity,
  listSkills, getSkill, assignTaskSkill, setTaskOperatingMode, listMcpTools, invokeTaskMcpTool, getOperatingModes, getComplexityLevels,
  saveTaskCheckpointToDisk, restoreTaskFromDisk, validateTaskContextFreshness, refuteTaskHypothesis, rollbackMultiRepo,
  getTaskHeartbeat, handleClientDisconnect, handleClientReconnect, replayTaskEvents,
  executeParallelWorkers, cancelWorker,
  captureWorktreeBaseline, verifyDirtyWorktreePreserved, calculateAgentDelta,
  defineHiddenContract, evaluateIndependentCorrectness, evaluatePatchQuality, reviewDiffIndependently,
  verifyMutationTest, diagnoseFailureType, inspectEdgeCasesAndContract,
  verifyTaskBlindness, attemptOracleDiscovery, adjudicateWorkerConflict, classifyRealityLevel,
  revalidateBusinessTask, redlineBusinessClaim,
};
