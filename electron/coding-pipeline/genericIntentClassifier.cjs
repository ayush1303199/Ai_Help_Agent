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

const INTENT_CATEGORIES = Object.freeze({
  BUILD_OR_SCAFFOLD: 'BUILD_OR_SCAFFOLD',
  INVESTIGATE_OR_DEBUG: 'INVESTIGATE_OR_DEBUG',
  RUN_OR_LAUNCH: 'RUN_OR_LAUNCH',
  TEST_OR_VERIFY: 'TEST_OR_VERIFY',
  REFACTOR: 'REFACTOR',
  UPGRADE_OR_MIGRATE: 'UPGRADE_OR_MIGRATE',
  EXPLAIN_OR_ASK: 'EXPLAIN_OR_ASK',
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
 * Checks if a request is genuinely ambiguous or lacks necessary technical context.
 */
function checkAmbiguity(text, projectContext = null) {
  const clean = String(text || '').trim();
  if (!clean) {
    return {
      needsClarification: true,
      clarificationPrompt: 'Please provide a task description or question for the coding agent.',
    };
  }

  // Detect vague requests lacking concrete target, file, symptom, or metric
  const isVague = /^(?:make\s+[\w\s]*\s*(?:better|faster|cleaner|nicer|cool(?:er)?)|improve\s+(?:this|it|the\s+project|the\s+app|the\s+code|performance|things)|fix\s+(?:this|it|the\s+bug|the\s+code|stuff|things)|do\s+(?:something|coding|it)|optimize\s+(?:this|it|everything)|clean\s+up)\s*[.!?]*$/i.test(clean)
    || (/^(?:make|improve|optimize)\b.*\b(?:faster|better|cleaner)\b/i.test(clean) && !/\b(?:ms|seconds?|query|queries|index|profile|benchmark|endpoint|test|error)\b/i.test(clean));

  if (isVague) {
    return {
      needsClarification: true,
      clarificationPrompt: `The request "${clean}" is ambiguous. Please specify the target component, desired behavior, or error details to proceed.`,
    };
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

  // Primary clause priority: check which action is introduced at the start of the prompt
  const leadingCommand = normalized.replace(/^(?:(?:can\s+you\s+|could\s+you\s+|please\s+)+)/i, '');
  if (/^(?:build|scaffold|bootstrap|generate|create|add|implement|init|setup|write)\b/i.test(leadingCommand) || /^(?:run|execute)\s+(?:the\s+)?build\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.BUILD_OR_SCAFFOLD] += 10;
  } else if (/^(?:investigate|diagnose|debug|troubleshoot|trace|find\s+(?:the\s+)?cause|fix|resolve|patch|repair|correct|ensure|guarantee|prevent|inspect|audit|examine|analyze|analyse)\b/i.test(leadingCommand)) {
    scores[INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG] += 10;
  } else if (/^(?:start|launch|boot|spin\s+up)\b/i.test(leadingCommand)) {
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
function classifyTaskIntent({ request, projectContext = null, evidence = [] } = {}) {
  const originalRequest = String(request || '');
  const constraints = extractConstraints(originalRequest);
  const ambiguity = checkAmbiguity(originalRequest, projectContext);

  if (ambiguity.needsClarification) {
    return {
      primaryIntent: null,
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
    };
  }

  const scores = scoreIntentCategories(originalRequest, projectContext, evidence);

  // Sort categories by score descending
  const sorted = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  let primaryIntent = INTENT_CATEGORIES.EXPLAIN_OR_ASK;
  let secondaryIntents = [];
  let confidence = 'LOW';
  let reasoning = 'Defaulted to informational inquiry based on text.';

  if (sorted.length > 0) {
    primaryIntent = sorted[0][0];
    const topScore = sorted[0][1];
    confidence = topScore >= 30 ? 'HIGH' : (topScore >= 20 ? 'MEDIUM' : 'LOW');
    secondaryIntents = sorted.slice(1).filter(([, score]) => score >= 15).map(([cat]) => cat);
    reasoning = `Classified primary intent as ${primaryIntent} with score ${topScore}${secondaryIntents.length ? ` and secondary intent(s): ${secondaryIntents.join(', ')}` : ''}.`;
  } else {
    primaryIntent = INTENT_CATEGORIES.EXPLAIN_OR_ASK;
    confidence = 'MEDIUM';
    reasoning = 'No mutation or execution directive identified; treated as question/explanation.';
  }

  const allIntents = [primaryIntent, ...secondaryIntents];

  // Determine actionability and mutation requirements
  const isReadOnlyConstrained = constraints.some((c) => c.startsWith('DO_NOT_MODIFY: any code') || c === 'READ_ONLY_MODE');

  const nonActionableIntents = new Set([INTENT_CATEGORIES.EXPLAIN_OR_ASK]);
  const actionable = !nonActionableIntents.has(primaryIntent);

  const mutationIntents = new Set([
    INTENT_CATEGORIES.BUILD_OR_SCAFFOLD,
    INTENT_CATEGORIES.REFACTOR,
    INTENT_CATEGORIES.UPGRADE_OR_MIGRATE,
  ]);

  let mutationRequired = false;
  if (!isReadOnlyConstrained) {
    if (mutationIntents.has(primaryIntent)) {
      mutationRequired = true;
    } else if (primaryIntent === INTENT_CATEGORIES.INVESTIGATE_OR_DEBUG) {
      mutationRequired = /\b(?:fix|resolve|patch|repair|solve|correct)\b/i.test(originalRequest);
    }
  }

  return {
    primaryIntent,
    secondaryIntents,
    allIntents,
    confidence,
    reasoning,
    actionable,
    mutationRequired,
    constraints,
    originalRequest,
    needsClarification: false,
    clarificationPrompt: null,
  };
}

module.exports = {
  INTENT_CATEGORIES,
  ALL_CATEGORIES,
  extractConstraints,
  checkAmbiguity,
  scoreIntentCategories,
  classifyTaskIntent,
};
