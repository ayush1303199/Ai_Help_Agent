import assert from 'node:assert/strict';
import {
  finalizeCodingActivities,
  parseCodingActivityEvent,
  upsertCodingActivity,
} from '../src/features/coding/codingActivity.ts';
import { CodingAgentTransport, CodingTransportError } from '../src/features/coding/codingTransport.ts';

function event(overrides = {}) {
  return {
    type: 'activity_event',
    event: 'activity_event',
    activityId: 'task-1:turn-1:1:1',
    executionId: 'request-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    action: { tool: 'search_code', target: 'src/example.ts' },
    activityType: 'SEARCHING',
    status: 'STARTED',
    timestamp: '2026-10-07T12:00:00Z',
    ...overrides,
  };
}

const started = parseCodingActivityEvent(event());
assert.ok(started, 'A valid structured STARTED event should be accepted.');
assert.equal(started.status, 'STARTED');

const completed = parseCodingActivityEvent(event({
  status: 'COMPLETED',
  result: { count: 2, paths: ['src/a.ts', 'src/b.ts'] },
}));
assert.ok(completed);
const excerptedRead = parseCodingActivityEvent(event({
  activityType: 'READING_FILE',
  action: { tool: 'read_file', target: 'src/controller.php' },
  status: 'COMPLETED',
  result: { lineCount: 2400, sourceContextTruncated: true },
}));
assert.ok(excerptedRead);
assert.equal(excerptedRead.result?.lineCount, 2400);
assert.equal(excerptedRead.result?.sourceContextTruncated, true);
let state = upsertCodingActivity([], started);
assert.equal(state.length, 1, 'STARTED should create one active activity.');
state = upsertCodingActivity(state, completed);
assert.equal(state.length, 1, 'A terminal event should update the matching activity.');
assert.equal(state[0].status, 'COMPLETED');
assert.equal(state[0].activityId, started.activityId);
assert.deepEqual(state[0].result?.paths, ['src/a.ts', 'src/b.ts']);

const failed = parseCodingActivityEvent(event({
  status: 'FAILED',
  error: { code: 'TOOL_FAILED', message: 'The read failed.' },
}));
assert.ok(failed);
state = upsertCodingActivity([], failed);
assert.equal(state[0].status, 'FAILED');
assert.equal(state[0].error?.message, 'The read failed.');

const unverified = parseCodingActivityEvent(event({
  activityType: 'VERIFYING',
  action: { tool: 'run_verification', target: 'test' },
  status: 'UNVERIFIED',
  result: { executionStatus: 'UNVERIFIED', exitCode: null },
}));
assert.ok(unverified);
assert.equal(unverified.status, 'UNVERIFIED');
assert.equal(unverified.result?.exitCode, null);

for (const status of ['BLOCKED', 'UNCERTAIN', 'NOT_ESTABLISHED']) {
  const evidenceState = parseCodingActivityEvent(event({
    activityType: 'VERIFYING',
    action: { tool: 'run_verification', target: 'typecheck' },
    status,
    result: { executed: false, evidenceState: status },
  }));
  assert.ok(evidenceState);
  assert.equal(evidenceState.status, status);
  assert.equal(evidenceState.result?.evidenceState, status);
}

for (const result of [
  undefined,
  { executed: false, exitCode: 0 },
  { executed: true, exitCode: 1 },
  { executed: true, exitCode: 0, evidenceState: 'NOT_ESTABLISHED' },
  { executed: true, exitCode: 0, evidenceState: 'UNRECOGNIZED' },
  { executed: true, exitCode: 0, status: 'BLOCKED' },
  { executed: true, exitCode: 0, executionStatus: 'BLOCKED' },
  { executed: true, exitCode: 0, ok: false },
  { executed: true, exitCode: 0, success: false },
  { executed: true, exitCode: 0, success: 'true' },
  { executed: true, exitCode: 0, executionBlocked: true },
  { executed: true, exitCode: 0, executionBlocked: null },
  { executed: true, exitCode: 0, cancelled: true },
  { executed: true, exitCode: 0, timedOut: true },
  { executed: true, exitCode: 0, error: 'verification failed' },
  { executed: true, exitCode: 0, failure: 'verification failed' },
  { exitCode: 0, success: true, verified: true, authorized: true },
]) {
  const malformedCompletion = parseCodingActivityEvent(event({
    activityType: 'VERIFYING',
    action: { tool: 'run_verification', target: 'typecheck' },
    status: 'COMPLETED',
    result,
  }));
  assert.ok(malformedCompletion);
  assert.equal(malformedCompletion.status, 'UNVERIFIED');
}
const executedVerificationCompletion = parseCodingActivityEvent(event({
  activityType: 'VERIFYING',
  action: { tool: 'run_verification', target: 'typecheck' },
  status: 'COMPLETED',
  result: { executed: true, exitCode: 0 },
}));
assert.equal(executedVerificationCompletion?.status, 'COMPLETED');
const backendVerificationCompletion = parseCodingActivityEvent(event({
  activityType: 'VERIFYING',
  action: { tool: 'run_verification', target: 'typecheck' },
  status: 'COMPLETED',
  result: { executed: true, exitCode: 0, executionStatus: 'PASS' },
}));
assert.equal(backendVerificationCompletion?.status, 'COMPLETED');

const progress = parseCodingActivityEvent(event({
  status: 'PROGRESS',
  operationSequence: 2,
}));
assert.ok(progress);
assert.equal(progress.status, 'PROGRESS');
state = upsertCodingActivity([started], progress);
assert.equal(state[0].status, 'PROGRESS');
assert.equal(upsertCodingActivity(state, started)[0].status, 'PROGRESS', 'Older updates must not replace newer progress.');
assert.equal(upsertCodingActivity(state, progress), state, 'Duplicate progress events should be suppressed.');
const staleProgress = parseCodingActivityEvent(event({
  status: 'PROGRESS',
  timestamp: '2026-10-07T11:59:59Z',
}));
assert.ok(staleProgress);
assert.equal(upsertCodingActivity(state, staleProgress)[0].timestamp, progress.timestamp);

const blocked = parseCodingActivityEvent(event({
  status: 'BLOCKED',
  terminalizedLocally: true,
  proposalId: 'proposal-1',
  repairAttempt: 2,
  result: { executed: false },
}));
assert.ok(blocked);
assert.equal(blocked.result?.executed, false);
assert.equal(blocked.proposalId, 'proposal-1');
assert.equal(blocked.repairAttempt, 2);
assert.equal(blocked.terminalizedLocally, false, 'Only the local reducer may mark provisional outcomes.');
const proposal = parseCodingActivityEvent(event({
  activityId: 'task-1:proposal-created',
  activityType: 'PROPOSAL',
  status: 'COMPLETED',
  result: { executionStatus: 'AWAITING_APPROVAL', executed: false },
}));
assert.ok(proposal);
assert.equal(proposal.activityType, 'PROPOSAL');
assert.equal(proposal.result?.executed, false, 'Proposal creation must not imply project execution.');
state = upsertCodingActivity([started], completed);
assert.equal(upsertCodingActivity(state, failed)[0].status, 'COMPLETED', 'An authoritative terminal outcome is immutable.');

const provisional = finalizeCodingActivities([started], 'request-1', 'UNVERIFIED');
state = upsertCodingActivity(provisional, completed);
assert.equal(state[0].status, 'COMPLETED', 'An authoritative result may resolve local provisional UNVERIFIED.');
assert.equal(state[0].terminalizedLocally, false);
assert.equal(upsertCodingActivity(provisional, {
  ...completed,
  terminalizedLocally: true,
})[0].status, 'UNVERIFIED', 'A local provisional terminal cannot overwrite itself with another local terminal.');

const unknownType = parseCodingActivityEvent(event({ activityType: 'UNRECOGNIZED' }));
assert.ok(unknownType);
assert.equal(unknownType.activityType, 'TOOL', 'Unknown activity types should safely fall back.');
assert.equal(parseCodingActivityEvent(event({ status: 'INFERRED' })), null);

const secondExecution = parseCodingActivityEvent(event({
  activityId: 'task-2:turn-2:1:1',
  executionId: 'request-2',
  taskId: 'task-2',
}));
assert.ok(secondExecution);
state = upsertCodingActivity([started], secondExecution);
assert.deepEqual(state.map((item) => item.executionId), ['request-1', 'request-2']);

state = finalizeCodingActivities([started, completed], 'request-1', 'UNVERIFIED');
assert.equal(state[0].status, 'UNVERIFIED');
assert.equal(state[0].terminalizedLocally, true);
assert.equal(state[1].status, 'COMPLETED', 'Already-terminal activities must remain unchanged.');
assert.equal(state[0].result, undefined, 'Local finalization must not synthesize a result.');

const transport = new CodingAgentTransport();
const receivedByRequest = new Map([
  ['request-1', []],
  ['request-2', []],
]);
for (const [requestId, activities] of receivedByRequest) {
  transport.requests.set(requestId, {
    scope: '.',
    handlers: { onActivity: activity => activities.push(activity) },
    chunks: [],
    filesRead: new Map(),
    filesSearched: new Set(),
    toolCalls: [],
    activityCount: 0,
  });
}
await transport.handleMessage({}, JSON.stringify(event({ status: 'STARTED' })));
await transport.handleMessage({}, JSON.stringify(event({
  activityId: 'task-2:turn-2:1:1',
  executionId: 'request-2',
  taskId: 'task-2',
  status: 'STARTED',
})));
assert.equal(receivedByRequest.get('request-1').length, 1);
assert.equal(receivedByRequest.get('request-1')[0].executionId, 'request-1');
assert.equal(receivedByRequest.get('request-2').length, 1);
assert.equal(receivedByRequest.get('request-2')[0].executionId, 'request-2');
transport.close();

const cancellationResults = [];
const cancellationTransport = new CodingAgentTransport();
cancellationTransport.requests.set('cancel-unverified', {
  scope: '.',
  handlers: {
    onActivity() {},
    onDone: result => cancellationResults.push(result.status),
    onError(error) { throw error; },
  },
  chunks: [],
  filesRead: new Map(),
  filesSearched: new Set(),
  toolCalls: [],
  activityCount: 0,
  idleTimer: null,
  maxDurationTimer: null,
  cancellationTimer: null,
});
cancellationTransport.requests.set('cancel-confirmed', {
  scope: '.',
  handlers: {
    onActivity() {},
    onDone: result => cancellationResults.push(result.status),
    onError(error) { throw error; },
  },
  chunks: [],
  filesRead: new Map(),
  filesSearched: new Set(),
  toolCalls: [],
  activityCount: 0,
  idleTimer: null,
  maxDurationTimer: null,
  cancellationTimer: null,
});
cancellationTransport.requests.set('cancel-not-active', {
  scope: '.',
  handlers: {
    onActivity() {},
    onDone: result => cancellationResults.push(result.status),
    onError(error) { throw error; },
  },
  chunks: [],
  filesRead: new Map(),
  filesSearched: new Set(),
  toolCalls: [],
  activityCount: 0,
  idleTimer: null,
  maxDurationTimer: null,
  cancellationTimer: null,
});
await cancellationTransport.handleMessage({}, JSON.stringify({
  type: 'cancelled',
  requestId: 'cancel-unverified',
  status: 'UNVERIFIED',
}));
await cancellationTransport.handleMessage({}, JSON.stringify({
  type: 'cancelled',
  requestId: 'cancel-confirmed',
  status: 'CANCELLED',
}));
await cancellationTransport.handleMessage({}, JSON.stringify({
  type: 'cancelled',
  requestId: 'cancel-not-active',
  status: 'NOT_ACTIVE',
}));
assert.deepEqual(cancellationResults, ['CANCELLATION_UNVERIFIED', 'CANCELLED', 'CANCELLATION_UNVERIFIED']);
cancellationTransport.close();

const outboundMessages = [];
let receivedProviderFailure;
globalThis.window = {
  electronAPI: undefined,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};
const requestTransport = new CodingAgentTransport();
requestTransport.connect = async () => ({
  readyState: 1,
  send: payload => outboundMessages.push(JSON.parse(payload)),
});
const startedRoots = [];
await requestTransport.send(
  'selected-project-request',
  [{ role: 'user', content: 'Inspect this project.' }],
  '.',
  'C:\\workspace\\selected-project',
  {
    onStart: (_turnId, root) => startedRoots.push(root),
    onActivity() {},
    onToken() {},
    onDone() {},
    onError(error) { receivedProviderFailure = error; },
  },
);
assert.equal(startedRoots[0], 'C:\\workspace\\selected-project');
assert.equal(outboundMessages[0].projectRoot, 'C:\\workspace\\selected-project');
await requestTransport.handleMessage({}, JSON.stringify({
  type: 'error',
  requestId: 'selected-project-request',
  classification: 'EXTERNAL_RESOURCE_FAILURE',
  category: 'PROVIDER_QUOTA_EXHAUSTED',
  retryable: false,
  message: 'Provider quota exhausted; task preserved.',
  providerRecovery: {
    state: 'WAITING_FOR_PROVIDER',
    classification: 'PROVIDER_QUOTA_EXHAUSTED',
    retryable: false,
    suggestedAction: 'CHECK_PROVIDER_QUOTA_RESET',
  },
  agentTaskState: { status: 'INCOMPLETE', originalRequest: 'Inspect this project.' },
}));
assert.ok(receivedProviderFailure instanceof CodingTransportError);
assert.equal(receivedProviderFailure.providerRecovery?.state, 'WAITING_FOR_PROVIDER');
assert.equal(receivedProviderFailure.category, 'PROVIDER_QUOTA_EXHAUSTED');
await requestTransport.send(
  'resumed-project-request',
  [{ role: 'user', content: 'Continue the saved task.' }],
  '.',
  'C:\\workspace\\selected-project',
  {
    onStart() {},
    onActivity() {},
    onToken() {},
    onDone() {},
    onError(error) { throw error; },
  },
  undefined,
  null,
  true,
);
assert.equal(outboundMessages[1].resumeProviderTask, true);
requestTransport.close();

const genericText = {
  id: 'message:request-1:0',
  executionId: 'request-1',
  phase: 'reading',
  message: 'Searching code...',
};
state = upsertCodingActivity([], genericText);
assert.equal(state[0].message, 'Searching code...');
assert.equal('event' in state[0], false, 'Free text must not be reconstructed as structured execution.');

const oversized = parseCodingActivityEvent(event({
  result: {
    count: 2,
    paths: Array.from({ length: 50 }, (_, index) => `src/${index}.ts`),
    evidenceIds: Array.from({ length: 30 }, (_, index) => `ev-${index}`),
  },
}));
assert.ok(oversized);
assert.equal(oversized.result?.paths?.length, 40, 'Paths should remain bounded.');
assert.equal(oversized.result?.evidenceIds?.length, 20, 'Evidence IDs should remain bounded.');

console.log('Coding activity trace tests passed.');
