// =============================================================================
// Agent-Nexus Desktop - Probe Client (只连探针，不拉起探针)
//
// 探针与前端解耦：桌面端是纯客户端，探针由 `nexus probe:install` 独立安装、
// 开机自启、无窗口常驻。桌面端只做三件事：探活、读令牌、给出离线指引。
// =============================================================================

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

class ProbeClient {
  constructor(port = 4300, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
  }

  remoteConfig() {
    const remotePath = path.join(os.homedir(), '.agent-nexus', 'remote.json');
    try {
      if (fs.existsSync(remotePath)) return JSON.parse(fs.readFileSync(remotePath, 'utf8'));
    } catch {}
    return null;
  }

  get baseUrl() {
    if (process.env.NEXUS_HUB_URL) return process.env.NEXUS_HUB_URL.replace(/\/+$/, '');
    // 仅在默认未指定远端端点 (127.0.0.1:4300) 时，自动解析 edge 模式下的 remote.json / probe.json
    if ((this.host === '127.0.0.1' || this.host === 'localhost') && this.port === 4300) {
      const remote = this.remoteConfig();
      if (remote?.hubUrl) return remote.hubUrl.replace(/\/+$/, '');
      const status = this.probeStatus();
      if (status?.hubUrl) return status.hubUrl.replace(/\/+$/, '');
    }
    return `http://${this.host}:${this.port}`;
  }

  isLocalHub() {
    try {
      const u = new URL(this.baseUrl);
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
    } catch {
      return true;
    }
  }

  checkAlive() {
    return new Promise((resolve) => {
      // 900ms 太紧：daemon 忙时 /health 实测会抖到 600ms 以上，会把健康探针
      // 误判成离线，桌面端随之在面板与离线页之间来回切。
      const urlStr = `${this.baseUrl}/health`;
      let u;
      try {
        u = new URL(urlStr);
      } catch {
        return resolve({ alive: false });
      }
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(urlStr, { timeout: 3500 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ alive: false });
          try {
            const data = JSON.parse(body);
            resolve({ alive: true, version: data.version || null, status: data.status || 'ok' });
          } catch {
            resolve({ alive: true, version: null });
          }
        });
      });
      req.on('error', () => resolve({ alive: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ alive: false });
      });
    });
  }

  // HTTP 探活失败时的兜底：仅对本机 Hub 有效（进程还在、端口还在监听，就不算离线）。
  // 远端 Hub 架构下，本机 edge 探针进程在跑不代表远端 Hub 可达，不能用本地进程欺骗桌面端。
  isProcessUp() {
    if (!this.isLocalHub()) return false;
    const state = this.probeStatus();
    const pid = state && Number.isInteger(state.pid) ? state.pid : null;
    if (!pid) return false;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code !== 'EPERM') return false;
    }
    return true;
  }

  async isAlive() {
    const health = await this.checkAlive();
    if (health.alive) return health;
    if (this.isProcessUp()) return { alive: true, version: null, status: 'degraded' };
    return health;
  }

  // 令牌解析优先级：环境变量 > remote.json > probe.json > 本机 session.token
  getToken() {
    const fromEnv = process.env.NEXUS_TOKEN || process.env.NEXUS_ADMIN_TOKEN;
    if (fromEnv) return fromEnv.trim();

    const remote = this.remoteConfig();
    if (remote?.token && typeof remote.token === 'string') return remote.token.trim();

    const status = this.probeStatus();
    if (status?.token && typeof status.token === 'string') return status.token.trim();

    const tokenPath = path.join(os.homedir(), '.agent-nexus', 'session.token');
    try {
      if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, 'utf8').trim();
    } catch {}
    return '';
  }

  probeStatus() {
    const statusPath = path.join(os.homedir(), '.agent-nexus', 'probe.json');
    try {
      if (fs.existsSync(statusPath)) return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {}
    return null;
  }

  isInstalled() {
    return fs.existsSync(path.join(os.homedir(), '.agent-nexus', 'probe-entry.json'));
  }

  panelUrl() {
    const token = this.getToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${this.baseUrl}/${query}`;
  }
}

module.exports = { ProbeClient };
