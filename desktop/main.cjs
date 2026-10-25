// =============================================================================
// Agent-Nexus Desktop - Main Process (纯客户端托盘外壳)
//
// 探针与前端解耦：本进程绝不拉起 daemon，只连接独立安装的后台探针。
// 探针不在线时展示 offline.html 指引页，并每 3 秒自动重连。
// =============================================================================

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('node:path');
const { ProbeClient } = require('./probe-client.cjs');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

const PORT = parseInt(process.env.NEXUS_PORT || '4300', 10);
const HOST = process.env.NEXUS_HOST && process.env.NEXUS_HOST !== '0.0.0.0' ? process.env.NEXUS_HOST : '127.0.0.1';
const probe = new ProbeClient(PORT, HOST);

let mainWindow = null;
let tray = null;
let statusInterval = null;
let isQuitting = false;
let showingOffline = false;

const icons = {
  idle: path.join(__dirname, 'assets', 'tray-idle.png'),
  active: path.join(__dirname, 'assets', 'tray-active.png'),
  busy: path.join(__dirname, 'assets', 'tray-busy.png'),
  app: path.join(__dirname, 'assets', 'icon.png')
};

const OFFLINE_PAGE = path.join(__dirname, 'offline.html');

function showOffline() {
  if (!mainWindow || showingOffline) return;
  showingOffline = true;
  mainWindow.loadFile(OFFLINE_PAGE);
}

function showPanel() {
  if (!mainWindow) return;
  showingOffline = false;
  mainWindow.loadURL(probe.panelUrl());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 560,
    minWidth: 640,
    minHeight: 440,
    title: 'Agent-Nexus 协同控制台',
    icon: nativeImage.createFromPath(icons.app),
    backgroundColor: '#0a0d16',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      additionalArguments: [`--nexus-endpoint=${probe.baseUrl}`]
    }
  });

  showPanel();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 探针没起来时面板会加载失败：落到离线指引页，由状态轮询负责重连。
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _desc, validatedURL) => {
    if (validatedURL && validatedURL.startsWith('file://')) return;
    showOffline();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray && process.platform === 'win32') {
        tray.displayBalloon?.({
          title: 'Agent-Nexus 协同控制台',
          content: '已最小化到托盘。后台探针仍在运行，协同防护持续生效。'
        });
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function updateTrayMenu(statusText = '待命就绪') {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Agent-Nexus (${statusText})`, enabled: false },
    { type: 'separator' },
    {
      label: '显示协同控制台',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '在系统浏览器中打开',
      click: () => shell.openExternal(probe.panelUrl())
    },
    { type: 'separator' },
    {
      label: '重启探针',
      click: () => restartProbe()
    },
    {
      label: '退出控制台',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

// 托盘上的“重启探针”只是给出指引，不替用户跑安装/启动命令：
// 探针归 CLI 管，桌面端保持纯客户端边界。
function restartProbe() {
  if (tray && process.platform === 'win32') {
    tray.displayBalloon?.({ title: 'Agent-Nexus 探针', content: '请在终端运行：nexus probe:start' });
  }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(icons.idle));
  tray.setToolTip('Agent-Nexus 多智能体协同守护');
  updateTrayMenu('就绪');

  tray.on('double-click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  startStatusPolling();
}

async function startStatusPolling() {
  if (statusInterval) clearInterval(statusInterval);

  const tick = async () => {
    const health = await probe.checkAlive();

    if (!health.alive) {
      showOffline();
      if (tray) {
        tray.setToolTip('Agent-Nexus: 探针离线');
        tray.setImage(nativeImage.createFromPath(icons.busy));
        updateTrayMenu('探针离线 · 运行 nexus probe:start');
      }
      return;
    }

    if (showingOffline) showPanel();

    try {
      const token = probe.getToken();
      const res = await fetch(`${probe.baseUrl}/api/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(1500)
      });
      if (!res.ok) return;
      const data = await res.json();
      const activeLeases = data.active_leases || 0;
      const waitingCount = data.waiting_intents || 0;
      const activeAgents = data.active_agents || data.active_agents_count || 0;

      let tip = 'Agent-Nexus: 待命就绪 (无活跃锁)';
      let iconPath = icons.idle;
      let statusText = `在线 (${activeAgents} 个智能体)`;

      if (waitingCount > 0) {
        tip = `Agent-Nexus: 冲突等待中 (${waitingCount} 个排队 / ${activeLeases} 个活跃锁)`;
        iconPath = icons.busy;
        statusText = `等待排队: ${waitingCount}`;
      } else if (activeLeases > 0) {
        tip = `Agent-Nexus: 协同施工中 (${activeLeases} 个活跃锁 / ${activeAgents} 个活跃智能体)`;
        iconPath = icons.active;
        statusText = `施工中: ${activeLeases} 个锁`;
      }

      if (tray) {
        tray.setToolTip(tip);
        tray.setImage(nativeImage.createFromPath(iconPath));
        updateTrayMenu(statusText);
      }
    } catch {}
  };

  await tick();
  statusInterval = setInterval(tick, 3000);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  createTray();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else if (mainWindow) mainWindow.show();
  });
});

ipcMain.on('nexus:minimize-to-tray', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('nexus:open-external', (_, url) => {
  if (url) shell.openExternal(url);
});

app.on('before-quit', () => {
  isQuitting = true;
  if (statusInterval) clearInterval(statusInterval);
});
