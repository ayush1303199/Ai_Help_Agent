import assert from 'node:assert/strict';
import agent from '../electron/generalAgent.cjs';

agent.resetForTest();

const owner = 7201;
const research = agent.createTask(owner, {
  goal: 'Open the public course page and inspect the available options.',
  constraints: ['Do not purchase anything.'],
});
const started = agent.startTask(research.taskId, owner);
assert.equal(started.phase, 'PLANNING');

const browser = agent.createExecutionBrowserSession(research.taskId, owner);
assert.ok(browser.browserSessionId);
const navigation = agent.performBrowserOperation(research.taskId, owner, 'navigate', {
  url: 'https://mock.test/courses',
  title: 'Course options',
  visibleText: 'Course A and Course B are available.',
  interactiveElements: [{ id: 'continue', role: 'button', label: 'Continue', type: 'button' }],
});
assert.equal(navigation.observation.pageState.name, 'LOADED');
assert.equal(navigation.task.browserSessionId, browser.browserSessionId);

const action = agent.planExecutionAction(research.taskId, owner, {
  capability: 'BROWSER',
  provider: 'mock-browser',
  operation: 'click',
  target: 'continue',
  browserSessionId: browser.browserSessionId,
  observationVersion: navigation.observation.version,
});
assert.equal(action.action.state, 'PLANNED');
const validated = agent.validateExecutionAction(research.taskId, owner, action.action.actionId);
assert.equal(validated.action.state, 'EXECUTING');
assert.equal(agent.executeExecutionAction(research.taskId, owner, action.action.actionId).action.state, 'OBSERVING');
assert.equal(agent.observeExecutionAction(research.taskId, owner, action.action.actionId).action.state, 'VERIFYING');
const verified = agent.verifyExecutionAction(research.taskId, owner, action.action.actionId, {
  verified: true,
  evidence: 'The course page reports the selected state.',
});
assert.equal(verified.action.state, 'SUCCEEDED');
assert.equal(verified.task.executionActionId, action.action.actionId);

const commerce = agent.createTask(owner, {
  goal: 'Order the selected camera for delivery to home.',
  constraints: ['Stop if the final amount changes.'],
});
agent.startTask(commerce.taskId, owner);
const prepared = agent.planExecutionAction(commerce.taskId, owner, {
  capability: 'SHOPPING',
  provider: 'mock-shopping',
  operation: 'execute',
  target: 'camera',
  riskLevel: 'FINANCIAL',
  requiresConfirmation: true,
  arguments: { expectedPrice: 100, currentPrice: 100 },
  expectedOutcome: { price: 100 },
});
assert.equal(agent.validateExecutionAction(commerce.taskId, owner, prepared.action.actionId).action.state, 'WAITING_FOR_CONFIRMATION');
const confirmation = agent.requestExecutionConfirmation(commerce.taskId, owner, prepared.action.actionId);
assert.throws(() => agent.confirmExecutionAction(commerce.taskId, owner, prepared.action.actionId, 'wrong'), /does not match/i);
agent.confirmExecutionAction(commerce.taskId, owner, prepared.action.actionId, confirmation.confirmation.confirmationId);
agent.executeExecutionAction(commerce.taskId, owner, prepared.action.actionId);
agent.observeExecutionAction(commerce.taskId, owner, prepared.action.actionId);
const commerceResult = agent.verifyExecutionAction(commerce.taskId, owner, prepared.action.actionId, {
  verified: true,
  evidence: 'Mock order reference is visible.',
});
assert.equal(commerceResult.action.state, 'SUCCEEDED');

agent.releaseSession(owner);
assert.equal(agent.getPublicSession(owner).tasks.length, 0);

console.log(JSON.stringify({
  runtime: 'general-agent-execution-integration',
  browserBridge: true,
  structuredActionLifecycle: true,
  confirmationBridge: true,
  ownershipCleanup: true,
}));

agent.resetForTest();
