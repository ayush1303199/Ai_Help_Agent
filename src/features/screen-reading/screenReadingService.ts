export async function captureScreenForReading(): Promise<string> {
  if (!window.electronAPI?.captureScreen) {
    throw new Error('Screen reading is available in the Electron desktop app.');
  }

  return window.electronAPI.captureScreen();
}
