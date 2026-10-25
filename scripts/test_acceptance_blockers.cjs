const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Test 1: developerFiles.chooseProjectFolder return contract and parentWindow support
{
  const developerFiles = require('../electron/developerFiles.cjs');
  assert.equal(typeof developerFiles.chooseProjectFolder, 'function');
  
  // Mock dialog that returns a test path
  const mockDialog = {
    showOpenDialog: async (windowOrOptions, options) => {
      const opts = options || windowOrOptions;
      return { canceled: false, filePaths: [process.cwd()] };
    }
  };

  const fakeOwnerWebContentsId = 99999;
  developerFiles.chooseProjectFolder(mockDialog, fakeOwnerWebContentsId).then(async (res) => {
    assert.equal(res.canceled, false);
    assert.equal(res.status, 'PROJECT_ATTACHED', 'chooseProjectFolder must return status: PROJECT_ATTACHED');
    assert.ok(res.projectRoot, 'chooseProjectFolder must return projectRoot');
    console.log('[PASS] chooseProjectFolder returns status: PROJECT_ATTACHED');
  }).catch((err) => {
    console.error('[FAIL] chooseProjectFolder test failed:', err);
    process.exit(1);
  });
}

// Test 2: developerFiles.syncProjectStateToBackend header check
{
  const developerFilesSource = fs.readFileSync(path.join(__dirname, '../electron/developerFiles.cjs'), 'utf8');
  assert.ok(
    developerFilesSource.includes("'X-Coding-Auth': authToken") ||
    developerFilesSource.includes('"X-Coding-Auth": authToken'),
    'syncProjectStateToBackend must include X-Coding-Auth header'
  );
  console.log('[PASS] syncProjectStateToBackend includes X-Coding-Auth header');
}

// Test 3: electron/main.cjs passes parentWindow to chooseProjectFolder
{
  const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.ok(
    mainSource.includes('chooseProjectFolder(dialog, event.sender.id, parentWindow)'),
    'main.cjs must pass parentWindow to chooseProjectFolder'
  );
  console.log('[PASS] main.cjs passes parentWindow to chooseProjectFolder');
}

// Test 4: useCodingAgentController gracefully handles 403 project-attach on restore
{
  const controllerSource = fs.readFileSync(path.join(__dirname, '../src/features/coding/useCodingAgentController.ts'), 'utf8');
  assert.ok(
    !controllerSource.includes("throw new Error(`Saved project could not be attached: HTTP ${attachResponse.status}`)"),
    'Controller must not throw error on unattached saved project restore'
  );
  assert.ok(
    controllerSource.includes("setProjectLifecycleState('NO_PROJECT')"),
    'Controller must reset lifecycle state to NO_PROJECT on unattached saved project restore'
  );
  console.log('[PASS] useCodingAgentController handles unattached saved project gracefully');
}

// Test 5: server/src/index.py returns PROJECT_NOT_ATTACHED (HTTP 200) when origin is trusted but session header is missing
{
  const indexSource = fs.readFileSync(path.join(__dirname, '../server/src/index.py'), 'utf8');
  assert.ok(
    indexSource.includes('except HTTPException:\n            return {"projectRoot": None, "status": "PROJECT_NOT_ATTACHED", "attached": False}') ||
    indexSource.includes('except HTTPException:\r\n            return {"projectRoot": None, "status": "PROJECT_NOT_ATTACHED", "attached": False}'),
    'index.py must catch HTTPException and return PROJECT_NOT_ATTACHED on GET /api/coding/project-state'
  );
  console.log('[PASS] index.py returns PROJECT_NOT_ATTACHED when session is invalid or missing');
}
