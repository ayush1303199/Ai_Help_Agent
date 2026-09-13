const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog } = require('electron');
const path = require('node:path');
const developerFiles = require('./developerFiles.cjs');

const isDev = !app.isPackaged;
let mainWindow = null;
let overlayWindow = null;

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

app.whenReady().then(() => {
  ipcMain.handle('overlay:open', () => {
    createOverlayWindow();
  });
  ipcMain.handle('overlay:toggle', () => {
    toggleOverlayWindow();
  });
  ipcMain.handle('overlay:close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  });
  ipcMain.handle('developer:choose-project', (_event) => developerFiles.chooseProjectFolder(dialog));
  ipcMain.handle('developer:clear-project', () => {
    developerFiles.clearProject();
  });
  ipcMain.handle('developer:list-directory', (_event, relativePath) => developerFiles.listDirectory(relativePath));
  ipcMain.handle('developer:read-file', (_event, relativePath) => developerFiles.readFile(relativePath));
  ipcMain.handle('developer:search-code', (_event, query) => developerFiles.searchCode(query));
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
