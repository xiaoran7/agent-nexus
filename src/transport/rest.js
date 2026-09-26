import { readFileSync, existsSync } from 'node:fs';
import { ValidationError } from '../daemon/coordinator.js';

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

export function createRestRouter(coordinator, stateService, messageService, uiPath) {
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
      res.writeHead(204);
      res.end();
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

      // 3. Intents (Coordinator Core)
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

      // 4. Leases
      if (url.pathname.startsWith('/api/leases/') && url.pathname.endsWith('/release') && req.method === 'POST') {
        const parts = url.pathname.split('/');
        const leaseId = parts[3];
        const data = await readJson();
        const result = coordinator.releaseLease(leaseId, data.agent_id);
        return sendJson(result.success ? 200 : 404, result);
      }

      // 5. Universal Hook fast check
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

      // 6. State & CAS (对齐 agent-comm)
      if (url.pathname.startsWith('/api/state')) {
        const parts = url.pathname.split('/').slice(3); // /api/state/:ns/:key
        const namespace = parts[0] || url.searchParams.get('namespace') || 'default';
        const key = parts[1] || null;

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
          if (parts[2] === 'cas') {
            const result = stateService.compareAndSwap(namespace, key, body.expected, body.new_value, body.updated_by, body.ttl_seconds);
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

      // 7. Messages (Agent 协调沟通总线)
      if (url.pathname === '/api/messages') {
        if (req.method === 'GET') {
          const toAgent = url.searchParams.get('to');
          if (toAgent) {
            return sendJson(200, messageService.inbox(toAgent));
          }
          return sendJson(200, messageService.list());
        }
        if (req.method === 'POST') {
          const body = await readJson();
          const msg = messageService.send(body);
          return sendJson(200, msg);
        }
      }

      // 8. Dashboard Snapshot & UI
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
