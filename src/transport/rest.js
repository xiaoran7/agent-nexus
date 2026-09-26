import { readFileSync, existsSync } from 'node:fs';

export function createRestRouter(coordinator, stateService, messageService, uiPath) {
  return async function handleRest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-ID');

    if (req.method === 'OPTIONS') {
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
      sendJson(500, { error: err.message });
    }
  };
}
