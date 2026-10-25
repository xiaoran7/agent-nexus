// =============================================================================
// Agent-Nexus Desktop - Preload Script (安全隔离上下文桥梁)
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

// 探针地址由主进程以启动参数注入，离线页用它显示当前要连的端点。
const endpointArg = process.argv.find((a) => a.startsWith('--nexus-endpoint='));

contextBridge.exposeInMainWorld('nexusDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
  endpoint: endpointArg ? endpointArg.slice('--nexus-endpoint='.length) : null,
  minimizeToTray: () => ipcRenderer.send('nexus:minimize-to-tray'),
  notifyStatus: (status) => ipcRenderer.send('nexus:update-status', status),
  openExternal: (url) => ipcRenderer.send('nexus:open-external', url)
});
