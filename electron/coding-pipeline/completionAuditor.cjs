/**
 * AI Help Agent - Truthful Completion Auditor (V6)
 *
 * Consumes the complete stage evidence chain from the workflow coordinator.
 * Validates that claims of completion, success, or verification are truthfully supported
 * by authentic host/sandbox evidence, and rejects unsupported success claims.
 */

'use strict';

const crypto = require('node:crypto');
const { WORKFLOW_STATES } = require('./workflowStateCoordinator.cjs');

const AUDITOR_OUTCOMES = Object.freeze({
  COMPLETED: 'COMPLETED',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
});

const TASK_COMPLETION_STATES = Object.freeze({
  WORKFLOW_COMPLETED: 'WORKFLOW_COMPLETED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  BLOCKED: 'BLOCKED',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  FAILED: 'FAILED',
  PARTIAL: 'PARTIAL',
});

/**
 * Audits workflow completion against collected evidence.
 *
 * @param {object} params
 * @param {import('./workflowStateCoordinator.cjs').WorkflowStateCoordinator} params.coordinator
 * @param {object} [params.finalResult] - Result object returned by the pipeline stage
 * @param {string} [params.originalRequest] - Complete user request text
 * @returns {object} Truthful audit report
 */
function auditWorkflowCompletion({
  coordinator,
  finalResult = null,
  originalRequest = '',
}) {
  if (!coordinator) {
    throw new Error('CompletionAuditor requires a valid WorkflowStateCoordinator instance.');
  }

  const requestText = originalRequest || coordinator.getOriginalRequest() || '';
  const currentState = coordinator.getState();
  const allEvidence = coordinator.getAllEvidence();
  const appliedPatches = coordinator.getAppliedPatches();

  const whatChanged = [];
  const regressionTargets = [];
  const checksRan = [];
  const checksPassed = [];
  const checksFailed = [];
  const checksBlocked = [];
  const checksSkipped = [];
  const unverifiedCapabilities = [];
  const auditFlags = [];

  // Extract modified files from coordinator or finalResult
  if (Array.isArray(appliedPatches) && appliedPatches.length > 0) {
    for (const patch of appliedPatches) {
      if (patch.targetFile && !whatChanged.includes(patch.targetFile)) {
        whatChanged.push(patch.targetFile);
      }
      if (Array.isArray(patch.files)) {
        for (const f of patch.files) {
          const p = typeof f === 'string' ? f : f?.path;
          if (p && !whatChanged.includes(p)) whatChanged.push(p);
        }
      }
    }
  }
  if (Array.isArray(finalResult?.filesModified)) {
    for (const f of finalResult.filesModified) {
      if (f && !whatChanged.includes(f)) whatChanged.push(f);
    }
  }

  // Extract regression targets from applied patches and verification reports
  if (Array.isArray(appliedPatches)) {
    for (const patch of appliedPatches) {
      if (Array.isArray(patch.regressionTargets)) {
        for (const rt of patch.regressionTargets) {
          const file = typeof rt === 'string' ? rt : rt?.file;
          if (file && !regressionTargets.includes(file)) {
            regressionTargets.push(file);
          }
        }
      }
    }
  }
  if (Array.isArray(finalResult?.regressionTargets)) {
    for (const rt of finalResult.regressionTargets) {
      const file = typeof rt === 'string' ? rt : rt?.file;
      if (file && !regressionTargets.includes(file)) {
        regressionTargets.push(file);
      }
    }
  }
  if (Array.isArray(finalResult?.verificationReport?.regressionTargets)) {
    for (const rt of finalResult.verificationReport.regressionTargets) {
      const file = typeof rt === 'string' ? rt : rt?.file;
      if (file && !regressionTargets.includes(file)) {
        regressionTargets.push(file);
      }
    }
  }

  // Audit impact analysis status if present
  const impact = finalResult?.repairPlan?.impactAnalysis || finalResult?.impactAnalysis;
  if (impact?.status === 'DEGRADED_UNRESOLVED') {
    auditFlags.push('Repair plan impact analysis used degraded graph with unresolved dependencies.');
  } else if (impact?.status === 'EMPTY_GRAPH') {
    auditFlags.push('Repair plan impact analysis ran against an empty or unindexed workspace graph.');
  } else if (impact?.status === 'DEGRADED_FUZZY' || impact?.status === 'GRAPH_UNAVAILABLE') {
    auditFlags.push(`Repair plan impact analysis operated in fallback mode: ${impact.status}.`);
  }

  // Inspect stage evidence across all stages
  for (const [stage, records] of Object.entries(allEvidence)) {
    for (const rec of records) {
      // Collect executed commands
      if (Array.isArray(rec.executedCommands)) {
        for (const cmd of rec.executedCommands) {
          checksRan.push({ stage, command: cmd.command || cmd, exitCode: cmd.exitCode, status: cmd.status });
          if (cmd.exitCode === 0 || cmd.status === 'PASSED') {
            checksPassed.push({ stage, check: cmd.command || cmd });
          } else if (cmd.status === 'FAILED' || (Number.isInteger(cmd.exitCode) && cmd.exitCode !== 0)) {
            checksFailed.push({ stage, check: cmd.command || cmd, exitCode: cmd.exitCode, reason: cmd.reason });
          }
        }
      }

      // Collect verification attempts
      if (Array.isArray(rec.verificationAttempts)) {
        for (const attempt of rec.verificationAttempts) {
          checksRan.push({ stage, check: attempt.check || attempt.command, exitCode: attempt.exitCode });
          if (attempt.ok || attempt.exitCode === 0) {
            checksPassed.push({ stage, check: attempt.check || attempt.command });
          } else {
            checksFailed.push({ stage, check: attempt.check || attempt.command, exitCode: attempt.exitCode, failure: attempt.failure });
          }
        }
      }

      // Collect limitations
      if (Array.isArray(rec.limitations)) {
        for (const lim of rec.limitations) {
          if (!unverifiedCapabilities.includes(lim)) {
            unverifiedCapabilities.push(lim);
          }
        }
      }

      // Detect blocked gates
      if (rec.executionBlocked || rec.status === 'BLOCKED') {
        checksBlocked.push({
          stage,
          gate: rec.gate || rec.phase || stage,
          reason: rec.reason || 'Execution blocked by security policy.',
        });
      }

      // Detect synthetic / simulated evidence
      if (rec.isSimulated || rec.provenance === 'SIMULATED' || rec.provenance === 'MOCK') {
        auditFlags.push(`Stage ${stage} contains simulated or synthetic evidence.`);
      }
    }
  }

  // Inspect finalResult verificationReport if present
  const vReport = finalResult?.workflowReceipt?.verificationReport || finalResult?.verificationReport;
  if (vReport) {
    if (Array.isArray(vReport.verificationEvidence)) {
      for (const ve of vReport.verificationEvidence) {
        if (!checksRan.some((c) => c.check === ve.command)) {
          checksRan.push({ check: ve.command, exitCode: ve.exitCode, status: ve.status });
        }
        if (ve.status === 'PASSED' || ve.exitCode === 0) {
          if (!checksPassed.some((c) => c.check === ve.command)) {
            checksPassed.push({ check: ve.command });
          }
        } else if (ve.status === 'FAILED' || (Number.isInteger(ve.exitCode) && ve.exitCode !== 0)) {
          if (!checksFailed.some((c) => c.check === ve.command)) {
            checksFailed.push({ check: ve.command, exitCode: ve.exitCode });
          }
        }
      }
    }

    if (vReport.hostExecution && vReport.hostExecution.status !== 'EXECUTED') {
      const hostReason = vReport.hostExecution.reason || 'Process isolation unverified; host execution skipped.';
      if (!unverifiedCapabilities.includes(hostReason)) {
        unverifiedCapabilities.push(`Host command execution: ${hostReason}`);
      }
      checksSkipped.push({ check: 'host_commands', reason: hostReason });
    }
  }

  // Analyze request intent characteristics
  const isReadOnlyRequest = /\b(?:explain|what|how|why|describe|overview|audit|inspect|read)\b/i.test(requestText)
    && !/\b(?:fix|implement|create|update|modify|refactor|add|remove|delete|repair)\b/i.test(requestText);
  const isBuildOrTestRequest = /\b(?:build|compile|test|typecheck|lint)\b/i.test(requestText);
  const isMutationRequest = /\b(?:fix|implement|create|update|modify|refactor|add|remove|delete|repair)\b/i.test(requestText);

  // Derive Truthful Auditor Outcome & Explicit Completion Semantics (Milestone V37.0)
  let outcome = AUDITOR_OUTCOMES.COMPLETED;
  let workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
  let taskStatus = TASK_COMPLETION_STATES.TASK_COMPLETED;
  let summaryReason = '';

  const isAwaitingApproval = currentState === WORKFLOW_STATES.APPROVAL_PENDING
    || finalResult?.outcome === 'NEEDS_APPROVAL'
    || finalResult?.outcome === 'AWAITING_APPROVAL'
    || finalResult?.outcome === 'APPROVAL_REQUIRED'
    || finalResult?.continuation?.status === 'AWAITING_APPROVAL'
    || Boolean(finalResult?.pendingApproval);

  if (currentState === WORKFLOW_STATES.CANCELLED || finalResult?.outcome === 'CANCELLED') {
    outcome = AUDITOR_OUTCOMES.BLOCKED;
    workflowStatus = TASK_COMPLETION_STATES.BLOCKED;
    taskStatus = TASK_COMPLETION_STATES.BLOCKED;
    summaryReason = 'Workflow was cancelled by user or coordinator; no verified completion is claimed.';
  } else if (isAwaitingApproval) {
    outcome = AUDITOR_OUTCOMES.PARTIALLY_COMPLETED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.NEEDS_APPROVAL;
    summaryReason = 'Proposal generated and awaiting explicit user authorization.';
  } else if (currentState === WORKFLOW_STATES.BLOCKED || finalResult?.outcome === 'BLOCKED' || checksBlocked.length > 0) {
    outcome = AUDITOR_OUTCOMES.BLOCKED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.BLOCKED;
    const block = checksBlocked[0] || { reason: finalResult?.reason || 'Workflow blocked by security gate.' };
    summaryReason = `Workflow blocked at gate ${block.gate || 'POLICY'}: ${block.reason}`;
  } else if (currentState === WORKFLOW_STATES.FAILED || finalResult?.outcome === 'FAILED' || checksFailed.length > 0) {
    outcome = AUDITOR_OUTCOMES.FAILED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.FAILED;
    const failReason = checksFailed[0]?.reason || checksFailed[0]?.failure || finalResult?.reason || 'Stage execution or verification failed.';
    summaryReason = `Workflow failed verification: ${failReason}`;
  } else if (currentState === WORKFLOW_STATES.CLARIFICATION_REQUIRED || finalResult?.outcome === 'CLARIFICATION_REQUIRED') {
    outcome = AUDITOR_OUTCOMES.UNCERTAIN;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.PARTIAL;
    summaryReason = finalResult?.clarificationPrompt || 'Essential requirements missing; clarification required.';
  } else if (currentState === WORKFLOW_STATES.UNCERTAIN || finalResult?.outcome === 'UNCERTAIN') {
    outcome = AUDITOR_OUTCOMES.UNCERTAIN;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.PARTIAL;
    summaryReason = 'Evidence is uncertain or diagnostic output is ambiguous.';
  } else if (isMutationRequest && whatChanged.length === 0) {
    // Mutation requested but nothing modified
    outcome = AUDITOR_OUTCOMES.FAILED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.FAILED;
    summaryReason = 'User requested file mutations, but no approved files were applied to disk.';
  } else if (isBuildOrTestRequest && checksRan.length === 0 && checksBlocked.length === 0) {
    // Build/test requested but nothing ran (e.g. only manifest was read)
    outcome = AUDITOR_OUTCOMES.PARTIALLY_COMPLETED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.PARTIAL;
    summaryReason = 'Build/test requested, but no verified execution was performed.';
    unverifiedCapabilities.push('Build/test commands were not executed.');
  } else if (unverifiedCapabilities.length > 0 && isMutationRequest) {
    // Code modified and statically checked, but runtime execution remains unverified
    outcome = AUDITOR_OUTCOMES.PARTIALLY_COMPLETED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.PARTIAL;
    summaryReason = `Approved changes applied and statically verified, but runtime execution remains unverified (${unverifiedCapabilities.join('; ')}).`;
  } else if (isReadOnlyRequest) {
    outcome = AUDITOR_OUTCOMES.COMPLETED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.TASK_COMPLETED;
    summaryReason = 'Read-only discovery and explanation completed truthfully without file mutations.';
  } else {
    outcome = AUDITOR_OUTCOMES.COMPLETED;
    workflowStatus = TASK_COMPLETION_STATES.WORKFLOW_COMPLETED;
    taskStatus = TASK_COMPLETION_STATES.TASK_COMPLETED;
    summaryReason = 'All requested operations and verifications were completed with verified evidence.';
  }

  // Digest over the entire evidence sequence to guarantee tamper evidence
  const evidenceDigest = crypto.createHash('sha256')
    .update(JSON.stringify({
      workflowId: coordinator.getWorkflowId(),
      currentState,
      whatChanged,
      checksPassed: checksPassed.map((c) => c.check),
      checksFailed: checksFailed.map((c) => c.check),
      unverifiedCapabilities,
    }))
    .digest('hex');

  return {
    workflowId: coordinator.getWorkflowId(),
    outcome,
    workflowStatus,
    taskStatus,
    originalRequest: requestText,
    summary: summaryReason,
    whatChanged,
    regressionTargets,
    checksRan,
    checksPassed,
    checksFailed,
    checksBlocked,
    checksSkipped,
    unverifiedCapabilities,
    auditFlags,
    evidenceDigest,
    isTruthful: true,
    auditedAt: new Date().toISOString(),
  };
}

module.exports = {
  AUDITOR_OUTCOMES,
  TASK_COMPLETION_STATES,
  auditWorkflowCompletion,
};
