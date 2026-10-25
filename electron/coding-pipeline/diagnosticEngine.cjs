'use strict';

/**
 * Modular Diagnostic Engine for AI Coding Agent (Milestone V4).
 *
 * Consumes structured evidence from build, compile, lint, typecheck, and test failures.
 * Calibrates diagnosis status and confidence strictly to observable evidence.
 * Redacts credentials, tokens, and sensitive information from diagnostics.
 * Avoids premature root-cause confirmation or speculative guesses.
 * Tracks failure evolution across repair loop attempts.
 *
 * ZERO hardcoded application packages, endpoints, or invented root causes.
 */

const crypto = require('node:crypto');

const DIAGNOSTIC_STATUSES = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  LIKELY: 'LIKELY',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  BLOCKED: 'BLOCKED',
});

const FAILURE_CATEGORIES = Object.freeze({
  SYNTAX_ERROR: 'SYNTAX_ERROR',
  TYPE_ERROR: 'TYPE_ERROR',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  ASSERTION_FAILURE: 'ASSERTION_FAILURE',
  RUNTIME_EXCEPTION: 'RUNTIME_EXCEPTION',
  BUILD_CONFIG_ERROR: 'BUILD_CONFIG_ERROR',
  TIMEOUT: 'TIMEOUT',
  PROCESS_ISOLATION_BLOCKED: 'PROCESS_ISOLATION_BLOCKED',
  UNKNOWN: 'UNKNOWN',
});

const VERIFICATION_TIERS = Object.freeze({
  PLAN_VALIDATED: 'PLAN_VALIDATED',
  PATCH_APPLIED: 'PATCH_APPLIED',
  STATIC_CHECKS_PASSED: 'STATIC_CHECKS_PASSED',
  BUILD_PASSED: 'BUILD_PASSED',
  TESTS_PASSED: 'TESTS_PASSED',
  RUNTIME_VERIFIED: 'RUNTIME_VERIFIED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
});

/**
 * Redacts secrets, passwords, tokens, API keys, and Authorization headers from text.
 * @param {string} text
 * @returns {string} Redacted text.
 */
function redactSensitiveData(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [redacted]')
    .replace(/ghp_[a-zA-Z0-9]{36}/gi, '[redacted-gh-token]')
    .replace(/xox[baprs]-[a-zA-Z0-9-]+/gi, '[redacted-slack-token]')
    .replace(/(authorization|token|secret|credential|password|api[_-]?key|private[_-]?key)(\s*[:=]\s*)(?:bearer\s+)?[^,\r\n;]+/gi, '$1$2[redacted]');
}

/**
 * Parses compiler/syntax errors, assertion errors, and stack frames from output.
 * @param {string} text
 * @returns {Object} Extracted diagnostic details.
 */
function extractDiagnosticDetails(text) {
  const clean = (text || '').replace(/\u001b\[[0-9;]*m/g, ''); // strip ANSI codes
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const compilerErrors = [];
  const assertionErrors = [];
  const runtimeExceptions = [];
  const missingModules = [];
  const stackFrames = [];

  // 1. Missing module / dependency patterns
  const moduleRegexes = [
    /Cannot find module\s+['"]([^'"]+)['"]/i,
    /ModuleNotFoundError:\s+No module named\s+['"]([^'"]+)['"]/i,
    /Error:\s+Could not resolve\s+['"]([^'"]+)['"]/i,
    /package\s+['"]?([^'"]+)['"]?\s+is not installed/i,
  ];
  for (const re of moduleRegexes) {
    const match = clean.match(re);
    if (match && match[1]) {
      missingModules.push(match[1]);
    }
  }

  // 2. Syntax / Compiler errors
  const compilerRegexes = [
    /(?:error\s+TS\d+:\s*.+)/gi,
    /(?:SyntaxError:\s*.+)/gi,
    /(?:Parse error:\s*.+)/gi,
    /(?:Fatal error:\s*.+)/gi,
    /error\[E\d+\]:\s*.+/gi, // Rust
  ];
  for (const re of compilerRegexes) {
    let m;
    while ((m = re.exec(clean)) !== null) {
      if (!compilerErrors.includes(m[0])) {
        compilerErrors.push(m[0].slice(0, 300));
      }
    }
  }

  // 3. Assertion errors
  const assertionRegexes = [
    /AssertionError(?: \[[^\]]+\])?:?\s*(.+)/gi,
    /Failed asserting that\s+(.+)/gi,
    /Expected:?\s*(.+?)\s+Received:?\s*(.+)/gi,
    /assert\s+.+==.+/gi,
    /Expected values to be strictly equal:\s*(.+)/gi,
  ];
  for (const re of assertionRegexes) {
    let m;
    while ((m = re.exec(clean)) !== null) {
      const msg = (m[1] || m[0]).trim();
      if (!assertionErrors.includes(msg)) {
        assertionErrors.push(msg.slice(0, 300));
      }
    }
  }

  // 4. Runtime exceptions
  const exceptionRegexes = [
    /TypeError:\s*(.+)/gi,
    /ReferenceError:\s*(.+)/gi,
    /NullPointerException:\s*(.+)/gi,
    /panic:\s*(.+)/gi,
    /Uncaught\s+[A-Za-z]+Error:\s*(.+)/gi,
  ];
  for (const re of exceptionRegexes) {
    let m;
    while ((m = re.exec(clean)) !== null) {
      if (!runtimeExceptions.includes(m[0])) {
        runtimeExceptions.push(m[0].slice(0, 300));
      }
    }
  }

  // 5. Stack frames / File locations
  const frameRegex = /(?:at\s+(?:.+?\s+\()?|File\s+["']?|in\s+|^)(?:file:\/{2,3})?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)[:\s,]+(?:line\s+)?(\d+)(?::(\d+))?/gi;
  let frameMatch;
  while ((frameMatch = frameRegex.exec(clean)) !== null) {
    const file = frameMatch[1];
    const line = Number(frameMatch[2]);
    const column = frameMatch[3] ? Number(frameMatch[3]) : null;
    if (file && !file.includes('node_modules') && !file.includes('internal/') && !file.includes('vendor/')) {
      if (!stackFrames.some((f) => f.file === file && f.line === line)) {
        stackFrames.push({ file, line, column });
      }
    }
  }

  // Primary summary line
  const summary = compilerErrors[0]
    || (missingModules.length > 0 ? `Missing module: ${missingModules[0]}` : null)
    || assertionErrors[0]
    || runtimeExceptions[0]
    || lines.find((l) => /error|fail|exception/i.test(l) && !/^npm /i.test(l))
    || 'Execution failed with non-zero exit code';

  return {
    summary: summary ? summary.slice(0, 400) : 'Execution failure',
    compilerErrors,
    assertionErrors,
    runtimeExceptions,
    missingModules,
    stackFrames: stackFrames.slice(0, 10),
  };
}

/**
 * Diagnoses a build, compile, lint, typecheck, or test failure from structured evidence.
 *
 * @param {Object} failureEvidence
 * @param {string} [failureEvidence.status] - 'FAILED', 'BLOCKED', etc.
 * @param {number|null} [failureEvidence.exitCode]
 * @param {string} [failureEvidence.stdout]
 * @param {string} [failureEvidence.stderr]
 * @param {string} [failureEvidence.gate] - Gate name if blocked by policy.
 * @param {string} [failureEvidence.reason]
 * @param {Array} [failureEvidence.missingDependencies]
 * @param {Object} [context]
 * @param {string} [context.projectRoot]
 * @param {Array} [context.attemptHistory] - Past repair attempts in current workflow.
 * @returns {Object} Structured diagnosis.
 */
function diagnoseFailure(failureEvidence = {}, context = {}) {
  const stdout = redactSensitiveData(String(failureEvidence.stdout || ''));
  const stderr = redactSensitiveData(String(failureEvidence.stderr || ''));
  const combinedOutput = `${stderr}\n${stdout}`.trim();
  const rawReason = redactSensitiveData(String(failureEvidence.reason || failureEvidence.error || ''));

  const details = extractDiagnosticDetails(`${combinedOutput}\n${rawReason}`);
  const attemptHistory = Array.isArray(context.attemptHistory) ? context.attemptHistory : [];
  const attemptNumber = attemptHistory.length + 1;

  // 1. Check for Process Isolation Gate Block
  if (
    failureEvidence.gate === 'PROCESS_ISOLATION_GATE'
    || failureEvidence.executionBlocked
    || /process isolation is required|PROJECT_EXECUTION_BLOCKED/i.test(rawReason)
  ) {
    return {
      diagnosisId: crypto.randomUUID(),
      status: DIAGNOSTIC_STATUSES.BLOCKED,
      failureCategory: FAILURE_CATEGORIES.PROCESS_ISOLATION_BLOCKED,
      rootCause: rawReason || 'Project execution is blocked: verified Windows process isolation is required.',
      evidence: {
        summary: 'Execution blocked by process isolation gate.',
        gate: 'PROCESS_ISOLATION_GATE',
        rawReason,
        stackFrames: [],
      },
      affectedFiles: [],
      primaryLocation: null,
      confidence: 'HIGH',
      proposedChecks: ['Verify operating-system sandbox or host runner credentials.'],
      limitations: ['Process execution cannot proceed without a verified host sandbox adapter.'],
      attemptNumber,
      isPersistingFailure: false,
      isNewFailure: false,
      maxAttemptsExceeded: false,
      createdAt: new Date().toISOString(),
    };
  }

  // 2. Check for Missing Dependency Gate / Missing Modules
  if (
    failureEvidence.gate === 'DEPENDENCY_PREREQUISITE_GATE'
    || (Array.isArray(failureEvidence.missingDependencies) && failureEvidence.missingDependencies.length > 0)
    || details.missingModules.length > 0
  ) {
    const missing = failureEvidence.missingDependencies
      ? failureEvidence.missingDependencies.map((d) => (typeof d === 'string' ? d : d.name || JSON.stringify(d)))
      : details.missingModules;

    return {
      diagnosisId: crypto.randomUUID(),
      status: DIAGNOSTIC_STATUSES.CONFIRMED,
      failureCategory: FAILURE_CATEGORIES.MISSING_DEPENDENCY,
      rootCause: `Required dependency is missing or unresolved: ${missing.join(', ')}.`,
      evidence: {
        summary: details.summary,
        missingModules: missing,
        stderrExcerpt: stderr.slice(0, 500),
        stackFrames: details.stackFrames,
      },
      affectedFiles: details.stackFrames.map((f) => f.file),
      primaryLocation: details.stackFrames[0] || null,
      confidence: 'HIGH',
      proposedChecks: ['Run dependency installation workflow via approved dependency manager.'],
      limitations: [],
      attemptNumber,
      isPersistingFailure: false,
      isNewFailure: false,
      maxAttemptsExceeded: false,
      createdAt: new Date().toISOString(),
    };
  }

  // 3. Compiler / Syntax Errors (Direct confirmed location)
  if (details.compilerErrors.length > 0) {
    const primaryFrame = details.stackFrames[0] || null;
    const isTypeError = details.compilerErrors.some((e) => /TS\d+|TypeError/i.test(e));
    const category = isTypeError ? FAILURE_CATEGORIES.TYPE_ERROR : FAILURE_CATEGORIES.SYNTAX_ERROR;

    return {
      diagnosisId: crypto.randomUUID(),
      status: primaryFrame ? DIAGNOSTIC_STATUSES.CONFIRMED : DIAGNOSTIC_STATUSES.LIKELY,
      failureCategory: category,
      rootCause: details.compilerErrors[0],
      evidence: {
        summary: details.summary,
        compilerErrors: details.compilerErrors,
        stderrExcerpt: stderr.slice(0, 500),
        stackFrames: details.stackFrames,
      },
      affectedFiles: details.stackFrames.map((f) => f.file),
      primaryLocation: primaryFrame,
      confidence: primaryFrame ? 'HIGH' : 'MEDIUM',
      proposedChecks: ['Run typecheck/linter to verify syntax/type alignment.'],
      limitations: primaryFrame ? [] : ['Compiler error reported without exact source file line frame.'],
      attemptNumber,
      isPersistingFailure: false,
      isNewFailure: false,
      maxAttemptsExceeded: false,
      createdAt: new Date().toISOString(),
    };
  }

  // 4. Assertion Errors (Test failure site - evidence, not automatic root cause proof)
  if (details.assertionErrors.length > 0) {
    const primaryFrame = details.stackFrames[0] || null;
    const affected = details.stackFrames.map((f) => f.file);

    return {
      diagnosisId: crypto.randomUUID(),
      status: DIAGNOSTIC_STATUSES.LIKELY,
      failureCategory: FAILURE_CATEGORIES.ASSERTION_FAILURE,
      rootCause: `Assertion failed: ${details.assertionErrors[0]}. Note: The assertion site indicates where the failure was observed; the causal defect may reside in called logic.`,
      evidence: {
        summary: details.summary,
        assertionErrors: details.assertionErrors,
        stderrExcerpt: stderr.slice(0, 500),
        stackFrames: details.stackFrames,
      },
      affectedFiles: affected,
      primaryLocation: primaryFrame,
      confidence: 'MEDIUM',
      proposedChecks: ['Inspect called logic upstream of assertion site to verify contract inputs/outputs.'],
      limitations: ['Stack trace points to assertion failure; causal defect may precede the assertion.'],
      attemptNumber,
      isPersistingFailure: false,
      isNewFailure: false,
      maxAttemptsExceeded: false,
      createdAt: new Date().toISOString(),
    };
  }

  // 5. Runtime Exceptions
  if (details.runtimeExceptions.length > 0) {
    const primaryFrame = details.stackFrames[0] || null;
    return {
      diagnosisId: crypto.randomUUID(),
      status: primaryFrame ? DIAGNOSTIC_STATUSES.CONFIRMED : DIAGNOSTIC_STATUSES.LIKELY,
      failureCategory: FAILURE_CATEGORIES.RUNTIME_EXCEPTION,
      rootCause: details.runtimeExceptions[0],
      evidence: {
        summary: details.summary,
        runtimeExceptions: details.runtimeExceptions,
        stderrExcerpt: stderr.slice(0, 500),
        stackFrames: details.stackFrames,
      },
      affectedFiles: details.stackFrames.map((f) => f.file),
      primaryLocation: primaryFrame,
      confidence: primaryFrame ? 'HIGH' : 'MEDIUM',
      proposedChecks: ['Inspect nullability/exception guards at runtime exception site.'],
      limitations: primaryFrame ? [] : ['Stack trace frames were not present in exception output.'],
      attemptNumber,
      isPersistingFailure: false,
      isNewFailure: false,
      maxAttemptsExceeded: false,
      createdAt: new Date().toISOString(),
    };
  }

  // 6. Insufficient evidence / Ambiguous output
  if (!combinedOutput && !rawReason) {
    return {
      diagnosisId: crypto.randomUUID(),
      status: DIAGNOSTIC_STATUSES.INSUFFICIENT_EVIDENCE,
      failureCategory: FAILURE_CATEGORIES.UNKNOWN,
      rootCause: 'Process exited with failure but produced zero stdout or stderr output.',
      evidence: {
        summary: 'No diagnostic output captured.',
        stackFrames: [],
      },
      affectedFiles: [],
      primaryLocation: null,
      confidence: 'LOW',
      proposedChecks: ['Run command with verbose logging enabled to capture failure diagnostics.'],
      limitations: ['Missing stdout/stderr logs from execution.'],
      attemptNumber,
      isPersistingFailure: false,
      isNewFailure: false,
      maxAttemptsExceeded: false,
      createdAt: new Date().toISOString(),
    };
  }

  // Fallback to likely/unknown
  return {
    diagnosisId: crypto.randomUUID(),
    status: DIAGNOSTIC_STATUSES.LIKELY,
    failureCategory: FAILURE_CATEGORIES.UNKNOWN,
    rootCause: details.summary,
    evidence: {
      summary: details.summary,
      stderrExcerpt: stderr.slice(0, 500),
      stackFrames: details.stackFrames,
    },
    affectedFiles: details.stackFrames.map((f) => f.file),
    primaryLocation: details.stackFrames[0] || null,
    confidence: details.stackFrames.length > 0 ? 'MEDIUM' : 'LOW',
    proposedChecks: ['Run isolated target test with stack trace enabled.'],
    limitations: details.stackFrames.length > 0 ? [] : ['No stack frames or clear error tokens identified in log.'],
    attemptNumber,
    isPersistingFailure: false,
    isNewFailure: false,
    maxAttemptsExceeded: false,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  DIAGNOSTIC_STATUSES,
  FAILURE_CATEGORIES,
  VERIFICATION_TIERS,
  redactSensitiveData,
  extractDiagnosticDetails,
  diagnoseFailure,
};
