const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog, globalShortcut, screen } = require('electron');
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

const OVERLAY_STATE_PATH = path.join(app.getPath('userData'), 'overlay-state.json');
const OVERLAY_VISIBILITY_VALUES = new Set(['VISIBLE', 'MINIMIZED', 'HIDDEN']);
const OVERLAY_TAB_VALUES = new Set(['answer', 'analysis', 'summary', 'action-items']);
const OVERLAY_PREFERENCE_KEYS = new Set(['lowVisibility', 'autoHideEnabled', 'autoHideDelay', 'alwaysOnTop', 'activeTab']);
const OVERLAY_MIN_WIDTH = 320;
const OVERLAY_MIN_HEIGHT = 180;
const OVERLAY_DEFAULT_WIDTH = 620;
const OVERLAY_DEFAULT_HEIGHT = 420;
const OVERLAY_MINI_WIDTH = 320;
const OVERLAY_MINI_HEIGHT = 128;
const defaultOverlayState = {
  visibility: 'VISIBLE',
  lowVisibility: false,
  autoHideEnabled: true,
  autoHideDelay: 5000,
  alwaysOnTop: true,
  activeTab: 'answer',
  bounds: { x: 0, y: 0, width: OVERLAY_DEFAULT_WIDTH, height: OVERLAY_DEFAULT_HEIGHT },
  expandedBounds: { x: 0, y: 0, width: OVERLAY_DEFAULT_WIDTH, height: OVERLAY_DEFAULT_HEIGHT },
};
let overlayState = { ...defaultOverlayState };
const overlayShortcutMap = new Map();
let overlayBoundsPersistTimer = null;
let overlayWriteSequence = 0;
let overlayWriteQueue = Promise.resolve();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function getDefaultOverlayBounds() {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = OVERLAY_DEFAULT_WIDTH;
  const height = OVERLAY_DEFAULT_HEIGHT;
  const x = clampNumber(workArea.x + Math.max(16, (workArea.width - width) / 2), workArea.x + 16, Math.max(workArea.x + 16, workArea.x + workArea.width - width - 16));
  const y = clampNumber(workArea.y + Math.max(16, (workArea.height - height) / 2), workArea.y + 16, Math.max(workArea.y + 16, workArea.y + workArea.height - height - 16));
  return { x, y, width, height };
}

function getNormalizedOverlayBounds(rawBounds = {}) {
  const fallback = getDefaultOverlayBounds();
  const source = isPlainObject(rawBounds) ? rawBounds : {};
  const rawX = Number.isFinite(source.x) ? source.x : fallback.x;
  const rawY = Number.isFinite(source.y) ? source.y : fallback.y;
  const display = screen.getDisplayNearestPoint({ x: rawX, y: rawY }) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = clampNumber(Number.isFinite(source.width) ? source.width : fallback.width, OVERLAY_MIN_WIDTH, Math.max(OVERLAY_MIN_WIDTH, workArea.width - 48));
  const height = clampNumber(Number.isFinite(source.height) ? source.height : fallback.height, OVERLAY_MIN_HEIGHT, Math.max(OVERLAY_MIN_HEIGHT, workArea.height - 48));
  const maxX = Math.max(workArea.x + 16, workArea.x + workArea.width - width - 16);
  const maxY = Math.max(workArea.y + 16, workArea.y + workArea.height - height - 16);
  const x = clampNumber(rawX, workArea.x + 16, maxX);
  const y = clampNumber(rawY, workArea.y + 16, maxY);
  return { x, y, width, height };
}

function getCompactOverlayBounds(bounds) {
  const safeBounds = getNormalizedOverlayBounds(bounds);
  return {
    ...safeBounds,
    width: Math.min(safeBounds.width, OVERLAY_MINI_WIDTH),
    height: Math.min(safeBounds.height, OVERLAY_MINI_HEIGHT),
  };
}

function normalizeOverlayState(rawState = {}) {
  const source = isPlainObject(rawState) ? rawState : {};
  const expandedBounds = getNormalizedOverlayBounds(
    isPlainObject(source.expandedBounds) ? source.expandedBounds : source.bounds,
  );
  const visibility = OVERLAY_VISIBILITY_VALUES.has(source.visibility)
    ? source.visibility
    : defaultOverlayState.visibility;
  const nextBounds = getNormalizedOverlayBounds(
    isPlainObject(source.bounds)
      ? source.bounds
      : visibility === 'MINIMIZED'
        ? getCompactOverlayBounds(expandedBounds)
        : expandedBounds,
  );
  const nextState = {
    ...defaultOverlayState,
    visibility,
    lowVisibility: typeof source.lowVisibility === 'boolean' ? source.lowVisibility : defaultOverlayState.lowVisibility,
    autoHideEnabled: typeof source.autoHideEnabled === 'boolean' ? source.autoHideEnabled : defaultOverlayState.autoHideEnabled,
    autoHideDelay: clampNumber(
      Number.isFinite(source.autoHideDelay) ? source.autoHideDelay : defaultOverlayState.autoHideDelay,
      500,
      60000,
    ),
    alwaysOnTop: typeof source.alwaysOnTop === 'boolean' ? source.alwaysOnTop : defaultOverlayState.alwaysOnTop,
    activeTab: OVERLAY_TAB_VALUES.has(source.activeTab) ? source.activeTab : defaultOverlayState.activeTab,
    bounds: nextBounds,
    expandedBounds,
  };
  return nextState;
}

function validateOverlayPreferences(prefs) {
  assertPlainObject(prefs, 'Overlay preferences');
  for (const key of Object.keys(prefs)) {
    if (!OVERLAY_PREFERENCE_KEYS.has(key)) {
      throw new TypeError(`Unsupported overlay preference: ${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'lowVisibility') && typeof prefs.lowVisibility !== 'boolean') {
    throw new TypeError('lowVisibility must be a boolean.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'autoHideEnabled') && typeof prefs.autoHideEnabled !== 'boolean') {
    throw new TypeError('autoHideEnabled must be a boolean.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'autoHideDelay')
    && (!Number.isFinite(prefs.autoHideDelay) || typeof prefs.autoHideDelay !== 'number')) {
    throw new TypeError('autoHideDelay must be a finite number.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'alwaysOnTop') && typeof prefs.alwaysOnTop !== 'boolean') {
    throw new TypeError('alwaysOnTop must be a boolean.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'activeTab') && !OVERLAY_TAB_VALUES.has(prefs.activeTab)) {
    throw new TypeError('activeTab is not supported.');
  }
  return prefs;
}

function validateOverlayBounds(bounds) {
  assertPlainObject(bounds, 'Overlay bounds');
  const expectedKeys = ['x', 'y', 'width', 'height'];
  if (Object.keys(bounds).some((key) => !expectedKeys.includes(key))) {
    throw new TypeError('Overlay bounds contain unsupported keys.');
  }
  for (const key of expectedKeys) {
    if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key])) {
      throw new TypeError(`Overlay bounds.${key} must be a finite number.`);
    }
  }
  return bounds;
}

async function readOverlayState() {
  try {
    const raw = await fs.readFile(OVERLAY_STATE_PATH, 'utf8');
    if (!raw.trim()) return normalizeOverlayState({ bounds: getDefaultOverlayBounds(), expandedBounds: getDefaultOverlayBounds() });
    const parsed = JSON.parse(raw);
    return normalizeOverlayState(parsed);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[OVERLAY] state read failed:', error);
    }
    const bounds = getDefaultOverlayBounds();
    return normalizeOverlayState({ bounds, expandedBounds: bounds });
  }
}

function getOverlayStateForRenderer() {
  return {
    ...overlayState,
    bounds: { ...overlayState.bounds },
    expandedBounds: { ...overlayState.expandedBounds },
  };
}

function publishOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.webContents.isDestroyed()) return;
  overlayWindow.webContents.send('overlay:state', getOverlayStateForRenderer());
}

async function persistOverlayState(nextState) {
  const safeState = normalizeOverlayState(nextState);
  overlayState = safeState;
  publishOverlayState();
  const writePath = `${OVERLAY_STATE_PATH}.${process.pid}.${overlayWriteSequence += 1}.tmp`;
  overlayWriteQueue = overlayWriteQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await fs.mkdir(path.dirname(OVERLAY_STATE_PATH), { recursive: true });
        await fs.writeFile(writePath, JSON.stringify(safeState, null, 2), 'utf8');
        try {
          await fs.rename(writePath, OVERLAY_STATE_PATH);
        } catch (error) {
          if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
          await fs.rm(OVERLAY_STATE_PATH, { force: true });
          await fs.rename(writePath, OVERLAY_STATE_PATH);
        }
      } catch (error) {
        console.warn('[OVERLAY] state write failed:', error);
        await fs.rm(writePath, { force: true }).catch(() => undefined);
      }
    });
  await overlayWriteQueue;
  return safeState;
}

function applyOverlayWindowState(nextState = overlayState, { reveal = false, focus = false } = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return nextState;
  const safeState = normalizeOverlayState(nextState);
  overlayWindow.setAlwaysOnTop(Boolean(safeState.alwaysOnTop));
  const bounds = safeState.visibility === 'MINIMIZED'
    ? getCompactOverlayBounds(safeState.bounds)
    : getNormalizedOverlayBounds(safeState.bounds);
  overlayWindow.setBounds(bounds, true);
  if (reveal && safeState.visibility === 'HIDDEN') {
    overlayWindow.hide();
  } else if (reveal) {
    if (overlayWindow.isMinimized()) overlayWindow.restore();
    overlayWindow.show();
    if (focus) overlayWindow.focus();
  }
  overlayState = safeState;
  publishOverlayState();
  return safeState;
}

function updateOverlayBoundsFromWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const nextBounds = getNormalizedOverlayBounds(overlayWindow.getBounds());
  const nextState = overlayState.visibility === 'MINIMIZED'
    ? normalizeOverlayState({ ...overlayState, bounds: nextBounds })
    : normalizeOverlayState({ ...overlayState, bounds: nextBounds, expandedBounds: nextBounds });
  overlayState = nextState;
  publishOverlayState();
  if (overlayBoundsPersistTimer) clearTimeout(overlayBoundsPersistTimer);
  overlayBoundsPersistTimer = setTimeout(() => {
    overlayBoundsPersistTimer = null;
    void persistOverlayState(overlayState);
  }, 100);
}

async function showOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    await createOverlayWindow();
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) return overlayState;
  const expandedBounds = getNormalizedOverlayBounds(
    overlayState.visibility === 'MINIMIZED' ? overlayState.expandedBounds : overlayState.bounds,
  );
  const nextState = normalizeOverlayState({
    ...overlayState,
    visibility: 'VISIBLE',
    lowVisibility: false,
    bounds: expandedBounds,
    expandedBounds,
  });
  await persistOverlayState(nextState);
  applyOverlayWindowState(nextState, { reveal: true, focus: true });
  return nextState;
}

async function hideOverlayWindow() {
  const nextState = normalizeOverlayState({ ...overlayState, visibility: 'HIDDEN', lowVisibility: true });
  await persistOverlayState(nextState);
  applyOverlayWindowState(nextState, { reveal: true });
  return nextState;
}

async function toggleOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return showOverlayWindow();
  }
  if (overlayState.visibility === 'HIDDEN') {
    return showOverlayWindow();
  }
  if (overlayState.visibility === 'MINIMIZED') {
    const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds);
    const expandedState = normalizeOverlayState({
      ...overlayState,
      visibility: 'VISIBLE',
      lowVisibility: false,
      bounds: expandedBounds,
      expandedBounds,
    });
    await persistOverlayState(expandedState);
    applyOverlayWindowState(expandedState, { reveal: true, focus: true });
    return expandedState;
  }
  return hideOverlayWindow();
}

async function minimizeOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return overlayState;
  const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
  const compactBounds = getCompactOverlayBounds(expandedBounds);
  const nextState = normalizeOverlayState({
    ...overlayState,
    visibility: 'MINIMIZED',
    lowVisibility: true,
    bounds: compactBounds,
    expandedBounds,
  });
  await persistOverlayState(nextState);
  applyOverlayWindowState(nextState, { reveal: true, focus: true });
  return nextState;
}

async function expandOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
    const nextState = normalizeOverlayState({
      ...overlayState,
      visibility: 'VISIBLE',
      lowVisibility: false,
      bounds: expandedBounds,
      expandedBounds,
    });
    await persistOverlayState(nextState);
    return showOverlayWindow();
  }
  const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
  const nextState = normalizeOverlayState({
    ...overlayState,
    visibility: 'VISIBLE',
    lowVisibility: false,
    bounds: expandedBounds,
    expandedBounds,
  });
  await persistOverlayState(nextState);
  applyOverlayWindowState(nextState, { reveal: true, focus: true });
  return nextState;
}

async function setOverlayPreferences(prefs = {}) {
  validateOverlayPreferences(prefs);
  const nextState = normalizeOverlayState({ ...overlayState, ...prefs });
  await persistOverlayState(nextState);
  // Preference and opacity changes must not reveal or focus the overlay.
  applyOverlayWindowState(nextState);
  return nextState;
}

async function setOverlayBounds(bounds = overlayState.bounds) {
  validateOverlayBounds(bounds);
  const nextBounds = getNormalizedOverlayBounds(bounds);
  const nextState = normalizeOverlayState({
    ...overlayState,
    bounds: overlayState.visibility === 'MINIMIZED' ? getCompactOverlayBounds(nextBounds) : nextBounds,
    expandedBounds: nextBounds,
  });
  await persistOverlayState(nextState);
  applyOverlayWindowState(nextState);
  return nextState;
}

async function setOverlayAlwaysOnTop(alwaysOnTop) {
  return setOverlayPreferences({ alwaysOnTop });
}

function registerOverlayShortcuts() {
  const keyHandlers = [
    { key: 'CommandOrControl+Shift+Space', action: async () => { const visible = overlayState.visibility === 'VISIBLE'; const hidden = overlayState.visibility === 'HIDDEN'; const next = hidden ? 'VISIBLE' : visible ? 'HIDDEN' : 'VISIBLE'; if (!overlayWindow || overlayWindow.isDestroyed()) { await showOverlayWindow(); return; } if (next === 'VISIBLE') { await showOverlayWindow(); } else { await hideOverlayWindow(); } } },
    { key: 'CommandOrControl+Shift+M', action: async () => { if (!overlayWindow || overlayWindow.isDestroyed()) { await showOverlayWindow(); return; } if (overlayState.visibility === 'MINIMIZED') { await expandOverlayWindow(); } else { await minimizeOverlayWindow(); } } },
    { key: 'CommandOrControl+Shift+A', action: async () => { if (!overlayWindow || overlayWindow.isDestroyed()) { await showOverlayWindow(); return; } await showOverlayWindow(); if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.focus(); } } },
  ];

  keyHandlers.forEach(({ key, action }) => {
    try {
      if (globalShortcut.isRegistered(key)) {
        console.warn(`[OVERLAY] shortcut unavailable (already registered): ${key}`);
        return;
      }
      const registered = globalShortcut.register(key, () => { void action(); });
      if (registered) {
        overlayShortcutMap.set(key, action);
      } else {
        console.warn(`[OVERLAY] shortcut unavailable: ${key}`);
      }
    } catch (error) {
      console.warn(`[OVERLAY] shortcut conflict for ${key}:`, error);
    }
  });
}

function unregisterOverlayShortcuts() {
  overlayShortcutMap.forEach((_action, key) => {
    try {
      globalShortcut.unregister(key);
    } catch (error) {
      console.warn(`[OVERLAY] shortcut unregister failed for ${key}:`, error);
    }
  });
  overlayShortcutMap.clear();
}

function assertTrustedOverlaySender(event) {
  const sender = event?.sender;
  const isMainRenderer = Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents);
  const isOverlayRenderer = Boolean(overlayWindow && !overlayWindow.isDestroyed() && sender === overlayWindow.webContents);
  if (!isMainRenderer && !isOverlayRenderer) {
    throw new Error('Unauthorized overlay IPC sender.');
  }
}

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

async function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return;
  }

  const bounds = getNormalizedOverlayBounds(overlayState.bounds || getDefaultOverlayBounds());
  overlayWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: OVERLAY_MIN_WIDTH,
    minHeight: OVERLAY_MIN_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: Boolean(overlayState.alwaysOnTop),
    resizable: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep the overlay protected from supported screen-capture APIs just like
  // the main window.
  overlayWindow.setContentProtection(true);

  overlayWindow.on('move', () => updateOverlayBoundsFromWindow());
  overlayWindow.on('resize', () => updateOverlayBoundsFromWindow());
  overlayWindow.on('show', () => {
    if (overlayState.visibility === 'HIDDEN') {
      overlayState = normalizeOverlayState({ ...overlayState, visibility: 'VISIBLE', lowVisibility: false });
      void persistOverlayState(overlayState);
    }
    publishOverlayState();
  });
  overlayWindow.on('hide', () => {
    if (overlayState.visibility !== 'HIDDEN') {
      overlayState = normalizeOverlayState({ ...overlayState, visibility: 'HIDDEN', lowVisibility: true });
      void persistOverlayState(overlayState);
    }
    publishOverlayState();
  });
  overlayWindow.on('minimize', () => {
    const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
    overlayState = normalizeOverlayState({
      ...overlayState,
      visibility: 'MINIMIZED',
      lowVisibility: true,
      bounds: getCompactOverlayBounds(expandedBounds),
      expandedBounds,
    });
    void persistOverlayState(overlayState);
  });
  overlayWindow.on('restore', () => {
    if (overlayState.visibility === 'MINIMIZED') {
      const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
      overlayState = normalizeOverlayState({
        ...overlayState,
        visibility: 'VISIBLE',
        lowVisibility: false,
        bounds: expandedBounds,
        expandedBounds,
      });
      overlayWindow.setBounds(expandedBounds, true);
      void persistOverlayState(overlayState);
    }
  });

  const overlayUrl = isDev
    ? `${process.env.ELECTRON_DEV_URL || 'http://localhost:5174'}?overlay=1`
    : `file://${path.join(__dirname, '..', 'dist', 'index.html')}?overlay=1`;
  overlayWindow.loadURL(overlayUrl);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  overlayState = normalizeOverlayState({ ...overlayState, bounds });
  publishOverlayState();
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
  ipcMain.handle('overlay:open', async (event) => {
    assertTrustedOverlaySender(event);
    return showOverlayWindow();
  });
  ipcMain.handle('overlay:show', async (event) => {
    assertTrustedOverlaySender(event);
    return showOverlayWindow();
  });
  ipcMain.handle('overlay:hide', async (event) => {
    assertTrustedOverlaySender(event);
    return hideOverlayWindow();
  });
  ipcMain.handle('overlay:toggle', async (event) => {
    assertTrustedOverlaySender(event);
    return toggleOverlayWindow();
  });
  ipcMain.handle('overlay:minimize', async (event) => {
    assertTrustedOverlaySender(event);
    return minimizeOverlayWindow();
  });
  ipcMain.handle('overlay:expand', async (event) => {
    assertTrustedOverlaySender(event);
    return expandOverlayWindow();
  });
  ipcMain.handle('overlay:close', (event) => {
    assertTrustedOverlaySender(event);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  });
  ipcMain.handle('overlay:get-preferences', async (event) => {
    assertTrustedOverlaySender(event);
    return getOverlayStateForRenderer();
  });
  ipcMain.handle('overlay:set-preferences', async (event, prefs) => {
    assertTrustedOverlaySender(event);
    return setOverlayPreferences(prefs);
  });
  ipcMain.handle('overlay:get-bounds', async (event) => {
    assertTrustedOverlaySender(event);
    return { ...overlayState.bounds };
  });
  ipcMain.handle('overlay:set-bounds', async (event, bounds) => {
    assertTrustedOverlaySender(event);
    return setOverlayBounds(typeof bounds === 'undefined' ? overlayState.bounds : bounds);
  });
  ipcMain.handle('overlay:set-always-on-top', async (event, alwaysOnTop) => {
    assertTrustedOverlaySender(event);
    return setOverlayAlwaysOnTop(alwaysOnTop);
  });
  ipcMain.handle('overlay:focus-answer', async (event) => {
    assertTrustedOverlaySender(event);
    await showOverlayWindow();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.focus();
    }
    return overlayState;
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
  ipcMain.handle('general:model-response', (event, taskId, input) => { registerGeneralRenderer(event); return generalAgent.recordModelResponse(taskId, event.sender.id, input || {}); });
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

  overlayState = await readOverlayState();
  registerOverlayShortcuts();
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  unregisterOverlayShortcuts();
  globalShortcut.unregisterAll();
});
