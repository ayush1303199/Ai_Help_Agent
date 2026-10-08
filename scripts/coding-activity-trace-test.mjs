import assert from 'node:assert/strict';
import {
  finalizeCodingActivities,
  parseCodingActivityEvent,
  upsertCodingActivity,
} from '../src/features/coding/codingActivity.ts';
import { CodingAgentTransport } from '../src/features/coding/codingTransport.ts';

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
assert.deepEqual(state.map((item) => item.executionId), ['request-2']);

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

const outboundMessages = [];
globalThis.window = { electronAPI: undefined };
const requestTransport = new CodingAgentTransport();
requestTransport.connect = async () => ({
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
    onError(error) { throw error; },
  },
);
assert.equal(startedRoots[0], 'C:\\workspace\\selected-project');
assert.equal(outboundMessages[0].projectRoot, 'C:\\workspace\\selected-project');
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
