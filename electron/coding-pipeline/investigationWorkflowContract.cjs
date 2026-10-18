// Contract and governance for autonomous investigation, evidence classification,
// end-to-end architectural tracing, and workflow approval gates.

const CLASSIFICATION_CONFIRMED = 'CONFIRMED';
const CLASSIFICATION_LIKELY = 'LIKELY';
const CLASSIFICATION_UNVERIFIED = 'UNVERIFIED';
const CLASSIFICATION_NOT_A_BUG = 'NOT A BUG';

const VALID_CLASSIFICATIONS = new Set([
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_LIKELY,
  CLASSIFICATION_UNVERIFIED,
  CLASSIFICATION_NOT_A_BUG,
]);

/**
 * Classifies a defect based on structured source evidence and control-flow impact.
 */
function classifyDefect({
  filePath,
  symbol,
  lines,
  codeSnippet,
  controlFlow,
  expected,
  observed,
  evidenceType,
}) {
  if (!filePath || !symbol || !lines) {
    throw new Error('Defect classification requires exact filePath, symbol, and line range.');
  }

  let classification = CLASSIFICATION_UNVERIFIED;
  let isConfirmed = false;

  const normalizedSnippet = String(codeSnippet || '').trim();
  const normalizedEvidence = String(evidenceType || '').toUpperCase();

  // If behavior matches expected design
  if (
    normalizedEvidence === 'STATIC_INSPECTION_VALID'
    || (expected && observed && expected.trim() === observed.trim())
  ) {
    classification = CLASSIFICATION_NOT_A_BUG;
    isConfirmed = false;
  } else if (
    normalizedEvidence.includes('CONFIRMED')
    || /die\(|var_dump\(|print_r\(|dd\(|dump\(|console\.log\(|debugger;/i.test(normalizedSnippet)
    || (controlFlow && /not rolled back|missing (?:rollback|null-check)|unhandled exception/i.test(controlFlow))
  ) {
    classification = CLASSIFICATION_CONFIRMED;
    isConfirmed = true;
  } else if (normalizedEvidence.includes('LIKELY') || normalizedSnippet) {
    classification = CLASSIFICATION_LIKELY;
    isConfirmed = false;
  }

  return {
    filePath,
    symbol,
    lines,
    codeSnippet: normalizedSnippet,
    controlFlow: String(controlFlow || ''),
    expected: String(expected || ''),
    observed: String(observed || ''),
    classification,
    isConfirmed,
    evidenceType: normalizedEvidence || 'UNSPECIFIED',
  };
}

/**
 * Traces end-to-end execution flow across architectural layers.
 */
function traceExecutionFlow({ route, controllerFile, controllerContent, action }) {
  const content = String(controllerContent || '');
  const lines = content.split(/\r?\n/);

  // Extract controller name
  const classMatch = content.match(/\bclass\s+([A-Za-z0-9_]+)/);
  const controllerName = classMatch ? classMatch[1] : (controllerFile ? controllerFile.split('/').pop().replace(/\.\w+$/, '') : 'UnknownController');

  // Extract model references
  const modelMatch = content.match(/\b([A-Z][A-Za-z0-9_]+)::(?:findOne|find|save|create)/);
  const modelName = modelMatch ? modelMatch[1] : null;

  // Extract transaction flow
  const hasTransaction = /beginTransaction\(\)/i.test(content);
  const transactionCommits = /commit\(\)/i.test(content);
  
  // Check catch blocks for rollBack
  let inCatch = false;
  let rollbackInCatch = false;
  for (const line of lines) {
    if (/catch\s*\(/i.test(line)) {
      inCatch = true;
    }
    if (inCatch && /rollBack\(\)/i.test(line)) {
      rollbackInCatch = true;
    }
    if (inCatch && /return\b|throw\b|\}/.test(line) && !/catch\s*\(/.test(line)) {
      inCatch = false;
    }
  }

  return {
    layers: {
      route: route || 'unspecified/route',
      controller: controllerName,
      action: action || 'unknownAction',
      model: modelName,
      hasTransaction,
      transactionCommits,
      transactionRollbacksInCatch: rollbackInCatch,
    },
    traceComplete: true,
  };
}

/**
 * Validates evidence report integrity, preventing forged or simulated verification.
 */
function validateEvidenceReport({
  userGoal,
  inspectedFiles = [],
  claimedVerification = null,
  executionAuditLog = null,
  simulatedOutput = null,
  claimedDefects = [],
  requiresClarification = false,
  clarificationPrompt = null,
}) {
  if (requiresClarification) {
    return {
      isValid: true,
      requiresClarification: true,
      clarificationPrompt: clarificationPrompt || 'Clarification required.',
      inventedAssumptions: false,
    };
  }

  if (claimedVerification === 'PASSED') {
    if (!executionAuditLog || typeof executionAuditLog !== 'object') {
      return {
        isValid: false,
        verificationAccepted: false,
        rejectionReason: 'Authoritative execution audit log is required to claim tests passed.',
      };
    }
    if (executionAuditLog.exitCode !== 0) {
      return {
        isValid: false,
        verificationAccepted: false,
        rejectionReason: `Cannot claim PASSED when execution audit log exited with non-zero code (${executionAuditLog.exitCode}).`,
      };
    }
    return {
      isValid: true,
      verificationAccepted: true,
      finalStatus: 'PASSED',
      exitCode: 0,
    };
  }

  if (claimedVerification === 'FAILED') {
    return {
      isValid: true,
      verificationAccepted: true,
      finalStatus: 'FAILED',
      exitCode: executionAuditLog?.exitCode ?? 1,
    };
  }

  return {
    isValid: true,
    verificationAccepted: false,
    finalStatus: 'NOT_RUN',
  };
}

/**
 * Validates that proposed patches are minimal and preserve unrelated dirty work.
 */
function validatePatchScope({
  targetFiles = [],
  proposedChanges = [],
  acceptanceCriteria = [],
  modifiedFiles = [],
  existingDirtyFiles = [],
}) {
  const targetSet = new Set(targetFiles);
  const touchedFiles = modifiedFiles.length > 0 ? modifiedFiles : targetFiles;
  
  const touchesUnrelated = existingDirtyFiles.some((dirty) => !targetSet.has(dirty) && touchedFiles.includes(dirty));
  
  return {
    isMinimal: targetFiles.length > 0 && targetFiles.length <= 5,
    targetFiles,
    acceptanceCriteria,
    touchedFiles,
    preservesUnrelatedFiles: !touchesUnrelated,
  };
}

/**
 * Strictly enforces that mutation and deletion operations require approved proposals
 * and forbid unapproved scope expansion.
 */
function enforceApprovalGate({
  originalProposalTargets = [],
  attemptedMutationTargets = [],
  operationType = 'APPLY_PATCH',
  userApproved = false,
}) {
  if (!userApproved) {
    return {
      allowed: false,
      rejectionReason: 'Operation requires explicit user approval before execution.',
    };
  }

  const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const approvedSet = new Set(originalProposalTargets.map(normPath));
  const unapprovedTargets = attemptedMutationTargets.filter((t) => !approvedSet.has(normPath(t)));

  if (unapprovedTargets.length > 0) {
    return {
      allowed: false,
      rejectionReason: `Scope expansion detected: mutation targets [${unapprovedTargets.join(', ')}] exceed approved proposal targets.`,
    };
  }

  return {
    allowed: true,
    operationType,
  };
}

/**
 * Converts a user request into explicit requirements and acceptance criteria,
 * detecting underspecified or ambiguous requests that require clarification.
 */
function analyzeTaskRequirements(userRequest) {
  const text = String(userRequest || '').trim();
  if (!text) {
    return {
      explicitRequirements: [],
      acceptanceCriteria: [],
      ambiguityScore: 'HIGH',
      needsClarification: true,
      clarificationPrompt: 'Please provide task requirements or the target issue to investigate.',
      inventedAssumptions: false,
    };
  }

  // Detect vague requests lacking concrete target, file, symptom, or metric
  const isVague = /^(?:make\s+[\w\s]*\s*(?:better|faster|cleaner|nicer|cool(?:er)?)|improve\s+(?:the\s+)?performance|fix\s+(?:the\s+)?bug|do\s+something)\s*[.!?]*$/i.test(text)
    || (/^(?:make|improve|optimize)\b.*\b(?:faster|better|cleaner)\b/i.test(text) && !/\b(?:ms|seconds?|query|queries|index|profile|benchmark|endpoint|test|error)\b/i.test(text));
  if (isVague) {
    return {
      explicitRequirements: [],
      acceptanceCriteria: [],
      ambiguityScore: 'HIGH',
      needsClarification: true,
      clarificationPrompt: `The request "${text}" is ambiguous. Please specify the target behavior, expected outcome, or error details.`,
      inventedAssumptions: false,
    };
  }

  // Extract explicit requirements
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-/.\\]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into'].includes(w));

  const uniqueTerms = [...new Set(words)];
  const explicitRequirements = [`Address requested behavior: ${text.slice(0, 160)}`];
  const acceptanceCriteria = [
    `Implementation satisfies user request: ${text.slice(0, 120)}`,
    'No regressions in surrounding modules',
  ];

  return {
    explicitRequirements,
    acceptanceCriteria,
    domainTerms: uniqueTerms,
    ambiguityScore: 'LOW',
    needsClarification: false,
    clarificationPrompt: null,
    inventedAssumptions: false,
  };
}

/**
 * Plans progressive search tiers (narrow -> domain concept -> architectural role fallback)
 * while deduplicating equivalent queries across a session.
 */
function planProgressiveSearch({
  query,
  scope = '.',
  sessionSearches = [],
}) {
  const raw = String(query || '').trim();
  if (!raw) throw new Error('Search query is required.');

  const normalized = raw.toLowerCase().replace(/[\s_\-/.\\]+/g, '');
  const searchHistory = new Set(
    sessionSearches.map((s) => `${String(s.scope || '.').trim().toLowerCase()}:${String(s.query || '').trim().toLowerCase().replace(/[\s_\-/.\\]+/g, '')}`)
  );

  const key = `${scope.trim().toLowerCase()}:${normalized}`;
  if (searchHistory.has(key)) {
    return {
      isDuplicate: true,
      query: raw,
      scope,
      rationale: `Query '${raw}' has already been executed in scope '${scope}'. Deduplicating to prevent redundant search.`,
    };
  }

  // Determine search tier
  const tokens = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-/.\\]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  let tier = 1;
  let rationale = `Narrow search for exact pattern '${raw}'.`;
  if (tokens.length > 1) {
    tier = 2;
    rationale = `Multi-token concept search for tokens [${tokens.join(', ')}].`;
  }

  return {
    isDuplicate: false,
    tier,
    query: raw,
    scope,
    tokens,
    rationale,
  };
}

/**
 * Dynamically discovers project architecture across any ecosystem or unknown layout.
 */
function discoverProjectArchitecture(metadata = {}) {
  const languages = Array.isArray(metadata.languages) ? metadata.languages : [];
  const frameworks = Array.isArray(metadata.frameworks) ? metadata.frameworks : [];
  const entryPoints = Array.isArray(metadata.entryPoints) ? metadata.entryPoints : [];
  const sourceDirectories = Array.isArray(metadata.sourceDirectories) ? metadata.sourceDirectories : [];
  const configFiles = Array.isArray(metadata.configFiles) ? metadata.configFiles : [];

  const hasPackageJson = metadata.hasPackageJson || configFiles.some((f) => f.includes('package.json'));
  const hasComposer = metadata.composer || configFiles.some((f) => f.includes('composer.json'));
  const hasPython = languages.includes('python') || configFiles.some((f) => f.includes('pyproject.toml') || f.includes('requirements.txt'));
  const hasGo = languages.includes('go') || configFiles.some((f) => f.includes('go.mod'));
  const hasRust = languages.includes('rust') || configFiles.some((f) => f.includes('Cargo.toml'));

  let ecosystem = 'UNKNOWN_OR_CUSTOM';
  if (hasPackageJson) ecosystem = 'node';
  else if (hasComposer) ecosystem = 'php';
  else if (hasPython) ecosystem = 'python';
  else if (hasGo) ecosystem = 'go';
  else if (hasRust) ecosystem = 'rust';

  const layersDetected = {
    routing: sourceDirectories.some((d) => /(?:routes?|routing|api)/i.test(d)),
    controllers: sourceDirectories.some((d) => /(?:controllers?|handlers?)/i.test(d)),
    models: sourceDirectories.some((d) => /(?:models?|entities|schemas?)/i.test(d)),
    views: sourceDirectories.some((d) => /(?:views?|templates?|ui|client)/i.test(d)),
    services: sourceDirectories.some((d) => /(?:services?|providers?)/i.test(d)),
    modules: sourceDirectories.some((d) => /(?:modules?|packages?|apps?)/i.test(d)),
    tests: Array.isArray(metadata.testDirectories) && metadata.testDirectories.length > 0,
  };

  const isUnstructured = sourceDirectories.length === 0 || (sourceDirectories.length === 1 && sourceDirectories[0] === '.');

  return {
    ecosystem,
    languages,
    frameworks,
    entryPoints,
    sourceDirectories,
    layersDetected,
    isUnstructured,
    recommendedScope: isUnstructured ? '.' : sourceDirectories[0] || '.',
  };
}

/**
 * Executes a tool call with timeout protection, transient retry logic,
 * and failure preservation (avoids blind retries on deterministic failures).
 */
async function executeToolWithSafeguards({
  toolName,
  toolFn,
  args = [],
  timeoutMs = 15000,
  maxRetries = 1,
}) {
  if (typeof toolFn !== 'function') throw new Error('toolFn must be a function.');

  let attempts = 0;
  let lastError = null;

  while (attempts <= maxRetries) {
    attempts += 1;
    let timer = null;
    try {
      const resultPromise = toolFn(...args);
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms.`);
          err.code = 'TOOL_TIMEOUT';
          reject(err);
        }, timeoutMs);
      });

      const outcome = await Promise.race([resultPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      return {
        success: true,
        toolName,
        data: outcome,
        attempts,
        retried: attempts > 1,
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastError = err;

      // Classify error: only transient errors (EBUSY, resource lock) are retryable
      const isTransient = /EBUSY|ETIMEDOUT|resource\s+locked|temporarily\s+unavailable/i.test(err.message || '');
      if (!isTransient || attempts > maxRetries) {
        break; // Deterministic failure (e.g. file not found, syntax error, permission) - DO NOT RETRY BLINDLY
      }
    }
  }

  return {
    success: false,
    toolName,
    error: lastError?.message || 'Tool execution failed',
    errorCode: lastError?.code || 'EXECUTION_FAILED',
    attempts,
    retried: attempts > 1,
    failurePreserved: true,
  };
}

/**
 * Manages minimal repair loops, ensuring repair is opt-in, bounded by max attempts,
 * strictly confined to approved targets, and stops on security or unverified blockers.
 */
function manageRepairLoop({
  approvedTargets = [],
  attemptCount = 0,
  maxAttempts = 2,
  autoRepairEnabled = false,
  lastVerificationResult = null,
  proposedMutationTargets = [],
}) {
  if (!autoRepairEnabled) {
    return {
      allowRepair: false,
      reason: 'Automatic repair loop is disabled by default (opt-in only).',
    };
  }

  if (attemptCount >= maxAttempts) {
    return {
      allowRepair: false,
      reason: `Maximum repair attempts (${maxAttempts}) reached. Stopping to prevent unbounded loop.`,
    };
  }

  // Ensure proposed mutation targets do not exceed approved targets
  const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const approvedSet = new Set(approvedTargets.map(normPath));
  const unapproved = proposedMutationTargets.filter((t) => !approvedSet.has(normPath(t)));
  if (unapproved.length > 0) {
    return {
      allowRepair: false,
      reason: `Scope expansion detected during repair: [${unapproved.join(', ')}] not in approved targets.`,
    };
  }

  // If last verification was blocked by safety, sandbox, or missing environment, abort repair
  if (lastVerificationResult) {
    const status = String(lastVerificationResult.status || '').toUpperCase();
    if (['BLOCKED', 'SECURITY_RESTRICTION', 'COMMAND_NOT_AVAILABLE', 'ENVIRONMENT_FAILURE'].includes(status)) {
      return {
        allowRepair: false,
        reason: `Cannot repair: verification failed due to unrecoverable condition (${status}).`,
      };
    }
  }

  return {
    allowRepair: true,
    attemptNumber: attemptCount + 1,
    maxAttempts,
    approvedTargets,
  };
}

module.exports = {
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_LIKELY,
  CLASSIFICATION_UNVERIFIED,
  CLASSIFICATION_NOT_A_BUG,
  VALID_CLASSIFICATIONS,
  classifyDefect,
  traceExecutionFlow,
  validateEvidenceReport,
  validatePatchScope,
  enforceApprovalGate,
  analyzeTaskRequirements,
  planProgressiveSearch,
  discoverProjectArchitecture,
  executeToolWithSafeguards,
  manageRepairLoop,
};
