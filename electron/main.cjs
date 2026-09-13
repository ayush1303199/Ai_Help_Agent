const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const path = require('node:path');

const isDev = !app.isPackaged;

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

app.whenReady().then(() => {
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

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
