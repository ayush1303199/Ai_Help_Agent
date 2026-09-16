const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const developerFiles = require('./developerFiles.cjs');
const developerAgent = require('./developerAgent.cjs');
const developerIndex = require('./developerIndex.cjs');
const developerContext = require('./developerContext.cjs');
const developerBenchmark = require('./developerBenchmark.cjs');
const generalAgent = require('./generalAgent.cjs');

const isDev = !app.isPackaged;
let mainWindow = null;
let overlayWindow = null;
const developerIndexCaches = new Map();
const generalSessionRenderers = new Set();

function registerGeneralRenderer(event) {
  const ownerId = event.sender.id;
  if (generalSessionRenderers.has(ownerId)) return ownerId;
  generalSessionRenderers.add(ownerId);
  event.sender.once('destroyed', () => {
    generalAgent.releaseSession(ownerId);
    generalSessionRenderers.delete(ownerId);
  });
  return ownerId;
}

// Keep Chromium cache in a writable app-specific directory on Windows.
app.setPath('userData', path.join(app.getPath('temp'), 'ai-assistant-electron'));

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Windows uses this to exclude the AI window from supported screen capture APIs.
  window.setContentProtection(true);

  if (isDev) {
    window.loadURL(process.env.ELECTRON_DEV_URL || 'http://localhost:5174');
  } else {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) return { action: 'allow' };
    return { action: 'deny' };
  });

  return window;
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
    return;
  }

  const overlayCompositorOptions = process.platform === 'darwin'
    ? { vibrancy: 'hud' }
    : process.platform === 'win32'
      ? { backgroundMaterial: 'acrylic' }
      : {};

  overlayWindow = new BrowserWindow({
    width: 620,
    height: 420,
    minWidth: 320,
    minHeight: 180,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    ...overlayCompositorOptions,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const overlayUrl = isDev
    ? `${process.env.ELECTRON_DEV_URL || 'http://localhost:5174'}?overlay=1`
    : `file://${path.join(__dirname, '..', 'dist', 'index.html')}?overlay=1`;
  overlayWindow.loadURL(overlayUrl);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function toggleOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    return;
  }
  createOverlayWindow();
}

app.whenReady().then(async () => {
  developerAgent.configureDurability({
    journalFile: path.join(app.getPath('userData'), 'developer-task-journal.json'),
    auditFile: path.join(app.getPath('userData'), 'developer-audit.jsonl'),
  });
  try {
    await developerAgent.loadJournal();
  } catch (error) {
    console.error('[DEV][JOURNAL] startup reconciliation failed:', error);
  }
  ipcMain.handle('overlay:open', () => {
    createOverlayWindow();
  });
  ipcMain.handle('overlay:toggle', () => {
    toggleOverlayWindow();
  });
  ipcMain.handle('overlay:close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  });
  ipcMain.handle('developer:choose-project', (event) => {
    developerAgent.getSession(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    if (currentRoot) {
      developerIndexCaches.delete(currentRoot);
      developerContext.invalidateContextCache(currentRoot);
    }
    return developerFiles.chooseProjectFolder(dialog, event.sender.id);
  });
  ipcMain.handle('developer:clear-project', (event) => {
    developerAgent.getSession(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    if (currentRoot) {
      developerIndexCaches.delete(currentRoot);
      developerContext.invalidateContextCache(currentRoot);
    }
    developerFiles.clearProject(event.sender.id);
  });
  ipcMain.handle('developer:list-directory', (event, relativePath) => {
    developerAgent.getSession(event.sender.id);
    return developerFiles.listDirectory(relativePath, event.sender.id);
  });
  ipcMain.handle('developer:read-file', (event, relativePath) => {
    developerAgent.getSession(event.sender.id);
    return developerFiles.readFile(relativePath, event.sender.id);
  });
  ipcMain.handle('developer:search-code', (event, query) => {
    developerAgent.getSession(event.sender.id);
    return developerFiles.searchCode(query, event.sender.id);
  });
  const ownedDeveloperSession = (event) => {
    const sessionId = developerAgent.getSession(event.sender.id);
    return { sessionId, ownerWebContentsId: event.sender.id };
  };
  ipcMain.handle('developer:index', async (event) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return { capabilities: nextIndex.capabilities, files: Object.keys(nextIndex.files), cacheHits: nextIndex.cacheHits };
  });
  ipcMain.handle('developer:symbol-search', async (event, query) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return developerIndex.searchSymbols(nextIndex, query).slice(0, 100);
  });
  ipcMain.handle('developer:repository-map', async (event) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return developerIndex.buildRepositoryMap(currentRoot, nextIndex?.repositoryMap || null);
  });
  ipcMain.handle('developer:find-references', async (event, query) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return developerIndex.findReferences(nextIndex, String(query || '').trim()).slice(0, 100);
  });
  ipcMain.handle('developer:context', async (event, payload) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const query = payload?.query;
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const search = await developerFiles.searchCode(query, event.sender.id);
    const cached = currentRoot ? developerIndexCaches.get(currentRoot) || null : null;
    const nextIndex = currentRoot ? await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null) : null;
    if (currentRoot) developerIndexCaches.set(currentRoot, nextIndex);
    const symbols = nextIndex
      ? developerIndex.searchSymbols(nextIndex, query).slice(0, 50)
      : [];
    return developerContext.assembleContext({ root: currentRoot, query, results: [...search.results, ...symbols], maxTokens: payload?.maxTokens });
  });
  ipcMain.handle('developer:provider-discovery', (_event, providers) => developerBenchmark.discoverProviders(providers));
  ipcMain.handle('developer:run-verification', (event, script) => {
    ownedDeveloperSession(event);
    return developerFiles.runVerification(script, event.sender.id);
  });
  ipcMain.handle('developer:session', (event) => {
    event.sender.once('destroyed', () => {
      const currentRoot = developerFiles.getProjectRoot(event.sender.id);
      if (currentRoot) {
        developerIndexCaches.delete(currentRoot);
        developerContext.invalidateContextCache(currentRoot);
      }
      developerAgent.releaseSession(event.sender.id);
      developerFiles.releaseProject(event.sender.id);
    });
    return { sessionId: developerAgent.getSession(event.sender.id) };
  });
  ipcMain.handle('developer:session-resume', (event, sessionId) => ({ sessionId: developerAgent.resumeSession(event.sender.id, sessionId) }));
  ipcMain.handle('developer:git-inspect', (event, kind) => {
    ownedDeveloperSession(event);
    return developerFiles.runGit(kind === 'diff' ? ['diff', '--no-ext-diff'] : ['status', '--short'], event.sender.id);
  });
  ipcMain.handle('developer:proposal-create', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    return developerAgent.createProposal({
      root: developerFiles.getProjectRoot(event.sender.id), raw: payload?.raw, expectedSnapshots: payload?.snapshots,
      sessionId: owner.sessionId, ownerWebContentsId: owner.ownerWebContentsId,
      workspace: payload?.workspace,
      verificationScript: payload?.verificationScript || null,
    });
  });
  ipcMain.handle('developer:proposal-approve', (event, id) => developerAgent.approve(id, { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id }));
  ipcMain.handle('developer:proposal-apply', async (event, id) => {
    const owner = { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id };
    const task = developerAgent.getTaskForTest(id);
    if (!task) throw new Error('Unknown Developer task.');
    developerAgent.getTask(id, owner);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    const requestedScripts = task.verificationScripts?.length
      ? task.verificationScripts
      : task.verificationScript ? [task.verificationScript] : [];
    const verificationPlan = await developerFiles.getVerificationScripts(event.sender.id, requestedScripts);
    const verify = () => {
      if (verificationPlan.missing?.length) {
        return Promise.resolve({
          ok: false,
          status: 'COMMAND_NOT_AVAILABLE',
          classification: 'COMMAND_NOT_AVAILABLE',
          failure: 'missing_dependency',
          checks: verificationPlan.scripts,
          attempts: [],
          reason: verificationPlan.reason,
        });
      }
      return developerAgent.runVerificationChecks({
        checks: verificationPlan.scripts,
        isCancelled: () => developerAgent.isCancellationRequested(id, owner),
        onProgress: (progress) => {
          if (progress.check) console.log(`[DEV][VERIFY] task=${id} check=${progress.check}`);
        },
        runCheck: (script) => developerFiles.runVerification(script, event.sender.id, {
          isCancelled: () => developerAgent.isCancellationRequested(id, owner),
        }).catch((error) => ({
          ok: false,
          script,
          exitCode: null,
          stdout: '',
          stderr: error.message,
          error: error.message,
        })),
      }).then((result) => verificationPlan.reason && result.status === 'NOT_AVAILABLE'
        ? { ...result, reason: verificationPlan.reason }
        : result);
    };
    try {
      return await developerAgent.apply(id, owner, verify, currentRoot);
    } catch (error) {
      if (error.taskSnapshot) return error.taskSnapshot;
      throw error;
    }
  });
  ipcMain.handle('developer:proposal-undo', (event, id) => developerAgent.undo(id, { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id }));
  ipcMain.handle('developer:proposal-get', (event, id) => developerAgent.getTask(id, { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id }));
  ipcMain.handle('developer:proposal-cancel', (event) => developerAgent.cancelSession(event.sender.id));
  ipcMain.handle('general:session', (event) => {
    registerGeneralRenderer(event);
    return generalAgent.getPublicSession(event.sender.id);
  });
  ipcMain.handle('general:task-create', (event, input) => { registerGeneralRenderer(event); return generalAgent.createTask(event.sender.id, input || {}); });
  ipcMain.handle('general:task-get', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.getTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-start', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.startTask(taskId, event.sender.id); });
  ipcMain.handle('general:browser-session-create', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.createExecutionBrowserSession(taskId, event.sender.id); });
  ipcMain.handle('general:browser-operation', (event, taskId, operation, target) => { registerGeneralRenderer(event); return generalAgent.performBrowserOperation(taskId, event.sender.id, operation, target || {}); });
  ipcMain.handle('general:execution-plan', (event, taskId, input) => { registerGeneralRenderer(event); return generalAgent.planExecutionAction(taskId, event.sender.id, input || {}); });
  ipcMain.handle('general:execution-get', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.getExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-validate', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.validateExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-confirmation', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.requestExecutionConfirmation(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-confirm', (event, taskId, actionId, confirmationId) => { registerGeneralRenderer(event); return generalAgent.confirmExecutionAction(taskId, event.sender.id, actionId, confirmationId); });
  ipcMain.handle('general:execution-execute', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.executeExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-observe', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.observeExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-verify', (event, taskId, actionId, evidence) => { registerGeneralRenderer(event); return generalAgent.verifyExecutionAction(taskId, event.sender.id, actionId, evidence || {}); });
  ipcMain.handle('general:execution-recover', (event, taskId, actionId, options) => { registerGeneralRenderer(event); return generalAgent.recoverExecutionAction(taskId, event.sender.id, actionId, options || {}); });
  ipcMain.handle('general:execution-cancel', (event, taskId, actionId, reason) => { registerGeneralRenderer(event); return generalAgent.cancelExecutionAction(taskId, event.sender.id, actionId, reason); });
  ipcMain.handle('general:task-replan', (event, taskId, input) => { registerGeneralRenderer(event); return generalAgent.replanTask(taskId, event.sender.id, input || {}); });
  ipcMain.handle('general:task-handoff-developer', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.prepareDeveloperHandoff(taskId, event.sender.id); });
  ipcMain.handle('general:capabilities', () => generalAgent.getCapabilityCatalog());
  ipcMain.handle('general:task-stop', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.stopTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-pause', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.pauseTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-resume', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.resumeTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-recover', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.recoverTask(taskId, event.sender.id); });
  ipcMain.handle('general:observe', (event, taskId, observation) => { registerGeneralRenderer(event); return generalAgent.observe(taskId, event.sender.id, observation || {}); });
  ipcMain.handle('general:prepare-action', (event, taskId, name, args) => { registerGeneralRenderer(event); return generalAgent.prepareAction(taskId, event.sender.id, name, args || {}); });
  ipcMain.handle('general:begin-action', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.beginAction(taskId, event.sender.id); });
  ipcMain.handle('general:confirm-action', (event, taskId, confirmationId) => { registerGeneralRenderer(event); return generalAgent.confirmAction(taskId, event.sender.id, confirmationId); });
  ipcMain.handle('general:complete-action', (event, taskId, result) => { registerGeneralRenderer(event); return generalAgent.completeAction(taskId, event.sender.id, result || {}); });
  ipcMain.handle('general:verify-action', (event, taskId, evidence) => { registerGeneralRenderer(event); return generalAgent.verifyAction(taskId, event.sender.id, evidence || {}); });
  ipcMain.handle('general:login-required', (event, taskId, reason) => { registerGeneralRenderer(event); return generalAgent.requestLogin(taskId, event.sender.id, reason); });
  ipcMain.handle('general:login-status', (event, taskId, status) => { registerGeneralRenderer(event); return generalAgent.completeLogin(taskId, event.sender.id, status); });
  ipcMain.handle('general:task-complete', (event, taskId, status, evidence) => { registerGeneralRenderer(event); return generalAgent.finishTask(taskId, event.sender.id, status, evidence); });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ['media'].includes(permission);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (process.platform !== 'win32') {
      // Electron does not provide a general system-output loopback stream on
      // macOS/Linux. Those platforms require a supported virtual audio route.
      callback({});
      return;
    }

    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const source = sources[0];
    if (!source) {
      callback({});
      return;
    }

    // Chromium's Windows loopback captures the selected display/window output,
    // not the physical microphone. The renderer still discards the video track.
    callback({ video: source, audio: 'loopback' });
  });

  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
