'use strict';

/**
 * Reusable, project-agnostic Test and Execution Classification System (Milestone V24).
 *
 * Enforces strict boundaries between:
 * 1. STATIC_ANALYSIS
 * 2. SYNTHETIC_TEST
 * 3. IN_PROCESS_RUNTIME_TEST
 * 4. ACTUAL_PROJECT_TEST
 * 5. ACTUAL_BUILD
 * 6. ACTUAL_APPLICATION_RUNTIME
 *
 * Guarantees:
 * - Every result includes an evidence source and execution status.
 * - Never reports a synthetic test as an actual project test.
 * - Never reports a successful build unless the real build command executed with exit code 0.
 * - Never reports application runtime as passed without actual startup verification.
 * - Enforces fail-closed BLOCKED_ISOLATION when isolation is unavailable.
 */

const TEST_EXECUTION_CATEGORIES = Object.freeze({
  STATIC_ANALYSIS: 'STATIC_ANALYSIS',
  SYNTHETIC_TEST: 'SYNTHETIC_TEST',
  IN_PROCESS_RUNTIME_TEST: 'IN_PROCESS_RUNTIME_TEST',
  ACTUAL_PROJECT_TEST: 'ACTUAL_PROJECT_TEST',
  ACTUAL_BUILD: 'ACTUAL_BUILD',
  ACTUAL_APPLICATION_RUNTIME: 'ACTUAL_APPLICATION_RUNTIME',
});

const TEST_EXECUTION_STATUSES = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  BLOCKED_ISOLATION: 'BLOCKED_ISOLATION',
  PREREQUISITES_MISSING: 'PREREQUISITES_MISSING',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_RUN: 'NOT_RUN',
  TIMED_OUT: 'TIMED_OUT',
  CANCELLED: 'CANCELLED',
});

const EVIDENCE_SOURCES = Object.freeze({
  CONTAINER_EXECUTION: 'CONTAINER_EXECUTION',
  HOST_SANDBOX: 'HOST_SANDBOX',
  ISOLATION_GATE: 'ISOLATION_GATE',
  DEPENDENCY_GATE: 'DEPENDENCY_GATE',
  MANIFEST_DISCOVERY: 'MANIFEST_DISCOVERY',
  AST_ANALYSIS: 'AST_ANALYSIS',
  IN_PROCESS_LOOPBACK: 'IN_PROCESS_LOOPBACK',
  SYNTHETIC_HARNESS: 'SYNTHETIC_HARNESS',
  STATIC_INSPECTION: 'STATIC_INSPECTION',
});

/**
 * Validates the structural and integrity constraints of a test execution record.
 * @param {Object} record
 * @returns {boolean}
 */
function validateTestExecutionRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Test execution record must be an object.');
  }
  if (!Object.values(TEST_EXECUTION_CATEGORIES).includes(record.category)) {
    throw new Error(`Invalid test execution category: "${record.category}". Expected one of: ${Object.values(TEST_EXECUTION_CATEGORIES).join(', ')}`);
  }
  if (!Object.values(TEST_EXECUTION_STATUSES).includes(record.status)) {
    throw new Error(`Invalid test execution status: "${record.status}". Expected one of: ${Object.values(TEST_EXECUTION_STATUSES).join(', ')}`);
  }
  if (!record.evidenceSource || typeof record.evidenceSource !== 'string') {
    throw new Error('Test execution record must include a non-empty evidenceSource.');
  }

  // Integrity rule 1: Synthetic test or in-process loopback cannot claim actual execution
  if (record.category === TEST_EXECUTION_CATEGORIES.SYNTHETIC_TEST || record.category === TEST_EXECUTION_CATEGORIES.IN_PROCESS_RUNTIME_TEST) {
    if (record.evidenceSource === EVIDENCE_SOURCES.CONTAINER_EXECUTION || record.evidenceSource === EVIDENCE_SOURCES.HOST_SANDBOX) {
      throw new Error(`Integrity violation: Category "${record.category}" cannot claim real execution source "${record.evidenceSource}".`);
    }
  }

  // Integrity rule 2: ACTUAL_PROJECT_TEST cannot have synthetic evidence source
  if (record.category === TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST) {
    if (record.evidenceSource === EVIDENCE_SOURCES.SYNTHETIC_HARNESS
      || record.evidenceSource === EVIDENCE_SOURCES.AST_ANALYSIS
      || record.evidenceSource === EVIDENCE_SOURCES.IN_PROCESS_LOOPBACK
      || record.evidenceSource === EVIDENCE_SOURCES.STATIC_INSPECTION) {
      throw new Error(`Integrity violation: ACTUAL_PROJECT_TEST cannot use synthetic/in-process evidence source "${record.evidenceSource}".`);
    }
    if (record.status === TEST_EXECUTION_STATUSES.PASSED && record.exitCode !== 0) {
      throw new Error(`Integrity violation: ACTUAL_PROJECT_TEST cannot be PASSED with non-zero exit code: ${record.exitCode}`);
    }
  }

  // Integrity rule 3: ACTUAL_BUILD cannot be PASSED without real execution exit code 0
  if (record.category === TEST_EXECUTION_CATEGORIES.ACTUAL_BUILD) {
    if (record.evidenceSource === EVIDENCE_SOURCES.SYNTHETIC_HARNESS
      || record.evidenceSource === EVIDENCE_SOURCES.AST_ANALYSIS
      || record.evidenceSource === EVIDENCE_SOURCES.STATIC_INSPECTION) {
      throw new Error(`Integrity violation: ACTUAL_BUILD cannot be attested by static/synthetic evidence source "${record.evidenceSource}".`);
    }
    if (record.status === TEST_EXECUTION_STATUSES.PASSED && record.exitCode !== 0) {
      throw new Error(`Integrity violation: ACTUAL_BUILD cannot be PASSED without exit code 0 (got: ${record.exitCode}).`);
    }
  }

  // Integrity rule 4: ACTUAL_APPLICATION_RUNTIME
  if (record.category === TEST_EXECUTION_CATEGORIES.ACTUAL_APPLICATION_RUNTIME) {
    if (record.status === TEST_EXECUTION_STATUSES.PASSED && record.evidenceSource !== EVIDENCE_SOURCES.CONTAINER_EXECUTION && record.evidenceSource !== EVIDENCE_SOURCES.HOST_SANDBOX) {
      throw new Error('Integrity violation: ACTUAL_APPLICATION_RUNTIME cannot be PASSED without verified container or host execution.');
    }
  }

  // Integrity rule 5: When isolation is blocked, exitCode must be null and status must be BLOCKED_ISOLATION
  if (record.status === TEST_EXECUTION_STATUSES.BLOCKED_ISOLATION) {
    if (record.exitCode !== null && record.exitCode !== undefined) {
      throw new Error(`Integrity violation: BLOCKED_ISOLATION record must have null exitCode, got ${record.exitCode}.`);
    }
  }

  return true;
}

/**
 * Creates an immutable, validated test execution record.
 * @param {Object} options
 * @returns {Object}
 */
function createTestExecutionRecord({
  category,
  status,
  evidenceSource,
  command = null,
  exitCode = null,
  stdoutSummary = '',
  stderrSummary = '',
  testCounts = null,
  durationMs = 0,
  endpointProbes = [],
  prerequisites = null,
  details = null,
}) {
  const record = Object.freeze({
    category,
    status,
    evidenceSource,
    command: typeof command === 'string' ? command : null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    stdoutSummary: typeof stdoutSummary === 'string' ? stdoutSummary.trim().slice(0, 2000) : '',
    stderrSummary: typeof stderrSummary === 'string' ? stderrSummary.trim().slice(0, 2000) : '',
    testCounts: testCounts && typeof testCounts === 'object' ? Object.freeze({ ...testCounts }) : null,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.trunc(durationMs)) : 0,
    endpointProbes: Array.isArray(endpointProbes) ? Object.freeze([...endpointProbes]) : Object.freeze([]),
    prerequisites: prerequisites && typeof prerequisites === 'object' ? Object.freeze({ ...prerequisites }) : null,
    details: details ? (typeof details === 'object' ? Object.freeze({ ...details }) : String(details)) : null,
    timestamp: new Date().toISOString(),
  });

  validateTestExecutionRecord(record);
  return record;
}

/**
 * Inspects a project's declared scripts, dependencies, and environment isolation
 * to determine test and execution readiness before any command is run.
 *
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {Object} [options.buildDiscovery]
 * @param {Object} [options.dependencyReport]
 * @param {Object} [options.isolationStatus]
 * @param {string[]} [options.requestedOperations]
 * @returns {Object} Structured readiness evaluation
 */
function evaluateProjectTestReadiness({
  projectRoot,
  buildDiscovery = null,
  dependencyReport = null,
  isolationStatus = null,
  requestedOperations = ['TEST', 'BUILD', 'START'],
} = {}) {
  const ecosystem = buildDiscovery?.ecosystem
    || dependencyReport?.primaryReport?.ecosystem
    || 'node';
  const manifests = buildDiscovery?.detectedManifests || [];
  const availableOps = buildDiscovery?.availableOperations || {};

  const depNeedsInstall = Boolean(dependencyReport?.needsInstallation);
  const missingDeps = dependencyReport?.missingDependencies
    || (dependencyReport?.findings || []).filter((f) => f.status === 'MISSING' || f.status === 'VERSION_MISMATCH')
    || [];

  const isolationAvailable = Boolean(isolationStatus?.available);
  const isolationVerified = Boolean(isolationStatus?.verified);
  const isIsolationSafe = isolationAvailable && isolationVerified;

  const operations = {};
  const operationMapping = {
    TEST: {
      category: TEST_EXECUTION_CATEGORIES.ACTUAL_PROJECT_TEST,
      buildOp: 'TEST',
      label: 'Project Test Suite',
    },
    BUILD: {
      category: TEST_EXECUTION_CATEGORIES.ACTUAL_BUILD,
      buildOp: 'BUILD',
      label: 'Project Build',
    },
    START: {
      category: TEST_EXECUTION_CATEGORIES.ACTUAL_APPLICATION_RUNTIME,
      buildOp: 'START',
      label: 'Application Startup & Runtime',
    },
  };

  let hasBlocker = false;
  let primaryBlocker = null;

  for (const opKey of requestedOperations) {
    const mapping = operationMapping[opKey];
    if (!mapping) continue;

    const discovered = availableOps[mapping.buildOp];
    const configured = Boolean(discovered);
    const command = configured ? `${discovered.binary} ${(discovered.args || []).join(' ')}`.trim() : null;

    let status = TEST_EXECUTION_STATUSES.NOT_RUN;
    let readyToExecute = false;
    let blockerReason = null;

    if (!configured) {
      status = TEST_EXECUTION_STATUSES.NOT_CONFIGURED;
      blockerReason = `${mapping.label} is not configured or declared in project manifest(s).`;
    } else if (depNeedsInstall) {
      status = TEST_EXECUTION_STATUSES.PREREQUISITES_MISSING;
      blockerReason = `Project has ${missingDeps.length} missing/unresolved dependencies (${missingDeps.map((d) => d.name || d).join(', ')}). Dependencies must be installed before execution.`;
      if (!hasBlocker) {
        hasBlocker = true;
        primaryBlocker = blockerReason;
      }
    } else if (!isIsolationSafe) {
      status = TEST_EXECUTION_STATUSES.BLOCKED_ISOLATION;
      blockerReason = `Execution blocked by process isolation policy: ${isolationStatus?.reason || 'Verified container or sandbox isolation is required.'}`;
      if (!hasBlocker) {
        hasBlocker = true;
        primaryBlocker = blockerReason;
      }
    } else {
      readyToExecute = true;
      status = TEST_EXECUTION_STATUSES.NOT_RUN;
    }

    operations[opKey] = Object.freeze({
      operation: opKey,
      category: mapping.category,
      label: mapping.label,
      configured,
      command,
      scriptName: discovered?.scriptName || null,
      binary: discovered?.binary || null,
      args: discovered?.args || [],
      readyToExecute,
      status,
      blockerReason,
      evidencePath: discovered?.evidencePath || null,
    });
  }

  let overallStatus = 'READY_TO_EXECUTE';
  if (depNeedsInstall) {
    overallStatus = 'PREREQUISITES_MISSING';
  } else if (!isIsolationSafe) {
    overallStatus = 'BLOCKED_ISOLATION';
  } else if (Object.values(operations).every((op) => !op.configured)) {
    overallStatus = 'NOT_CONFIGURED';
  }

  return Object.freeze({
    projectRoot,
    ecosystem,
    manifests,
    dependencies: Object.freeze({
      satisfied: !depNeedsInstall,
      missingCount: missingDeps.length,
      missingDependencies: missingDeps,
      reason: depNeedsInstall ? `Missing dependencies: ${missingDeps.map((d) => d.name || d).join(', ')}` : null,
    }),
    isolation: Object.freeze({
      available: isolationAvailable,
      verified: isolationVerified,
      safe: isIsolationSafe,
      reason: isolationStatus?.reason || (isIsolationSafe ? 'Isolation verified.' : 'Isolation unverified.'),
    }),
    operations: Object.freeze(operations),
    overallStatus,
    primaryBlocker,
  });
}

module.exports = {
  TEST_EXECUTION_CATEGORIES,
  TEST_EXECUTION_STATUSES,
  EVIDENCE_SOURCES,
  validateTestExecutionRecord,
  createTestExecutionRecord,
  evaluateProjectTestReadiness,
};
