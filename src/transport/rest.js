import { readFileSync, existsSync } from 'node:fs';
import { ValidationError } from '../daemon/coordinator.js';
import { extractBearer, extractQueryToken, verifySecret, generateToken } from './auth.js';

// 不需要令牌的路径：健康检查与面板 HTML 本身。
// 面板的静态页面必须能打开，否则没有 token 的用户连登录入口都看不到；
// 它随后要读的 /api/dashboard 仍然要令牌。
const PUBLIC_PATHS = new Set(['/health', '/', '/index.html']);

// daemon 只监听 127.0.0.1，但浏览器不理会目标地址是不是本机：
// 页面里的 fetch 照样能打到 127.0.0.1:4100。原来这里无条件回 '*'，
// 等于任何网站都能注册 agent、读全部协调状态、往库里写消息。
// 改为只放行 NEXUS_ALLOWED_ORIGINS 显式列出的来源（逗号分隔）；
// 无 Origin 的直连（hook 脚本、MCP 客户端）不受白名单影响。
//
// 允许的跨源列表按请求读取，而非在模块加载时求值一次。
// 模块加载时机早于任何配置注入，缓存下来会让 NEXUS_ALLOWED_ORIGINS 在
// 长驻进程里永远读到空值——白名单配了也不生效。按环境变量原文做记忆化，
// 配置没变时不会重复解析。
let allowedOriginsCache = { raw: null, list: [] };

function allowedOrigins() {
  const raw = process.env.NEXUS_ALLOWED_ORIGINS || '';
  if (raw !== allowedOriginsCache.raw) {
    allowedOriginsCache = {
      raw,
      list: raw.split(',').map((o) => o.trim()).filter(Boolean)
    };
  }
  return allowedOriginsCache.list;
}

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  return Boolean(origin) && allowedOrigins().includes(origin);
}

function applyCors(req, res) {
  if (isOriginAllowed(req)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-ID');
    return true;
  }
  // 非放行来源：浏览器自会拦截响应，这里不必再回 CORS 头
  return false;
}

export function createRestRouter(coordinator, stateService, messageService, uiPath, tokenStore) {
  return async function handleRest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 真正响应上也必须回 CORS 头。浏览器只在实际响应里看到
    // Access-Control-Allow-Origin 才放行响应体；只在预检里回，等于白名单没生效。
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      if (!isOriginAllowed(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-ID, Authorization');
      res.writeHead(204);
      res.end();
      return;
    }

    // 认证放在读 body 之前：没令牌的请求一个字节都不该被读进来。
    const isPublic = PUBLIC_PATHS.has(url.pathname);
    const token = verifySecret(tokenStore, extractBearer(req) ?? extractQueryToken(url));
    if (!isPublic && !token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Missing or invalid token. Send it as "Authorization: Bearer <token>".'
      }));
      return;
    }
    // 作用域不足的令牌不该能改协调状态。operator 与 agent 令牌都带 write，
    // 这条是为将来可能的只读观测令牌留的口子。
    if (token && !token.scopes.includes('write') && req.method !== 'GET') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This token is read-only' }));
      return;
    }

    const readJson = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
    });

    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      // 1. Health
      if (url.pathname === '/health') {
        return sendJson(200, { status: 'healthy', service: 'agent-nexus', version: '0.1.0' });
      }

      // 2. Agents
      if (url.pathname === '/api/agents' && req.method === 'GET') {
        return sendJson(200, coordinator.listAgents());
      }
      if (url.pathname === '/api/agents/register' && req.method === 'POST') {
        const data = await readJson();
        const agent = coordinator.registerAgent(data);
        return sendJson(200, { success: true, agent });
      }

      // 3. Token minting (签发绑定某个 agent 的令牌)
      if (url.pathname === '/api/tokens' && req.method === 'POST') {
        if (!token.scopes.includes('mint')) {
          return sendJson(403, { error: 'This token cannot mint agent tokens' });
        }
        const body = await readJson();
        const agentId = body.agent_id;
        if (typeof agentId !== 'string' || agentId.trim() === '') {
          return sendJson(400, { error: '"agent_id" is required and must be a non-empty string', field: 'agent_id' });
        }
        // 同一 agent 重复签发时轮换旧令牌：多 agent 场景下更安全的是
        // "重发即作废"，否则上一枚还在某处流通。
        const previous = tokenStore.secretFor(agentId);
        if (previous) tokenStore.revoke(previous);

        // 顺带登记：messages.from_agent 带外键，先有令牌却发不出消息
        // （"unknown agent; register it first"）对第一次用的人是死胡同。
        if (!coordinator.getAgent(agentId)) {
          coordinator.registerAgent({
            id: agentId,
            name: agentId,
            provider: 'unknown',
            sessionId: agentId
          });
        }

        const spec = tokenStore.issue(generateToken(agentId));
        return sendJson(201, { agent_id: spec.agent_id, token: spec.secret });
      }

      // 4. Intents (Coordinator Core)
      if (url.pathname === '/api/intents/declare' && req.method === 'POST') {
        const data = await readJson();
        const result = coordinator.declareIntent({
          agentId: data.agent_id,
          intentSummary: data.summary,
          claims: data.claims || [],
          ttlSeconds: data.ttl_seconds || 300
        });
        return sendJson(200, result);
      }

      // 5. Leases
      if (url.pathname.startsWith('/api/leases/') && url.pathname.endsWith('/release') && req.method === 'POST') {
        const parts = url.pathname.split('/');
        const leaseId = parts[3];
        const data = await readJson();
        const result = coordinator.releaseLease(leaseId, data.agent_id);
        return sendJson(result.success ? 200 : 404, result);
      }

      // 6. Universal Hook fast check
      if (url.pathname === '/api/hook/check' && req.method === 'POST') {
        const data = await readJson();
        const checkResult = coordinator.fastCheckAndAutoClaim({
          agentId: data.agent_id,
          provider: data.provider || 'unknown',
          sessionId: data.session_id || 'default',
          filePath: data.file_path,
          promptHint: data.prompt_hint
        });
        return sendJson(200, checkResult);
      }

      // 7. State & CAS (对齐 agent-comm)
      if (url.pathname.startsWith('/api/state')) {
        const parts = url.pathname.split('/').slice(3); // /api/state/:ns/:key
        const namespace = parts[0] || url.searchParams.get('namespace') || 'default';
        // 只有第三段不是保留动作时才算键名，否则 /api/state/:ns/cas 里的 "cas"
        // 会被当成一个真实存在的键，键名就永远从请求体里取。
        const RESERVED = new Set(['cas']);
        const key = parts[1] && !RESERVED.has(parts[1]) ? parts[1] : null;

        if (req.method === 'GET') {
          if (key) {
            const entry = stateService.get(namespace, key);
            return entry ? sendJson(200, entry) : sendJson(404, { error: 'Not Found' });
          } else {
            const prefix = url.searchParams.get('prefix') || '';
            return sendJson(200, stateService.list(namespace, prefix));
          }
        }
        if (req.method === 'POST') {
          const body = await readJson();
          // CAS 有两种写法：/api/state/:ns/:key/cas（键在路径里）和
          // /api/state/:ns/cas（键在请求体的 key 字段里）。key 已把保留段
          // "cas" 排除在外，所以这里只要末段是 cas 就走 CAS。
          if (parts[parts.length - 1] === 'cas') {
            const casKey = key || body.key || null;
            const result = stateService.compareAndSwap(namespace, casKey, body.expected, body.new_value, body.updated_by, body.ttl_seconds);
            return sendJson(200, result);
          }
          const entry = stateService.set(namespace, key, body.value, body.updated_by, body.ttl_seconds);
          return sendJson(200, entry);
        }
        if (req.method === 'DELETE' && key) {
          const ok = stateService.delete(namespace, key);
          return sendJson(200, { success: ok });
        }
      }

      // 8. Messages (Agent 协调沟通总线)
      if (url.pathname === '/api/messages') {
        if (req.method === 'GET') {
          const toAgent = url.searchParams.get('to');
          if (toAgent) {
            // 收件箱按令牌绑定的 agent 隔离：令牌说是 A，就只能读 A 的。
            // operator 令牌不绑定 agent，放行读取（面板要看全局时间线）。
            if (token && token.agent_id && token.agent_id !== toAgent) {
              return sendJson(403, { error: 'This token cannot read another agent\'s inbox' });
            }
            return sendJson(200, messageService.inbox(toAgent));
          }
          // 无参列举是全局流水。绑定 agent 的令牌不该靠它绕过隔离。
          if (token && token.agent_id) {
            return sendJson(403, { error: 'Use ?to=<your agent id> to read your inbox' });
          }
          return sendJson(200, messageService.list());
        }
        if (req.method === 'POST') {
          const body = await readJson();
          const msg = messageService.send(body, token);
          return sendJson(200, msg);
        }
      }

      // 9. Dashboard Snapshot & UI
      if (url.pathname === '/api/dashboard' && req.method === 'GET') {
        return sendJson(200, coordinator.getDashboardSnapshot());
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (existsSync(uiPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(readFileSync(uiPath, 'utf8'));
          return;
        }
      }

      sendJson(404, { error: 'Not Found' });
    } catch (err) {
      // 调用方给了非法输入是 400，不是 500。原始错误串（尤其是 SQLite 绑定报错）
      // 不能直接透出去，它会暴露底层 schema 且对调用方毫无可操作性。
      if (err instanceof ValidationError) {
        return sendJson(err.statusCode || 400, { error: err.message, field: err.field });
      }
      if (err instanceof SyntaxError) {
        return sendJson(400, { error: 'Request body is not valid JSON' });
      }
      console.error('[Agent-Nexus] Unhandled request error:', err);
      sendJson(500, { error: 'Internal Server Error' });
    }
  };
}
