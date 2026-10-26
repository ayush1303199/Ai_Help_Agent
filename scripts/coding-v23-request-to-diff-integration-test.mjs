/**
 * Milestone V23 — Request-to-Validated-Diff Real Workflow Integration Test Suite
 *
 * Tests the complete flow:
 * USER REQUEST -> INTENT UNDERSTANDING -> TASK PLAN -> REPOSITORY INVESTIGATION -> VALIDATED DIFF GENERATION -> APPROVAL BOUNDARY
 *
 * Exercises actual production workflow components:
 * - electron/developerAgent.cjs
 * - electron/coding-pipeline/genericIntentClassifier.cjs
 * - electron/coding-pipeline/investigationWorkflowContract.cjs
 * - electron/coding-pipeline/codingDiffEngine.cjs
 *
 * Asserts observable state transitions, file reads, proposal contracts, diff validations, and safety boundaries.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const developerAgent = require('../electron/developerAgent.cjs');
const { classifyTaskIntent, INTENT_CATEGORIES } = require('../electron/coding-pipeline/genericIntentClassifier.cjs');
const {
  analyzeTaskRequirements,
  createTaskPlan,
  validatePatchScope,
  validateProposalContract,
  executeToolWithSafeguards,
} = require('../electron/coding-pipeline/investigationWorkflowContract.cjs');

async function createTempWorkspace(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v23-workflow-'));
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
  console.log('Starting Milestone V23 Request-to-Validated-Diff Integration Test Suite...\n');

  // STEP 4: Request-to-Validated-Diff Integrated Workflow Sequence (Points 1 - 12)
  {
    console.log('--- Step 4: Complete Request-to-Validated-Diff Sequence ---');
    const fixtureFiles = {
      'package.json': JSON.stringify({
        name: 'user-service',
        version: '1.0.0',
        scripts: { test: 'node test.js' },
      }, null, 2),
      'src/userService.js': `function getUserStatus(user) {
  if (!user) {
    return 'UNKNOWN';
  }
  // BUG: Direct property access throws TypeError when account is null
  return user.account.status;
}

module.exports = { getUserStatus };
`,
    };

    const ws = await createTempWorkspace(fixtureFiles);
    const originalContent = fixtureFiles['src/userService.js'];

    try {
      const readOperations = [];
      const userRequest = 'Investigate and fix TypeError in src/userService.js when account is null';

      // 1. Submit natural-language request & 2. Confirm original request is preserved
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest,
        root: ws,
        sessionId: 'v23-integration-session',
        ownerWebContentsId: 2301,
        // Two-phase approval: No auto-approval callback provided, must stop at APPROVAL_REQUIRED
        requestApproval: null,
        assessFindingRelevance: async ({ findings, objective }) => ({
          findings: findings.map((f) => ({
            findingId: f.findingId,
            decision: 'SUPPORTED',
            relationship: 'The missing account null check directly triggers the reported TypeError in getUserStatus.',
            evidenceIds: [f.sourceEvidenceId],
            contradictionEvidenceIds: [],
            unresolvedAssumptions: [],
            provenance: 'VERIFIED_CODE_EVIDENCE',
          })),
        }),
        tools: {
          readFile: async (p, range) => {
            readOperations.push({ path: p, range });
            const diskContent = await fs.readFile(path.join(ws, p), 'utf8');
            return {
              content: diskContent,
              lineRange: { startLine: 1, endLine: 10, totalLines: 10, complete: true },
            };
          },
          searchCode: async (q) => ({
            results: [{ path: 'src/userService.js', score: 100 }],
          }),
          proposePatch: async ({ originalContent }) => {
            // Generates targeted safe fix: user.account ? user.account.status : 'INACTIVE'
            return originalContent.replace(
              "  return user.account.status;",
              "  return user.account ? user.account.status : 'INACTIVE';"
            );
          },
          findDefects: async ({ filePath, content }) => [{
            filePath,
            lines: '6',
            symbol: 'getUserStatus',
            codeSnippet: 'return user.account.status;',
            controlFlow: 'Unchecked property access on nullable account object',
            expected: "return user.account ? user.account.status : 'INACTIVE';",
            observed: 'return user.account.status;',
            evidenceType: 'STATIC_INSPECTION_CONFIRMED',
          }],
        },
      });

      // Assertions matching Points 1 - 12:

      // Point 2: Original request preserved
      assert.equal(result.userGoal, userRequest);
      assert.equal(result.taskPlan.userGoal, userRequest);

      // Point 3: Intent classification identifies correct task type
      assert.equal(result.taskType, 'INVESTIGATE_OR_DEBUG');
      assert.equal(result.taskPlan.taskType, 'INVESTIGATE_OR_DEBUG');

      // Point 4: Task planning retains goal and acceptance criteria
      assert.ok(result.taskPlan.acceptanceCriteria.length > 0);
      assert.ok(result.taskRepresentation);
      assert.equal(result.taskRepresentation.userGoal, userRequest);
      assert.equal(result.taskRepresentation.taskType, 'INVESTIGATE_OR_DEBUG');

      // Point 5: Repository investigation reads relevant fixture source through existing mechanism
      assert.ok(readOperations.length > 0, 'fileReader must be invoked on authoritative files');
      assert.equal(readOperations[0].path.replace(/\\/g, '/'), 'src/userService.js');
      assert.ok(result.continuation.inspectedFiles.some((f) => f.path === 'src/userService.js' || f === 'src/userService.js'));

      // Point 6: Proposed modification supported by inspected source
      assert.ok(result.continuation.objectiveRelevantDefects.length > 0);
      const defect = result.continuation.objectiveRelevantDefects[0];
      assert.equal(defect.filePath, 'src/userService.js');
      assert.ok(defect.codeSnippet.includes('user.account.status'));

      // Point 7: Structured diff/proposal generated through production validation path
      assert.ok(result.continuation.rawPatch, 'A unified diff must be generated');
      const patch = result.continuation.rawPatch;

      // Point 8: Diff syntactically valid and strictly within authorized file scope
      assert.ok(patch.includes('--- a/src/userService.js'), 'Diff header must target authorized file');
      assert.ok(patch.includes('+++ b/src/userService.js'), 'Diff header must target authorized file');
      assert.ok(result.continuation.patchScope.targetFiles.includes('src/userService.js'));
      assert.equal(result.continuation.patchScope.targetFiles.length, 1);
      assert.equal(result.continuation.patchScope.isValid, true);

      // Point 9: Proposal contains intended change rather than generic instructions
      assert.ok(patch.includes("-  return user.account.status;"));
      assert.ok(patch.includes("+  return user.account ? user.account.status : 'INACTIVE';"));

      // Point 10: Proposal stops at approval boundary; 0 unauthorized mutations
      assert.equal(result.outcome, 'APPROVAL_REQUIRED');
      assert.equal(result.phase, 'APPROVE');
      assert.ok(result.continuationToken, 'Continuation token must be issued for resumption');
      const diskContentAfter = await fs.readFile(path.join(ws, 'src/userService.js'), 'utf8');
      assert.equal(diskContentAfter, originalContent, 'Workspace file must remain completely unmodified before approval');

      // Point 11: Workflow receipt captures accurate state without unsupported success claims
      assert.ok(result.workflowReceipt);
      assert.equal(result.workflowReceipt.outcome, 'APPROVAL_REQUIRED');
      assert.deepEqual(result.workflowReceipt.appliedDiffScope.modifiedFiles, []);
      assert.equal(result.workflowReceipt.worktreeIntegrity.unrelatedUntouched, true);

      // Point 12: Verification status accurately reflects that verification has NOT run yet
      assert.equal(result.evidenceLevel, 'NOT_RUN');

      console.log('  -> Step 4 PASSED: Complete Request-to-Validated-Diff sequence verified.');
    } finally {
      await cleanupWorkspace(ws);
    }
  }

  // STEP 5: Negative and Safety Validation Cases
  console.log('\n--- Step 5: Negative and Safety Cases ---');

  // 5a. Ambiguous request with no sufficient context
  {
    console.log('Case 5a: Ambiguous request with no context...');
    const result = classifyTaskIntent({ request: 'make things better' });
    assert.equal(result.needsClarification, true);
    assert.equal(result.actionable, false);
    assert.ok(result.clarificationPrompt.includes('is ambiguous'));
    assert.equal(result.unresolvedQuestions.length, 1);
    console.log('  -> 5a PASSED: Ambiguous request halts with focused prompt.');
  }

  // 5b. Follow-up request with referent in prior context
  {
    console.log('Case 5b: Follow-up request with established referent...');
    const contextMessages = [
      { role: 'user', content: 'Investigate crash in src/controllers/order.js on line 55' },
      { role: 'assistant', content: 'Identified bug in src/controllers/order.js: order.items is undefined' },
    ];
    const followUp = classifyTaskIntent({
      request: 'fix the bug',
      contextMessages,
    });
    assert.equal(followUp.needsClarification, false);
    assert.equal(followUp.taskType, 'INVESTIGATE_OR_DEBUG');
    assert.equal(followUp.actionable, true);
    assert.equal(followUp.mutationRequired, true);

    const requirements = analyzeTaskRequirements('fix the bug', contextMessages);
    assert.equal(requirements.needsClarification, false);
    assert.ok(requirements.searchSignals.exactPaths.includes('src/controllers/order.js'));
    console.log('  -> 5b PASSED: Follow-up resolves referent from context.');
  }

  // 5c. Follow-up request with NO established referent
  {
    console.log('Case 5c: Follow-up request with NO established referent...');
    const followUpOrphan = classifyTaskIntent({
      request: 'fix the bug',
      contextMessages: [], // No prior context!
    });
    assert.equal(followUpOrphan.needsClarification, true);
    assert.ok(followUpOrphan.clarificationPrompt.includes('is ambiguous'));
    console.log('  -> 5c PASSED: Orphan follow-up correctly triggers clarification.');
  }

  // 5d. Missing or unreadable authoritative source files
  {
    console.log('Case 5d: Unreadable authoritative source file...');
    const failingRead = async () => {
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    };
    const toolOutcome = await executeToolWithSafeguards({
      toolName: 'read_file',
      toolFn: failingRead,
      maxRetries: 1,
    });
    assert.equal(toolOutcome.success, false);
    assert.equal(toolOutcome.failurePreserved, true);
    assert.equal(toolOutcome.errorCode, 'ENOENT');
    console.log('  -> 5d PASSED: Missing source file failure preserved honestly.');
  }

  // 5e. Patch containing an unauthorized file
  {
    console.log('Case 5e: Patch modifying unauthorized file...');
    const validation = validatePatchScope({
      targetFiles: ['src/allowed.js'],
      inspectedFiles: ['src/allowed.js'],
      modifiedFiles: ['src/allowed.js', 'src/forbidden.js'], // Unauthorized file!
      existingDirtyFiles: [],
    });
    assert.equal(validation.isValid, false);
    assert.ok(validation.rejectionReason.includes('not in the authorized target scope'));
    console.log('  -> 5e PASSED: Unauthorized file modification strictly rejected.');
  }

  // 5f. Stale source / uninspected file
  {
    console.log('Case 5f: Stale source / uninspected file...');
    const uninspected = validatePatchScope({
      targetFiles: ['src/uninspected.js'],
      inspectedFiles: ['src/inspected.js'],
      modifiedFiles: ['src/uninspected.js'],
    });
    assert.equal(uninspected.isValid, false);
    assert.ok(uninspected.rejectionReason.includes('touches uninspected file(s)'));
    console.log('  -> 5f PASSED: Uninspected file patch rejected.');
  }

  // 5g. Approval rejection produces zero mutations
  {
    console.log('Case 5g: Approval rejection produces zero mutations...');
    const ws = await createTempWorkspace({
      'config.json': '{"port": 8080}\n',
    });
    try {
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'Change port in config.json to 9090',
        root: ws,
        sessionId: 'v23-rejection-test',
        ownerWebContentsId: 2307,
        requestApproval: async () => false, // Explicit rejection
        assessFindingRelevance: async ({ findings }) => ({
          findings: findings.map((f) => ({
            findingId: f.findingId,
            decision: 'SUPPORTED',
            relationship: 'Relevant config update',
            evidenceIds: [f.sourceEvidenceId],
            contradictionEvidenceIds: [],
            unresolvedAssumptions: [],
            provenance: 'TEST',
          })),
        }),
        tools: {
          readFile: async (p) => ({ content: await fs.readFile(path.join(ws, p), 'utf8') }),
          searchCode: async () => ({ results: [{ path: 'config.json', score: 100 }] }),
          proposePatch: async ({ originalContent }) => originalContent.replace('8080', '9090'),
          findDefects: async () => [{
            filePath: 'config.json',
            lines: '1',
            symbol: 'port',
            codeSnippet: '8080',
            expected: '9090',
            observed: '8080',
          }],
        },
      });

      assert.equal(result.outcome, 'APPROVAL_REJECTED');
      const diskContent = await fs.readFile(path.join(ws, 'config.json'), 'utf8');
      assert.equal(diskContent, '{"port": 8080}\n', 'Workspace file must remain untouched');
      console.log('  -> 5g PASSED: Approval rejection leaves workspace clean.');
    } finally {
      await cleanupWorkspace(ws);
    }
  }

  // 5h. Cancellation before mutation
  {
    console.log('Case 5h: Cancellation before mutation...');
    const ws = await createTempWorkspace({
      'app.js': 'console.log("running");\n',
    });
    try {
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'Update app.js',
        root: ws,
        sessionId: 'v23-cancel-test',
        ownerWebContentsId: 2308,
        isCancelled: () => true, // Pre-cancelled!
      });
      assert.equal(result.outcome, 'CANCELLED');
      assert.equal(result.filesModified.length, 0);
      assert.equal(result.evidenceLevel, 'INCONCLUSIVE');
      console.log('  -> 5h PASSED: Pre-cancellation halts workflow with zero mutations.');
    } finally {
      await cleanupWorkspace(ws);
    }
  }

  // 5i. Mocked test result cannot be mislabeled as real execution
  {
    console.log('Case 5i: Mocked test result cannot be mislabeled as real execution...');
    const { classifyVerificationEvidenceLevel, VERIFICATION_EVIDENCE_LEVELS } = developerAgent;

    const mockedResult = classifyVerificationEvidenceLevel({
      isPassing: true,
      testOutcome: { status: 'PASS', ok: true, attempts: [{ check: 'static_modular_integration', synthetic: true }] },
      finalEvidence: [],
      hermeticVerification: { passed: 9, total: 9 },
    });
    assert.equal(mockedResult, VERIFICATION_EVIDENCE_LEVELS.PASSED_SYNTHETIC_TESTS);
    assert.notEqual(mockedResult, VERIFICATION_EVIDENCE_LEVELS.PASSED_REAL_EXECUTION);
    console.log('  -> 5i PASSED: Synthetic/mocked verification cannot claim real execution.');
  }

  // 5j. Unavailable isolation runtime blocks target execution
  {
    console.log('Case 5j: Unavailable isolation runtime blocks target execution...');
    const ws = await createTempWorkspace({
      'package.json': JSON.stringify({ name: 'unisolated-pkg', scripts: { test: 'node -e "process.exit(0)"' } }),
    });
    try {
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        userRequest: 'test the project',
        root: ws,
        sessionId: 'v23-isolation-test',
        ownerWebContentsId: 2310,
        containerRunner: {
          isAvailable: async () => false, // Docker unavailable
          execute: async () => { throw new Error('Host execution forbidden'); },
        },
      });

      // Target project execution must be fail-closed BLOCKED
      assert.equal(result.executionBlocked, true);
      assert.ok(['BLOCKED', 'BLOCKED_ISOLATION'].includes(result.outcome));
      console.log('  -> 5j PASSED: Unavailable isolation safely halts with BLOCKED_ISOLATION.');
    } finally {
      await cleanupWorkspace(ws);
    }
  }

  console.log('\nALL Milestone V23 Request-to-Validated-Diff Integration Tests passed successfully!');
}

runTests().catch((err) => {
  console.error('\nIntegration test suite failed:', err);
  process.exit(1);
});
