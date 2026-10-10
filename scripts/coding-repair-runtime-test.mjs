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
let applyCalls = 0;
let conversationCount = 0;
let initialProjectSync = false;
let autoModeGranted = false;

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
    setTimeout(() => this.onmessage?.({
      data: JSON.stringify({
        type: 'done',
        requestId: request.requestId,
        content: diff,
        proposalRequired: true,
        status: 'PROPOSAL_READY',
        filesRead: [{ path: 'src/index.ts', content: original }],
        toolCalls: [],
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
  advanceDeveloperConversation: async ({ turnId, state }) => ({ turnId, state, updatedAt: new Date().toISOString() }),
  readDeveloperFile: async () => ({ content: original }),
  createDeveloperProposal: async (raw, snapshots, _script, _scope, _turnId, repairToken) => {
    const index = proposalRegistrations.length;
    proposalRegistrations.push({ raw, snapshots, repairToken });
    return {
      id: `proposal-${index + 1}`,
      proposalId: `proposal-ref-${index + 1}`,
      manifestHash: `manifest-${index + 1}`,
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
