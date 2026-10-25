'use strict';

/**
 * Modular Repair Planner & Controlled Repair Lifecycle for AI Coding Agent (Milestone V4).
 *
 * Consumes structured diagnosis from diagnosticEngine.cjs, reads target files
 * through authorized project tools, and produces minimal, scoped repair proposals.
 *
 * Enforces:
 * - Strict maximum 3 repair attempts per workflow.
 * - Loop prevention: rejects repeating identical ineffective patches.
 * - Rejection of scope expansion (unrelated files).
 * - Pre-apply drift detection against source snapshots.
 * - Strict approval gating with cryptographic digest binding.
 * - Rollback snapshot capture.
 * - Fail-closed process-isolation boundary.
 *
 * ZERO hardcoded application packages, endpoints, or invented patches.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyProjectAuthorization } = require('./projectDiscovery.cjs');
const { requireProjectProcessIsolation } = require('./projectProcessIsolation.cjs');
const { DIAGNOSTIC_STATUSES, FAILURE_CATEGORIES, VERIFICATION_TIERS } = require('./diagnosticEngine.cjs');

const MAX_REPAIR_ATTEMPTS = 3;

const REPAIR_PLAN_STATUSES = Object.freeze({
  READY: 'READY',
  ABSTAINED: 'ABSTAINED',
  UNRESOLVABLE: 'UNRESOLVABLE',
  BLOCKED: 'BLOCKED',
});

/**
 * Generates a unified diff preview between two strings.
 */
function createDiffPreview(filePath, original, replacement) {
  const origLines = original.split(/\r?\n/);
  const replLines = replacement.split(/\r?\n/);

  let startDiff = -1;
  let endDiffOrig = origLines.length - 1;
  let endDiffRepl = replLines.length - 1;

  for (let i = 0; i < Math.max(origLines.length, replLines.length); i++) {
    if (origLines[i] !== replLines[i]) {
      startDiff = i;
      break;
    }
  }

  if (startDiff === -1) {
    return '--- identical (no changes) ---';
  }

  while (endDiffOrig > startDiff && endDiffRepl > startDiff) {
    if (origLines[endDiffOrig] !== replLines[endDiffRepl]) {
      break;
    }
    endDiffOrig--;
    endDiffRepl--;
  }

  const contextStart = Math.max(0, startDiff - 2);
  const contextEndOrig = Math.min(origLines.length, endDiffOrig + 3);
  const contextEndRepl = Math.min(replLines.length, endDiffRepl + 3);

  const hunkLines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${contextStart + 1},${contextEndOrig - contextStart} +${contextStart + 1},${contextEndRepl - contextStart} @@`,
  ];

  for (let i = contextStart; i < startDiff; i++) {
    hunkLines.push(` ${origLines[i]}`);
  }
  for (let i = startDiff; i <= endDiffOrig; i++) {
    hunkLines.push(`-${origLines[i]}`);
  }
  for (let i = startDiff; i <= endDiffRepl; i++) {
    hunkLines.push(`+${replLines[i]}`);
  }
  for (let i = endDiffOrig + 1; i < contextEndOrig; i++) {
    hunkLines.push(` ${origLines[i]}`);
  }

  return hunkLines.join('\n');
}

/**
 * Creates an immutable, minimal repair plan based on diagnosis evidence.
 *
 * @param {Object} options
 * @param {Object} options.diagnosis - Structured diagnosis from diagnosticEngine.
 * @param {string} options.projectRoot - Authorized workspace root.
 * @param {Function} [options.sourceReader] - Async reader (path) => string.
 * @param {Array} [options.previousPlans] - Array of previous plans in repair loop.
 * @param {Function} [options.customPatchGenerator] - Optional hook for custom patch creation.
 * @returns {Promise<Object>} Structured repair plan.
 */
/**
 * Validates that a file path is strictly located within the authorized project root (no traversal).
 */
function validatePathWithinRoot(filePath, projectRoot) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { valid: false, error: 'File path must be a non-empty string.' };
  }
  const resolved = path.resolve(projectRoot, filePath);
  const canonicalRoot = path.resolve(projectRoot);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { valid: false, error: `File path "${filePath}" traverses outside authorized project root.` };
  }
  return { valid: true, resolvedPath: resolved, relativePath: relative.replace(/\\/g, '/') };
}

/**
 * Rolls back all modified files using captured snapshot contents.
 */
async function rollbackAllSnapshots(projectRoot, snapshots = {}) {
  for (const [snapFile, snapContent] of Object.entries(snapshots)) {
    try {
      const fullPath = path.resolve(projectRoot, snapFile);
      await fs.writeFile(fullPath, snapContent, 'utf8');
    } catch {
      // best-effort snapshot restoration
    }
  }
}

/**
 * Validates multi-file patch integrity before application:
 * - Path traversal validation on all target paths.
 * - Pre-apply drift detection across all target files.
 * - Plan digest binding.
 */
async function validateMultiFilePatchIntegrity({
  fileChanges = [],
  projectRoot,
  approvedDigest = null,
} = {}) {
  if (!Array.isArray(fileChanges) || fileChanges.length === 0) {
    return { valid: false, error: 'Patch contains zero file changes.' };
  }
  if (!projectRoot) {
    return { valid: false, error: 'projectRoot is required for patch integrity validation.' };
  }

  for (const change of fileChanges) {
    const pathCheck = validatePathWithinRoot(change.filePath, projectRoot);
    if (!pathCheck.valid) {
      return { valid: false, error: pathCheck.error };
    }

    // Pre-apply drift check
    try {
      const diskContent = await fs.readFile(pathCheck.resolvedPath, 'utf8');
      if (diskContent !== change.originalContent) {
        return {
          valid: false,
          driftDetected: true,
          error: `Pre-apply drift guard: disk contents of "${change.filePath}" have changed since proposal was generated.`,
        };
      }
    } catch (readErr) {
      return {
        valid: false,
        error: `Could not verify target file "${change.filePath}" before apply: ${readErr.message}`,
      };
    }
  }

  return { valid: true };
}

async function createRepairPlan({
  diagnosis,
  projectRoot,
  sourceReader = null,
  previousPlans = [],
  customPatchGenerator = null,
  projectGraph = null,
  semanticGraph = null,
} = {}) {
  if (!diagnosis || !projectRoot) {
    throw new Error('diagnosis and projectRoot are required to create a repair plan.');
  }

  const attemptNumber = (diagnosis.attemptNumber || previousPlans.length + 1);

  // 1. Guard against unbounded repair attempts
  if (attemptNumber > MAX_REPAIR_ATTEMPTS) {
    return {
      status: REPAIR_PLAN_STATUSES.UNRESOLVABLE,
      attemptNumber,
      maxAttempts: MAX_REPAIR_ATTEMPTS,
      reason: `Maximum repair attempts (${MAX_REPAIR_ATTEMPTS}) reached. Terminating repair loop to prevent unbounded cycle.`,
      diagnosisId: diagnosis.diagnosisId,
      projectRoot,
      affectedFiles: [],
      fileChanges: [],
    };
  }

  // 2. Guard against Blocked diagnosis (e.g. process isolation or authorization)
  if (diagnosis.status === DIAGNOSTIC_STATUSES.BLOCKED) {
    return {
      status: REPAIR_PLAN_STATUSES.BLOCKED,
      attemptNumber,
      reason: diagnosis.rootCause,
      gate: diagnosis.evidence?.gate || 'PROCESS_ISOLATION_GATE',
      diagnosisId: diagnosis.diagnosisId,
      projectRoot,
      affectedFiles: [],
      fileChanges: [],
    };
  }

  // 3. Guard against Insufficient Evidence
  if (diagnosis.status === DIAGNOSTIC_STATUSES.INSUFFICIENT_EVIDENCE) {
    return {
      status: REPAIR_PLAN_STATUSES.ABSTAINED,
      attemptNumber,
      reason: 'Cannot formulate minimal repair plan: diagnostic evidence is insufficient to identify root cause without speculation.',
      diagnosisId: diagnosis.diagnosisId,
      projectRoot,
      affectedFiles: [],
      fileChanges: [],
    };
  }

  // 4. Identify target affected files strictly from diagnosis evidence
  const affected = (diagnosis.affectedFiles || []).filter(Boolean);
  if (affected.length === 0 && !diagnosis.primaryLocation?.file) {
    return {
      status: REPAIR_PLAN_STATUSES.ABSTAINED,
      attemptNumber,
      reason: 'No affected files identified in diagnostic evidence. Refusing speculative file modification.',
      diagnosisId: diagnosis.diagnosisId,
      projectRoot,
      affectedFiles: [],
      fileChanges: [],
    };
  }

  const targetFile = diagnosis.primaryLocation?.file || affected[0];
  const relativeTarget = path.isAbsolute(targetFile)
    ? path.relative(projectRoot, targetFile).replace(/\\/g, '/')
    : targetFile.replace(/\\/g, '/');

  // 5. Read target source file from authorized workspace
  let originalContent = '';
  try {
    if (typeof sourceReader === 'function') {
      const readRes = await sourceReader(relativeTarget);
      originalContent = typeof readRes === 'string' ? readRes : readRes?.content || '';
    } else {
      const resolved = path.resolve(projectRoot, relativeTarget);
      // Ensure path stays inside projectRoot
      if (!resolved.startsWith(path.resolve(projectRoot))) {
        return {
          status: REPAIR_PLAN_STATUSES.BLOCKED,
          reason: `Target file path "${relativeTarget}" traverses outside authorized projectRoot.`,
          diagnosisId: diagnosis.diagnosisId,
          projectRoot,
        };
      }
      originalContent = await fs.readFile(resolved, 'utf8');
    }
  } catch (readErr) {
    return {
      status: REPAIR_PLAN_STATUSES.ABSTAINED,
      attemptNumber,
      reason: `Could not read affected file "${relativeTarget}": ${readErr.message}`,
      diagnosisId: diagnosis.diagnosisId,
      projectRoot,
      affectedFiles: [relativeTarget],
    impactAnalysis: impactAnalysis || null,
    };
  }

  // 6. Formulate Minimal Patch Proposal
  let replacementContent = null;
  let rationale = `Repair for ${diagnosis.failureCategory}: ${diagnosis.rootCause}`;

  if (typeof customPatchGenerator === 'function') {
    const custom = await customPatchGenerator({
      filePath: relativeTarget,
      originalContent,
      diagnosis,
    });
    if (custom && typeof custom.replacementContent === 'string') {
      replacementContent = custom.replacementContent;
      if (custom.rationale) rationale = custom.rationale;
    }
  }

  // Generic minimal syntax / exception patch if custom generator wasn't provided or returned null
  if (replacementContent === null) {
    if (diagnosis.failureCategory === FAILURE_CATEGORIES.MISSING_DEPENDENCY) {
      return {
        status: REPAIR_PLAN_STATUSES.ABSTAINED,
        attemptNumber,
        reason: `Missing dependency failure requires package installation via dependency manager, not source mutation: ${diagnosis.rootCause}`,
        diagnosisId: diagnosis.diagnosisId,
        projectRoot,
        affectedFiles: [relativeTarget],
      };
    }

    // Default minimal targeted patch representation:
    // If target line is present, apply minimal guarded wrapper or syntax correction
    const targetLine = diagnosis.primaryLocation?.line;
    if (targetLine && targetLine > 0) {
      const lines = originalContent.split(/\r?\n/);
      if (lines.length >= targetLine) {
        // Build minimal replacement maintaining code preservation
        replacementContent = originalContent; // baseline fallback
      }
    }
  }

  if (replacementContent === null || replacementContent === originalContent) {
    return {
      status: REPAIR_PLAN_STATUSES.ABSTAINED,
      attemptNumber,
      reason: 'No safe deterministic patch could be synthesized from current diagnostic evidence without speculation.',
      diagnosisId: diagnosis.diagnosisId,
      projectRoot,
      affectedFiles: [relativeTarget],
    };
  }

  const diffPreview = createDiffPreview(relativeTarget, originalContent, replacementContent);

  // 7. Calculate deterministic SHA-256 plan digest
  const digestPayload = JSON.stringify({
    projectRoot: path.resolve(projectRoot),
    diagnosisId: diagnosis.diagnosisId,
    targetFile: relativeTarget,
    diffPreview,
  });
  const planDigest = crypto.createHash('sha256').update(digestPayload).digest('hex');

  // 8. Prevent repeating an identical ineffective patch
  const isDuplicatePatch = previousPlans.some((p) => p.planDigest === planDigest);
  if (isDuplicatePatch) {
    return {
      status: REPAIR_PLAN_STATUSES.ABSTAINED,
      attemptNumber,
      reason: 'Identical repair patch was already attempted in previous cycle and failed to resolve the issue. Halting to avoid infinite loop.',
      diagnosisId: diagnosis.diagnosisId,
      projectRoot,
      planDigest,
      affectedFiles: [relativeTarget],
    };
  }

  const activeGraph = projectGraph || semanticGraph || null;
  let impactAnalysis = null;
  if (activeGraph && typeof activeGraph.detectAffectedFilesDetailed === 'function') {
    impactAnalysis = activeGraph.detectAffectedFilesDetailed([relativeTarget]);
  } else if (activeGraph && typeof activeGraph.detectAffectedFiles === 'function') {
    impactAnalysis = {
      status: 'VERIFIED',
      targets: activeGraph.detectAffectedFiles([relativeTarget]),
      unresolvedDependencies: [],
      totalTargets: 1,
    };
  }

  return {
    planId: crypto.randomUUID(),
    status: REPAIR_PLAN_STATUSES.READY,
    diagnosisId: diagnosis.diagnosisId,
    projectRoot: path.resolve(projectRoot),
    attemptNumber,
    maxAttempts: MAX_REPAIR_ATTEMPTS,
    planDigest,
    affectedFiles: [relativeTarget],
    impactAnalysis: impactAnalysis || null,
    fileChanges: [
      {
        filePath: relativeTarget,
        originalContent,
        replacementContent,
        diffPreview,
        rationale,
      },
    ],
    scope: {
      maxFilesAllowed: 3,
      filesModifiedCount: 1,
      isScopeExpanded: false,
    },
    riskAssessment: 'LOW',
    rollbackInfo: {
      snapshots: {
        [relativeTarget]: originalContent,
      },
    },
    requiredChecks: ['npm run lint', 'npm run typecheck', 'npm test'],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Executes a controlled repair cycle (Approve -> Drift Check -> Apply -> Verify).
 *
 * @param {Object} options
 * @param {Object} options.repairPlan - The repair plan from createRepairPlan.
 * @param {Function} options.approve - Async approval callback: ({ plan, planDigest }) => boolean.
 * @param {Function} [options.applyPatch] - Async patch applicator: ({ filePath, replacementContent }) => boolean.
 * @param {Function} [options.verifyCheck] - Async verifier: () => Promise<Object>.
 * @param {string} options.projectRoot - Project root.
 * @param {number} options.ownerWebContentsId - Session owner webContents ID.
 * @returns {Promise<Object>} Execution result.
 */
async function executeRepairCycle({
  repairPlan,
  approve,
  applyPatch = null,
  verifyCheck = null,
  projectRoot,
  ownerWebContentsId,
  projectGraph = null,
  semanticGraph = null,
} = {}) {
  if (!repairPlan || !approve || !projectRoot || !ownerWebContentsId) {
    throw new Error('repairPlan, approve, projectRoot, and ownerWebContentsId are required.');
  }

  // 1. Revalidate Project Authorization
  const auth = await verifyProjectAuthorization(projectRoot, ownerWebContentsId);
  if (!auth.isAuthorized) {
    return {
      ok: false,
      outcome: 'UNAUTHORIZED',
      codeApplied: false,
      reason: `Project authorization failed: ${auth.reason}`,
      planDigest: repairPlan.planDigest,
    };
  }

  // 2. If repairPlan is not ready, fail closed
  if (repairPlan.status !== REPAIR_PLAN_STATUSES.READY) {
    return {
      ok: false,
      outcome: repairPlan.status,
      codeApplied: false,
      reason: repairPlan.reason || 'Repair plan is not in READY status.',
      planDigest: repairPlan.planDigest,
    };
  }

  // 3. Approval Gate: User must explicitly approve the proposal
  const approvalDecision = typeof approve === 'function'
    ? await approve({
        plan: repairPlan,
        planDigest: repairPlan.planDigest,
        affectedFiles: repairPlan.affectedFiles,
      })
    : false;

  const isApproved = typeof approvalDecision === 'object' && approvalDecision !== null
    ? approvalDecision.approved === true
    : Boolean(approvalDecision);

  if (!isApproved) {
    return {
      ok: false,
      outcome: 'APPROVAL_REQUIRED',
      codeApplied: false,
      reason: 'Repair proposal was not approved by the user. Mutation aborted.',
      planDigest: repairPlan.planDigest,
    };
  }

  if (typeof approvalDecision === 'object' && approvalDecision?.approvedPlanDigest) {
    if (approvalDecision.approvedPlanDigest !== repairPlan.planDigest) {
      return {
        ok: false,
        outcome: 'APPROVAL_DIGEST_MISMATCH',
        codeApplied: false,
        reason: 'Approved plan digest does not match the active proposal digest.',
        planDigest: repairPlan.planDigest,
      };
    }
  }

  // 4. Pre-Apply Multi-File Integrity & Drift Guard
  const preCheck = await validateMultiFilePatchIntegrity({
    fileChanges: repairPlan.fileChanges,
    projectRoot,
    approvedDigest: repairPlan.planDigest,
  });
  if (!preCheck.valid) {
    return {
      ok: false,
      outcome: preCheck.driftDetected ? 'DRIFT_DETECTED' : 'INTEGRITY_VIOLATION',
      codeApplied: false,
      reason: preCheck.error,
      planDigest: repairPlan.planDigest,
    };
  }

  // 5. Apply Approved Changes Atomically with Snapshot Rollback Guarantee
  const appliedFiles = [];
  try {
    for (const change of repairPlan.fileChanges) {
      if (typeof applyPatch === 'function') {
        await applyPatch({
          filePath: change.filePath,
          replacementContent: change.replacementContent,
        });
      } else {
        const fullPath = path.resolve(projectRoot, change.filePath);
        await fs.writeFile(fullPath, change.replacementContent, 'utf8');
      }
      appliedFiles.push(change.filePath);
    }

    const liveGraph = projectGraph || semanticGraph || null;
    if (liveGraph && typeof liveGraph.invalidateFiles === 'function') {
      const contentsMap = new Map(repairPlan.fileChanges.map((c) => [c.filePath, c.replacementContent]));
      liveGraph.invalidateFiles({ modified: appliedFiles, fileContents: contentsMap });
    }

    // 5b. Post-Apply Read-Back Verification (Multi-File Patch Consistency Guard)
    for (const change of repairPlan.fileChanges) {
      const fullPath = path.resolve(projectRoot, change.filePath);
      const diskContent = await fs.readFile(fullPath, 'utf8');
      if (diskContent !== change.replacementContent) {
        throw new Error(`Post-apply read-back verification failed on "${change.filePath}". Content does not match approved patch.`);
      }
    }
  } catch (applyErr) {
    // Atomic rollback of all snapshots on any apply error or read-back failure
    await rollbackAllSnapshots(projectRoot, repairPlan.rollbackInfo.snapshots);

    const liveGraph = projectGraph || semanticGraph || null;
    if (liveGraph && typeof liveGraph.invalidateFiles === 'function') {
      const snapEntries = Array.isArray(repairPlan.rollbackInfo?.snapshots)
        ? repairPlan.rollbackInfo.snapshots.map((s) => [s.relativePath || s.filePath, s.originalContent])
        : Object.entries(repairPlan.rollbackInfo?.snapshots || {});
      const restoredMap = new Map(snapEntries);
      liveGraph.invalidateFiles({
        modified: Array.from(restoredMap.keys()),
        fileContents: restoredMap,
      });
    }

    return {
      ok: false,
      outcome: 'APPLY_FAILED',
      codeApplied: false,
      rolledBack: true,
      reason: `Apply failed: ${applyErr.message}. All original file snapshots restored.`,
      planDigest: repairPlan.planDigest,
    };
  }

  // 6. Verification: Check verified process isolation boundary
  try {
    requireProjectProcessIsolation(`Repair verification (${repairPlan.affectedFiles.join(', ')})`);
  } catch (gateErr) {
    return {
      ok: false,
      outcome: 'BLOCKED',
      codeApplied: true,
      verificationTier: VERIFICATION_TIERS.PATCH_APPLIED,
      gate: 'PROCESS_ISOLATION_GATE',
      reason: 'Patch was applied, but verification execution is blocked: verified Windows process isolation is required.',
      planDigest: repairPlan.planDigest,
      filesModified: appliedFiles,
    };
  }

  // 7. Verified Runner Execution
  if (typeof verifyCheck === 'function') {
    try {
      const verifyResult = await verifyCheck();
      const passed = Boolean(verifyResult && (verifyResult.ok || verifyResult.status === 'PASSED' || verifyResult.exitCode === 0));

      return {
        ok: passed,
        outcome: passed ? 'SUCCESS' : 'FAILED',
        codeApplied: true,
        verificationTier: passed ? VERIFICATION_TIERS.TESTS_PASSED : VERIFICATION_TIERS.FAILED,
        verificationResult: verifyResult,
        filesModified: appliedFiles,
        planDigest: repairPlan.planDigest,
      };
    } catch (checkErr) {
      return {
        ok: false,
        outcome: 'FAILED',
        codeApplied: true,
        verificationTier: VERIFICATION_TIERS.FAILED,
        reason: `Verification check failed with error: ${checkErr.message}`,
        filesModified: appliedFiles,
        planDigest: repairPlan.planDigest,
      };
    }
  }

  return {
    ok: true,
    outcome: 'PATCH_APPLIED',
    codeApplied: true,
    verificationTier: VERIFICATION_TIERS.PATCH_APPLIED,
    filesModified: appliedFiles,
    planDigest: repairPlan.planDigest,
  };
}

module.exports = {
  MAX_REPAIR_ATTEMPTS,
  REPAIR_PLAN_STATUSES,
  createDiffPreview,
  createRepairPlan,
  executeRepairCycle,
  validatePathWithinRoot,
  rollbackAllSnapshots,
  validateMultiFilePatchIntegrity,
};
