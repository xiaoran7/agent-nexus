// =============================================================================
// Agent-Nexus Desktop - Preload Script (安全隔离上下文桥梁)
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexusDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
  minimizeToTray: () => ipcRenderer.send('nexus:minimize-to-tray'),
  notifyStatus: (status) => ipcRenderer.send('nexus:update-status', status),
  openExternal: (url) => ipcRenderer.send('nexus:open-external', url)
});
