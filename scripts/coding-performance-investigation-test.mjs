import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';

console.log('[PERF-TEST] Starting Regression Test Suite for Performance Investigation & Conversation Ownership...');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-perf-test-'));
const projectPath = path.join(tempDir, 'ecommerce-store');

try {
  // Set up a mock project with a realistic query-producing file
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(path.join(projectPath, 'models'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(projectPath, 'package.json'),
    JSON.stringify({ name: 'ecommerce-store', version: '1.0.0' }, null, 2),
  );

  await fs.writeFile(
    path.join(projectPath, 'models', 'Order.php'),
    `<?php
namespace app\\models;

class Order {
    public function getSlowOrders() {
        // Unindexed filter query taking significant time under load
        return $this->db->query("SELECT * FROM orders WHERE status = 'pending'");
    }

    public function getQuickCount() {
        return $this->db->query("SELECT count(*) FROM orders");
    }
}
`,
  );

  // =========================================================================
  // STEP 1: Project Attachment Contract
  // =========================================================================
  console.log('[STEP 1] Attaching project to backend (/api/coding/project-attach)...');
  const attachRes = await fetch('http://127.0.0.1:3001/api/coding/project-attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot: projectPath }),
  });
  assert.equal(attachRes.ok, true);
  const attachData = await attachRes.json();
  assert.equal(attachData.status, 'PROJECT_ATTACHED');
  assert.equal(attachData.projectRoot.toLowerCase(), projectPath.toLowerCase());
  console.log('  -> STEP 1 PASSED: Project attached successfully.');

  // =========================================================================
  // STEP 2: Conversation Ownership Contract & Isolation
  // =========================================================================
  console.log('[STEP 2] Verifying Conversation Ownership Lifecycle & Session Invariance...');
  const ownerDesktop = 301;
  await developerFiles.attachProject(projectPath, ownerDesktop);
  const sessionId = developerAgent.getSession(ownerDesktop);

  const turn = developerAgent.beginConversationTurn({
    root: projectPath,
    scope: '.',
    request: 'which query is take time',
    sessionId,
    ownerWebContentsId: ownerDesktop,
  });
  assert.equal(turn.state, 'reading');
  assert.equal(turn.sessionId, sessionId);

  // Advance turn to understanding
  const advanced = developerAgent.advanceConversationTurn(turn.turnId, 'understanding', {
    ownerWebContentsId: ownerDesktop,
    sessionId,
  });
  assert.equal(advanced.state, 'understanding');

  // Verify non-owner cannot hijack or advance this conversation turn
  const foreignOwner = { ownerWebContentsId: 999, sessionId: 'rogue-session' };
  assert.throws(
    () => developerAgent.advanceConversationTurn(turn.turnId, 'completed', foreignOwner),
    /conversation turn is not owned by this renderer session/i,
  );

  // Complete turn legitimately
  const completed = developerAgent.advanceConversationTurn(turn.turnId, 'completed', {
    ownerWebContentsId: ownerDesktop,
    sessionId,
  });
  assert.equal(completed.state, 'completed');
  console.log('  -> STEP 2 PASSED: Conversation ownership remains strictly bounded and isolated.');

  // =========================================================================
  // STEP 3: Python Performance Investigation & Relevance Gate Suite
  // =========================================================================
  console.log('[STEP 3] Executing Python Performance Investigation Suite (Intent, Tools, Contract)...');
  const pyCheck = spawn('python', ['scripts/coding-performance-python-test.py'], {
    stdio: 'inherit',
  });
  const pyExitCode = await new Promise((resolve) => pyCheck.on('close', resolve));
  assert.equal(pyExitCode, 0, 'Python performance investigation test must exit with code 0');
  console.log('  -> STEP 3 PASSED: Python performance tests passed with 100% contract compliance.');

  // =========================================================================
  // STEP 4: Tool Execution on Real Files
  // =========================================================================
  console.log('[STEP 4] Verifying Real Tool Execution for Query Search & Reading...');
  const searchToolRes = await fetch('http://127.0.0.1:3001/api/coding/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'search_code',
      arguments: { query: 'SELECT * FROM orders' },
      scope: '.',
    }),
  });
  assert.equal(searchToolRes.ok, true);
  const searchToolData = await searchToolRes.json();
  assert.equal(searchToolData.ok, true);
  assert.ok(searchToolData.data.results.length > 0);
  assert.ok(searchToolData.data.results.some((r) => r.path.includes('Order.php')));

  // Test alias resolution for repo_browser.search_code with pattern
  const aliasToolRes = await fetch('http://127.0.0.1:3001/api/coding/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'repo_browser.search_code',
      arguments: { pattern: 'SELECT * FROM orders' },
      scope: '.',
    }),
  });
  assert.equal(aliasToolRes.ok, true);
  const aliasToolData = await aliasToolRes.json();
  assert.equal(aliasToolData.ok, true);
  assert.ok(aliasToolData.data.results.length > 0);

  const readToolRes = await fetch('http://127.0.0.1:3001/api/coding/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'read_file',
      arguments: { relativePath: 'models/Order.php' },
      scope: '.',
    }),
  });
  assert.equal(readToolRes.ok, true);
  const readToolData = await readToolRes.json();
  assert.equal(readToolData.ok, true);
  assert.ok(readToolData.data.content.includes('SELECT * FROM orders WHERE status = \'pending\''));
  console.log('  -> STEP 4 PASSED: Tool bridge returns authentic query lines from project source.');

  // =========================================================================
  // STEP 5: Multi-Turn Transition from Investigation to Fix Proposal
  // =========================================================================
  console.log('[STEP 5] Verifying Clean Multi-turn Transition to PROPOSAL_GENERATION...');
  const ownerProposal = 302;
  await developerFiles.attachProject(projectPath, ownerProposal);
  const proposalSessionId = developerAgent.getSession(ownerProposal);

  // User then says: "fix ka proposal/diff banao"
  const proposalDiff = `--- a/models/Order.php
+++ b/models/Order.php
@@ -5,4 +5,5 @@
     public function getSlowOrders() {
         // Unindexed filter query taking significant time under load
-        return $this->db->query("SELECT * FROM orders WHERE status = 'pending'");
+        // Optimized with limit and indexed query
+        return $this->db->query("SELECT * FROM orders WHERE status = 'pending' LIMIT 100");
     }
`;

  const proposal = await developerAgent.createProposal({
    root: projectPath,
    sessionId: proposalSessionId,
    ownerWebContentsId: ownerProposal,
    raw: proposalDiff,
  });
  assert.equal(proposal.state, 'awaiting_approval');
  assert.equal(proposal.lifecycleState, 'WAITING_FOR_APPROVAL');

  // Verify file has NOT been automatically modified
  const currentContent = await fs.readFile(path.join(projectPath, 'models', 'Order.php'), 'utf8');
  assert.ok(currentContent.includes('WHERE status = \'pending\'"'));
  assert.ok(!currentContent.includes('LIMIT 100'), 'Proposal MUST NOT be automatically applied without approval!');

  console.log('  -> STEP 5 PASSED: Proposal created in awaiting_approval state without automatic apply.');
  console.log('[PERF-TEST] ALL 5 PERFORMANCE INVESTIGATION REGRESSION SUITES PASSED (5/5).');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}
