const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kmHost', {
  quitApp: () => ipcRenderer.invoke('quit-app'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
});
