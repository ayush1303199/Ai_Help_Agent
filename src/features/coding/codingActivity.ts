export type CodingActivityType =
  | 'SEARCHING'
  | 'READING_FILE'
  | 'DISCOVERING_REPOSITORY'
  | 'INSPECTING_SYMBOL'
  | 'TRACING_CALLER'
  | 'VERIFYING'
  | 'INSPECTING_DATABASE'
  | 'TOOL'
  | 'PROPOSAL';

export type CodingActivityStatus =
  | 'STARTED'
  | 'PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'UNVERIFIED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'UNCERTAIN'
  | 'NOT_ESTABLISHED';

export interface CodingActivityResult {
  count?: number;
  rowCount?: number;
  lineCount?: number;
  sourceContextTruncated?: boolean;
  paths?: string[];
  databaseType?: string;
  executionStatus?: string;
  evidenceState?: 'BLOCKED' | 'UNCERTAIN' | 'NOT_ESTABLISHED';
  evidenceIds?: string[];
  exitCode?: number | null;
  command?: string;
  executed?: boolean;
}

export interface CodingActivityError {
  code?: string;
  message?: string;
}

export interface CodingActivityEvent {
  event: 'activity_event';
  activityId: string;
  executionId: string;
  taskId?: string;
  sessionId?: string;
  proposalId?: string;
  repairAttempt?: number;
  operationSequence?: number;
  action: {
    tool: string;
    target?: string;
    reason?: string;
    expectedEvidence?: string[];
  };
  activityType: CodingActivityType;
  status: CodingActivityStatus;
  result?: CodingActivityResult;
  error?: CodingActivityError;
  timestamp: string;
  terminalizedLocally?: boolean;
}

export interface CodingActivityMessage {
  id: string;
  executionId: string;
  phase: string;
  message: string;
  plan?: Record<string, unknown>;
}

export type CodingActivity = CodingActivityEvent | CodingActivityMessage;

const activityTypes = new Set<CodingActivityType>([
  'SEARCHING',
  'READING_FILE',
  'DISCOVERING_REPOSITORY',
  'INSPECTING_SYMBOL',
  'TRACING_CALLER',
  'VERIFYING',
  'INSPECTING_DATABASE',
  'TOOL',
  'PROPOSAL',
]);

const activityStatuses = new Set<CodingActivityStatus>([
  'STARTED',
  'PROGRESS',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'UNVERIFIED',
  'CANCELLED',
  'BLOCKED',
  'UNCERTAIN',
  'NOT_ESTABLISHED',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function boundedStringArray(value: unknown, limit: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, limit)
    .map((item) => item.slice(0, maxLength));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function parseCodingActivityEvent(value: unknown): CodingActivityEvent | null {
  if (!isRecord(value) || value.event !== 'activity_event') return null;
  if (
    typeof value.activityId !== 'string'
    || !value.activityId
    || typeof value.executionId !== 'string'
    || !value.executionId
    || !isRecord(value.action)
    || typeof value.action.tool !== 'string'
    || !value.action.tool
    || typeof value.status !== 'string'
    || !activityStatuses.has(value.status as CodingActivityStatus)
    || typeof value.timestamp !== 'string'
    || !value.timestamp
  ) return null;

  const rawType = value.activityType;
  const activityType = typeof rawType === 'string' && activityTypes.has(rawType as CodingActivityType)
    ? rawType as CodingActivityType
    : 'TOOL';
  const result: CodingActivityResult = {};
  const rawResult = isRecord(value.result) ? value.result : null;
  const verificationCompletionEstablished = rawResult?.executed === true
    && rawResult.exitCode === 0
    && !Object.prototype.hasOwnProperty.call(rawResult, 'evidenceState')
    && (rawResult.status === undefined || rawResult.status === 'PASS')
    && (rawResult.executionStatus === undefined || rawResult.executionStatus === 'PASS')
    && (rawResult.ok === undefined || rawResult.ok === true)
    && (rawResult.success === undefined || rawResult.success === true)
    && (rawResult.executionBlocked === undefined || rawResult.executionBlocked === false)
    && (rawResult.cancelled === undefined || rawResult.cancelled === false)
    && (rawResult.timedOut === undefined || rawResult.timedOut === false)
    && !rawResult.error
    && !rawResult.failure;
  const status = activityType === 'VERIFYING'
    && value.status === 'COMPLETED'
    && !verificationCompletionEstablished
    ? 'UNVERIFIED'
    : value.status as CodingActivityStatus;
  if (rawResult) {
    const count = nonnegativeInteger(rawResult.count);
    const rowCount = nonnegativeInteger(rawResult.rowCount);
    const lineCount = nonnegativeInteger(rawResult.lineCount);
    const exitCode = rawResult.exitCode === null
      ? null
      : (typeof rawResult.exitCode === 'number' && Number.isInteger(rawResult.exitCode)
        ? rawResult.exitCode
        : undefined);
    if (count !== undefined) result.count = count;
    if (rowCount !== undefined) result.rowCount = rowCount;
    if (lineCount !== undefined) result.lineCount = lineCount;
    if (rawResult.sourceContextTruncated === true) result.sourceContextTruncated = true;
    if (rawResult.exitCode === null || exitCode !== undefined) result.exitCode = exitCode ?? null;
    if (typeof rawResult.executed === 'boolean') result.executed = rawResult.executed;
    const paths = boundedStringArray(rawResult.paths, 40, 300);
    const evidenceIds = boundedStringArray(rawResult.evidenceIds, 20, 160);
    if (paths) result.paths = paths;
    if (evidenceIds) result.evidenceIds = evidenceIds;
    result.databaseType = boundedString(rawResult.databaseType, 80);
    result.executionStatus = boundedString(rawResult.executionStatus, 80);
    if (['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED'].includes(String(rawResult.evidenceState))) {
      result.evidenceState = rawResult.evidenceState as CodingActivityResult['evidenceState'];
    }
    result.command = boundedString(rawResult.command, 300);
  }

  const error = isRecord(value.error) ? {
    code: boundedString(value.error.code, 100),
    message: boundedString(value.error.message, 500),
  } : undefined;
  const expectedEvidence = boundedStringArray(value.action.expectedEvidence, 8, 240);
  const action = {
    tool: value.action.tool.slice(0, 120),
    target: boundedString(value.action.target, 300),
    reason: boundedString(value.action.reason, 500),
    expectedEvidence,
  };
  const timestamp = value.timestamp.slice(0, 40);
  return {
    event: 'activity_event',
    activityId: value.activityId.slice(0, 200),
    executionId: value.executionId.slice(0, 200),
    taskId: boundedString(value.taskId, 200),
    sessionId: boundedString(value.sessionId, 200),
    proposalId: boundedString(value.proposalId, 200),
    repairAttempt: nonnegativeInteger(value.repairAttempt),
    operationSequence: nonnegativeInteger(value.operationSequence),
    action,
    activityType,
    status,
    result: rawResult ? result : undefined,
    error,
    timestamp,
    terminalizedLocally: false,
  };
}

const terminalStatuses = new Set<CodingActivityStatus>([
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'UNVERIFIED',
  'CANCELLED',
  'BLOCKED',
  'UNCERTAIN',
  'NOT_ESTABLISHED',
]);

function lifecycleRank(status: CodingActivityStatus): number {
  if (status === 'STARTED') return 0;
  if (status === 'PROGRESS') return 1;
  return 2;
}

function isOlderActivity(existing: CodingActivityEvent, incoming: CodingActivityEvent): boolean {
  if (lifecycleRank(incoming.status) < lifecycleRank(existing.status)) return true;
  if (existing.operationSequence !== undefined && incoming.operationSequence !== undefined) {
    if (incoming.operationSequence !== existing.operationSequence) {
      return incoming.operationSequence < existing.operationSequence;
    }
  }
  const existingTime = Date.parse(existing.timestamp);
  const incomingTime = Date.parse(incoming.timestamp);
  if (Number.isFinite(existingTime) && Number.isFinite(incomingTime) && incomingTime !== existingTime) {
    return incomingTime < existingTime;
  }
  if (incoming.status === existing.status) return true;
  return lifecycleRank(incoming.status) <= lifecycleRank(existing.status);
}

export function upsertCodingActivity(
  current: CodingActivity[],
  activity: CodingActivity,
): CodingActivity[] {
  if (!('event' in activity)) {
    const existingIndex = current.findIndex(
      (item) => !('event' in item) && item.id === activity.id,
    );
    if (existingIndex < 0) return [...current, activity].slice(-40);
    const updated = [...current];
    updated[existingIndex] = activity;
    return updated.slice(-40);
  }
  const existingIndex = current.findIndex(
    (item) => 'event' in item
      && item.executionId === activity.executionId
      && item.activityId === activity.activityId,
  );
  if (existingIndex < 0) return [...current, activity].slice(-40);
  const existing = current[existingIndex];
  if (!('event' in existing)) return [...current, activity].slice(-40);
  const existingTerminal = terminalStatuses.has(existing.status);
  const incomingTerminal = terminalStatuses.has(activity.status);
  if (existingTerminal) {
    if (!(existing.terminalizedLocally && incomingTerminal && !activity.terminalizedLocally)) {
      return current;
    }
  } else if (isOlderActivity(existing, activity)) {
    return current;
  }
  const updated = [...current];
  updated[existingIndex] = activity;
  return updated.slice(-40);
}

export function finalizeCodingActivities(
  current: CodingActivity[],
  executionId: string,
  status: 'UNVERIFIED',
): CodingActivity[] {
  return current.map((item) => (
    'event' in item
    && item.event === 'activity_event'
    && item.executionId === executionId
    && (item.status === 'STARTED' || item.status === 'PROGRESS')
      ? { ...item, status, terminalizedLocally: true }
      : item
  ));
}
