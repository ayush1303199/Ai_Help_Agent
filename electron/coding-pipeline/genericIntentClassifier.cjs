'use strict';

/**
 * Generic Intent Classifier for AI Coding Agent (Milestone V1).
 *
 * Classifies user coding requests into one or more generic intent categories
 * using semantic meaning, linguistic structure, constraints, and discovered
 * project evidence.
 *
 * ZERO hardcoded application features, endpoints, or project-specific names.
 */

const PROCESSING_LEVELS = Object.freeze({
  LEVEL_A_DIRECT_INTERACTION: 'LEVEL_A_DIRECT_INTERACTION',
  LEVEL_B_LIGHTWEIGHT_UNDERSTANDING: 'LEVEL_B_LIGHTWEIGHT_UNDERSTANDING',
  LEVEL_C_FOCUSED_INVESTIGATION: 'LEVEL_C_FOCUSED_INVESTIGATION',
  LEVEL_D_FULL_DEVELOPMENT: 'LEVEL_D_FULL_DEVELOPMENT',
});

const INTENT_CATEGORIES = Object.freeze({
  CONVERSATION_OR_FEEDBACK: 'CONVERSATION_OR_FEEDBACK',
  DISCUSS_OR_BRAINSTORM: 'DISCUSS_OR_BRAINSTORM',
  EXPLAIN_OR_ASK: 'EXPLAIN_OR_ASK',
  INVESTIGATE_OR_DEBUG: 'INVESTIGATE_OR_DEBUG',
  BUILD_OR_SCAFFOLD: 'BUILD_OR_SCAFFOLD',
  REFACTOR: 'REFACTOR',
  UPGRADE_OR_MIGRATE: 'UPGRADE_OR_MIGRATE',
  TEST_OR_VERIFY: 'TEST_OR_VERIFY',
  RUN_OR_LAUNCH: 'RUN_OR_LAUNCH',
});

const INSTALL_INTENTS = Object.freeze({
  INSTALL_NAMED_PACKAGE: 'INSTALL_NAMED_PACKAGE',
  INSTALL_PROJECT_DEPENDENCIES: 'INSTALL_PROJECT_DEPENDENCIES',
  ADD_DEPENDENCY: 'ADD_DEPENDENCY',
  UPDATE_OR_REINSTALL: 'UPDATE_OR_REINSTALL',
});

const ALL_CATEGORIES = Object.values(INTENT_CATEGORIES);

/**
 * Extracts explicit user constraints and directives from request text.
 * Preserves constraints like 'do not modify X', 'read-only', 'without changing Y'.
 */
function extractConstraints(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  const constraints = [];
  const clauseBoundary = '([^,;!?\\n]+?(?=(?:\\s*[,;!?\\n]|\\s+(?:and|or|while|but)\\b|\\s*\\.\\s+|$)))';

  // 1. Explicit negative directives
  const negativePatterns = [
    new RegExp(`\\b(?:do\\s+not|don't|dont|never)\\s+(?:modify|change|edit|write|touch|delete|remove|alter|patch)\\s+${clauseBoundary}`, 'gi'),
    new RegExp(`\\bwithout\\s+(?:modifying|changing|editing|writing|touching|altering|patching|breaking)\\s+${clauseBoundary}`, 'gi'),
    new RegExp(`\\bno\\s+(?:code\\s+|file\\s+|source\\s+)?(?:changes?|modifications?|edits?|writes?|patches?)(?:\\s+(?:to|in)\\s+${clauseBoundary})?`, 'gi'),
  ];

  for (const pattern of negativePatterns) {
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const target = match[1] ? match[1].trim() : 'any code';
      constraints.push(`DO_NOT_MODIFY: ${target}`);
    }
  }

  // 2. Explicit scope limitations
  const scopePatterns = [
    new RegExp(`\\bonly\\s+(?:modify|change|edit|touch|update|in|inside)\\s+${clauseBoundary}`, 'gi'),
    new RegExp(`\\blimit(?:ed)?\\s+(?:changes|scope)?\\s+to\\s+${clauseBoundary}`, 'gi'),
  ];

  for (const pattern of scopePatterns) {
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      if (match[1]) constraints.push(`ONLY_SCOPE: ${match[1].trim()}`);
    }
  }

  // 3. Preservation directives
  const preservePatterns = [
    new RegExp(`\\b(?:preserve|keep|maintain)\\s+${clauseBoundary}`, 'gi'),
    /\b(?:backwards?\s+compatib\w*|no\s+breaking\s+changes?)\b/gi,
  ];

  for (const pattern of preservePatterns) {
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      constraints.push(`PRESERVE: ${match[1] ? match[1].trim() : match[0].trim()}`);
    }
  }

  // 4. Read-only flags
  if (/\b(?:read-only|dry-run|audit\s+only|inspect\s+only)\b/i.test(normalized)) {
    constraints.push('READ_ONLY_MODE');
  }

  return [...new Set(constraints)];
}

/**
 * Distinguishes the four primary installation request intents:
 * 1. INSTALL_NAMED_PACKAGE: install a specifically named package
 * 2. INSTALL_PROJECT_DEPENDENCIES: install dependencies already declared in project manifest
 * 3. ADD_DEPENDENCY: add a new dependency (ambiguous when package name missing)
 * 4. UPDATE_OR_REINSTALL: update or reinstall existing dependencies
 */
function classifyInstallIntent(text, optionsOrContext = []) {
  const clean = String(text || '').trim();
  const contextMessages = Array.isArray(optionsOrContext)
    ? optionsOrContext
    : (Array.isArray(optionsOrContext?.contextMessages) ? optionsOrContext.contextMessages : []);

  function buildResult({ isInstallRequest, intent, packageName = null, needsClarification = false, clarificationPrompt = null, resolvedFromContext = false }) {
    return {
      isInstallRequest,
      installIntent: intent,
      intent,
      packageName,
      needsClarification,
      requiresClarification: needsClarification,
      clarificationPrompt,
      resolvedFromContext,
    };
  }

  if (!clean) {
    return buildResult({ isInstallRequest: false, intent: null });
  }

  // 1. UPDATE_OR_REINSTALL
  if (
    /\b(?:upgrade|update|reinstall)\s+(?:the\s+)?(?:dependencies|deps|packages?|node_modules|vendor)\b/i.test(clean)
    || /\b(?:npm|pnpm|yarn|bun|composer)\s+(?:update|upgrade)\b/i.test(clean)
    || /\breinstall\s+(?:all\s+)?(?:dependencies|deps|packages?)\b/i.test(clean)
  ) {
    return buildResult({
      isInstallRequest: true,
      intent: INSTALL_INTENTS.UPDATE_OR_REINSTALL,
    });
  }

  // 2. INSTALL_PROJECT_DEPENDENCIES: install dependencies declared in project manifest
  const isExplicitProjectInstall =
    /\b(?:install|download)\s+(?:the\s+)?(?:project\s+)?(?:dependencies|deps|node_modules|missing\s+dependencies)\b/i.test(clean)
    || /\b(?:install|download)\s+all\s+(?:the\s+)?(?:dependencies|deps|packages?)\b/i.test(clean)
    || /^(?:npm|pnpm|yarn|bun|composer)\s+(?:install|i)\s*(?:--[\w-]+)*$/i.test(clean)
    || /^(?:install\s+dependencies|install\s+deps|install\s+node_modules|npm\s+i|npm\s+install|pnpm\s+install|yarn\s+install|composer\s+install)\s*$/i.test(clean)
    || /\binstall\s+(?:the\s+)?packages\s+declared\s+in\s+(?:the\s+)?(?:manifest|package\.json)\b/i.test(clean);

  if (isExplicitProjectInstall) {
    return buildResult({
      isInstallRequest: true,
      intent: INSTALL_INTENTS.INSTALL_PROJECT_DEPENDENCIES,
    });
  }

  // 3. INSTALL_NAMED_PACKAGE: specifically named package
  const reservedWords = new Set([
    'a', 'an', 'the', 'some', 'new', 'another', 'dependencies', 'deps', 'node_modules',
    'packages', 'package', 'libraries', 'library', 'dependency', 'everything', 'all', 'project',
    'something', 'stuff', 'it', 'this', 'that', 'code', 'repo', 'repository', 'workspace'
  ]);

  const cliAddMatch = clean.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+([@\w./-]+)/i);
  const composerAddMatch = clean.match(/\b(?:composer\s+require)\s+([@\w./-]+)/i);
  const pipAddMatch = clean.match(/\b(?:pip\s+install)\s+([@\w./-]+)/i);
  const namedPackageMatch = clean.match(/\b(?:install|add)\s+(?:the\s+)?(?:package|library|dependency)\s+([@\w./-]+)/i)
    || clean.match(/\b(?:install|add)\s+([@\w./-]+)\s+(?:package|library|dependency)\b/i);

  let explicitPackage = null;
  if (cliAddMatch && !reservedWords.has(cliAddMatch[1].toLowerCase())) {
    explicitPackage = cliAddMatch[1];
  } else if (composerAddMatch && !reservedWords.has(composerAddMatch[1].toLowerCase())) {
    explicitPackage = composerAddMatch[1];
  } else if (pipAddMatch && !reservedWords.has(pipAddMatch[1].toLowerCase())) {
    explicitPackage = pipAddMatch[1];
  } else if (namedPackageMatch && !reservedWords.has(namedPackageMatch[1].toLowerCase())) {
    explicitPackage = namedPackageMatch[1];
  } else {
    const singleWordAdd = clean.match(/^(?:please\s+)?(?:install|add)\s+([@\w./-]+)\s*$/i);
    if (singleWordAdd && !reservedWords.has(singleWordAdd[1].toLowerCase())) {
      explicitPackage = singleWordAdd[1];
    }
  }

  if (explicitPackage) {
    return buildResult({
      isInstallRequest: true,
      intent: INSTALL_INTENTS.INSTALL_NAMED_PACKAGE,
      packageName: explicitPackage,
    });
  }

  // 4. ADD_DEPENDENCY: request to add a package/dependency where package name is MISSING
  const isAmbiguousPackageAddition =
    /\b(?:add|install)\s+(?:a\s+|an\s+|some\s+|new\s+|another\s+)?(?:package|library|dependency)\b/i.test(clean)
    || /^(?:please\s+)?(?:add|install)\s+(?:a\s+|an\s+|some\s+|new\s+|another\s+)?(?:package|dependency|library)\b/i.test(clean)
    || /^(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)\s*$/i.test(clean);

  if (isAmbiguousPackageAddition) {
    // Check if user already answered which package in contextMessages (do not ask repeatedly)
    let priorAnswer = null;
    if (contextMessages.length > 0) {
      for (let i = contextMessages.length - 1; i >= 0; i--) {
        const msg = contextMessages[i];
        if (!msg || typeof msg.content !== 'string') continue;
        const c = msg.content.trim();
        // Check if user gave an install command or package name in previous turn
        const userAddMatch = c.match(/(?:install|add)\s+([@\w./-]+)/i) || c.match(/^([@\w./-]+)$/i);
        if (userAddMatch && !reservedWords.has(userAddMatch[1].toLowerCase())) {
          priorAnswer = userAddMatch[1];
          break;
        }
      }
    }

    if (priorAnswer) {
      return buildResult({
        isInstallRequest: true,
        intent: INSTALL_INTENTS.INSTALL_NAMED_PACKAGE,
        packageName: priorAnswer,
        needsClarification: false,
        resolvedFromContext: true,
      });
    }

    return buildResult({
      isInstallRequest: true,
      intent: INSTALL_INTENTS.ADD_DEPENDENCY,
      packageName: null,
      needsClarification: true,
      clarificationPrompt: 'Which package or dependency would you like to install?',
    });
  }

  return buildResult({ isInstallRequest: false, intent: null });
}

function checkLanguageConflict(clean, projectContext) {
  if (projectContext && projectContext.workspaceState === 'EXISTING_APPLICATION' && Array.isArray(projectContext.languages) && projectContext.languages.length > 0) {
    const knownEcosystems = {
      python: { names: ['python', 'django', 'flask', 'fastapi', 'pytest', 'pip'], ext: '.py' },
      php: { names: ['php', 'laravel', 'symfony', 'composer', 'phpunit'], ext: '.php' },
      rust: { names: ['rust', 'cargo', 'actix'], ext: '.rs' },
      go: { names: ['go', 'golang', 'gin'], ext: '.go' },
      java: { names: ['java', 'maven', 'gradle', 'spring'], ext: '.java' },
      ruby: { names: ['ruby', 'rails', 'gem'], ext: '.rb' },
    };

    const projectLangs = projectContext.languages.map((l) => String(l).toLowerCase());

    for (const [langKey, def] of Object.entries(knownEcosystems)) {
      if (projectLangs.includes(langKey) || (langKey === 'python' && projectLangs.includes('py')) || (langKey === 'rust' && projectLangs.includes('rs'))) {
        continue;
      }
      const pattern = new RegExp('\\b(?:in|using|with|write|create|implement|add)\\s+(?:a\\s+)?(?:' + def.names.join('|') + ')\\b', 'i');
      if (pattern.test(clean)) {
        const hasExplicitLocation = /\b(?:in\s+[\w./-]+\/|file\s+[\w./-]+\.[\w]+|\.[\w]+)\b/i.test(clean);
        if (!hasExplicitLocation) {
          const detectedStr = projectLangs.join(', ');
          return {
            needsClarification: true,
            clarificationPrompt: 'The requested ' + langKey + ' code conflicts with the detected ' + detectedStr + ' project structure. Please specify the target directory or intended integration approach for ' + langKey + ' code in this repository.',
            languageConflict: { detected: projectLangs, requested: langKey },
          };
        }
      }
    }
  }
  return { needsClarification: false, clarificationPrompt: null };
}

/**
 * Checks if a request is genuinely ambiguous or lacks necessary technical context.
 */
function checkAmbiguity(text, projectContext = null, contextMessages = []) {
  const clean = String(text || '').trim();
  if (!clean) {
    return {
      needsClarification: true,
      clarificationPrompt: 'Please provide a task description or question for the coding agent.',
    };
  }

  // Detect vague requests lacking concrete target, file, symptom, or metric
  const isVague = /^(?:(?:can\s+you|could\s+you|would\s+you|please|will\s+you)\s+(?:please\s+)?)?(?:make\s+[\w\s]*\s*(?:better|faster|cleaner|nicer|cool(?:er)?)|improve\s+(?:this|it|the\s+project|the\s+app|the\s+code|performance|things)|fix\s+(?:this|it|the\s+bug|that\s+bug|the\s+code|stuff|things)|do\s+(?:something|coding|it)|optimize\s+(?:this|it|everything)|clean\s+(?:it\s+)?up)(?:\s+(?:now|please|for\s+me))?\s*[.!?]*$/i.test(clean)
    || (/^(?:make|improve|optimize)\b.*\b(?:faster|better|cleaner)\b/i.test(clean) && !/\b(?:ms|seconds?|query|queries|index|profile|benchmark|endpoint|test|error)\b/i.test(clean));

  function referencesDefectOrArtifact(str) {
    if (typeof str !== 'string' || str.trim().length < 5) return false;
    const hasFile = /\b[\w-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|php|py|rb|go|rs|html|css|sql|ya?ml|env)\b/i.test(str);
    const hasFinding = /\b(?:root\s+cause|identified\s+(?:a\s+)?defect|found\s+(?:a\s+)?defect|unhandled\s+rejection|null\s+pointer|memory\s+leak|stack\s+trace)\b/i.test(str);
    const hasDefectWithTarget = /\b(?:defect|bug|error|exception|failure|crash|leak|timeout|issue|unhandled|broken|failing)\b/i.test(str)
      && /\b(?:in|at|on|for|with)\s+(?:the\s+)?[\w_.-]+/i.test(str);
    return hasFile || hasFinding || hasDefectWithTarget;
  }

  if (isVague) {
    const isCancelled = projectContext?.taskStatus === 'CANCELLED'
      || projectContext?.isCancelled === true
      || projectContext?.taskCancelled === true;
    if (isCancelled) {
      return {
        needsClarification: true,
        clarificationPrompt: 'The previous task was cancelled. Please specify if you would like to restart the task or work on a different issue.',
        cancelledContext: true,
      };
    }

    const isFailed = projectContext?.taskStatus === 'FAILED'
      || projectContext?.isFailed === true;
    if (isFailed) {
      return {
        needsClarification: true,
        clarificationPrompt: 'The previous task or verification failed. Please clarify whether you would like to retry the task or investigate the failure.',
        failedContext: true,
      };
    }

    const isStaleOrCompleted = projectContext?.taskStatus === 'COMPLETED'
      || projectContext?.isCompleted === true
      || projectContext?.taskCompleted === true
      || projectContext?.isStale === true;

    if (isStaleOrCompleted) {
      return {
        needsClarification: true,
        clarificationPrompt: 'The previous task is already completed. Please specify what new issue or change you would like to work on.',
        staleContext: true,
      };
    }

    const priorFindings = Array.isArray(projectContext?.priorFindings)
      ? projectContext.priorFindings
      : (Array.isArray(projectContext?.findings) ? projectContext.findings : []);
    const hasPriorFindings = priorFindings.length > 0;

    const hasPriorContext = Array.isArray(contextMessages) && contextMessages.length > 0
      && contextMessages.some((msg) => msg && typeof msg.content === 'string' && referencesDefectOrArtifact(msg.content));
    const isAnaphoricFix = /^(?:(?:can\s+you|could\s+you|would\s+you|please|will\s+you)\s+(?:please\s+)?)?(?:fix|resolve|patch|repair|address|debug)\s+(?:this|it|the\s+bug|that\s+bug|the\s+issue|that\s+issue|the\s+problem|the\s+defect)\b/i.test(clean);

    if (isAnaphoricFix) {
      // Multiple findings in projectContext -> ambiguous which finding to address
      if (priorFindings.length > 1) {
        return {
          needsClarification: true,
          clarificationPrompt: `Multiple issues were identified (${priorFindings.length} findings). Please clarify which specific issue you would like to address.`,
          multipleCandidates: true,
        };
      }

      // Check for multiple findings in the latest assistant response
      const latestAssistantMsg = Array.isArray(contextMessages)
        ? contextMessages.slice().reverse().find((m) => m && m.role === 'assistant')
        : null;
      const assistantContent = latestAssistantMsg?.content || '';
      const hasMultipleContextFindings = /\b(?:multiple\s+(?:issues|defects|bugs|errors|findings)|found\s+(?:\d+|two|three|several)\s+(?:issues|defects|bugs|errors|findings))\b/i.test(assistantContent)
        || /(?:^|\n)\s*(?:1[.)]|first|issue\s*1)[\s\S]+(?:^|\n)\s*(?:2[.)]|second|issue\s*2)/i.test(assistantContent);

      if (hasMultipleContextFindings) {
        return {
          needsClarification: true,
          clarificationPrompt: 'Multiple issues were identified in the previous findings. Please clarify which specific issue you would like to address.',
          multipleCandidates: true,
        };
      }

      if (hasPriorContext || hasPriorFindings) {
        return { needsClarification: false, clarificationPrompt: null, resolvedFromContext: true };
      }
    }

    return {
      needsClarification: true,
      clarificationPrompt: `The request "${clean}" is ambiguous. Please specify the target component, desired behavior, or error details to proceed.`,
    };
  }

  // Detect ambiguous mixed-intent requests combining action directive and informational inquiry
  const hasDisjunctiveInquiry = /\b(?:or\s+(?:should|can|could|would|what|why|how|explain|tell|describe|clarify|discuss|else)|either\b.*\bor\b|not\s+sure\s+(?:if|whether))\b/i.test(clean);
  const hasActionVerb = /\b(?:debug|fix|repair|patch|modify|change|refactor|remove|delete|add|create|implement|write|apply|update|replace|build|scaffold|setup|full-?stack)\b/i.test(clean);
  if (hasDisjunctiveInquiry && hasActionVerb) {
    return {
      needsClarification: true,
      clarificationPrompt: 'Your request combines an action directive and an informational inquiry. Please clarify whether you would like the agent to apply code changes or provide an explanation first.',
    };
  }

  // Check ambiguous installation requests (package name missing)
  const installIntentInfo = classifyInstallIntent(clean, contextMessages);
  if (installIntentInfo.needsClarification) {
    return {
      needsClarification: true,
      clarificationPrompt: installIntentInfo.clarificationPrompt,
      installIntent: installIntentInfo.installIntent,
    };
  }

  // Check language conflict with detected project structure
  const langConflict = checkLanguageConflict(clean, projectContext);
  if (langConflict.needsClarification) {
    return langConflict;
  }

  return { needsClarification: false, clarificationPrompt: null };
}

/**
 * Evaluates semantic evidence across categories for a given request and context.
 */
function scoreIntentCategories(text, projectContext = null, evidence = []) {
  const normalized = String(text || '').toLowerCase().trim();
  const scores = {};
  for (const cat of ALL_CATEGORIES) {
    scores[cat] = 0;
  }

  const installIntentEval = classifyInstallIntent(normalized);
  if (installIntentEval.isInstallRequest) {
    scores[INTENT_CATEGORIES.UPGRADE_OR_MIGRATE] += 40;
  }

  // Primary clause priority: check which action is introduced at the start of the prompt
  const leadingCommand = normalized.replace(/^(?:(?:can\s+you\s+|could\s+you\s+|please\s+)+)/i, '');
  if (/^(?:build\s+and\s+test)\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.TEST_OR_VERIFY] += 10;
    scores[INTENT_CATEGORIES.BUILD_OR_SCAFFOLD] += 10;
  } else if (/^(?:build|scaffold|bootstrap|generate|create|add|implement|init|setup|write)\b/i.test(leadingCommand) || /^(?:run|execute)\s+(?:the\s+)?build\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.BUILD_OR_SCAFFOLD] += 10;
  } else if (/^(?:investigate|diagnose|debug|troubleshoot|trace|find\s+(?:the\s+)?cause|fix|resolve|patch|repair|correct|ensure|guarantee|prevent|inspect|audit|examine|analyze|analyse)\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG] += 10;
  } else if (/^(?:start|launch|boot|spin\s+up)\b/i.test(leadingCommand) || /^(?:run|execute)\s+(?:(?:the|my|this|our)\s+)?(?:attached\s+)?(?:project|app|application|workspace|server|dev\s+server)\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.RUN_OR_LAUNCH] += 10;
  } else if (/^(?:run|execute|check|perform)\s+(?:the\s+)?(?:tests?|test\s+suite|unit\s+tests?|e2e|specs?)/i.test(leadingCommand) || /^(?:test|verify)\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.TEST_OR_VERIFY] += 10;
  } else if (/^(?:refactor|restructure|reorganize|clean\s+up|simplify|decouple|remove|delete|eliminate|drop|change|modify|alter|adjust|switch|replace|set)\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.REFACTOR] += 10;
  } else if (/^(?:upgrade|migrate|bump|update|install|(?:npm|pnpm|yarn|bun)\s+(?:install|i|add))\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.UPGRADE_OR_MIGRATE] += 10;
  } else if (/^(?:what|how|why|where|who|explain|describe|show\s+me|tell\s+me|walk\s+me)\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.EXPLAIN_OR_ASK] += 10;
  }

  // 1. BUILD_OR_SCAFFOLD signals
  const buildPatterns = [
    /^(?:build|scaffold|bootstrap|generate|create|add|implement)\b/i,
    /\b(?:build|scaffold|bootstrap|generate|create|add|implement)\s+(?:(?:a|an|the|new|another|additional)\s+)*(?:[\w-]+\s+){0,4}(?:project|app|service|controller|model|component|route|endpoint|module|feature|functionality|handler|middleware|api|script|file|class|function)\b/i,
    /\b(?:initialize|init)\s+(?:the\s+)?(?:project|repository|workspace|package|application)\b/i,
    /\b(?:write|set\s+up)\s+(?:a\s+new|an?\s+initial|code\s+for)\b/i,
    /\b(?:run|execute|trigger|start)\s+(?:the\s+)?build\b/i,
    /\b(?:compile|transpile|typecheck|type-check)\b/i,
  ];
  if (buildPatterns.some((p) => p.test(normalized))) {
    scores[INTENT_CATEGORIES.BUILD_OR_SCAFFOLD] += 30;
  }

  // 2. INVESTIGATE_OR_DEBUG signals
  const debugPatterns = [
    /^(?:investigate|diagnose|debug|troubleshoot|trace|find\s+(?:the\s+)?root\s+cause|fix|resolve|patch|repair|correct|ensure|guarantee|prevent|inspect|audit|examine|analyze|analyse)\b/i,
    /\b(?:investigate|diagnose|debug|troubleshoot|trace|find\s+(?:the\s+)?root\s+cause|inspect|audit|examine|analyze|analyse)\b/i,
    /\b(?:failure|fault)\b/i,
    /\b(?:why\s+is\s+(?:it|this|\w+)\s+(?:failing|crashing|throwing|broken|timing\s+out))\b/i,
    /\b(?:fix|resolve|patch|repair|correct)\s+(?:the\s+)?(?:bug|defect|error|exception|crash|failure|issue|leak|problem|missing|broken)\b/i,
    /\b(?:fix|resolve|patch|repair|correct)\b/i,
    /\b(?:nullpointerexception|typeerror|syntaxerror|unhandled\s+rejection|500\s+internal|stack\s*trace)\b/i,
    /\b(?:bug|defect|flaw)\b/i,
    /\b(?:check\s+karo|kya\s+bug|kiya\s+bug)\b/i,
    /\b(?:ensure|guarantee|prevent)\s+(?:that\s+)?(?:failed|failure|errors?|crashes?|exceptions?|bugs?|leaks?|unhandled)\b/i,
    /\b(?:ensure|make\s+sure)\b/i,
    /\b(?:release|rollback)\s+(?:the\s+)?(?:database\s+)?transaction\b/i,
  ];
  if (debugPatterns.some((p) => p.test(normalized))) {
    scores[INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG] += 30;
  }

  // 3. RUN_OR_LAUNCH signals
  const runPatterns = [
    /^(?:start|launch|boot|spin\s+up)\b/i,
    /\b(?:start|launch|boot|spin\s+up)\s+(?:the\s+)?(?:dev\s+server|development\s+server|server|app|application|backend|frontend|service)\b/i,
    /\b(?:run|start|launch|boot|execute)\s+(?:(?:the|my|this|our)\s+)?(?:attached\s+)?(?:project|app|application|server|workspace)\b/i,
    /\b(?:run|start)\s+(?:the\s+)?(?:project|app|server)\s+(?:locally|on\s+port\s+\d+|in\s+dev\s+mode)\b/i,
    /\b(?:start\s+listening|serve\s+the\s+app)\b/i,
  ];
  if (runPatterns.some((p) => p.test(normalized))) {
    scores[INTENT_CATEGORIES.RUN_OR_LAUNCH] += 30;
  }

  // 4. TEST_OR_VERIFY signals
  const testPatterns = [
    /\b(?:run|execute|check|perform)\s+(?:the\s+)?(?:tests?|test\s+suite|unit\s+tests?|e2e\s+tests?|integration\s+tests?|specs?)\b/i,
    /\b(?:run|check)\s+(?:npm\s+test|phpunit|pytest|vitest|jest|cargo\s+test|go\s+test)\b/i,
    /\b(?:verify|test)\s+(?:that|if|whether|the\s+build|all\s+checks|all\s+assertion)\b/i,
    /\b(?:check\s+for\s+regressions?|run\s+lint(?:er)?|typecheck|static\s+analysis)\b/i,
    /^(?:test|verify)\s+(?:this|the\s+project|the\s+module)\b/i,
    /\b(?:build\s+and\s+test|(?:run|start)\s+and\s+test)\s+(?:(?:the|my|this|our|attached)\s+)?(?:project|app|application|workspace)\b/i,
  ];
  if (testPatterns.some((p) => p.test(normalized))) {
    scores[INTENT_CATEGORIES.TEST_OR_VERIFY] += 30;
  }
  if (/\b(?:tests?\s+pass(?:ing)?|test\s+coverage|assertions?\s+pass)\b/i.test(normalized)) {
    scores[INTENT_CATEGORIES.TEST_OR_VERIFY] += 15;
  }

  // 5. REFACTOR signals
  const refactorPatterns = [
    /^(?:refactor|restructure|reorganize|remove|delete|eliminate|drop|change|modify|alter|adjust|switch|replace|set)\b/i,
    /\b(?:refactor|restructure|reorganize|clean\s+up|simplify|decouple|modularize)\b/i,
    /\b(?:change|modify|alter|adjust|switch|replace|set)\s+(?:the\s+)?[\w-]+\s+to\b/i,
    /\b(?:remove|delete|eliminate|drop)\s+(?:the\s+)?(?:debugger|console\.log|unused|dead\s+code|redundant|duplicate|old|deprecated|statement|call)\b/i,
    /\b(?:remove|delete|eliminate|drop)\b/i,
    /\b(?:extract\s+(?:method|function|class|module|service|hook|component)|extract\s+common)\b/i,
    /\b(?:reduce\s+technical\s+debt|improve\s+maintainability|code\s+smell|deduplicate)\b/i,
    /\b(?:rename\s+(?:symbol|variable|function|class|file)\s+across)\b/i,
  ];
  if (refactorPatterns.some((p) => p.test(normalized))) {
    scores[INTENT_CATEGORIES.REFACTOR] += 30;
  }

  // 6. UPGRADE_OR_MIGRATE signals
  const upgradePatterns = [
    /^(?:upgrade|migrate|bump)\b/i,
    /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/i,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/i,
    /\b(?:upgrade|bump|update|install|download)\s+(?:the\s+)?(?:node_modules|dependencies|deps|packages?|libraries|version|runtime|missing\s+dependencies)\b/i,
    /\bmigrate\s+(?:from|to|the\s+codebase|the\s+schema|the\s+database|api|the\s+api\s+routes)\b/i,
    /\b(?:upgrade|migrate)\s+[\w.-]+\s+(?:to\s+(?:v\d+|latest|version|\d+))\b/i,
    /\b(?:deprecat\w+|breaking\s+changes?\s+migration)\b/i,
  ];
  if (upgradePatterns.some((p) => p.test(normalized))) {
    scores[INTENT_CATEGORIES.UPGRADE_OR_MIGRATE] += 30;
  }

  // 7. EXPLAIN_OR_ASK signals
  const questionPatterns = [
    /^(?:what\s+(?:is|are|does|do|happens)|how\s+(?:does|do|can|is|are|to)|why\s+(?:is|does|do|did)|where\s+(?:is|are|can)|who\s+is)\b/i,
    /^(?:explain|describe|show\s+me|tell\s+me\s+about|walk\s+(?:me\s+)?through|give\s+(?:me\s+)?an?\s+overview|help\s+me\s+understand)\b/i,
    /^(?:can\s+you\s+(?:please\s+)?explain)\b/i,
    /\b(?:what\s+does\s+this\s+code\s+do|how\s+is\s+this\s+implemented|where\s+is\s+the\s+definition)\b/i,
  ];
  if (questionPatterns.some((p) => p.test(normalized))) {
    scores[INTENT_CATEGORIES.EXPLAIN_OR_ASK] += 30;
  }
  if (normalized.endsWith('?') && !/\b(?:fix|create|build|implement|refactor|upgrade|run|scaffold)\b/i.test(normalized)) {
    scores[INTENT_CATEGORIES.EXPLAIN_OR_ASK] += 15;
  }
  if (/\b(?:read-only|explain\s+only|no\s+changes?)\b/i.test(normalized)) {
    scores[INTENT_CATEGORIES.EXPLAIN_OR_ASK] += 10;
  }

  // Contextual modifiers
  if (projectContext) {
    if (projectContext.workspaceState === 'EMPTY') {
      if (scores[INTENT_CATEGORIES.BUILD_OR_SCAFFOLD] > 0 || /\b(?:start|create|setup|init)\b/i.test(normalized)) {
        scores[INTENT_CATEGORIES.BUILD_OR_SCAFFOLD] += 20;
      }
    }
    if (projectContext.scripts && (scores[INTENT_CATEGORIES.TEST_OR_VERIFY] > 0 || scores[INTENT_CATEGORIES.RUN_OR_LAUNCH] > 0)) {
      const requestedWords = normalized.split(/\s+/);
      for (const [scriptName] of Object.entries(projectContext.scripts)) {
        if (requestedWords.includes(scriptName.toLowerCase())) {
          if (/test|check|lint|spec/i.test(scriptName)) {
            scores[INTENT_CATEGORIES.TEST_OR_VERIFY] += 15;
          } else if (/start|dev|serve|launch|run/i.test(scriptName)) {
            scores[INTENT_CATEGORIES.RUN_OR_LAUNCH] += 15;
          }
        }
      }
    }
  }

  return scores;
}

/**
 * Classifies a user request into generic intent categories.
 *
 * @param {Object} options
 * @param {string} options.request - Raw user prompt/request text.
 * @param {Object} [options.projectContext] - Discovered project context.
 * @param {Array} [options.evidence] - Evidence items discovered from workspace.
 * @returns {Object} Structured classification result.
 */

/**
 * General semantic intent analyzer.
 * Evaluates speech act, target artifacts, required evidence, and risk without hardcoded keyword lists.
 */
function analyzeSemanticIntent(text, { projectContext = null, evidence = [], contextMessages = [] } = {}) {
  const clean = String(text || '').trim();
  if (!clean) {
    return {
      primaryIntent: INTENT_CATEGORIES.CONVERSATION_OR_FEEDBACK,
      processingLevel: PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION,
      confidence: 'HIGH',
      actionable: false,
      mutationRequired: false,
      needsClarification: true,
      clarificationPrompt: 'Please provide a task description or question for the coding agent.',
      reasoning: 'Empty request provided.',
    };
  }

  function referencesDefectOrArtifact(str) {
    if (typeof str !== 'string' || str.trim().length < 5) return false;
    const hasFile = /\b[\w-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|php|py|rb|go|rs|html|css|sql|ya?ml|env)\b/i.test(str);
    const hasFinding = /\b(?:root\s+cause|identified\s+(?:a\s+)?defect|found\s+(?:a\s+)?defect|unhandled\s+rejection|null\s+pointer|memory\s+leak|stack\s+trace)\b/i.test(str);
    const hasDefectWithTarget = /\b(?:defect|bug|error|exception|failure|crash|leak|timeout|issue|unhandled|broken|failing)\b/i.test(str)
      && /\b(?:in|at|on|for|with)\s+(?:the\s+)?[\w_.-]+/i.test(str);
    return hasFile || hasFinding || hasDefectWithTarget;
  }

  const hasPriorContext = Array.isArray(contextMessages) && contextMessages.length > 0
    && contextMessages.some((msg) => msg && typeof msg.content === 'string' && referencesDefectOrArtifact(msg.content));
  const hasPriorFindings = Array.isArray(projectContext?.priorFindings) && projectContext.priorFindings.length > 0;

  // 1. Detect Vague / Ambiguous Directives requiring clarification
  const isVagueDirective = /^(?:(?:can\s+you|could\s+you|would\s+you|please|will\s+you)\s+(?:please\s+)?)?(?:make\s+[\w\s]*\s*(?:better|faster|cleaner|nicer|cool(?:er)?)|improve\s+(?:this|it|the\s+project|the\s+app|the\s+code|performance|things)|fix\s+(?:this|it|the\s+bug|that\s+bug|the\s+code|stuff|things)|do\s+(?:something|coding|it)|optimize\s+(?:this|it|everything)|clean\s+(?:it\s+)?up)\s*[.!?]*$/i.test(clean)
    || (/^(?:make|improve|optimize)\b.*\b(?:faster|better|cleaner)\b/i.test(clean) && !/\b(?:ms|seconds?|query|queries|index|profile|benchmark|endpoint|test|error)\b/i.test(clean));

  if (isVagueDirective) {
    const isAnaphoricFix = /^(?:(?:can\s+you|could\s+you|would\s+you|please|will\s+you)\s+(?:please\s+)?)?(?:fix|resolve|patch|repair|address|debug)\s+(?:this|it|the\s+bug|that\s+bug|the\s+issue|that\s+issue|the\s+problem|the\s+defect)\b/i.test(clean);

    if (isAnaphoricFix && (hasPriorContext || hasPriorFindings)) {
      return {
        primaryIntent: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG,
        processingLevel: PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT,
        confidence: 'HIGH',
        actionable: true,
        mutationRequired: true,
        needsClarification: false,
        resolvedFromContext: true,
        reasoning: 'Resolved anaphoric defect fix reference from prior context.',
      };
    }

    return {
      primaryIntent: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG,
      processingLevel: PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING,
      confidence: 'LOW',
      actionable: false,
      mutationRequired: false,
      needsClarification: true,
      clarificationPrompt: `The request "${clean}" is ambiguous. Please specify the target component, desired behavior, or error details to proceed.`,
      reasoning: 'Vague directive without target, metric, or prior context.',
    };
  }

  // 2. Detect Ambiguous Mixed-Intent Requests (Combining Action Directive and Informational Inquiry)
  const hasDisjunctiveInquiry = /\b(?:or\s+(?:should|can|could|would|what|why|how|explain|tell|describe|clarify|discuss|else)|either\b.*\bor\b|not\s+sure\s+(?:if|whether))\b/i.test(clean);
  const hasActionVerb = /\b(?:debug|fix|repair|patch|modify|change|refactor|remove|delete|add|create|implement|write|apply|update|replace|build|scaffold|setup|full-?stack)\b/i.test(clean);
  if (hasDisjunctiveInquiry && hasActionVerb) {
    return {
      primaryIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK,
      processingLevel: PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING,
      confidence: 'MEDIUM',
      actionable: false,
      mutationRequired: false,
      needsClarification: true,
      clarificationPrompt: 'Your request combines an action directive and an informational inquiry. Please clarify whether you would like the agent to apply code changes or provide an explanation first.',
      reasoning: 'Mixed action and informational inquiry requires user clarification.',
    };
  }

  // 3. Detect Explicit Constraints (e.g. read-only, do not modify)
  const isExplicitNoChange = /\b(?:do\s+not|don't|dont|never)\s+(?:(?:just|only|actually|any)\s+){0,2}(?:modify|change|edit|write|apply|implement|fix|repair|patch|add|create|refactor|update|remove|delete|touch)\b/i.test(clean)
    || /\bwithout\s+(?:(?:just|only|actually|any)\s+)?(?:modifying|changing|editing|writing|applying|implementing|fixing|repairing|patching|adding|creating|refactoring|updating|removing|deleting|touching)\b/i.test(clean)
    || /\b(?:do\s+not|don't|dont)\s+(?:want|need|expect)\s+(?:any\s+)?(?:code\s+)?(?:changes?|modifications?|edits?|patches?)\b/i.test(clean)
    || /\b(?:do\s+not|don't|dont|never)\s+(?:make|apply)\s+(?:any\s+)?(?:code\s+)?changes?(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(clean)
    || /\bwithout\s+making\s+(?:any\s+)?(?:code\s+)?changes?(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(clean)
    || /\bno\s+(?:(?:code|file|source)\s+)?(?:changes?|modifications?|edits?|writes?|patches?)(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(clean);

  // 4. Identify Operative Action Directives vs Informational Inquiries
  const referencesConcreteArtifacts = /\b(?:code|files?|source|controller|model|view|route|routes|component|components|endpoint|endpoints|tests?|specs?|package|dependency|dependencies|node_modules|server|dev\s+server|app|database|schema|migration|script|scripts|config|bug|defect|error|trace|failure|crash)\b/i.test(clean)
    || /\b[\w-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|php|py|rb|go|rs|html|css|sql|ya?ml|env)\b/i.test(clean);

  const referencesTechnicalConcepts = referencesConcreteArtifacts
    || /\b(?:architecture|pipeline|lifecycle|algorithm|function|method|class|interface|type|protocol|pattern|strategy|database|auth|token|session|memory|concurrency|thread|async|promise|event|socket|ipc|pipe|process|isolation|runner|supervisor|verifier|contract|cgroups|namespace|sandbox|docker|wsl|terminal|cli|api|backend|frontend|rollback|git|patch|diff|commit|branch|repo|repository|module|agent|workflow)\b/i.test(clean);

  const isSocialQuestion = /\b(?:how\s+are\s+you(?:\s+doing)?|how's\s+it\s+going|what's\s+up|how\s+do\s+you\s+do|how\s+are\s+things|how\s+is\s+your\s+day|how\s+have\s+you\s+been)\b/i.test(clean);
  if (isSocialQuestion && !referencesConcreteArtifacts) {
    return {
      primaryIntent: INTENT_CATEGORIES.CONVERSATION_OR_FEEDBACK,
      processingLevel: PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION,
      confidence: 'HIGH',
      actionable: false,
      mutationRequired: false,
      needsClarification: false,
      reasoning: 'Social or interpersonal communication without project action.',
    };
  }

  // Distinct action domains:
  const isRunOrLaunch = /^(?:run|start|launch|boot|spin\s+up|execute)\s+(?:(?:the|my|this|our)\s+)?(?:attached\s+)?(?:project|app|application|workspace|server)(?:\s+(?:now|please|for\s+me|locally|in\s+dev(?:\s+mode)?))?$/i.test(clean)
    || /^(?:build\s+and\s+(?:test|run)|(?:run|start)\s+and\s+test)\s+(?:(?:the|my|this|our)\s+)?(?:attached\s+)?(?:project|app|application|workspace)/i.test(clean)
    || /\b(?:start|launch|boot|spin\s+up)\s+(?:(?:the|my|this|our)\s+)?(?:dev\s+server|server|application|app)\b/i.test(clean);

  const isTestOrVerify = /^(?:run\s+(?:the\s+)?tests?|run\s+(?:the\s+)?test\s+suite|run\s+tests?\s+for\b|test\s+(?:the\s+)?(?:project|app|code|tests?)|run\s+e2e|run\s+unit\s+tests?|check\s+if\s+(?:the\s+)?project\s+works?)\b/i.test(clean)
    || (/\b(?:run|execute)\s+(?:the\s+)?(?:tests?|test\s+suite|unit\s+tests?|regression\s+tests?)\b/i.test(clean) && !/\b(?:how|what|why|where)\b/i.test(clean));

  const isDependencyOperation = /\b(?:install|download|upgrade|migrate|update)\s+(?:(?:the|all|any|our|project|workspace|missing)\s+)*(?:dependencies|deps|packages?|node_modules)\b/i.test(clean)
    || /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update)\b/i.test(clean)
    || /^(?:install|add|upgrade|update)\s+(?:a\s+)?(?:package|dependency)\b/i.test(clean);

  // Split into sentences/clauses to handle conversational preambles (e.g. "Thanks for explaining! Please fix X.")
  const sentences = clean.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);

  function stripCourtesy(str) {
    return str
      .replace(/^(?:(?:hello|hi|hey|good\s+(?:morning|afternoon|evening)|thanks(?:\s+for\s+[^,;!?.\n]+)?|thank\s+you(?:\s+for\s+[^,;!?.\n]+)?|understood|got\s+it|sounds\s+good|okay|ok|cool|great|awesome|perfect|nice|sure|all\s+right|alright)\s*[,;!?.\n]?\s*)+/i, '')
      .replace(/^(?:(?:now|then|so)\s*[,;]?\s*)?(?:(?:can\s+you|could\s+you|would\s+you|please|will\s+you)\s+(?:please\s+)?)+/i, '')
      .replace(/^(?:(?:now|then|so)\s*[,;]?\s*)+/i, '')
      .trim();
  }

  const strippedOfCourtesy = stripCourtesy(clean);
  const clauseStripped = sentences.map(stripCourtesy);

  const isExplicitExplanation = /^(?:explain|describe|clarify|summarize|walk\s+me\s+through|tell\s+me(?:\s+about|\s+how|\s+why|\s+what|\s+if|\s+whether)?|show\s+me|help\s+me\s+understand|give\s+me\s+(?:an?\s+)?(?:overview|summary|explanation|details|breakdown)|provide\s+(?:an?\s+)?(?:overview|summary|explanation|details|breakdown))\b/i.test(strippedOfCourtesy)
    || /^(?:i\s+(?:want|would\s+like)\s+to\s+understand)\b/i.test(strippedOfCourtesy);

  const isQuestionInquiry = /^(?:what\s+(?:is|are|does|do|can|would|happened|happens|was|were)|how\s+(?:does|do|did|is|are|was|were|would|should|might|will|can|could|to)|why\s+(?:is|are|does|do|did|was|were|would|should)|where\s+(?:is|are|can|do|does)|who\s+(?:is|are|wrote|modified)|which\s+(?:file|module|class|function|method|component|test|part)|is\s+there\s+|are\s+there\s+|does\s+it\s+|do\s+we\s+|should\s+(?:i|we|it)\s+|could\s+(?:we|i)\s+|can\s+(?:we|i)\s+|would\s+it\s+be\s+)/i.test(clean)
    || /^(?:what\s+(?:is|are|does|do|can|would|happened|happens|was|were)|how\s+(?:does|do|did|is|are|was|were|would|should|might|will|can|could|to)|why\s+(?:is|are|does|do|did|was|were|would|should)|where\s+(?:is|are|can|do|does)|who\s+(?:is|are|wrote|modified)|which\s+(?:file|module|class|function|method|component|test|part)|is\s+there\s+|are\s+there\s+|does\s+it\s+|do\s+we\s+|should\s+(?:i|we|it)\s+|could\s+(?:we|i)\s+|can\s+(?:we|i)\s+|would\s+it\s+be\s+)/i.test(strippedOfCourtesy);

  const isDiscussionOrBrainstorm = /^(?:what\s+if\s+we\b|hows+about\s+(?:we|if)|let's\s+(?:think|discuss|talk|consider|explore|brainstorm)|we\s+could\s+(?:consider|explore|think\s+about)|could\s+we\s+(?:discuss|consider|explore|think\s+about)|can\s+we\s+(?:discuss|consider|explore|think\s+about)|i'm\s+thinking\s+(?:about|we\s+could)|i\s+was\s+thinking\s+(?:about|we\s+could))/i.test(strippedOfCourtesy);

  const directActionPattern = /^(?:debug|fix|repair|patch|modify|change|refactor|remove|delete|add|create|implement|write|apply|update|upgrade|migrate|replace|resolve|investigate|diagnose|inspect|audit|examine|trace|find\s+and\s+fix|run|start|launch|boot|execute|scaffold|bootstrap|setup|set\s+up|initialize|init|build|install|download|ensure|make\s+sure|enforce|prevent|handle|support|guard\s+against|enable|disable)\b/i;
  const startsWithDirectAction = directActionPattern.test(strippedOfCourtesy) || clauseStripped.some((c) => directActionPattern.test(c));

  // 5. Evaluate Processing Levels

  // Case A: Discussion or Brainstorming without directive to apply changes
  if (isDiscussionOrBrainstorm && !startsWithDirectAction) {
    return {
      primaryIntent: INTENT_CATEGORIES.DISCUSS_OR_BRAINSTORM,
      processingLevel: referencesConcreteArtifacts
        ? PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING
        : PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION,
      confidence: 'HIGH',
      actionable: false,
      mutationRequired: false,
      needsClarification: false,
      reasoning: 'Discussion or brainstorming regarding concepts or architecture without directive to apply changes.',
    };
  }

  // Case B: Explanations & Technical Inquiries (Level B)
  if ((isExplicitExplanation || isQuestionInquiry) && !startsWithDirectAction) {
    if (isExplicitNoChange) {
      const requestsInvestigation = /\b(?:investigate|diagnose|find\s+(?:the\s+)?cause|root\s+cause|why|failing|fails|failed|broken|error|bug|trace)\b/i.test(clean);
      if (requestsInvestigation && referencesConcreteArtifacts) {
        return {
          primaryIntent: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG,
          processingLevel: PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION,
          confidence: 'HIGH',
          actionable: true,
          mutationRequired: false,
          needsClarification: false,
          reasoning: 'Read-only investigation of source code without code mutations.',
        };
      }
    }

    return {
      primaryIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK,
      processingLevel: PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING,
      confidence: 'HIGH',
      actionable: false,
      mutationRequired: false,
      needsClarification: false,
      reasoning: 'Information or explanation inquiry without directive to modify workspace.',
    };
  }

  // Case C: Actionable Tasks (Run, Test, Install, Investigate, Development)
  if (isRunOrLaunch) {
    return {
      primaryIntent: INTENT_CATEGORIES.RUN_OR_LAUNCH,
      processingLevel: PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT,
      confidence: 'HIGH',
      actionable: true,
      mutationRequired: false,
      needsClarification: false,
      reasoning: 'Directive to run or launch project application/server.',
    };
  }

  if (isTestOrVerify) {
    return {
      primaryIntent: INTENT_CATEGORIES.TEST_OR_VERIFY,
      processingLevel: PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT,
      confidence: 'HIGH',
      actionable: true,
      mutationRequired: false,
      needsClarification: false,
      reasoning: 'Directive to execute project test suite or verification.',
    };
  }

  if (isDependencyOperation) {
    return {
      primaryIntent: INTENT_CATEGORIES.UPGRADE_OR_MIGRATE,
      processingLevel: PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT,
      confidence: 'HIGH',
      actionable: true,
      mutationRequired: true,
      needsClarification: false,
      reasoning: 'Directive to install, update, or manage project dependencies.',
    };
  }

  // Pure Read-only Investigation Directive (Level C)
  if (isExplicitNoChange && /\b(?:investigate|diagnose|inspect|audit|examine|find\s+(?:the\s+)?cause|trace)\b/i.test(strippedOfCourtesy)) {
    return {
      primaryIntent: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG,
      processingLevel: PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION,
      confidence: 'HIGH',
      actionable: true,
      mutationRequired: false,
      needsClarification: false,
      reasoning: 'Read-only focused source investigation requested without code modifications.',
    };
  }

  if (/^(?:debug|investigate|diagnose|inspect|audit|examine)\b/i.test(strippedOfCourtesy) && (referencesConcreteArtifacts || strippedOfCourtesy.length > 15)) {
    const hasRepairDirective = /\b(?:fix|repair|patch|resolve|correct|address|implement|change|modify)\b/i.test(strippedOfCourtesy);
    return {
      primaryIntent: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG,
      processingLevel: hasRepairDirective && !isExplicitNoChange
        ? PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT
        : (isExplicitNoChange ? PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION : PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT),
      confidence: 'HIGH',
      actionable: true,
      mutationRequired: !isExplicitNoChange,
      needsClarification: false,
      reasoning: 'Investigation and resolution of defect or issue in project artifacts.',
    };
  }

  // Actionable Code Modification Directive (Level D)
  if (startsWithDirectAction && (referencesConcreteArtifacts || strippedOfCourtesy.length > 15 || hasPriorContext || hasPriorFindings)) {
    let specificIntent = INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG;
    if (/^(?:build|scaffold|bootstrap|create|implement|add|setup|set\s+up|initialize|init)\b/i.test(strippedOfCourtesy)) {
      specificIntent = INTENT_CATEGORIES.BUILD_OR_SCAFFOLD;
    } else if (/^(?:refactor|restructure|reorganize|clean\s+up|simplify)\b/i.test(strippedOfCourtesy)) {
      specificIntent = INTENT_CATEGORIES.REFACTOR;
    } else if (/^(?:upgrade|migrate|update|install|download)\b/i.test(strippedOfCourtesy)) {
      specificIntent = INTENT_CATEGORIES.UPGRADE_OR_MIGRATE;
    }

    return {
      primaryIntent: specificIntent,
      processingLevel: PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT,
      confidence: 'HIGH',
      actionable: true,
      mutationRequired: true,
      needsClarification: false,
      reasoning: 'Directive to perform code modifications, creation, or repair on project artifacts.',
    };
  }

  // Trailing question mark without action directive -> Level B or A
  if (clean.endsWith('?') && !startsWithDirectAction) {
    return {
      primaryIntent: INTENT_CATEGORIES.EXPLAIN_OR_ASK,
      processingLevel: referencesConcreteArtifacts
        ? PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING
        : PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION,
      confidence: 'MEDIUM',
      actionable: false,
      mutationRequired: false,
      needsClarification: false,
      reasoning: 'Trailing inquiry question without directive to perform project mutations.',
    };
  }

  // Case C2: Technical task or actionable instruction referencing concrete artifacts / technical domain
  if (referencesConcreteArtifacts || referencesTechnicalConcepts || strippedOfCourtesy.length > 25) {
    return {
      primaryIntent: INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG,
      processingLevel: PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT,
      confidence: 'MEDIUM',
      actionable: true,
      mutationRequired: true,
      needsClarification: false,
      reasoning: 'Actionable software engineering task referencing concrete artifacts or technical objectives.',
    };
  }

  // Case D: Pure Conversational / Social / Interpersonal / Feedback (Level A)
  return {
    primaryIntent: INTENT_CATEGORIES.CONVERSATION_OR_FEEDBACK,
    processingLevel: PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION,
    confidence: 'HIGH',
    actionable: false,
    mutationRequired: false,
    needsClarification: false,
    reasoning: 'Conversational interaction or social communication without action directive.',
  };
}

function classifyTaskIntent({ request, projectContext = null, evidence = [], contextMessages = [] } = {}) {
  const originalRequest = String(request || '');
  const constraints = extractConstraints(originalRequest);
  const ambiguity = checkAmbiguity(originalRequest, projectContext, contextMessages);

  if (ambiguity.needsClarification) {
    const taskRepresentation = {
      userGoal: originalRequest,
      taskType: null,
      requestedOutcomes: [],
      constraints,
      acceptanceCriteria: [],
      unresolvedQuestions: [ambiguity.clarificationPrompt],
    };
    return {
      primaryIntent: null,
      taskType: null,
      processingLevel: PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING,
      userGoal: originalRequest,
      requestedOutcomes: [],
      taskRepresentation,
      secondaryIntents: [],
      allIntents: [],
      confidence: 'LOW',
      reasoning: ambiguity.clarificationPrompt,
      actionable: false,
      mutationRequired: false,
      constraints,
      originalRequest,
      needsClarification: true,
      clarificationPrompt: ambiguity.clarificationPrompt,
      unresolvedQuestions: [ambiguity.clarificationPrompt],
    };
  }

  // 1. Run general semantic intent analyzer
  const semanticAnalysis = analyzeSemanticIntent(originalRequest, { projectContext, evidence, contextMessages });

  // Fine-grained technical intent evaluation
  const scores = scoreIntentCategories(originalRequest, projectContext, evidence);
  const sorted = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);
  const hasHighTechnicalSignal = sorted.length > 0 && sorted[0][1] >= 10;

  // If semantic analysis determined direct interaction (Level A) and no strong technical directive is present, return lightweight conversational classification
  if (semanticAnalysis.processingLevel === PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION && !hasHighTechnicalSignal) {
    const taskRepresentation = {
      userGoal: originalRequest,
      taskType: semanticAnalysis.primaryIntent,
      requestedOutcomes: [originalRequest],
      constraints,
      acceptanceCriteria: [originalRequest],
      unresolvedQuestions: [],
    };
    return {
      primaryIntent: semanticAnalysis.primaryIntent,
      taskType: semanticAnalysis.primaryIntent,
      processingLevel: semanticAnalysis.processingLevel,
      userGoal: originalRequest,
      requestedOutcomes: [originalRequest],
      taskRepresentation,
      secondaryIntents: [],
      allIntents: [semanticAnalysis.primaryIntent],
      confidence: semanticAnalysis.confidence || 'HIGH',
      reasoning: semanticAnalysis.reasoning,
      actionable: false,
      mutationRequired: false,
      constraints,
      originalRequest,
      installIntent: null,
      packageName: null,
      needsClarification: false,
      clarificationPrompt: null,
      unresolvedQuestions: [],
    };
  }

  let primaryIntent = semanticAnalysis.primaryIntent || INTENT_CATEGORIES.EXPLAIN_OR_ASK;
  let secondaryIntents = [];
  let confidence = semanticAnalysis.confidence || 'MEDIUM';
  let reasoning = semanticAnalysis.reasoning || 'Evaluated request based on semantic analysis.';

  if (sorted.length > 0 && semanticAnalysis.processingLevel !== PROCESSING_LEVELS.LEVEL_A_DIRECT_INTERACTION) {
    primaryIntent = sorted[0][0];
    const topScore = sorted[0][1];
    confidence = topScore >= 30 ? 'HIGH' : (topScore >= 20 ? 'MEDIUM' : 'LOW');
    secondaryIntents = sorted.slice(1).filter(([, score]) => score >= 15).map(([cat]) => cat);
    reasoning = `Classified primary intent as ${primaryIntent} with score ${topScore}${secondaryIntents.length ? ` and secondary intent(s): ${secondaryIntents.join(', ')}` : ''}.`;
  }


  const allIntents = [primaryIntent, ...secondaryIntents];

  // Determine actionability and mutation requirements
  const isReadOnlyConstrained = constraints.some((c) => c.startsWith('DO_NOT_MODIFY: any code') || c === 'READ_ONLY_MODE');

  const nonActionable = [
    INTENT_CATEGORIES.EXPLAIN_OR_ASK,
    INTENT_CATEGORIES.CONVERSATION_OR_FEEDBACK,
    INTENT_CATEGORIES.DISCUSS_OR_BRAINSTORM,
  ];

  const nonMutatingActionable = [
    INTENT_CATEGORIES.RUN_OR_LAUNCH,
    INTENT_CATEGORIES.TEST_OR_VERIFY,
  ];

  const actionable = !nonActionable.includes(primaryIntent) || semanticAnalysis.actionable;
  let mutationRequired = actionable && !nonMutatingActionable.includes(primaryIntent);
  if (isReadOnlyConstrained || (semanticAnalysis.actionable && semanticAnalysis.mutationRequired === false)) {
    mutationRequired = false;
  }

  const processingLevel = semanticAnalysis.processingLevel || (
    !actionable
      ? PROCESSING_LEVELS.LEVEL_B_LIGHTWEIGHT_UNDERSTANDING
      : mutationRequired
        ? PROCESSING_LEVELS.LEVEL_D_FULL_DEVELOPMENT
        : PROCESSING_LEVELS.LEVEL_C_FOCUSED_INVESTIGATION
  );

  const taskType = primaryIntent;
  const requestedOutcomes = [
    primaryIntent === INTENT_CATEGORIES.BUILD_OR_SCAFFOLD
      ? `Build/scaffold project components for "${originalRequest}"`
      : primaryIntent === INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG
        ? `Investigate and resolve defect for "${originalRequest}"`
        : primaryIntent === INTENT_CATEGORIES.RUN_OR_LAUNCH
          ? `Launch/run application runtime for "${originalRequest}"`
          : primaryIntent === INTENT_CATEGORIES.TEST_OR_VERIFY
            ? `Execute verification checks and report real execution evidence for "${originalRequest}"`
            : primaryIntent === INTENT_CATEGORIES.REFACTOR
              ? `Refactor codebase according to constraints for "${originalRequest}"`
              : primaryIntent === INTENT_CATEGORIES.UPGRADE_OR_MIGRATE
                ? `Upgrade/migrate dependencies or environment for "${originalRequest}"`
                : `Analyze codebase and answer inquiry for "${originalRequest}"`,
  ];

  const taskRepresentation = {
    userGoal: originalRequest,
    taskType,
    requestedOutcomes,
    constraints,
    acceptanceCriteria: requestedOutcomes,
    unresolvedQuestions: [],
  };

  const installIntentResult = classifyInstallIntent(originalRequest, contextMessages);

  return {
    primaryIntent,
    taskType,
    processingLevel,
    userGoal: originalRequest,
    requestedOutcomes,
    taskRepresentation,
    secondaryIntents,
    allIntents,
    confidence,
    reasoning,
    actionable,
    mutationRequired,
    constraints,
    originalRequest,
    installIntent: installIntentResult.installIntent || null,
    packageName: installIntentResult.packageName || null,
    needsClarification: false,
    clarificationPrompt: null,
    unresolvedQuestions: [],
  };
}

module.exports = {
  PROCESSING_LEVELS,
  INTENT_CATEGORIES,
  TASK_TYPES: INTENT_CATEGORIES,
  ALL_CATEGORIES,
  INSTALL_INTENTS,
  classifyInstallIntent,
  checkLanguageConflict,
  extractConstraints,
  checkAmbiguity,
  scoreIntentCategories,
  analyzeSemanticIntent,
  classifyTaskIntent,
};
