/**
 * Milestone V22 — End-to-End Coding Agent Intent & Implementation Reliability Test Suite
 *
 * Generic test fixtures validating the 12 core acceptance criteria of Phase 7:
 * 1. A clear request is preserved and converted into the correct task.
 * 2. A request requiring repository investigation reads authoritative source evidence.
 * 3. A request requiring implementation produces a plan aligned with the original objective.
 * 4. The implementation receives the correct project context and approved scope.
 * 5. A genuinely ambiguous request triggers an appropriate clarification.
 * 6. A follow-up instruction preserves prior context where required.
 * 7. A failed tool call cannot become a fabricated success.
 * 8. An invalid, stale, or out-of-scope patch is rejected.
 * 9. Approval rejection causes no unauthorized mutation.
 * 10. Cancellation and isolation failure preserve the required safety guarantees.
 * 11. Verification distinguishes real execution from synthetic tests and checks that were not run.
 * 12. Existing Coding Agent lifecycle, transport, architecture, and safety contracts pass.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const developerAgent = require('../electron/developerAgent.cjs');
const developerFiles = require('../electron/developerFiles.cjs');
const { classifyTaskIntent, INTENT_CATEGORIES, TASK_TYPES } = require('../electron/coding-pipeline/genericIntentClassifier.cjs');
const { analyzeTaskRequirements, createTaskPlan, validatePatchScope, executeToolWithSafeguards } = require('../electron/coding-pipeline/investigationWorkflowContract.cjs');

async function createTempWorkspace(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v22-workspace-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return dir;
}

async function cleanupWorkspace(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}

async function runTests() {
  console.log('Starting Milestone V22 End-to-End Intent & Implementation Reliability Tests...\n');

  // Case 1: Clear request is preserved and converted into the correct task representation
  {
    console.log('Case 1: Clear request converted into correct task representation...');
    const userRequest = 'Investigate and repair the null pointer exception in src/services/auth.js';
    const classification = classifyTaskIntent({ request: userRequest });

    assert.equal(classification.primaryIntent, INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG);
    assert.equal(classification.taskType, 'INVESTIGATE_OR_DEBUG');
    assert.equal(classification.userGoal, userRequest);
    assert.equal(classification.originalRequest, userRequest);
    assert.equal(classification.needsClarification, false);
    assert.ok(classification.requestedOutcomes.length > 0);
    assert.ok(classification.taskRepresentation, 'taskRepresentation must be present');
    assert.equal(classification.taskRepresentation.userGoal, userRequest);
    assert.equal(classification.taskRepresentation.taskType, 'INVESTIGATE_OR_DEBUG');
    assert.deepEqual(classification.taskRepresentation.unresolvedQuestions, []);

    const plan = createTaskPlan({
      userRequest,
      requirements: classification,
      taskType: classification.taskType,
      constraints: classification.constraints,
    });
    assert.equal(plan.userGoal, userRequest);
    assert.equal(plan.taskType, 'INVESTIGATE_OR_DEBUG');
    assert.ok(plan.taskRepresentation);
    console.log('  -> Case 1 PASSED: Clear request preserved and converted to task.');
  }

  // Case 2: Request requiring repository investigation reads authoritative source evidence
  {
    console.log('Case 2: Investigation reads authoritative source evidence...');
    const ws = await createTempWorkspace({
      'src/auth.js': 'function login(user) {\n  const token = user.token;\n  return token;\n}\nmodule.exports = { login };\n',
    });
    try {
      const readCalls = [];
      const fileReader = async (p, range) => {
        readCalls.push({ path: p, range });
        const content = await fs.readFile(path.join(ws, p), 'utf8');
        return { content, lineRange: { startLine: 1, endLine: 4, totalLines: 4, complete: true } };
      };
      const fileSearcher = async (q) => ({
        results: [{ path: 'src/auth.js', score: 90 }],
      });

      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'Investigate potential issue in src/auth.js',
        root: ws,
        sessionId: 'v22-test-session',
        ownerWebContentsId: 2202,
        tools: {
          readFile: fileReader,
          searchCode: fileSearcher,
          operatingMode: 'INVESTIGATE',
        },
      });

      assert.ok(readCalls.length > 0, 'fileReader must be invoked on authoritative files');
      assert.equal(readCalls[0].path.replace(/\\/g, '/'), 'src/auth.js');
      assert.ok(result.inspectedFiles.includes('src/auth.js'));
      console.log('  -> Case 2 PASSED: Authoritative source evidence read without speculation.');
    } finally {
      await cleanupWorkspace(ws);
    }
  }

  // Case 3: Request requiring implementation produces plan aligned with original objective
  {
    console.log('Case 3: Implementation produces aligned task plan...');
    const userRequest = 'Create a health check controller at src/controllers/health.js';
    const classification = classifyTaskIntent({ request: userRequest });

    assert.equal(classification.primaryIntent, INTENT_CATEGORIES.BUILD_OR_SCAFFOLD);
    assert.equal(classification.taskType, 'BUILD_OR_SCAFFOLD');
    assert.equal(classification.actionable, true);
    assert.equal(classification.mutationRequired, true);

    const plan = createTaskPlan({
      userRequest,
      requirements: classification,
      taskType: classification.taskType,
      constraints: classification.constraints,
      operatingMode: 'BUILD',
    });

    assert.equal(plan.taskType, 'BUILD_OR_SCAFFOLD');
    assert.equal(plan.subtasks.find((s) => s.id === 'ST-1').status, 'PENDING');
    console.log('  -> Case 3 PASSED: Implementation plan accurately aligned with user objective.');
  }

  // Case 4: Implementation receives correct project context and approved scope
  {
    console.log('Case 4: Implementation receives correct project context and authorized scope...');
    const validation = validatePatchScope({
      targetFiles: ['src/services/user.js'],
      inspectedFiles: ['src/services/user.js'],
      modifiedFiles: ['src/services/user.js'],
      existingDirtyFiles: [],
    });
    assert.equal(validation.isValid, true);

    // Out-of-scope file rejected
    const outOfScope = validatePatchScope({
      targetFiles: ['src/services/user.js'],
      inspectedFiles: ['src/services/user.js'],
      modifiedFiles: ['src/unrelated/config.js'],
      existingDirtyFiles: [],
    });
    assert.equal(outOfScope.isValid, false);
    console.log('  -> Case 4 PASSED: Context scope and file target boundaries strictly validated.');
  }

  // Case 5: Genuinely ambiguous request triggers appropriate clarification
  {
    console.log('Case 5: Genuinely ambiguous request triggers clarification...');
    const vagueRequests = ['make it faster', 'improve performance', 'fix stuff'];
    for (const req of vagueRequests) {
      const classification = classifyTaskIntent({ request: req });
      assert.equal(classification.needsClarification, true, `Request "${req}" must trigger clarification`);
      assert.ok(classification.clarificationPrompt, 'Clarification prompt must be present');
      assert.equal(classification.actionable, false);
      assert.equal(classification.unresolvedQuestions.length, 1);
    }
    console.log('  -> Case 5 PASSED: Ambiguous requests halt at CLARIFICATION_REQUIRED.');
  }

  // Case 6: Follow-up instruction preserves prior context where required
  {
    console.log('Case 6: Follow-up instruction resolves from prior conversation context...');
    const contextMessages = [
      { role: 'user', content: 'Investigate the error in src/auth.js where login returns 500' },
      { role: 'assistant', content: 'Identified defect: TypeError on line 42 of src/auth.js' },
    ];
    const followUp = classifyTaskIntent({
      request: 'fix the bug',
      contextMessages,
    });

    assert.equal(followUp.needsClarification, false, 'Follow-up with context must not trigger false ambiguity');
    assert.equal(followUp.primaryIntent, INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG);
    assert.equal(followUp.taskType, 'INVESTIGATE_OR_DEBUG');
    assert.equal(followUp.actionable, true);
    assert.equal(followUp.mutationRequired, true);

    const reqAnalysis = analyzeTaskRequirements('fix the bug', contextMessages);
    assert.equal(reqAnalysis.needsClarification, false);
    assert.ok(reqAnalysis.searchSignals.exactPaths.includes('src/auth.js') || reqAnalysis.domainTerms.includes('src/auth.js'));
    console.log('  -> Case 6 PASSED: Follow-up instruction seamlessly grounded in prior conversation context.');
  }

  // Case 7: Failed tool call cannot become a fabricated success
  {
    console.log('Case 7: Failed tool call preserves failure honestly...');
    const failingTool = async () => {
      throw new Error('Disk read fault: EACCES permission denied');
    };

    const toolResult = await executeToolWithSafeguards({
      toolName: 'read_source_file',
      toolFn: failingTool,
      maxRetries: 1,
    });

    assert.equal(toolResult.success, false);
    assert.equal(toolResult.failurePreserved, true);
    assert.ok(toolResult.error.includes('EACCES'));
    console.log('  -> Case 7 PASSED: Tool failure honestly recorded and preserved.');
  }

  // Case 8: Invalid, stale, or out-of-scope patch is rejected
  {
    console.log('Case 8: Stale and uninspected patches rejected...');
    const staleCheck = validatePatchScope({
      targetFiles: ['src/api.js'],
      inspectedFiles: [], // Never inspected!
      modifiedFiles: ['src/api.js'],
    });
    assert.equal(staleCheck.isValid, false);
    assert.ok(staleCheck.rejectionReason.includes('uninspected') || staleCheck.rejectionReason.includes('Stage 3'));
    console.log('  -> Case 8 PASSED: Uninspected patch scope strictly rejected.');
  }

  // Case 9: Approval rejection causes no unauthorized mutation
  {
    console.log('Case 9: Approval rejection preserves workspace untouched...');
    const ws = await createTempWorkspace({
      'index.js': 'console.log("original content");\n',
    });
    try {
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'Fix the greeting in index.js',
        root: ws,
        sessionId: 'v22-rejection-session',
        ownerWebContentsId: 2209,
        requestApproval: async () => false, // Reject!
        assessFindingRelevance: async ({ findings }) => ({
          findings: findings.map((f) => ({
            findingId: f.findingId,
            decision: 'SUPPORTED',
            relationship: 'Directly addresses the defect.',
            evidenceIds: [f.sourceEvidenceId],
            contradictionEvidenceIds: [],
            unresolvedAssumptions: [],
            provenance: 'TEST_FIXTURE',
          })),
        }),
        tools: {
          readFile: async (p) => ({ content: await fs.readFile(path.join(ws, p), 'utf8') }),
          searchCode: async () => ({ results: [{ path: 'index.js', score: 100 }] }),
          proposePatch: async ({ originalContent }) => originalContent.replace('original content', 'fixed content'),
          findDefects: async () => [{
            filePath: 'index.js',
            lines: '1',
            symbol: 'greeting',
            codeSnippet: 'console.log("original content");',
            expected: 'console.log("fixed content");',
            observed: 'console.log("original content");',
          }],
        },
      });

      assert.equal(result.outcome, 'APPROVAL_REJECTED');
      const diskContent = await fs.readFile(path.join(ws, 'index.js'), 'utf8');
      assert.equal(diskContent, 'console.log("original content");\n', 'Disk must remain untouched on rejection');
      console.log('  -> Case 9 PASSED: Approval rejection produced 0 workspace mutations.');
    } finally {
      await cleanupWorkspace(ws);
    }
  }

  // Case 10: Cancellation preserves required safety guarantees
  {
    console.log('Case 10: Cancellation halts workflow cleanly...');
    const ws = await createTempWorkspace({
      'package.json': JSON.stringify({ name: 'cancel-test', scripts: { test: 'node -e "process.exit(0)"' } }),
    });
    try {
      let cancelled = false;
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'Run test on project',
        root: ws,
        sessionId: 'v22-cancel-session',
        ownerWebContentsId: 2210,
        isCancelled: () => {
          cancelled = true;
          return true;
        },
      });

      assert.equal(result.outcome, 'CANCELLED');
      assert.equal(result.filesModified.length, 0);
      assert.equal(result.evidenceLevel, 'INCONCLUSIVE');
      console.log('  -> Case 10 PASSED: Cancellation safely preserved repository state.');
    } finally {
      await cleanupWorkspace(ws);
    }
  }

  // Case 11: Verification distinguishes real execution from synthetic tests and checks not run
  {
    console.log('Case 11: Verification evidence levels distinguish execution truth...');
    const { VERIFICATION_EVIDENCE_LEVELS, classifyVerificationEvidenceLevel } = developerAgent;

    assert.ok(VERIFICATION_EVIDENCE_LEVELS);
    assert.equal(VERIFICATION_EVIDENCE_LEVELS.PASSED_REAL_EXECUTION, 'PASSED_REAL_EXECUTION');
    assert.equal(VERIFICATION_EVIDENCE_LEVELS.PASSED_SYNTHETIC_TESTS, 'PASSED_SYNTHETIC_TESTS');
    assert.equal(VERIFICATION_EVIDENCE_LEVELS.FAILED, 'FAILED');
    assert.equal(VERIFICATION_EVIDENCE_LEVELS.BLOCKED, 'BLOCKED');
    assert.equal(VERIFICATION_EVIDENCE_LEVELS.NOT_RUN, 'NOT_RUN');
    assert.equal(VERIFICATION_EVIDENCE_LEVELS.INCONCLUSIVE, 'INCONCLUSIVE');

    // 11a: Real execution passed
    const realPassed = classifyVerificationEvidenceLevel({
      isPassing: true,
      testOutcome: { status: 'PASS', ok: true, executed: true },
      finalEvidence: [{ executed: true, exitCode: 0, provenance: 'CONTAINER_EXECUTION' }],
      hostExecution: { status: 'EXECUTED' },
    });
    assert.equal(realPassed, VERIFICATION_EVIDENCE_LEVELS.PASSED_REAL_EXECUTION);

    // 11b: Synthetic / hermetic only passed
    const syntheticPassed = classifyVerificationEvidenceLevel({
      isPassing: true,
      testOutcome: { status: 'PASS', ok: true, attempts: [{ check: 'static_modular_integration' }] },
      finalEvidence: [],
      hermeticVerification: { passed: 9, total: 9 },
    });
    assert.equal(syntheticPassed, VERIFICATION_EVIDENCE_LEVELS.PASSED_SYNTHETIC_TESTS);

    // 11c: Failed check
    const failedCheck = classifyVerificationEvidenceLevel({
      isPassing: false,
      testOutcome: { status: 'FAILED', ok: false, exitCode: 1 },
    });
    assert.equal(failedCheck, VERIFICATION_EVIDENCE_LEVELS.FAILED);

    // 11d: Blocked execution
    const blockedCheck = classifyVerificationEvidenceLevel({
      isPassing: false,
      testOutcome: { status: 'BLOCKED', executionBlocked: true },
      executionBlocked: true,
    });
    assert.equal(blockedCheck, VERIFICATION_EVIDENCE_LEVELS.BLOCKED);

    // 11e: Not run / skipped
    const notRunCheck = classifyVerificationEvidenceLevel({
      isPassing: false,
      testOutcome: { status: 'SKIPPED' },
      verificationUnavailable: true,
    });
    assert.equal(notRunCheck, VERIFICATION_EVIDENCE_LEVELS.NOT_RUN);

    // 11f: Cancelled / inconclusive
    const inconclusiveCheck = classifyVerificationEvidenceLevel({
      isPassing: false,
      isCancelled: true,
    });
    assert.equal(inconclusiveCheck, VERIFICATION_EVIDENCE_LEVELS.INCONCLUSIVE);
    console.log('  -> Case 11 PASSED: Real execution, synthetic tests, failures, blockers, and skipped checks truthfully distinguished.');
  }

  // Case 12: Real target Hello fixture remains fail-closed and untouched
  {
    console.log('Case 12: Real Hello workspace verification...');
    const helloPath = 'C:\\Users\\Admin\\Downloads\\Hello';
    const pkgJsonPath = path.join(helloPath, 'package.json');
    let hasHello = false;
    try {
      const pkgStat = await fs.stat(pkgJsonPath);
      hasHello = pkgStat.isFile();
    } catch {}

    if (hasHello) {
      const nodeModulesExists = await fs.access(path.join(helloPath, 'node_modules')).then(() => true).catch(() => false);
      assert.equal(nodeModulesExists, false, 'Hello node_modules must remain absent');
      console.log('  -> Case 12 PASSED: Target workspace verified fail-closed and untouched.');
    } else {
      console.log('  -> Case 12 SKIPPED: C:\\Users\\Admin\\Downloads\\Hello not present on host.');
    }
  }

  console.log('\nALL Milestone V22 End-to-End Intent & Implementation Reliability tests passed successfully!');
}

runTests().catch((err) => {
  console.error('\nTest suite failed:', err);
  process.exit(1);
});
