import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import developerAgent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import {
  validateSafePath,
  isGreenfieldWorkspace,
  discoverProjectConventions,
  deriveModularPlan,
  synthesizeMultiFilePatch,
  verifyIntegrationReachability,
} from '../electron/coding-pipeline/modularArchitectureEngine.cjs';

const {
  createSession,
  executeAutonomousCodingWorkflow,
} = developerAgent;

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-modular-test-'));
const ownerId = 73001;

try {
  console.log('--- STARTING SECTION 4.F MODULAR ARCHITECTURE & REUSABILITY TEST SUITE ---');

  // =========================================================================
  // TEST 1: Greenfield Request Creates Multiple Separated Modules (Config, Utils, Service, Entrypoint)
  // =========================================================================
  const greenfieldDir = path.join(testRoot, 'greenfield-app');
  await fs.mkdir(greenfieldDir, { recursive: true });

  const isGreenfield = await isGreenfieldWorkspace(greenfieldDir);
  assert.equal(isGreenfield, true, 'Empty workspace must be detected as greenfield');

  const greenfieldPlan = await deriveModularPlan(greenfieldDir, {
    userRequest: 'Create a calculation service with configurable multipliers and math utilities',
  });
  assert.equal(greenfieldPlan.isGreenfield, true);
  assert.equal(greenfieldPlan.modulesToCreate.length, 4, 'Greenfield plan must separate config, utils, service, and entrypoint');

  const responsibilities = greenfieldPlan.modulesToCreate.map((m) => m.responsibility);
  assert.ok(responsibilities.includes('CONFIGURATION'), 'Must include configuration module');
  assert.ok(responsibilities.includes('SHARED_UTILITY'), 'Must include shared utility module');
  assert.ok(responsibilities.includes('CORE_BUSINESS_LOGIC'), 'Must include core business logic module');
  assert.ok(responsibilities.includes('APPLICATION_ENTRYPOINT'), 'Must include application entrypoint module');

  const greenfieldSessionId = 'session-v10-greenfield';
  createSession(greenfieldSessionId, ownerId);

  let greenfieldProposalCaptured = null;
  const greenfieldResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Scaffold calculation service in greenfield project',
    root: greenfieldDir,
    scope: '.',
    sessionId: greenfieldSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async ({ proposalContract }) => {
      greenfieldProposalCaptured = proposalContract;
      return true;
    },
    tools: {
      deriveModularPlan: true,
    },
  });

  assert.equal(greenfieldResult.outcome, 'SUCCESS');
  assert.equal(greenfieldResult.codeApplied, true);
  assert.equal(greenfieldResult.codeVerified, true);
  assert.ok(greenfieldProposalCaptured.isGreenfield);

  // Verify all 4 modular files exist on disk
  for (const mod of greenfieldPlan.modulesToCreate) {
    const stat = await fs.stat(path.join(greenfieldDir, mod.path));
    assert.ok(stat.isFile(), `Module ${mod.path} must exist on disk`);
  }
  console.log('[TEST 1 PASSED] Greenfield request creates multiple appropriately separated modules.');

  // =========================================================================
  // TEST 2: Feature Request in Existing Project Reuses Established Architecture
  // =========================================================================
  const existingDir = path.join(testRoot, 'existing-app');
  await fs.mkdir(path.join(existingDir, 'services'), { recursive: true });
  await fs.mkdir(path.join(existingDir, 'utils'), { recursive: true });
  await fs.writeFile(path.join(existingDir, 'package.json'), JSON.stringify({ name: 'existing-app', version: '1.0.0' }), 'utf8');
  await fs.writeFile(path.join(existingDir, 'index.js'), '// Main Application Entrypoint\nconst existingApp = true;\n', 'utf8');

  const existingConventions = await discoverProjectConventions(existingDir);
  assert.equal(existingConventions.isGreenfield, false);
  assert.equal(existingConventions.language, 'javascript');
  assert.ok(existingConventions.serviceDirs.includes('services'));
  assert.ok(existingConventions.utilDirs.includes('utils'));

  const existingPlan = await deriveModularPlan(existingDir, {
    userRequest: 'Add order processing feature',
  });
  assert.equal(existingPlan.isGreenfield, false);
  // Reuses services/ directory instead of scaffolding new app root
  assert.ok(existingPlan.modulesToCreate.some((m) => m.path.startsWith('services/')));
  assert.ok(existingPlan.integrationPoints.some((p) => p.targetFile === 'index.js'));
  console.log('[TEST 2 PASSED] Feature request in existing project reuses established architecture.');

  // =========================================================================
  // TEST 3: Shared Logic is Reused Instead of Duplicated Where Applicable
  // =========================================================================
  const sharedModulePath = path.join(existingDir, 'utils', 'sharedUtils.js');
  await fs.writeFile(sharedModulePath, 'function formatResponse(d) { return { d }; }\nmodule.exports = { formatResponse };\n', 'utf8');

  const sharedPlan = await deriveModularPlan(existingDir, {
    userRequest: 'Add payment notification service reusing existing shared utils',
  });
  assert.ok(sharedPlan.reusedModules.length > 0, 'Existing shared utility must be detected and reused');
  assert.ok(!sharedPlan.modulesToCreate.some((m) => m.path === 'utils/sharedUtils.js'), 'Must not duplicate existing utility file');
  console.log('[TEST 3 PASSED] Shared logic is reused instead of duplicated where applicable.');

  // =========================================================================
  // TEST 4: Required Integration Points Are Updated and Verified
  // =========================================================================
  const existingSessionId = 'session-v10-existing';
  createSession(existingSessionId, ownerId);

  const existingResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Implement feature service in existing project',
    root: existingDir,
    scope: '.',
    sessionId: existingSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async () => true,
    tools: {
      modularPlan: sharedPlan,
    },
  });

  assert.equal(existingResult.outcome, 'SUCCESS');
  assert.equal(existingResult.codeApplied, true);
  assert.equal(existingResult.codeVerified, true);

  // Check that index.js integration point was updated
  const indexContentAfter = await fs.readFile(path.join(existingDir, 'index.js'), 'utf8');
  assert.ok(indexContentAfter.includes('executeFeature'), 'Integration point in index.js must import executeFeature');
  console.log('[TEST 4 PASSED] Required integration points are updated and verified.');

  // =========================================================================
  // TEST 5: Missing or Failed File Write Prevents False Success Report
  // =========================================================================
  const missingPlan = {
    isGreenfield: false,
    modulesToCreate: [{ path: 'services/ghostService.js', responsibility: 'CORE_BUSINESS_LOGIC', content: 'module.exports = {};' }],
    integrationPoints: [{ targetFile: 'index.js', integrationSnippet: 'require("./services/ghostService");' }],
    planRecord: [],
  };
  // Do NOT write the ghostService to disk; simulate verification
  const reachabilityFailure = await verifyIntegrationReachability(existingDir, missingPlan);
  assert.equal(reachabilityFailure.isValid, false, 'Missing module file must fail reachability check');
  assert.match(reachabilityFailure.rejectionReason, /ghostService\.js/);
  console.log('[TEST 5 PASSED] Missing or failed file write prevents false success report.');

  // =========================================================================
  // TEST 6: Existing Files and Unrelated User Changes Are Preserved
  // =========================================================================
  assert.ok(indexContentAfter.includes('const existingApp = true;'), 'Existing original logic in index.js must be preserved');
  const pkgContent = await fs.readFile(path.join(existingDir, 'package.json'), 'utf8');
  assert.ok(pkgContent.includes('existing-app'), 'Existing package.json must remain 100% untouched');
  console.log('[TEST 6 PASSED] Existing files and unrelated user changes are preserved.');

  // =========================================================================
  // TEST 7: Path Validation and Approval Requirements Remain Enforced
  // =========================================================================
  assert.throws(
    () => validateSafePath(existingDir, '../../outside.js'),
    /escapes the project root/,
    'Path escaping root must be rejected'
  );
  assert.throws(
    () => validateSafePath(existingDir, '/absolute/path.js'),
    /escapes the project root/,
    'Absolute paths must be rejected'
  );

  // Approval rejection prevents writing
  const declinedSessionId = 'session-v10-declined';
  createSession(declinedSessionId, ownerId);
  const declinedResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Implement unauthorized feature',
    root: existingDir,
    scope: '.',
    sessionId: declinedSessionId,
    ownerWebContentsId: ownerId,
    requestApproval: async () => false, // USER REJECTS
    tools: {
      modularPlan: {
        isGreenfield: false,
        modulesToCreate: [{ path: 'services/unauthorizedService.js', responsibility: 'CORE', content: 'bad' }],
        integrationPoints: [],
        planRecord: [],
      },
    },
  });
  assert.equal(declinedResult.outcome, 'APPROVAL_REJECTED');
  assert.equal(declinedResult.codeApplied, false);
  const unauthorizedExists = await fs.stat(path.join(existingDir, 'services/unauthorizedService.js')).then(() => true).catch(() => false);
  assert.equal(unauthorizedExists, false, '0 bytes must be written when approval is declined');
  console.log('[TEST 7 PASSED] Path validation and approval requirements remain enforced.');

  // =========================================================================
  // TEST 8: Existing Single-File Tasks Continue to Work
  // =========================================================================
  const singleFileRel = 'services/SingleFileFix.js';
  await fs.writeFile(path.join(existingDir, singleFileRel), 'function debugMe() {\n  debugger;\n  return true;\n}\n', 'utf8');

  const singleFileSessionId = 'session-v10-single-file';
  createSession(singleFileSessionId, ownerId);
  const singleFileResult = await executeAutonomousCodingWorkflow({
    userRequest: 'Fix the debugger statement in SingleFileFix.js',
    root: existingDir,
    scope: '.',
    sessionId: singleFileSessionId,
    ownerWebContentsId: ownerId,
    assessFindingRelevance: async ({ findings }) => ({
      findings: findings.map((f) => ({
        findingId: f.findingId,
        decision: 'SUPPORTED',
        relationship: 'The single file fix directly links the cited debugger statement to the requested outcome.',
        evidenceIds: [f.sourceEvidenceId],
        contradictionEvidenceIds: [],
        unresolvedAssumptions: [],
        provenance: 'TEST_FIXTURE',
      })),
    }),
    requestApproval: async () => true,
    runCheck: async (script) => ({ ok: true, executed: true, exitCode: 0, check: script || 'test' }),
    tools: {
      searchCode: async () => ({
        results: [{ path: singleFileRel, score: 95, line: 2 }],
      }),
      readFile: async () => ({ content: 'function debugMe() {\n  debugger;\n  return true;\n}\n' }),
    },
  });
  assert.ok(['SUCCESS', 'WORK_ITEM_COVERAGE_NOT_ESTABLISHED'].includes(singleFileResult.outcome));
  assert.equal(singleFileResult.codeApplied, true);
  const singleFileContent = await fs.readFile(path.join(existingDir, singleFileRel), 'utf8');
  assert.ok(!singleFileContent.includes('debugger;'), 'Single file bug fix must still work seamlessly');
  console.log('[TEST 8 PASSED] Existing single-file tasks continue to work without regression.');

  // =========================================================================
  // TEST 9: Created Modules Can Be Imported, Resolved, and Reached
  // =========================================================================
  // Test requiring the greenfield entrypoint and calculation service
  await fs.writeFile(path.join(greenfieldDir, 'package.json'), JSON.stringify({ name: 'greenfield-app', type: 'commonjs' }), 'utf8');
  const { createRequire } = await import('node:module');
  const requireGreenfield = createRequire(path.join(greenfieldDir, 'index.js'));
  const greenfieldEntry = requireGreenfield('./index.js');
  assert.equal(typeof greenfieldEntry.run, 'function', 'Greenfield entrypoint run() must be a functional export');
  const calcOutput = greenfieldEntry.run();
  assert.equal(calcOutput, 100, 'Greenfield calculation service must be reachable and return expected result (50 * 2 = 100)');
  console.log('[TEST 9 PASSED] Created modules can be imported, resolved, and reached through execution path.');

  // =========================================================================
  // TEST 10: Tests Detect Incomplete Integration, Not Just File Existence
  // =========================================================================
  const orphanModulePath = path.join(existingDir, 'services', 'orphanService.js');
  await fs.writeFile(orphanModulePath, 'function orphanLogic() { return 123; }\nmodule.exports = { orphanLogic };\n', 'utf8');

  // Plan says orphanService should be integrated into index.js with specific snippet, but index.js does not have it!
  const incompleteIntegrationPlan = {
    isGreenfield: false,
    modulesToCreate: [{ path: 'services/orphanService.js', responsibility: 'CORE_BUSINESS_LOGIC', content: 'x' }],
    integrationPoints: [{
      targetFile: 'index.js',
      integrationSnippet: 'const { orphanLogic } = require("./services/orphanService");',
    }],
    planRecord: [],
  };

  const incompleteCheck = await verifyIntegrationReachability(existingDir, incompleteIntegrationPlan);
  assert.equal(incompleteCheck.isValid, false, 'Must detect incomplete integration even when the file exists on disk');
  assert.match(incompleteCheck.rejectionReason, /Incomplete integration/i);
  assert.ok(incompleteCheck.incompleteIntegrations.length > 0);
  console.log('[TEST 10 PASSED] Tests detect incomplete integration, not just file existence.');

  console.log('--- ALL 10 SECTION 4.F MODULAR ARCHITECTURE & REUSABILITY TESTS PASSED SUCCESSFULLY! ---');
} finally {
  developerFiles.releaseProject(ownerId);
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
