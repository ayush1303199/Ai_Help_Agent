import assert from 'node:assert/strict';
import {
  clarificationDecision,
  evaluateScope,
  evaluateUnderstanding,
  updateEvidence,
} from '../server/src/llm/developerDecisionEngine.js';

function simulateAdaptiveLoop() {
  const events = ['REQUEST'];
  let evidence = {};
  const providerTurns = [
    { tool: 'search_code', args: { query: 'login timeout' } },
    { tool: 'read_file', args: { relativePath: 'src/login.ts' } },
    { final: 'A validated proposal can now be prepared.' },
  ];
  let providerTurn = 0;

  const firstTurn = providerTurns[providerTurn++];
  assert.equal(firstTurn.tool, 'search_code');
  events.push(`PROVIDER_TURN ${providerTurn}`);
  events.push(`TOOL_CALL ${firstTurn.tool}`);
  evidence = updateEvidence(evidence, 'search_code', {
    ok: true,
    data: { query: firstTurn.args.query, results: [{ path: 'src/login.ts', line: 4, text: 'timeout' }] },
  });
  events.push('TOOL_RESULT');
  evidence.testsLocated = false;
  let decision = evaluateUnderstanding({ request: 'Fix the login timeout bug.', evidence });
  events.push(`DECISION ${decision.decision}`);
  assert.equal(decision.decision, 'READ_MORE');

  events.push('CONTINUATION');
  const secondTurn = providerTurns[providerTurn++];
  assert.equal(secondTurn.tool, 'read_file');
  events.push(`PROVIDER_TURN ${providerTurn}`);
  events.push(`TOOL_CALL ${secondTurn.tool}`);
  evidence = updateEvidence(evidence, 'read_file', {
    ok: true,
    data: {
      path: secondTurn.args.relativePath,
      content: 'import config from "./config";\nexport function login() { return config.timeout; }',
    },
  });
  events.push('TOOL_RESULT');
  evidence.testsLocated = true;
  decision = evaluateUnderstanding({ request: 'Fix the login timeout bug.', evidence });
  events.push(`DECISION ${decision.writeReady ? 'READY_TO_PROPOSE' : decision.decision}`);
  const finalTurn = providerTurns[providerTurn++];
  assert.equal(finalTurn.final, 'A validated proposal can now be prepared.');
  events.push(`PROVIDER_TURN ${providerTurn}`);
  events.push('PROPOSAL');
  assert.equal(decision.writeReady, true);
  assert.deepEqual(events, [
    'REQUEST',
    'PROVIDER_TURN 1',
    'TOOL_CALL search_code',
    'TOOL_RESULT',
    'DECISION READ_MORE',
    'CONTINUATION',
    'PROVIDER_TURN 2',
    'TOOL_CALL read_file',
    'TOOL_RESULT',
    'DECISION READY_TO_PROPOSE',
    'PROVIDER_TURN 3',
    'PROPOSAL',
  ]);
  return events;
}

function simulateClarification() {
  let evidence = {};
  evidence = updateEvidence(evidence, 'search_code', {
    ok: true,
    data: { results: [{ path: 'candidate/Login.ts' }, { path: 'admin/Login.ts' }] },
  });
  evidence = updateEvidence(evidence, 'read_file', { ok: true, data: { path: 'candidate/Login.ts', content: 'export function login() {}' } });
  evidence = updateEvidence(evidence, 'read_file', { ok: true, data: { path: 'admin/Login.ts', content: 'export function login() {}' } });
  evidence.searches = 2;
  const decision = clarificationDecision(evidence);
  assert.equal(decision.decision, 'NEEDS_CLARIFICATION');
  assert.equal(decision.candidates.length, 2);
  return decision;
}

const adaptiveEvents = simulateAdaptiveLoop();
const clarification = simulateClarification();
const scope = evaluateScope({
  expectedFiles: 1,
  candidatePaths: ['src/login.ts'],
  proposalFiles: ['src/login.ts', 'src/config.ts'],
});
assert.equal(scope.state, 'SCOPE_EXPANDED');
console.log(JSON.stringify({
  simulated: true,
  adaptiveEvents,
  clarification,
  scope: { state: scope.state, scopeExpansion: scope.scopeExpansion, scopeRisk: scope.scopeRisk },
}));
