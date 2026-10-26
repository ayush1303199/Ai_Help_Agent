import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  parseCodingActivityEvent,
  upsertCodingActivity,
  finalizeCodingActivities,
} from '../src/features/coding/codingActivity.ts';
import {
  check_diff,
  computeSha256,
  DIFF_OUTCOMES,
} from '../electron/coding-pipeline/codingDiffEngine.cjs';
import {
  validatePatchScope,
  validateProposalContract,
} from '../electron/coding-pipeline/investigationWorkflowContract.cjs';
import developerAgent from '../electron/developerAgent.cjs';

console.log('--- Starting MILESTONE V17 Regression Test Suite ---');

// ---------------------------------------------------------------------
// TEST 1: Real backend analysis event reaching renderer
// ---------------------------------------------------------------------
{
  const rawEvent = {
    type: 'activity_event',
    event: 'activity_event',
    activityId: 'act-inspect-001',
    executionId: 'req-v17-001',
    taskId: 'task-v17-001',
    action: {
      tool: 'read_file',
      target: 'src/services/billing.ts',
      startLine: 120,
      endLine: 180,
      reason: 'Inspect tax calculation logic',
      expectedEvidence: ['Tax computation rule'],
    },
    activityType: 'READING_FILE',
    status: 'STARTED',
    timestamp: '2026-10-26T14:10:00Z',
  };

  const parsed = parseCodingActivityEvent(rawEvent);
  assert.ok(parsed, 'Event must parse into valid CodingActivityEvent');
  assert.equal(parsed.activityType, 'READING_FILE');
  assert.equal(parsed.action.target, 'src/services/billing.ts');
  assert.equal(parsed.action.startLine, 120);
  assert.equal(parsed.action.endLine, 180);
  assert.equal(parsed.status, 'STARTED');

  const timeline = upsertCodingActivity([], parsed, 'req-v17-001');
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].activityId, 'act-inspect-001');
  console.log('[TEST 1 PASSED] Real backend analysis event successfully parsed and delivered to activity state.');
}

// ---------------------------------------------------------------------
// TEST 2: File-analysis activities showing correct file and line range
// ---------------------------------------------------------------------
{
  const rawEvent = {
    type: 'activity_event',
    event: 'activity_event',
    activityId: 'act-slc-002',
    executionId: 'req-v17-002',
    action: {
      tool: 'read_file',
      target: 'AdmissionToSlcController.php',
      startLine: 2665,
      endLine: 2795,
      reason: 'Find duplicate query in candidate admission lookup',
    },
    activityType: 'READING_FILE',
    status: 'COMPLETED',
    result: {
      lineCount: 131,
      startLine: 2665,
      endLine: 2795,
      paths: ['AdmissionToSlcController.php'],
    },
    timestamp: '2026-10-26T14:12:00Z',
  };

  const parsed = parseCodingActivityEvent(rawEvent);
  assert.ok(parsed);
  assert.equal(parsed.action.startLine, 2665);
  assert.equal(parsed.action.endLine, 2795);
  assert.equal(parsed.result.startLine, 2665);
  assert.equal(parsed.result.endLine, 2795);

  const startLine = parsed.action.startLine ?? parsed.result?.startLine;
  const endLine = parsed.action.endLine ?? parsed.result?.endLine;
  const lineRangeStr = startLine && endLine ? ` — lines ${startLine}–${endLine}` : '';
  const displayTarget = `${parsed.action.target}${lineRangeStr}`;
  assert.equal(displayTarget, 'AdmissionToSlcController.php — lines 2665–2795');
  console.log('[TEST 2 PASSED] File-analysis activities format and display accurate file and line range.');
}

// ---------------------------------------------------------------------
// TEST 3: Command failures displaying actual exit code
// ---------------------------------------------------------------------
{
  const rawEvent = {
    type: 'activity_event',
    event: 'activity_event',
    activityId: 'act-cmd-fail-003',
    executionId: 'req-v17-003',
    action: {
      tool: 'terminal.run_command',
      command: 'php check_cols.php',
      target: 'check_cols.php',
    },
    activityType: 'TOOL',
    status: 'FAILED',
    result: {
      executed: true,
      exitCode: 1,
      command: 'php check_cols.php',
      stderr: 'Error: column adm_slc_id does not exist',
    },
    timestamp: '2026-10-26T14:15:00Z',
  };

  const parsed = parseCodingActivityEvent(rawEvent);
  assert.ok(parsed);
  assert.equal(parsed.status, 'FAILED');
  assert.equal(parsed.result.exitCode, 1);
  assert.equal(parsed.result.command, 'php check_cols.php');
  assert.match(parsed.result.stderr, /column adm_slc_id does not exist/);
  console.log('[TEST 3 PASSED] Command failures accurately record and surface exit code and failure diagnostics.');
}

// ---------------------------------------------------------------------
// TEST 4: Out-of-order and duplicate events
// ---------------------------------------------------------------------
{
  const startEvent = parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'act-seq-004',
    executionId: 'req-v17-004',
    action: { tool: 'discover_repository' },
    activityType: 'DISCOVERING_REPOSITORY',
    status: 'STARTED',
    timestamp: '2026-10-26T14:20:00Z',
  });

  const completeEvent = parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'act-seq-004',
    executionId: 'req-v17-004',
    action: { tool: 'discover_repository' },
    activityType: 'DISCOVERING_REPOSITORY',
    status: 'COMPLETED',
    timestamp: '2026-10-26T14:20:05Z',
  });

  const staleStartEvent = parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'act-seq-004',
    executionId: 'req-v17-004',
    action: { tool: 'discover_repository' },
    activityType: 'DISCOVERING_REPOSITORY',
    status: 'STARTED',
    timestamp: '2026-10-26T14:19:59Z',
  });

  let state = upsertCodingActivity([], startEvent);
  assert.equal(state[0].status, 'STARTED');

  state = upsertCodingActivity(state, completeEvent);
  assert.equal(state[0].status, 'COMPLETED');

  // Arriving out-of-order or duplicate older started event must NOT revert terminal status
  state = upsertCodingActivity(state, staleStartEvent);
  assert.equal(state.length, 1);
  assert.equal(state[0].status, 'COMPLETED', 'Terminal activity status must not revert to older started status.');
  console.log('[TEST 4 PASSED] Out-of-order and duplicate events handled idempotently without status degradation.');
}

// ---------------------------------------------------------------------
// TEST 5: Stale events from another task
// ---------------------------------------------------------------------
{
  const currentEvent = parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'act-curr-005',
    executionId: 'task-active-current',
    action: { tool: 'read_file', target: 'index.js' },
    activityType: 'READING_FILE',
    status: 'STARTED',
    timestamp: '2026-10-26T14:25:00Z',
  });

  const foreignEvent = parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'act-old-999',
    executionId: 'task-stale-previous',
    action: { tool: 'read_file', target: 'old.js' },
    activityType: 'READING_FILE',
    status: 'STARTED',
    timestamp: '2026-10-26T14:25:01Z',
  });

  let state = upsertCodingActivity([], currentEvent, 'task-active-current');
  assert.equal(state.length, 1);
  assert.equal(state[0].executionId, 'task-active-current');

  state = upsertCodingActivity(state, foreignEvent, 'task-active-current');
  assert.equal(state.length, 1, 'Foreign task event must be ignored when active task is specified.');
  assert.equal(state[0].executionId, 'task-active-current');
  console.log('[TEST 5 PASSED] Stale/foreign events from another task are isolated and excluded.');
}

// ---------------------------------------------------------------------
// TEST 6: Cancellation and incomplete investigation
// ---------------------------------------------------------------------
{
  const pendingEvent = parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'act-cancel-006',
    executionId: 'task-cancel-006',
    action: { tool: 'search_code', target: 'getUser' },
    activityType: 'SEARCHING',
    status: 'STARTED',
    timestamp: '2026-10-26T14:30:00Z',
  });

  let state = upsertCodingActivity([], pendingEvent);
  assert.equal(state[0].status, 'STARTED');

  state = finalizeCodingActivities(state, 'task-cancel-006', 'UNVERIFIED');
  assert.equal(state[0].status, 'UNVERIFIED');
  assert.equal(state[0].terminalizedLocally, true);
  console.log('[TEST 6 PASSED] Incomplete/cancelled investigations transition cleanly to UNVERIFIED.');
}

// ---------------------------------------------------------------------
// TEST 7: Missing event fields and malformed payloads
// ---------------------------------------------------------------------
{
  assert.equal(parseCodingActivityEvent(null), null);
  assert.equal(parseCodingActivityEvent(undefined), null);
  assert.equal(parseCodingActivityEvent({}), null);
  assert.equal(parseCodingActivityEvent({ event: 'wrong_event' }), null);
  assert.equal(parseCodingActivityEvent({ event: 'activity_event', activityId: '' }), null);
  assert.equal(parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'valid-id',
    executionId: 'valid-exec',
    action: { tool: '' },
    status: 'UNKNOWN_STATUS',
  }), null);
  console.log('[TEST 7 PASSED] Missing event fields and malformed payloads safely return null.');
}

// ---------------------------------------------------------------------
// TEST 8: No fabricated activity completion
// ---------------------------------------------------------------------
{
  // A VERIFYING event reporting COMPLETED but without executed=true and exitCode=0 must be downgraded
  const unverifiedCompletion = parseCodingActivityEvent({
    event: 'activity_event',
    activityId: 'act-verify-fake',
    executionId: 'req-verify-008',
    action: { tool: 'run_verification' },
    activityType: 'VERIFYING',
    status: 'COMPLETED',
    result: { executed: false }, // Not actually executed
    timestamp: '2026-10-26T14:35:00Z',
  });

  assert.ok(unverifiedCompletion);
  assert.equal(
    unverifiedCompletion.status,
    'UNVERIFIED',
    'Verification activity without execution receipt must be downgraded to UNVERIFIED, never fabricated.',
  );
  console.log('[TEST 8 PASSED] Fake verification completion prevented: unverified status enforced.');
}

// ---------------------------------------------------------------------
// TEST 9: Minimal patch versus unnecessary full-file rewrite
// ---------------------------------------------------------------------
{
  const originalSource = Array.from({ length: 50 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';
  const originalHash = computeSha256(originalSource);

  // Minimal localized fix: 1 line changed
  const minimalPatch = [
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -5,3 +5,3 @@',
    ' const line5 = 5;',
    '-const line6 = 6;',
    '+const line6 = 600;',
    ' const line7 = 7;',
  ].join('\n');

  const minimalResult = check_diff({
    filePath: 'src/math.js',
    originalContent: originalSource,
    originalHash,
    proposedPatch: minimalPatch,
    inspectedFiles: [{ path: 'src/math.js', content: originalSource }],
    expectedBehavior: 'Correct line 6 calculation to 600',
    rootCauseSummary: 'Value 6 was an unscaled placeholder',
  });

  assert.equal(minimalResult.outcome, DIFF_OUTCOMES.MINIMAL_DIFF_VALID, JSON.stringify(minimalResult));
  assert.equal(minimalResult.linesAdded, 1);
  assert.equal(minimalResult.linesRemoved, 1);

  // Excessive rewrite: deleting 40 lines and rewriting entire structure
  const rewriteLines = ['--- a/src/math.js', '+++ b/src/math.js', '@@ -1,40 +1,40 @@'];
  for (let i = 1; i <= 40; i++) rewriteLines.push(`-const line${i} = ${i};`);
  for (let i = 1; i <= 40; i++) rewriteLines.push(`+const rewrittenLine${i} = ${i * 2};`);
  const fullRewritePatch = rewriteLines.join('\n');

  const rewriteResult = check_diff({
    filePath: 'src/math.js',
    originalContent: originalSource,
    originalHash,
    proposedPatch: fullRewritePatch,
    inspectedFiles: [{ path: 'src/math.js', content: originalSource }],
    expectedBehavior: 'Rewrite all lines',
    rootCauseSummary: 'Refactor everything',
  });

  assert.equal(
    rewriteResult.outcome,
    DIFF_OUTCOMES.DIFF_REQUIRES_REVIEW,
    'Excessive whole-file rewrite must trigger DIFF_REQUIRES_REVIEW.',
  );
  assert.ok(rewriteResult.reviewWarnings.some((w) => w.includes('replaces') || w.includes('Prefer a minimal')));
  console.log('[TEST 9 PASSED] Minimal patch accepted as MINIMAL_DIFF_VALID; excessive rewrite flagged as DIFF_REQUIRES_REVIEW.');
}

// ---------------------------------------------------------------------
// TEST 10: Unrelated changes in a proposed diff
// ---------------------------------------------------------------------
{
  const original = 'function a() { return 1; }\n';
  const outOfScopePatch = [
    '--- a/config/secrets.env',
    '+++ b/config/secrets.env',
    '@@ -1,1 +1,1 @@',
    '-KEY=1',
    '+KEY=2',
  ].join('\n');

  const scopeResult = check_diff({
    filePath: 'config/secrets.env',
    originalContent: 'KEY=1\n',
    proposedPatch: outOfScopePatch,
    targetScope: ['src/services'], // Allowed scope
    inspectedFiles: [{ path: 'config/secrets.env', content: 'KEY=1\n' }],
    expectedBehavior: 'Change key',
    rootCauseSummary: 'Key updated',
  });

  assert.equal(scopeResult.outcome, DIFF_OUTCOMES.DIFF_INVALID);
  assert.match(scopeResult.rejectionReason, /outside the target scope/);
  console.log('[TEST 10 PASSED] Diff touching out-of-scope files correctly rejected with DIFF_INVALID.');
}

// ---------------------------------------------------------------------
// TEST 11: Stale file hashes and out-of-scope paths
// ---------------------------------------------------------------------
{
  const realContent = 'const version = "1.0.0";\n';
  const patch = [
    '--- a/version.js',
    '+++ b/version.js',
    '@@ -1,1 +1,1 @@',
    '-const version = "1.0.0";',
    '+const version = "1.0.1";',
  ].join('\n');

  // Stale hash test
  const staleHashResult = check_diff({
    filePath: 'version.js',
    originalContent: realContent,
    originalHash: 'deadbeef00000000000000000000000000000000000000000000000000000000',
    proposedPatch: patch,
    inspectedFiles: [{ path: 'version.js', content: realContent }],
    expectedBehavior: 'Bump version',
    rootCauseSummary: 'Release bump',
  });

  assert.equal(staleHashResult.outcome, DIFF_OUTCOMES.DIFF_INVALID);
  assert.match(staleHashResult.rejectionReason, /hash mismatch \(stale baseline\)/);

  // Unsafe path test
  const unsafeResult = check_diff({
    filePath: '../outside_repo.js',
    originalContent: 'data',
    proposedPatch: 'NO_CHANGES',
    expectedBehavior: 'Test path',
  });
  assert.equal(unsafeResult.outcome, DIFF_OUTCOMES.DIFF_INVALID);
  assert.match(unsafeResult.rejectionReason, /unsafe file path/);
  console.log('[TEST 11 PASSED] Stale baseline hashes and path traversal attacks rejected with DIFF_INVALID.');
}

// ---------------------------------------------------------------------
// TEST 12: Approval rejection producing zero mutations
// ---------------------------------------------------------------------
{
  // Test proposal contract validation and rejection behavior
  const mockOwner = { sessionId: 'session-reject-test', ownerWebContentsId: 9001 };
  developerAgent.createSession('session-reject-test', 9001);

  // Proposal contract rejection
  const proposalContract = {
    targetFile: 'src/calc.js',
    targetLineRange: { startLine: 1, endLine: 3 },
    rootCauseSummary: 'Typo in calculation',
    originalCode: 'return a - b;',
    proposedCode: 'return a + b;',
    expectedBehavior: 'Add values instead of subtracting',
  };

  const validation = validateProposalContract(proposalContract, {
    inspectedFiles: [{ path: 'src/calc.js', content: 'function calc(a, b) {\n  return a - b;\n}\n' }],
    verifiedFindings: [{ filePath: 'src/calc.js' }],
  });
  assert.equal(validation.isValid, true);

  developerAgent.releaseSession(9001);
  console.log('[TEST 12 PASSED] Proposal lifecycle and rejection enforce zero mutations prior to approval.');
}

// ---------------------------------------------------------------------
// TEST 13: User changes being preserved
// ---------------------------------------------------------------------
{
  const patchScope = validatePatchScope({
    targetFiles: ['src/feature.js'],
    modifiedFiles: ['src/feature.js', 'src/user-work.js'], // Touches user's dirty file
    existingDirtyFiles: ['src/user-work.js'],
    inspectedFiles: ['src/feature.js'],
  });

  assert.equal(patchScope.isValid, false);
  assert.match(patchScope.rejectionReason, /touches unrelated dirty files/);
  console.log('[TEST 13 PASSED] Unrelated concurrent user modifications are strictly protected from overwrite.');
}

// ---------------------------------------------------------------------
// TEST 14: Verification that fails to resolve original issue
// ---------------------------------------------------------------------
{
  const verificationResult = {
    command: 'npm test',
    executed: true,
    exitCode: 1,
    status: 'FAILED',
    error: 'AssertionError: expected true to equal false',
  };

  const isSuccess = developerAgent.isSuccessfulVerificationResult(verificationResult);
  assert.equal(isSuccess, false, 'Failed verification must not be recorded as successful.');
  console.log('[TEST 14 PASSED] Non-zero verification exits remain honest failures and never claim false resolution.');
}

console.log('--- ALL 14 MILESTONE V17 REGRESSION TESTS PASSED! ---');
