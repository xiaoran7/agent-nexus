// =============================================================================
// CPA (cliproxyapi) Gateway Observer
// 只读观测本节点上真实存在的 CPA 管理接口，为面板提供可核验的网关事实：
// 账号池健康度、供应商分布、近期请求成败。绝不写入、绝不重启、绝不读凭据明文。
// =============================================================================

import { request as httpRequest } from 'node:http';

const PROBE_PATHS = ['/v0/management/auth-files', '/v0/management/config'];
const CACHE_TTL_MS = 8000;

// 常见部署位置：本机回环 8316（CPA 控制面）。允许用环境变量覆盖。
function candidateEndpoints() {
  const explicit = process.env.NEXUS_CPA_MGMT_URL;
  if (explicit) return [{ baseUrl: explicit.replace(/\/+$/, '') }];
  const host = process.env.NEXUS_CPA_HOST || '127.0.0.1';
  const port = Number(process.env.NEXUS_CPA_PORT || 8316);
  return [{ baseUrl: `http://${host}:${port}` }];
}

function managementSecret() {
  return process.env.NEXUS_CPA_MGMT_SECRET || process.env.CPA_MGMT_SECRET || null;
}

function jsonGet(baseUrl, path, secret, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(path, baseUrl);
    } catch {
      resolve({ ok: false, reason: 'bad_url' });
      return;
    }
    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 512 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            resolve({ ok: false, status: res.statusCode });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(body) });
          } catch {
            resolve({ ok: false, reason: 'bad_json' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    req.on('error', () => resolve({ ok: false, reason: 'unreachable' }));
    req.end();
  });
}

function summarizeAuthFiles(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const providers = new Map();
  let disabled = 0;
  let cooling = 0;
  let failed = 0;
  let requestSuccess = 0;
  let requestFailed = 0;

  for (const f of files) {
    const provider = String(f.provider || f.account_type || 'unknown').toLowerCase();
    providers.set(provider, (providers.get(provider) || 0) + 1);
    if (f.disabled) disabled += 1;
    if (Array.isArray(f.cooldowns) && f.cooldowns.length > 0) cooling += 1;
    failed += Number(f.failed) || 0;
    for (const r of Array.isArray(f.recent_requests) ? f.recent_requests : []) {
      requestSuccess += Number(r.success) || 0;
      requestFailed += Number(r.failed) || 0;
    }
  }

  return {
    totalAccounts: files.length,
    enabledAccounts: files.length - disabled,
    disabledAccounts: disabled,
    coolingAccounts: cooling,
    failedCount: failed,
    providers: [...providers.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    recentRequests: { success: requestSuccess, failed: requestFailed }
  };
}

function summarizeConfig(payload) {
  const apiKeys = Array.isArray(payload?.['api-keys']) ? payload['api-keys'].length : 0;
  const modelCount = payload?.models && typeof payload.models === 'object'
    ? Object.keys(payload.models).length
    : 0;
  return { apiKeyCount: apiKeys, routedModelCount: modelCount, requestLogEnabled: payload?.['request-log'] === true };
}

export class CpaGatewayService {
  constructor({ endpoints = null, secret = null, now = () => Date.now() } = {}) {
    this.endpoints = endpoints || candidateEndpoints();
    this.secret = secret ?? managementSecret();
    this.now = now;
    this.cache = null;
  }

  async _detect() {
    for (const ep of this.endpoints) {
      const auth = await jsonGet(ep.baseUrl, PROBE_PATHS[0], this.secret);
      if (auth.ok) {
        const cfg = await jsonGet(ep.baseUrl, PROBE_PATHS[1], this.secret);
        return {
          reachable: true,
          baseUrl: ep.baseUrl,
          auth: summarizeAuthFiles(auth.data),
          config: cfg.ok ? summarizeConfig(cfg.data) : null
        };
      }
      // 端点存在但密钥无效：如实报告，不臆测数据。
      if (auth.status === 401 || auth.status === 403) {
        return {
          reachable: true,
          baseUrl: ep.baseUrl,
          unauthorized: true,
          auth: null,
          config: null
        };
      }
    }
    return { reachable: false, baseUrl: this.endpoints[0]?.baseUrl || null, auth: null, config: null };
  }

  async getStatus({ force = false } = {}) {
    const now = this.now();
    if (!force && this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return { ...this.cache.value, cached: true };
    }
    const detected = await this._detect();
    const value = {
      ...detected,
      managementAuthConfigured: Boolean(this.secret),
      observedAt: now,
      cached: false
    };
    this.cache = { at: now, value };
    return value;
  }
}

let sharedService = null;
export function getSharedCpaGatewayService() {
  if (!sharedService) sharedService = new CpaGatewayService();
  return sharedService;
}
