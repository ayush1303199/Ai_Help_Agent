import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import developerFiles from '../electron/developerFiles.cjs';
import developerAgent from '../electron/developerAgent.cjs';

console.log('[TEST] Starting Coding Agent sync & tool contract verification test...');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-sync-contract-'));
const projectPath = path.join(tempDir, 'active-project');
await fs.mkdir(projectPath, { recursive: true });
await fs.writeFile(path.join(projectPath, 'index.ts'), 'console.log("hello");\n', 'utf8');
await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'active-project', scripts: { typecheck: 'node -v' } }), 'utf8');

try {
  // ==========================================
  // CASE 1: Initial project selection & attach
  // ==========================================
  console.log('[TEST] Case 1: Initial project attachment...');
  const ownerA = 1001;
  const attached = await developerFiles.chooseProjectFolder({
    showOpenDialog: async () => ({ canceled: false, filePaths: [projectPath] }),
  }, ownerA);

  assert.equal(attached.projectRoot, projectPath);
  assert.equal(developerFiles.getProjectRoot(ownerA), projectPath);

  const stateA = await developerFiles.getProjectState(ownerA);
  assert.equal(stateA.status, developerFiles.PROJECT_STATUSES.ATTACHED);
  assert.equal(stateA.projectRoot, projectPath);

  // File operations work under ownerA
  const fileA = await developerFiles.readFile('index.ts', ownerA);
  assert.equal(fileA.content, 'console.log("hello");\n');
  console.log('[TEST] Case 1 PASSED: Initial project attached and readable.');

  // ==========================================
  // CASE 2: Renderer reload / window reconnect
  // ==========================================
  console.log('[TEST] Case 2: Renderer reload / reconnect...');
  // Old renderer window destroyed
  developerFiles.releaseProject(ownerA);
  // OwnerA is no longer in projectRoots
  assert.equal(developerFiles.getProjectRoot(ownerA), null);

  // New renderer window created with new webContentsId 1002
  const ownerReloaded = 1002;
  // Querying project state reconnects to authoritative project
  const stateReloaded = await developerFiles.getProjectState(ownerReloaded);
  assert.equal(stateReloaded.status, developerFiles.PROJECT_STATUSES.ATTACHED);
  assert.equal(stateReloaded.projectRoot, projectPath);

  // Asserting owner automatically re-attaches to the reloaded session without throwing
  const resolvedRoot = developerFiles.assertProjectOwner(ownerReloaded);
  assert.equal(resolvedRoot, projectPath);
  assert.equal(developerFiles.getProjectRoot(ownerReloaded), projectPath);

  // File read works immediately after reload
  const fileReloaded = await developerFiles.readFile('index.ts', ownerReloaded);
  assert.equal(fileReloaded.content, 'console.log("hello");\n');
  console.log('[TEST] Case 2 PASSED: Reloaded renderer reconnected to authoritative project.');

  // ==========================================
  // CASE 3: Multi-session isolation
  // ==========================================
  console.log('[TEST] Case 3: Multi-session ownership isolation...');
  const unauthorizedOwner = 9999;
  // While ownerReloaded owns the project, unauthorizedOwner cannot read or assert ownership
  assert.throws(
    () => developerFiles.assertProjectOwner(unauthorizedOwner),
    (err) => err.code === 'PROJECT_NOT_OWNED' || /not owned/i.test(err.message),
  );
  await assert.rejects(
    () => developerFiles.readFile('index.ts', unauthorizedOwner),
    /not owned/i,
  );
  console.log('[TEST] Case 3 PASSED: Non-owner webContents strictly isolated.');

  // ==========================================
  // CASE 4: Intentional detach
  // ==========================================
  console.log('[TEST] Case 4: Explicit clearProject / detach...');
  developerFiles.clearProject(ownerReloaded);
  const stateDetached = await developerFiles.getProjectState(ownerReloaded);
  assert.equal(stateDetached.status, developerFiles.PROJECT_STATUSES.DETACHED);
  assert.equal(stateDetached.projectRoot, null);

  // Operations now throw PROJECT_DETACHED
  assert.throws(
    () => developerFiles.assertProjectOwner(ownerReloaded),
    (err) => err.code === 'PROJECT_DETACHED' || /PROJECT_DETACHED/i.test(err.message),
  );
  console.log('[TEST] Case 4 PASSED: Explicit detach transitions status to PROJECT_DETACHED.');

  // ==========================================
  // CASE 5: Missing project on disk
  // ==========================================
  console.log('[TEST] Case 5: Missing folder on disk detection...');
  const doomedDir = path.join(tempDir, 'doomed-project');
  await fs.mkdir(doomedDir, { recursive: true });
  await developerFiles.attachProject(doomedDir, ownerReloaded);
  assert.equal((await developerFiles.getProjectState(ownerReloaded)).status, developerFiles.PROJECT_STATUSES.ATTACHED);

  // Delete folder from disk
  await fs.rm(doomedDir, { recursive: true, force: true });

  const stateMissing = await developerFiles.getProjectState(ownerReloaded);
  assert.equal(stateMissing.status, developerFiles.PROJECT_STATUSES.MISSING);

  assert.throws(
    () => developerFiles.assertProjectOwner(ownerReloaded),
    (err) => err.code === 'PROJECT_MISSING' || /PROJECT_MISSING/i.test(err.message),
  );
  console.log('[TEST] Case 5 PASSED: Missing folder classified as PROJECT_MISSING.');

  // ==========================================
  // CASE 6: Proposal approval lifecycle preservation
  // ==========================================
  console.log('[TEST] Case 6: Proposal lifecycle & unapproved write protection...');
  const ownerLifecycle = 2001;
  await developerFiles.attachProject(projectPath, ownerLifecycle);
  const sessionId = developerAgent.getSession(ownerLifecycle);
  const patchContent = `--- a/index.ts
+++ b/index.ts
@@ -1,1 +1,1 @@
-console.log("hello");
+console.log("verified");
`;

  const proposal = await developerAgent.createProposal({
    root: projectPath,
    sessionId,
    ownerWebContentsId: ownerLifecycle,
    raw: patchContent,
  });
  assert.equal(proposal.state, 'awaiting_approval');

  // Attempting to apply unapproved proposal must reject
  await assert.rejects(
    () => developerAgent.apply(proposal.taskId, { ownerWebContentsId: ownerLifecycle, sessionId }),
    /approved/,
  );

  // Explicit approval
  developerAgent.approve(proposal.taskId, { ownerWebContentsId: ownerLifecycle, sessionId });
  const applied = await developerAgent.apply(
    proposal.taskId,
    { ownerWebContentsId: ownerLifecycle, sessionId },
    async () => ({ ok: true, status: 'PASS' }),
    projectPath,
  );
  assert.equal(applied.state, 'completed');
  assert.equal(await fs.readFile(path.join(projectPath, 'index.ts'), 'utf8'), 'console.log("verified");\n');

  // Undo restores exact snapshot
  await developerAgent.undo(proposal.taskId, { ownerWebContentsId: ownerLifecycle, sessionId });
  assert.equal(await fs.readFile(path.join(projectPath, 'index.ts'), 'utf8'), 'console.log("hello");\n');
  console.log('[TEST] Case 6 PASSED: Proposal approval gate & rollback strictly preserved.');

  // ==========================================
  // CASE 7: Python Tool Schema Invariant & Provider Error Classification
  // ==========================================
  console.log('[TEST] Case 7: Python provider & websocket contract checks...');
  const pythonScript = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path("server/src").resolve()))

from coding_websocket import (
    classify_provider_exception,
    get_backend_project_state,
    set_backend_project_state,
    CODING_TOOLS,
)
from coding_provider import complete_coding_model

# 1. Test error classifications
test_cases = [
    ("Tool call validation failed: attempted to call tool 'search_code' which was not in request.tools", "TOOL_SCHEMA_MISSING"),
    ("Unsupported Coding Agent tool: delete_database", "TOOL_UNKNOWN"),
    ("Developer project directory does not exist on disk (PROJECT_MISSING)", "PROJECT_MISSING"),
    ("Developer project is detached (PROJECT_DETACHED)", "PROJECT_DETACHED"),
    ("No project folder selected (PROJECT_NOT_ATTACHED)", "PROJECT_NOT_ATTACHED"),
    ("Project session was stale (PROJECT_STALE)", "PROJECT_STALE"),
    ("Renderer disconnected unexpectedly", "RENDERER_DISCONNECTED"),
    ("Desktop window lost (ELECTRON_SESSION_DISCONNECTED)", "ELECTRON_SESSION_DISCONNECTED"),
    ("Could not connect to the isolated Coding Agent service", "BACKEND_UNAVAILABLE"),
    ("Error code: 429 - rate limit exceeded", "PROVIDER_RATE_LIMIT"),
    ("Connection error: connection closed unexpectedly", "PROVIDER_NETWORK_FAILURE"),
]

for err_str, expected_cat in test_cases:
    classified = classify_provider_exception(Exception(err_str))
    assert classified["category"] == expected_cat, f"Expected {expected_cat}, got {classified['category']} for {err_str}"

# 2. Test backend project state tracking
st = get_backend_project_state()
assert "status" in st

updated = set_backend_project_state("${projectPath.replace(/\\/g, '\\\\')}")
assert updated["status"] == "PROJECT_ATTACHED"
assert updated["attached"] == True

cleared = set_backend_project_state(None)
assert cleared["status"] == "PROJECT_DETACHED"
assert cleared["attached"] == False

# 3. Test that search_code tool declaration schema is valid
search_tool = next((t for t in CODING_TOOLS if (t.get("function") or {}).get("name") == "search_code"), None)
assert search_tool is not None, "search_code must exist in CODING_TOOLS"
assert "query" in search_tool["function"]["parameters"]["properties"]

print("Python tool invariants and error classifications validated successfully.")
`;

  await new Promise((resolve, reject) => {
    const py = spawn('python', ['-c', pythonScript], { stdio: 'inherit' });
    py.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Python validation exited with code ${code}`));
    });
  });
  console.log('[TEST] Case 7 PASSED: Python tool contract & error classification verified.');

} finally {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log('\nAll Coding Agent sync & tool contract tests PASSED successfully.');
