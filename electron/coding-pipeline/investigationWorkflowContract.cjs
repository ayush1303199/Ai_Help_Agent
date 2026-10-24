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
  lineRange,
  codeSnippet,
  codeEvidence,
  controlFlow,
  causalExplanation,
  expected,
  observed,
  evidenceType,
}) {
  const lineSpec = lines || (typeof lineRange === 'object' && lineRange !== null ? `${lineRange.startLine}-${lineRange.endLine}` : null);
  if (!filePath || !symbol || !lineSpec) {
    throw new Error('Defect classification requires exact filePath, symbol, and line range.');
  }

  let classification = CLASSIFICATION_UNVERIFIED;
  let isConfirmed = false;

  const normalizedSnippet = String(codeEvidence || codeSnippet || '').trim();
  const normalizedEvidence = String(evidenceType || '').toUpperCase();
  const normalizedCausal = String(causalExplanation || controlFlow || observed || '').trim();

  // If behavior matches expected design
  if (
    normalizedEvidence === 'STATIC_INSPECTION_VALID'
    || (expected && observed && expected.trim() === observed.trim())
  ) {
    classification = CLASSIFICATION_NOT_A_BUG;
    isConfirmed = false;
  } else if (
    normalizedEvidence.includes('CONFIRMED')
    || /\b(?:die|var_dump|print_r|dd|dump|console\.log|print|System\.out\.println|fmt\.Print)\s*\(|debugger;/i.test(normalizedSnippet)
    || (controlFlow && /not rolled back|missing (?:rollback|null-check)|unhandled exception|resource leak|unhandled rejection/i.test(controlFlow))
    || (causalExplanation && /uncaught|unhandled|null pointer|undefined property|correlates with line/i.test(causalExplanation))
  ) {
    classification = CLASSIFICATION_CONFIRMED;
    isConfirmed = true;
  } else if (normalizedEvidence.includes('LIKELY') || normalizedSnippet) {
    classification = CLASSIFICATION_LIKELY;
    isConfirmed = false;
  }

  const normalizedRange = typeof lineRange === 'object' && lineRange !== null
    ? { startLine: Number(lineRange.startLine) || 1, endLine: Number(lineRange.endLine) || 1 }
    : (typeof lineSpec === 'string' && lineSpec.includes('-')
        ? { startLine: Number(lineSpec.split('-')[0]) || 1, endLine: Number(lineSpec.split('-')[1]) || 1 }
        : { startLine: Number(lineSpec) || 1, endLine: Number(lineSpec) || 1 });

  return {
    filePath,
    symbol,
    lines: String(lineSpec),
    lineRange: normalizedRange,
    codeSnippet: normalizedSnippet,
    codeEvidence: normalizedSnippet,
    causalExplanation: normalizedCausal,
    controlFlow: String(controlFlow || normalizedCausal),
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

  // 8. Extract Imported Dependencies / Symbols (Multi-Hop Tracing)
  const importedDependencies = [];
  // JS/TS imports and requires
  const esmImportRegex = /(?:import\s+(?:(?:\{([^}]+)\})|(?:\*\s+as\s+([A-Za-z0-9_]+))|([A-Za-z0-9_]+))\s+from\s+['"]([^'"]+)['"])|(?:(?:const|let|var)\s+(?:(?:\{([^}]+)\})|([A-Za-z0-9_]+))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\))/g;
  let match;
  while ((match = esmImportRegex.exec(rawContent)) !== null) {
    const rawPath = match[4] || match[7];
    const rawSymbols = match[1] || match[2] || match[3] || match[5] || match[6] || '';
    if (rawPath) {
      const symbols = rawSymbols
        ? rawSymbols.split(',').map((s) => s.trim().replace(/^.* as /, '')).filter(Boolean)
        : [];
      importedDependencies.push({
        path: rawPath,
        symbols,
        isRelative: rawPath.startsWith('.') || rawPath.startsWith('/'),
      });
    }
  }

  // Python imports
  const pyImportRegex = /(?:from\s+([A-Za-z0-9_.]+)\s+import\s+([A-Za-z0-9_,\s*]+))|(?:import\s+([A-Za-z0-9_.]+))/g;
  while ((match = pyImportRegex.exec(rawContent)) !== null) {
    const rawMod = match[1] || match[3];
    const rawSymbols = match[2] || '';
    if (rawMod) {
      const symbols = rawSymbols
        ? rawSymbols.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      importedDependencies.push({
        path: rawMod,
        symbols,
        isRelative: rawMod.startsWith('.'),
      });
    }
  }

  // PHP use / require
  const phpUseRegex = /(?:use\s+([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?;)|(?:(?:require|require_once|include|include_once)\s*(?:\(?\s*__DIR__\s*\.\s*)?['"]([^'"]+)['"]\)?)/g;
  while ((match = phpUseRegex.exec(rawContent)) !== null) {
    if (match[1]) {
      const fullNamespace = match[1];
      const alias = match[2] || fullNamespace.split('\\').pop();
      importedDependencies.push({
        path: fullNamespace,
        symbols: [alias],
        isRelative: false,
      });
    } else if (match[3]) {
      const relPath = match[3];
      importedDependencies.push({
        path: relPath,
        symbols: [],
        isRelative: relPath.startsWith('.') || relPath.startsWith('/'),
      });
    }
  }

  // 9. Generic Outbound Render / View / Component Targets Extraction (Universal 2nd-Hop)
  const renderTargets = [];
  const renderRegexes = [
    // PHP / Express / Django / Flask / Rails render/view calls
    /(?:\$this->|res\.)?(?:render|renderPartial|render_template|view|display|show)\s*\(\s*['"]([^'"]+)['"]/g,
    // JSX / TSX Component invocations (<TargetComponent ... />)
    /<([A-Z][A-Za-z0-9_]+)(?:\s+[^>]*?)?(?:\/?>)/g,
  ];
  for (const regex of renderRegexes) {
    let rMatch;
    while ((rMatch = regex.exec(rawContent)) !== null) {
      const target = rMatch[1];
      if (target && !renderTargets.includes(target)) {
        renderTargets.push(target);
      }
    }
  }

  // 10. Generic Outbound Callee Symbols & Static Invocations (Universal 2nd-Hop)
  const outboundCallees = [];
  const calleeRegexes = [
    // Static method calls: ClassName::methodName(...)
    /\b([A-Z][A-Za-z0-9_]+)::([A-Za-z0-9_]+)\s*\(/g,
    // Method calls on services / models: this.service.method(...) or this->service->method(...)
    /(?:this|self|\$this)[.->]+([A-Za-z0-9_]+)[.->]+([A-Za-z0-9_]+)\s*\(/g,
    // Service/Model class references: e.g. UserValidator.validate(...)
    /\b([A-Z][A-Za-z0-9_]+(?:Service|Model|Repository|Validator|Client|Helper))\s*[.:]+([A-Za-z0-9_]+)\s*\(/g,
  ];
  for (const regex of calleeRegexes) {
    let cMatch;
    while ((cMatch = regex.exec(rawContent)) !== null) {
      const target = cMatch[1];
      const method = cMatch[2] || undefined;
      if (target && !outboundCallees.some((item) => item.target === target && item.method === method)) {
        outboundCallees.push({ target, method });
      }
    }
  }

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
      dependencies: importedDependencies,
      renderTargets,
      outboundCallees,
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

  // Anti-Speculation Gate: Validate claimed defects against actual inspected files
  if (Array.isArray(claimedDefects) && claimedDefects.length > 0) {
    const inspectedMap = new Map();
    for (const item of inspectedFiles) {
      if (typeof item === 'string') {
        inspectedMap.set(item, null);
      } else if (item && typeof item === 'object' && item.path) {
        inspectedMap.set(item.path, item);
      }
    }

    for (const defect of claimedDefects) {
      if (!defect || typeof defect !== 'object') continue;
      // 1. File must have been inspected if inspectedFiles was populated
      if (inspectedMap.size > 0 && defect.filePath && !inspectedMap.has(defect.filePath)) {
        return {
          isValid: false,
          verificationAccepted: false,
          rejectionReason: `Defect in uninspected file rejected: ${defect.filePath}. Root-cause diagnosis requires grounded source inspection.`,
        };
      }

      // 2. Code evidence must be non-empty
      const snippet = String(defect.codeEvidence || defect.codeSnippet || '').trim();
      if (!snippet) {
        return {
          isValid: false,
          verificationAccepted: false,
          rejectionReason: `Defect in ${defect.filePath || 'unknown file'} lacks verified code evidence.`,
        };
      }

      // 3. If file content is available in inspectedFiles, verify code evidence exists in content
      // (Omission defects like missing rollbacks describe missing control flow rather than literal matches)
      const inspectedEntry = inspectedMap.get(defect.filePath);
      const isOmission = String(defect.evidenceType || '').includes('CONTROL_FLOW') || snippet.startsWith('//');
      if (!isOmission && inspectedEntry && typeof inspectedEntry.content === 'string') {
        const fileContent = inspectedEntry.content.replace(/\r\n/g, '\n');
        const snippetLines = snippet.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
        const snippetMatched = snippetLines.some((sLine) => fileContent.includes(sLine));
        if (!snippetMatched) {
          return {
            isValid: false,
            verificationAccepted: false,
            rejectionReason: `Defect code evidence does not match actual disk content of ${defect.filePath}.`,
          };
        }
      }

      // 4. Line range validation against inspected file range
      if (inspectedEntry && inspectedEntry.lineRange && typeof inspectedEntry.lineRange === 'object') {
        const startLine = defect.lineRange?.startLine || Number(String(defect.lines).split('-')[0]);
        if (
          Number.isInteger(startLine) &&
          inspectedEntry.lineRange.startLine &&
          inspectedEntry.lineRange.endLine &&
          (startLine < inspectedEntry.lineRange.startLine || startLine > inspectedEntry.lineRange.endLine)
        ) {
          return {
            isValid: false,
            verificationAccepted: false,
            rejectionReason: `Defect line ${startLine} is outside inspected range ${inspectedEntry.lineRange.startLine}-${inspectedEntry.lineRange.endLine} for ${defect.filePath}.`,
          };
        }
      }

      // 5. Zero-speculation enforcement: reject ungrounded speculative language in causal explanation
      const explanation = String(defect.causalExplanation || defect.relationship || '').trim();
      if (explanation && /\b(?:probably|likely|or another\.\.\.|might be referenced as)\b/i.test(explanation)) {
        return {
          isValid: false,
          verificationAccepted: false,
          rejectionReason: `Defect explanation in ${defect.filePath || 'unknown file'} contains speculative phrasing. Grounded diagnosis must cite inspected source evidence without unverified speculation.`,
        };
      }
    }
  }

  if (claimedVerification === 'PASSED') {
    if (!executionAuditLog || typeof executionAuditLog !== 'object') {
      return {
        isValid: false,
        verificationAccepted: false,
        rejectionReason: 'Authoritative execution audit log is required to claim tests passed.',
      };
    }
    if (executionAuditLog.executed !== true) {
      return {
        isValid: false,
        verificationAccepted: false,
        rejectionReason: 'Cannot claim PASSED when verification was not actually executed.',
      };
    }
    if (executionAuditLog.exitCode !== 0) {
      return {
        isValid: false,
        verificationAccepted: false,
        rejectionReason: `Cannot claim PASSED when execution audit log exited with non-zero code (${executionAuditLog.exitCode}).`,
      };
    }
    if (Array.isArray(executionAuditLog.attempts) && executionAuditLog.attempts.length === 0) {
      return {
        isValid: false,
        verificationAccepted: false,
        rejectionReason: 'Cannot claim PASSED with zero executed verification attempts.',
      };
    }
    if (Array.isArray(executionAuditLog.attempts) && executionAuditLog.attempts.some((a) => a.exitCode !== 0 || a.ok === false)) {
      return {
        isValid: false,
        verificationAccepted: false,
        rejectionReason: 'Cannot claim PASSED when one or more verification attempts failed.',
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
 * Validates the structured proposal contract ensuring evidence grounding,
 * exact line ranges, root-cause link, and expected runtime behavior statements.
 */
function validateProposalContract(contract, { inspectedFiles = [], verifiedFindings = [] } = {}) {
  if (!contract || typeof contract !== 'object') {
    return { isValid: false, rejectionReason: 'Proposal contract must be a non-null object.' };
  }
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

  if (contract.isModular === true) {
    if (!contract.targetFile && (!Array.isArray(contract.files) || contract.files.length === 0)) {
      return { isValid: false, rejectionReason: 'Modular proposal contract requires targetFile or files array.' };
    }
    if (!contract.expectedBehavior || typeof contract.expectedBehavior !== 'string' || !contract.expectedBehavior.trim()) {
      return { isValid: false, rejectionReason: 'Modular proposal contract requires expectedBehavior statement.' };
    }
    return { isValid: true };
  }

  // 1. targetFile validation
  if (!contract.targetFile || typeof contract.targetFile !== 'string') {
    return { isValid: false, rejectionReason: 'Proposal contract missing valid targetFile string.' };
  }
  const targetNorm = norm(contract.targetFile);

  // 2. Stage 3 inspection grounding
  if (Array.isArray(inspectedFiles) && inspectedFiles.length > 0) {
    const inspectedSet = new Set(
      inspectedFiles.map((f) => norm(typeof f === 'string' ? f : f?.path)).filter(Boolean)
    );
    if (!inspectedSet.has(targetNorm)) {
      return {
        isValid: false,
        rejectionReason: `Scope violation: targetFile [${contract.targetFile}] was not inspected in Stage 3.`,
      };
    }
  }

  // 3. Verified finding grounding
  if (Array.isArray(verifiedFindings) && verifiedFindings.length > 0) {
    const findingSet = new Set(
      verifiedFindings.map((f) => norm(f?.filePath)).filter(Boolean)
    );
    if (!findingSet.has(targetNorm)) {
      return {
        isValid: false,
        rejectionReason: `Scope violation: targetFile [${contract.targetFile}] has no verified defect finding.`,
      };
    }
  }

  // 4. targetLineRange validation
  if (
    !contract.targetLineRange ||
    typeof contract.targetLineRange !== 'object' ||
    !Number.isInteger(contract.targetLineRange.startLine) ||
    !Number.isInteger(contract.targetLineRange.endLine) ||
    contract.targetLineRange.startLine < 1 ||
    contract.targetLineRange.endLine < contract.targetLineRange.startLine
  ) {
    return { isValid: false, rejectionReason: 'Proposal contract requires valid startLine and endLine (>= 1, endLine >= startLine).' };
  }

  // 5. rootCauseSummary validation
  if (!contract.rootCauseSummary || typeof contract.rootCauseSummary !== 'string' || !contract.rootCauseSummary.trim()) {
    return { isValid: false, rejectionReason: 'Proposal contract requires a non-empty rootCauseSummary.' };
  }

  // 6. originalCode validation
  if (typeof contract.originalCode !== 'string') {
    return { isValid: false, rejectionReason: 'Proposal contract requires originalCode string.' };
  }

  // 7. proposedCode validation
  if (typeof contract.proposedCode !== 'string') {
    return { isValid: false, rejectionReason: 'Proposal contract requires proposedCode string.' };
  }

  // 8. expectedBehavior validation
  if (!contract.expectedBehavior || typeof contract.expectedBehavior !== 'string' || !contract.expectedBehavior.trim()) {
    return { isValid: false, rejectionReason: 'Proposal contract requires a non-empty expectedBehavior statement.' };
  }

  // 9. Verified source content grounding
  if (Array.isArray(inspectedFiles) && inspectedFiles.length > 0) {
    const inspectedEntry = inspectedFiles.find((f) => norm(typeof f === 'string' ? f : f?.path) === targetNorm);
    if (inspectedEntry && typeof inspectedEntry.content === 'string') {
      const fileLines = inspectedEntry.content.split(/\r?\n/);
      if (contract.targetLineRange.endLine > fileLines.length) {
        return {
          isValid: false,
          rejectionReason: `targetLineRange [${contract.targetLineRange.startLine}-${contract.targetLineRange.endLine}] exceeds total file lines (${fileLines.length}) in ${contract.targetFile}.`,
        };
      }
      const origCode = contract.originalCode.trim();
      if (origCode) {
        const fileContentNorm = inspectedEntry.content.replace(/\r\n/g, '\n');
        const origCodeNorm = origCode.replace(/\r\n/g, '\n');
        if (!fileContentNorm.includes(origCodeNorm)) {
          return {
            isValid: false,
            rejectionReason: `Proposal originalCode does not match verified source content of ${contract.targetFile}.`,
          };
        }
      }
    }
  }

  // 10. Structural scope validation
  if (contract.structuralScope && typeof contract.structuralScope === 'object') {
    const scope = contract.structuralScope;
    if (
      Number.isInteger(scope.startLine) &&
      Number.isInteger(scope.endLine) &&
      scope.startLine >= 1 &&
      scope.endLine >= scope.startLine
    ) {
      if (
        contract.targetLineRange.startLine < scope.startLine ||
        contract.targetLineRange.endLine > scope.endLine
      ) {
        return {
          isValid: false,
          rejectionReason: `Proposal targetLineRange [${contract.targetLineRange.startLine}-${contract.targetLineRange.endLine}] exceeds structuralScope boundaries [${scope.startLine}-${scope.endLine}].`,
        };
      }
    }
  }

  // 11. Diff Preview unified diff hunk validation
  if (contract.diffPreview && typeof contract.diffPreview === 'string') {
    if (!contract.diffPreview.includes('@@')) {
      return {
        isValid: false,
        rejectionReason: 'Proposal diffPreview must contain a valid unified diff hunk.',
      };
    }
  }

  return {
    isValid: true,
    targetFile: contract.targetFile,
    targetLineRange: contract.targetLineRange,
    structuralScope: contract.structuralScope || null,
    rootCauseSummary: contract.rootCauseSummary,
    originalCode: contract.originalCode,
    proposedCode: contract.proposedCode,
    diffPreview: contract.diffPreview || '',
    expectedBehavior: contract.expectedBehavior,
  };
}

/**
 * Validates that proposed patches are minimal, grounded in inspected evidence,
 * and preserve unrelated dirty work.
 */
function validatePatchScope({
  targetFiles = [],
  inspectedFiles = [],
  verifiedFindings = [],
  proposalContract = null,
  proposedChanges = [],
  acceptanceCriteria = [],
  modifiedFiles = [],
  existingDirtyFiles = [],
}) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const targetSet = new Set(targetFiles.map(norm));
  const touchedFiles = (modifiedFiles.length > 0 ? modifiedFiles : targetFiles).map(norm);

  const dirtySet = new Set(existingDirtyFiles.map(norm));
  const touchesUnrelated = touchedFiles.some((dirty) => dirtySet.has(dirty) && !targetSet.has(dirty));

  let isValid = !touchesUnrelated;
  let rejectionReason = touchesUnrelated ? 'Proposed patch touches unrelated dirty files.' : null;

  // Verify all target files were inspected in Stage 3 if inspectedFiles is provided
  if (isValid && Array.isArray(inspectedFiles) && inspectedFiles.length > 0) {
    const inspectedSet = new Set(
      inspectedFiles.map((f) => norm(typeof f === 'string' ? f : f?.path)).filter(Boolean)
    );
    const uninspectedTargets = targetFiles.filter((t) => !inspectedSet.has(norm(t)));
    if (uninspectedTargets.length > 0) {
      isValid = false;
      rejectionReason = `Scope violation: proposed patch touches uninspected file(s): [${uninspectedTargets.join(', ')}]. All modifications must be grounded in Stage 3 evidence.`;
    }
  }

  // Verify target files correspond to verified findings if verifiedFindings is provided
  if (isValid && Array.isArray(verifiedFindings) && verifiedFindings.length > 0) {
    const findingFiles = new Set(
      verifiedFindings.map((f) => norm(f?.filePath)).filter(Boolean)
    );
    const unverifiedTargets = targetFiles.filter((t) => !findingFiles.has(norm(t)));
    if (unverifiedTargets.length > 0) {
      isValid = false;
      rejectionReason = `Scope violation: proposed patch touches file(s) without verified defect findings: [${unverifiedTargets.join(', ')}].`;
    }
  }

  // Validate proposal contract if supplied
  if (isValid && proposalContract) {
    const contractResult = validateProposalContract(proposalContract, { inspectedFiles, verifiedFindings });
    if (!contractResult.isValid) {
      isValid = false;
      rejectionReason = contractResult.rejectionReason;
    }
  }

  const isMinimal = isValid && targetFiles.length > 0 && targetFiles.length <= 5;

  return {
    isValid,
    isMinimal,
    targetFiles,
    acceptanceCriteria,
    touchedFiles,
    preservesUnrelatedFiles: !touchesUnrelated,
    proposalContract: proposalContract || null,
    rejectionReason,
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
    approvedTargets: [...approvedSet],
  };
}

/**
 * Extracts structured diagnostics from execution output across all major test frameworks and languages.
 * (Node/Vitest/Jest/Mocha, Python/Pytest/Unittest, PHP/PHPUnit, Go test, Rust cargo test, Maven/Gradle).
 */
function extractFailureDiagnostics(resultOrText) {
  const text = typeof resultOrText === 'string'
    ? resultOrText
    : `${resultOrText?.stderr || ''}\n${resultOrText?.stdout || ''}\n${resultOrText?.error || ''}\n${resultOrText?.failure || ''}\n${resultOrText?.message || ''}`;

  const cleanText = text.replace(/\u001b\[[0-9;]*m/g, ''); // strip ANSI codes
  const lines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 1. Failing test names
  const failingTests = [];
  const testRegexes = [
    /(?:FAIL|failed|failing)\s+test\s+["'`]?([^"'`\r\n]+)["'`]?/gi,
    /●\s+([^\r\n]+)/g,
    /FAILED\s+([^\s\r\n:]+::\w+)/g,
    /\d+\)\s+([^:\r\n]+):/g,
    /--- FAIL:\s+([^\s\r\n]+)/g,
  ];
  for (const re of testRegexes) {
    let m;
    while ((m = re.exec(cleanText)) !== null) {
      if (m[1] && !failingTests.includes(m[1].trim())) {
        failingTests.push(m[1].trim());
      }
    }
  }

  // 2. Assertion errors
  const assertionErrors = [];
  const assertionRegexes = [
    /AssertionError(?: \[[^\]]+\])?:?\s*(.+)/gi,
    /Failed asserting that\s+(.+)/gi,
    /Expected:?\s*(.+?)\s+Received:?\s*(.+)/gi,
    /assert\s+.+==.+/gi,
    /Expected values to be strictly equal:\s*(.+)/gi,
  ];
  for (const re of assertionRegexes) {
    let m;
    while ((m = re.exec(cleanText)) !== null) {
      const msg = (m[1] || m[0]).trim();
      if (msg && !assertionErrors.includes(msg)) {
        assertionErrors.push(msg.slice(0, 300));
      }
    }
  }

  // 3. Compiler / Syntax errors
  const compilerErrors = [];
  const compilerRegexes = [
    /(?:error\s+TS\d+:\s*.+)/gi,
    /(?:SyntaxError:\s*.+)/gi,
    /(?:TypeError:\s*.+)/gi,
    /(?:Parse error:\s*.+)/gi,
    /(?:Fatal error:\s*.+)/gi,
  ];
  for (const re of compilerRegexes) {
    let m;
    while ((m = re.exec(cleanText)) !== null) {
      const msg = m[0].trim();
      if (msg && !compilerErrors.includes(msg)) {
        compilerErrors.push(msg.slice(0, 300));
      }
    }
  }

  // 4. Stack frames / File locations
  const stackFrames = [];
  const frameRegex = /(?:at\s+(?:.+?\s+\()?|File\s+["']?|in\s+)([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)[:\s,]+(?:line\s+)?(\d+)(?::(\d+))?/gi;
  let frameMatch;
  while ((frameMatch = frameRegex.exec(cleanText)) !== null) {
    const file = frameMatch[1];
    const line = Number(frameMatch[2]);
    const column = frameMatch[3] ? Number(frameMatch[3]) : null;
    if (file && !file.includes('node_modules') && !file.includes('internal/')) {
      stackFrames.push({ file, line, column });
    }
  }

  // Primary summary line
  const summary = assertionErrors[0]
    || compilerErrors[0]
    || (failingTests.length > 0 ? `Test failed: ${failingTests[0]}` : null)
    || lines.find((l) => /error|fail|exception/i.test(l) && !/^npm /i.test(l))
    || 'Verification check failed with non-zero exit code';

  return {
    summary: summary.slice(0, 500),
    failingTests,
    assertionErrors,
    compilerErrors,
    stackFrames: stackFrames.slice(0, 10),
  };
}

/**
 * Strictly verifies post-approval apply conditions (Milestone V4):
 * - User approval is confirmed (userApproved === true)
 * - Proposal contract is valid and non-null
 * - Mutation targets strictly match proposalContract.targetFile (blocking scope expansion)
 * - Target file on disk has not drifted from proposalContract.originalCode (pre-apply drift guard)
 * - Target diff hunks do not exceed approved targetLineRange
 */
function validateApplyScope({
  proposalContract = null,
  mutationTargets = [],
  files = [],
  userApproved = false,
  currentDiskContent = null,
  targetLineRange = null,
  patchHunks = [],
} = {}) {
  if (!userApproved) {
    return {
      allowed: false,
      code: 'APPROVAL_REQUIRED',
      rejectionReason: 'APPLY_SCOPE_VIOLATION: Mutation requires explicit user approval before apply.',
    };
  }

  if (!proposalContract || typeof proposalContract !== 'object') {
    return {
      allowed: false,
      code: 'APPLY_SCOPE_VIOLATION',
      rejectionReason: 'APPLY_SCOPE_VIOLATION: A valid V3 proposal contract is required to apply changes.',
    };
  }

  const contractValidation = validateProposalContract(proposalContract);
  if (!contractValidation.isValid) {
    return {
      allowed: false,
      code: 'APPLY_SCOPE_VIOLATION',
      rejectionReason: `APPLY_SCOPE_VIOLATION: Proposal contract is invalid: ${contractValidation.rejectionReason}`,
    };
  }

  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const approvedTarget = norm(proposalContract.targetFile);
  const targets = (
    mutationTargets.length > 0
      ? mutationTargets
      : files.map((f) => (typeof f === 'string' ? f : f?.path))
  ).filter(Boolean);

  const approvedTargets = proposalContract.isModular === true && Array.isArray(proposalContract.files)
    ? proposalContract.files.map((f) => norm(typeof f === 'string' ? f : f?.path))
    : [approvedTarget];

  const unapproved = targets.filter((t) => !approvedTargets.includes(norm(t)));
  if (unapproved.length > 0) {
    return {
      allowed: false,
      code: 'APPLY_SCOPE_VIOLATION',
      rejectionReason: `APPLY_SCOPE_VIOLATION: Attempted mutation targets [${unapproved.join(', ')}] exceed approved proposal contract targets [${approvedTargets.join(', ')}].`,
    };
  }

  if (proposalContract.isModular === true) {
    return {
      allowed: true,
      driftDetected: false,
      rejectionReason: null,
    };
  }

  // Pre-apply drift detection on target region if currentDiskContent is provided
  if (typeof currentDiskContent === 'string' && proposalContract.originalCode) {
    const range = targetLineRange || proposalContract.targetLineRange;
    const diskLines = currentDiskContent.split(/\r?\n/);
    if (range && Number.isInteger(range.startLine) && Number.isInteger(range.endLine)) {
      const sliceStart = Math.max(0, range.startLine - 1);
      const sliceEnd = Math.min(diskLines.length, range.endLine);
      const targetSlice = diskLines.slice(sliceStart, sliceEnd).join('\n').trim();
      const expectedSlice = proposalContract.originalCode.replace(/\r?\n/g, '\n').trim();

      if (expectedSlice && !targetSlice.includes(expectedSlice) && !currentDiskContent.includes(expectedSlice)) {
        return {
          allowed: false,
          code: 'STALE_PROPOSAL_DRIFT',
          rejectionReason: `STALE_PROPOSAL_DRIFT: Target file lines ${range.startLine}-${range.endLine} on disk drifted from approved proposal contract code.`,
        };
      }
    }
  }

  // Check patch hunks against targetLineRange if provided
  if (Array.isArray(patchHunks) && patchHunks.length > 0 && proposalContract.targetLineRange) {
    const { startLine, endLine } = proposalContract.targetLineRange;
    const tolerance = 5;
    const minAllowed = Math.max(1, startLine - tolerance);
    const maxAllowed = endLine + tolerance;
    for (const hunk of patchHunks) {
      const hunkStart = Number(hunk.oldStart || hunk.start || hunk.startLine || 0);
      const hunkCount = Number(hunk.oldCount || hunk.count || hunk.lineCount || 1);
      const hunkEnd = hunkStart + hunkCount - 1;
      if (hunkStart > 0 && (hunkEnd < minAllowed || hunkStart > maxAllowed)) {
        return {
          allowed: false,
          code: 'APPLY_SCOPE_VIOLATION',
          rejectionReason: `APPLY_SCOPE_VIOLATION: Patch hunk @@ -${hunkStart},${hunkCount} @@ is outside approved line range [${startLine}-${endLine}].`,
        };
      }
    }
  }

  return {
    allowed: true,
    code: 'APPROVED_SCOPE_VALID',
    targetFile: proposalContract.targetFile,
    targetLineRange: proposalContract.targetLineRange,
  };
}


/**
 * Converts a user request into explicit requirements and acceptance criteria,
 * detecting underspecified or ambiguous requests that require clarification.
 */
const STRUCTURAL_KEYWORDS = [
  'action', 'method', 'function', 'func', 'fn', 'handler',
  'controller', 'service', 'endpoint', 'route', 'class', 'view', 'component',
];

function generateSymbolVariants(symbols, structuralKeywords = []) {
  const variants = new Set();
  const keywords = (structuralKeywords || []).map((k) => String(k).toLowerCase());
  for (const sym of symbols || []) {
    if (!sym || typeof sym !== 'string') continue;
    const cleanSym = sym.trim();
    if (!cleanSym || cleanSym.length < 2) continue;
    variants.add(cleanSym);

    // camelCase to snake_case
    const snake = cleanSym.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    variants.add(snake);

    // snake_case to camelCase
    const camel = cleanSym.replace(/_([a-z0-9])/gi, (_, c) => c.toUpperCase());
    const lowerCamel = camel.charAt(0).toLowerCase() + camel.slice(1);
    const upperCamel = camel.charAt(0).toUpperCase() + camel.slice(1);
    variants.add(lowerCamel);
    variants.add(upperCamel);

    const hasAction = keywords.some((k) => /action/i.test(k));
    const hasHandler = keywords.some((k) => /handler/i.test(k));
    const hasController = keywords.some((k) => /controller/i.test(k));
    const hasService = keywords.some((k) => /service/i.test(k));

    if (hasAction) {
      variants.add(`action${upperCamel}`);
      variants.add(`action_${snake}`);
      variants.add(`${lowerCamel}Action`);
      variants.add(`${snake}_action`);
    }
    if (hasHandler) {
      variants.add(`handle${upperCamel}`);
      variants.add(`${lowerCamel}Handler`);
      variants.add(`${upperCamel}Handler`);
      variants.add(`handle_${snake}`);
      variants.add(`${snake}_handler`);
    }
    if (hasController) {
      variants.add(`${upperCamel}Controller`);
      variants.add(`${lowerCamel}Controller`);
      variants.add(`${snake}_controller`);
    }
    if (hasService) {
      variants.add(`${upperCamel}Service`);
      variants.add(`${lowerCamel}Service`);
      variants.add(`${snake}_service`);
    }
  }
  return [...variants];
}

function extractEnclosingFunctionBlock(content, targetLineOrSymbol, options = {}) {
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 60;
  const minLines = Number.isInteger(options.minLines) ? options.minLines : 15;
  if (typeof content !== 'string' || !content.trim()) {
    return { extractedCode: '', startLine: 1, endLine: 1, symbolName: null, bounded: true };
  }
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  let targetIndex = -1;
  let targetSymbol = null;
  if (typeof targetLineOrSymbol === 'number' && targetLineOrSymbol > 0) {
    targetIndex = Math.min(Math.max(1, targetLineOrSymbol), totalLines) - 1;
  } else if (typeof targetLineOrSymbol === 'string' && targetLineOrSymbol.trim()) {
    targetSymbol = targetLineOrSymbol.trim();
    const escaped = targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const symRegex = new RegExp(`(?:function\\s+|def\\s+|fn\\s+|func\\s+|class\\s+|\\b)${escaped}\\b|\\b${escaped}\\s*\\(`, 'i');
    for (let i = 0; i < totalLines; i++) {
      if (symRegex.test(lines[i])) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) {
      const lower = targetSymbol.toLowerCase();
      for (let i = 0; i < totalLines; i++) {
        if (lines[i].toLowerCase().includes(lower)) {
          targetIndex = i;
          break;
        }
      }
    }
  }
  if (targetIndex === -1) targetIndex = 0;

  const CONTROL_FLOW_REGEX = /^\s*(?:if|for|while|switch|catch|with|foreach)\b/;
  const FUNC_SIGNATURE_REGEX = /^\s*(?:(?:export|default|abstract|final|public|private|protected|static|async|function|\*)\s+)*(?:function(?:\s+[\w$]+)?|def\s+[\w$]+|fn\s+[\w$]+|func\s+(?:\([^)]*\)\s*)?[\w$]+)\s*(?:\([^)]*\))?/i;
  const METHOD_SIGNATURE_REGEX = /^\s*(?:(?:export|default|abstract|final|public|private|protected|static|async)\s+)+[\w$]+\s*\([^)]*\)/i;
  const BARE_METHOD_REGEX = /^\s*(?!if\b|for\b|while\b|switch\b|catch\b|with\b|return\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^;{]+)?\s*\{?\s*$/i;

  let declStart = targetIndex;
  for (let i = targetIndex; i >= Math.max(0, targetIndex - 35); i--) {
    const curLine = lines[i];
    if (CONTROL_FLOW_REGEX.test(curLine)) continue;
    if (FUNC_SIGNATURE_REGEX.test(curLine) || METHOD_SIGNATURE_REGEX.test(curLine) || BARE_METHOD_REGEX.test(curLine)) {
      declStart = i;
      break;
    }
  }

  const isPython = options.language === 'python' || lines[declStart].trim().startsWith('def ') || lines[declStart].trim().endsWith(':');
  let blockEnd = declStart;
  let foundOpen = false;
  let openBraces = 0;

  if (isPython) {
    const indentMatch = lines[declStart].match(/^(\s*)/);
    const baseIndent = indentMatch ? indentMatch[1].length : 0;
    for (let i = declStart + 1; i < totalLines; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const curMatch = line.match(/^(\s*)/);
      const lineIndent = curMatch ? curMatch[1].length : 0;
      if (lineIndent <= baseIndent) {
        blockEnd = i - 1;
        break;
      }
      blockEnd = i;
      if (blockEnd - declStart >= maxLines) break;
    }
  } else {
    for (let i = declStart; i < totalLines; i++) {
      const line = lines[i];
      const cleanLine = line.replace(/(["'`])(?:\\.|[^\\])*?\1/g, '').replace(/\/\/.*$|\/\*.*?\*\//g, '');
      const opens = (cleanLine.match(/\{/g) || []).length;
      const closes = (cleanLine.match(/\}/g) || []).length;
      if (opens > 0) foundOpen = true;
      openBraces += opens - closes;
      blockEnd = i;
      if (foundOpen && openBraces <= 0) {
        break;
      }
      if (blockEnd - declStart >= maxLines) break;
    }
  }

  const startLine = Math.max(1, declStart + 1);
  const endLine = (foundOpen && openBraces <= 0)
    ? Math.min(totalLines, blockEnd + 1)
    : Math.min(totalLines, Math.max(startLine + minLines - 1, blockEnd + 1));
  const extractedLines = lines.slice(startLine - 1, endLine);

  let detectedSymbol = targetSymbol;
  if (!detectedSymbol && declStart >= 0 && declStart < totalLines) {
    const declLine = lines[declStart];
    const match = declLine.match(/(?:function\s+([A-Za-z_$][\w$]*)|def\s+([A-Za-z_$][\w$]*)|fn\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*\([^)]*\))/);
    if (match) {
      detectedSymbol = match[1] || match[2] || match[3] || match[4] || null;
    }
  }

  return {
    startLine,
    endLine,
    symbolName: detectedSymbol,
    extractedCode: extractedLines.join('\n'),
    lineCount: extractedLines.length,
    bounded: true,
  };
}

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

  // Extract high-precision signals (paths, symbols, routes, errors, quoted phrases)
  const exactPaths = [];
  const exactSymbols = [];
  const routePaths = [];
  const errorSignals = [];
  const quotedLiterals = [];

  // 1. Quoted literals: "..." or '...' or `...`
  const quotePattern = /["'`](\S(?:[\s\S]*?\S)?)["'`]/g;
  let qMatch;
  while ((qMatch = quotePattern.exec(text)) !== null) {
    const val = qMatch[1].trim();
    if (val.length > 1 && val.length < 100) quotedLiterals.push(val);
  }

  // 2. Route / API endpoints: e.g. /api/v1/users, /auth/login
  const routePattern = /(?:\/[\w\-:{}]+){2,}/g;
  let rMatch;
  while ((rMatch = routePattern.exec(text)) !== null) {
    routePaths.push(rMatch[0].trim());
  }

  // 3. Relative file paths with extensions or slashes (excluding leading slash routes)
  const pathPattern = /(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.-]+\.[a-z0-9]{1,5}|\b[A-Za-z0-9_.-]+\.(?:[a-z]{1,5}|[cm]?[jt]sx?|php|py|rb|go|rs|java|kt|c|cpp|h|hpp|vue|svelte|html|css|json|ya?ml|sql|sh)\b/gi;
  let pMatch;
  while ((pMatch = pathPattern.exec(text)) !== null) {
    const val = pMatch[0].trim();
    if (val.length > 2 && !val.startsWith('http://') && !val.startsWith('https://')) {
      exactPaths.push(val.replace(/\\/g, '/'));
    }
  }

  // 4. Error / Exception signals: e.g. TypeError, NullPointerException, HTTP 500, etc.
  const errorPattern = /\b(?:[A-Z][a-zA-Z]*(?:Error|Exception|Fault|Failure)|HTTP\s+[45]\d{2}|[45]\d{2}\s+(?:Internal|Not\s+Found|Forbidden|Unauthorized|Bad\s+Request))\b/g;
  let eMatch;
  while ((eMatch = errorPattern.exec(text)) !== null) {
    errorSignals.push(eMatch[0].trim());
  }

  // 4b. Structured stack frames / runtime error locations
  const errorFrames = [];
  const stackPattern = /(?:(?:at\s+[\w$.<>]+\s+\()?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?\)?)|(?:File\s+["']([^"']+)["'],\s+line\s+(\d+)(?:,\s+in\s+([A-Za-z0-9_]+))?)/g;
  let stMatch;
  while ((stMatch = stackPattern.exec(text)) !== null) {
    const file = (stMatch[1] || stMatch[4] || '').replace(/\\/g, '/');
    const line = parseInt(stMatch[2] || stMatch[5], 10);
    const symbol = stMatch[6] || null;
    if (file && Number.isInteger(line)) {
      errorFrames.push({
        file,
        line,
        symbol,
        raw: stMatch[0].trim(),
      });
      exactPaths.push(file);
    }
  }

  // 5. Code symbols: CamelCase, PascalCase, snake_case with underscores, or functions like name()
  const symbolPattern = /\b(?:[a-z]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*|[a-z0-9]+_[a-z0-9_]+|[A-Za-z_$][\w$]*(?=\(\)))\b/g;
  let sMatch;
  while ((sMatch = symbolPattern.exec(text)) !== null) {
    exactSymbols.push(sMatch[0].trim());
  }

  // Extract explicit requirements & domain words
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

  // Structural intent detection and convention-aware symbol synthesis
  const lowerText = text.toLowerCase();
  const matchedStructural = STRUCTURAL_KEYWORDS.filter((keyword) => {
    const kwRegex = new RegExp(`\\b${keyword}\\b`, 'i');
    return kwRegex.test(lowerText);
  });
  const synthesizedVariants = matchedStructural.length > 0 ? generateSymbolVariants(exactSymbols, matchedStructural) : [];

  // Assemble prioritized domain terms:
  // 1. Exact relative paths
  // 2. Exact symbols / identifiers & synthesized declaration variants
  // 3. Route endpoints & quoted literals
  // 4. Error signals
  // 5. General filtered domain terms
  const prioritizedDomainTerms = [...new Set([
    ...exactPaths,
    ...exactSymbols,
    ...synthesizedVariants,
    ...routePaths,
    ...quotedLiterals,
    ...errorSignals,
    ...uniqueTerms,
  ])].filter((term) => term && term.length > 1);

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

  const hasConcreteCreationDirective = /\b(?:build|create|implement|scaffold|generate|add|update|modify)\b[^.!?\r\n]{0,160}\b(?:feature|endpoint|route|api|model|schema|page|component|form|service|application|project|system|module)\b/i.test(text);
  const startsWithDiagnosticInquiry = /^\s*(?:(?:please\s+)?(?:investigate|diagnose|debug|audit|trace|explain)\b|why\b|how\b|what\s+(?:happened|caused|is\s+wrong)\b|find\s+(?:the\s+)?(?:cause|root\s+cause)\b)/i.test(text);
  const isCompositeActionList = /^\s*(?:implement|complete|handle)\s*:/i.test(text)
    && (text.match(/^\s*[-*]\s+\S.+$/gm) || []).length >= 3;
  const isActionableCreationRequest = hasConcreteCreationDirective
    && !startsWithDiagnosticInquiry
    && !isCompositeActionList;
  const isBugFix = /\b(?:fix|repair|patch|debug|bug|issue|defect|error|trace|fail|failing|failed|broken)\b/i.test(text);
  const isModular = isActionableCreationRequest
    || (!isBugFix && /\b(?:modular|clean\s+architecture|full-?stack|fullstack|multi-layer|separate\s+files?|build\s+(?:a\s+)?complete|scaffold|setup\s+project|create\s+project|new\s+feature|add\s+feature)\b/i.test(text));

  return {
    explicitRequirements,
    acceptanceCriteria,
    domainTerms: prioritizedDomainTerms,
    searchSignals: {
      exactPaths: [...new Set(exactPaths)],
      exactSymbols: [...new Set([...exactSymbols, ...synthesizedVariants])],
      structuralIntent: matchedStructural,
      routePaths: [...new Set(routePaths)],
      errorSignals: [...new Set(errorSignals)],
      errorFrames: errorFrames,
      quotedLiterals: [...new Set(quotedLiterals)],
    },
    ambiguityScore: 'LOW',
    needsClarification: false,
    clarificationPrompt: null,
    inventedAssumptions: false,
    isModular,
    isActionableCreationRequest,
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
  BLOCKED: ['IN_PROGRESS', 'FAILED', 'ABSTAINED', 'SKIPPED', 'CANCELLED'],
  ABSTAINED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  SKIPPED: ['IN_PROGRESS'],
  CANCELLED: [],
});

const LEGAL_WORK_ITEM_TRANSITIONS = Object.freeze({
  PENDING: ['IN_PROGRESS', 'SKIPPED', 'BLOCKED', 'DELEGATED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'BLOCKED', 'SKIPPED', 'DELEGATED', 'CANCELLED'],
  FAILED: ['IN_PROGRESS', 'BLOCKED', 'DELEGATED', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'FAILED', 'SKIPPED', 'DELEGATED', 'CANCELLED'],
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
        const normTarget = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
        const rawExpected = proposalEvidence?.targets || [proposalEvidence?.targetFile].filter(Boolean);
        const rawApproved = Array.isArray(evidence.approvedTargets) ? evidence.approvedTargets : [];
        const expectedTargets = rawExpected.map(normTarget);
        const approvedTargets = rawApproved.map(normTarget);
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

/**
 * Constructs a canonical machine-verifiable workflow receipt for an autonomous coding execution.
 */
function buildWorkflowReceipt({
  outcome,
  stagesCompleted = [],
  rootCause = null,
  approvedProposal = null,
  appliedDiffScope = null,
  verificationReport = null,
  integrationVerification = null,
  hermeticVerification = null,
  worktreeIntegrity = null,
  rolledBack = false,
}) {
  return {
    outcome: String(outcome || 'UNKNOWN'),
    stagesCompleted: Array.isArray(stagesCompleted) ? [...stagesCompleted] : [],
    rootCause: rootCause ? {
      filePath: rootCause.filePath || null,
      lineRange: rootCause.lineRange || (rootCause.lines ? { startLine: Number(String(rootCause.lines).split('-')[0]) || 1, endLine: Number(String(rootCause.lines).split('-')[1]) || 1 } : null),
      codeEvidence: rootCause.codeEvidence || rootCause.codeSnippet || null,
      symbol: rootCause.symbol || null,
      causalExplanation: rootCause.causalExplanation || rootCause.controlFlow || null,
    } : null,
    approvedProposal: approvedProposal ? {
      targetFile: approvedProposal.targetFile || null,
      targetLineRange: approvedProposal.targetLineRange || null,
      expectedBehavior: approvedProposal.expectedBehavior || null,
      rootCauseSummary: approvedProposal.rootCauseSummary || null,
    } : null,
    appliedDiffScope: appliedDiffScope ? {
      modifiedFiles: Array.isArray(appliedDiffScope.modifiedFiles) ? [...appliedDiffScope.modifiedFiles] : [],
      lineEndingsPreserved: appliedDiffScope.lineEndingsPreserved !== false,
      driftDetected: Boolean(appliedDiffScope.driftDetected),
      scopeViolation: Boolean(appliedDiffScope.scopeViolation),
      rolledBack: Boolean(rolledBack || appliedDiffScope.rolledBack),
    } : null,
    verificationReport: verificationReport ? {
      status: verificationReport.status || (verificationReport.ok ? 'PASSED' : 'FAILED'),
      ok: Boolean(verificationReport.ok),
      executed: Boolean(verificationReport.executed),
      verificationMode: verificationReport.verificationMode || 'UNKNOWN',
      exitCode: Number.isInteger(verificationReport.exitCode) ? verificationReport.exitCode : null,
      verificationEvidence: Array.isArray(verificationReport.verificationEvidence) ? verificationReport.verificationEvidence : [],
      failureDiagnostics: verificationReport.failureDiagnostics || null,
      hostExecution: verificationReport.hostExecution && typeof verificationReport.hostExecution === 'object'
        ? {
            status: String(verificationReport.hostExecution.status || 'UNKNOWN'),
            reason: verificationReport.hostExecution.reason || null,
          }
        : null,
      integrationVerification: integrationVerification ? {
        status: integrationVerification.isValid !== true
          ? 'INCOMPLETE'
          : integrationVerification.verificationModes?.includes('LIVE_PROBE')
            ? integrationVerification.verificationModes.includes('STATIC_WIRING')
              ? 'STATIC_AND_LIVE_VERIFIED'
              : 'LIVE_REACHABILITY_VERIFIED'
            : integrationVerification.verificationModes?.includes('STATIC_WIRING')
              ? 'STATIC_WIRING_VERIFIED'
              : 'NOT_REQUIRED',
        liveProbePerformed: integrationVerification.verificationModes?.includes('LIVE_PROBE') === true,
        verificationModes: Array.isArray(integrationVerification.verificationModes)
          ? [...integrationVerification.verificationModes]
          : [],
        routeMounts: Array.isArray(integrationVerification.routeMounts)
          ? integrationVerification.routeMounts.map((route) => ({
              method: route.method,
              path: route.path,
              verificationType: route.verificationType,
              status: route.status,
            }))
          : [],
        rejectionReason: integrationVerification.rejectionReason || null,
        hermeticVerification: integrationVerification.hermeticVerification
          ? {
              status: integrationVerification.hermeticVerification.status || 'UNKNOWN',
              passed: Number(integrationVerification.hermeticVerification.passed) || 0,
              total: Number(integrationVerification.hermeticVerification.total) || 0,
              gates: Array.isArray(integrationVerification.hermeticVerification.gates)
                ? integrationVerification.hermeticVerification.gates.map((gate) => ({
                    id: String(gate.id || 'UNKNOWN'),
                    passed: gate.passed === true,
                    evidence: gate.evidence ?? null,
                  }))
                : [],
            }
          : null,
      } : null,
      hermeticVerification: hermeticVerification
        ? {
            status: hermeticVerification.status || 'UNKNOWN',
            passed: Number(hermeticVerification.passed) || 0,
            total: Number(hermeticVerification.total) || 0,
            gates: Array.isArray(hermeticVerification.gates)
              ? hermeticVerification.gates.map((gate) => ({
                  id: String(gate.id || 'UNKNOWN'),
                  passed: gate.passed === true,
                  evidence: gate.evidence ?? null,
                }))
              : [],
          }
        : null,
    } : null,
    worktreeIntegrity: worktreeIntegrity ? {
      preserved: worktreeIntegrity.preserved !== false,
      unrelatedUntouched: worktreeIntegrity.unrelatedUntouched !== false,
      auditResult: worktreeIntegrity.auditResult || null,
    } : null,
    rolledBack: Boolean(rolledBack),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validates the canonical workflow receipt for structural integrity and honest consistency.
 */
function validateWorkflowReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { isValid: false, rejectionReason: 'Receipt must be a valid non-null object.' };
  }
  if (!Array.isArray(receipt.stagesCompleted) || receipt.stagesCompleted.length === 0) {
    return { isValid: false, rejectionReason: 'Receipt must contain non-empty stagesCompleted array.' };
  }
  const terminalSuccess = ['SUCCESS', 'COMPLETED'].includes(receipt.outcome);
  if (terminalSuccess) {
    if (!receipt.stagesCompleted.includes('APPLY') || !receipt.stagesCompleted.includes('VERIFY')) {
      return { isValid: false, rejectionReason: 'Successful receipt must include APPLY and VERIFY stages.' };
    }
    if (!receipt.verificationReport || receipt.verificationReport.ok !== true || receipt.verificationReport.exitCode !== 0) {
      return { isValid: false, rejectionReason: 'Successful receipt requires verified verificationReport with exitCode 0.' };
    }
    if (!receipt.approvedProposal) {
      return { isValid: false, rejectionReason: 'Successful receipt requires approvedProposal.' };
    }
    if (!receipt.appliedDiffScope || !receipt.appliedDiffScope.modifiedFiles.length) {
      return { isValid: false, rejectionReason: 'Successful receipt requires appliedDiffScope with modified files.' };
    }
  }
  if (receipt.rolledBack === true && terminalSuccess) {
    return { isValid: false, rejectionReason: 'Rolled back workflow cannot claim successful outcome.' };
  }
  return { isValid: true };
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
  validateProposalContract,
  enforceApprovalGate,
  validateApplyScope,
  extractFailureDiagnostics,
  invalidateCompletedWorkItems,
  extractEnclosingFunctionBlock,
  generateSymbolVariants,
  analyzeTaskRequirements,
  planProgressiveSearch,
  discoverProjectArchitecture,
  executeToolWithSafeguards,
  manageRepairLoop,
  createTaskPlan,
  advanceTaskPlan,
  buildWorkflowReceipt,
  validateWorkflowReceipt,
};
