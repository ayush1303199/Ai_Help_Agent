/**
 * Authoritative Coding Agent Task Activity & Persistent History Service.
 * Provides:
 * - Authoritative lifecycle state machine (CREATED -> RUNNING -> INSPECTING -> PROPOSAL_READY ->
 *   WAITING_FOR_APPROVAL -> APPLYING -> VERIFYING -> COMPLETED/FAILED/BLOCKED/CANCELLED/KILLED/INTERRUPTED)
 * - Unique, stable task ID propagation across IPC, orchestrator, execution, and verification.
 * - Incremental persistence to application-owned storage via authorizeAppOwnedMutation.
 * - Chronological event logging with strict monotonic sequence numbers and timestamps.
 * - Real process execution capture (exit codes, bounded sanitized stdout/stderr, test results).
 * - Safe secret redaction (credentials, tokens, .env contents).
 * - Startup reconciliation: reconciles interrupted active tasks on application restart.
 * - Bounded retention policy to prevent log flooding or disk exhaustion.
 * - Session and project-scoped access control.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { authorizeAppOwnedMutation } = require('../appOwnedPersistence.cjs');

const TASK_LIFECYCLE_STATES = Object.freeze([
  'CREATED',
  'QUEUED',
  'RUNNING',
  'INSPECTING',
  'PROPOSAL_READY',
  'WAITING_FOR_APPROVAL',
  'APPLYING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'KILLED',
  'INTERRUPTED',
]);

const TERMINAL_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'KILLED',
  'INTERRUPTED',
]);

const ALLOWED_TASK_TRANSITIONS = Object.freeze({
  CREATED: ['QUEUED', 'RUNNING', 'INSPECTING', 'CANCELLED', 'BLOCKED', 'FAILED', 'KILLED'],
  QUEUED: ['RUNNING', 'INSPECTING', 'CANCELLED', 'BLOCKED', 'FAILED', 'KILLED'],
  RUNNING: ['INSPECTING', 'PROPOSAL_READY', 'WAITING_FOR_APPROVAL', 'APPLYING', 'VERIFYING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED', 'KILLED', 'INTERRUPTED'],
  INSPECTING: ['PROPOSAL_READY', 'WAITING_FOR_APPROVAL', 'APPLYING', 'VERIFYING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED', 'KILLED', 'INTERRUPTED'],
  PROPOSAL_READY: ['WAITING_FOR_APPROVAL', 'APPLYING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'KILLED', 'BLOCKED', 'INTERRUPTED'],
  WAITING_FOR_APPROVAL: ['APPLYING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'KILLED', 'INTERRUPTED'],
  APPLYING: ['VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'KILLED', 'INTERRUPTED'],
  VERIFYING: ['COMPLETED', 'INSPECTING', 'PROPOSAL_READY', 'WAITING_FOR_APPROVAL', 'APPLYING', 'FAILED', 'BLOCKED', 'CANCELLED', 'KILLED', 'INTERRUPTED'],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
  KILLED: [],
  INTERRUPTED: [],
});

const MAX_TASK_RETENTION = 100;
const MAX_EVENTS_PER_TASK = 250;
const MAX_OUTPUT_EXCERPT_CHARS = 4000;
const MAX_SUMMARY_CHARS = 512;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value, maxChars = MAX_OUTPUT_EXCERPT_CHARS) {
  if (typeof value !== 'string') return '';
  let cleaned = value
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{16,}|bearer\s+[A-Za-z0-9._-]+)/gi, '[REDACTED_TOKEN]')
    .replace(/(?:api[_-]?key|password|secret|auth(?:orization)?|credential)\s*[:=]\s*["']?[^\s"',;]+["']?/gi, (match) => {
      const parts = match.split(/[:=]/);
      return `${parts[0]}=[REDACTED]`;
    })
    .replace(/^(?:[A-Z0-9_]+_(?:KEY|SECRET|PASSWORD|TOKEN)=).+$/gim, (line) => {
      const prefix = line.split('=')[0];
      return `${prefix}=[REDACTED]`;
    });
  if (cleaned.length > maxChars) {
    cleaned = `${cleaned.slice(0, maxChars)}…[truncated ${cleaned.length - maxChars} chars]`;
  }
  return cleaned;
}

function redactObject(obj, depth = 0) {
  if (depth > 6 || !obj) return obj;
  if (typeof obj === 'string') return sanitizeText(obj, 1000);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 50).map((item) => redactObject(item, depth + 1));
  const res = {};
  for (const [key, val] of Object.entries(obj)) {
    if (/key|token|secret|password|auth|credential/i.test(key)) {
      res[key] = '[REDACTED]';
    } else if (key === 'env' && typeof val === 'object') {
      res[key] = '[REDACTED_ENV_MAP]';
    } else {
      res[key] = redactObject(val, depth + 1);
    }
  }
  return res;
}

class TaskActivityService {
  constructor() {
    this._tasks = new Map(); // taskId -> TaskRecord
    this._storageRoot = null;
    this._journalFile = null;
    this._auditFile = null;
    this._persistenceQueue = Promise.resolve();
    this._persistenceError = null;
    this._listeners = new Set(); // callback for live task updates
  }

  configureStorage({ storageRoot, journalFile, auditFile }) {
    if (storageRoot) this._storageRoot = path.resolve(storageRoot);
    if (journalFile) this._journalFile = path.resolve(journalFile);
    if (auditFile) this._auditFile = path.resolve(auditFile);
    if (this._journalFile && !this._storageRoot) {
      this._storageRoot = path.dirname(this._journalFile);
    }
  }

  addListener(listener) {
    if (typeof listener === 'function') {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }
    return () => {};
  }

  _notifyListeners(event, task) {
    for (const listener of this._listeners) {
      try {
        listener(event, task);
      } catch (err) {
        console.error('[TaskActivityService] Listener error:', err);
      }
    }
  }

  createTask({
    taskId,
    title,
    projectRoot = null,
    sessionId = null,
    ownerWebContentsId = null,
    correlationId = null,
    intent = null,
    mode = null,
  }) {
    const id = String(taskId || crypto.randomUUID()).trim();
    if (!id) throw new Error('Task ID cannot be empty.');

    const existing = this._tasks.get(id);
    if (existing) {
      // Idempotent task creation if matches existing task ID
      return existing;
    }

    const cleanTitle = sanitizeText(title || 'Coding task', MAX_SUMMARY_CHARS);
    const createdAt = nowIso();

    const taskRecord = {
      taskId: id,
      title: cleanTitle,
      projectRoot: projectRoot ? path.resolve(projectRoot) : null,
      sessionId: sessionId || null,
      ownerWebContentsId: ownerWebContentsId ?? null,
      correlationId: correlationId || id,
      intent: intent || null,
      mode: mode || null,
      status: 'CREATED',
      terminalStatus: null,
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      durationMs: null,
      proposal: null,
      diffExcerpt: null,
      filesModified: [],
      testResults: [],
      repairHistory: [],
      verificationEvidence: [],
      error: null,
      events: [],
      eventCount: 0,
      updatedAt: createdAt,
    };

    this._enforceRetentionLimit();
    this._tasks.set(id, taskRecord);

    const initialEvent = {
      sequence: 1,
      type: 'TASK_CREATED',
      timestamp: createdAt,
      status: 'CREATED',
      title: cleanTitle,
      projectRoot: taskRecord.projectRoot,
      correlationId: taskRecord.correlationId,
    };
    taskRecord.events.push(initialEvent);
    taskRecord.eventCount = 1;

    this._schedulePersist();
    this._notifyListeners(initialEvent, taskRecord);

    return taskRecord;
  }

  transitionTaskState(taskId, nextState, reason = '', { owner = null } = {}) {
    const task = this.getTask(taskId, { owner });
    if (!task) throw new Error(`Unknown Coding task: ${taskId}`);

    const currentState = task.status;
    if (currentState === nextState) return task;

    const allowed = ALLOWED_TASK_TRANSITIONS[currentState] || [];
    if (!allowed.includes(nextState)) {
      throw new Error(`Illegal task transition from "${currentState}" to "${nextState}" for task ${taskId}. Allowed: ${allowed.join(', ')}`);
    }

    task.status = nextState;
    task.updatedAt = nowIso();

    if (TERMINAL_STATES.has(nextState)) {
      task.terminalStatus = nextState;
      task.finishedAt = task.updatedAt;
      if (task.startedAt) {
        task.durationMs = Math.max(0, new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime());
      }
    }

    const event = {
      sequence: task.events.length + 1,
      type: 'STATE_TRANSITION',
      timestamp: task.updatedAt,
      status: nextState,
      from: currentState,
      to: nextState,
      reason: sanitizeText(reason, 500) || undefined,
    };

    this._appendEvent(task, event);
    this._schedulePersist();
    this._notifyListeners(event, task);

    return task;
  }

  recordEvent(taskId, eventType, data = {}, { owner = null } = {}) {
    const task = this.getTask(taskId, { owner });
    if (!task) {
      // Auto-register task if not yet registered but taskId provided
      const autoTask = this.createTask({
        taskId,
        title: data.title || 'Autonomous workflow task',
        projectRoot: data.projectRoot || null,
        sessionId: owner?.sessionId || null,
        ownerWebContentsId: owner?.ownerWebContentsId || null,
      });
      return this.recordEvent(taskId, eventType, data, { owner });
    }

    const timestamp = data.timestamp || nowIso();
    const event = {
      sequence: task.events.length + 1,
      type: String(eventType).toUpperCase(),
      timestamp,
      correlationId: data.correlationId || task.correlationId,
      ...redactObject(data),
    };

    // Keep excerpts safe
    if (data.command) event.command = sanitizeText(data.command, 500);
    if (data.exitCode !== undefined) event.exitCode = data.exitCode;
    if (data.stdout) event.stdoutExcerpt = sanitizeText(data.stdout, MAX_OUTPUT_EXCERPT_CHARS);
    if (data.stderr) event.stderrExcerpt = sanitizeText(data.stderr, MAX_OUTPUT_EXCERPT_CHARS);
    if (data.error) event.error = sanitizeText(typeof data.error === 'string' ? data.error : data.error?.message, 1000);

    // Update task high-level aggregates
    if (data.proposal) {
      task.proposal = redactObject(data.proposal);
      if (data.proposal.diff) {
        task.diffExcerpt = sanitizeText(data.proposal.diff, 2000);
      }
    }
    if (data.diff) {
      task.diffExcerpt = sanitizeText(data.diff, 2000);
    }
    if (Array.isArray(data.filesModified)) {
      task.filesModified = [...new Set([...task.filesModified, ...data.filesModified])];
    }
    if (data.testResult) {
      task.testResults.push(redactObject(data.testResult));
    }
    if (data.repair) {
      task.repairHistory.push(redactObject(data.repair));
    }
    if (data.verificationEvidence) {
      task.verificationEvidence.push(redactObject(data.verificationEvidence));
    }
    if (data.error && !task.error) {
      task.error = sanitizeText(typeof data.error === 'string' ? data.error : data.error?.message, 1000);
    }

    this._appendEvent(task, event);
    this._schedulePersist();
    this._notifyListeners(event, task);

    return event;
  }

  _appendEvent(task, event) {
    if (task.events.length >= MAX_EVENTS_PER_TASK) {
      // Bound event entries: keep initial 20 and last (MAX_EVENTS_PER_TASK - 21)
      const head = task.events.slice(0, 20);
      const tail = task.events.slice(-(MAX_EVENTS_PER_TASK - 21));
      task.events = [...head, event, ...tail];
    } else {
      task.events.push(event);
    }
    task.eventCount += 1;
    task.updatedAt = event.timestamp || nowIso();
  }

  getTask(taskId, { owner = null } = {}) {
    const id = String(taskId || '').trim();
    if (!id) return null;
    const task = this._tasks.get(id);
    if (!task) return null;
    if (owner) {
      const sessionMismatch = Boolean(task.sessionId && owner.sessionId && task.sessionId !== owner.sessionId);
      const webContentsMismatch = Boolean(task.ownerWebContentsId !== null && owner.ownerWebContentsId !== undefined && task.ownerWebContentsId !== owner.ownerWebContentsId);
      if (sessionMismatch || webContentsMismatch) {
        throw new Error('Unauthorized access to Coding task history.');
      }
    }
    return task;
  }

  listTasks({
    sessionId = null,
    ownerWebContentsId = null,
    projectRoot = null,
    status = null,
    search = null,
    limit = 50,
    offset = 0,
  } = {}) {
    let result = Array.from(this._tasks.values());

    if (sessionId) {
      result = result.filter((t) => t.sessionId === sessionId || t.sessionId === null);
    }
    if (ownerWebContentsId !== null && ownerWebContentsId !== undefined) {
      result = result.filter((t) => t.ownerWebContentsId === null || t.ownerWebContentsId === ownerWebContentsId);
    }
    if (projectRoot) {
      const canonicalProject = path.resolve(projectRoot);
      result = result.filter((t) => t.projectRoot && (t.projectRoot === canonicalProject || t.projectRoot.startsWith(canonicalProject)));
    }
    if (status && status !== 'ALL') {
      const statusUpper = status.toUpperCase();
      result = result.filter((t) => t.status === statusUpper || t.terminalStatus === statusUpper);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((t) => t.taskId.toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
    }

    // Sort chronological descending (most recent first)
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = result.length;
    const paginated = result.slice(offset, offset + limit).map((t) => ({
      taskId: t.taskId,
      title: t.title,
      status: t.status,
      terminalStatus: t.terminalStatus,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      durationMs: t.durationMs,
      projectRoot: t.projectRoot,
      eventCount: t.eventCount,
      error: t.error,
    }));

    return { tasks: paginated, total };
  }

  _enforceRetentionLimit() {
    if (this._tasks.size < MAX_TASK_RETENTION) return;
    const sorted = Array.from(this._tasks.values()).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    // Remove oldest completed/terminal tasks first
    const evictCount = (this._tasks.size - MAX_TASK_RETENTION) + 1;
    let evicted = 0;
    for (const task of sorted) {
      if (TERMINAL_STATES.has(task.status)) {
        this._tasks.delete(task.taskId);
        evicted += 1;
        if (evicted >= evictCount) break;
      }
    }
  }

  _schedulePersist() {
    if (!this._journalFile && !this._storageRoot) return;
    this._persistenceQueue = this._persistenceQueue
      .then(() => this._writeJournalAtomic())
      .catch((err) => {
        this._persistenceError = err;
        console.error('[TaskActivityService] Persistence error:', err);
      });
  }

  async _writeJournalAtomic() {
    const targetFile = this._journalFile || path.join(this._storageRoot, 'developer-task-history.json');
    const storageRoot = this._storageRoot || path.dirname(targetFile);

    const payload = JSON.stringify({
      schemaVersion: 1,
      savedAt: nowIso(),
      tasks: Array.from(this._tasks.values()),
    }, null, 2);

    await authorizeAppOwnedMutation({
      root: storageRoot,
      target: storageRoot,
      resource: 'app-state',
      operation: 'write',
    });
    await fs.mkdir(storageRoot, { recursive: true });

    const tempFile = `${targetFile}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    try {
      await authorizeAppOwnedMutation({
        root: storageRoot,
        target: tempFile,
        resource: 'app-state',
        operation: 'write',
      });
      await fs.writeFile(tempFile, payload, 'utf8');

      await authorizeAppOwnedMutation({
        root: storageRoot,
        target: targetFile,
        resource: 'app-state',
        operation: 'replace',
      });
      await fs.rename(tempFile, targetFile);
    } finally {
      await authorizeAppOwnedMutation({
        root: storageRoot,
        target: tempFile,
        resource: 'app-state',
        operation: 'remove',
      }).catch(() => {});
      await fs.rm(tempFile, { force: true }).catch(() => {});
    }
  }

  async loadHistory() {
    const targetFile = this._journalFile || (this._storageRoot ? path.join(this._storageRoot, 'developer-task-history.json') : null);
    if (!targetFile) return { loaded: 0, reconciled: 0 };

    let content;
    try {
      content = await fs.readFile(targetFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { loaded: 0, reconciled: 0 };
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.warn('[TaskActivityService] Corrupt journal file, starting fresh:', err.message);
      return { loaded: 0, reconciled: 0 };
    }

    const loadedTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    let reconciledCount = 0;

    for (const saved of loadedTasks) {
      if (!saved?.taskId) continue;
      const task = { ...saved, ownerWebContentsId: null };

      // Startup Reconciliation (Section 9): Reconcile non-terminal interrupted tasks
      if (!TERMINAL_STATES.has(task.status)) {
        task.status = 'INTERRUPTED';
        task.terminalStatus = 'INTERRUPTED';
        task.finishedAt = nowIso();
        task.error = 'Task was interrupted during previous application shutdown and requires safe review.';
        task.events = Array.isArray(task.events) ? task.events : [];
        task.events.push({
          sequence: task.events.length + 1,
          type: 'STARTUP_RECONCILIATION',
          timestamp: task.finishedAt,
          status: 'INTERRUPTED',
          reason: 'Application restarted while task was in non-terminal state.',
        });
        task.eventCount = task.events.length;
        reconciledCount += 1;
      }

      this._tasks.set(task.taskId, task);
    }

    if (reconciledCount > 0) {
      this._schedulePersist();
    }

    return { loaded: this._tasks.size, reconciled: reconciledCount };
  }

  async flush() {
    await this._persistenceQueue;
    if (this._persistenceError) {
      const err = this._persistenceError;
      this._persistenceError = null;
      throw err;
    }
  }

  resetForTesting() {
    this._tasks.clear();
    this._persistenceQueue = Promise.resolve();
    this._persistenceError = null;
  }
}

const taskActivityService = new TaskActivityService();

module.exports = {
  taskActivityService,
  TaskActivityService,
  TASK_LIFECYCLE_STATES,
  TERMINAL_STATES,
  ALLOWED_TASK_TRANSITIONS,
  sanitizeText,
  redactObject,
};
