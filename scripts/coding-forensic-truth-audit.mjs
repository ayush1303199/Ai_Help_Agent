import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

import developerAgent from '../electron/developerAgent.cjs';
import { taskOrchestrator } from '../electron/coding-pipeline/orchestrator.cjs';
import { browserVerifier } from '../electron/coding-pipeline/browserVerifier.cjs';
import developerBenchmark from '../electron/developerBenchmark.cjs';

console.log('=== RUNNING CODING AGENT FORENSIC TRUTH VERIFICATION ===\n');

const forensicResults = {
  processRestart: null,
  parallelism: null,
  dirtyWorktree: null,
  approvalBypass: null,
  browserVerification: null,
  providerExecution: null,
  benchmarkIntegrity: null,
  gitDeletions: null,
  crossAgentBoundaries: null,
};

// -------------------------------------------------------------
// 1. REAL RESTART AUDIT: Process A (PID 1) -> Exit -> Process B (PID 2)
// -------------------------------------------------------------
console.log('--- 1. Auditing Real OS Process Restart (Two Distinct PIDs) ---');
const tmpTestDir = path.join(os.tmpdir(), `forensic-restart-${Date.now()}`);
await fs.mkdir(tmpTestDir, { recursive: true });
const checkpointFile = path.join(tmpTestDir, 'forensic-task-checkpoint.json');

// Script for Process A
const procAScript = `
const { taskOrchestrator } = require('${path.resolve('electron/coding-pipeline/orchestrator.cjs').replace(/\\/g, '/')}');
async function run() {
  const task = taskOrchestrator.createTask({
    taskId: 'forensic_proc_task_1',
    goal: 'Audit multi-process restart',
    owner: 'forensic-auditor',
  });
  task.findings.push('Finding recorded by Process A');
  task.hypotheses.push({ id: 'h1', text: 'Hypothesis A', status: 'ACTIVE' });
  task.subtasks.push({ id: 'st1', description: 'Subtask A', status: 'COMPLETED' });
  await taskOrchestrator.saveCheckpointToDisk('forensic_proc_task_1', '${checkpointFile.replace(/\\/g, '/')}');
  console.log(JSON.stringify({ pid: process.pid, saved: true, taskId: task.taskId }));
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
`;

// Script for Process B
const procBScript = `
const { taskOrchestrator } = require('${path.resolve('electron/coding-pipeline/orchestrator.cjs').replace(/\\/g, '/')}');
async function run() {
  const restored = await taskOrchestrator.restoreTaskFromDisk('${checkpointFile.replace(/\\/g, '/')}');
  if (!restored) {
    console.error('Failed to restore');
    process.exit(1);
  }
  restored.findings.push('Finding added by Process B');
  restored.state = 'COMPLETED';
  console.log(JSON.stringify({
    pid: process.pid,
    restored: true,
    taskId: restored.taskId,
    findingsCount: restored.findings.length,
    findings: restored.findings,
  }));
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
`;

const procAPath = path.join(tmpTestDir, 'procA.cjs');
const procBPath = path.join(tmpTestDir, 'procB.cjs');
await fs.writeFile(procAPath, procAScript, 'utf8');
await fs.writeFile(procBPath, procBScript, 'utf8');

function runChild(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', reject);
  });
}

const resA = await runChild(procAPath);
assert.equal(resA.code, 0, `Process A failed: ${resA.stderr}`);
const dataA = JSON.parse(resA.stdout);

const resB = await runChild(procBPath);
assert.equal(resB.code, 0, `Process B failed: ${resB.stderr}`);
const dataB = JSON.parse(resB.stdout);

assert.notEqual(dataA.pid, dataB.pid, 'Processes must have different PIDs');
assert.equal(dataB.restored, true);
assert.equal(dataB.findingsCount, 2);

console.log(`[PASS] Multi-process restart PROVEN: Process A (PID ${dataA.pid}) -> exit -> Process B (PID ${dataB.pid}) resumed state.`);
forensicResults.processRestart = {
  status: 'PROVEN',
  processAPid: dataA.pid,
  processBPid: dataB.pid,
  dataRestored: true,
  findingsCount: dataB.findingsCount,
};

// -------------------------------------------------------------
// 2. REAL PARALLELISM AUDIT: Async Concurrency vs OS Threads
// -------------------------------------------------------------
console.log('\n--- 2. Auditing Parallel Worker Concurrency ---');
const parTaskId = 'forensic_par_task';
taskOrchestrator.createTask({ taskId: parTaskId, goal: 'Audit concurrency' });

let workerAInterval = null;
let workerBInterval = null;

const parallelConfigs = [
  { workerId: 'w_A', role: 'Investigator A' },
  { workerId: 'w_B', role: 'Investigator B' },
];

await taskOrchestrator.executeParallelWorkers(parTaskId, parallelConfigs, async (worker) => {
  const start = Date.now();
  await new Promise(r => setTimeout(r, 60));
  const end = Date.now();
  if (worker.workerId === 'w_A') workerAInterval = { start, end };
  if (worker.workerId === 'w_B') workerBInterval = { start, end };
  return { findings: [`Findings from ${worker.workerId}`], evidence: [] };
});

const isOverlapping = workerAInterval.start < workerBInterval.end && workerBInterval.start < workerAInterval.end;
assert.ok(isOverlapping, 'Worker intervals must overlap');
console.log(`[PASS] Asynchronous execution overlap PROVEN (w_A: ${workerAInterval.start}-${workerAInterval.end}, w_B: ${workerBInterval.start}-${workerBInterval.end}).`);
console.log(`[NOTE] Concurrency is Node.js async event-loop concurrency (Promise.all), NOT multi-core OS threads.`);
forensicResults.parallelism = {
  status: 'PARTIALLY_PROVEN',
  nature: 'Node.js async event-loop concurrency (Promise.all)',
  osThreadsUsed: false,
  overlappingIntervals: true,
  workerA: workerAInterval,
  workerB: workerBInterval,
};

// -------------------------------------------------------------
// 3. DIRTY WORKTREE AUDIT: Byte-for-Byte User File Preservation
// -------------------------------------------------------------
console.log('\n--- 3. Auditing Dirty Worktree Byte-for-Byte Preservation ---');
const dirtyRepoDir = path.join(tmpTestDir, 'dirty-repo');
await fs.mkdir(dirtyRepoDir, { recursive: true });

const userFile1 = path.join(dirtyRepoDir, 'user_notes.txt');
const userFile2 = path.join(dirtyRepoDir, 'draft_work.js');
const targetFile = path.join(dirtyRepoDir, 'target.js');

await fs.writeFile(userFile1, 'IMPORTANT USER NOTES: DO NOT OVERWRITE', 'utf8');
await fs.writeFile(userFile2, 'const draft = "WIP by human user";', 'utf8');
await fs.writeFile(targetFile, 'function add(a, b) { return a - b; }\nmodule.exports = { add };', 'utf8');

const hashUser1Before = crypto.createHash('sha256').update(await fs.readFile(userFile1)).digest('hex');
const hashUser2Before = crypto.createHash('sha256').update(await fs.readFile(userFile2)).digest('hex');

// Agent captures baseline
const baselineTaskId = 'forensic_baseline_task';
const baseline = await developerAgent.captureWorktreeBaseline(baselineTaskId, dirtyRepoDir, ['user_notes.txt', 'draft_work.js', 'target.js']);

// Agent modifies target file
await fs.writeFile(targetFile, 'function add(a, b) { return a + b; }\nmodule.exports = { add };', 'utf8');

// Verification of dirty worktree
const verifyRes = await developerAgent.verifyDirtyWorktreePreserved(baselineTaskId, ['target.js']);
assert.equal(verifyRes.ok, true);

// Verify byte-for-byte hashes after agent operation
const hashUser1After = crypto.createHash('sha256').update(await fs.readFile(userFile1)).digest('hex');
const hashUser2After = crypto.createHash('sha256').update(await fs.readFile(userFile2)).digest('hex');

assert.equal(hashUser1Before, hashUser1After, 'User file 1 hash must be identical');
assert.equal(hashUser2Before, hashUser2After, 'User file 2 hash must be identical');
console.log('[PASS] Dirty worktree preservation PROVEN: User files preserved with exact SHA-256 match.');
forensicResults.dirtyWorktree = {
  status: 'PROVEN',
  hashMatch: true,
  userFilesPreserved: 2,
};

// -------------------------------------------------------------
// 4. APPROVAL BYPASS AUDIT: Unapproved & Stale Proposal Mutation Blocking
// -------------------------------------------------------------
console.log('\n--- 4. Auditing Approval Bypass and Stale Proposal Rejection ---');
developerAgent.resetForTest();

const ownerWebContentsId = 99;
const sessionId = developerAgent.getSession(ownerWebContentsId);
const owner = { ownerWebContentsId, sessionId };

const diffContent = '--- a/target.js\n+++ b/target.js\n@@ -1,2 +1,2 @@\n-function add(a, b) { return a - b; }\n+function add(a, b) { return a + b; }\n module.exports = { add };\n';

await fs.writeFile(targetFile, 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n', 'utf8');

const proposal = await developerAgent.createProposal({
  root: dirtyRepoDir,
  ownerWebContentsId,
  sessionId,
  raw: diffContent,
});

assert.equal(proposal.state, 'awaiting_approval');

// Test 1: Attempt to apply without approval
let unapprovedApplyBlocked = false;
try {
  await developerAgent.apply(proposal.taskId, owner);
} catch (err) {
  unapprovedApplyBlocked = true;
  assert.ok(err.message.includes('Proposal is not approved') || err.message.includes('approved'));
}
assert.ok(unapprovedApplyBlocked, 'Unapproved proposal apply must be blocked');

// Test 2: Stale context modification
developerAgent.approve(proposal.taskId, owner);
// Mutate disk underneath proposal
await fs.writeFile(targetFile, '// concurrent external edit\nfunction add(a, b) { return a * b; }\nmodule.exports = { add };\n', 'utf8');

let staleApplyBlocked = false;
try {
  await developerAgent.apply(proposal.taskId, owner);
} catch (err) {
  staleApplyBlocked = true;
  console.log('Observed stale apply error:', err.message);
  assert.ok(err.message.length > 0);
}
assert.ok(staleApplyBlocked, 'Stale snapshot mismatch apply must be blocked');
console.log('[PASS] Approval safety gates PROVEN: Unapproved apply and stale proposal apply were both rejected.');
forensicResults.approvalBypass = {
  status: 'PROVEN',
  unapprovedApplyBlocked: true,
  staleApplyBlocked: true,
};

// -------------------------------------------------------------
// 5. BROWSER VERIFICATION AUDIT: Live Browser vs HTTP Fallback
// -------------------------------------------------------------
console.log('\n--- 5. Auditing Browser Verification Capability ---');
const browserEval = await browserVerifier.evaluateBrowserOrFallback({
  port: 65432,
  route: '/health',
  browserAvailable: false,
});

console.log(`[RESULT] Browser mode: ${browserEval.capabilityMode}`);
console.log(`[RESULT] Visual verified: ${browserEval.visualVerified}`);
console.log(`[RESULT] Limitation reported: "${browserEval.limitationReported}"`);

assert.equal(browserEval.capabilityMode, 'HTTP_DOM_FALLBACK');
assert.equal(browserEval.visualVerified, false);
assert.ok(browserEval.limitationReported.includes('Real browser automation unavailable'));

console.log('[AUDIT VERDICT] LIVE_BROWSER is UNAVAILABLE. Claims of "real browser verification" or "visual proof" are FALSE.');
console.log('[AUDIT VERDICT] Only HTTP_DOM_FALLBACK is implemented and functional.');
forensicResults.browserVerification = {
  status: 'PARTIALLY_PROVEN',
  liveBrowser: 'UNAVAILABLE',
  fallback: 'HTTP_DOM_FALLBACK',
  visualCapture: false,
  honestLimitationReported: true,
};

// -------------------------------------------------------------
// 6. REAL LLM / PROVIDER EXECUTION AUDIT
// -------------------------------------------------------------
console.log('\n--- 6. Auditing Real LLM / Provider Execution ---');
const bench19 = developerBenchmark.runBlindRealRepositoryEngineeringBenchmark();
console.log(`[RESULT] Real Provider in Benchmark: status = "${bench19.splits.realProvider.status}", reason = "${bench19.splits.realProvider.reason}"`);

assert.equal(bench19.splits.realProvider.status, 'BLOCKED');
console.log('[AUDIT VERDICT] Live LLM execution during automated test suites is BLOCKED/OFFLINE.');
console.log('[AUDIT VERDICT] Provider error handling and retry contracts are implemented, but real model execution is UNPROVEN in offline runs.');
forensicResults.providerExecution = {
  status: 'BLOCKED',
  offlineHarness: true,
  liveCallsObservedInTest: false,
  errorHandlingImplemented: true,
};

// -------------------------------------------------------------
// 7. BENCHMARK CODE AUDIT: Synthetic In-Memory vs Real Disk Tasks
// -------------------------------------------------------------
console.log('\n--- 7. Auditing Benchmark Implementation (300 Tasks vs Real Repositories) ---');
const bench300 = developerBenchmark.runUniversalCodingBenchmark300();
console.log(`[RESULT] runUniversalCodingBenchmark300 total tasks: ${bench300.totalTasks}`);
console.log(`[RESULT] runUniversalCodingBenchmark300 passed tasks: ${bench300.passedTasks}`);
console.log(`[AUDIT] Inspecting task generation: tasks are created via in-memory array push:`);
console.log(`        tasks.push({ taskId: ..., passed: true })`);
console.log(`[AUDIT VERDICT] runUniversalCodingBenchmark300 does NOT execute 300 real disk tasks.`);
console.log(`[AUDIT VERDICT] It is an in-memory simulation / model metric generator.`);
console.log(`[AUDIT VERDICT] Real disk execution in Stage 19 test suite consists of 3 real filesystem repositories, NOT 300.`);
forensicResults.benchmarkIntegrity = {
  status: 'BENCHMARK_SIMULATION',
  totalReportedTasks: 300,
  executedOnDiskInBenchmarkFunction: 0,
  executedOnDiskInTestSuites: 3,
  nature: 'Static in-memory distribution and programmatic simulation',
};

// Clean up temp dir
try {
  await fs.rm(tmpTestDir, { recursive: true, force: true });
} catch {}

console.log('\n=== FORENSIC PROBE COMPLETED ===');
console.log(JSON.stringify(forensicResults, null, 2));
