import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { taskOrchestrator, ORCHESTRATOR_STATES, FAILURE_CLASSIFICATIONS_2 } from '../electron/coding-pipeline/orchestrator.cjs';
import { artifactEngine, ARTIFACT_TYPES } from '../electron/coding-pipeline/artifacts.cjs';
import { devServerManager, detectEnvironmentRuntimes } from '../electron/coding-pipeline/environment.cjs';
import { browserVerifier } from '../electron/coding-pipeline/browserVerifier.cjs';
import { multiRepoCoordinator } from '../electron/coding-pipeline/multiRepo.cjs';
import { verificationOrchestrator } from '../electron/coding-pipeline/verificationOrchestrator.cjs';
import { CAPABILITY_REGISTRY, scoreToolSelection } from '../electron/coding-pipeline/capabilityRegistry.cjs';
import agent from '../electron/developerAgent.cjs';
import { runUniversalCodingBenchmark200 } from '../electron/developerBenchmark.cjs';

console.log('=== RUNNING STAGE 14 PRODUCTION AUTONOMOUS ENGINEERING RUNTIME VERIFICATION ===\n');

// 1. TaskOrchestrator Lifecycle & State Machine
console.log('--- 1. Testing TaskOrchestrator Lifecycle, States & Illegal Transitions ---');
const task1 = taskOrchestrator.createTask({
  goal: 'Fix authentication session expiration bug',
  intent: 'BUG_INVESTIGATION',
  workspace: '/mock/workspace',
});
assert.equal(task1.state, 'queued');
assert.equal(task1.goal, 'Fix authentication session expiration bug');

// Valid transitions
taskOrchestrator.transitionState(task1.taskId, 'planning');
assert.equal(task1.state, 'planning');
taskOrchestrator.transitionState(task1.taskId, 'discovering');
assert.equal(task1.state, 'discovering');
taskOrchestrator.transitionState(task1.taskId, 'investigating');
assert.equal(task1.state, 'investigating');

// Illegal transition rejection
assert.throws(
  () => taskOrchestrator.transitionState(task1.taskId, 'completed'),
  /Illegal state transition/,
  'Illegal jump from investigating to completed must be rejected'
);
console.log('[PASS] State transitions and illegal transition guards verified.');

// 2. Task Decomposition & Parallel Bounded Subtasks with Deduplication
console.log('\n--- 2. Testing Task Decomposition & Parallel Bounded Subtasks ---');
const subtasks = taskOrchestrator.decomposeGoal(task1.taskId);
assert.ok(subtasks.length >= 4, 'Task must decompose into at least 4 independent subtasks');
const envSub = subtasks.find((s) => s.role === 'Environment Investigator');
assert.ok(envSub, 'Environment Investigator subtask created');

// Execute subtask with executor
const subResult1 = await taskOrchestrator.executeSubtask(task1.taskId, envSub.id, async (sub) => {
  return {
    findings: ['Project is Node/TypeScript with Express API', 'Database is PostgreSQL'],
    evidence: [{ tool: 'list_directory', target: 'src/' }],
    confidence: 'HIGH',
  };
});
assert.equal(subResult1.status, 'COMPLETED');
assert.ok(task1.findings.includes('Project is Node/TypeScript with Express API'));

// Deduplication: re-executing identical subtask role/goal returns existing result
const subResult2 = await taskOrchestrator.executeSubtask(task1.taskId, envSub.id, async () => {
  throw new Error('Should not run because it is deduplicated');
});
assert.equal(subResult2.status, 'COMPLETED');
console.log('[PASS] Task decomposition, bounded execution, and subtask deduplication verified.');

// 3. Contradiction Detection & Next-Best-Action Engine 2.0
console.log('\n--- 3. Testing Contradiction Detection & Next-Best-Action Engine 2.0 ---');
task1.findings.push('Database index exists on session_token');
task1.findings.push('Database index missing on session_token');
const contradictions = taskOrchestrator.detectAndResolveContradictions(task1.taskId);
assert.ok(contradictions.length > 0, 'Contradictory findings must be flagged');

task1.targets = ['src/auth/session.ts'];
const nextAction = taskOrchestrator.computeNextBestAction(task1.taskId);
assert.ok(nextAction, 'Next best action must be computed');
assert.equal(nextAction.action, 'read_target_file');
assert.equal(nextAction.target, 'src/auth/session.ts');
console.log('[PASS] Contradiction detection and information-gain next action verified.');

// 4. Failure Classification 2.0 & Recovery Memory
console.log('\n--- 4. Testing Failure Classification 2.0 & Recovery Memory ---');
const failDiag1 = taskOrchestrator.classifyFailure({
  stderr: 'TypeError: Cannot read properties of undefined (reading "sessionKey")',
});
assert.equal(failDiag1.type, FAILURE_CLASSIFICATIONS_2.IMPLEMENTATION_DEFECT);

const failDiag2 = taskOrchestrator.classifyFailure({
  stdout: 'FAIL test/auth.test.ts: AssertionError: expected 401 to equal 200',
});
assert.equal(failDiag2.type, FAILURE_CLASSIFICATIONS_2.TEST_DEFECT);

taskOrchestrator.recordFailedStrategy(task1.taskId, {
  strategy: 'Strategy A: direct null check',
  result: 'FAILED',
  reason: 'Session manager throws higher up in stack',
});
assert.equal(task1.recoveryMemory.length, 1);
assert.equal(task1.recoveryMemory[0].strategy, 'Strategy A: direct null check');
console.log('[PASS] Failure Classification 2.0 and recovery memory verified.');

// 5. Checkpointing & Resumption
console.log('\n--- 5. Testing Checkpointing & Resumption ---');
const chk = taskOrchestrator.saveCheckpoint(task1.taskId, 'investigation_completed');
assert.ok(chk.checkpointId);
assert.equal(chk.milestone, 'investigation_completed');

// Mutate task and then restore
task1.targets = ['wrong/target.ts'];
const restored = taskOrchestrator.resumeFromCheckpoint(task1.taskId, chk.checkpointId);
assert.deepEqual(task1.targets, ['src/auth/session.ts']);
assert.equal(restored.checkpointId, chk.checkpointId);
console.log('[PASS] Checkpointing and state restoration verified.');

// 6. User Steering & Forking
console.log('\n--- 6. Testing User Steering & Forking ---');
const steerRes = taskOrchestrator.steerTask(task1.taskId, {
  action: 'change_direction',
  direction: 'Focus on Redis cache eviction instead of database',
  newGoal: 'Fix Redis cache eviction on logout',
});
assert.equal(steerRes.ok, true);
assert.equal(task1.goal, 'Fix Redis cache eviction on logout');

const forked = taskOrchestrator.forkTask(task1.taskId, 'RedisTTLStrategy');
assert.ok(forked.taskId.includes('fork_redisttlstrategy'));
assert.equal(forked.parentTaskId, task1.taskId);
console.log('[PASS] Steering and task forking verified.');

// 7. Artifact Engine & Provenance
console.log('\n--- 7. Testing Artifact Engine & Provenance ---');
const art1 = artifactEngine.createArtifact({
  taskId: task1.taskId,
  type: ARTIFACT_TYPES.IMPLEMENTATION_PLAN,
  content: '# Implementation Plan\n1. Evict key on logout\n2. Refresh TTL',
  phase: 'planning',
});
assert.ok(art1.artifactId);
assert.ok(art1.hash);
assert.equal(art1.type, ARTIFACT_TYPES.IMPLEMENTATION_PLAN);
const taskArts = artifactEngine.getArtifacts(task1.taskId);
assert.equal(taskArts.length, 1);
console.log('[PASS] Structured artifact creation with provenance hash verified.');

// 8. Adaptive Verification Orchestrator & Security Gates
console.log('\n--- 8. Testing Adaptive Verification & Security Gates ---');
const lowRiskPlan = verificationOrchestrator.computeAdaptivePlan({ risk: 'LOW', hasTests: true });
assert.equal(lowRiskPlan.level, 'FOCUSED');
assert.deepEqual(lowRiskPlan.scripts, ['test']);

const highRiskPlan = verificationOrchestrator.computeAdaptivePlan({
  risk: 'HIGH',
  hasTests: true,
  hasTypecheck: true,
  hasLint: true,
  hasBuild: true,
  isUiTask: true,
});
assert.equal(highRiskPlan.level, 'COMPREHENSIVE');
assert.ok(highRiskPlan.scripts.includes('browser_verify'));

const secClean = verificationOrchestrator.inspectSecurityGates('function safe() { return 42; }');
assert.equal(secClean.passed, true);

const secLeak = verificationOrchestrator.inspectSecurityGates('const API_KEY = "sk-1234567890abcdef1234";');
assert.equal(secLeak.passed, false);
console.log('[PASS] Adaptive verification and security gates verified.');

// 9. DevServerManager (No Fixed Ports) & BrowserVerifier
console.log('\n--- 9. Testing DevServerManager & BrowserVerifier ---');
const tempAppDir = path.join(os.tmpdir(), `stage14-test-${crypto.randomUUID()}`);
await fs.mkdir(tempAppDir, { recursive: true });
try {
  await fs.writeFile(
    path.join(tempAppDir, 'package.json'),
    JSON.stringify({
      name: 'dynamic-test-app',
      scripts: { dev: 'node server.js --port 7421' },
      dependencies: { vite: '^5.0.0' },
    }),
    'utf8'
  );

  const serverConfig = await devServerManager.discoverDevServerConfig(tempAppDir);
  assert.equal(serverConfig.detected, true);
  assert.equal(serverConfig.port, 7421, 'Must extract dynamic port without fixed port assumption');
  assert.equal(serverConfig.framework, 'vite');

  const browserRes = await browserVerifier.verifyEndpoint({ port: 7421, timeoutMs: 500 });
  assert.equal(browserRes.ok, false);
  assert.ok(['CONNECTION_REFUSED', 'TIMEOUT'].includes(browserRes.classification));
  console.log('[PASS] Dynamic dev server discovery and browser verifier verified.');
} finally {
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {});
}

// 10. MultiRepo Coordinator & Baseline Snapshot
console.log('\n--- 10. Testing MultiRepo Coordinator & Baseline Snapshot ---');
const multiRepoDir = path.join(os.tmpdir(), `multi-repo-${crypto.randomUUID()}`);
await fs.mkdir(path.join(multiRepoDir, 'client'), { recursive: true });
await fs.mkdir(path.join(multiRepoDir, 'server'), { recursive: true });
try {
  await fs.writeFile(path.join(multiRepoDir, 'client', 'package.json'), JSON.stringify({ name: 'client', dependencies: { server: 'workspace:*' } }));
  await fs.writeFile(path.join(multiRepoDir, 'server', 'package.json'), JSON.stringify({ name: 'server' }));

  const repos = await multiRepoCoordinator.discoverRepositoriesInWorkspace(multiRepoDir);
  assert.ok(repos.length >= 2);
  const graph = await multiRepoCoordinator.buildCrossRepoDependencyGraph(repos);
  assert.ok(graph.dependencies.client.includes('server'), 'Client dependency on server detected');
  console.log('[PASS] Multi-repository dependency discovery and graph resolution verified.');
} finally {
  await fs.rm(multiRepoDir, { recursive: true, force: true }).catch(() => {});
}

// 11. Run 200-Task Universal Coding Benchmark
console.log('\n--- 11. Executing 200-Task Universal Coding Benchmark ---');
const benchmark200 = runUniversalCodingBenchmark200();
assert.equal(benchmark200.totalTasks, 200);
assert.equal(benchmark200.passedTasks, 200);
assert.ok(benchmark200.overallEngineeringScore >= 95.0, `Score must be >= 95.0, got ${benchmark200.overallEngineeringScore}`);
assert.equal(benchmark200.metrics.wrongProject.value, 0.0);
assert.equal(benchmark200.metrics.wrongFile.value, 0.0);
assert.equal(benchmark200.metrics.unnecessaryQuestions.value, 0.0);
assert.equal(benchmark200.metrics.recoverySuccess.value, 1.0);
assert.equal(benchmark200.metrics.resumeSuccess.value, 1.0);
console.log(`[PASS] 200-task benchmark passed with composite engineering score: ${benchmark200.overallEngineeringScore}%`);

console.log('\n=== ALL STAGE 14 PRODUCTION RUNTIME VERIFICATIONS PASSED SUCCESSFULLY ===');
