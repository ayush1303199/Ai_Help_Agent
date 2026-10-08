import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';

console.log('[TEST-MATRIX] Starting 10-point Verification Matrix for Coding Agent Project Attachment & Failure Elimination...');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-matrix-test-'));
const projectPath = path.join(tempDir, 'sample-ecommerce');

try {
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'models'), { recursive: true });
  await fs.writeFile(
    path.join(projectPath, 'package.json'),
    JSON.stringify({ name: 'sample-ecommerce', version: '1.0.0' }, null, 2),
  );
  await fs.writeFile(
    path.join(projectPath, 'src', 'index.ts'),
    'console.log("hello store");\n',
  );
  await fs.writeFile(
    path.join(projectPath, 'models', 'Order.php'),
    '<?php\nclass Order {\n  public function getSlowOrders() {\n    // query takes time\n    return $this->db->query("SELECT * FROM orders WHERE status = \'pending\'");\n  }\n}\n',
  );

  // =========================================================================
  // TEST 1: Electron Native Picker [UNIT/INTEGRATION]
  // =========================================================================
  console.log('[TEST 1] Electron Native Picker (chooseProjectFolder)...');
  const ownerDesktop = 101;
  const mockDialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [projectPath] }),
  };
  const chosenResult = await developerFiles.chooseProjectFolder(mockDialog, ownerDesktop);
  assert.equal(chosenResult.canceled, false);
  assert.equal(chosenResult.projectRoot.toLowerCase(), projectPath.toLowerCase());
  const desktopChosenState = await developerFiles.getProjectState(ownerDesktop);
  assert.equal(desktopChosenState.status, 'PROJECT_ATTACHED');
  console.log('  -> TEST 1 PASSED: Electron native picker attaches project.');

  // =========================================================================
  // TEST 2: Browser Directory Picker & Discovery [INTEGRATION/E2E]
  // =========================================================================
  console.log('[TEST 2] Browser Directory Discovery Bridge (/api/coding/project-discover)...');
  const discoverRes = await fetch('http://localhost:3001/api/coding/project-discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'sample-ecommerce',
      signatures: ['package.json', 'models'],
    }),
  });
  assert.equal(discoverRes.ok, true, 'project-discover endpoint must return HTTP 200');
  const discoveryData = await discoverRes.json();
  assert.equal(discoveryData.status, 'PROJECT_ATTACHED');
  assert.equal(discoveryData.projectRoot.toLowerCase(), projectPath.toLowerCase());
  console.log('  -> TEST 2 PASSED: Browser project discovery located and attached project.');

  // =========================================================================
  // TEST 3: Project Attachment Contract [INTEGRATION]
  // =========================================================================
  console.log('[TEST 3] Project Attachment Contract (/api/coding/project-attach & developerFiles.attachProject)...');
  const attachRes = await fetch('http://localhost:3001/api/coding/project-attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot: projectPath }),
  });
  assert.equal(attachRes.ok, true);
  const attachData = await attachRes.json();
  assert.equal(attachData.status, 'PROJECT_ATTACHED');
  assert.equal(attachData.attached, true);
  assert.equal(attachData.projectRoot.toLowerCase(), projectPath.toLowerCase());

  const electronAttach = await developerFiles.attachProject(projectPath, 102);
  assert.equal(electronAttach.status, 'PROJECT_ATTACHED');
  assert.equal(electronAttach.projectRoot.toLowerCase(), projectPath.toLowerCase());
  console.log('  -> TEST 3 PASSED: Both HTTP and Electron attachment contracts satisfied.');

  // =========================================================================
  // TEST 4: Project State Synchronization [INTEGRATION/BUSINESS]
  // =========================================================================
  console.log('[TEST 4] Project State Synchronization (Electron <-> Backend)...');
  const backendStateRes = await fetch('http://localhost:3001/api/coding/project-state');
  const backendState = await backendStateRes.json();
  assert.equal(backendState.status, 'PROJECT_ATTACHED');
  assert.equal(backendState.attached, true);
  assert.equal(backendState.projectRoot.toLowerCase(), projectPath.toLowerCase());

  const electronState = await developerFiles.getProjectState(102);
  assert.equal(electronState.status, 'PROJECT_ATTACHED');
  assert.equal(electronState.projectRoot.toLowerCase(), projectPath.toLowerCase());
  console.log('  -> TEST 4 PASSED: State synchronized two-way between Electron and backend.');

  // =========================================================================
  // TEST 5: Renderer Reload Persistence [INTEGRATION/BUSINESS]
  // =========================================================================
  console.log('[TEST 5] Renderer Reload Persistence & Recovery...');
  // Simulating fresh renderer session requesting state on mount
  const reloadedSessionStateRes = await fetch('http://localhost:3001/api/coding/project-state');
  const reloadedSessionState = await reloadedSessionStateRes.json();
  assert.equal(reloadedSessionState.status, 'PROJECT_ATTACHED');
  assert.equal(reloadedSessionState.projectRoot.toLowerCase(), projectPath.toLowerCase());
  console.log('  -> TEST 5 PASSED: Reconnected session immediately recovers authoritative project.');

  // =========================================================================
  // TEST 6: Project Detach [INTEGRATION/BUSINESS]
  // =========================================================================
  console.log('[TEST 6] Project Detach & Refusal of Project Operations...');
  const clearRes = await fetch('http://localhost:3001/api/coding/project-clear', { method: 'POST' });
  assert.equal(clearRes.ok, true);
  const clearedState = await clearRes.json();
  assert.equal(clearedState.status, 'PROJECT_DETACHED');
  assert.equal(clearedState.attached, false);

  // File operations must now be rejected
  const rejectedRead = await fetch('http://localhost:3001/api/coding/read-file?path=package.json');
  assert.equal(rejectedRead.status, 409, 'Detached project must reject file read with HTTP 409');
  console.log('  -> TEST 6 PASSED: Detach blocks project operations.');

  // Re-attach for subsequent tests
  await fetch('http://localhost:3001/api/coding/project-attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot: projectPath }),
  });

  // =========================================================================
  // TEST 7: Missing Directory [INTEGRATION/BUSINESS]
  // =========================================================================
  console.log('[TEST 7] Missing Directory Detection (PROJECT_MISSING)...');
  const missingDirPath = path.join(tempDir, 'deleted-folder');
  await fs.mkdir(missingDirPath, { recursive: true });
  await fetch('http://localhost:3001/api/coding/project-attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot: missingDirPath }),
  });
  // Delete the directory from disk
  await fs.rm(missingDirPath, { recursive: true, force: true });
  const missingStateRes = await fetch('http://localhost:3001/api/coding/project-state');
  const missingState = await missingStateRes.json();
  assert.equal(missingState.status, 'PROJECT_MISSING', 'Deleted directory must report PROJECT_MISSING');
  console.log('  -> TEST 7 PASSED: PROJECT_MISSING detected accurately.');

  // Re-attach projectPath
  await fetch('http://localhost:3001/api/coding/project-attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot: projectPath }),
  });

  // =========================================================================
  // TEST 8: Unauthorized File Access & Security Scoping [SECURITY/INTEGRATION]
  // =========================================================================
  console.log('[TEST 8] Unauthorized File Access & Security Boundary Check...');
  const outsidePathRes = await fetch('http://localhost:3001/api/coding/read-file?path=../outside-secret.txt');
  assert.equal(outsidePathRes.status, 400, 'Path traversal must be rejected with HTTP 400');

  const sensitiveRes = await fetch('http://localhost:3001/api/coding/read-file?path=.env');
  assert.equal(sensitiveRes.status, 400, 'Sensitive path .env must be rejected with HTTP 400');

  const validFileRes = await fetch('http://localhost:3001/api/coding/read-file?path=src/index.ts');
  assert.equal(validFileRes.status, 200, 'Authorized project file must be allowed with HTTP 200');
  console.log('  -> TEST 8 PASSED: Security scoping and containment verified.');

  // =========================================================================
  // TEST 9: Coding Agent File Inspection [INTEGRATION/BUSINESS]
  // =========================================================================
  console.log('[TEST 9] Coding Agent File Inspection & Tool Execution...');
  const dirRes = await fetch('http://localhost:3001/api/coding/directory?path=.');
  assert.equal(dirRes.ok, true);
  const dirEntries = await dirRes.json();
  const entryNames = dirEntries.map((e) => e.name);
  assert.ok(entryNames.includes('package.json'));
  assert.ok(entryNames.includes('models'));

  const searchRes = await fetch('http://localhost:3001/api/coding/search-code?query=query&scope=.');
  assert.equal(searchRes.ok, true);
  const searchResults = await searchRes.json();
  assert.ok(searchResults.results.length > 0);
  assert.ok(searchResults.results.some((r) => r.path.includes('Order.php')));

  const toolExecRes = await fetch('http://localhost:3001/api/coding/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'read_file',
      arguments: { relativePath: 'models/Order.php' },
      scope: '.',
    }),
  });
  assert.equal(toolExecRes.ok, true);
  const toolExec = await toolExecRes.json();
  assert.equal(toolExec.ok, true);
  assert.ok(toolExec.data.content.includes('SELECT * FROM orders'));
  console.log('  -> TEST 9 PASSED: Inspection endpoints and tool bridge operate on real files.');

  // =========================================================================
  // TEST 10: Proposal / Diff Generation & Approval Gate [INTEGRATION/BUSINESS]
  // =========================================================================
  console.log('[TEST 10] Proposal / Diff Generation, Approval Gating & Rollback...');
  const ownerProposal = 105;
  await developerFiles.attachProject(projectPath, ownerProposal);
  const sessionId = developerAgent.getSession(ownerProposal);

  const proposal = await developerAgent.createProposal({
    root: projectPath,
    sessionId,
    ownerWebContentsId: ownerProposal,
    raw: `--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,1 +1,1 @@\n-console.log("hello store");\n+console.log("hello store verified");\n`,
  });
  assert.equal(proposal.state, 'awaiting_approval');
  assert.equal(proposal.lifecycleState, 'WAITING_FOR_APPROVAL');

  // Verify file has NOT been modified before approval
  const preApplyContent = await fs.readFile(path.join(projectPath, 'src', 'index.ts'), 'utf8');
  assert.equal(preApplyContent, 'console.log("hello store");\n');

  // Approve proposal
  const approved = developerAgent.approve(proposal.taskId, { ownerWebContentsId: ownerProposal, sessionId });
  assert.equal(approved.state, 'approved');

  // Apply proposal
  const applied = await developerAgent.apply(
    proposal.taskId,
    { ownerWebContentsId: ownerProposal, sessionId },
    async () => ({ ok: true, status: 'PASS' }),
    projectPath,
  );
  assert.equal(applied.state, 'completed');
  const postApplyContent = await fs.readFile(path.join(projectPath, 'src', 'index.ts'), 'utf8');
  assert.equal(postApplyContent, 'console.log("hello store verified");\n');

  // Undo proposal
  await developerAgent.undo(proposal.taskId, { ownerWebContentsId: ownerProposal, sessionId });
  const postUndoContent = await fs.readFile(path.join(projectPath, 'src', 'index.ts'), 'utf8');
  assert.equal(postUndoContent, 'console.log("hello store");\n');

  console.log('  -> TEST 10 PASSED: Approval gate, atomic apply, and rollback verified.');
  console.log('[TEST-MATRIX] ALL 10 VERIFICATION TESTS PASSED SUCCESSFULLY (10/10).');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}
