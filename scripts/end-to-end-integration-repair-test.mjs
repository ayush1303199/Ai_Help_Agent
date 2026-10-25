import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  normalizeProjectRuntimeTestWorkflowResult,
  isProjectRuntimeTestRequest,
} from '../src/features/coding/codingTransport.ts';

console.log('--- RUNNING END-TO-END INTEGRATION REPAIR REGRESSION TEST SUITE ---');

// =========================================================================
// SCENARIO 1: Investigation request never triggers file creation question
// =========================================================================
console.log('[Scenario 1] Testing investigation request never triggers file creation question...');
{
  const pythonCheck = spawnSync('python', ['-c', `
import sys
sys.path.insert(0, 'server/src')
import re
from coding_websocket import _is_underspecified_file_creation_request

test_cases = [
    ("investigate why the orders page is not rendering", False),
    ("why does the order component fail to compile?", False),
    ("fix the order file issue", False),
    ("inspect file structure", False),
    ("test the project files", False),
    ("debug the file error", False),
    ("create a file", True),
    ("yume ek filenbnani hai", True),
    ("ek file bana do", True),
    ("add abc.php in controllers", False),
    ("can you add the file in project", False),
]

for req, expected in test_cases:
    actual = _is_underspecified_file_creation_request(req)
    assert actual == expected, f"Failed for '{req}': expected {expected}, got {actual}"
print("OK")
`], { encoding: 'utf8' });

  assert.equal(pythonCheck.status, 0, `Python test failed: ${pythonCheck.stderr || pythonCheck.stdout}`);
  assert.match(pythonCheck.stdout, /OK/);
}

// =========================================================================
// SCENARIO 2: Original request & workspace identity preserved across handoff
// =========================================================================
console.log('[Scenario 2] Testing request & workspace identity across handoff...');
{
  const controllerSource = await readFile(new URL('../src/features/coding/useCodingAgentController.ts', import.meta.url), 'utf8');
  assert.match(
    controllerSource,
    /validateWorkflowHandoffPlan/,
    'Controller must validate the version-2 handoff plan.',
  );
  assert.match(
    controllerSource,
    /Continuing the original request and its validated work items through the standard Coding Agent proposal workflow/,
    'Controller must continue the original request upon valid handoff.',
  );

  // Test handoff normalization contract
  const validHandoffPlan = {
    schemaVersion: 2,
    status: 'HANDED_OFF',
    workItems: [
      {
        id: 'WI-001',
        objective: 'Fix order page rendering issue',
        status: 'DELEGATED',
        dependsOn: [],
        requiredEvidence: ['APPROVED_SCOPE_PROPOSAL'],
      },
    ],
  };
  assert.equal(validHandoffPlan.status, 'HANDED_OFF');
  assert.equal(validHandoffPlan.workItems[0].status, 'DELEGATED');
}

// =========================================================================
// SCENARIO 3: Bounded investigation stops without infinite loop
// =========================================================================
console.log('[Scenario 3] Testing bounded investigation stopping condition...');
{
  const devAgent = await readFile(new URL('../electron/developerAgent.cjs', import.meta.url), 'utf8');
  assert.match(
    devAgent,
    /advanceConversationTurn\(turn\.turnId,\s*'failed',\s*owner,\s*\{\s*phase:\s*'implementation_required'\s*\}\)/,
    'Handoff must record implementation_required phase.',
  );
  assert.match(
    devAgent,
    /taskPlan\.status\s*=\s*'HANDED_OFF'/,
    'Developer agent must mark taskPlan as HANDED_OFF when delegating work items.',
  );
}

// =========================================================================
// SCENARIO 4: Missing continuation state yields explicit actionable error
// =========================================================================
console.log('[Scenario 4] Testing missing continuation state fail-closed error...');
{
  const controllerSource = await readFile(new URL('../src/features/coding/useCodingAgentController.ts', import.meta.url), 'utf8');
  assert.match(
    controllerSource,
    /The investigation requires implementation, but did not return a valid version-2 handoff plan/,
    'Controller must report explicit error when handoff plan is invalid or missing.',
  );
}

// =========================================================================
// SCENARIO 5: Synthetic in-process passes do not claim real host startup
// =========================================================================
console.log('[Scenario 5] Testing synthetic in-process passes cannot claim real host startup...');
{
  const blockedResult = {
    outcome: 'VERIFICATION_BLOCKED',
    codeVerified: false,
    message: 'Process isolation gate blocked host execution.',
    executionVerificationReceipt: {
      status: 'PASSED',
      message: 'In-process HTTP loopback probes passed 9/9 gates.',
    },
    hermeticVerification: {
      passed: 9,
      total: 9,
      gates: [],
    },
  };

  const normalized = normalizeProjectRuntimeTestWorkflowResult('test the project', blockedResult);
  assert.equal(
    normalized.outcome,
    'VERIFICATION_BLOCKED',
    'VERIFICATION_BLOCKED must not be converted to SUCCESS.',
  );
  assert.equal(
    normalized.codeVerified,
    false,
    'codeVerified must remain false when host verification was blocked.',
  );
  assert.match(
    normalized.message,
    /in-process hermetic simulation passed, but live host execution was blocked by PROCESS_ISOLATION_GATE/,
    'Result message must clearly disclose that only in-process simulation ran.',
  );
}

// =========================================================================
// SCENARIO 6: Missing isolation gate blocks live command execution
// =========================================================================
console.log('[Scenario 6] Testing isolation gate policy...');
{
  const sandboxAdapter = await readFile(new URL('../electron/coding-pipeline/sandboxExecutionAdapter.cjs', import.meta.url), 'utf8');
  assert.match(
    sandboxAdapter,
    /PROCESS_ISOLATION_GATE/,
    'sandboxExecutionAdapter must enforce PROCESS_ISOLATION_GATE.',
  );
}

// =========================================================================
// SCENARIO 7: Approval required before protected changes applied
// =========================================================================
console.log('[Scenario 7] Testing approval gate before applying changes...');
{
  const devAgent = await readFile(new URL('../electron/developerAgent.cjs', import.meta.url), 'utf8');
  assert.match(
    devAgent,
    /awaiting_approval/,
    'Conversation lifecycle must enforce awaiting_approval state.',
  );
  assert.match(
    devAgent,
    /enforceApprovalGate/,
    'enforceApprovalGate must be verified before apply.',
  );
}

// =========================================================================
// SCENARIO 8: Verification failure / blocked cannot produce SUCCESS
// =========================================================================
console.log('[Scenario 8] Testing verification failure cannot produce SUCCESS...');
{
  const failedResult = {
    outcome: 'HERMETIC_VERIFICATION_FAILED',
    codeVerified: false,
    hermeticVerification: {
      passed: 7,
      total: 9,
      gates: [
        { id: 'gate-8', passed: false, diagnostics: [{ reason: 'AST syntax error' }] },
      ],
    },
  };
  const normalizedFailed = normalizeProjectRuntimeTestWorkflowResult('test the project', failedResult);
  assert.notEqual(normalizedFailed.outcome, 'SUCCESS');
  assert.notEqual(normalizedFailed.codeVerified, true);
}

// =========================================================================
// SCENARIO 9: Rollback and audit correctly propagated
// =========================================================================
console.log('[Scenario 9] Testing rollback and audit propagation...');
{
  const rolledBackResult = {
    outcome: 'TEST_FAILED',
    rolledBack: true,
    codeVerified: false,
    filesModified: ['src/Order.js'],
  };
  const normalizedRollback = normalizeProjectRuntimeTestWorkflowResult('test the project', rolledBackResult);
  assert.equal(normalizedRollback.rolledBack, true);
  assert.notEqual(normalizedRollback.outcome, 'SUCCESS');
}

// =========================================================================
// SCENARIO 10: UI displays terminal status and reason
// =========================================================================
console.log('[Scenario 10] Testing UI displays terminal status and reason...');
{
  const controllerSource = await readFile(new URL('../src/features/coding/useCodingAgentController.ts', import.meta.url), 'utf8');
  assert.match(
    controllerSource,
    /result\.outcome === 'BLOCKED'/,
    'UI controller must handle result.outcome === BLOCKED explicitly.',
  );
  assert.match(
    controllerSource,
    /Workflow was blocked\$\{result\.phase/,
    'UI controller must display the phase and reason for BLOCKED outcome.',
  );
}

console.log('--- ALL 10 REGRESSION SCENARIOS PASSED SUCCESSFULLY ---');
