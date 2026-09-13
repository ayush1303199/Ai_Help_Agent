const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openOverlay: () => ipcRenderer.invoke('overlay:open'),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  chooseDeveloperProject: () => ipcRenderer.invoke('developer:choose-project'),
  clearDeveloperProject: () => ipcRenderer.invoke('developer:clear-project'),
  listDeveloperDirectory: (relativePath) => ipcRenderer.invoke('developer:list-directory', relativePath),
  readDeveloperFile: (relativePath) => ipcRenderer.invoke('developer:read-file', relativePath),
  searchDeveloperCode: (query) => ipcRenderer.invoke('developer:search-code', query),
});
