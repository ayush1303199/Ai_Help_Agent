/**
 * Production Autonomous Engineering Task Orchestrator.
 * Core orchestration engine supporting:
 * - Persistent execution & checkpointing
 * - Parallel bounded subtasks & deduplication
 * - Contradiction detection & evidence synthesis
 * - Next-Best-Action Engine 2.0 with information-gain reasoning
 * - Failure Classification 2.0 & recovery memory
 * - Tool budget management
 * - Strict lifecycle state machine
 * - Safe user steering & forking
 */

const fs = require('node:fs/promises');
const { authorizeAppOwnedMutation } = require('../appOwnedPersistence.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CAPABILITY_REGISTRY, scoreToolSelection } = require('./capabilityRegistry.cjs');
const { skillSystem } = require('./skillSystem.cjs');
const { mcpToolAdapter } = require('./mcpAdapter.cjs');
const { routeTaskMode, OPERATING_MODES, MODE_SPECIFICATIONS, COMPLEXITY_LEVELS } = require('./modes.cjs');

const ORCHESTRATOR_STATES = Object.freeze([
  'queued',
  'planning',
  'discovering',
  'investigating',
  'planning_change',
  'awaiting_approval',
  'approved',
  'executing',
  'testing',
  'recovering',
  'verifying',
  'completed',
  'paused',
  'blocked',
  'cancelled',
  'failed',
  'budget_exhausted',
  'needs_user',
]);

const ALLOWED_ORCHESTRATOR_TRANSITIONS = Object.freeze({
  queued: ['planning', 'discovering', 'cancelled'],
  planning: ['discovering', 'investigating', 'completed', 'failed', 'cancelled'],
  discovering: ['investigating', 'planning_change', 'completed', 'failed', 'cancelled'],
  investigating: ['planning_change', 'awaiting_approval', 'completed', 'recovering', 'failed', 'cancelled', 'paused'],
  planning_change: ['awaiting_approval', 'investigating', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'investigating', 'cancelled', 'needs_user'],
  approved: ['executing', 'cancelled'],
  executing: ['testing', 'recovering', 'verifying', 'failed', 'cancelled'],
  testing: ['verifying', 'recovering', 'failed', 'cancelled'],
  recovering: ['executing', 'testing', 'verifying', 'awaiting_approval', 'failed', 'cancelled'],
  verifying: ['completed', 'recovering', 'failed', 'cancelled'],
  completed: ['cancelled'],
  paused: ['investigating', 'executing', 'testing', 'verifying', 'cancelled'],
  blocked: ['planning', 'investigating', 'cancelled'],
  cancelled: [],
  failed: ['planning', 'investigating', 'recovering', 'cancelled'],
  budget_exhausted: ['completed', 'failed', 'cancelled'],
  needs_user: ['approved', 'investigating', 'cancelled'],
});

const FAILURE_CLASSIFICATIONS_2 = Object.freeze({
  IMPLEMENTATION_DEFECT: 'implementation_defect',
  TEST_DEFECT: 'test_defect',
  ENVIRONMENT_ISSUE: 'environment_issue',
  DEPENDENCY_ISSUE: 'dependency_issue',
  CONFIGURATION_ISSUE: 'configuration_issue',
  RUNTIME_ISSUE: 'runtime_issue',
  TIMEOUT: 'timeout',
  PERMISSION_ISSUE: 'permission_issue',
  NETWORK_ISSUE: 'network_issue',
  BROWSER_ISSUE: 'browser_issue',
  TOOL_ISSUE: 'tool_issue',
  RESOURCE_ISSUE: 'resource_issue',
  FLAKY_BEHAVIOR: 'flaky_behavior',
  UNKNOWN: 'unknown',
});

class TaskOrchestrator {
  constructor() {
    this._tasks = new Map(); // taskId -> taskState
    this._eventLogs = new Map(); // taskId -> Array of event objects
    this._checkpointStorageRoot = null;
  }

  setCheckpointStorageRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error('Checkpoint storage root must be an absolute application-owned path.');
    }
    this._checkpointStorageRoot = path.resolve(root);
  }

  getCheckpointPath(taskId) {
    if (!this._checkpointStorageRoot) {
      throw new Error('Application-owned checkpoint storage is not configured.');
    }
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) {
      throw new Error('Checkpoint task identifier is invalid.');
    }
    return path.join(this._checkpointStorageRoot, `${taskId}.json`);
  }

  createTask({
    taskId,
    sessionId,
    ownerWebContentsId = null,
    goal,
    intent = 'BUG_INVESTIGATION',
    workspace = '',
    repository = '',
    project = '',
    package: pkg = '',
    budget = {},
    mode = null,
    complexity = null,
    skillId = null,
  }) {
    const id = taskId || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const modeRouting = routeTaskMode({
      goal: goal || '',
      intent,
      userRequestedMode: mode,
      explicitComplexity: complexity,
    });
    const selectedSkillMatch = skillId
      ? { skill: skillSystem.getSkill(skillId) }
      : skillSystem.selectBestSkill({ goal: goal || '', intent });

    const initialBudget = {
      maxToolCalls: budget.maxToolCalls || modeRouting.effectiveToolBudget || 30,
      maxFilesystemReads: budget.maxFilesystemReads || 50,
      maxTerminalCommands: budget.maxTerminalCommands || 10,
      maxBrowserActions: budget.maxBrowserActions || 15,
      maxSubtasks: budget.maxSubtasks || (modeRouting.complexity === 'PARALLEL' ? 8 : 12),
      maxRetries: budget.maxRetries || 3,
      maxRuntimeMs: budget.maxRuntimeMs || 120000,
      usedToolCalls: 0,
      usedFilesystemReads: 0,
      usedTerminalCommands: 0,
      usedBrowserActions: 0,
      usedSubtasks: 0,
      usedRetries: 0,
      startTime: Date.now(),
    };

    const task = {
      taskId: id,
      sessionId: sessionId || 'default-session',
      ownerWebContentsId: ownerWebContentsId ?? null,
      goal: String(goal || '').trim(),
      intent,
      mode: modeRouting.mode,
      complexity: modeRouting.complexity,
      modeRouting,
      activeSkill: selectedSkillMatch.skill ? selectedSkillMatch.skill.id : null,
      skillName: selectedSkillMatch.skill ? selectedSkillMatch.skill.name : null,
      skillPlaybook: selectedSkillMatch.skill ? selectedSkillMatch.skill.playbookSteps : [],
      skillStepIndex: 0,
      workspace,
      repository,
      project,
      package: pkg,
      targets: [],
      symbols: [],
      plan: [],
      currentPhase: 'planning',
      state: 'queued',
      completedSteps: [],
      pendingSteps: [],
      findings: [],
      evidence: [],
      hypotheses: [],
      rejectedHypotheses: [],
      recoveryMemory: [], // [ { strategy, result, reason, timestamp } ]
      toolHistory: [],
      subtasks: [],
      subtaskResults: [],
      changes: [],
      testPlan: [],
      testResults: [],
      verification: null,
      artifacts: [],
      mcpInvocations: [],
      risk: 'LOW',
      approvalState: 'UNAPPROVED',
      checkpoint: null,
      checkpoints: [],
      nextAction: null,
      blocker: null,
      budget: initialBudget,
      forks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._tasks.set(id, task);
    this._eventLogs.set(id, []);
    this.recordEvent(id, 'TASK_CREATED', { goal: task.goal, intent: task.intent, mode: task.mode, activeSkill: task.activeSkill });

    return task;
  }

  getTask(taskId) {
    return this._tasks.get(taskId) || null;
  }

  recordEvent(taskId, type, payload = {}) {
    const log = this._eventLogs.get(taskId);
    if (!log) return;

    const event = {
      sequence: log.length + 1,
      type,
      timestamp: new Date().toISOString(),
      payload: this._sanitizePayload(payload),
    };
    log.push(event);
  }

  getEventLog(taskId) {
    return this._eventLogs.get(taskId) || [];
  }

  _sanitizePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const clean = {};
    for (const [k, v] of Object.entries(payload)) {
      if (/key|token|secret|password|auth/i.test(k)) {
        clean[k] = '[REDACTED]';
      } else if (typeof v === 'string') {
        clean[k] = v.replace(/(?:sk-|ghp_|api[_-]?key[=:\s]+|bearer\s+)[A-Za-z0-9_.-]{6,}/gi, '[REDACTED]');
      } else if (typeof v === 'object' && v !== null) {
        clean[k] = this._sanitizePayload(v);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

  transitionState(taskId, nextState, reason = '') {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const currentState = task.state;
    const allowed = ALLOWED_ORCHESTRATOR_TRANSITIONS[currentState] || [];
    if (!allowed.includes(nextState)) {
      throw new Error(`Illegal state transition from "${currentState}" to "${nextState}" for task ${taskId}. Allowed: ${allowed.join(', ')}`);
    }

    if (task.mode && MODE_SPECIFICATIONS[task.mode]) {
      const modeSpec = MODE_SPECIFICATIONS[task.mode];
      if (!modeSpec.allowedLifecycleStates.includes(nextState)) {
        throw new Error(`Mode "${task.mode}" does not permit transitioning to state "${nextState}" for task ${taskId}. Allowed for mode ${task.mode}: ${modeSpec.allowedLifecycleStates.join(', ')}`);
      }
    }

    task.state = nextState;
    task.updatedAt = new Date().toISOString();
    this.recordEvent(taskId, `STATE_TRANSITION`, { from: currentState, to: nextState, reason });
    return task;
  }

  // --- Task Decomposition (Section 11) ---
  decomposeGoal(taskId) {
    const task = this.getTask(taskId);
    if (!task) return [];

    const isUi = /ui|button|modal|css|layout|render|component|frontend/i.test(task.goal);
    const isPerf = /slow|latency|query|bottleneck|optimize/i.test(task.goal);

    const subtasks = [
      {
        id: `${taskId}_sub_env`,
        role: 'Environment Investigator',
        goal: 'Discover repository structure, runtime engines, and project boundaries.',
        status: 'PENDING',
        permissions: ['read'],
        priority: 1,
      },
      {
        id: `${taskId}_sub_source`,
        role: 'Code Investigator',
        goal: 'Trace entry points, affected symbols, and execution paths.',
        status: 'PENDING',
        permissions: ['read', 'search'],
        priority: 2,
      },
      {
        id: `${taskId}_sub_deps`,
        role: 'Dependency Investigator',
        goal: 'Examine imports, caller hierarchies, and dependent modules.',
        status: 'PENDING',
        permissions: ['read'],
        priority: 3,
      },
    ];

    if (isPerf) {
      subtasks.push({
        id: `${taskId}_sub_perf`,
        role: 'Performance Investigator',
        goal: 'Audit query loops, in-memory filtering, and duplicate invocations.',
        status: 'PENDING',
        permissions: ['read', 'search'],
        priority: 4,
      });
    }

    if (isUi) {
      subtasks.push({
        id: `${taskId}_sub_ui`,
        role: 'Browser Investigator',
        goal: 'Identify server routes, component hierarchies, and user-visible triggers.',
        status: 'PENDING',
        permissions: ['read', 'browser:task_owned'],
        priority: 4,
      });
    }

    subtasks.push({
      id: `${taskId}_sub_tests`,
      role: 'Test Investigator',
      goal: 'Locate directly related test suites and expected assertions.',
      status: 'PENDING',
      permissions: ['read', 'search'],
      priority: 5,
    });

    task.subtasks = subtasks;
    this.recordEvent(taskId, 'SUBTASKS_CREATED', { count: subtasks.length });
    return subtasks;
  }

  // --- Parallel Bounded Subtask Execution with Deduplication (Sections 12-16) ---
  async executeSubtask(taskId, subtaskId, executorFn) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const subtask = task.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) throw new Error('Subtask not found');

    // Deduplication check
    const existing = task.subtaskResults.find(
      (r) => r.role === subtask.role && r.goal === subtask.goal && r.status === 'COMPLETED'
    );
    if (existing) {
      this.recordEvent(taskId, 'SUBTASK_DEDUPLICATED', { subtaskId, reusedFrom: existing.subtaskId });
      return existing;
    }

    // Budget check
    if (task.budget.usedSubtasks >= task.budget.maxSubtasks) {
      throw new Error(`Subtask budget limit (${task.budget.maxSubtasks}) exceeded`);
    }

    task.budget.usedSubtasks += 1;
    subtask.status = 'RUNNING';
    const started = Date.now();

    try {
      const result = await executorFn(subtask);
      subtask.status = 'COMPLETED';
      const record = {
        subtaskId,
        role: subtask.role,
        goal: subtask.goal,
        status: 'COMPLETED',
        findings: Array.isArray(result.findings) ? result.findings : [],
        evidence: Array.isArray(result.evidence) ? result.evidence : [],
        confidence: result.confidence || 'HIGH',
        durationMs: Date.now() - started,
      };

      task.subtaskResults.push(record);
      this.mergeSubtaskFindings(taskId, record);
      return record;
    } catch (err) {
      subtask.status = 'FAILED';
      const record = {
        subtaskId,
        role: subtask.role,
        status: 'FAILED',
        error: err.message,
        durationMs: Date.now() - started,
      };
      task.subtaskResults.push(record);
      return record;
    }
  }

  // --- Result Merging & Contradiction Resolution (Sections 16-17) ---
  mergeSubtaskFindings(taskId, subtaskResult) {
    const task = this.getTask(taskId);
    if (!task) return;

    for (const finding of subtaskResult.findings || []) {
      if (!task.findings.includes(finding)) {
        task.findings.push(finding);
      }
    }

    for (const ev of subtaskResult.evidence || []) {
      task.evidence.push(ev);
    }

    // Contradiction detection
    this.detectAndResolveContradictions(taskId);
  }

  detectAndResolveContradictions(taskId) {
    const task = this.getTask(taskId);
    if (!task) return [];

    const contradictions = [];
    const findings = task.findings;

    for (let i = 0; i < findings.length; i++) {
      for (let j = i + 1; j < findings.length; j++) {
        const a = findings[i].toLowerCase();
        const b = findings[j].toLowerCase();

        const hasMissing = a.includes('missing') || a.includes('not found') || b.includes('missing') || b.includes('not found');
        const hasPresent = a.includes('exists') || a.includes('found') || a.includes('present') || b.includes('exists') || b.includes('found') || b.includes('present');
        const hasDefect = a.includes('defect') || a.includes('broken') || b.includes('defect') || b.includes('broken');
        const hasCorrect = a.includes('correct') || a.includes('valid') || a.includes('passes') || b.includes('correct') || b.includes('valid') || b.includes('passes');

        if ((hasMissing && hasPresent) || (hasDefect && hasCorrect)) {
          contradictions.push({ findingA: findings[i], findingB: findings[j] });
        }
      }
    }

    if (contradictions.length > 0) {
      this.recordEvent(taskId, 'CONTRADICTIONS_DETECTED', { count: contradictions.length });
    }

    return contradictions;
  }

  // --- Next-Best-Action Engine 2.0 (Sections 18-19) ---
  computeNextBestAction(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;

    const { budget, findings, targets, evidence, approvalState, state } = task;

    // 1. If budget exhausted
    if (budget.usedToolCalls >= budget.maxToolCalls) {
      return {
        action: 'synthesize_final_report',
        rationale: 'Tool budget reached maximum allocation. Synthesizing best-effort conclusions.',
        informationGain: 'CRITICAL',
        risk: 'LOW',
      };
    }

    // 2. If no targets identified
    if (targets.length === 0) {
      return {
        action: 'discover_targets',
        rationale: 'Identify candidate target files from the user goal and repository map.',
        informationGain: 'HIGH',
        risk: 'LOW',
      };
    }

    // 3. If target identified but not yet read
    const hasRead = evidence.some((e) => e.tool === 'read_file');
    if (!hasRead) {
      return {
        action: 'read_target_file',
        target: targets[0],
        rationale: 'Read target source file to inspect implementation and locate defect or extension point.',
        informationGain: 'CRITICAL',
        risk: 'LOW',
      };
    }

    // 4. If findings gathered and proposal ready, but not approved
    if (findings.length > 0 && approvalState === 'UNAPPROVED' && state === 'investigating') {
      return {
        action: 'prepare_proposal',
        rationale: 'All necessary investigation evidence gathered. Synthesizing minimal proposal for approval.',
        informationGain: 'CRITICAL',
        risk: 'MEDIUM',
      };
    }

    // 5. If approved, next action is execute apply
    if (approvalState === 'APPROVED' && state === 'approved') {
      return {
        action: 'apply_proposal',
        rationale: 'Proposal approved by user. Applying changes isolated to target files.',
        informationGain: 'CRITICAL',
        risk: 'HIGH',
      };
    }

    return {
      action: 'synthesize_final_report',
      rationale: 'Task lifecycle complete. Generating verified summary report and artifacts.',
      informationGain: 'HIGH',
      risk: 'LOW',
    };
  }

  // --- Failure Classification 2.0 & Recovery Memory (Sections 20-23) ---
  classifyFailure({ stdout = '', stderr = '', exitCode = null, exception = null }) {
    const combined = `${stdout}\n${stderr}\n${exception?.message || ''}`.toLowerCase();

    if (/syntaxerror|parse\s+error|type\s+error|cannot\s+read\s+properties/i.test(combined)) {
      return {
        type: FAILURE_CLASSIFICATIONS_2.IMPLEMENTATION_DEFECT,
        remediation: 'Inspect modified hunks for syntax or type errors and re-align with original contract.',
      };
    }
    if (/assertionerror|assert|expected.*received|test\s+failed|failures:\s+[1-9]/i.test(combined)) {
      return {
        type: FAILURE_CLASSIFICATIONS_2.TEST_DEFECT,
        remediation: 'Compare test assertion expectations against verified method behavior.',
      };
    }
    if (/timeout|timed\s*out|etimedout/i.test(combined)) {
      return {
        type: FAILURE_CLASSIFICATIONS_2.TIMEOUT,
        remediation: 'Increase operation timeout or verify dev server / test runner responsiveness.',
      };
    }
    if (/econnrefused|connection\s+refused|cannot\s+connect/i.test(combined)) {
      return {
        type: FAILURE_CLASSIFICATIONS_2.NETWORK_ISSUE,
        remediation: 'Probe target host and port to confirm server is bound and listening.',
      };
    }
    if (/module_not_found|cannot\s+find\s+module|import\s+error/i.test(combined)) {
      return {
        type: FAILURE_CLASSIFICATIONS_2.DEPENDENCY_ISSUE,
        remediation: 'Verify package manifest declarations and relative import paths.',
      };
    }
    if (/permission\s+denied|eacces|eperm/i.test(combined)) {
      return {
        type: FAILURE_CLASSIFICATIONS_2.PERMISSION_ISSUE,
        remediation: 'Verify file permissions and operating system security attributes.',
      };
    }

    return {
      type: FAILURE_CLASSIFICATIONS_2.RUNTIME_ISSUE,
      remediation: 'Inspect stdout and stderr diagnostics for application-level runtime failures.',
    };
  }

  recordFailedStrategy(taskId, { strategy, result, reason }) {
    const task = this.getTask(taskId);
    if (!task) return;

    task.recoveryMemory.push({
      strategy,
      result,
      reason,
      timestamp: new Date().toISOString(),
    });
    this.recordEvent(taskId, 'STRATEGY_FAILED', { strategy, reason });
  }

  // --- Checkpointing & Resumption (Sections 6, 7, 62) ---
  saveCheckpoint(taskId, milestone = 'generic') {
    const task = this.getTask(taskId);
    if (!task) return null;

    const checkpointId = `chk_${Date.now()}_${task.checkpoints.length + 1}`;
    const checkpoint = {
      checkpointId,
      milestone,
      timestamp: new Date().toISOString(),
      state: task.state,
      targets: [...task.targets],
      findings: [...task.findings],
      evidenceCount: task.evidence.length,
      hypotheses: [...task.hypotheses],
      rejectedHypotheses: [...task.rejectedHypotheses],
      approvalState: task.approvalState,
      completedSteps: [...task.completedSteps],
      budgetUsed: { ...task.budget },
    };

    task.checkpoints.push(checkpoint);
    task.checkpoint = checkpoint;
    this.recordEvent(taskId, 'CHECKPOINT_SAVED', { checkpointId, milestone });
    return checkpoint;
  }

  resumeFromCheckpoint(taskId, checkpointId = null) {
    const task = this.getTask(taskId);
    if (!task) return null;

    let targetCheckpoint = null;
    if (checkpointId) {
      targetCheckpoint = task.checkpoints.find((c) => c.checkpointId === checkpointId);
    } else {
      targetCheckpoint = task.checkpoint || task.checkpoints[task.checkpoints.length - 1];
    }

    if (!targetCheckpoint) return null;

    // Validate checkpoint targets
    task.targets = [...targetCheckpoint.targets];
    task.findings = [...targetCheckpoint.findings];
    task.hypotheses = [...targetCheckpoint.hypotheses];
    task.rejectedHypotheses = [...targetCheckpoint.rejectedHypotheses];
    task.completedSteps = [...targetCheckpoint.completedSteps];

    // If context changed, require fresh approval
    if (targetCheckpoint.approvalState === 'APPROVED') {
      task.approvalState = 'APPROVED';
    }

    this.recordEvent(taskId, 'TASK_RESUMED', { checkpointId: targetCheckpoint.checkpointId, milestone: targetCheckpoint.milestone });
    return targetCheckpoint;
  }

  // --- User Steering & Forking (Sections 79-82) ---
  steerTask(taskId, { action, direction, newGoal = null }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    if (action === 'pause') {
      task.state = 'paused';
      this.recordEvent(taskId, 'TASK_PAUSED', { reason: direction });
      return { ok: true, state: 'paused' };
    }

    if (action === 'resume') {
      task.state = 'investigating';
      this.recordEvent(taskId, 'TASK_RESUMED', { reason: direction });
      return { ok: true, state: 'investigating' };
    }

    if (action === 'change_direction' && newGoal) {
      this.saveCheckpoint(taskId, 'pre_steering');
      task.goal = newGoal;
      // Invalidate unapproved proposal and stale hypotheses
      task.hypotheses = [];
      task.approvalState = 'UNAPPROVED';
      task.state = 'investigating';
      this.recordEvent(taskId, 'STEERING_DIRECTION_CHANGED', { newGoal, direction });
      return { ok: true, updatedGoal: newGoal };
    }

    return { ok: true };
  }

  forkTask(taskId, strategyName) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const forkId = `${taskId}_fork_${strategyName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    const forkTask = {
      ...this.createTask({
        taskId: forkId,
        sessionId: task.sessionId,
        goal: task.goal,
        intent: task.intent,
        workspace: task.workspace,
        repository: task.repository,
        project: task.project,
      }),
      targets: [...task.targets],
      findings: [...task.findings],
      evidence: [...task.evidence],
      parentTaskId: taskId,
      strategyName,
    };

    task.forks.push(forkId);
    this.recordEvent(taskId, 'TASK_FORKED', { forkId, strategyName });
    return forkTask;
  }

  assignSkill(taskId, skillId) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const skill = skillSystem.getSkill(skillId);
    if (!skill) throw new Error(`Unknown skill: ${skillId}`);
    task.activeSkill = skill.id;
    task.skillName = skill.name;
    task.skillPlaybook = [...skill.playbookSteps];
    task.skillStepIndex = 0;
    this.recordEvent(taskId, 'SKILL_ASSIGNED', { skillId, skillName: skill.name });
    return skill;
  }

  setOperatingMode(taskId, mode, complexity = null) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const routing = routeTaskMode({
      goal: task.goal,
      intent: task.intent,
      userRequestedMode: mode,
      explicitComplexity: complexity,
    });
    task.mode = routing.mode;
    task.complexity = routing.complexity;
    task.modeRouting = routing;
    task.budget.maxToolCalls = routing.effectiveToolBudget;
    this.recordEvent(taskId, 'MODE_CHANGED', { mode: routing.mode, complexity: routing.complexity });
    return routing;
  }

  executeNextSkillStep(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (!task.skillPlaybook || task.skillPlaybook.length === 0) {
      return { completed: true, step: null };
    }
    if (task.skillStepIndex >= task.skillPlaybook.length) {
      return { completed: true, step: null, totalSteps: task.skillPlaybook.length };
    }
    const currentStep = task.skillPlaybook[task.skillStepIndex];
    task.skillStepIndex++;
    this.recordEvent(taskId, 'SKILL_STEP_EXECUTED', {
      stepIndex: task.skillStepIndex,
      action: currentStep.action,
      purpose: currentStep.purpose,
    });
    return {
      completed: task.skillStepIndex >= task.skillPlaybook.length,
      step: currentStep,
      stepIndex: task.skillStepIndex,
      totalSteps: task.skillPlaybook.length,
    };
  }

  async invokeMcpTool(taskId, toolName, params = {}, context = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const result = await mcpToolAdapter.callTool(toolName, params, {
      ...context,
      taskContext: task,
      permissions: context.permissions || ['read', 'execute:allowlisted', 'network:local', 'browser:task_owned'],
    });

    task.mcpInvocations.push({
      toolName,
      ok: result.ok,
      durationMs: result.durationMs,
      timestamp: new Date().toISOString(),
    });

    task.budget.usedToolCalls++;
    this.recordEvent(taskId, 'MCP_TOOL_INVOKED', { toolName, ok: result.ok, durationMs: result.durationMs });

    return result;
  }

  async saveCheckpointToDisk(taskId, milestone = 'generic') {
    const task = this.getTask(taskId);
    if (!task) return null;
    const filePath = this.getCheckpointPath(taskId);
    const checkpoint = this.saveCheckpoint(taskId, milestone);
    const serializedTask = {
      taskId: task.taskId,
      sessionId: task.sessionId,
      ownerWebContentsId: task.ownerWebContentsId ?? null,
      goal: task.goal,
      intent: task.intent,
      mode: task.mode,
      complexity: task.complexity,
      activeSkill: task.activeSkill,
      skillName: task.skillName,
      skillPlaybook: task.skillPlaybook,
      skillStepIndex: task.skillStepIndex,
      state: task.state,
      workspace: task.workspace,
      repository: task.repository,
      project: task.project,
      package: task.package,
      targets: task.targets || [],
      symbols: task.symbols || [],
      findings: task.findings || [],
      evidence: task.evidence || [],
      hypotheses: task.hypotheses || [],
      rejectedHypotheses: task.rejectedHypotheses || [],
      completedSteps: task.completedSteps || [],
      budget: task.budget,
      approvalState: task.approvalState,
      checkpoints: task.checkpoints || [],
      workers: (task.workers || []).map((w) => ({
        workerId: w.workerId,
        role: w.role,
        status: w.status,
        findingsCount: (w.findings || []).length,
      })),
      nextAction: task.nextAction || null,
    };

    const savedAt = new Date().toISOString();
    const rawPayload = JSON.stringify({
      schemaVersion: 1,
      savedAt,
      task: serializedTask,
      checkpoint,
    }, null, 2);

    const checksum = crypto.createHash('sha256').update(rawPayload).digest('hex');
    const envelope = JSON.stringify({
      schemaVersion: 1,
      checksum,
      savedAt,
      task: serializedTask,
      checkpoint,
    }, null, 2);

    const checkpointRoot = this._checkpointStorageRoot;
    await authorizeAppOwnedMutation({
      root: checkpointRoot,
      target: checkpointRoot,
      resource: 'checkpoint',
      operation: 'write',
    });
    await fs.mkdir(checkpointRoot, { recursive: true });
    // Atomic Write (Section 20): Write to temp file, verify integrity, then atomic rename
    const tempFile = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(3).toString('hex')}`;
    try {
      await authorizeAppOwnedMutation({
        root: checkpointRoot,
        target: tempFile,
        resource: 'checkpoint',
        operation: 'write',
      });
      await fs.writeFile(tempFile, envelope, 'utf8');
      const verifyRead = await fs.readFile(tempFile, 'utf8');
      const verifyChecksum = JSON.parse(verifyRead).checksum;
      if (verifyChecksum !== checksum) {
        throw new Error('Integrity validation failed during checkpoint write.');
      }
      await authorizeAppOwnedMutation({
        root: checkpointRoot,
        target: filePath,
        resource: 'checkpoint',
        operation: 'replace',
      });
      await fs.rename(tempFile, filePath);
    } finally {
      await authorizeAppOwnedMutation({
        root: checkpointRoot,
        target: tempFile,
        resource: 'checkpoint',
        operation: 'remove',
      });
      await fs.rm(tempFile, { force: true });
    }

    this.recordEvent(taskId, 'CHECKPOINT_PERSISTED_TO_DISK', { filePath, checkpointId: checkpoint.checkpointId, schemaVersion: 1 });
    return checkpoint;
  }

  async restoreTaskFromDisk(taskId, expectedSessionId, expectedWorkspace) {
    if (!expectedSessionId || typeof expectedWorkspace !== 'string' || !expectedWorkspace) {
      throw new Error('Checkpoint restore requires the owning session and project root.');
    }
    const filePath = this.getCheckpointPath(taskId);
    const raw = await fs.readFile(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Corrupted checkpoint file: invalid JSON format');
    }

    // Checkpoint Versioning (Section 21)
    if (!parsed.schemaVersion || parsed.schemaVersion > 1) {
      throw new Error(`Incompatible checkpoint schema version: ${parsed.schemaVersion || 'none'}. Expected version 1.`);
    }

    // Checkpoint Integrity (Section 20)
    if (parsed.checksum) {
      const rawPayload = JSON.stringify({
        schemaVersion: parsed.schemaVersion,
        savedAt: parsed.savedAt,
        task: parsed.task,
        checkpoint: parsed.checkpoint,
      }, null, 2);
      const computed = crypto.createHash('sha256').update(rawPayload).digest('hex');
      if (computed !== parsed.checksum) {
        throw new Error('Corrupted checkpoint: checksum integrity mismatch.');
      }
    }

    const restoredTask = parsed.task;
    if (!restoredTask || !restoredTask.taskId) {
      throw new Error('Invalid task checkpoint file: missing taskId');
    }
    if (expectedSessionId && restoredTask.sessionId !== expectedSessionId) {
      throw new Error('Checkpoint belongs to a different Coding Agent session.');
    }
    if (typeof restoredTask.workspace !== 'string' || !restoredTask.workspace) {
      throw new Error('Checkpoint has no project binding and cannot be restored safely.');
    }
    const [checkpointRoot, selectedRoot] = await Promise.all([
      fs.realpath(restoredTask.workspace),
      fs.realpath(expectedWorkspace),
    ]);
    if (checkpointRoot !== selectedRoot) {
      throw new Error('Checkpoint belongs to a different Coding Agent project.');
    }

    this._tasks.set(restoredTask.taskId, restoredTask);
    if (!this._eventLogs.has(restoredTask.taskId)) {
      this._eventLogs.set(restoredTask.taskId, []);
    }
    this.recordEvent(restoredTask.taskId, 'TASK_RESTORED_FROM_DISK', {
      filePath,
      checkpointId: parsed.checkpoint?.checkpointId,
      schemaVersion: parsed.schemaVersion,
    });
    return restoredTask;
  }

  // --- Task Supervisor & Heartbeat (Stage 17 Section 13-17) ---
  getTaskHeartbeat(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const now = Date.now();
    const lastActivityTime = new Date(task.updatedAt || task.createdAt || now).getTime();
    const staleThresholdMs = 5 * 60 * 1000;
    const isStale = (now - lastActivityTime) > staleThresholdMs;

    const activeWorkers = (task.workers || []).filter((w) => w.status === 'RUNNING').map((w) => ({
      workerId: w.workerId,
      role: w.role,
      startedAt: w.startedAt,
    }));

    const lastAction = (task.toolHistory && task.toolHistory.length > 0)
      ? task.toolHistory[task.toolHistory.length - 1]
      : null;

    return {
      taskId: task.taskId,
      state: task.state,
      phase: task.currentPhase || task.state,
      lastActivity: task.updatedAt || new Date().toISOString(),
      lastSuccessfulAction: lastAction ? { tool: lastAction.name || lastAction.tool, time: lastAction.timestamp } : null,
      activeWorkersCount: activeWorkers.length,
      activeWorkers,
      currentTool: task.currentTool || (lastAction ? lastAction.name || lastAction.tool : null),
      retryState: {
        usedRetries: task.budget?.usedRetries || 0,
        maxRetries: task.budget?.maxRetries || 3,
      },
      isStale,
      backgroundExecution: Boolean(task.isBackground),
    };
  }

  handleClientDisconnect(taskId, clientId = 'renderer') {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.disconnectedClients = task.disconnectedClients || [];
    if (!task.disconnectedClients.includes(clientId)) {
      task.disconnectedClients.push(clientId);
    }
    task.isBackground = true;
    this.recordEvent(taskId, 'CLIENT_DISCONNECTED', { clientId, backgroundRunning: true });
    return {
      taskId: task.taskId,
      state: task.state,
      backgroundRunning: true,
      disconnectedAt: new Date().toISOString(),
    };
  }

  handleClientReconnect(taskId, clientId = 'renderer') {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (task.disconnectedClients) {
      task.disconnectedClients = task.disconnectedClients.filter((id) => id !== clientId);
    }
    this.recordEvent(taskId, 'CLIENT_RECONNECTED', { clientId, restoredPhase: task.currentPhase || task.state });
    return {
      taskId: task.taskId,
      state: task.state,
      phase: task.currentPhase || task.state,
      findings: task.findings || [],
      evidenceCount: (task.evidence || []).length,
      activeHypotheses: task.hypotheses || [],
      activeWorkers: (task.workers || []).filter((w) => w.status === 'RUNNING'),
      artifacts: task.artifacts || [],
      nextAction: task.nextAction || null,
      reconnectedAt: new Date().toISOString(),
    };
  }

  // --- Structured Event Replay (Stage 17 Section 22-23) ---
  replayTaskEvents(taskId) {
    const events = this.getEventLog(taskId);
    const narrative = {
      taskId,
      totalEvents: events.length,
      timeline: [],
      collectedEvidence: [],
      rejectedHypotheses: [],
      failures: [],
      recoveries: [],
      verifiedOutcomes: [],
      finalDecision: null,
    };

    for (const ev of events) {
      narrative.timeline.push({ type: ev.type, timestamp: ev.timestamp });
      if (ev.type === 'EVIDENCE_RECORDED' || ev.type === 'TOOL_COMPLETED') {
        narrative.collectedEvidence.push(ev.payload);
      }
      if (ev.type === 'HYPOTHESIS_REFUTED') {
        narrative.rejectedHypotheses.push(ev.payload);
      }
      if (ev.type.includes('FAILURE') || ev.type.includes('FAILED') || ev.type.includes('ERROR')) {
        narrative.failures.push(ev.payload);
      }
      if (ev.type.includes('RECOVERY') || ev.type.includes('FALLBACK') || ev.type.includes('RECOVERED')) {
        narrative.recoveries.push(ev.payload);
      }
      if (ev.type === 'VERIFICATION_COMPLETED' || ev.type === 'TEST_COMPLETED') {
        narrative.verifiedOutcomes.push(ev.payload);
      }
      if (ev.type === 'STATE_CHANGED' && ['completed', 'failed', 'cancelled', 'blocked'].includes(ev.payload?.to)) {
        narrative.finalDecision = ev.payload;
      }
    }
    return narrative;
  }

  // --- Real Parallel Worker Runtime & Concurrency Tracking (Stage 17 Section 26-30) ---
  async executeParallelWorkers(taskId, workerConfigs = [], workerRunnerFn) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    task.workers = task.workers || [];
    const instantiatedWorkers = workerConfigs.map((cfg, idx) => {
      const workerId = cfg.workerId || `worker_${Date.now()}_${idx}_${crypto.randomBytes(2).toString('hex')}`;
      return {
        workerId,
        parentTaskId: taskId,
        role: cfg.role || 'Generic Investigator',
        scope: cfg.scope || '.',
        budget: cfg.budget || { maxToolCalls: 5, maxRuntimeMs: 30000 },
        status: 'PENDING',
        context: cfg.context || {},
        findings: [],
        evidence: [],
        failure: null,
        result: null,
        startedAt: null,
        completedAt: null,
      };
    });

    task.workers.push(...instantiatedWorkers);
    this.recordEvent(taskId, 'PARALLEL_WORKERS_SCHEDULED', { count: instantiatedWorkers.length });

    const executionPromises = instantiatedWorkers.map(async (worker) => {
      if (task.cancelRequested || worker.status === 'CANCELLED') {
        worker.status = 'CANCELLED';
        return worker;
      }

      worker.status = 'RUNNING';
      worker.startedAt = Date.now();
      this.recordEvent(taskId, 'WORKER_STARTED', { workerId: worker.workerId, role: worker.role });

      try {
        const out = await workerRunnerFn(worker);
        worker.status = 'COMPLETED';
        worker.completedAt = Date.now();
        worker.result = out;
        worker.findings = Array.isArray(out?.findings) ? out.findings : [];
        worker.evidence = Array.isArray(out?.evidence) ? out.evidence : [];

        for (const f of worker.findings) {
          if (!task.findings.includes(f)) task.findings.push(f);
        }
        for (const e of worker.evidence) {
          task.evidence.push(e);
        }
        this.recordEvent(taskId, 'WORKER_COMPLETED', {
          workerId: worker.workerId,
          durationMs: worker.completedAt - worker.startedAt,
          findingsCount: worker.findings.length,
        });
        return worker;
      } catch (err) {
        worker.status = 'FAILED';
        worker.completedAt = Date.now();
        worker.failure = {
          message: err.message,
          error: String(err),
          timestamp: new Date().toISOString(),
        };
        this.recordEvent(taskId, 'WORKER_FAILED', {
          workerId: worker.workerId,
          role: worker.role,
          error: err.message,
        });
        return worker;
      }
    });

    await Promise.allSettled(executionPromises);
    const completedWorkers = instantiatedWorkers.filter((w) => w.status === 'COMPLETED');
    const failedWorkers = instantiatedWorkers.filter((w) => w.status === 'FAILED');

    this.detectAndResolveContradictions(taskId);

    return {
      taskId,
      totalWorkers: instantiatedWorkers.length,
      completedCount: completedWorkers.length,
      failedCount: failedWorkers.length,
      workers: instantiatedWorkers,
      failureIsolationPreserved: completedWorkers.length > 0 && failedWorkers.length > 0,
      contradictions: this.detectAndResolveContradictions(taskId),
    };
  }

  cancelWorker(taskId, workerId, reason = 'user_aborted') {
    const task = this.getTask(taskId);
    if (!task) return null;
    const worker = (task.workers || []).find((w) => w.workerId === workerId);
    if (worker && worker.status === 'RUNNING') {
      worker.status = 'CANCELLED';
      worker.completedAt = Date.now();
      worker.cancellationReason = reason;
      this.recordEvent(taskId, 'WORKER_CANCELLED', { workerId, reason });
      return worker;
    }
    return null;
  }

  async validateContextFreshness(taskId, targetSnapshots = []) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const staleFiles = [];
    const snapshotsToValidate = targetSnapshots.length > 0
      ? targetSnapshots
      : (task.targets || []).map((t) => (typeof t === 'string' ? { path: t } : t));

    for (const snap of snapshotsToValidate) {
      if (!snap || !snap.path) continue;
      try {
        const content = await fs.readFile(snap.path, 'utf8');
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');
        if (snap.hash && snap.hash !== currentHash) {
          staleFiles.push({ path: snap.path, expectedHash: snap.hash, currentHash });
        }
      } catch (err) {
        staleFiles.push({ path: snap.path, error: err.message });
      }
    }

    if (staleFiles.length > 0) {
      task.hasStaleContext = true;
      if (task.approvalState === 'APPROVED') {
        task.approvalState = 'UNAPPROVED';
        this.recordEvent(taskId, 'APPROVAL_INVALIDATED', { reason: 'stale_context_detected', staleFiles });
      }
      this.recordEvent(taskId, 'STALE_CONTEXT_DETECTED', { count: staleFiles.length, staleFiles });
      return { fresh: false, staleFiles };
    }

    task.hasStaleContext = false;
    return { fresh: true, staleFiles: [] };
  }

  invalidateApprovalIfStale(taskId, reason = 'proposal_modified') {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    if (task.approvalState === 'APPROVED') {
      task.approvalState = 'UNAPPROVED';
      if (task.state === 'approved' || task.state === 'executing') {
        task.state = 'awaiting_approval';
      }
      this.recordEvent(taskId, 'APPROVAL_INVALIDATED', { reason });
      return { invalidated: true, reason };
    }
    return { invalidated: false };
  }

  refuteHypothesis(taskId, hypothesisText, contradictoryEvidence = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const index = task.hypotheses.findIndex((h) => (typeof h === 'string' ? h : h.text) === hypothesisText);
    const item = index >= 0 ? task.hypotheses.splice(index, 1)[0] : hypothesisText;

    const record = {
      hypothesis: typeof item === 'string' ? item : item.text,
      refutedAt: new Date().toISOString(),
      reason: contradictoryEvidence?.reason || 'Contradicted by empirical observation',
      evidence: contradictoryEvidence,
    };

    task.rejectedHypotheses.push(record);
    this.recordEvent(taskId, 'HYPOTHESIS_REFUTED', record);
    return record;
  }

  resolveContradiction(taskId, { findingA, findingB, winningEvidence, resolution }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const disproven = resolution === 'keep_a' ? findingB : findingA;
    const kept = resolution === 'keep_a' ? findingA : findingB;

    const idx = task.findings.indexOf(disproven);
    if (idx >= 0) {
      task.findings.splice(idx, 1);
    }

    this.recordEvent(taskId, 'CONTRADICTION_RESOLVED', { kept, disproven, resolution, winningEvidence });
    return { resolved: true, kept, disproven };
  }

  recordToolCall(taskId, { tool, target, purpose, ok, findingsCount = 0 }) {
    const task = this.getTask(taskId);
    if (!task) return { stalled: false };

    task.toolHistory.push({
      tool,
      target,
      purpose,
      ok,
      findingsCount,
      timestamp: Date.now(),
    });

    task.budget.usedToolCalls++;
    return this.detectProgressStall(taskId);
  }

  detectProgressStall(taskId) {
    const task = this.getTask(taskId);
    if (!task) return { stalled: false };

    const history = task.toolHistory;
    if (history.length < 4) return { stalled: false };

    const recent = history.slice(-4);
    const first = recent[0];
    const allIdentical = recent.every(
      (h) => h.tool === first.tool && h.target === first.target && h.findingsCount === 0
    );

    if (allIdentical) {
      task.state = 'blocked';
      task.blocker = {
        reason: 'NO_PROGRESS_STALL_DETECTED',
        details: `Tool "${first.tool}" on target "${first.target}" repeated 4 times without yielding progress.`,
      };
      this.recordEvent(taskId, 'PROGRESS_STALL_DETECTED', task.blocker);
      return { stalled: true, blocker: task.blocker };
    }

    return { stalled: false };
  }

  cancelTask(taskId, reason = 'user_cancelled') {
    const task = this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    task.state = 'cancelled';
    let cancelledSubtasksCount = 0;
    for (const sub of task.subtasks) {
      if (sub.status === 'PENDING' || sub.status === 'RUNNING') {
        sub.status = 'CANCELLED';
        cancelledSubtasksCount++;
      }
    }

    this.recordEvent(taskId, 'TASK_CANCELLED', { reason, cancelledSubtasksCount });
    return { ok: true, state: 'cancelled', cancelledSubtasksCount };
  }
}

const taskOrchestrator = new TaskOrchestrator();

module.exports = {
  ORCHESTRATOR_STATES,
  ALLOWED_ORCHESTRATOR_TRANSITIONS,
  FAILURE_CLASSIFICATIONS_2,
  OPERATING_MODES,
  MODE_SPECIFICATIONS,
  COMPLEXITY_LEVELS,
  skillSystem,
  mcpToolAdapter,
  TaskOrchestrator,
  taskOrchestrator,
};
