/**
 * Stage 18: Engineering Quality + Independent Correctness Engine.
 * 
 * Provides:
 * 1. Independent Correctness Oracle (Hidden validation, behavior over patch matching)
 * 2. Patch Quality Engine (Minimality, scope, dead-code & formatting penalties)
 * 3. Independent Diff Reviewer (Second review pass, disagreement detection)
 * 4. Mutation Testing Harness (Buggy baseline verification, mutation resistance)
 * 5. Defect & Environment Classifier (False-failure vs false-success diagnostics)
 * 6. Edge-Case & Contract Preservation Inspector
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class IndependentCorrectnessOracle {
  constructor() {
    // taskId -> HiddenContract
    // CRITICAL: Hidden contracts are kept strictly inside the evaluator and NEVER leaked to the agent.
    this._hiddenContracts = new Map();
  }

  defineHiddenContract(taskId, contract = {}) {
    if (!taskId) return false;
    this._hiddenContracts.set(taskId, {
      taskId,
      hiddenAssertions: Array.isArray(contract.hiddenAssertions) ? contract.hiddenAssertions : [],
      expectedBehavior: typeof contract.expectedBehavior === 'function' ? contract.expectedBehavior : null,
      forbiddenModifications: Array.isArray(contract.forbiddenModifications) ? contract.forbiddenModifications : [],
      regressionInvariants: Array.isArray(contract.regressionInvariants) ? contract.regressionInvariants : [],
      securityRequirements: Array.isArray(contract.securityRequirements) ? contract.securityRequirements : [],
      allowedTargetScope: Array.isArray(contract.allowedTargetScope) ? contract.allowedTargetScope : [],
      definedAt: new Date().toISOString(),
    });
    return true;
  }

  hasHiddenContract(taskId) {
    return this._hiddenContracts.has(taskId);
  }

  async evaluateIndependentCorrectness(taskId, patchPayload = {}, workspaceContext = {}) {
    const contract = this._hiddenContracts.get(taskId);
    if (!contract) {
      // If no hidden contract registered, fallback to standard verification checks
      return {
        hasHiddenContract: false,
        passed: true,
        behavioralCorrectness: true,
        hiddenTestPassRate: 1.0,
        regressionPassRate: 1.0,
        securityPassRate: 1.0,
        violations: [],
      };
    }

    const violations = [];
    let hiddenTestsPassed = 0;
    const hiddenTestsTotal = contract.hiddenAssertions.length;

    // 1. Evaluate Hidden Assertions
    for (const assertion of contract.hiddenAssertions) {
      try {
        const res = await assertion(workspaceContext);
        if (res && res.pass) {
          hiddenTestsPassed++;
        } else {
          violations.push(res?.reason || `Hidden assertion '${res?.testName || 'unnamed'}' failed.`);
        }
      } catch (err) {
        violations.push(`Hidden assertion threw exception: ${err.message}`);
      }
    }

    // 2. Evaluate Expected Behavior (Behavior over patch matching)
    let behavioralCorrectness = true;
    if (contract.expectedBehavior) {
      try {
        const bRes = await contract.expectedBehavior(workspaceContext);
        if (!bRes || !bRes.pass) {
          behavioralCorrectness = false;
          violations.push(bRes?.reason || 'Observable runtime behavior failed to satisfy contract.');
        }
      } catch (err) {
        behavioralCorrectness = false;
        violations.push(`Behavioral evaluation threw exception: ${err.message}`);
      }
    }

    // 3. Evaluate Forbidden Modifications & Scope
    const modifiedFiles = Array.isArray(patchPayload.modifiedFiles) ? patchPayload.modifiedFiles : [];
    for (const file of modifiedFiles) {
      const normalized = file.replace(/\\/g, '/');
      const isForbidden = contract.forbiddenModifications.some((pattern) => {
        const normPat = pattern.replace(/\\/g, '/');
        return normalized.includes(normPat) || normPat.includes(normalized);
      });
      if (isForbidden) {
        violations.push(`Forbidden file modification detected: ${file}`);
      }

      if (contract.allowedTargetScope.length > 0) {
        const inScope = contract.allowedTargetScope.some((allowed) => {
          const normAllowed = allowed.replace(/\\/g, '/');
          return normalized.includes(normAllowed) || normAllowed.includes(normalized);
        });
        if (!inScope) {
          violations.push(`Out-of-scope file modification detected: ${file}`);
        }
      }
    }

    // 4. Evaluate Regression Invariants
    let regressionPassed = true;
    for (const invariant of contract.regressionInvariants) {
      try {
        const invRes = await invariant(workspaceContext);
        if (!invRes || !invRes.pass) {
          regressionPassed = false;
          violations.push(invRes?.reason || 'Pre-existing behavioral regression invariant violated.');
        }
      } catch (err) {
        regressionPassed = false;
        violations.push(`Regression invariant evaluation error: ${err.message}`);
      }
    }

    // 5. Evaluate Security Requirements
    let securityPassed = true;
    for (const secCheck of contract.securityRequirements) {
      try {
        const secRes = await secCheck(patchPayload, workspaceContext);
        if (!secRes || !secRes.pass) {
          securityPassed = false;
          violations.push(secRes?.reason || 'Security requirement breached.');
        }
      } catch (err) {
        securityPassed = false;
        violations.push(`Security check error: ${err.message}`);
      }
    }

    const hiddenPassRate = hiddenTestsTotal > 0 ? hiddenTestsPassed / hiddenTestsTotal : 1.0;
    const passed = violations.length === 0 && behavioralCorrectness && regressionPassed && securityPassed;

    return {
      hasHiddenContract: true,
      passed,
      behavioralCorrectness,
      hiddenTestsPassed,
      hiddenTestsTotal,
      hiddenTestPassRate: Number(hiddenPassRate.toFixed(3)),
      regressionPassed,
      securityPassed,
      violations,
    };
  }

  clearHiddenContract(taskId) {
    this._hiddenContracts.delete(taskId);
  }
}

class PatchQualityEngine {
  evaluatePatchQuality(diffText = '', modifiedFiles = [], targetScope = []) {
    const rawLines = String(diffText || '').split('\n');
    let linesAdded = 0;
    let linesRemoved = 0;
    const penalties = [];
    const unnecessaryChanges = [];

    const normScope = targetScope.map((s) => s.replace(/\\/g, '/').toLowerCase());

    for (const line of rawLines) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
      if (line.startsWith('+')) {
        linesAdded++;
        // Check for dead code or suspicious patterns
        if (/\/\/\s*TODO\s*remove/i.test(line) || /debugger;/i.test(line) || /console\.log\(["']test/i.test(line)) {
          penalties.push({ type: 'DEAD_OR_DEBUG_CODE', line: line.trim(), penalty: 0.1 });
        }
      } else if (line.startsWith('-')) {
        linesRemoved++;
      }
    }

    // Check scope minimality
    const unrelatedFiles = [];
    for (const f of modifiedFiles) {
      const normF = f.replace(/\\/g, '/').toLowerCase();
      if (normScope.length > 0 && !normScope.some((s) => normF.includes(s) || s.includes(normF))) {
        unrelatedFiles.push(f);
        penalties.push({ type: 'OUT_OF_SCOPE_FILE', file: f, penalty: 0.25 });
        unnecessaryChanges.push(`File ${f} is outside the intended target scope.`);
      }
    }

    // Formatting-only churn check
    if (linesAdded > 0 && linesRemoved > 0 && Math.abs(linesAdded - linesRemoved) < 2) {
      const addedText = rawLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).join('');
      const removedText = rawLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim()).join('');
      if (addedText === removedText && addedText.length > 0) {
        penalties.push({ type: 'FORMATTING_CHURN_ONLY', penalty: 0.15 });
        unnecessaryChanges.push('Patch contains whitespace or formatting changes without AST behavioral change.');
      }
    }

    const totalLinesChanged = linesAdded + linesRemoved;
    const totalPenalty = penalties.reduce((sum, p) => sum + p.penalty, 0);
    const baseScore = Math.max(0, 1 - totalPenalty);

    // Minimality ratio: reward targeted concise changes over broad rewrites
    const minimalityRatio = totalLinesChanged > 0
      ? Number(Math.max(0.1, Math.min(1.0, 1 - (unrelatedFiles.length * 0.3) - (totalPenalty * 0.5))).toFixed(3))
      : 1.0;

    const finalScore = Number(Math.max(0, Math.min(1.0, baseScore * minimalityRatio)).toFixed(3));

    return {
      passed: finalScore >= 0.7 && unrelatedFiles.length === 0,
      score: finalScore,
      minimalityRatio,
      filesChanged: modifiedFiles.length,
      linesAdded,
      linesRemoved,
      totalLinesChanged,
      unrelatedFiles,
      unnecessaryChanges,
      penalties,
    };
  }
}

class IndependentDiffReviewer {
  reviewDiffIndependently(diffText = '', taskGoal = '', modifiedFiles = []) {
    const findings = {
      whatChanged: [],
      why: '',
      risks: [],
      whatIsMissing: [],
      whatIsUnnecessary: [],
      disagreementDetected: false,
      approved: false,
    };

    const text = String(diffText || '');
    const goal = String(taskGoal || '').toLowerCase();

    // 1. Analyze What Changed
    for (const f of modifiedFiles) {
      findings.whatChanged.push(`Modified file ${path.basename(f)}`);
    }

    // 2. Analyze Rationale
    findings.why = `Change addresses goal: "${taskGoal.slice(0, 120)}"`;

    // 3. Analyze Potential Risks (Independent adversarial checks)
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(text)) {
      findings.risks.push('Silent catch block detected: swallows errors without logging or rethrowing.');
    }
    if (/==\s*null|null\s*==/.test(text) && !/===/.test(text)) {
      findings.risks.push('Loose null comparison detected where strict equality or explicit check is preferred.');
    }
    if (/process\.env\.[A-Z0-9_]+/i.test(text) && !/(?:\|\||\?\?)\s*['"]/.test(text)) {
      findings.risks.push('Environment variable accessed without fallback default value.');
    }

    // 4. Missing Requirements Check
    if (goal.includes('error') && !text.includes('throw') && !text.includes('Error') && !text.includes('err')) {
      findings.whatIsMissing.push('Goal mentions error handling, but diff contains no error construction or propagation.');
    }
    if (goal.includes('timeout') && !text.includes('timeout') && !text.includes('Timeout')) {
      findings.whatIsMissing.push('Goal specifies timeout handling, but diff lacks timeout logic.');
    }

    // 5. Evaluate Disagreement
    if (findings.risks.length > 1 || findings.whatIsMissing.length > 0) {
      findings.disagreementDetected = true;
      findings.approved = false;
      findings.recommendation = 'Collect additional evidence or address risks before approving change.';
    } else {
      findings.disagreementDetected = false;
      findings.approved = true;
      findings.recommendation = 'Diff review passes independent correctness and risk inspection.';
    }

    return findings;
  }
}

class MutationTestingHarness {
  async verifyBuggyBaselineFails(testRunnerFn, testContext) {
    try {
      const res = await testRunnerFn(testContext);
      const failed = res && (res.pass === false || res.ok === false || res.failed === true || res.exitCode !== 0);
      return {
        verifiedFailingOnBaseline: failed,
        output: res?.output || res?.error || (failed ? 'Baseline failed as expected' : 'Baseline unexpectedly passed'),
      };
    } catch (err) {
      return {
        verifiedFailingOnBaseline: true,
        output: err.message,
      };
    }
  }

  async verifyMutationCatchesFault(repairedRunnerFn, mutationFn, testRunnerFn, context) {
    // 1. Verify repaired logic currently passes
    const preRes = await testRunnerFn(context);
    const prePassed = preRes && (preRes.pass === true || preRes.ok === true || preRes.exitCode === 0);
    if (!prePassed) {
      return {
        mutationCaught: false,
        mutationResistanceVerified: false,
        reason: 'Repaired implementation does not pass baseline tests before mutation.',
      };
    }

    // 2. Apply mutation
    let mutationRevertFn = null;
    try {
      mutationRevertFn = await mutationFn(context);
    } catch (err) {
      return {
        mutationCaught: false,
        mutationResistanceVerified: false,
        reason: `Failed to apply mutation: ${err.message}`,
      };
    }

    // 3. Verify test FAILS on mutated logic
    let mutatedFailed = false;
    try {
      const mutRes = await testRunnerFn(context);
      mutatedFailed = mutRes && (mutRes.pass === false || mutRes.ok === false || mutRes.exitCode !== 0);
    } catch {
      mutatedFailed = true;
    }

    // 4. Revert mutation safely
    if (typeof mutationRevertFn === 'function') {
      try {
        await mutationRevertFn();
      } catch {}
    }

    return {
      mutationCaught: mutatedFailed,
      mutationResistanceVerified: mutatedFailed,
      reason: mutatedFailed
        ? 'Test successfully caught mutated faulty behavior.'
        : 'Test failed to catch mutant: regression protection is weak.',
    };
  }
}

class DefectEnvironmentClassifier {
  diagnoseFailureType(errorOutput = '', exitCode = 1, environmentState = {}) {
    const text = String(errorOutput || '').toLowerCase();

    // Check False-Failure (Environment issues)
    const isPortCollision = /eaddrinuse|address already in use|port \d+ is already in use/i.test(text);
    const isMissingTool = /command not found|is not recognized as an internal or external command|no such file or directory: '.*bin'/i.test(text);
    const isNetworkDrop = /econnrefused|etimedout|getaddrinfo enotfound|socket hang up/i.test(text);
    const isPermissionLock = /ebusy|eperm|resource locked|access is denied/i.test(text);

    if (isPortCollision || isMissingTool || isNetworkDrop || isPermissionLock) {
      return {
        classification: 'FALSE_FAILURE_ENVIRONMENT',
        isCodeDefect: false,
        isEnvironmentIssue: true,
        reason: isPortCollision ? 'Port conflict in environment' : isMissingTool ? 'Host command unavailable' : isNetworkDrop ? 'Network unreachable' : 'File permission lock',
        recommendedAction: 'Remediate host environment, do NOT alter correct source code.',
      };
    }

    // Check False-Success (Unit test passed superficially, but behavioral oracle failed)
    if (environmentState.unitTestsPassed === true && environmentState.behavioralContractPassed === false) {
      return {
        classification: 'FALSE_SUCCESS_SUPERFICIAL',
        isCodeDefect: true,
        isEnvironmentIssue: false,
        reason: 'Superficial unit tests passed, but independent behavioral contract failed.',
        recommendedAction: 'Investigate deep contract requirements, do not declare success.',
      };
    }

    // Check Test Defect
    if (text.includes('assertionerror') && (text.includes('expected 200 to be 500') || text.includes('contradictory expectation'))) {
      return {
        classification: 'TEST_DEFECT',
        isCodeDefect: false,
        isEnvironmentIssue: false,
        reason: 'Test assertion itself is contradictory or defective.',
        recommendedAction: 'Correct the invalid test assertion.',
      };
    }

    // Genuine Implementation Defect
    return {
      classification: 'IMPLEMENTATION_DEFECT',
      isCodeDefect: true,
      isEnvironmentIssue: false,
      reason: 'Application code failed behavioral or syntax expectation.',
      recommendedAction: 'Implement targeted code fix within target scope.',
    };
  }
}

class EdgeCaseContractValidator {
  identifyEdgeCaseRequirements(symbolInfo = {}) {
    const cases = [];
    const params = Array.isArray(symbolInfo.parameters) ? symbolInfo.parameters : [];

    for (const p of params) {
      cases.push({ parameter: p.name || 'arg', testCase: 'null', input: null, reason: 'Verify null safety' });
      cases.push({ parameter: p.name || 'arg', testCase: 'undefined', input: undefined, reason: 'Verify undefined safety' });
      if (p.type === 'string' || p.name?.toLowerCase().includes('str') || p.name?.toLowerCase().includes('text')) {
        cases.push({ parameter: p.name, testCase: 'empty_string', input: '', reason: 'Verify empty string handling' });
        cases.push({ parameter: p.name, testCase: 'whitespace_only', input: '   ', reason: 'Verify whitespace trimming' });
      }
      if (p.type === 'number' || p.name?.toLowerCase().includes('num') || p.name?.toLowerCase().includes('count')) {
        cases.push({ parameter: p.name, testCase: 'zero', input: 0, reason: 'Verify zero boundary' });
        cases.push({ parameter: p.name, testCase: 'negative', input: -1, reason: 'Verify negative input guard' });
      }
      if (p.type === 'array' || p.name?.toLowerCase().includes('list') || p.name?.toLowerCase().includes('items')) {
        cases.push({ parameter: p.name, testCase: 'empty_array', input: [], reason: 'Verify empty list handling' });
        cases.push({ parameter: p.name, testCase: 'duplicate_entries', input: ['a', 'a'], reason: 'Verify deduplication' });
      }
    }

    return cases;
  }

  verifyContractPreservation(symbolName, preInterface = {}, postInterface = {}) {
    const breakingChanges = [];

    const preParams = preInterface.parameters || [];
    const postParams = postInterface.parameters || [];

    // Check if any mandatory parameter was removed or added without a default
    for (let i = 0; i < preParams.length; i++) {
      const preP = preParams[i];
      const postP = postParams.find((p) => p.name === preP.name);
      if (!postP) {
        breakingChanges.push(`Parameter '${preP.name}' was removed from symbol '${symbolName}'.`);
      }
    }

    for (const postP of postParams) {
      const preP = preParams.find((p) => p.name === postP.name);
      if (!preP && !postP.optional && postP.defaultValue === undefined) {
        breakingChanges.push(`New mandatory parameter '${postP.name}' added to '${symbolName}' without default value.`);
      }
    }

    return {
      preserved: breakingChanges.length === 0,
      breakingChanges,
    };
  }
}

class BlindnessIsolationGuard {
  verifyTaskBlindness(task = {}, hiddenContract = null) {
    const leaks = [];
    if (!task) return { isClean: true, leakageCount: 0, leaks: [] };

    // 1. Check direct properties
    const forbiddenProps = ['hiddenContract', 'hiddenAssertions', 'expectedBehavior', 'oracleInternals'];
    for (const prop of forbiddenProps) {
      if (task[prop] !== undefined) {
        leaks.push({ type: 'PROPERTY_LEAK', property: prop });
      }
    }

    // 2. Check findings and hypotheses for leaked contract phrases
    if (hiddenContract && Array.isArray(hiddenContract.hiddenAssertions)) {
      const allText = [
        ...(task.findings || []),
        ...(task.evidence || []),
        ...(task.hypotheses || []),
        task.goal || '',
      ].join(' ').toLowerCase();

      for (const assertion of hiddenContract.hiddenAssertions) {
        if (typeof assertion.testName === 'string' && assertion.testName.length > 5) {
          if (allText.includes(assertion.testName.toLowerCase())) {
            leaks.push({ type: 'TEST_NAME_LEAK', name: assertion.testName });
          }
        }
      }
    }

    return {
      isClean: leaks.length === 0,
      leakageCount: leaks.length,
      leaks,
    };
  }

  attemptOracleDiscovery(taskId, publicApiObject = {}) {
    // Audit check: verify public API refuses to disclose hidden oracle contracts
    const hasHiddenGetter = typeof publicApiObject.getHiddenContract === 'function';
    let task = null;
    try {
      task = typeof publicApiObject.getTask === 'function' ? publicApiObject.getTask(taskId) : null;
    } catch {
      task = null;
    }
    const directAccess = task ? task.hiddenAssertions || task.hiddenContract : null;

    return {
      accessBlocked: !hasHiddenGetter && !directAccess,
      directAccessDetected: Boolean(directAccess),
      compromised: Boolean(hasHiddenGetter || directAccess),
    };
  }
}

class WorkerConflictAdjudicator {
  adjudicateConflict(workerA = {}, workerB = {}, repositoryEvidence = {}) {
    const findingsA = Array.isArray(workerA.findings) ? workerA.findings : [];
    const findingsB = Array.isArray(workerB.findings) ? workerB.findings : [];

    // Conflict detection: do they propose contradictory root causes or targets?
    const targetA = workerA.targetFile || workerA.scope;
    const targetB = workerB.targetFile || workerB.scope;

    const conflictDetected = Boolean(targetA && targetB && targetA !== targetB);

    if (!conflictDetected) {
      return {
        conflictDetected: false,
        adjudicated: true,
        winningWorkerId: workerA.workerId || 'workerA',
        rationale: 'No target conflict between parallel workers.',
      };
    }

    // Score based on empirical evidence strength rather than first-answer-wins
    const evidenceList = Array.isArray(repositoryEvidence.evidence) ? repositoryEvidence.evidence : [];
    const evidenceText = evidenceList.join(' ').toLowerCase();

    const scoreEvidence = (worker) => {
      let score = 0;
      const target = String(worker.targetFile || worker.scope || '').toLowerCase();
      if (evidenceText.includes(target)) score += 2.0; // Direct evidence match
      if (worker.hasStacktrace) score += 1.5;
      if (worker.hasTestProof) score += 2.0;
      if (worker.findings && worker.findings.length > 0) score += 0.5;
      return score;
    };

    const scoreA = scoreEvidence(workerA);
    const scoreB = scoreEvidence(workerB);

    const winningWorker = scoreA >= scoreB ? workerA : workerB;
    const losingWorker = scoreA >= scoreB ? workerB : workerA;

    return {
      conflictDetected: true,
      adjudicated: true,
      winningWorkerId: winningWorker.workerId || (scoreA >= scoreB ? 'workerA' : 'workerB'),
      winningTarget: winningWorker.targetFile || winningWorker.scope,
      losingWorkerId: losingWorker.workerId || (scoreA >= scoreB ? 'workerB' : 'workerA'),
      scores: { scoreA, scoreB },
      rationale: `Evidence-based adjudication selected ${winningWorker.workerId} (score: ${Math.max(scoreA, scoreB)}) over ${losingWorker.workerId} (score: ${Math.min(scoreA, scoreB)}) based on verifiable repository evidence.`,
    };
  }
}

class RealityLevelEvaluator {
  classifyRealityLevel(executionTrace = {}) {
    // Reality levels hierarchy:
    // L0 = helper/unit
    // L1 = orchestrator
    // L2 = production API / IPC
    // L3 = production runtime (real lifecycle apply)
    // L4 = real provider (LLM tool loop)
    // L5 = real repository (multi-file causal tracing)
    // L6 = live browser (real DOM/visual interaction)
    // L7 = restart/recovery (process termination & resume)
    // L8 = independent hidden oracle validation

    let level = 'L0';
    let levelName = 'HELPER_UNIT';
    const capabilities = [];

    if (executionTrace.hasOrchestrator) {
      level = 'L1';
      levelName = 'ORCHESTRATOR';
      capabilities.push('task_orchestration');
    }
    if (executionTrace.hasIpcGateway) {
      level = 'L2';
      levelName = 'PRODUCTION_API';
      capabilities.push('typed_ipc');
    }
    if (executionTrace.hasProductionLifecycle) {
      level = 'L3';
      levelName = 'PRODUCTION_RUNTIME';
      capabilities.push('lifecycle_apply_verify');
    }
    if (executionTrace.hasRealProvider) {
      level = 'L4';
      levelName = 'REAL_PROVIDER';
      capabilities.push('live_llm_tool_loop');
    }
    if (executionTrace.hasRealRepository) {
      level = 'L5';
      levelName = 'REAL_REPOSITORY';
      capabilities.push('multi_file_causal_tracing');
    }
    if (executionTrace.hasLiveBrowser) {
      level = 'L6';
      levelName = 'LIVE_BROWSER';
      capabilities.push('browser_interaction');
    }
    if (executionTrace.hasProcessRestart) {
      level = 'L7';
      levelName = 'RESTART_RECOVERY';
      capabilities.push('disk_checkpoint_restart');
    }
    if (executionTrace.hasHiddenOracle) {
      level = 'L8';
      levelName = 'INDEPENDENT_ORACLE';
      capabilities.push('hidden_behavioral_validation');
    }

    return {
      realityLevel: level,
      levelName,
      confidence: ['L5', 'L7', 'L8'].includes(level) ? 'HIGH' : 'MEDIUM',
      verifiedCapabilities: capabilities,
    };
  }
}

class BusinessTruthRevalidationEngine {
  constructor() {
    this._revalidatedTasks = new Map();
  }

  async revalidateTask(taskDef = {}) {
    const {
      taskId,
      goal,
      businessIntent,
      buggyBaselineRunner,
      patchedRunner,
      mutationRunner,
      visibleTestRunner,
      businessValidator,
      regressionValidator,
      isMockOnly = false,
      isPassiveAssertionOnly = false,
      infraBlocked = false,
      infraBlockedReason = null,
    } = taskDef;

    if (infraBlocked) {
      return {
        taskId: taskId || 'unknown',
        status: 'BLOCKED',
        reason: infraBlockedReason || 'Required external infrastructure is offline',
        businessVerified: false,
        visibleTestPassed: false,
      };
    }

    if (isMockOnly) {
      return {
        taskId: taskId || 'unknown',
        status: 'MOCK_ONLY_PASS',
        reason: 'Task outcome generated via in-memory simulation / mock without real execution',
        businessVerified: false,
        visibleTestPassed: true,
      };
    }

    if (isPassiveAssertionOnly) {
      return {
        taskId: taskId || 'unknown',
        status: 'INVALID_TEST',
        reason: 'Test relies on passive assertion fraud (e.g. not null, truthy, function exists) without semantic verification',
        businessVerified: false,
        visibleTestPassed: true,
      };
    }

    let baselineFailedAsExpected = false;
    let baselineDetails = null;
    if (typeof buggyBaselineRunner === 'function') {
      try {
        const baseRes = await buggyBaselineRunner();
        const baseBusinessCheck = typeof businessValidator === 'function' ? await businessValidator(baseRes?.businessResult) : { pass: baseRes?.exitCode === 0 };
        if (!baseBusinessCheck.pass || baseRes?.exitCode !== 0) {
          baselineFailedAsExpected = true;
          baselineDetails = 'Buggy baseline failed business check as expected.';
        } else {
          return {
            taskId: taskId || 'unknown',
            status: 'INVALID_BUG_FIX_FIXTURE',
            reason: 'Buggy baseline already passed business check; cannot prove bug fix value',
            businessVerified: false,
            visibleTestPassed: true,
          };
        }
      } catch (err) {
        baselineFailedAsExpected = true;
        baselineDetails = `Buggy baseline threw as expected: ${err.message}`;
      }
    } else {
      baselineFailedAsExpected = true;
    }

    let visiblePass = false;
    if (typeof visibleTestRunner === 'function') {
      const vRes = await visibleTestRunner();
      visiblePass = Boolean(vRes && (vRes.pass || vRes.exitCode === 0));
    } else {
      visiblePass = true;
    }

    let patchRes = null;
    let businessCheck = { pass: false, reason: 'No business validator provided' };
    if (typeof patchedRunner === 'function') {
      patchRes = await patchedRunner();
      if (typeof businessValidator === 'function') {
        businessCheck = await businessValidator(patchRes?.businessResult);
      } else {
        businessCheck = { pass: patchRes?.exitCode === 0 };
      }
    }

    if (visiblePass && !businessCheck.pass) {
      return {
        taskId: taskId || 'unknown',
        status: 'FALSE_PASS',
        reason: `Visible tests passed, but business requirement failed: ${businessCheck.reason || 'Semantic mismatch'}`,
        businessVerified: false,
        visibleTestPassed: true,
        baselineFailedAsExpected,
        beforeOutput: baselineDetails,
        afterOutput: patchRes?.output || patchRes?.businessResult,
      };
    }

    if (!businessCheck.pass) {
      return {
        taskId: taskId || 'unknown',
        status: 'FAIL',
        reason: businessCheck.reason || 'Business requirement not satisfied',
        businessVerified: false,
        visibleTestPassed: visiblePass,
      };
    }

    let mutationCaught = false;
    if (typeof mutationRunner === 'function') {
      try {
        const mutRes = await mutationRunner();
        const mutBusinessCheck = typeof businessValidator === 'function' ? await businessValidator(mutRes?.businessResult) : { pass: mutRes?.exitCode === 0 };
        if (!mutBusinessCheck.pass || mutRes?.exitCode !== 0) {
          mutationCaught = true;
        }
      } catch {
        mutationCaught = true;
      }
      if (!mutationCaught) {
        return {
          taskId: taskId || 'unknown',
          status: 'PARTIAL_PASS',
          reason: 'Implementation passes, but business oracle failed to catch injected mutation (weak verification)',
          businessVerified: false,
          visibleTestPassed: true,
        };
      }
    } else {
      mutationCaught = true;
    }

    let regressionClean = true;
    if (typeof regressionValidator === 'function') {
      const regCheck = await regressionValidator(patchRes?.businessResult);
      if (!regCheck.pass) {
        regressionClean = false;
        return {
          taskId: taskId || 'unknown',
          status: 'FAIL',
          reason: `Regression detected in untouched behavior: ${regCheck.reason}`,
          businessVerified: false,
          visibleTestPassed: true,
        };
      }
    }

    const result = {
      taskId: taskId || 'unknown',
      status: 'VERIFIED_PASS',
      businessVerified: true,
      visibleTestPassed: visiblePass,
      baselineFailedAsExpected,
      mutationCaught,
      regressionClean,
      before: baselineDetails,
      after: patchRes?.businessResult || 'Correct business behavior observed',
      timestamp: new Date().toISOString(),
    };

    this._revalidatedTasks.set(taskId, result);
    return result;
  }

  redlineClaim(claim = {}) {
    const {
      taskId,
      claimedStatus = 'PASS',
      claimedScore = 1.0,
      revalidatedResult = {},
    } = claim;

    const actualStatus = revalidatedResult.status || 'UNREVALIDATED';
    const isFalsePass = claimedStatus === 'PASS' && actualStatus === 'FALSE_PASS';
    const isMockOnly = actualStatus === 'MOCK_ONLY_PASS';
    const isVerified = actualStatus === 'VERIFIED_PASS';

    return {
      taskId: taskId || 'unknown',
      claimedStatus,
      claimedScore,
      actualStatus,
      isFalsePass,
      isMockOnly,
      isVerified,
      reason: revalidatedResult.reason || (isVerified ? 'All business requirements, regressions, and mutation checks verified.' : 'Discrepancy detected.'),
      before: revalidatedResult.before || null,
      after: revalidatedResult.after || null,
    };
  }
}

// Singletons
const correctnessOracle = new IndependentCorrectnessOracle();
const patchQualityEngine = new PatchQualityEngine();
const diffReviewer = new IndependentDiffReviewer();
const mutationHarness = new MutationTestingHarness();
const defectClassifier = new DefectEnvironmentClassifier();
const edgeCaseValidator = new EdgeCaseContractValidator();
const blindnessGuard = new BlindnessIsolationGuard();
const workerConflictAdjudicator = new WorkerConflictAdjudicator();
const realityLevelEvaluator = new RealityLevelEvaluator();
const businessRevalidationEngine = new BusinessTruthRevalidationEngine();

module.exports = {
  IndependentCorrectnessOracle,
  PatchQualityEngine,
  IndependentDiffReviewer,
  MutationTestingHarness,
  DefectEnvironmentClassifier,
  EdgeCaseContractValidator,
  BlindnessIsolationGuard,
  WorkerConflictAdjudicator,
  RealityLevelEvaluator,
  BusinessTruthRevalidationEngine,
  correctnessOracle,
  patchQualityEngine,
  diffReviewer,
  mutationHarness,
  defectClassifier,
  edgeCaseValidator,
  blindnessGuard,
  workerConflictAdjudicator,
  realityLevelEvaluator,
  businessRevalidationEngine,
};
