interface GeneralTaskState {
  taskId: string;
  sessionId: string;
  goal: string;
  requirements: string[];
  constraints: string[];
  phase: string;
  currentSite: string | null;
  currentUrl: string | null;
  browserSessionId: string | null;
  pendingAction: {
    actionId: string;
    tool: string;
    args: Record<string, unknown>;
    riskLevel: string;
    target: string;
    preparedAt: string;
    startedAt: string | null;
    confirmedAt: string | null;
    result: { ok: boolean; status: string } | null;
  } | null;
  riskLevel: string;
  confirmationId: string | null;
  authenticationState: string;
  planningStatus: string;
  progressMessage: string;
  trace: {
    taskId: string;
    phase: string;
    intent: string | null;
    capability: string | null;
    provider: string | null;
    currentNode: string | null;
    action: string | null;
    risk: string;
    confirmationState: string;
    verificationState: string;
    failureClassification: string | null;
    retryCount: number;
  };
  structuredRequirements: {
    taskType: string;
    origin: string | null;
    destination: string | null;
    travelDate: string | null;
    resultCount: number | null;
    optimization: string;
    actionIntent: string;
    intent: string;
    currentIntent: string;
    allowedActions: string[];
    forbiddenActions: string[];
    autonomyLevel: string;
    domainRequirements: Record<string, Record<string, unknown>>;
    criticalRequirements: string[];
    requirementStatus: Record<string, string>;
    preferences: Record<string, string | number>;
    executionPolicy: string;
    bookingAllowed: boolean;
    paymentAllowed: boolean;
    submitAllowed: boolean;
    confirmationRequired: boolean;
    refinement: {
      input: string;
      changedFields: string[];
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    } | null;
  } | null;
  categories: string[];
  preferences: Record<string, unknown>;
  missingInformation: Array<{ id: string; prompt: string; reason: string; requiredFor: string; criticality?: string }>;
  capabilityRoutes: Array<{
    capability: string;
    description: string;
    allowedActions: string[];
    riskLevel: string;
    requiredPermissions: string[];
    requiredConfirmation: boolean;
    verificationStrategy: string;
    recoveryStrategy: string;
    providerCandidates: Array<{
      providerId: string;
      displayName: string;
      lifecycle: string;
      implemented: boolean;
      ready: boolean;
      supportsFallback: boolean;
    }>;
  }>;
  providers: string[];
  plan: {
    version: number;
    status: string;
    nextAction: string;
    taskGraph: {
      nodes: Array<{ id: string; title: string; capability: string | null; action: string; dependsOn: string[]; status: string }>;
      roots: string[];
      terminalNodeId: string;
    };
  } | null;
  handoff: Record<string, unknown> | null;
  executionActionId: string | null;
  observationVersion: number;
  lastObservation: Record<string, unknown> | null;
  assistantResponse: {
    status: 'COMPLETED' | 'PARTIAL' | 'ERROR';
    content: string;
    provider: string | null;
    model: string | null;
    source: 'LIVE_PROVIDER';
    evidenceAvailable: boolean;
    requestId: string | null;
    receivedAt: string;
  } | null;
  providerError: { category: string; message: string; at: string } | null;
  contextMetrics: {
    estimatedInputChars?: number;
    estimatedInputTokens?: number;
    messageChars?: number;
    toolSchemaChars?: number;
    observationChars?: number;
    budgetChars?: number;
    budgetTokens?: number;
    originalMessageCount?: number;
    messageCount?: number;
    compacted?: boolean;
    compactionMode?: string;
    retryCount?: number;
    compactionStatus?: string;
  } | null;
  actionCount: number;
  retryCount: number;
  navigationDepth: number;
  screenshotCount: number;
  taskMemory: {
    summary: string | null;
    references: Array<{ phrase: string; status: string }>;
    referenceResolution: { status: string; phrase?: string; reason?: string; index?: number } | null;
    currentIntent: string | null;
    currentCapability: string | null;
    structuredRequirements: Record<string, unknown> | null;
    constraints: string[];
    preferences: Record<string, unknown>;
    selectedReferences: Array<{ phrase: string; index?: number; selectedAt: string }>;
    resultSetSummary: { count: number; source: string; updatedAt: string } | null;
    lastRefinement: Record<string, unknown> | null;
    conversationSummary: string;
    pendingAction: { actionId: string; tool: string; target: string } | null;
    riskLevel: string;
    confirmationState: string;
    completed: string[];
    remaining: string[];
    ruledOut: string[];
    observations: Array<Record<string, unknown>>;
  };
  finalStatus: string | null;
  blockedReason: string | null;
  paused: boolean;
  bounds: Record<string, number>;
  history: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

interface GeneralExecutionAction {
  actionId: string;
  taskId: string;
  generalSessionId: string;
  browserSessionId: string | null;
  capability: string;
  provider: string;
  operation: string;
  target: string | Record<string, unknown>;
  arguments: Record<string, unknown>;
  riskLevel: string;
  requiresConfirmation: boolean;
  expectedOutcome: unknown;
  observationVersion: number;
  state: string;
  lifecycle: Array<{ state: string; at: string; [key: string]: unknown }>;
  confirmationId: string | null;
  confirmedAt: string | null;
  attempts: number;
  retryCount: number;
  result: Record<string, unknown> | null;
  observation: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
}

interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OverlayRendererState {
  answer?: string;
  question?: string;
  analysis?: string | string[] | null;
  summary?: string | string[] | null;
  actionItems?: unknown;
  status?: string;
  visibility: 'VISIBLE' | 'MINIMIZED' | 'HIDDEN';
  lowVisibility: boolean;
  opacity: number;
  autoHideEnabled: boolean;
  autoHideDelay: number;
  alwaysOnTop: boolean;
  activeTab: 'answer' | 'analysis' | 'summary' | 'action-items' | 'search' | 'history';
  bounds: OverlayBounds;
  expandedBounds: OverlayBounds;
}

interface MeetingOverlayRuntimeState {
  answer: string;
  question: string;
  analysis: string;
  summary: string;
  actionItems: string[];
  transcripts?: Array<{ id: string; source: string; text: string; createdAt: string }>;
  answeredSegments?: Array<{ question: string; answer: string; createdAt?: string }>;
  status: string;
  error: string;
  statusMessage: string;
  statusStartedAt: number;
  agent: 'meeting';
  captureActive: boolean;
  transcribing: boolean;
  audioSignalDetected: boolean;
  meetingActive: boolean;
  version: number;
  updatedAt: number;
}

interface MeetingOverlayCommand {
  type: 'start-listening' | 'stop-listening' | 'cancel-request' | 'open-audio-settings' | 'question';
  question?: string;
  commandId?: string;
}

interface MeetingOverlayCommandResult {
  commandId: string;
  ok: boolean;
  captureActive?: boolean;
  message?: string;
}

interface Window {
  electronAPI?: {
    openOverlay: () => Promise<OverlayRendererState>;
    showOverlay: () => Promise<OverlayRendererState>;
    hideOverlay: () => Promise<OverlayRendererState>;
    toggleOverlay: () => Promise<OverlayRendererState>;
    minimizeOverlay: () => Promise<OverlayRendererState>;
    expandOverlay: () => Promise<OverlayRendererState>;
    closeOverlay: () => Promise<void>;
    getOverlayPreferences: () => Promise<OverlayRendererState>;
    setOverlayPreferences: (prefs: Partial<{ lowVisibility: boolean; opacity: number; autoHideEnabled: boolean; autoHideDelay: number; alwaysOnTop: boolean; activeTab: 'answer' | 'analysis' | 'summary' | 'action-items' | 'search' | 'history' }>) => Promise<OverlayRendererState>;
    getOverlayBounds: () => Promise<OverlayBounds>;
    setOverlayBounds: (bounds: OverlayBounds) => Promise<OverlayRendererState>;
    setOverlayAlwaysOnTop: (alwaysOnTop: boolean) => Promise<OverlayRendererState>;
    onOverlayState: (callback: (state: OverlayRendererState) => void) => () => void;
    publishMeetingOverlayState: (state: MeetingOverlayRuntimeState) => Promise<MeetingOverlayRuntimeState>;
    getMeetingOverlayState: () => Promise<MeetingOverlayRuntimeState>;
    onMeetingOverlayState: (callback: (state: MeetingOverlayRuntimeState) => void) => () => void;
    sendMeetingOverlayCommand: (command: MeetingOverlayCommand) => Promise<void>;
    onMeetingOverlayCommand: (callback: (command: MeetingOverlayCommand) => void) => () => void;
    reportMeetingOverlayCommandResult: (result: MeetingOverlayCommandResult) => Promise<void>;
    onMeetingOverlayCommandResult: (callback: (result: MeetingOverlayCommandResult) => void) => () => void;
    focusOverlayAnswer: () => Promise<OverlayRendererState>;
    captureScreen: () => Promise<string>;
    onScreenReadShortcut: (callback: () => void) => () => void;
    chooseDeveloperProject: () => Promise<{ canceled: boolean; projectRoot: string | null }>;
    discoverDeveloperProject: (projectName: string) => Promise<{ matches: string[]; projectRoot: string | null }>;
    getDeveloperProjectState: () => Promise<{ status: 'PROJECT_ATTACHED' | 'PROJECT_DETACHED' | 'PROJECT_MISSING' | 'PROJECT_NOT_ATTACHED' | 'PROJECT_STALE' | 'PROJECT_SESSION_RECONNECTING'; projectRoot: string | null; reason?: string | null }>;
    attachDeveloperProject: (projectRoot: string) => Promise<{ status: string; projectRoot: string | null; reason?: string | null }>;
    clearDeveloperProject: () => Promise<void>;
    listDeveloperDirectory: (relativePath?: string) => Promise<Array<{ name: string; type: 'file' | 'directory' }>>;
    readDeveloperFile: (relativePath: string) => Promise<{ path: string; content: string }>;
    searchDeveloperCode: (query: string, scope?: string) => Promise<{ query: string; scope?: string; results: Array<{ path: string; line: number; text: string; matchType: 'filename' | 'content' | 'scope-fallback' }>; filesVisited: number; truncated: boolean }>;
    buildDeveloperIndex: () => Promise<{ capabilities: { parser: string; typeResolution: boolean; guaranteedCallGraph: boolean; supportedExtensions: string[] }; files: string[]; cacheHits: number }>;
    searchDeveloperSymbols: (query: string) => Promise<Array<{ name: string; path: string; line: number; kind: string }>>;
    getDeveloperRepositoryMap: () => Promise<{ root: string; packageManager: string; languages: string[]; frameworks: string[]; entryPoints: string[]; sourceDirectories: string[]; testDirectories: string[]; configFiles: string[]; importantFiles: string[]; structure: Array<{ path: string; type: 'file' | 'directory' }> }>;
    findDeveloperReferences: (query: string) => Promise<Array<{ symbol: string; kind: string; file: string; line: number; relationship: 'definition' | 'reference' }>>;
    assembleDeveloperContext: (payload: { query: string; scope?: string; maxTokens?: number }) => Promise<{ tokenCount: number; budget: number; items: unknown[]; diversity: number; cached: boolean }>;
    executeDeveloperTool: (name: string, args: Record<string, unknown>, scope?: string) => Promise<{ ok: boolean; tool: string; data?: unknown; error?: string }>;
    runDeveloperVerification: (script: string) => Promise<{ ok: boolean; script: string; exitCode: number | null; stdout: string; stderr: string; durationMs: number; classification?: string; cancelled?: boolean }>;
    inspectDeveloperGit: (kind: 'status' | 'diff') => Promise<{ args: string[]; stdout: string; stderr: string }>;
    beginDeveloperConversation: (request: string, scope?: string) => Promise<{ turnId: string; state: string; projectRoot: string; scope: string; sessionId?: string }>;
    inspectDeveloperDatabase: (request: string, contextMessages?: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<{
      ok: boolean;
      handled: boolean;
      intents: string[];
      turnId?: string;
      data: {
        status: string;
        requestedFile: { path: string; role: string; confidence: number; preview: Array<{ line: number; text: string }> } | null;
        configFile: { path: string; role: string; confidence: number; preview: Array<{ line: number; text: string }> } | null;
        dependencies: string[];
        unresolvedDependencies: string[];
        unresolvedSymbols: string[];
        configuration: { engine: string | null; database: string | null; host: string | null; port: string | null; username: string | null; password: string | null; source: string };
        live: { status: string; reason: string };
        excludedCandidates: Array<{ path: string; role: string; confidence: number; databaseConfigEligible: boolean }>;
        report: string;
      } | null;
      error: { code: string; message: string } | null;
    }>;
    advanceDeveloperConversation: (update: { turnId: string; state: 'understanding' | 'completed' | 'failed' | 'cancelled'; phase?: string; fileCount?: number }) => Promise<{ turnId: string; state: string; updatedAt: string }>;
    createDeveloperProposal: (raw: string, snapshots: Array<{ path: string; hash: string }>, verificationScript?: string | null, scope?: string, conversationTurnId?: string | null) => Promise<{ id: string; state: string; lifecycleState?: string; files: Array<{ path: string; hash: string }>; runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null; }>;
    approveDeveloperProposal: (id: string) => Promise<{ id: string; state: string; lifecycleState?: string; runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null; }>;
    rejectDeveloperProposal: (id: string) => Promise<{ id: string; state: string; lifecycleState?: string; runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null; }>;
    applyDeveloperProposal: (id: string) => Promise<{
      id: string;
      state: string;
      lifecycleState?: string;
      runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null;
      verification?: {
        status?: string;
        classification?: string;
        reason?: string;
        attempts?: Array<{ check?: string; ok?: boolean; classification?: string; extracted?: { file?: string | null; line?: number | null; message?: string } }>;
      } | null;
      outcome?: string | null;
      error?: string | null;
    }>;
    undoDeveloperProposal: (id: string) => Promise<{ id: string; state: string; lifecycleState?: string; runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null; }>;
    getDeveloperProposal: (id: string) => Promise<{ id: string; state: string; lifecycleState?: string; runtime?: { phase?: string; taskState?: string; planVersion?: number; metrics?: Record<string, unknown>; history?: Array<{ phase?: string; message?: string }> } | null; }>;
    getDeveloperSession: () => Promise<{ sessionId: string }>;
    resumeDeveloperSession: (sessionId: string) => Promise<{ sessionId: string }>;
    cancelDeveloperTask: () => Promise<void>;
    pauseDeveloperTask?: (taskId: string) => Promise<Record<string, unknown>>;
    resumeDeveloperTask?: (taskId: string, targetPhase?: string) => Promise<Record<string, unknown>>;
    steerDeveloperTask?: (taskId: string, payload: { action: string; direction?: string; newGoal?: string }) => Promise<Record<string, unknown>>;
    listDeveloperSkills?: () => Promise<Array<Record<string, unknown>>>;
    assignDeveloperTaskSkill?: (taskId: string, skillId: string) => Promise<Record<string, unknown>>;
    setDeveloperTaskMode?: (taskId: string, mode: string, complexity?: string) => Promise<Record<string, unknown>>;
    listDeveloperMcpTools?: () => Promise<Array<Record<string, unknown>>>;
    invokeDeveloperTaskMcpTool?: (taskId: string, toolName: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    saveDeveloperTaskCheckpointDisk?: (taskId: string, filePath: string, milestone?: string) => Promise<Record<string, unknown>>;
    restoreDeveloperTaskCheckpointDisk?: (filePath: string) => Promise<Record<string, unknown>>;
    validateDeveloperTaskContextFreshness?: (taskId: string, targetSnapshots: Array<{ path: string; hash: string }>) => Promise<{ fresh: boolean; staleFiles: string[] }>;
    refuteDeveloperTaskHypothesis?: (taskId: string, text: string, evidence?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    rollbackDeveloperMultiRepo?: (taskId: string) => Promise<{ ok: boolean; rolledBackRepos: string[]; errors: string[] }>;
    getDeveloperTaskHeartbeat?: (taskId: string) => Promise<Record<string, unknown>>;
    disconnectDeveloperTask?: (taskId: string, clientId?: string) => Promise<Record<string, unknown>>;
    reconnectDeveloperTask?: (taskId: string, clientId?: string) => Promise<Record<string, unknown>>;
    replayDeveloperTaskEvents?: (taskId: string) => Promise<Record<string, unknown>>;
    cancelDeveloperTaskWorker?: (taskId: string, workerId: string, reason?: string) => Promise<Record<string, unknown>>;
    captureDeveloperWorktreeBaseline?: (taskId: string, repoRoot: string, files?: string[]) => Promise<Record<string, unknown>>;
    verifyDeveloperWorktreePreserved?: (taskId: string, agentFiles?: string[]) => Promise<{ ok: boolean; preservedCount: number; violations: Array<Record<string, unknown>> }>;
    defineDeveloperHiddenContract?: (taskId: string, contract: Record<string, unknown>) => Promise<boolean>;
    evaluateDeveloperCorrectness?: (taskId: string, patchPayload?: Record<string, unknown>, workspaceContext?: Record<string, unknown>) => Promise<{
      hasHiddenContract: boolean;
      passed: boolean;
      behavioralCorrectness: boolean;
      hiddenTestsPassed: number;
      hiddenTestsTotal: number;
      hiddenTestPassRate: number;
      regressionPassed: boolean;
      securityPassed: boolean;
      violations: string[];
    }>;
    evaluateDeveloperPatchQuality?: (diffText: string, modifiedFiles?: string[], targetScope?: string[]) => Promise<{
      passed: boolean;
      score: number;
      minimalityRatio: number;
      filesChanged: number;
      linesAdded: number;
      linesRemoved: number;
      totalLinesChanged: number;
      unrelatedFiles: string[];
      unnecessaryChanges: string[];
      penalties: Array<Record<string, unknown>>;
    }>;
    reviewDeveloperDiffIndependent?: (diffText: string, taskGoal?: string, modifiedFiles?: string[]) => Promise<{
      whatChanged: string[];
      why: string;
      risks: string[];
      whatIsMissing: string[];
      whatIsUnnecessary: string[];
      disagreementDetected: boolean;
      approved: boolean;
      recommendation?: string;
    }>;
    diagnoseDeveloperDefect?: (errorOutput: string, exitCode?: number, environmentState?: Record<string, unknown>) => Promise<{
      classification: string;
      isCodeDefect: boolean;
      isEnvironmentIssue: boolean;
      reason: string;
      recommendedAction: string;
    }>;
    inspectDeveloperEdgeCases?: (symbolInfo: Record<string, unknown>, preInterface?: Record<string, unknown>, postInterface?: Record<string, unknown>) => Promise<{
      edgeCases: Array<Record<string, unknown>>;
      contract: { preserved: boolean; breakingChanges: string[] };
    }>;
    verifyDeveloperTaskBlindness?: (taskId: string) => Promise<{ isClean: boolean; leakageCount: number; leaks: Array<Record<string, unknown>> }>;
    auditDeveloperOracleDiscovery?: (taskId: string) => Promise<{ accessBlocked: boolean; directAccessDetected: boolean; compromised: boolean }>;
    adjudicateDeveloperWorkerConflict?: (workerA: Record<string, unknown>, workerB: Record<string, unknown>, repositoryEvidence?: Record<string, unknown>) => Promise<{
      conflictDetected: boolean;
      adjudicated: boolean;
      winningWorkerId: string;
      winningTarget?: string;
      losingWorkerId?: string;
      scores: Record<string, number>;
      rationale: string;
    }>;
    classifyDeveloperRealityLevel?: (executionTrace: Record<string, unknown>) => Promise<{
      realityLevel: string;
      levelName: string;
      confidence: string;
      verifiedCapabilities: string[];
    }>;
    revalidateDeveloperBusinessTask?: (taskDef: Record<string, unknown>) => Promise<{
      taskId: string;
      status: string;
      businessVerified: boolean;
      visibleTestPassed: boolean;
      baselineFailedAsExpected?: boolean;
      mutationCaught?: boolean;
      regressionClean?: boolean;
      reason?: string;
      before?: unknown;
      after?: unknown;
    }>;
    redlineDeveloperBusinessClaim?: (claim: Record<string, unknown>) => Promise<{
      taskId: string;
      claimedStatus: string;
      claimedScore: number;
      actualStatus: string;
      isFalsePass: boolean;
      isMockOnly: boolean;
      isVerified: boolean;
      reason: string;
      before?: unknown;
      after?: unknown;
    }>;
    getGeneralSession: () => Promise<{ sessionId: string; taskIds: string[]; tasks: GeneralTaskState[] }>;
    createGeneralTask: (input: { goal: string; requirements?: string[]; constraints?: string[] }) => Promise<GeneralTaskState>;
    getGeneralTask: (taskId: string) => Promise<GeneralTaskState>;
    startGeneralTask: (taskId: string) => Promise<GeneralTaskState>;
    createGeneralBrowserSession: (taskId: string) => Promise<{ browserSessionId: string; task: GeneralTaskState }>;
    generalBrowserOperation: (taskId: string, operation: string, target?: Record<string, unknown> | string) => Promise<{ observation: Record<string, unknown>; task: GeneralTaskState }>;
    planGeneralExecutionAction: (taskId: string, input: {
      capability: string;
      provider: string;
      operation: string;
      target: string | Record<string, unknown>;
      arguments?: Record<string, unknown>;
      riskLevel?: string;
      requiresConfirmation?: boolean;
      expectedOutcome?: unknown;
      observationVersion?: number;
      browserSessionId?: string;
    }) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    getGeneralExecutionAction: (taskId: string, actionId: string) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    validateGeneralExecutionAction: (taskId: string, actionId: string) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    requestGeneralExecutionConfirmation: (taskId: string, actionId: string) => Promise<{ confirmation: Record<string, unknown>; task: GeneralTaskState }>;
    confirmGeneralExecutionAction: (taskId: string, actionId: string, confirmationId: string) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    executeGeneralExecutionAction: (taskId: string, actionId: string) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    observeGeneralExecutionAction: (taskId: string, actionId: string) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    verifyGeneralExecutionAction: (taskId: string, actionId: string, evidence?: Record<string, unknown>) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    recoverGeneralExecutionAction: (taskId: string, actionId: string, options?: Record<string, unknown>) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    cancelGeneralExecutionAction: (taskId: string, actionId: string, reason?: string) => Promise<{ action: GeneralExecutionAction; task: GeneralTaskState }>;
    replanGeneralTask: (taskId: string, input?: { message?: string; requirements?: string[]; constraints?: string[] }) => Promise<GeneralTaskState>;
    prepareGeneralDeveloperHandoff: (taskId: string) => Promise<{ handoff: Record<string, unknown>; task: GeneralTaskState }>;
    getGeneralCapabilities: () => Promise<Array<{
      name: string;
      description: string;
      allowedActions: string[];
      riskLevel: string;
      requiredPermissions: string[];
      requiredConfirmation: boolean;
      supportedProviders: string[];
      verificationStrategy: string;
      recoveryStrategy: string;
    }>>;
    stopGeneralTask: (taskId: string) => Promise<GeneralTaskState>;
    pauseGeneralTask: (taskId: string) => Promise<GeneralTaskState>;
    resumeGeneralTask: (taskId: string) => Promise<GeneralTaskState>;
    recoverGeneralTask: (taskId: string) => Promise<GeneralTaskState>;
    observeGeneralTask: (taskId: string, observation: { kind?: string; url?: string; text?: string; summary?: string }) => Promise<GeneralTaskState>;
    recordGeneralModelResponse: (taskId: string, input: { status?: 'COMPLETED' | 'PARTIAL' | 'ERROR'; content?: string; provider?: string; model?: string; requestId?: string; failureClassification?: string; category?: string; error?: string; contextMetrics?: Record<string, unknown> | null }) => Promise<GeneralTaskState>;
    prepareGeneralAction: (taskId: string, name: string, args?: Record<string, unknown>) => Promise<{ requiresConfirmation: boolean; loginRequired?: boolean; confirmation?: { confirmationId: string; taskId: string; sessionId: string; actionId: string; site: string | null; target: string; riskLevel: string; summary: string; expiresAt: string }; task: GeneralTaskState }>;
    beginGeneralAction: (taskId: string) => Promise<GeneralTaskState>;
    confirmGeneralAction: (taskId: string, confirmationId: string) => Promise<GeneralTaskState>;
    completeGeneralAction: (taskId: string, result: { ok?: boolean; status?: string }) => Promise<GeneralTaskState>;
    verifyGeneralAction: (taskId: string, evidence: { ok?: boolean; evidence?: string; text?: string; status?: string }) => Promise<GeneralTaskState>;
    markGeneralLoginRequired: (taskId: string, reason?: string) => Promise<{ requiresConfirmation: boolean; loginRequired: boolean; task: GeneralTaskState }>;
    setGeneralLoginStatus: (taskId: string, status: 'LOGIN_SUCCESS' | 'LOGIN_FAILED') => Promise<GeneralTaskState>;
    completeGeneralTask: (taskId: string, status: 'COMPLETED' | 'COMPLETED_WITH_LIMITATIONS', evidence: string) => Promise<GeneralTaskState>;
  };
}
