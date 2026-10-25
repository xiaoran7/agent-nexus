import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';

export function getSessionTokenPath() {
  return join(homedir(), '.agent-nexus', 'session.token');
}

export function getRemoteConfigPath() {
  return process.env.NEXUS_REMOTE_CONFIG_PATH || join(homedir(), '.agent-nexus', 'remote.json');
}

export function readRemoteConfig(customPath = null) {
  // 测试隔离：除非显式指定了 customPath 或 NEXUS_REMOTE_CONFIG_PATH，否则单测运行期间不读取开发者宿主机的 ~/.agent-nexus/remote.json
  const isRunningInTest = Boolean(process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === 'test');
  if (isRunningInTest && !customPath && !process.env.NEXUS_REMOTE_CONFIG_PATH) {
    return null;
  }
  try {
    const cfgPath = customPath || getRemoteConfigPath();
    if (existsSync(cfgPath)) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch {}
  return null;
}

export function writeRemoteConfig(config, customPath = null) {
  const cfgPath = customPath || getRemoteConfigPath();
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  return cfgPath;
}

export function clearRemoteConfig(customPath = null) {
  const cfgPath = customPath || getRemoteConfigPath();
  if (existsSync(cfgPath)) {
    unlinkSync(cfgPath);
    return true;
  }
  return false;
}

/**
 * 统一解析当前客户端（Hook / MCP / Bridge / CLI）应连接的 Nexus Hub 端点与节点身份
 * 优先级：显式参数 > 环境变量 (NEXUS_HUB_URL / NEXUS_HOST / NEXUS_PORT / NEXUS_TOKEN / NEXUS_NODE_ID) > ~/.agent-nexus/remote.json > 本机回环默认
 */
export function resolveNexusEndpoint(overrides = {}) {
  const remoteCfg = readRemoteConfig(overrides.remoteConfigPath || null) || {};
  const rawUrl = overrides.hubUrl || process.env.NEXUS_HUB_URL || process.env.NEXUS_URL || remoteCfg.hubUrl || null;

  let protocol = 'http:';
  let host = overrides.host || process.env.NEXUS_HOST || remoteCfg.host || '127.0.0.1';
  let port = overrides.port ?? (process.env.NEXUS_PORT ? parseInt(process.env.NEXUS_PORT, 10) : (remoteCfg.port || 4300));

  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      protocol = u.protocol || 'http:';
      host = overrides.host || process.env.NEXUS_HOST || u.hostname || host;
      port = overrides.port ?? (process.env.NEXUS_PORT ? parseInt(process.env.NEXUS_PORT, 10) : (u.port ? parseInt(u.port, 10) : (protocol === 'https:' ? 443 : 80)));
    } catch {}
  }

  const baseUrl = overrides.baseUrl || `${protocol}//${host}:${port}`;
  const token = overrides.token ||
                process.env.NEXUS_TOKEN ||
                process.env.NEXUS_ADMIN_TOKEN ||
                remoteCfg.token ||
                readSessionToken() ||
                null;
  const nodeId = (overrides.nodeId || process.env.NEXUS_NODE_ID || remoteCfg.nodeId || hostname() || 'local').trim();
  const isRemoteHub = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';

  return {
    protocol,
    host,
    port,
    baseUrl,
    token,
    nodeId,
    isRemoteHub
  };
}

export function readSessionToken() {
  try {
    const tokenPath = getSessionTokenPath();
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, 'utf8').trim();
      return token || null;
    }
  } catch {}
  return null;
}

// 令牌分两种：
//   agent  token —— 绑定一个 agent_id，只能读自己的收件箱，不能签发。
//   operator token —— 不绑定 agent，可读写全部、签发 agent 令牌。
// 身份不再靠 agent 自报的 provider：那是个客户端可控的字符串，
// 自称 claude 的陌生进程和真 Claude Code 没有区别。
//
// token 怎么交给 agent 是个没做完的问题：daemon 跑在本机，agent 也在本机，
// 但把 token 写进 ~/.claude/settings.json 这类文件意味着任何能读该文件的
// 进程都能拿到。这里不替用户做这个决定——没有配 token 时 daemon 直接拒绝
// 服务 /api/*，而不是退回无认证。

// operator 令牌带 read / write / mint。带 write 是因为 operator 自己就是主要的
// 调用方（注册 agent、释放租约、看面板）；真正需要收紧的是"能读谁的收件箱"，
// 那一条由 agent_id 绑定单独管，不靠这里的 read-only。
// mint 让它成为签发 agent 令牌的唯一入口：没有它，operator 只能把同一枚
// 全局令牌发给所有 agent，绑定就名存实亡。
const OBSERVER_SCOPES = new Set(['read', 'write', 'mint']);

export function generateToken(agentId, fixedSecret = null) {
  const secret = (typeof fixedSecret === 'string' && fixedSecret.trim())
    ? fixedSecret.trim()
    : randomBytes(32).toString('base64url');
  return {
    agent_id: agentId || null,
    secret,
    scopes: agentId ? ['read', 'write'] : [...OBSERVER_SCOPES]
  };
}

// 长度不同的 token 走 timingSafeEqual 会抛，所以先比长度；
// 长度本身不是秘密（签发时就是定长的），这只是让比较能走常数时间路径。
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// 令牌的签发与校验都放在 token 存储里。daemon 每次启动重新签发，
// 不落盘：重启即轮换，磁盘上不留长期凭据。
export class TokenStore {
  constructor() {
    this.bySecret = new Map();
    this.byAgent = new Map();
  }

  issue(spec) {
    this.bySecret.set(spec.secret, spec);
    if (spec.agent_id) this.byAgent.set(spec.agent_id, spec.secret);
    return spec;
  }

  verify(secret) {
    if (typeof secret !== 'string' || secret === '') return null;
    return this.bySecret.get(secret) ?? null;
  }

  // 重发同一 agent 的令牌时作废旧的那枚，否则上一枚仍在流通。
  revoke(secret) {
    const spec = this.bySecret.get(secret);
    if (!spec) return false;
    this.bySecret.delete(secret);
    if (spec.agent_id && this.byAgent.get(spec.agent_id) === secret) {
      this.byAgent.delete(spec.agent_id);
    }
    return true;
  }

  secretFor(agentId) {
    return this.byAgent.get(agentId) ?? null;
  }

  all() {
    return [...this.bySecret.values()];
  }
}

export function extractBearer(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  // 面板由浏览器用 WebSocket 连，没有自定义头，只能走查询参数。
  return null;
}

export function extractQueryToken(url) {
  return url.searchParams.get('token') || null;
}

export function verifySecret(store, candidate) {
  if (!candidate) return null;
  const spec = store.verify(candidate);
  if (!spec) return null;
  // 重新比一次：Map 的键查找是普通比较，这里确保走过常数时间路径。
  return constantTimeEqual(spec.secret, candidate) ? spec : null;
}
