const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openOverlay: () => ipcRenderer.invoke('overlay:open'),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
});
