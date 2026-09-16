import assert from 'node:assert/strict';
import { buildReadPlan, createTaskRuntimeState, detectBadToolBehavior, evaluateCompletionState } from '../server/src/llm/developerDecisionEngine.js';

const plan = buildReadPlan('Fix the login timeout bug.');
assert.equal(plan.mode, 'AGENT');
assert.equal(plan.runtimeState.phase, 'UNDERSTANDING');
assert.ok(Array.isArray(plan.taskPlan.tasks));

const runtime = createTaskRuntimeState({
  phase: 'CONTEXT_BUILDING',
  plan: plan.taskPlan,
  taskGraph: plan.taskGraph,
  taskMemory: { goal: 'Fix login timeout', constraints: ['read-only'], filesInspected: ['src/login.ts'], importantFindings: ['timeout is read from config'], plannedChanges: ['edit config'], proposalIds: [], verificationResults: [], failures: [], repairRounds: 0 },
});
runtime.recordToolDecision({ selectedTool: 'search_code', reasonCategory: 'locate_target', useful: true });
runtime.recordObservation('SEARCH_TARGET_FOUND', { path: 'src/login.ts' });
runtime.setPhase('PROPOSING', { message: 'proposal preparation' });
runtime.recordAssumption('FACT', { description: 'Target file was identified.' });
runtime.recordAssumption('UNKNOWN', { description: 'Exact root cause still unconfirmed.' });
assert.equal(runtime.taskState, 'PROPOSING');
assert.equal(runtime.metrics.toolCalls, 1);
assert.equal(runtime.observations.at(-1).kind, 'PROPOSING');
assert.equal(runtime.assumptions.length, 2);

const decisionLog = [
  { tool: 'search_code', phase: 'EXPLORING', targetScope: 'narrow', reasonCategory: 'locate_target' },
  { tool: 'search_code', phase: 'EXPLORING', targetScope: 'narrow', reasonCategory: 'locate_target' },
  { tool: 'read_file', phase: 'UNDERSTANDING', targetScope: 'narrow', reasonCategory: 'read_context' },
  { tool: 'run_command', phase: 'PROPOSING', targetScope: 'narrow', reasonCategory: 'verification' },
];
const badBehavior = detectBadToolBehavior(decisionLog);
assert.equal(badBehavior.duplicateToolCalls.length, 1);
assert.equal(badBehavior.repeatedSearches.length, 1);
assert.equal(badBehavior.invalidPhaseUsage.length, 2);
assert.equal(evaluateCompletionState({ implemented: true, verificationStatus: 'PASS', repairAttempts: 0, changedFiles: ['src/login.ts'] }).status, 'COMPLETED');

const os = await import('node:os');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const developerFiles = (await import('../electron/developerFiles.cjs')).default;
const developerContext = (await import('../electron/developerContext.cjs')).default;

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-project-isolation-'));
const projectA = path.join(tempRoot, 'project-a');
const projectB = path.join(tempRoot, 'project-b');
await fs.mkdir(projectA, { recursive: true });
await fs.mkdir(projectB, { recursive: true });
await fs.writeFile(path.join(projectA, 'alpha.txt'), 'A');
await fs.writeFile(path.join(projectB, 'beta.txt'), 'B');

await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectA] }) }, 'owner-a');
await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectB] }) }, 'owner-b');
assert.equal(developerFiles.getProjectRoot('owner-a'), projectA);
assert.equal(developerFiles.getProjectRoot('owner-b'), projectB);
assert.equal(developerFiles.getProjectRoot(), null);
assert.equal((await developerFiles.readFile('alpha.txt', 'owner-a')).content, 'A');
assert.equal((await developerFiles.readFile('beta.txt', 'owner-b')).content, 'B');
assert.throws(() => developerFiles.assertProjectOwner('owner-c'), /not owned/i);

const sharedResult = [{ path: 'src/login.ts', text: 'login timeout is read from config', matchType: 'content' }];
const contextA = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectA, maxTokens: 1200 });
const contextB = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectB, maxTokens: 1200 });
assert.notEqual(contextA.root, contextB.root);
assert.equal(contextA.items[0]?.path, sharedResult[0].path);
assert.equal(contextB.items[0]?.path, sharedResult[0].path);
assert.equal(contextA.cached, false);
assert.equal(contextB.cached, false);
developerContext.invalidateContextCache(projectA);
const contextARefreshed = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectA, maxTokens: 1200 });
assert.equal(contextARefreshed.cached, false);

const projectBContextBeforeClear = developerContext.assembleContext({ query: 'beta', results: [{ path: 'src/beta.ts', text: 'beta service timeout', matchType: 'content' }], root: projectB, maxTokens: 1200 });
developerContext.invalidateContextCache(projectB);
const projectBContextAfterClear = developerContext.assembleContext({ query: 'beta', results: [{ path: 'src/beta.ts', text: 'beta service timeout', matchType: 'content' }], root: projectB, maxTokens: 1200 });
assert.equal(projectBContextBeforeClear.cached, false);
assert.equal(projectBContextAfterClear.cached, false);

developerFiles.clearProject('owner-a');
developerFiles.clearProject('owner-b');

console.log(JSON.stringify({
  simulated: true,
  planMode: plan.mode,
  runtimePhase: runtime.phase,
  runtimeMetrics: runtime.metrics,
  historyLength: runtime.history.length,
  assumptionCount: runtime.assumptions.length,
  badToolBehavior: badBehavior,
  projectIsolation: true,
}));
