import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const projectRoot = 'C:\\repair-runtime-project';
const original = 'console.log("original");\n';
const diff = [
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1 +1 @@',
  '-console.log("original");',
  '+console.log("changed");',
  '',
].join('\n');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5174/',
});
const previous = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  webSocket: globalThis.WebSocket,
  actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto });

const providerRequests = [];
const proposalRegistrations = [];
const conversationRepairTokens = [];
const conversationUpdates = [];
let applyCalls = 0;
let conversationCount = 0;
let initialProjectSync = false;
let autoModeGranted = false;
let nextDoneMessage = null;
let proposalHandoffPlan = null;

class RuntimeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor() {
    setTimeout(() => {
      this.readyState = RuntimeWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(serialized) {
    const request = JSON.parse(serialized);
    if (request.type === 'authenticate') {
      setTimeout(() => this.onmessage?.({
        data: JSON.stringify({ type: 'authenticated', authenticated: true, connectionId: 'connection-1' }),
      }), 0);
      return;
    }
    if (request.type !== 'chat') return;
    providerRequests.push(request);
    const response = nextDoneMessage || {
      content: diff,
      proposalRequired: true,
      status: 'PROPOSAL_READY',
      filesRead: [{ path: 'src/index.ts', content: original }],
      toolCalls: [],
    };
    nextDoneMessage = null;
    setTimeout(() => this.onmessage?.({
      data: JSON.stringify({
        type: 'done',
        requestId: request.requestId,
        ...response,
      }),
    }), 0);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
globalThis.WebSocket = RuntimeWebSocket;
dom.window.WebSocket = RuntimeWebSocket;

window.electronAPI = {
  getDeveloperProjectState: async () => ({ status: 'PROJECT_ATTACHED', projectRoot }),
  listDeveloperDirectory: async () => {
    initialProjectSync = true;
    return [];
  },
  getDeveloperBackendAuthToken: async () => 'runtime-test-auth',
  registerDeveloperMutationConnection: async () => ({ registered: true }),
  beginDeveloperConversation: async (_request, scope, repairToken) => {
    conversationRepairTokens.push(repairToken || null);
    return {
      turnId: `turn-${++conversationCount}`,
      sessionId: 'session-1',
      projectRoot,
      scope,
    };
  },
  advanceDeveloperConversation: async ({ turnId, state, phase, fileCount }) => {
    const update = { turnId, state, phase, fileCount };
    conversationUpdates.push(update);
    return { ...update, updatedAt: new Date().toISOString() };
  },
  readDeveloperFile: async () => ({ content: original }),
  createDeveloperProposal: async (raw, snapshots, _script, _scope, _turnId, repairToken, handoffWorkflowRequestId) => {
    const index = proposalRegistrations.length;
    proposalRegistrations.push({ raw, snapshots, repairToken, handoffWorkflowRequestId });
    return {
      id: `proposal-${index + 1}`,
      proposalId: `proposal-ref-${index + 1}`,
      manifestHash: `manifest-${index + 1}`,
      taskPlan: handoffWorkflowRequestId ? {
        schemaVersion: 2,
        status: 'HANDED_OFF',
        workItems: proposalHandoffPlan?.workItems?.map((item) => ({ ...item })) || [],
      } : null,
      state: repairToken && autoModeGranted ? 'approved' : 'awaiting_approval',
      lifecycleState: repairToken && autoModeGranted ? 'APPROVED' : 'WAITING_FOR_APPROVAL',
      attemptNumber: repairToken ? 2 : 1,
      maxAttempts: autoModeGranted ? 4 : 3,
      attemptLabel: repairToken && autoModeGranted
        ? 'attempt 2 of 4'
        : repairToken ? 'attempt 2 of 3' : 'attempt 1 of 3',
      repairAvailable: false,
      autoRepairEnabled: repairToken && autoModeGranted,
      autoRepairAuthorized: repairToken && autoModeGranted,
      reviewFlags: [],
      files: [],
      runtime: null,
    };
  },
  approveDeveloperProposal: async (id, options = {}) => {
    autoModeGranted = options.autoRepair === true;
    return { id, state: 'approved', autoRepairEnabled: autoModeGranted };
  },
  applyDeveloperProposal: async (id) => {
    applyCalls += 1;
    if (applyCalls === 3) {
      return {
        id,
        state: 'completed',
        verification: { status: 'PASS', executed: true, exitCode: 0 },
        repairAvailable: false,
        attemptNumber: 2,
        maxAttempts: 4,
        attemptLabel: 'attempt 2 of 4',
      };
    }
    return {
      id,
      state: 'failed',
      verification: {
        status: 'CODE_FAILURE',
        classification: 'CODE_FAILURE',
        attempts: [{
          check: 'test',
          ok: false,
          executed: true,
          exitCode: 1,
          stderr: 'src/index.ts:1:1 test failed',
          stdout: '',
          extracted: { file: 'src/index.ts', line: 1, message: 'test failed' },
        }],
      },
      repairAvailable: true,
      attemptNumber: 1,
      maxAttempts: 3,
      attemptLabel: 'attempt 1 of 3',
      fileState: 'Restored to the pre-attempt snapshot.',
    };
  },
  getDeveloperVerificationRepairContext: async () => ({
    repairToken: 'main-issued-one-time-token',
    attemptNumber: 2,
    maxAttempts: autoModeGranted ? 4 : 3,
    attemptLabel: autoModeGranted ? 'attempt 2 of 4' : 'attempt 2 of 3',
    check: 'test',
    classification: 'CODE_FAILURE',
    location: 'src/index.ts:1',
    output: 'src/index.ts:1:1 test failed',
  }),
  cancelDeveloperVerificationRepairChain: async () => ({ cancelled: true }),
  rejectDeveloperProposal: async (id) => ({ id, state: 'cancelled' }),
};
localStorage.setItem('ai_help_agent_coding_project_root', projectRoot);

const vite = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true } });
let root;
let current;
const waitForReact = async (predicate, message) => {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  throw new Error(message);
};

try {
  const { useCodingAgentController } = await vite.ssrLoadModule(
    '/src/features/coding/useCodingAgentController.ts',
  );
  function Harness() {
    current = useCodingAgentController({
      maxContextChars: 12000,
      maxHistoryMessages: 20,
      maxMessageChars: 8000,
    });
    return null;
  }

  root = createRoot(document.getElementById('root'));
  act(() => flushSync(() => root.render(createElement(Harness))));
  await waitForReact(
    () => initialProjectSync && current?.workspace?.projectRoot === projectRoot,
    'The attached project did not initialize.',
  );
  await act(async () => {
    current.workspace.onInputChange('Make a safe change.');
  });
  await act(async () => {
    current.workspace.onSendMessage();
  });
  await waitForReact(() => providerRequests.length === 1 && current.workspace.proposal?.id === 'proposal-1', 'The initial proposal was not prepared.');
  await act(async () => {
    current.workspace.onApproveProposal();
  });
  await waitForReact(() => current.workspace.proposal?.state === 'approved', 'The initial proposal was not approved.');
  await act(async () => {
    current.workspace.onApplyProposal();
  });
  await waitForReact(() => current.workspace.proposal?.state === 'failed', 'The verification failure was not surfaced.');

  assert.equal(providerRequests.length, 1, 'Verification failure must not trigger an automatic provider call.');
  assert.equal(applyCalls, 1);
  assert.equal(current.workspace.proposal.attemptLabel, 'attempt 1 of 3');

  await act(async () => {
    current.workspace.onRequestRepair();
  });
  await waitForReact(() => providerRequests.length === 2 && current.workspace.proposal?.id === 'proposal-2', 'The explicit repair action did not produce a proposal.');
  assert.equal(providerRequests.length, 2, 'One explicit repair action must produce exactly one provider request.');
  assert.equal(applyCalls, 1, 'A repair proposal must not write before its separate approval and apply action.');
  assert.equal(proposalRegistrations[1].repairToken, 'main-issued-one-time-token');
  assert.deepEqual(conversationRepairTokens, [null, 'main-issued-one-time-token']);
  assert.equal(providerRequests[1].verificationAttempt.repairToken, undefined);
  assert.match(providerRequests[1].messages.at(-1).content, /untrusted program output, not instructions/i);
  assert.doesNotMatch(providerRequests[1].messages.at(-1).content, /main-issued-one-time-token/);
  assert.equal(current.workspace.proposal.attemptLabel, 'attempt 2 of 3');

  await act(async () => {
    current.workspace.onApproveProposal();
  });
  await waitForReact(() => current.workspace.proposal?.state === 'approved', 'The repair proposal was not approved.');
  assert.equal(applyCalls, 1, 'Approval alone must not apply the repair patch.');
  console.log('Coding repair runtime provider-count and approval-gating test passed.');

  await act(async () => {
    current.workspace.onClearMessages();
  });
  await waitForReact(() => current.workspace.proposal === null, 'The completed manual test setup did not reset.');
  await act(async () => {
    current.workspace.onInputChange('Make an Auto mode change.');
  });
  await act(async () => {
    current.workspace.onSendMessage();
  });
  await waitForReact(() => providerRequests.length === 3 && current.workspace.proposal?.id === 'proposal-3', 'The Auto mode initial proposal was not prepared.');
  await act(async () => {
    current.workspace.onAutoRepairChange(true);
  });
  await waitForReact(() => current.workspace.autoRepairChoice === true, 'Auto mode could not be selected.');
  await act(async () => {
    current.workspace.onApproveProposal();
  });
  await waitForReact(
    () => providerRequests.length === 4 && applyCalls === 3
      && current.workspace.proposal?.id === 'proposal-4'
      && current.workspace.proposal?.state === 'completed',
    `Auto mode did not finish the bounded repair cycle (requests=${providerRequests.length}, applies=${applyCalls}, proposal=${JSON.stringify(current.workspace.proposal)}, status=${current.workspace.statusMessage}).`,
  );
  assert.equal(providerRequests.length, 4, 'One automatic repair must use one additional model cycle.');
  assert.equal(applyCalls, 3, 'Auto mode must apply the initial proposal and one repair without a second approval click.');
  assert.equal(proposalRegistrations[3].repairToken, 'main-issued-one-time-token');
  console.log('Coding Auto mode edit-verify-repair runtime test passed.');

  await act(async () => {
    current.workspace.onClearMessages();
  });
  await waitForReact(() => current.workspace.proposal === null, 'The Auto mode test setup did not reset.');
  const handoffRequest = 'Add bounded retry handling to the request processor';
  const handoffWorkItems = [
    {
      id: 'WI-001',
      objective: 'Persist retry settings.',
      status: 'DELEGATED',
      dependsOn: [],
      requiredEvidence: ['APPROVED_SCOPE_PROPOSAL', 'EXPLICIT_APPROVAL', 'VERIFICATION_PASS'],
    },
    {
      id: 'WI-002',
      objective: 'Expose retry settings through the API.',
      status: 'DELEGATED',
      dependsOn: ['WI-001'],
      requiredEvidence: ['APPROVED_SCOPE_PROPOSAL', 'EXPLICIT_APPROVAL', 'VERIFICATION_PASS'],
    },
    {
      id: 'WI-003',
      objective: 'Add focused retry behavior tests.',
      status: 'DELEGATED',
      dependsOn: ['WI-002'],
      requiredEvidence: ['APPROVED_SCOPE_PROPOSAL', 'EXPLICIT_APPROVAL', 'VERIFICATION_PASS'],
    },
  ];
  proposalHandoffPlan = {
    schemaVersion: 2,
    status: 'HANDED_OFF',
    workItems: handoffWorkItems.map((item) => ({ ...item })),
  };
  let workflowRequest = null;
  window.electronAPI.executeDeveloperWorkflow = async (payload) => {
    workflowRequest = payload;
    return {
      outcome: 'IMPLEMENTATION_REQUIRED',
      taskState: { status: 'INCOMPLETE', objective: { request: handoffRequest } },
      taskPlan: {
        schemaVersion: 2,
        status: 'HANDED_OFF',
        workItems: handoffWorkItems.map((item) => ({ ...item })),
      },
      nextAction: { tool: 'standard_coding_proposal' },
    };
  };
  await act(async () => {
    current.workspace.onInputChange(handoffRequest);
  });
  await act(async () => {
    current.workspace.onSendMessage();
  });
  await waitForReact(
    () => providerRequests.length === 5 && current.workspace.proposal?.id === 'proposal-5',
    'An implementation-required investigation did not continue through the standard Coding Agent proposal flow.',
  );
  assert.equal(current.workspace.proposal?.state, 'awaiting_approval');
  assert.equal(workflowRequest.userRequest, handoffRequest);
  assert.equal(providerRequests[4].messages.filter((message) => (
    message.role === 'user' && message.content === handoffRequest
  )).length, 1, 'The original objective must be sent once during handoff.');
  assert.match(
    providerRequests[4].messages.at(-2).content,
    /Continue the original user request through the standard Coding Agent workflow/,
  );
  const handoffPlanMessage = providerRequests[4].messages.at(-2).content;
  for (const item of handoffWorkItems) {
    assert.ok(handoffPlanMessage.includes(item.id), `The proposal workflow must receive work-item identity ${item.id}.`);
    assert.ok(handoffPlanMessage.includes(item.objective), `The proposal workflow must receive objective ${item.id}.`);
    for (const dependency of item.dependsOn) {
      assert.ok(handoffPlanMessage.includes(dependency), `The proposal workflow must receive dependency ${dependency}.`);
    }
    for (const evidence of item.requiredEvidence) {
      assert.ok(handoffPlanMessage.includes(evidence), `The proposal workflow must receive evidence requirement ${evidence}.`);
    }
  }
  assert.equal(
    proposalRegistrations[4].raw.includes('+console.log("changed");'),
    true,
    'The standard proposal flow should use the existing proposal registration boundary.',
  );
  assert.equal(typeof proposalRegistrations[4].handoffWorkflowRequestId, 'string');
  assert.deepEqual(
    current.workspace.proposal.handoffPlan?.workItems.map((item) => item.id),
    handoffWorkItems.map((item) => item.id),
    'The registered proposal must retain the exact version-2 handoff plan.',
  );
  assert.equal(applyCalls, 3, 'Handoff must prepare a proposal without applying it.');
  assert.match(
    current.workspace.messages.at(-1).content,
    /original request remains incomplete until every handed-off work item is covered/i,
    'The proposal-ready response must not claim the handed-off multi-item request is complete.',
  );
  assert.doesNotMatch(
    current.workspace.messages.at(-1).content,
    /request completed successfully|all requested work is complete/i,
  );
  console.log('Coding implementation-required handoff runtime test passed.');

  await act(async () => {
    current.workspace.onClearMessages();
  });
  await waitForReact(() => current.workspace.proposal === null, 'The handoff validation test setup did not reset.');
  window.electronAPI.executeDeveloperWorkflow = async () => ({
    outcome: 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED',
    message: 'The approved proposal was applied and verification passed, but trusted item-specific evidence did not establish request completion.',
    taskId: 'task-incomplete-coverage',
    taskPlan: {
      schemaVersion: 2,
      status: 'BLOCKED',
      workItems: handoffWorkItems.map((item) => ({ ...item, status: 'BLOCKED' })),
    },
    filesModified: ['src/request-processor.ts'],
    codeApplied: true,
    codeVerified: true,
  });
  await act(async () => {
    current.workspace.onInputChange('Fix the request processor retry behavior.');
  });
  await act(async () => {
    current.workspace.onSendMessage();
  });
  await waitForReact(
    () => current.workspace.messages.at(-1)?.content.includes('The task remains incomplete'),
    'The renderer must not present passing generic verification as completed request work.',
  );
  assert.match(current.workspace.messages.at(-1).content, /trusted item-specific evidence did not establish request completion/i);
  assert.equal(current.workspace.appliedPatchLog.at(-1)?.state, 'blocked');
  assert.equal(providerRequests.length, 5, 'Reporting unresolved item coverage must not start a second provider request.');
  console.log('Coding honest item-coverage outcome rendering regression passed.');

  await act(async () => {
    current.workspace.onClearMessages();
  });
  await waitForReact(() => current.workspace.proposal === null, 'The invalid-plan test setup did not reset.');
  window.electronAPI.executeDeveloperWorkflow = async () => ({
    outcome: 'IMPLEMENTATION_REQUIRED',
    taskPlan: { schemaVersion: 2, status: 'HANDED_OFF', workItems: [] },
  });
  await act(async () => {
    current.workspace.onInputChange('Implement a change without a usable work plan.');
  });
  await act(async () => {
    current.workspace.onSendMessage();
  });
  await waitForReact(
    () => current.workspace.messages.at(-1)?.content.includes('did not return a valid version-2 handoff plan'),
    'A malformed handoff plan must be surfaced instead of silently continuing without plan scope.',
  );
  assert.equal(providerRequests.length, 5, 'A malformed handoff plan must not start proposal generation.');
  assert.equal(applyCalls, 3, 'A malformed handoff plan must not apply changes.');
  console.log('Coding invalid handoff plan fail-closed regression passed.');
  window.electronAPI.executeDeveloperWorkflow = async (payload) => {
    workflowRequest = payload;
    return {
      outcome: 'IMPLEMENTATION_REQUIRED',
      taskState: { status: 'INCOMPLETE', objective: { request: payload.userRequest } },
      taskPlan: {
        schemaVersion: 2,
        status: 'HANDED_OFF',
        workItems: handoffWorkItems.map((item) => ({ ...item })),
      },
      nextAction: { tool: 'standard_coding_proposal' },
    };
  };

  await act(async () => {
    current.workspace.onClearMessages();
  });
  await waitForReact(() => current.workspace.proposal === null, 'The incomplete-task test setup did not reset.');
  const incompleteRequest = 'Explain the project entry point and identify any missing evidence.';
  nextDoneMessage = {
    content: 'The available evidence does not establish the complete request outcome.',
    proposalRequired: false,
    status: 'INVESTIGATION_INCOMPLETE',
    agentTaskState: {
      status: 'INVESTIGATION_INCOMPLETE',
      originalRequest: incompleteRequest,
      evidence: [{ id: 'evidence-one', status: 'CONFIRMED' }],
      nextAction: {
        tool: 'read_file',
        reason: 'Inspect the remaining relevant source before concluding.',
        expectedEvidence: ['Relevant source content'],
      },
    },
    filesRead: [],
    toolCalls: [],
  };
  await act(async () => {
    current.workspace.onInputChange(incompleteRequest);
  });
  await act(async () => {
    current.workspace.onSendMessage();
  });
  await waitForReact(
    () => providerRequests.length === 6
      && conversationUpdates.some((update) => update.state === 'blocked')
      && current.workspace.messages.some((message) => (
        message.requestId === providerRequests[5].requestId
        && !message.streaming
        && message.content.includes('Inspect the remaining relevant source before concluding.')
      )),
    'An incomplete backend task was not preserved as blocked with its next action in the renderer.',
  );
  const incompleteTurn = conversationUpdates.at(-1);
  assert.equal(incompleteTurn?.state, 'blocked');
  assert.equal(incompleteTurn?.phase, 'INVESTIGATION_INCOMPLETE');
  assert.ok(providerRequests[5].messages.some((message) => (
    message.role === 'user' && message.content === incompleteRequest
  )));
  assert.equal(current.workspace.messages.at(-1)?.content.includes('Task remains incomplete'), true);
  console.log('Coding incomplete-task transport and lifecycle regression passed.');

  for (const [index, [scenario, fallback]] of [
    ['no-changes', 'NO_CHANGES'],
    ['invalid-format', 'I recommend updating the implementation, but this is not a unified diff.'],
  ].entries()) {
    await act(async () => {
      current.workspace.onClearMessages();
    });
    await waitForReact(() => current.workspace.proposal === null, `The ${scenario} test setup did not reset.`);
    const updateCount = conversationUpdates.length;
    nextDoneMessage = {
      content: fallback,
      proposalRequired: true,
      status: 'PROPOSAL_READY',
      filesRead: [],
      toolCalls: [],
    };
    await act(async () => {
      current.workspace.onInputChange(`Prepare a change for ${scenario} request.`);
    });
    await act(async () => {
      current.workspace.onSendMessage();
    });
    await waitForReact(
      () => conversationUpdates.slice(updateCount).some((update) => update.state === 'blocked')
        && current.workspace.messages.at(-1)?.streaming === false,
      `A ${scenario} proposal fallback was incorrectly treated as completed.`,
    );
    assert.equal(conversationUpdates.slice(updateCount).at(-1)?.state, 'blocked');
    assert.equal(current.workspace.proposal, null, 'Invalid or absent diffs must not create a proposal.');
    assert.equal(
      current.workspace.messages.at(-1)?.content.includes(
        scenario === 'no-changes' ? 'could not identify a safe change to propose' : 'No validated diff was generated',
      ),
      true,
      'The user should be told that no proposal was created or applied.',
    );
    assert.equal(proposalRegistrations.length, 5);
  }
  console.log('Coding proposal fallback incomplete-state regressions passed.');
} finally {
  if (root) await act(async () => root.unmount());
  await vite.close();
  dom.window.close();
  if (previous.window === undefined) delete globalThis.window;
  else globalThis.window = previous.window;
  if (previous.document === undefined) delete globalThis.document;
  else globalThis.document = previous.document;
  if (previous.localStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previous.localStorage;
  if (previous.webSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = previous.webSocket;
  if (previous.actEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
}
