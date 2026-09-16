import assert from 'node:assert/strict';
import agent from '../electron/generalAgent.cjs';
import planner from '../electron/generalAgentPlanner.cjs';

agent.resetForTest();

const catalog = agent.getCapabilityCatalog();
assert.ok(catalog.length >= 40);
for (const definition of catalog) {
  for (const key of ['name', 'description', 'allowedActions', 'riskLevel', 'requiredPermissions', 'requiredConfirmation', 'supportedProviders', 'verificationStrategy', 'recoveryStrategy']) {
    assert.ok(Object.prototype.hasOwnProperty.call(definition, key), `${definition.name} missing ${key}`);
  }
}

const researchPlan = planner.buildPlan({
  goal: 'Find the best JavaScript courses under ₹70,000 and compare them.',
  requirements: ['Show title, price, and evidence.'],
  constraints: ['Do not purchase anything.'],
});
assert.ok(researchPlan.categories.includes('PRODUCT_COMPARISON'));
assert.ok(researchPlan.categories.includes('WEB_RESEARCH'));
assert.equal(researchPlan.status, 'READY');
assert.equal(researchPlan.riskLevel, 'READ_ONLY');
assert.equal(researchPlan.preferences.budget, 70000);
assert.equal(researchPlan.preferences.ranking, 'BEST_VALUE');
assert.equal(researchPlan.taskGraph.nodes.at(-1).action, 'verify');
assert.ok(researchPlan.capabilityRoutes.some((route) => route.capability === 'PRODUCT_COMPARISON'));

const travelPlan = planner.buildPlan({ goal: 'Book my bus to Jaipur tomorrow evening.' });
assert.ok(travelPlan.categories.includes('BUS'));
assert.ok(travelPlan.categories.includes('TRAVEL_BOOKING'));
assert.equal(travelPlan.riskLevel, 'FINANCIAL');
assert.ok(travelPlan.missingInformation.some((item) => item.id === 'origin'));
assert.ok(!travelPlan.missingInformation.some((item) => item.id === 'destination'));
assert.ok(travelPlan.taskGraph.nodes.some((node) => node.id === 'request-confirmation' && node.status === 'BLOCKED'));
assert.equal(planner.classifyRisk('Read my latest emails and summarize them.', ['EMAIL']), 'USER_DATA');
assert.equal(planner.classifyRisk('Send the approved email to the recruiter.', ['EMAIL']), 'EXTERNAL_COMMUNICATION');
assert.equal(planner.classifyRisk('Check whether my booking was confirmed.', ['TRAVEL_BOOKING']), 'USER_DATA');
assert.equal(planner.classifyRisk('Track my order status.', ['ORDERS', 'TRACKING']), 'USER_DATA');
const completedTravelPlan = planner.buildPlan({
  goal: travelPlan.objective,
  requirements: ['Origin is Delhi.'],
});
assert.ok(!completedTravelPlan.missingInformation.some((item) => item.id === 'origin'));

const referenceDate = new Date('2026-11-03T12:00:00Z');
for (const [text, expectedDate] of [
  ['Delhi to Patna on 5 November 2026', '2026-11-05'],
  ['Delhi to Patna on November 5, 2026', '2026-11-05'],
  ['Delhi to Patna on 05/11/2026', '2026-11-05'],
  ['Delhi to Patna on 2026-11-05', '2026-11-05'],
]) {
  const plan = planner.buildPlan({ goal: text, referenceDate });
  assert.equal(plan.structuredRequirements.travelDate, expectedDate, `Expected explicit date to be parsed for ${text}`);
  assert.ok(!plan.missingInformation.some((item) => item.id === 'travel-date'), `Explicit date should satisfy travel-date for ${text}`);
  assert.equal(plan.structuredRequirements.origin, 'Delhi');
  assert.equal(plan.structuredRequirements.destination, 'Patna');
}

const tomorrowPlan = planner.buildPlan({ goal: 'Delhi to Patna tomorrow', referenceDate });
assert.equal(tomorrowPlan.structuredRequirements.travelDate, '2026-11-04');
assert.ok(!tomorrowPlan.missingInformation.some((item) => item.id === 'travel-date'));

const nextFridayPlan = planner.buildPlan({ goal: 'Delhi to Patna next Friday', referenceDate });
assert.equal(nextFridayPlan.structuredRequirements.travelDate, '2026-11-06');
assert.ok(!nextFridayPlan.missingInformation.some((item) => item.id === 'travel-date'));

const safeResearchPlan = planner.buildPlan({
  goal: 'Find the best 3 buses from Delhi to Patna on 5 November 2026. Prioritize the cheapest reasonable option. Do NOT book, pay, or submit anything.',
});
assert.equal(safeResearchPlan.structuredRequirements.actionIntent, 'RESEARCH');
assert.deepEqual(safeResearchPlan.structuredRequirements.forbiddenActions, ['BOOK', 'PAY', 'SUBMIT']);
assert.deepEqual(safeResearchPlan.structuredRequirements.allowedActions, ['SEARCH', 'COMPARE', 'SHOW']);
assert.equal(safeResearchPlan.structuredRequirements.executionPolicy, 'PREPARE_ONLY');
assert.equal(safeResearchPlan.structuredRequirements.bookingAllowed, false);
assert.equal(safeResearchPlan.structuredRequirements.paymentAllowed, false);
assert.equal(safeResearchPlan.structuredRequirements.preferences.ranking, 'BEST_VALUE');
assert.equal(planner.extractActionIntent('Open the page and prepare a draft, but do not send it.').actionIntent, 'PREPARE');
assert.equal(planner.extractActionIntent('Send the message now.').actionIntent, 'EXECUTE');
assert.deepEqual(planner.extractReferences('Show me the second one.'), [{ phrase: 'the second one', status: 'ORDINAL' }]);
assert.deepEqual(planner.resolveReference('Show me the second one.', ['A', 'B', 'C']), {
  status: 'RESOLVED',
  phrase: 'the second one',
  index: 1,
});
assert.equal(planner.resolveReference('Show me the second one.', []).status, 'PENDING_CONTEXT');
assert.equal(planner.resolveReference('Use that one.', ['A', 'B']).status, 'AMBIGUOUS');

const registry = agent;
registry.registerGeneralProvider({
  providerId: 'backup-browser',
  displayName: 'Backup browser adapter',
  description: 'Deterministic test provider.',
  capabilities: ['WEB_RESEARCH'],
  lifecycle: 'AVAILABLE',
  implemented: true,
  supportsFallback: true,
});
const capabilityRegistry = (await import('node:module')).createRequire(import.meta.url)('../electron/generalAgentCapabilities.cjs').getCapabilityRegistry();
capabilityRegistry.registerCapability({
  ...capabilityRegistry.getCapability('WEB_RESEARCH'),
  supportedProviders: ['isolated-browser', 'backup-browser'],
});
capabilityRegistry.setProviderLifecycle('isolated-browser', 'TEMPORARILY_UNAVAILABLE');
const fallbackPlan = planner.buildPlan({ goal: 'Research the application deadline on the university website.' });
const researchRoute = fallbackPlan.capabilityRoutes.find((route) => route.capability === 'WEB_RESEARCH');
assert.equal(researchRoute.providerCandidates[0].providerId, 'backup-browser');
assert.equal(researchRoute.providerCandidates[0].ready, true);
assert.ok(researchRoute.providerCandidates.some((provider) => provider.lifecycle === 'TEMPORARILY_UNAVAILABLE'));

agent.resetForTest();
const owner = 5101;
const task = agent.createTask(owner, {
  goal: 'Inspect my current project and summarize the relevant files. token: do-not-share',
});
const started = agent.startTask(task.taskId, owner);
assert.ok(started.categories.includes('DEVELOPMENT_APPS'));
assert.ok(started.plan);
assert.equal(started.plan.taskGraph.nodes[0].action, 'understand');
assert.doesNotMatch(started.goal, /do-not-share/i);
const handoff = agent.prepareDeveloperHandoff(task.taskId, owner);
assert.equal(handoff.handoff.targetMode, 'developer');
assert.doesNotMatch(JSON.stringify(handoff), /do-not-share/i);
assert.match(handoff.handoff.contextBoundary, /credentials/i);
assert.throws(() => agent.getTask(task.taskId, 5102), /not owned/i);

console.log(JSON.stringify({
  runtime: 'general-capability-architecture',
  capabilities: catalog.length,
  providerFallback: true,
  taskGraph: true,
  missingInformation: true,
  handoffIsolation: true,
}));

agent.resetForTest();
