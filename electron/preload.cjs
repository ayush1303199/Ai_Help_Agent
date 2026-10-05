const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openOverlay: () => ipcRenderer.invoke('overlay:open'),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  minimizeOverlay: () => ipcRenderer.invoke('overlay:minimize'),
  expandOverlay: () => ipcRenderer.invoke('overlay:expand'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  getOverlayPreferences: () => ipcRenderer.invoke('overlay:get-preferences'),
  setOverlayPreferences: (prefs) => ipcRenderer.invoke('overlay:set-preferences', prefs),
  onOverlayState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('overlay:state', listener);
    return () => ipcRenderer.removeListener('overlay:state', listener);
  },
  publishMeetingOverlayState: (state) => ipcRenderer.invoke('meeting-overlay:publish-state', state),
  getMeetingOverlayState: () => ipcRenderer.invoke('meeting-overlay:get-state'),
  onMeetingOverlayState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('meeting-overlay:state', listener);
    return () => ipcRenderer.removeListener('meeting-overlay:state', listener);
  },
  sendMeetingOverlayCommand: (command) => ipcRenderer.invoke('meeting-overlay:command', command),
  onMeetingOverlayCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('meeting-overlay:command', listener);
    return () => ipcRenderer.removeListener('meeting-overlay:command', listener);
  },
  reportMeetingOverlayCommandResult: (result) => ipcRenderer.invoke('meeting-overlay:command-result', result),
  onMeetingOverlayCommandResult: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('meeting-overlay:command-result', listener);
    return () => ipcRenderer.removeListener('meeting-overlay:command-result', listener);
  },
  getOverlayBounds: () => ipcRenderer.invoke('overlay:get-bounds'),
  setOverlayBounds: (bounds) => ipcRenderer.invoke('overlay:set-bounds', bounds),
  setOverlayAlwaysOnTop: (alwaysOnTop) => ipcRenderer.invoke('overlay:set-always-on-top', alwaysOnTop),
  focusOverlayAnswer: () => ipcRenderer.invoke('overlay:focus-answer'),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  onScreenReadShortcut: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('screen:read-shortcut', listener);
    return () => ipcRenderer.removeListener('screen:read-shortcut', listener);
  },
  chooseDeveloperProject: () => ipcRenderer.invoke('developer:choose-project'),
  discoverDeveloperProject: (projectName) => ipcRenderer.invoke('developer:discover-project', { projectName }),
  getDeveloperProjectState: () => ipcRenderer.invoke('developer:project-state'),
  attachDeveloperProject: (projectRoot) => ipcRenderer.invoke('developer:project-attach', { projectRoot }),
  clearDeveloperProject: () => ipcRenderer.invoke('developer:clear-project'),
  listDeveloperDirectory: (relativePath) => ipcRenderer.invoke('developer:list-directory', relativePath),
  readDeveloperFile: (relativePath) => ipcRenderer.invoke('developer:read-file', relativePath),
  searchDeveloperCode: (query, scope = '.') => ipcRenderer.invoke('developer:search-code', { query, scope }),
  buildDeveloperIndex: () => ipcRenderer.invoke('developer:index'),
  searchDeveloperSymbols: (query) => ipcRenderer.invoke('developer:symbol-search', query),
  getDeveloperRepositoryMap: () => ipcRenderer.invoke('developer:repository-map'),
  findDeveloperReferences: (query) => ipcRenderer.invoke('developer:find-references', query),
  assembleDeveloperContext: (payload) => ipcRenderer.invoke('developer:context', {
    query: String(payload?.query || '').slice(0, 200),
    scope: String(payload?.scope || '.'),
    maxTokens: Math.max(64, Math.min(Number(payload?.maxTokens) || 4000, 12000)),
  }),
  executeDeveloperTool: (name, args, scope = '.') => ipcRenderer.invoke('developer:tool', { name, args, scope }),
  runDeveloperVerification: (script) => ipcRenderer.invoke('developer:run-verification', script),
  inspectDeveloperGit: (kind) => ipcRenderer.invoke('developer:git-inspect', kind),
  beginDeveloperConversation: (request, scope = '.') => ipcRenderer.invoke('developer:conversation-start', { request, scope }),
  inspectDeveloperDatabase: (request, contextMessages = []) => ipcRenderer.invoke('developer:database-inspect', { request, contextMessages }),
  advanceDeveloperConversation: (update) => ipcRenderer.invoke('developer:conversation-update', update),
  createDeveloperProposal: (raw, snapshots, verificationScript = null, scope = '.', conversationTurnId = null) => ipcRenderer.invoke('developer:proposal-create', { raw, snapshots, verificationScript, scope, conversationTurnId }),
  approveDeveloperProposal: (id) => ipcRenderer.invoke('developer:proposal-approve', id),
  rejectDeveloperProposal: (id) => ipcRenderer.invoke('developer:proposal-reject', id),
  applyDeveloperProposal: (id) => ipcRenderer.invoke('developer:proposal-apply', id),
  undoDeveloperProposal: (id) => ipcRenderer.invoke('developer:proposal-undo', id),
  getDeveloperProposal: (id) => ipcRenderer.invoke('developer:proposal-get', id),
  getDeveloperSession: () => ipcRenderer.invoke('developer:session'),
  resumeDeveloperSession: (sessionId) => ipcRenderer.invoke('developer:session-resume', sessionId),
  cancelDeveloperTask: () => ipcRenderer.invoke('developer:proposal-cancel'),
  pauseDeveloperTask: (taskId) => ipcRenderer.invoke('developer:task-pause', taskId),
  resumeDeveloperTask: (taskId, targetPhase) => ipcRenderer.invoke('developer:task-resume', { taskId, targetPhase }),
  steerDeveloperTask: (taskId, payload) => ipcRenderer.invoke('developer:task-steer', { taskId, ...payload }),
  saveDeveloperTaskCheckpoint: (taskId, milestone) => ipcRenderer.invoke('developer:task-checkpoint-save', { taskId, milestone }),
  restoreDeveloperTaskCheckpoint: (taskId, checkpointId) => ipcRenderer.invoke('developer:task-checkpoint-restore', { taskId, checkpointId }),
  getDeveloperTaskArtifacts: (taskId) => ipcRenderer.invoke('developer:task-artifacts', taskId),
  verifyDeveloperBrowser: (taskId, options) => ipcRenderer.invoke('developer:task-browser-verify', { taskId, options }),
  manageDeveloperServer: (taskId, action, projectRoot) => ipcRenderer.invoke('developer:dev-server-manage', { taskId, action, projectRoot }),
  listDeveloperSkills: () => ipcRenderer.invoke('developer:skills-list'),
  assignDeveloperTaskSkill: (taskId, skillId) => ipcRenderer.invoke('developer:task-skill-assign', { taskId, skillId }),
  setDeveloperTaskMode: (taskId, mode, complexity) => ipcRenderer.invoke('developer:task-mode-set', { taskId, mode, complexity }),
  listDeveloperMcpTools: () => ipcRenderer.invoke('developer:mcp-tools-list'),
  invokeDeveloperTaskMcpTool: (taskId, toolName, params) => ipcRenderer.invoke('developer:task-mcp-invoke', { taskId, toolName, params }),
  saveDeveloperTaskCheckpointDisk: (taskId, filePath, milestone) => ipcRenderer.invoke('developer:task-checkpoint-save-disk', { taskId, filePath, milestone }),
  restoreDeveloperTaskCheckpointDisk: (filePath) => ipcRenderer.invoke('developer:task-checkpoint-restore-disk', { filePath }),
  validateDeveloperTaskContextFreshness: (taskId, targetSnapshots) => ipcRenderer.invoke('developer:task-context-freshness', { taskId, targetSnapshots }),
  refuteDeveloperTaskHypothesis: (taskId, text, evidence) => ipcRenderer.invoke('developer:task-hypothesis-refute', { taskId, text, evidence }),
  rollbackDeveloperMultiRepo: (taskId) => ipcRenderer.invoke('developer:task-multi-repo-rollback', { taskId }),
  getDeveloperTaskHeartbeat: (taskId) => ipcRenderer.invoke('developer:task-heartbeat', taskId),
  disconnectDeveloperTask: (taskId, clientId) => ipcRenderer.invoke('developer:task-disconnect', { taskId, clientId }),
  reconnectDeveloperTask: (taskId, clientId) => ipcRenderer.invoke('developer:task-reconnect', { taskId, clientId }),
  replayDeveloperTaskEvents: (taskId) => ipcRenderer.invoke('developer:task-replay', taskId),
  cancelDeveloperTaskWorker: (taskId, workerId, reason) => ipcRenderer.invoke('developer:task-worker-cancel', { taskId, workerId, reason }),
  captureDeveloperWorktreeBaseline: (taskId, repoRoot, files) => ipcRenderer.invoke('developer:worktree-baseline-capture', { taskId, repoRoot, files }),
  verifyDeveloperWorktreePreserved: (taskId, agentFiles) => ipcRenderer.invoke('developer:worktree-preserve-verify', { taskId, agentFiles }),
  defineDeveloperHiddenContract: (taskId, contract) => ipcRenderer.invoke('developer:task-hidden-contract-define', { taskId, contract }),
  evaluateDeveloperCorrectness: (taskId, patchPayload, workspaceContext) => ipcRenderer.invoke('developer:task-correctness-evaluate', { taskId, patchPayload, workspaceContext }),
  evaluateDeveloperPatchQuality: (diffText, modifiedFiles, targetScope) => ipcRenderer.invoke('developer:task-patch-quality-evaluate', { diffText, modifiedFiles, targetScope }),
  reviewDeveloperDiffIndependent: (diffText, taskGoal, modifiedFiles) => ipcRenderer.invoke('developer:task-diff-review-independent', { diffText, taskGoal, modifiedFiles }),
  diagnoseDeveloperDefect: (errorOutput, exitCode, environmentState) => ipcRenderer.invoke('developer:task-defect-diagnose', { errorOutput, exitCode, environmentState }),
  inspectDeveloperEdgeCases: (symbolInfo, preInterface, postInterface) => ipcRenderer.invoke('developer:task-edge-cases-inspect', { symbolInfo, preInterface, postInterface }),
  verifyDeveloperTaskBlindness: (taskId) => ipcRenderer.invoke('developer:task-blindness-verify', taskId),
  auditDeveloperOracleDiscovery: (taskId) => ipcRenderer.invoke('developer:task-oracle-discovery-audit', taskId),
  adjudicateDeveloperWorkerConflict: (workerA, workerB, repositoryEvidence) => ipcRenderer.invoke('developer:task-worker-conflict-adjudicate', { workerA, workerB, repositoryEvidence }),
  classifyDeveloperRealityLevel: (executionTrace) => ipcRenderer.invoke('developer:task-reality-level-classify', { executionTrace }),
  revalidateDeveloperBusinessTask: (taskDef) => ipcRenderer.invoke('developer:business-task-revalidate', { taskDef }),
  redlineDeveloperBusinessClaim: (claim) => ipcRenderer.invoke('developer:business-claim-redline', { claim }),
  getGeneralSession: () => ipcRenderer.invoke('general:session'),
  createGeneralTask: (input) => ipcRenderer.invoke('general:task-create', input),
  getGeneralTask: (taskId) => ipcRenderer.invoke('general:task-get', taskId),
  startGeneralTask: (taskId) => ipcRenderer.invoke('general:task-start', taskId),
  createGeneralBrowserSession: (taskId) => ipcRenderer.invoke('general:browser-session-create', taskId),
  generalBrowserOperation: (taskId, operation, target) => ipcRenderer.invoke('general:browser-operation', taskId, operation, target),
  planGeneralExecutionAction: (taskId, input) => ipcRenderer.invoke('general:execution-plan', taskId, input),
  getGeneralExecutionAction: (taskId, actionId) => ipcRenderer.invoke('general:execution-get', taskId, actionId),
  validateGeneralExecutionAction: (taskId, actionId) => ipcRenderer.invoke('general:execution-validate', taskId, actionId),
  requestGeneralExecutionConfirmation: (taskId, actionId) => ipcRenderer.invoke('general:execution-confirmation', taskId, actionId),
  confirmGeneralExecutionAction: (taskId, actionId, confirmationId) => ipcRenderer.invoke('general:execution-confirm', taskId, actionId, confirmationId),
  executeGeneralExecutionAction: (taskId, actionId) => ipcRenderer.invoke('general:execution-execute', taskId, actionId),
  observeGeneralExecutionAction: (taskId, actionId) => ipcRenderer.invoke('general:execution-observe', taskId, actionId),
  verifyGeneralExecutionAction: (taskId, actionId, evidence) => ipcRenderer.invoke('general:execution-verify', taskId, actionId, evidence),
  recoverGeneralExecutionAction: (taskId, actionId, options) => ipcRenderer.invoke('general:execution-recover', taskId, actionId, options),
  cancelGeneralExecutionAction: (taskId, actionId, reason) => ipcRenderer.invoke('general:execution-cancel', taskId, actionId, reason),
  replanGeneralTask: (taskId, input) => ipcRenderer.invoke('general:task-replan', taskId, input),
  prepareGeneralDeveloperHandoff: (taskId) => ipcRenderer.invoke('general:task-handoff-developer', taskId),
  getGeneralCapabilities: () => ipcRenderer.invoke('general:capabilities'),
  stopGeneralTask: (taskId) => ipcRenderer.invoke('general:task-stop', taskId),
  pauseGeneralTask: (taskId) => ipcRenderer.invoke('general:task-pause', taskId),
  resumeGeneralTask: (taskId) => ipcRenderer.invoke('general:task-resume', taskId),
  recoverGeneralTask: (taskId) => ipcRenderer.invoke('general:task-recover', taskId),
  observeGeneralTask: (taskId, observation) => ipcRenderer.invoke('general:observe', taskId, observation),
  recordGeneralModelResponse: (taskId, input) => ipcRenderer.invoke('general:model-response', taskId, input),
  prepareGeneralAction: (taskId, name, args) => ipcRenderer.invoke('general:prepare-action', taskId, name, args),
  beginGeneralAction: (taskId) => ipcRenderer.invoke('general:begin-action', taskId),
  confirmGeneralAction: (taskId, confirmationId) => ipcRenderer.invoke('general:confirm-action', taskId, confirmationId),
  completeGeneralAction: (taskId, result) => ipcRenderer.invoke('general:complete-action', taskId, result),
  verifyGeneralAction: (taskId, evidence) => ipcRenderer.invoke('general:verify-action', taskId, evidence),
  markGeneralLoginRequired: (taskId, reason) => ipcRenderer.invoke('general:login-required', taskId, reason),
  setGeneralLoginStatus: (taskId, status) => ipcRenderer.invoke('general:login-status', taskId, status),
  completeGeneralTask: (taskId, status, evidence) => ipcRenderer.invoke('general:task-complete', taskId, status, evidence),
});
