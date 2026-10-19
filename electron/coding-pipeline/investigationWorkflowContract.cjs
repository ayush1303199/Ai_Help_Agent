// Contract and governance for autonomous investigation, evidence classification,
// end-to-end architectural tracing, and workflow approval gates.

const CLASSIFICATION_CONFIRMED = 'CONFIRMED';
const CLASSIFICATION_LIKELY = 'LIKELY';
const CLASSIFICATION_UNVERIFIED = 'UNVERIFIED';
const CLASSIFICATION_NOT_A_BUG = 'NOT A BUG';
const {
  isTrustedWorkItemVerificationResult,
} = require('./workItemVerificationContract.cjs');

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
    || /die\(|var_dump\(|print_r\(|dd\(|dump\(|console\.log\(|debugger;|print\(|System\.out\.println\(|fmt\.Print/i.test(normalizedSnippet)
    || (controlFlow && /not rolled back|missing (?:rollback|null-check)|unhandled exception|resource leak|unhandled rejection/i.test(controlFlow))
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
 * Strips comments from source content to prevent false-positive matches on commented-out code.
 */
function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?:^|[^\\])\/\/.*$/gm, '')
    .replace(/(?:^|[^\\])#.*$/gm, '');
}

function maskNonCodeSource(source, filePath = '') {
  const text = String(source || '');
  const chars = text.split('');
  const extension = String(filePath).toLowerCase().split('.').pop();
  const maskCharacter = (index) => {
    if (text[index] !== '\n' && text[index] !== '\r') chars[index] = ' ';
  };
  const slashCommentExtensions = new Set([
    'c', 'cc', 'cpp', 'cs', 'css', 'dart', 'go', 'h', 'hpp', 'java', 'js', 'jsx',
    'kt', 'kts', 'less', 'mjs', 'php', 'phtml', 'rs', 'scala', 'scss', 'swift',
    'ts', 'tsx',
  ]);
  const hashCommentExtensions = new Set([
    'bash', 'ini', 'php', 'ps1', 'py', 'pyi', 'phtml', 'rb', 'sh', 'toml', 'yaml', 'yml', 'zsh',
  ]);
  const dashCommentExtensions = new Set(['hs', 'lua', 'sql']);
  const lineCommentTokens = [];
  if (slashCommentExtensions.has(extension)) lineCommentTokens.push('//');
  if (hashCommentExtensions.has(extension)) lineCommentTokens.push('#');
  if (dashCommentExtensions.has(extension)) lineCommentTokens.push('--');

  let quote = '';
  let tripleQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') {
        maskCharacter(index);
        if (index + 1 < text.length) maskCharacter(index + 1);
        index += 1;
      } else if (tripleQuote && text.startsWith(quote.repeat(3), index)) {
        maskCharacter(index);
        maskCharacter(index + 1);
        maskCharacter(index + 2);
        index += 2;
        quote = '';
        tripleQuote = false;
      } else if (!tripleQuote && character === quote) {
        maskCharacter(index);
        quote = '';
      } else if (!tripleQuote && quote !== '`' && (character === '\n' || character === '\r')) {
        quote = '';
      } else {
        maskCharacter(index);
      }
      continue;
    }
    const isRustCharacterLiteral = extension !== 'rs'
      || /^'(?:[^'\\\r\n]|\\(?:u\{[\da-fA-F_]+\}|.))'/.test(text.slice(index));
    if (character === '"' || character === '`' || (character === "'" && isRustCharacterLiteral)) {
      quote = character;
      tripleQuote = ['py', 'pyi'].includes(extension) && text.startsWith(character.repeat(3), index);
      maskCharacter(index);
      if (tripleQuote) {
        maskCharacter(index + 1);
        maskCharacter(index + 2);
        index += 2;
      }
      continue;
    }

    const blockStart = text.startsWith('/*', index);
    const htmlCommentStart = text.startsWith('<!--', index);
    const lineToken = lineCommentTokens.find((token) => text.startsWith(token, index));
    if (!blockStart && !htmlCommentStart && !lineToken) continue;

    const endToken = blockStart ? '*/' : htmlCommentStart ? '-->' : null;
    const nestedBlockComments = extension === 'rs' && blockStart;
    let blockDepth = nestedBlockComments ? 0 : (blockStart ? 1 : 0);
    let cursor = index;
    while (cursor < text.length) {
      if (nestedBlockComments && text.startsWith('/*', cursor)) {
        blockDepth += 1;
        chars[cursor] = ' ';
        chars[cursor + 1] = ' ';
        cursor += 2;
        continue;
      }
      if (nestedBlockComments && text.startsWith('*/', cursor)) {
        blockDepth -= 1;
        chars[cursor] = ' ';
        chars[cursor + 1] = ' ';
        cursor += 2;
        if (blockDepth === 0) break;
        continue;
      }
      if (endToken && text.startsWith(endToken, cursor)) {
        cursor += endToken.length;
        break;
      }
      if (!endToken && (text[cursor] === '\n' || text[cursor] === '\r')) break;
      if (text[cursor] !== '\n' && text[cursor] !== '\r') chars[cursor] = ' ';
      cursor += 1;
    }
    index = cursor - 1;
  }
  return chars.join('');
}

/**
 * Generic execution flow tracing across architectural layers for any language / framework.
 * Dynamically resolves entrypoints, primary declarations, data operations, and resource guards.
 */
function traceExecutionFlow({ route, controllerFile, controllerContent, action }) {
  const rawContent = String(controllerContent || '');
  const content = stripComments(rawContent);
  const lines = content.split(/\r?\n/);

  // 1. Detect Framework Signals
  let framework = 'generic';
  if (/(?:yii\\web|Yii::\$app|app\\modules)/i.test(content) || (controllerFile && /modules[\\/].*[\\/]controllers/i.test(controllerFile))) {
    framework = 'yii2';
  } else if (/(?:Illuminate\\|App\\Http\\Controllers|extends\s+Controller)/i.test(content) || (controllerFile && /app[\\/]Http[\\/]Controllers/i.test(controllerFile))) {
    framework = 'laravel';
  } else if (/@(?:Get|Post|Put|Delete|Controller|Injectable)\s*\(/i.test(content) || /@nestjs/i.test(content)) {
    framework = 'nest';
  } else if (/(?:express\(\)|router\.(?:get|post|use)|req,\s*res)/i.test(content)) {
    framework = 'express';
  } else if (/(?:fastapi|rest_framework|django|flask)/i.test(content) || (controllerFile && /\.py$/i.test(controllerFile))) {
    framework = 'python-web';
  } else if (/(?:RestController|RequestMapping|GetMapping|PostMapping|Service)/i.test(content) || (controllerFile && /\.java$/i.test(controllerFile))) {
    framework = 'spring';
  }

  // 2. Generic Primary Declaration Extraction (Class, Struct, or Exported Function)
  const classMatch = content.match(/\b(?:class|struct|interface)\s+([A-Za-z0-9_]+)/);
  const fnMatch = content.match(/(?:export\s+(?:default\s+)?(?:async\s+)?function|def|func)\s+([A-Za-z0-9_]+)/);
  const controllerName = classMatch
    ? classMatch[1]
    : fnMatch
      ? fnMatch[1]
      : (controllerFile ? controllerFile.split(/[/\\]/).pop().replace(/\.\w+$/, '') : 'UnknownController');

  // 3. Generic Endpoint / Route Extraction (HTTP Decorators, Router Calls, Route Definitions)
  const routeMatch = content.match(/(?:Route::(?:get|post|put|delete|any|match)|router\.(?:get|post|put|delete|patch|all)|@app\.(?:get|post|put|delete)|@(?:GetMapping|PostMapping|RequestMapping))\s*\(\s*['"]([^'"]+)['"]/i)
    || (route ? [null, route] : null);
  const detectedRoute = routeMatch ? routeMatch[1] : (route || 'unspecified/route');

  // 4. Generic Action / Handler Extraction
  const actionMatch = content.match(/\b(?:public\s+function|def|func)\s+(?:action)?([A-Za-z0-9_]+)\s*\(/i)
    || content.match(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/i);
  const detectedAction = action || (actionMatch ? actionMatch[1] : 'unknownAction');

  // 5. Generic Data Layer / ORM / Model References
  const modelMatch = content.match(/\b([A-Z][A-Za-z0-9_]+)::(?:findOne|find|save|create|where|first|query)\b/)
    || content.match(/\b([A-Z][A-Za-z0-9_]+Model|[A-Z][A-Za-z0-9_]+Entity|[A-Z][A-Za-z0-9_]+Repository)\b/);
  const modelName = modelMatch ? modelMatch[1] : null;

  // 6. Generic Resource & Transaction Lifecycle Guard Tracking
  const hasTransaction = /(?:beginTransaction|@Transactional|session\.begin|client\.query\(['"]BEGIN['"]\))/i.test(content);
  const transactionCommits = /(?:commit\(\)|client\.query\(['"]COMMIT['"]\))/i.test(content);
  
  // Check catch/except error blocks for rollback/cleanup
  let inCatch = false;
  let rollbackInCatch = false;
  for (const line of lines) {
    if (/catch\s*\(|except\s+.*:/i.test(line)) {
      inCatch = true;
    }
    if (inCatch && /(?:rollBack|rollback|client\.query\(['"]ROLLBACK['"]\))/i.test(line)) {
      rollbackInCatch = true;
    }
    if (inCatch && /(?:return\b|throw\b|\})/.test(line) && !/catch\s*\(|except\s+.*:/.test(line)) {
      inCatch = false;
    }
  }

  // 7. Track Unified Execution Call Chain
  const callChain = [];
  if (detectedRoute && detectedRoute !== 'unspecified/route') callChain.push(`route:${detectedRoute}`);
  if (controllerName) callChain.push(`controller:${controllerName}`);
  if (detectedAction && detectedAction !== 'unknownAction') callChain.push(`action:${detectedAction}`);
  if (modelName) callChain.push(`model:${modelName}`);

  return {
    layers: {
      framework,
      route: detectedRoute,
      controller: controllerName,
      action: detectedAction,
      model: modelName,
      hasTransaction,
      transactionCommits,
      transactionRollbacksInCatch: rollbackInCatch,
      callChain,
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

  const searchStopWords = new Set([
    'please', 'could', 'would', 'should', 'might', 'maybe', 'make', 'made',
    'fix', 'repair', 'patch', 'modify', 'change', 'refactor', 'remove',
    'delete', 'add', 'create', 'implement', 'write', 'apply', 'update',
    'replace', 'resolve', 'investigate', 'find', 'look', 'into', 'this',
    'that', 'these', 'those', 'with', 'from', 'what', 'when', 'where',
    'which', 'who', 'does', 'did', 'are', 'was', 'were', 'have', 'has',
    'been', 'being', 'will', 'can', 'how', 'why', 'the', 'and', 'for',
    'but', 'not', 'all', 'any', 'some', 'your', 'our', 'their', 'there',
    'here', 'then', 'than', 'about', 'into', 'onto', 'after', 'before',
    'method', 'call', 'unreferenced', 'module', 'modules',
  ]);
  const uniqueTerms = [...new Set(words)]
    .filter((word) => !searchStopWords.has(word))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const listedRequirements = text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/)?.[1]?.trim())
    .filter(Boolean);
  const explicitRequirements = listedRequirements.length > 1
    ? listedRequirements
    : [`Address requested behavior: ${text}`];
  const acceptanceCriteria = [
    ...explicitRequirements.map((requirement) => `Satisfy explicit requirement: ${requirement}`),
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

const VALID_SUBTASK_STATUSES = Object.freeze([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'SKIPPED',
  'ABSTAINED',
  'CANCELLED',
]);

const VALID_WORK_ITEM_STATUSES = Object.freeze([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'SKIPPED',
  'DELEGATED',
  'CANCELLED',
]);

const VALID_HYPOTHESIS_STATUSES = Object.freeze([
  'INVESTIGATING',
  'SUPPORTED',
  'REFUTED',
  'CONFIRMED',
  'UNVERIFIED',
]);

const LEGAL_SUBTASK_TRANSITIONS = Object.freeze({
  PENDING: ['IN_PROGRESS', 'SKIPPED', 'BLOCKED', 'ABSTAINED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'BLOCKED', 'ABSTAINED', 'SKIPPED', 'CANCELLED'],
  FAILED: ['IN_PROGRESS', 'BLOCKED', 'ABSTAINED', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'FAILED', 'ABSTAINED', 'CANCELLED'],
  ABSTAINED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  SKIPPED: ['IN_PROGRESS'],
  CANCELLED: [],
});

const LEGAL_WORK_ITEM_TRANSITIONS = Object.freeze({
  PENDING: ['IN_PROGRESS', 'SKIPPED', 'BLOCKED', 'DELEGATED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'BLOCKED', 'SKIPPED', 'DELEGATED', 'CANCELLED'],
  FAILED: ['IN_PROGRESS', 'BLOCKED', 'DELEGATED', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'FAILED', 'DELEGATED', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS', 'BLOCKED'],
  SKIPPED: ['IN_PROGRESS'],
  DELEGATED: ['IN_PROGRESS'],
  CANCELLED: [],
});

const LEGAL_HYPOTHESIS_TRANSITIONS = Object.freeze({
  INVESTIGATING: ['SUPPORTED', 'REFUTED', 'UNVERIFIED', 'CONFIRMED'],
  SUPPORTED: ['CONFIRMED', 'REFUTED', 'INVESTIGATING', 'UNVERIFIED'],
  UNVERIFIED: ['INVESTIGATING', 'SUPPORTED', 'REFUTED'],
  REFUTED: ['INVESTIGATING', 'UNVERIFIED'],
  CONFIRMED: ['REFUTED', 'INVESTIGATING'],
});

const UNTRUSTED_PROVENANCE_SOURCES = new Set([
  'renderer_claim',
  'model_claim',
  'unverified_claim',
  'self_reported',
  'worker_claim',
  'prompt_claim',
]);

const STAGE_EVIDENCE_REQUIREMENTS = Object.freeze({
  'ST-1': ['REQUIREMENTS_ANALYSIS', 'PROJECT_DISCOVERY'],
  'ST-2': ['SOURCE_INSPECTION'],
  'ST-3': ['APPROVED_SCOPE_PROPOSAL'],
  'ST-4': ['EXPLICIT_APPROVAL'],
  'ST-5': ['VERIFICATION_PASS'],
  'ST-6': ['PRESERVATION_AUDIT'],
});

function refreshTaskPlanStatus(taskPlan) {
  if (taskPlan.status === 'NEEDS_CLARIFICATION') return taskPlan.status;
  const stageStatuses = Array.isArray(taskPlan.subtasks)
    ? taskPlan.subtasks.map((subtask) => subtask.status)
    : [];
  const workStatuses = Array.isArray(taskPlan.workItems)
    ? taskPlan.workItems.map((workItem) => workItem.status)
    : [];
  if ([...stageStatuses, ...workStatuses].includes('CANCELLED')) {
    taskPlan.status = 'CANCELLED';
  } else if ([...stageStatuses, ...workStatuses].includes('FAILED')) {
    taskPlan.status = 'FAILED';
  } else {
    const hasDelegatedWork = workStatuses.includes('DELEGATED');
    const workBlocked = workStatuses.some((status) => ['BLOCKED', 'ABSTAINED'].includes(status));
    const stageBlocked = stageStatuses.some((status) => ['BLOCKED', 'ABSTAINED'].includes(status));
    if (workBlocked) {
      taskPlan.status = 'BLOCKED';
    } else if (hasDelegatedWork) {
      taskPlan.status = 'HANDED_OFF';
    } else if (stageBlocked) {
      taskPlan.status = 'BLOCKED';
    } else {
      const stagesSettled = stageStatuses.length === 0 || taskPlan.subtasks.every((subtask) => (
        subtask.status === 'COMPLETED' || subtask.status === 'SKIPPED'
      ));
      const workSettled = workStatuses.length === 0 || taskPlan.workItems.every((workItem) => (
        workItem.status === 'COMPLETED' || workItem.status === 'SKIPPED'
      ));
      taskPlan.status = stagesSettled && workSettled
        ? 'COMPLETED'
        : stageStatuses.includes('IN_PROGRESS') || workStatuses.includes('IN_PROGRESS')
          ? 'IN_PROGRESS'
          : 'PENDING';
    }
  }
  return taskPlan.status;
}

function invalidateCompletedWorkItems(taskPlan, reason = 'Approved proposal changes were rolled back.') {
  if (!taskPlan || !Array.isArray(taskPlan.workItems)) return taskPlan;
  for (const item of [...taskPlan.workItems].reverse()) {
    if (item.status !== 'COMPLETED') continue;
    advanceTaskPlan(taskPlan, {
      workItemId: item.id,
      status: 'BLOCKED',
      outcome: reason,
    });
  }
  return taskPlan;
}

/**
 * Creates a versioned request plan while keeping stable lifecycle stage IDs.
 */
function createTaskPlan({
  userRequest,
  projectArch = null,
  requirements = null,
  operatingMode = 'AUTONOMOUS',
  complexity = 'DEEP',
  capabilities = {},
}) {
  const goal = String(userRequest || '').trim();
  const canApply = capabilities.canApply ?? ['AUTONOMOUS', 'BUILD'].includes(operatingMode);
  const canPropose = capabilities.canPropose ?? canApply;
  const canVerify = capabilities.canVerify ?? canApply;
  const isClarificationRequired = requirements?.needsClarification === true || !goal;
  const explicitRequirements = Array.isArray(requirements?.explicitRequirements)
    ? requirements.explicitRequirements.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const requirementUnits = isClarificationRequired
    ? []
    : operatingMode === 'AUTONOMOUS' && canApply && explicitRequirements.length > 1
      ? explicitRequirements.slice(0, 12)
      : [explicitRequirements[0] || goal];
  const capabilityBlockers = [];
  if (canApply && capabilities.approvalAvailable === false) capabilityBlockers.push('APPROVAL_UNAVAILABLE');
  if (canVerify && capabilities.verificationAvailable === false) capabilityBlockers.push('VERIFICATION_UNAVAILABLE');
  const completionEvidence = canApply
    ? ['APPROVED_SCOPE_PROPOSAL', 'EXPLICIT_APPROVAL', 'VERIFICATION_PASS', 'PRESERVATION_AUDIT']
    : operatingMode === 'AUDIT'
      ? ['SOURCE_INSPECTION', 'PRESERVATION_AUDIT']
      : ['SOURCE_INSPECTION'];
  const subtasks = [
    {
      id: 'ST-1',
      title: 'Analyze Task Requirements & Architecture Boundaries',
      status: isClarificationRequired ? 'BLOCKED' : 'PENDING',
      phase: 'UNDERSTAND',
      dependsOn: [],
      requiredEvidence: STAGE_EVIDENCE_REQUIREMENTS['ST-1'],
      expectedOutcome: 'Task scope and constraints are grounded in the original request.',
    },
    {
      id: 'ST-2',
      title: 'Dynamic Codebase Investigation & Execution Flow Tracing',
      status: isClarificationRequired ? 'SKIPPED' : 'PENDING',
      phase: 'INVESTIGATE',
      dependsOn: ['ST-1'],
      requiredEvidence: STAGE_EVIDENCE_REQUIREMENTS['ST-2'],
      expectedOutcome: 'Relevant sources and evidence have been inspected for the requested objective.',
    },
    {
      id: 'ST-3',
      title: 'Formulate Root-Cause Hypothesis & Minimal Patch Plan',
      status: isClarificationRequired ? 'SKIPPED' : 'PENDING',
      phase: 'PLAN',
      dependsOn: ['ST-2'],
      requiredEvidence: STAGE_EVIDENCE_REQUIREMENTS['ST-3'],
      expectedOutcome: 'A proposal is prepared only for an established defect and authorized scope.',
    },
    {
      id: 'ST-4',
      title: 'Enforce Approval Gate & Apply Atomic Changes',
      status: isClarificationRequired ? 'SKIPPED' : 'PENDING',
      phase: 'APPROVE',
      dependsOn: ['ST-3'],
      requiredEvidence: STAGE_EVIDENCE_REQUIREMENTS['ST-4'],
      expectedOutcome: 'The exact proposal and scope receive explicit user approval.',
    },
    {
      id: 'ST-5',
      title: 'Execute Verification Check & Truthful Evidence Recording',
      status: isClarificationRequired ? 'SKIPPED' : 'PENDING',
      phase: 'VERIFY',
      dependsOn: ['ST-4'],
      requiredEvidence: STAGE_EVIDENCE_REQUIREMENTS['ST-5'],
      expectedOutcome: 'Verification passes with trusted execution evidence.',
    },
    {
      id: 'ST-6',
      title: 'Preservation Audit & Completion Reporting',
      status: isClarificationRequired ? 'SKIPPED' : 'PENDING',
      phase: 'AUDIT',
      dependsOn: [canApply || operatingMode === 'AUDIT' ? 'ST-5' : 'ST-2'],
      requiredEvidence: STAGE_EVIDENCE_REQUIREMENTS['ST-6'],
      expectedOutcome: 'The approved scope and repository preservation are audited.',
    },
  ];

  if (!canApply && !isClarificationRequired) {
    subtasks[2].status = 'SKIPPED';
    subtasks[2].expectedOutcome = 'Skipped: Read-only mode active; code modifications are disallowed.';
    subtasks[3].status = 'SKIPPED';
    subtasks[3].expectedOutcome = 'Skipped: Read-only mode active; proposal application is disallowed.';
    subtasks[4].status = 'SKIPPED';
    subtasks[4].expectedOutcome = 'Skipped: This read-only workflow does not execute verification.';
    if (operatingMode !== 'AUDIT') subtasks[5].status = 'SKIPPED';
  }
  if (capabilityBlockers.includes('APPROVAL_UNAVAILABLE')) subtasks[3].status = 'BLOCKED';
  if (capabilityBlockers.includes('VERIFICATION_UNAVAILABLE')) subtasks[4].status = 'BLOCKED';

  const workItems = requirementUnits.map((objective, index) => ({
    id: `WI-${String(index + 1).padStart(3, '0')}`,
    objective,
    status: capabilityBlockers.length > 0 ? 'BLOCKED' : 'PENDING',
    stageId: operatingMode === 'AUDIT' ? 'ST-6' : canApply ? 'ST-6' : 'ST-2',
    dependsOn: [],
    requiredEvidence: [...completionEvidence],
    completionCriteria: [objective],
    source: 'USER_REQUEST',
  }));

  const hypotheses = [
    {
      id: 'H1',
      hypothesis: `Investigate behavior matching: "${goal.slice(0, 100)}" across architectural layers.`,
      status: isClarificationRequired ? 'UNVERIFIED' : 'INVESTIGATING',
      confidence: 'MEDIUM',
    },
  ];

  const taskPlan = {
    schemaVersion: 2,
    goal,
    operatingMode,
    complexity,
    projectEcosystem: projectArch?.ecosystem || 'UNKNOWN',
    planType: 'REQUEST_DRIVEN',
    dynamicDecomposition: true,
    permissions: { canPropose, canApply, canVerify },
    capabilities: { ...capabilities },
    capabilityBlockers,
    status: isClarificationRequired ? 'NEEDS_CLARIFICATION' : capabilityBlockers.length ? 'BLOCKED' : 'PENDING',
    planNotice: 'Request work items are bounded to explicit requirements; stable lifecycle stages retain execution ownership.',
    workItems,
    hypotheses,
    subtasks,
    constraints: [
      'Preserve pre-existing dirty files and unrelated repository changes.',
      'Require approved proposals and verified baseline snapshots before writes.',
      'Fail-closed if sandbox execution or verification runner is unavailable.',
      'Audit mode forbids git mutation, staging, commits, and file updates.',
    ],
    updatedAt: new Date().toISOString(),
  };
  return taskPlan;
}

/**
 * Advances subtask and hypothesis statuses dynamically as observed work completes.
 * Enforces legal state machine transitions, evidence requirements, and provenance validation.
 */
function advanceTaskPlan(taskPlan, {
  subtaskId,
  workItemId,
  status,
  outcome = null,
  hypothesisId = null,
  hypothesisStatus = null,
  evidence = null,
} = {}) {
  if (!taskPlan || (!Array.isArray(taskPlan.subtasks) && !Array.isArray(taskPlan.workItems))) return taskPlan;

  const evidenceTypes = (candidate) => (
    candidate && Array.isArray(candidate.types) ? candidate.types : []
  );
  const validateTrustedEvidence = (candidate, itemLabel) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${itemLabel} cannot be COMPLETED without structured evidence.`);
    }
    if (candidate.provenance && UNTRUSTED_PROVENANCE_SOURCES.has(String(candidate.provenance).toLowerCase())) {
      throw new Error(`${itemLabel} cannot be COMPLETED from untrusted provenance: ${candidate.provenance}`);
    }
    if (candidate.verified === false || candidate.contradictory === true) {
      throw new Error(`${itemLabel} cannot be COMPLETED with contradictory or unverified evidence.`);
    }
  };
  const validateWorkItemStatus = (item, nextStatus, itemEvidence) => {
    if (!VALID_WORK_ITEM_STATUSES.includes(nextStatus)) {
      throw new Error(`Invalid work item status: ${nextStatus}. Must be one of: ${VALID_WORK_ITEM_STATUSES.join(', ')}`);
    }
    if (item.status !== nextStatus) {
      const allowed = LEGAL_WORK_ITEM_TRANSITIONS[item.status] || [];
      if (!allowed.includes(nextStatus)) {
        throw new Error(`Illegal work item transition from ${item.status} to ${nextStatus} for ${item.id}.`);
      }
    }
    if (['IN_PROGRESS', 'COMPLETED'].includes(nextStatus)) {
      for (const dependencyId of item.dependsOn || []) {
        const dependency = taskPlan.workItems.find((candidate) => candidate.id === dependencyId);
        if (!dependency || dependency.status !== 'COMPLETED') {
          throw new Error(`Work item ${item.id} cannot advance before dependency ${dependencyId} is completed.`);
        }
      }
    }
    if (nextStatus === 'COMPLETED') {
      if (!isTrustedWorkItemVerificationResult(itemEvidence, { plan: taskPlan, item })) {
        throw new Error(`Work item ${item.id} cannot be completed without a trusted, item-bound host verification result.`);
      }
    }
    if (nextStatus === 'DELEGATED') {
      validateTrustedEvidence(itemEvidence, `Work item ${item.id}`);
      const expectedTypes = nextStatus === 'DELEGATED' ? ['STANDARD_PROPOSAL_HANDOFF'] : item.requiredEvidence;
      const actualTypes = evidenceTypes(itemEvidence);
      if (!expectedTypes.every((type) => actualTypes.includes(type))) {
        throw new Error(`Work item ${item.id} lacks required evidence: ${expectedTypes.filter((type) => !actualTypes.includes(type)).join(', ')}.`);
      }
      if (itemEvidence.objective !== item.objective) {
        throw new Error(`Work item ${item.id} evidence is not bound to its original objective.`);
      }
    }
  };
  const applyWorkItemStatus = (item, nextStatus, itemOutcome, itemEvidence) => {
    validateWorkItemStatus(item, nextStatus, itemEvidence);
    if (item.status === 'COMPLETED' && nextStatus !== 'COMPLETED') {
      delete item.evidence;
      delete item.verificationResult;
    }
    item.status = nextStatus;
    if (itemOutcome) item.outcome = String(itemOutcome);
    if (itemEvidence) item.evidence = itemEvidence;
    item.updatedAt = new Date().toISOString();
  };

  if (workItemId && status) {
    const workItem = taskPlan.workItems.find((item) => item.id === workItemId);
    if (!workItem) throw new Error(`Work item not found in plan: ${workItemId}`);
    applyWorkItemStatus(workItem, status, outcome, evidence);
  }

  if (subtaskId && status && Array.isArray(taskPlan.subtasks)) {
    if (!VALID_SUBTASK_STATUSES.includes(status)) {
      throw new Error(`Invalid subtask status: ${status}. Must be one of: ${VALID_SUBTASK_STATUSES.join(', ')}`);
    }
    const subtask = taskPlan.subtasks.find((item) => item.id === subtaskId);
    if (!subtask) throw new Error(`Subtask not found in plan: ${subtaskId}`);

    if (subtask.status !== status) {
      const allowed = LEGAL_SUBTASK_TRANSITIONS[subtask.status] || [];
      if (!allowed.includes(status)) {
        throw new Error(`Illegal subtask transition from ${subtask.status} to ${status} for ${subtaskId}.`);
      }
    }

    if (status === 'IN_PROGRESS') {
      for (const dependencyId of subtask.dependsOn || []) {
        const dependency = taskPlan.subtasks.find((candidate) => candidate.id === dependencyId);
        if (!dependency || !['COMPLETED', 'SKIPPED'].includes(dependency.status)) {
          throw new Error(`Subtask ${subtaskId} cannot start before dependency ${dependencyId} is resolved.`);
        }
      }
    }
    if (status === 'COMPLETED') {
      validateTrustedEvidence(evidence, `Subtask ${subtaskId}`);
      if (subtaskId === 'ST-1' && (!Number.isInteger(evidence.requirementCount) || !evidence.requestHash)) {
        throw new Error('Subtask ST-1 requires evidence bound to analyzed requirements and the original request.');
      }
      if (subtaskId === 'ST-2'
        && (!Array.isArray(evidence.sourceEvidence) || evidence.sourceEvidence.length === 0)) {
        throw new Error('Subtask ST-2 requires at least one inspected source evidence reference.');
      }
      if (subtaskId === 'ST-5'
        && (evidence.status !== 'PASS' || evidence.exitCode !== 0
          || evidence.isPassing !== true || evidence.executed !== true)) {
        throw new Error('Subtask ST-5 cannot be COMPLETED without an executed passing verification result and zero exit code.');
      }
      const missingTypes = (subtask.requiredEvidence || []).filter((type) => !evidenceTypes(evidence).includes(type));
      if (missingTypes.length > 0) {
        throw new Error(`Subtask ${subtaskId} cannot be COMPLETED without required evidence: ${missingTypes.join(', ')}.`);
      }
      if (subtaskId === 'ST-3'
        && (!evidence.proposalId
          || (!Array.isArray(evidence.targets) && !evidence.targetFile)
          || !evidence.snapshotHash)) {
        throw new Error('Subtask ST-3 requires a proposal ID and its approved target scope.');
      }
      if (subtaskId === 'ST-4') {
        const proposalEvidence = taskPlan.subtasks.find((item) => item.id === 'ST-3')?.evidence;
        const expectedTargets = proposalEvidence?.targets || [proposalEvidence?.targetFile].filter(Boolean);
        const approvedTargets = Array.isArray(evidence.approvedTargets) ? evidence.approvedTargets : [];
        if (evidence.approved !== true
          || !evidence.proposalId
          || evidence.proposalId !== proposalEvidence?.proposalId
          || expectedTargets.length !== approvedTargets.length
          || expectedTargets.some((target) => !approvedTargets.includes(target))) {
          throw new Error('Subtask ST-4 approval evidence must bind to the proposal created in ST-3.');
        }
      }
      if (subtaskId === 'ST-5') {
        const proposalEvidence = taskPlan.subtasks.find((item) => item.id === 'ST-3')?.evidence;
        const approvalEvidence = taskPlan.subtasks.find((item) => item.id === 'ST-4')?.evidence;
        if (!proposalEvidence?.proposalId
          || proposalEvidence.proposalId !== approvalEvidence?.proposalId
          || (evidence.proposalId && evidence.proposalId !== proposalEvidence.proposalId)) {
          throw new Error('Subtask ST-5 verification evidence does not match the approved proposal.');
        }
        if (!Array.isArray(evidence.attempts)
          || evidence.attempts.length === 0
          || !evidence.attempts.every((attempt) => attempt?.executed === true && attempt?.exitCode === 0)) {
          throw new Error('Subtask ST-5 requires host-observed successful execution attempts.');
        }
      }
      if (subtaskId === 'ST-6' && evidence.preserved !== true) {
        throw new Error('Subtask ST-6 requires evidence that pre-existing files were preserved.');
      }
    }

    subtask.status = status;
    if (outcome) subtask.outcome = String(outcome);
    if (evidence) subtask.evidence = evidence;
    subtask.updatedAt = new Date().toISOString();

    const linkedWorkItems = (taskPlan.workItems || []).filter((item) => item.stageId === subtaskId);
    if (status === 'IN_PROGRESS') {
      for (const item of linkedWorkItems) {
        if (['PENDING', 'BLOCKED', 'FAILED'].includes(item.status)) {
          applyWorkItemStatus(item, 'IN_PROGRESS', 'The owning lifecycle stage is active.');
        }
      }
    } else if (status === 'COMPLETED') {
      for (const item of linkedWorkItems) {
        if (!['COMPLETED', 'SKIPPED', 'DELEGATED', 'CANCELLED', 'BLOCKED'].includes(item.status)) {
          applyWorkItemStatus(
            item,
            'BLOCKED',
            "Lifecycle-stage evidence does not establish this work item's objective; trusted item-specific verification is unavailable.",
          );
        }
      }
    } else if (['FAILED', 'BLOCKED', 'ABSTAINED', 'CANCELLED'].includes(status)) {
      const itemStatus = status === 'ABSTAINED' ? 'BLOCKED' : status;
      const affectedItems = status === 'CANCELLED'
        ? (taskPlan.workItems || []).filter((item) => !['COMPLETED', 'SKIPPED', 'DELEGATED', 'CANCELLED'].includes(item.status))
        : linkedWorkItems;
      for (const item of affectedItems) {
        if (item.status !== itemStatus) {
          applyWorkItemStatus(item, itemStatus, outcome);
        }
      }
    }
  }

  if (hypothesisId && hypothesisStatus && Array.isArray(taskPlan.hypotheses)) {
    if (!VALID_HYPOTHESIS_STATUSES.includes(hypothesisStatus)) {
      throw new Error(`Invalid hypothesis status: ${hypothesisStatus}. Must be one of: ${VALID_HYPOTHESIS_STATUSES.join(', ')}`);
    }
    const hypothesis = taskPlan.hypotheses.find((h) => h.id === hypothesisId);
    if (!hypothesis) {
      throw new Error(`Hypothesis not found in plan: ${hypothesisId}`);
    }

    if (hypothesis.status !== hypothesisStatus) {
      const allowed = LEGAL_HYPOTHESIS_TRANSITIONS[hypothesis.status] || [];
      if (!allowed.includes(hypothesisStatus)) {
        throw new Error(`Illegal hypothesis transition from ${hypothesis.status} to ${hypothesisStatus} for ${hypothesisId}.`);
      }
    }

    if (hypothesisStatus === 'CONFIRMED') {
      if (!evidence || (typeof evidence === 'string' && evidence.trim().length === 0)) {
        throw new Error(`Hypothesis ${hypothesisId} cannot become CONFIRMED without supporting evidence.`);
      }
      if (typeof evidence === 'object') {
        if (evidence.provenance && UNTRUSTED_PROVENANCE_SOURCES.has(String(evidence.provenance).toLowerCase())) {
          throw new Error(`Hypothesis ${hypothesisId} cannot become CONFIRMED from untrusted provenance: ${evidence.provenance}`);
        }
        if (evidence.contradictory === true || evidence.verified === false) {
          throw new Error(`Hypothesis ${hypothesisId} cannot become CONFIRMED with contradictory or unverified evidence.`);
        }
      }
    } else if (hypothesisStatus === 'SUPPORTED') {
      if (!evidence || (typeof evidence === 'string' && evidence.trim().length === 0)) {
        throw new Error(`Hypothesis ${hypothesisId} cannot become SUPPORTED without evidence.`);
      }
    }

    hypothesis.status = hypothesisStatus;
    if (evidence) hypothesis.evidence = evidence;
    hypothesis.updatedAt = new Date().toISOString();
  }

  refreshTaskPlanStatus(taskPlan);
  taskPlan.updatedAt = new Date().toISOString();
  return taskPlan;
}

module.exports = {
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_LIKELY,
  CLASSIFICATION_UNVERIFIED,
  CLASSIFICATION_NOT_A_BUG,
  VALID_CLASSIFICATIONS,
  VALID_SUBTASK_STATUSES,
  VALID_WORK_ITEM_STATUSES,
  VALID_HYPOTHESIS_STATUSES,
  LEGAL_SUBTASK_TRANSITIONS,
  LEGAL_WORK_ITEM_TRANSITIONS,
  LEGAL_HYPOTHESIS_TRANSITIONS,
  classifyDefect,
  maskNonCodeSource,
  traceExecutionFlow,
  validateEvidenceReport,
  validatePatchScope,
  enforceApprovalGate,
  invalidateCompletedWorkItems,
  analyzeTaskRequirements,
  planProgressiveSearch,
  discoverProjectArchitecture,
  executeToolWithSafeguards,
  manageRepairLoop,
  createTaskPlan,
  advanceTaskPlan,
};
