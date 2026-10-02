import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import developerFiles from '../electron/developerFiles.cjs';
import developerAgent from '../electron/developerAgent.cjs';

async function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, shell: true, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

async function main() {
  console.log('=== IQ1000+ CODING AGENT COMPREHENSIVE ACCEPTANCE TEST SUITE ===');

  const testTempDir = await fs.mkdtemp(path.join(process.cwd(), '.coding-iq1000-'));
  const originalRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  developerAgent.resetForTest();

  try {
    // ------------------------------------------------------------------------
    // TEST SUITE 1: Python Intelligence Engine Unit Verifications
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Testing Python Intent Classifier, Planner, and Session Store ---');
    const pythonScript = `
import sys
sys.path.insert(0, 'server/src')
from coding_websocket import TaskIntent, classify_task_intent, generate_task_plan, CODING_TASK_STORE

# 1.1 Intent Classification Matrix
cases = [
    ("Login API kabhi kabhi 500 de rahi hai, check karo", TaskIntent.BUG_INVESTIGATION, False),
    ("Kaunsa query slow hai check karo", TaskIntent.PERFORMANCE_INVESTIGATION, False),
    ("AdmOuPrgList.php ke getProgrammes() method mein jo duplicate-query issue hai uska fix proposal banao", TaskIntent.PROPOSAL_GENERATION, True),
    ("Fix karo aur relevant tests chalao", TaskIntent.DIRECT_FIX, True),
    ("Yeh method kaise kaam karta hai samjhao", TaskIntent.EXPLANATION, False),
    ("Code review karo aur clean up suggest karo", TaskIntent.CODE_REVIEW, False),
    ("Security vulnerability check karo", TaskIntent.SECURITY_AUDIT, False),
    ("Tests fail ho rahe hain check karo", TaskIntent.TEST_FAILURE, False),
]

for req, expected_intent, expected_prop in cases:
    res = classify_task_intent(req)
    assert res["intent"] == expected_intent, f"Expected {expected_intent} for '{req}', got {res['intent']}"
    assert res["proposal_required"] == expected_prop, f"Expected proposal_required={expected_prop} for '{req}', got {res['proposal_required']}"

# 1.2 Target extraction
res_target = classify_task_intent("AdmOuPrgList.php ke getProgrammes() method ko check karo")
assert "AdmOuPrgList.php" in res_target["target_files"], "Should extract target file AdmOuPrgList.php"
assert "getProgrammes" in res_target["target_symbols"], "Should extract target symbol getProgrammes"

# 1.3 Adaptive Task Plan Generation
plan_perf = generate_task_plan(classify_task_intent("Kaunsa query slow hai"), "Kaunsa query slow hai")
assert plan_perf["intent"] == TaskIntent.PERFORMANCE_INVESTIGATION
assert any("Duplicate or repeated" in h for h in plan_perf["hypotheses"]), "Plan must include tailored performance hypotheses"
assert "Observed queries" in plan_perf["required_evidence"]

# 1.4 Persistent Task Memory & Session Continuity
session_id = "test-session-100"
session = CODING_TASK_STORE.get_or_create(session_id, project_root="/repo", scope="models")
CODING_TASK_STORE.record_tool_call(session_id, "read_file", {"relativePath": "models/AdmOuPrgList.php"}, "Code Investigator")
CODING_TASK_STORE.record_tool_call(session_id, "search_symbols", {"query": "getProgrammes"}, "Dependency Tracer")
CODING_TASK_STORE.record_evidence(session_id, "read_file", "models/AdmOuPrgList.php", "Line 99 uses ->where() wiping admission_session scope")
CODING_TASK_STORE.record_finding(session_id, "Scope override wipes session filter and causes duplicate queries")
CODING_TASK_STORE.reject_hypothesis(session_id, "Missing database index", "Columns uni_id and prg_id are indexed in schema")

context = CODING_TASK_STORE.get_continuation_context(session_id)
assert "models/AdmOuPrgList.php" in context, "Context must preserve target files"
assert "getProgrammes" in context, "Context must preserve target symbols"
assert "Scope override wipes session filter" in context, "Context must preserve findings"
assert "Missing database index" in context, "Context must preserve rejected hypotheses"

print("PYTHON_INTELLIGENCE_OK")
`;
    const pyTestFile = path.join(testTempDir, 'py_test.py');
    await fs.writeFile(pyTestFile, pythonScript, 'utf8');
    const pyResult = await runCommand('python', [pyTestFile], process.cwd());
    assert.equal(pyResult.code, 0, `Python test failed: ${pyResult.stderr}\n${pyResult.stdout}`);
    assert.ok(pyResult.stdout.includes('PYTHON_INTELLIGENCE_OK'), `Expected PYTHON_INTELLIGENCE_OK in stdout:\n${pyResult.stdout}\nSTDERR:\n${pyResult.stderr}`);
    console.log('[PASS] Python Intent Classifier, Planner, and Session Store passed all assertions.');

    // ------------------------------------------------------------------------
    // TEST SUITE 2: Project Candidate Ranking & Ambiguity Handling
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Testing Project Candidate Ranking & Ambiguity (electron/developerFiles.cjs) ---');
    const discoRoot = path.join(testTempDir, 'disco');
    const repoA = path.join(discoRoot, 'proj-service-alpha');
    const repoB = path.join(discoRoot, 'proj-service-beta');
    await fs.mkdir(path.join(repoA, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoB, 'models'), { recursive: true });
    await fs.writeFile(path.join(repoA, 'package.json'), JSON.stringify({ name: 'service-alpha' }), 'utf8');
    await fs.writeFile(path.join(repoB, 'composer.json'), JSON.stringify({ name: 'service-beta' }), 'utf8');
    await fs.writeFile(path.join(repoA, 'src', 'UserService.php'), '<?php class UserService {}', 'utf8');
    await fs.writeFile(path.join(repoB, 'models', 'UserService.php'), '<?php class UserService {}', 'utf8');

    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = discoRoot;

    // Direct ranking helper
    const ranked = await developerFiles.rankProjectCandidates([repoA, repoB], 'proj-service-alpha', [discoRoot]);
    assert.equal(ranked[0], repoA, 'Candidate matching target name must be ranked highest');

    // Ambiguous target discovery: UserService.php exists in both projects
    const ownerId = 91001;
    const ambigResult = await developerFiles.discoverProjectByName('UserService.php', ownerId);
    assert.equal(ambigResult.projectRoot, null, 'Ambiguous target present in multiple projects must NOT randomly select');
    assert.equal(ambigResult.matches.length, 2, 'Must return both matched project roots for user disambiguation');
    developerFiles.releaseProject(ownerId);
    console.log('[PASS] Ambiguous target resolution cleanly returns ranked candidate matches without guessing.');

    // ------------------------------------------------------------------------
    // TEST SUITE 3: Session Continuation Across Conversation Turns
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Testing Session Continuation Across Turns (developerAgent.cjs) ---');
    const sessionOwnerId = 91002;
    const turn1 = developerAgent.beginConversationTurn({
      root: repoA,
      request: 'UserService.php ko check karo aur batao kya issue hai',
      sessionId: developerAgent.getSession(sessionOwnerId),
      ownerWebContentsId: sessionOwnerId,
    });
    assert.ok(turn1.sessionId, 'beginConversationTurn must return sessionId');
    assert.equal(turn1.state, 'reading');

    developerAgent.advanceConversationTurn(turn1.turnId, 'understanding', {
      sessionId: turn1.sessionId,
      ownerWebContentsId: sessionOwnerId,
    }, { phase: 'understanding' });

    developerAgent.recordConversationFindings(turn1.turnId, [
      'UserService.php has missing authorization check in validate()',
    ], {
      sessionId: turn1.sessionId,
      ownerWebContentsId: sessionOwnerId,
    });

    const turnContext = developerAgent.getConversationTurn(turn1.turnId, {
      sessionId: turn1.sessionId,
      ownerWebContentsId: sessionOwnerId,
    });
    assert.equal(turnContext.findings.length, 1);
    assert.ok(turnContext.findings[0].includes('missing authorization'));
    console.log('[PASS] Turn findings recorded and persisted across conversation state.');

    // ------------------------------------------------------------------------
    // TEST SUITE 4: Guarded Proposal Lifecycle — Safe Apply & Rollback
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Testing Guarded Proposal Lifecycle on Test Fixture ---');
    const diff = `--- a/src/UserService.php
+++ b/src/UserService.php
@@ -1,1 +1,2 @@
 <?php class UserService {}
+/* validated fix */
`;
    const proposal = await developerAgent.createProposal({
      root: repoA,
      ownerWebContentsId: sessionOwnerId,
      sessionId: turn1.sessionId,
      raw: diff,
    });
    assert.equal(proposal.state, 'awaiting_approval', 'Proposal must start in awaiting_approval');

    // Attempting apply without approval must fail
    await assert.rejects(
      () => developerAgent.apply(proposal.taskId, { sessionId: turn1.sessionId, ownerWebContentsId: sessionOwnerId }, async () => ({ ok: true, status: 'PASS' }), repoA),
      /approved/i,
      'Must refuse silent apply without explicit user approval',
    );

    // Approve and apply
    developerAgent.approve(proposal.taskId, { sessionId: turn1.sessionId, ownerWebContentsId: sessionOwnerId });
    const applied = await developerAgent.apply(
      proposal.taskId,
      { sessionId: turn1.sessionId, ownerWebContentsId: sessionOwnerId },
      async () => ({ ok: true, status: 'PASS' }),
      repoA,
    );
    assert.equal(applied.state, 'completed');

    const updatedCode = await fs.readFile(path.join(repoA, 'src', 'UserService.php'), 'utf8');
    assert.ok(updatedCode.includes('/* validated fix */'));

    // Undo rollback
    await developerAgent.undo(proposal.taskId, { sessionId: turn1.sessionId, ownerWebContentsId: sessionOwnerId });
    const revertedCode = await fs.readFile(path.join(repoA, 'src', 'UserService.php'), 'utf8');
    assert.equal(revertedCode, '<?php class UserService {}');
    console.log('[PASS] Guarded approval contract and undo rollback verified.');

    // ------------------------------------------------------------------------
    // TEST SUITE 5: Zero Hard-Coding & Zero Cross-Agent Modification Audit
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Auditing Production Source for Zero Hardcoding & Boundary Isolation ---');
    const filesToAudit = [
      'server/src/coding_websocket.py',
      'server/src/coding_provider.py',
      'electron/developerFiles.cjs',
      'electron/developerAgent.cjs',
      'electron/developerIndex.cjs',
      'electron/developerContext.cjs',
      'src/features/coding/useCodingAgentController.ts',
      'src/features/coding/codingTransport.ts',
    ];

    const forbiddenStrings = [
      'candidate-portal-2026',
      'AdmOuPrgList.php',
      'C:\\xampp\\htdocs',
    ];

    for (const relFile of filesToAudit) {
      const fullPath = path.resolve(process.cwd(), relFile);
      const content = await fs.readFile(fullPath, 'utf8');
      for (const forbidden of forbiddenStrings) {
        assert.ok(
          !content.includes(forbidden),
          `Production file ${relFile} must NOT contain hardcoded string '${forbidden}'`,
        );
      }
    }
    console.log('[PASS] Zero hard-coding audit confirmed across all Coding Agent production files.');

    // Cross-agent git diff check
    const gitDiffResult = await runCommand('git', ['status', '--porcelain'], process.cwd());
    const modifiedLines = gitDiffResult.stdout.split(/\r?\n/).filter(Boolean);
    const forbiddenPaths = ['meeting', 'general', 'stt', 'provider_registry.py', 'src/features/meeting', 'src/features/general'];
    for (const line of modifiedLines) {
      const filePath = line.trim().slice(3);
      for (const forbidden of forbiddenPaths) {
        assert.ok(
          !filePath.toLowerCase().includes(forbidden.toLowerCase()),
          `Modification leaked to forbidden component: ${filePath}`,
        );
      }
    }
    console.log('[PASS] Cross-agent boundary audit confirmed: Meeting, General, STT, and Provider Registry completely untouched.');

    console.log('\n=== ALL IQ1000+ ACCEPTANCE TESTS PASSED SUCCESSFULLY ===');
  } finally {
    developerAgent.resetForTest();
    if (originalRoots === undefined) delete process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
    else process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = originalRoots;
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[E2E TEST FAILURE]:', err);
  process.exit(1);
});
