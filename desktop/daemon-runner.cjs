// =============================================================================
// Agent-Nexus Desktop - Daemon Runner (守护进程探测、拉起与退出生命周期)
// =============================================================================

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

class DaemonController {
  constructor(port = 4300) {
    this.port = port;
    this.childProcess = null;
    this.isEmbedded = false;
  }

  /**
   * 检查 Daemon 健康状态
   */
  async checkAlive() {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.port}/health`, { timeout: 800 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * 确保 Daemon 运行中：若已有外部 Daemon 则复用，否则拉起托管子进程
   */
  async ensureDaemonRunning() {
    const alive = await this.checkAlive();
    if (alive) {
      console.log(`[Desktop] Connected to existing Agent-Nexus daemon on 127.0.0.1:${this.port}`);
      this.isEmbedded = false;
      return true;
    }

    console.log(`[Desktop] No running daemon detected on port ${this.port}. Launching managed daemon...`);
    const cliPath = path.resolve(__dirname, '../src/cli.js');

    this.childProcess = spawn(process.execPath, [cliPath, 'start'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NEXUS_PORT: String(this.port)
      }
    });

    this.isEmbedded = true;

    this.childProcess.stdout.on('data', (d) => {
      const msg = d.toString();
      // 在桌面终端调试输出
      if (process.env.DEBUG) process.stdout.write(msg);
    });

    this.childProcess.stderr.on('data', (d) => {
      if (process.env.DEBUG) process.stderr.write(d.toString());
    });

    // 轮询等待健康检查就绪 (最多等待 6 秒)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await this.checkAlive()) {
        console.log('[Desktop] Managed daemon is ready.');
        return true;
      }
    }

    throw new Error(`Failed to start Agent-Nexus daemon on port ${this.port} within 6 seconds.`);
  }

  /**
   * 读取本机活动操作者令牌，实现免密免配
   */
  getToken() {
    const customPath = process.env.NEXUS_TOKEN || process.env.NEXUS_ADMIN_TOKEN;
    if (customPath) return customPath.trim();

    const tokenPath = path.join(os.homedir(), '.agent-nexus', 'session.token');
    try {
      if (fs.existsSync(tokenPath)) {
        return fs.readFileSync(tokenPath, 'utf8').trim();
      }
    } catch {}
    return '';
  }

  /**
   * 优雅关停托管的子进程
   */
  async shutdown() {
    if (this.childProcess && this.isEmbedded) {
      console.log('[Desktop] Gracefully terminating managed daemon...');
      try {
        this.childProcess.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 600));
        if (!this.childProcess.killed) {
          this.childProcess.kill('SIGKILL');
        }
      } catch (err) {
        console.error('[Desktop] Error shutting down daemon:', err);
      }
    }
  }
}

module.exports = { DaemonController };
