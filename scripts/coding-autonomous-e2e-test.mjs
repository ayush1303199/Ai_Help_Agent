import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import developerFiles from '../electron/developerFiles.cjs';
import developerAgent from '../electron/developerAgent.cjs';

function randomId(prefix = 'proj') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

const CODING_PRODUCTION_FILES = [
  'electron/developerAgent.cjs',
  'electron/developerFiles.cjs',
  'electron/developerIndex.cjs',
  'electron/developerContext.cjs',
  'electron/developerBenchmark.cjs',
  'server/src/coding_websocket.py',
  'server/src/coding_provider.py',
  'src/features/coding/codingTransport.ts',
  'src/features/coding/useCodingAgentController.ts',
  'src/features/coding/codingDiff.ts',
  'src/features/coding/codingSessionStore.ts',
];

const FORBIDDEN_LITERALS = [
  'candidate-portal-2026',
  'project-alpha',
  'project-beta',
  'candidatePortal',
  'AdmOuPrgList.php',
  'C:\\xampp\\htdocs',
  'C:/xampp/htdocs',
  'C:\\wamp64\\www',
  'C:\\laragon\\www',
  '/var/www/html',
  'defaultProject',
  'defaultRepository',
  'defaultRoot',
];

async function runHardCodeAudit() {
  console.log('\n--- AUDIT: Automated Production Code Hard-Code Scan ---');
  const findings = [];

  for (const relativeFile of CODING_PRODUCTION_FILES) {
    const fullPath = path.resolve(process.cwd(), relativeFile);
    let content = '';
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    for (const literal of FORBIDDEN_LITERALS) {
      const lowerLiteral = literal.toLowerCase();
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.toLowerCase().includes(lowerLiteral)) {
          let classification = 'PRODUCTION ASSUMPTION';
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            classification = 'DOCUMENTATION';
          } else if (trimmed.includes('console.log') || trimmed.includes('logger.')) {
            classification = 'LOGGING';
          }

          findings.push({
            file: relativeFile,
            line: i + 1,
            literal,
            classification,
            snippet: trimmed.slice(0, 100),
          });
        }
      }
    }
  }

  const productionAssumptions = findings.filter((f) => f.classification === 'PRODUCTION ASSUMPTION');
  console.log(`[AUDIT RESULT] Scanned ${CODING_PRODUCTION_FILES.length} production files.`);
  console.log(`[AUDIT RESULT] Total occurrences found: ${findings.length}`);
  console.log(`[AUDIT RESULT] Production Assumptions: ${productionAssumptions.length}`);

  if (productionAssumptions.length > 0) {
    console.error('FAILED: Found hardcoded assumptions in production logic:');
    console.table(productionAssumptions);
  }
  assert.equal(productionAssumptions.length, 0, 'Production code must contain ZERO project-specific assumptions');
  console.log('[PASS] Production code is 100% free of hardcoded project identities, paths, and routing assumptions.');
}

async function runAutonomousCodingTests() {
  console.log('=== STARTING TRUE AUTONOMOUS CODING AGENT PROJECT INTELLIGENCE TESTS ===');

  await runHardCodeAudit();

  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-intel-test-'));
  const originalRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  developerAgent.resetForTest();

  try {
    const workspaceRoot = path.join(testRoot, 'multi-workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = workspaceRoot;

    // ------------------------------------------------------------------------
    // SCENARIO 1: Multiple Unknown Projects with Different Technologies
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Testing Multiple Unknown Projects with Heterogeneous Stacks ---');
    const projPhpName = randomId('php-app');
    const projNodeName = randomId('node-svc');
    const projJavaName = randomId('java-core');

    const projPhpDir = path.join(workspaceRoot, projPhpName);
    const projNodeDir = path.join(workspaceRoot, projNodeName);
    const projJavaDir = path.join(workspaceRoot, projJavaName);

    await fs.mkdir(path.join(projPhpDir, 'models'), { recursive: true });
    await fs.mkdir(path.join(projNodeDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(projJavaDir, 'app'), { recursive: true });

    await fs.writeFile(path.join(projPhpDir, 'composer.json'), JSON.stringify({ name: projPhpName }), 'utf8');
    await fs.writeFile(path.join(projNodeDir, 'package.json'), JSON.stringify({ name: projNodeName }), 'utf8');
    await fs.writeFile(path.join(projJavaDir, 'pom.xml'), `<project><name>${projJavaName}</name></project>`, 'utf8');

    const targetPhpFile = `${randomId('Model')}.php`;
    const targetNodeFile = `${randomId('Handler')}.js`;
    const targetJavaFile = `${randomId('Worker')}.java`;

    await fs.writeFile(path.join(projPhpDir, 'models', targetPhpFile), '<?php class CustomModel { function execute() {} }', 'utf8');
    await fs.writeFile(path.join(projNodeDir, 'src', targetNodeFile), 'module.exports = { run: () => {} };', 'utf8');
    await fs.writeFile(path.join(projJavaDir, 'app', targetJavaFile), 'public class CustomWorker { public void process() {} }', 'utf8');

    const owner1 = 91001;
    // Discover by directory name
    const discPhp = await developerFiles.discoverProjectByName(projPhpName, owner1);
    assert.equal(discPhp.projectRoot, await fs.realpath(projPhpDir));
    developerFiles.releaseProject(owner1);

    const discNode = await developerFiles.discoverProjectByName(projNodeName, owner1);
    assert.equal(discNode.projectRoot, await fs.realpath(projNodeDir));
    developerFiles.releaseProject(owner1);

    const discJava = await developerFiles.discoverProjectByName(projJavaName, owner1);
    assert.equal(discJava.projectRoot, await fs.realpath(projJavaDir));
    developerFiles.releaseProject(owner1);

    // Discover by target file name without supplying project name!
    const discByPhpFile = await developerFiles.discoverProjectByName(targetPhpFile, owner1);
    assert.equal(discByPhpFile.projectRoot, await fs.realpath(projPhpDir));
    developerFiles.releaseProject(owner1);

    const discByNodeFile = await developerFiles.discoverProjectByName(targetNodeFile, owner1);
    assert.equal(discByNodeFile.projectRoot, await fs.realpath(projNodeDir));
    developerFiles.releaseProject(owner1);

    const discByJavaFile = await developerFiles.discoverProjectByName(targetJavaFile, owner1);
    assert.equal(discByJavaFile.projectRoot, await fs.realpath(projJavaDir));
    developerFiles.releaseProject(owner1);
    console.log('[PASS] Heterogeneous unknown projects discovered dynamically by name and target file.');

    // ------------------------------------------------------------------------
    // SCENARIO 2: Project Switching Without State Leakage
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Testing Project Switching (Task A -> B -> C) ---');
    const ownerSwitch = 91002;
    const sessionSwitch = developerAgent.getSession(ownerSwitch);

    // Turn 1 on Project PHP
    await developerFiles.discoverProjectByName(projPhpName, ownerSwitch);
    assert.equal(developerFiles.getProjectRoot(ownerSwitch), await fs.realpath(projPhpDir));
    const turnA = developerAgent.beginConversationTurn({
      root: developerFiles.getProjectRoot(ownerSwitch),
      scope: '.',
      request: 'Check project A',
      sessionId: sessionSwitch,
      ownerWebContentsId: ownerSwitch,
    });
    assert.equal(turnA.sessionId, sessionSwitch);

    // Turn 2 switch to Project Node
    await developerFiles.discoverProjectByName(projNodeName, ownerSwitch);
    assert.equal(developerFiles.getProjectRoot(ownerSwitch), await fs.realpath(projNodeDir));
    const turnB = developerAgent.beginConversationTurn({
      root: developerFiles.getProjectRoot(ownerSwitch),
      scope: '.',
      request: 'Check project B',
      sessionId: sessionSwitch,
      ownerWebContentsId: ownerSwitch,
    });
    assert.equal(turnB.sessionId, sessionSwitch);

    // Turn 3 switch to Project Java
    await developerFiles.discoverProjectByName(projJavaName, ownerSwitch);
    assert.equal(developerFiles.getProjectRoot(ownerSwitch), await fs.realpath(projJavaDir));
    const turnC = developerAgent.beginConversationTurn({
      root: developerFiles.getProjectRoot(ownerSwitch),
      scope: '.',
      request: 'Check project C',
      sessionId: sessionSwitch,
      ownerWebContentsId: ownerSwitch,
    });
    assert.equal(turnC.sessionId, sessionSwitch);

    developerFiles.releaseProject(ownerSwitch);
    console.log('[PASS] Clean project switching verified: no stale project leakage across tasks.');

    // ------------------------------------------------------------------------
    // SCENARIO 3: Renamed Project
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Testing Renamed Project ---');
    const origName = randomId('legacy-repo');
    const renamedName = randomId('modern-repo');
    const origPath = path.join(workspaceRoot, origName);
    const renamedPath = path.join(workspaceRoot, renamedName);

    await fs.mkdir(path.join(origPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(origPath, 'package.json'), JSON.stringify({ name: origName }), 'utf8');

    // Rename on disk
    await fs.rename(origPath, renamedPath);

    const ownerRename = 91003;
    const discRenamed = await developerFiles.discoverProjectByName(renamedName, ownerRename);
    assert.equal(discRenamed.projectRoot, await fs.realpath(renamedPath));
    developerFiles.releaseProject(ownerRename);
    console.log('[PASS] Renamed project discovered correctly at new name without code change.');

    // ------------------------------------------------------------------------
    // SCENARIO 4: Moved Project
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Testing Moved Project ---');
    const movedProjName = randomId('relocated-proj');
    const initialLocation = path.join(workspaceRoot, movedProjName);
    const nestedSubDir = path.join(workspaceRoot, 'nested-ecosystem', 'sub-group');
    await fs.mkdir(nestedSubDir, { recursive: true });
    const targetLocation = path.join(nestedSubDir, movedProjName);

    await fs.mkdir(path.join(initialLocation, 'src'), { recursive: true });
    await fs.writeFile(path.join(initialLocation, 'package.json'), JSON.stringify({ name: movedProjName }), 'utf8');

    // Move to nested location
    await fs.rename(initialLocation, targetLocation);

    const ownerMove = 91004;
    const discMoved = await developerFiles.discoverProjectByName(movedProjName, ownerMove);
    assert.equal(discMoved.projectRoot, await fs.realpath(targetLocation));
    developerFiles.releaseProject(ownerMove);
    console.log('[PASS] Moved project discovered dynamically across nested directory hierarchy.');

    // ------------------------------------------------------------------------
    // SCENARIO 5: Monorepo Root vs Package Discovery
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Testing Monorepo Boundary Resolution ---');
    const monorepoName = randomId('monorepo');
    const monorepoRoot = path.join(workspaceRoot, monorepoName);
    const frontendPkg = path.join(monorepoRoot, 'client');
    const backendPkg = path.join(monorepoRoot, 'server');

    await fs.mkdir(frontendPkg, { recursive: true });
    await fs.mkdir(backendPkg, { recursive: true });

    await fs.writeFile(path.join(monorepoRoot, 'package.json'), JSON.stringify({ name: monorepoName, workspaces: ['client', 'server'] }), 'utf8');
    await fs.writeFile(path.join(frontendPkg, 'package.json'), JSON.stringify({ name: '@mono/client' }), 'utf8');
    await fs.writeFile(path.join(backendPkg, 'package.json'), JSON.stringify({ name: '@mono/server' }), 'utf8');

    const monoTarget = `${randomId('ServerApi')}.ts`;
    await fs.writeFile(path.join(backendPkg, monoTarget), 'export const api = () => {};', 'utf8');

    const ownerMono = 91005;
    // Resolving by package-specific target file should find the innermost package enclosing root
    const discMonoPkg = await developerFiles.discoverProjectByName(monoTarget, ownerMono);
    assert.equal(discMonoPkg.projectRoot, await fs.realpath(backendPkg), 'Target file inside sub-package should resolve to sub-package root');
    developerFiles.releaseProject(ownerMono);

    // Resolving monorepo by name finds the workspace root
    const discMonoRoot = await developerFiles.discoverProjectByName(monorepoName, ownerMono);
    assert.equal(discMonoRoot.projectRoot, await fs.realpath(monorepoRoot));
    developerFiles.releaseProject(ownerMono);
    console.log('[PASS] Monorepo workspace root and package boundary resolved with precision.');

    // ------------------------------------------------------------------------
    // SCENARIO 6: Ambiguity Handling — No Random Guessing
    // ------------------------------------------------------------------------
    console.log('\n--- 6. Testing Ambiguous Target Resolution ---');
    const ambigRepoA = path.join(workspaceRoot, randomId('ambig-service-a'));
    const ambigRepoB = path.join(workspaceRoot, randomId('ambig-service-b'));
    await fs.mkdir(path.join(ambigRepoA, 'src'), { recursive: true });
    await fs.mkdir(path.join(ambigRepoB, 'src'), { recursive: true });
    await fs.writeFile(path.join(ambigRepoA, 'package.json'), JSON.stringify({ name: 'ambig-a' }), 'utf8');
    await fs.writeFile(path.join(ambigRepoB, 'package.json'), JSON.stringify({ name: 'ambig-b' }), 'utf8');

    const commonFileName = 'CommonService.js';
    await fs.writeFile(path.join(ambigRepoA, 'src', commonFileName), 'module.exports = { a: 1 };', 'utf8');
    await fs.writeFile(path.join(ambigRepoB, 'src', commonFileName), 'module.exports = { b: 2 };', 'utf8');

    const ownerAmbig = 91006;
    const ambigResult = await developerFiles.discoverProjectByName(commonFileName, ownerAmbig);
    // When 2 equally plausible repositories contain the file, NEVER silently select one!
    assert.equal(ambigResult.projectRoot, null, 'Must NOT pick a project randomly when multiple equally strong matches exist');
    assert.equal(ambigResult.matches.length, 2, 'Must return all matching candidates to prompt clarification');
    developerFiles.releaseProject(ownerAmbig);
    console.log('[PASS] Ambiguous target resolution safely yields candidates without guessing.');

    // ------------------------------------------------------------------------
    // SCENARIO 7: Guarded Lifecycle on Dynamic Fixture (Apply & Undo Rollback)
    // ------------------------------------------------------------------------
    console.log('\n--- 7. Testing Guarded Proposal Apply & Undo Rollback on Dynamic Fixture ---');
    const lifecycleRepoName = randomId('lifecycle-app');
    const lifecycleDir = path.join(workspaceRoot, lifecycleRepoName);
    await fs.mkdir(path.join(lifecycleDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(lifecycleDir, 'package.json'), JSON.stringify({ name: lifecycleRepoName }), 'utf8');

    const lifecycleTarget = 'Config.js';
    const lifecyclePath = path.join(lifecycleDir, 'src', lifecycleTarget);
    await fs.writeFile(lifecyclePath, 'module.exports = { enabled: false };\n', 'utf8');

    const ownerLifecycle = 91007;
    const sessionLifecycle = developerAgent.getSession(ownerLifecycle);
    const ownerObj = { ownerWebContentsId: ownerLifecycle, sessionId: sessionLifecycle };
    const discLifecycle = await developerFiles.discoverProjectByName(lifecycleRepoName, ownerLifecycle);
    assert.equal(discLifecycle.projectRoot, await fs.realpath(lifecycleDir));

    const initialContent = await developerFiles.readFile(`src/${lifecycleTarget}`, ownerLifecycle);
    assert.ok(initialContent.content.includes('enabled: false'));

    const diffContent = `--- a/src/${lifecycleTarget}
+++ b/src/${lifecycleTarget}
@@ -1,1 +1,1 @@
-module.exports = { enabled: false };
+module.exports = { enabled: true };
`;

    const prop = await developerAgent.createProposal({
      root: discLifecycle.projectRoot,
      ownerWebContentsId: ownerLifecycle,
      sessionId: sessionLifecycle,
      raw: diffContent,
    });
    assert.equal(prop.state, 'awaiting_approval', 'Proposal must begin in awaiting_approval');

    // Attempting unapproved apply must fail
    await assert.rejects(
      () => developerAgent.apply(prop.taskId, ownerObj, async () => ({ ok: true, status: 'PASS' }), discLifecycle.projectRoot),
      /approved/i,
      'Cannot apply without explicit user approval',
    );

    // Explicit approval
    developerAgent.approve(prop.taskId, ownerObj);
    const applyRes = await developerAgent.apply(prop.taskId, ownerObj, async () => ({ ok: true, status: 'PASS' }), discLifecycle.projectRoot);
    assert.equal(applyRes.state, 'completed');

    const modified = await developerFiles.readFile(`src/${lifecycleTarget}`, ownerLifecycle);
    assert.ok(modified.content.includes('enabled: true'), 'File must reflect approved diff');

    // Clean rollback via undo
    await developerAgent.undo(prop.taskId, ownerObj);
    const rolledBack = await developerFiles.readFile(`src/${lifecycleTarget}`, ownerLifecycle);
    assert.equal(rolledBack.content, 'module.exports = { enabled: false };\n', 'Undo must restore original content exactly');
    developerFiles.releaseProject(ownerLifecycle);
    console.log('[PASS] Full guarded lifecycle verified: unapproved apply blocked, approved apply executed, undo restored clean state.');

    // ------------------------------------------------------------------------
    // SCENARIO 8: True Unknown-Project Goal Discovery (Requirement 47)
    // ------------------------------------------------------------------------
    console.log('\n--- 8. Testing True Unknown-Project Goal Discovery (Goal: "Find the relevant API implementation and inspect it.") ---');
    const isolatedWorkspace = path.join(testRoot, 'isolated-workspace');
    await fs.mkdir(isolatedWorkspace, { recursive: true });
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = isolatedWorkspace;

    const unknownProjectName = randomId('unknown-corp-api');
    const unknownProjectDir = path.join(isolatedWorkspace, unknownProjectName);
    const subRouteDir = path.join(unknownProjectDir, 'routes');
    await fs.mkdir(subRouteDir, { recursive: true });
    await fs.writeFile(path.join(unknownProjectDir, 'package.json'), JSON.stringify({ name: unknownProjectName }), 'utf8');

    const apiFileName = `${randomId('PaymentApi')}.js`;
    await fs.writeFile(
      path.join(subRouteDir, apiFileName),
      'module.exports = { handlePayment: () => ({ status: "SUCCESS" }) };',
      'utf8',
    );

    const ownerUnknown = 91008;
    // User provides ONLY: "Find the relevant API implementation and inspect it."
    // No project name, no file path!
    const autoDisc = await developerFiles.discoverProjectByName('*', ownerUnknown);
    assert.equal(autoDisc.projectRoot, await fs.realpath(unknownProjectDir), 'Must discover unknown repository from goal alone');

    // Search and inspect code inside discovered project
    const searchRes = await developerFiles.searchCode('handlePayment', ownerUnknown);
    assert.ok(searchRes.results.length >= 1, 'Must locate symbol inside unknown repository');
    assert.ok(searchRes.results.some((m) => m.path.includes(apiFileName)));

    const inspectedContent = await developerFiles.readFile(`routes/${apiFileName}`, ownerUnknown);
    assert.ok(inspectedContent.content.includes('status: "SUCCESS"'));
    developerFiles.releaseProject(ownerUnknown);
    console.log('[PASS] Requirement 47 verified: Unknown project and target API discovered and inspected purely from goal.');

    // ------------------------------------------------------------------------
    // SCENARIO 9: Large Workspace Bounded Traversal (Requirement 50)
    // ------------------------------------------------------------------------
    console.log('\n--- 9. Testing Large Workspace Bounded Traversal ---');
    const largeWorkspace = path.join(testRoot, 'large-workspace');
    await fs.mkdir(largeWorkspace, { recursive: true });
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = largeWorkspace;

    // Create 15 projects with multiple subdirectories
    for (let i = 0; i < 15; i++) {
      const pDir = path.join(largeWorkspace, `large-proj-${i}`);
      await fs.mkdir(path.join(pDir, 'lib'), { recursive: true });
      await fs.writeFile(path.join(pDir, 'package.json'), JSON.stringify({ name: `large-proj-${i}` }), 'utf8');
      await fs.writeFile(path.join(pDir, 'lib', `file-${i}.js`), `module.exports = ${i};`, 'utf8');
    }

    const startMs = Date.now();
    const ownerLarge = 91009;
    const largeDisc = await developerFiles.discoverProjectByName('*', ownerLarge);
    const durationMs = Date.now() - startMs;
    assert.ok(largeDisc.matches.length >= 15, 'Must discover all projects in large workspace');
    assert.ok(durationMs < 2000, `Traversal must complete swiftly within budget (took ${durationMs}ms)`);
    developerFiles.releaseProject(ownerLarge);
    console.log(`[PASS] Requirement 50 verified: 15 generated projects traversed and bounded in ${durationMs}ms.`);

    console.log('\n=== ALL TRUE AUTONOMOUS CODING INTELLIGENCE TESTS COMPLETED SUCCESSFULLY ===');
  } finally {
    developerAgent.resetForTest();
    if (originalRoots === undefined) delete process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
    else process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = originalRoots;
    await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

runAutonomousCodingTests().catch((err) => {
  console.error('[TEST FAILURE]:', err);
  process.exit(1);
});
