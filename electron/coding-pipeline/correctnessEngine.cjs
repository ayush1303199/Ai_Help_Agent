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

// Singletons
const correctnessOracle = new IndependentCorrectnessOracle();
const patchQualityEngine = new PatchQualityEngine();
const diffReviewer = new IndependentDiffReviewer();
const mutationHarness = new MutationTestingHarness();
const defectClassifier = new DefectEnvironmentClassifier();
const edgeCaseValidator = new EdgeCaseContractValidator();

module.exports = {
  IndependentCorrectnessOracle,
  PatchQualityEngine,
  IndependentDiffReviewer,
  MutationTestingHarness,
  DefectEnvironmentClassifier,
  EdgeCaseContractValidator,
  correctnessOracle,
  patchQualityEngine,
  diffReviewer,
  mutationHarness,
  defectClassifier,
  edgeCaseValidator,
};
