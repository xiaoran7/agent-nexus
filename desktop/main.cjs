// =============================================================================
// Agent-Nexus Desktop - Main Process (Electron 系统托盘与多智能体协同主控)
// =============================================================================

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('node:path');
const http = require('node:http');
const { DaemonController } = require('./daemon-runner.cjs');

// 单实例锁控制
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Desktop] Another instance is already running. Quitting.');
  app.quit();
  process.exit(0);
}

const PORT = parseInt(process.env.NEXUS_PORT || '4100', 10);
const daemon = new DaemonController(PORT);

let mainWindow = null;
let tray = null;
let statusInterval = null;
let isQuitting = false;

// 托盘图标缓存
const icons = {
  idle: path.join(__dirname, 'assets', 'tray-idle.png'),
  active: path.join(__dirname, 'assets', 'tray-active.png'),
  busy: path.join(__dirname, 'assets', 'tray-busy.png'),
  app: path.join(__dirname, 'assets', 'icon.png')
};

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Agent-Nexus 协同控制台',
    icon: nativeImage.createFromPath(icons.app),
    backgroundColor: '#0a0d16',
    autoHideMenuBar: true,
    show: false, // 初始隐藏，等加载完毕后再显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const token = daemon.getToken();
  const targetUrl = `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`;

  mainWindow.loadURL(targetUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 拦截关闭事件，仅最小化/隐藏至托盘
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray && process.platform === 'win32') {
        tray.displayBalloon?.({
          title: 'Agent-Nexus 协同控制台',
          content: '应用已最小化到系统托盘，协同防碰撞守护进程持续生效中。'
        });
      }
    }
  });

  // 外部链接交由系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function updateTrayMenu(statusText = '待命就绪') {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Agent-Nexus (${statusText})`,
      enabled: false
    },
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
      label: '查看演进拓扑 (Topology)',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          // 通过前端执行切换到拓扑 Tab
          mainWindow.webContents.executeJavaScript(`
            if (typeof window.switchTab === 'function') {
              window.switchTab('topology');
            } else {
              const tab = document.querySelector('[data-tab="topology"]');
              if (tab) tab.click();
            }
          `).catch(() => {});
        }
      }
    },
    {
      label: '在系统浏览器中打开',
      click: () => {
        const token = daemon.getToken();
        shell.openExternal(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`);
      }
    },
    { type: 'separator' },
    {
      label: '退出 Agent-Nexus',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  const iconImg = nativeImage.createFromPath(icons.idle);
  tray = new Tray(iconImg);

  tray.setToolTip('Agent-Nexus 多智能体协同守护');
  updateTrayMenu('就绪');

  // 双击托盘图标切换显隐
  tray.on('double-click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 单击托盘图标唤醒
  tray.on('click', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 启动状态轮询 (每 3 秒更新一次状态与托盘指示)
  startStatusPolling();
}

function startStatusPolling() {
  if (statusInterval) clearInterval(statusInterval);

  statusInterval = setInterval(() => {
    const token = daemon.getToken();
    const req = http.get(
      `http://127.0.0.1:${PORT}/api/status`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 1500
      },
      (res) => {
        if (res.statusCode !== 200) return;
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const activeLeases = data.active_leases || 0;
            const waitingCount = data.waiting_intents || 0;
            const activeAgents = data.active_agents || 0;

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
        });
      }
    );

    req.on('error', () => {
      if (tray) {
        tray.setToolTip('Agent-Nexus: 守护进程脱机连接中...');
        updateTrayMenu('守护进程连接断开');
      }
    });
  }, 3000);
}

// 多开唤醒已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// 应用就绪初始化
app.whenReady().then(async () => {
  try {
    await daemon.ensureDaemonRunning();
  } catch (err) {
    console.error('[Desktop] Daemon startup error:', err);
  }

  createTray();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

// IPC 消息支持
ipcMain.on('nexus:minimize-to-tray', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('nexus:open-external', (_, url) => {
  if (url) shell.openExternal(url);
});

// 应用即将退出前的清理
app.on('before-quit', () => {
  isQuitting = true;
  if (statusInterval) clearInterval(statusInterval);
});

app.on('will-quit', async () => {
  await daemon.shutdown();
});
