import assert from 'node:assert/strict';
import execution from '../electron/generalAgentExecution.cjs';

const {
  ACTION_STATES,
  ExecutionError,
  MOCK_PROVIDER_ADAPTERS,
  MockBrowserAdapter,
  createAction,
  createExecutionEngine,
  createExecutableTaskGraph,
  transitionAction,
} = execution;

assert.deepEqual(Object.keys(MOCK_PROVIDER_ADAPTERS).sort(), [
  'bus',
  'email',
  'flight',
  'food',
  'grocery',
  'hotel',
  'shopping',
  'social',
]);
for (const adapter of Object.values(MOCK_PROVIDER_ADAPTERS)) {
  assert.equal(adapter.displayName.includes('Mock'), true);
  assert.ok(adapter.operations.includes('prepare'));
  assert.ok(adapter.operations.includes('execute'));
  assert.ok(adapter.operations.includes('verify'));
}

assert.deepEqual(ACTION_STATES, [
  'PLANNED',
  'VALIDATING',
  'WAITING_FOR_CONFIRMATION',
  'EXECUTING',
  'OBSERVING',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
]);
const invalid = createAction({
  actionId: 'invalid-transition',
  taskId: 'task-lifecycle',
  generalSessionId: 'general-lifecycle',
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'prepare',
});
assert.throws(() => transitionAction(invalid, 'SUCCEEDED'), /Invalid action transition/);

const engine = createExecutionEngine({ limits: { maxActions: 30 } });
const ownerA = 'owner-a';
const ownerB = 'owner-b';
const browserA = engine.createBrowserSession('general-a', 'task-a', ownerA);
const browserB = engine.createBrowserSession('general-b', 'task-b', ownerB);
assert.notEqual(browserA.sessionId, browserB.sessionId);
assert.throws(() => engine.getBrowserSession(browserA.sessionId, ownerB), /not owned/i);
assert.throws(() => engine.getBrowserSession(browserA.sessionId, ownerA, { taskId: 'task-b' }), /different task/i);

const page = engine.browserOperation(browserA.sessionId, ownerA, 'navigate', {
  url: 'https://mock.test/products',
  title: 'Products',
  visibleText: 'A structured product page',
  interactiveElements: [{ id: 'details', role: 'button', label: 'Details', type: 'button' }],
});
assert.equal(page.url, 'https://mock.test/products');
assert.equal(engine.browserOperation(browserA.sessionId, ownerA, 'click', 'details').pageState.name, 'INTERACTION_COMPLETE');
assert.equal(engine.browserOperation(browserA.sessionId, ownerA, 'type', { target: 'query', text: 'laptop' }).pageState.name, 'INPUT_UPDATED');
assert.equal(engine.browserOperation(browserA.sessionId, ownerA, 'scroll', { delta: 300 }).pageState.name, 'SCROLLED');
assert.equal(engine.browserOperation(browserA.sessionId, ownerA, 'wait', { milliseconds: 10 }).pageState.name, 'WAITED_10MS');
const screenshot = engine.browserOperation(browserA.sessionId, ownerA, 'screenshot');
assert.match(screenshot.screenshotReference, /^mock-screenshot:\/\//);
assert.throws(() => engine.browserOperation(browserA.sessionId, ownerA, 'type', {
  target: 'password',
  fieldType: 'password',
  text: 'do-not-leak',
}), /credentials/i);
const freshVersion = engine.getBrowserSession(browserA.sessionId, ownerA).state.observationVersion;

const staleAction = engine.planAction({
  taskId: 'task-a',
  generalSessionId: 'general-a',
  owner: ownerA,
  browserSessionId: browserA.sessionId,
  observationVersion: freshVersion,
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'prepare',
  target: 'item-stale',
});
engine.browserOperation(browserA.sessionId, ownerA, 'observe');
assert.throws(() => engine.validateAction(staleAction.actionId, ownerA), /stale observation/i);
assert.equal(engine.getAction(staleAction.actionId, ownerA).state, 'BLOCKED');

const graph = createExecutableTaskGraph([
  { id: 'collect', operation: 'collect' },
  { id: 'prepare', operation: 'prepare', dependencies: ['collect'] },
  { id: 'verify', operation: 'verify', dependencies: ['prepare'] },
]);
assert.equal(graph.readyNodes()[0].id, 'collect');
assert.equal(graph.executeNode('collect', () => ({ items: ['one'] })).status, 'SUCCEEDED');
assert.equal(graph.executeNode('prepare', () => { throw new Error('provider failed'); }).status, 'FAILED');
assert.equal(graph.resumeFromFailedNode('prepare').getNode('prepare').status, 'PENDING');
assert.equal(graph.getNode('verify').status, 'PENDING');

const prepare = engine.planAction({
  taskId: 'task-shop',
  generalSessionId: 'general-shop',
  owner: ownerA,
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'prepare',
  target: 'headphones',
  arguments: { price: 40 },
  expectedOutcome: { prepared: true },
});
assert.equal(engine.validateAction(prepare.actionId, ownerA).state, 'EXECUTING');
assert.equal(engine.executeAction(prepare.actionId, ownerA).state, 'OBSERVING');
assert.equal(engine.observeAction(prepare.actionId, ownerA).state, 'VERIFYING');
const preparedResult = engine.verifyAction(prepare.actionId, ownerA, { verified: true, evidence: 'mock preparation evidence' });
assert.equal(preparedResult.state, 'SUCCEEDED');
assert.equal(preparedResult.verification.verified, true);

const gated = engine.planAction({
  taskId: 'task-shop',
  generalSessionId: 'general-shop',
  owner: ownerA,
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'execute',
  target: 'camera',
  riskLevel: 'FINANCIAL',
  requiresConfirmation: true,
  arguments: { expectedPrice: 100, currentPrice: 100 },
});
assert.equal(engine.validateAction(gated.actionId, ownerA).state, 'WAITING_FOR_CONFIRMATION');
assert.throws(() => engine.executeAction(gated.actionId, ownerA), /confirmation/i);
const confirmation = engine.requestConfirmation(gated.actionId, ownerA);
assert.throws(() => engine.confirmAction(gated.actionId, 'wrong-confirmation', ownerA), /does not match/i);
assert.equal(engine.confirmAction(gated.actionId, confirmation.confirmationId, ownerA).state, 'EXECUTING');
assert.equal(engine.executeAction(gated.actionId, ownerA).state, 'OBSERVING');
assert.equal(engine.observeAction(gated.actionId, ownerA).state, 'VERIFYING');
assert.equal(engine.verifyAction(gated.actionId, ownerA, { evidence: 'order reference shown' }).state, 'SUCCEEDED');

const duplicate = engine.planAction({
  taskId: 'task-shop',
  generalSessionId: 'general-shop',
  owner: ownerA,
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'execute',
  target: 'camera',
  riskLevel: 'FINANCIAL',
  requiresConfirmation: true,
  arguments: { expectedPrice: 100, currentPrice: 100 },
});
assert.throws(() => engine.validateAction(duplicate.actionId, ownerA), /already completed|duplicate/i);

const priceChanged = engine.planAction({
  taskId: 'task-price',
  generalSessionId: 'general-price',
  owner: ownerA,
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'execute',
  target: 'phone',
  arguments: { expectedPrice: 100, currentPrice: 125 },
});
engine.validateAction(priceChanged.actionId, ownerA);
const priceConfirmation = engine.requestConfirmation(priceChanged.actionId, ownerA);
engine.confirmAction(priceChanged.actionId, priceConfirmation.confirmationId, ownerA);
assert.throws(() => engine.executeAction(priceChanged.actionId, ownerA), /price changed/i);
assert.equal(engine.getAction(priceChanged.actionId, ownerA).failure.classification, 'PRICE_CHANGED');

const paymentUnknown = engine.planAction({
  taskId: 'task-payment',
  generalSessionId: 'general-payment',
  owner: ownerA,
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'execute',
  target: 'unknown-payment',
  riskLevel: 'FINANCIAL',
  requiresConfirmation: true,
  arguments: { simulatePaymentUnknown: true },
});
engine.validateAction(paymentUnknown.actionId, ownerA);
engine.confirmAction(paymentUnknown.actionId, paymentUnknown.confirmationId, ownerA);
assert.throws(() => engine.executeAction(paymentUnknown.actionId, ownerA), /unknown/i);
assert.equal(engine.getAction(paymentUnknown.actionId, ownerA).state, 'BLOCKED');
assert.throws(() => engine.recoverAction(paymentUnknown.actionId, ownerA), /may not retry/i);

const providerFailure = engine.planAction({
  taskId: 'task-fallback',
  generalSessionId: 'general-fallback',
  owner: ownerA,
  capability: 'FOOD',
  provider: 'mock-food',
  operation: 'prepare',
  target: 'meal',
  fallbackProvider: 'mock-shopping',
  fallbackMetadata: { reason: 'deterministic test fallback' },
  arguments: { simulateProviderFailure: true },
});
engine.validateAction(providerFailure.actionId, ownerA);
assert.throws(() => engine.executeAction(providerFailure.actionId, ownerA), /mock provider failure/i);
const failure = engine.getAction(providerFailure.actionId, ownerA).failure;
assert.equal(failure.classification, 'PROVIDER_ERROR');
assert.equal(failure.fallback.provider, 'mock-shopping');

for (const [target, argument, expected] of [
  ['login', { simulateLoginRequired: true }, 'LOGIN_REQUIRED'],
  ['captcha', { simulateCaptcha: true }, 'CAPTCHA_REQUIRED'],
]) {
  const action = engine.planAction({
    taskId: `task-${target}`,
    generalSessionId: `general-${target}`,
    owner: ownerA,
    capability: 'SHOPPING',
    provider: 'mock-shopping',
    operation: 'prepare',
    target,
    arguments: argument,
  });
  engine.validateAction(action.actionId, ownerA);
  assert.throws(() => engine.executeAction(action.actionId, ownerA), /captcha|required/i);
  assert.equal(engine.getAction(action.actionId, ownerA).failure.classification, expected);
}

const credentials = engine.planAction({
  taskId: 'task-redaction',
  generalSessionId: 'general-redaction',
  owner: ownerA,
  capability: 'EMAIL',
  provider: 'mock-email',
  operation: 'send',
  target: 'recipient',
  arguments: { password: 'super-secret', apiKey: 'sk-test-not-real', body: 'safe text' },
});
assert.equal(credentials.arguments.password, '[REDACTED]');
assert.equal(credentials.arguments.apiKey, '[REDACTED]');
assert.doesNotMatch(JSON.stringify(credentials), /super-secret|sk-test-not-real/);

const closed = engine.closeBrowserSession(browserA.sessionId, ownerA, { generalSessionId: 'general-a', taskId: 'task-a' });
assert.equal(closed.state.closed, true);
assert.throws(() => engine.getBrowserSession(browserA.sessionId, ownerA), /closed|stale/i);
assert.ok(new MockBrowserAdapter().operations.includes('navigate'));
assert.ok(ExecutionError);

console.log(JSON.stringify({
  runtime: 'general-agent-execution',
  lifecycle: true,
  sessionIsolation: true,
  browserOperations: true,
  taskGraphRecovery: true,
  confirmationGating: true,
  verificationEvidence: true,
  protections: ['stale-observation', 'price-change', 'duplicate-action', 'payment-unknown'],
  failureMetadata: true,
  credentialRedaction: true,
}));
