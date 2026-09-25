const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const STATES = Object.freeze([
  'idle', 'reading', 'understanding', 'proposal_ready', 'awaiting_approval',
  'approved', 'applying', 'verifying', 'completed', 'recovering', 'failed',
  'cancelled', 'undone',
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
});
const transitions = {
  idle: ['reading', 'proposal_ready', 'cancelled'],
  reading: ['understanding', 'proposal_ready', 'failed', 'cancelled'],
  understanding: ['proposal_ready', 'reading', 'failed', 'cancelled'],
  proposal_ready: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'verifying', 'failed', 'cancelled'],
  approved: ['applying', 'failed', 'cancelled'],
  applying: ['verifying', 'recovering', 'failed', 'cancelled'],
  verifying: ['completed', 'recovering', 'failed', 'cancelled'],
  completed: ['undone', 'reading', 'cancelled'],
  recovering: ['verifying', 'awaiting_approval', 'failed', 'cancelled'],
  failed: ['reading', 'proposal_ready', 'recovering', 'verifying', 'cancelled'],
  cancelled: [],
  undone: ['reading', 'cancelled'],
};
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SENSITIVE_PATH_PATTERN = /(?:^|[\\/])(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.config|id_rsa(?:\..*)?|[^\\/]+\.(?:pem|key|p12|pfx|crt|cer|der))$/i;
const registry = new Map();
const sessions = new Map();
let locked = false;
let journalPath = null;
let auditPath = null;
let journalQueue = Promise.resolve();
let auditQueue = Promise.resolve();
let journalError = null;
let auditError = null;
let eventSequence = 0;

function now() { return new Date().toISOString(); }
function bounded(value, limit = 2000) {
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
}
function assertOwner(task, owner) {
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
  const task = [...registry.values()].find((item) => item.sessionId === sessionId);
  recordMutation(task, 'session_resumed', { ownerWebContentsId });
  return sessionId;
}
function releaseSession(ownerWebContentsId) {
  cancelSession(ownerWebContentsId);
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
    observations: Array.isArray(state.observations) ? [...state.observations].slice(-20) : [],
    metrics: { ...state.metrics },
    taskMemory: { ...state.taskMemory },
    history: Array.isArray(state.history) ? [...state.history].slice(-20) : [],
    lastUpdated: state.lastUpdated,
  };
}
function publicTask(task) {
  return {
    id: task.taskId, taskId: task.taskId, sessionId: task.sessionId, state: task.state,
    lifecycleState: STATE_ALIASES[task.state] || task.state.toUpperCase(),
    proposalId: task.proposalId || task.taskId,
    workspace: task.workspace, files: task.files.map(({ path, hash: fileHash }) => ({ path, hash: fileHash })),
    targetFiles: task.files.map(({ path }) => path),
    snapshotHashes: task.before.map(({ path, hash: fileHash }) => ({ path, hash: fileHash })),
    approval: task.approval ? { approvedAt: task.approval.approvedAt, actor: task.approval.actor } : null,
    progress: task.progress, verification: task.verification || null, verificationScript: task.verificationScript || null,
    verificationScripts: task.verificationScripts || [],
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
  if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) throw new Error('Proposal is invalid or too large.');
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
  output.push(...source.slice(cursor)); return output.join('\n');
}

async function createProposal({
  root: inputRoot, raw, expectedSnapshots = [], sessionId, ownerWebContentsId,
  workspace = {}, verificationScript = null, verificationScripts = [],
}) {
  if (!sessionId || ownerWebContentsId === undefined) throw new Error('Developer session ownership is required.');
  if (verificationScript !== null) commandPolicy(verificationScript);
  const requestedScripts = [
    ...(Array.isArray(verificationScripts) ? verificationScripts : []),
    ...(verificationScript ? [verificationScript] : []),
  ];
  const safeVerificationScripts = [...new Set(requestedScripts.map((script) => commandPolicy(script).script))];
  const root = await fs.realpath(inputRoot);
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
    createdAt: now(), updatedAt: now(),
  };
  registry.set(task.taskId, task); recordMutation(task, 'proposal_registered', { proposalId: task.proposalId });
  transition(task, 'awaiting_approval'); return publicTask(task);
}
function getTask(taskId, owner) { const task = registry.get(taskId); if (!task) throw new Error('Unknown Developer task.'); assertOwner(task, owner); return task; }
function approve(taskId, owner) {
  const task = getTask(taskId, owner);
  task.approval = { approvedAt: now(), actor: 'renderer-session' };
  task.runtime = task.runtime || {};
  task.runtime.phase = 'AWAITING_APPROVAL';
  task.runtime.taskState = 'AWAITING_APPROVAL';
  task.runtime.history = [...(task.runtime.history || []), { phase: 'AWAITING_APPROVAL', at: now(), message: 'User approved the proposal.' }].slice(-20);
  task.runtime.lastUpdated = now();
  transition(task, 'approved');
  recordMutation(task, 'proposal_approved', { proposalId: task.proposalId || taskId, actor: task.approval.actor });
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
    transition(task, 'applying');
    task.runtime = task.runtime || {};
    task.runtime.phase = 'APPLYING';
    task.runtime.taskState = 'APPLYING';
    task.runtime.history = [...(task.runtime.history || []), { phase: 'APPLYING', at: now(), message: 'Applying validated patch.' }].slice(-20);
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
    task.runtime.history = [...(task.runtime.history || []), { phase: 'VERIFYING', at: now(), message: 'Running approved verification.' }].slice(-20);
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
    task.runtime.history = [...(task.runtime.history || []), { phase: 'COMPLETED', at: now(), message: 'Apply and verification completed.' }].slice(-20);
    task.runtime.lastUpdated = now();
    progress(task, 'complete', 'Apply and verification completed.');
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
    failure: result?.ok ? null : classifyFailure(result),
    classification: result?.ok ? null : classifyFailureCategory(result),
    cancelled: Boolean(result?.cancelled),
  };
}
function commandPolicy(script) {
  const allowed = new Set(['lint', 'typecheck', 'test', 'build', 'check', 'validate', 'verify']);
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
function resetForTest() {
  registry.clear(); sessions.clear(); locked = false; journalError = null; auditError = null;
  journalQueue = Promise.resolve(); auditQueue = Promise.resolve();
}
module.exports = {
  STATES, STATE_ALIASES, transitions, createSession, getSession, cancelSession, createProposal, approve, apply, undo,
  getTask: (id, owner) => publicTask(getTask(id, owner)), getTaskForTest, normalizeCommandResult,
  classifyFailure, classifyFailureCategory, commandPolicy, selectVerificationChecks, extractFailure, normalizeObservation,
  diagnoseObservation, executeVerificationLoop, runVerificationChecks, runEngineeringLoop, isCancellationRequested,
  configureDurability, loadJournal,
  flushDurability, resumeSession, releaseSession, resetForTest, parsePatch, applyFilePatch,
};
