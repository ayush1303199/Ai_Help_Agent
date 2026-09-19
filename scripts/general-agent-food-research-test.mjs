import assert from 'node:assert/strict';
import planner from '../electron/generalAgentPlanner.cjs';
import agent from '../electron/generalAgent.cjs';

const goal = 'Find ₹60 biryani chawal near Motibag South Campus Delhi without delivery.';
const plan = planner.buildPlan({ goal });
const food = plan.structuredRequirements.domainRequirements.food;

assert.equal(plan.structuredRequirements.actionIntent, 'RESEARCH');
assert.equal(food.foodType, 'BIRYANI');
assert.equal(food.dish, 'BIRYANI RICE');
assert.equal(food.budget, 60);
assert.equal(food.location, 'Motibag South Campus Delhi');
assert.equal(food.deliveryExcluded, true);
assert.equal(food.purchase, false);
assert.equal(food.payment, false);
assert.deepEqual(food.searchQueries, [
  '₹60 BIRYANI RICE',
  '₹60 BIRYANI RICE Motibag South Campus Delhi',
  '₹60 BIRYANI RICE South Campus Delhi',
  'BIRYANI RICE under ₹60 Motibag South Campus Delhi',
]);

const candidates = planner.evaluateFoodCandidates([
  {
    title: 'Delhi campus biryani menu',
    url: 'https://local-restaurant.example/menu',
    snippet: 'Motibag South Campus Delhi restaurant menu: biryani ₹60, pickup available.',
    source: 'local-restaurant.example',
    sourceType: 'MENU',
    price: '₹60',
    priceEvidenceType: 'PRICE_EXPLICITLY_OBSERVED',
  },
  {
    title: '₹60 Biryani challenge in Hyderabad',
    url: 'https://youtube.com/watch?v=1',
    snippet: 'A food video from Hyderabad.',
    source: 'youtube.com',
  },
  {
    title: '₹60 biryani near Delhi',
    url: 'https://example.com/article',
    snippet: 'A generic article mentions a ₹60 biryani price.',
    source: 'example.com',
  },
], food);

assert.equal(candidates[0].classification, 'MATCH');
assert.equal(candidates[0].priceVerification, 'PRICE_EXPLICITLY_OBSERVED');
assert.equal(candidates[0].deliveryEvidence, 'SUPPORTED');
assert.equal(candidates.some((candidate) => candidate.locationRelevance === 'CONTRADICTED'), true);
assert.equal(candidates.some((candidate) => candidate.classification === 'IRRELEVANT'), true);
assert.equal(planner.foodResearchOutcome(candidates), 'MATCH');
assert.match(planner.formatFoodResearchResponse(food, candidates), /local-restaurant\.example/);

const partial = planner.evaluateFoodCandidates([{
  title: 'Delhi biryani references',
  url: 'https://example.com/delhi',
  snippet: 'Delhi biryani references at ₹60.',
  source: 'example.com',
}], food);
assert.equal(partial[0].classification, 'PARTIAL_MATCH');
assert.equal(planner.foodResearchOutcome(partial), 'PARTIAL_MATCH');

const noPickupEvidence = planner.evaluateFoodCandidates([{
  title: 'Motibag South Campus Delhi biryani menu',
  url: 'https://restaurant.example/menu',
  snippet: 'Motibag South Campus Delhi menu lists biryani at ₹60.',
  source: 'restaurant.example',
}], food);
assert.equal(noPickupEvidence[0].locationRelevance, 'MATCH');
assert.equal(noPickupEvidence[0].priceVerification, 'PRICE_EXPLICITLY_OBSERVED');
assert.equal(noPickupEvidence[0].deliveryEvidence, 'NOT_VERIFIED');
assert.equal(noPickupEvidence[0].classification, 'PARTIAL_MATCH');

const duplicate = planner.evaluateFoodCandidates([
  { title: 'Same restaurant', url: 'https://example.com/menu?utm_source=a', snippet: 'Delhi menu', source: 'example.com' },
  { title: 'Same restaurant', url: 'https://example.com/menu?utm_source=b', snippet: 'Delhi menu ₹60 pickup', source: 'local menu' },
], food);
assert.equal(duplicate.length, 1);

agent.resetForTest();
const owner = 9101;
const task = agent.createTask(owner, { goal });
agent.startTask(task.taskId, owner);
agent.observe(task.taskId, owner, {
  kind: 'PAGE',
  url: 'https://duckduckgo.com/?q=%E2%82%B960+biryani',
  text: 'Search results',
  results: [{
    title: '₹60 Biryani menu near Motibag South Campus Delhi',
    url: 'https://local-restaurant.example/menu',
    snippet: 'Motibag South Campus Delhi menu: biryani ₹60, pickup available.',
    source: 'local-restaurant.example',
    price: '₹60',
    priceEvidenceType: 'PRICE_EXPLICITLY_OBSERVED',
  }],
});
const remembered = agent.getTask(task.taskId, owner);
assert.deepEqual(remembered.taskMemory.research.searchQueries, ['₹60 biryani']);
assert.equal(remembered.taskMemory.research.outcome, 'MATCH');
assert.equal(remembered.taskMemory.resultSetSummary.matchedCount, 1);
const response = agent.recordModelResponse(task.taskId, owner, {
  status: 'COMPLETED',
  content: 'Found a broad result.',
  provider: 'test-provider',
  model: 'test-model',
});
assert.equal(response.finalStatus, 'COMPLETED');
assert.match(response.assistantResponse.content, /No order or payment was made/);

agent.resetForTest();
console.log('general-agent food research tests passed');
