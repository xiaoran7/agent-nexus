// =============================================================================
// Agent-Nexus Desktop - Probe Client (只连探针，不拉起探针)
//
// 探针与前端解耦：桌面端是纯客户端，探针由 `nexus probe:install` 独立安装、
// 开机自启、无窗口常驻。桌面端只做三件事：探活、读令牌、给出离线指引。
// =============================================================================

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

class ProbeClient {
  constructor(port = 4300, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  checkAlive() {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/health`, { timeout: 900 }, (res) => {
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

  // 探针把当前 operator 令牌写入 session.token；桌面端只读不写，重启即随探针轮换。
  getToken() {
    const fromEnv = process.env.NEXUS_TOKEN || process.env.NEXUS_ADMIN_TOKEN;
    if (fromEnv) return fromEnv.trim();

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
