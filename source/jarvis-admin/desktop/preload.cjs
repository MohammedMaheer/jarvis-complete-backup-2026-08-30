const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisDesktop', Object.freeze({
  isDesktop: true,
  getSystemSnapshot: () => ipcRenderer.invoke('jarvis:system-snapshot'),
  inspectScreen: () => ipcRenderer.invoke('jarvis:screen-context'),
  executeAction: (action) => ipcRenderer.invoke('jarvis:desktop-action', action),
  minimize: () => ipcRenderer.invoke('jarvis:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('jarvis:window', 'toggle-maximize'),
  close: () => ipcRenderer.invoke('jarvis:window', 'close'),
  setWindowMode: (mode) => ipcRenderer.invoke('jarvis:window-mode', mode),
  dashboardReady: () => ipcRenderer.invoke('jarvis:dashboard-ready'),
}))
