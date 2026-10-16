import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ValidationError } from '../daemon/coordinator.js';
import { extractBearer, extractQueryToken, verifySecret, generateToken } from './auth.js';

const PUBLIC_PATHS = new Set(['/health', '/', '/index.html', '/style.css', '/app.js']);

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
  return false;
}

export function createRestRouter(coordinator, stateService, messageService, uiPath, tokenStore, projectRegistry = null, memoryService = null) {
  const staticCache = new Map();

  return async function handleRest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

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

    const isPublic = PUBLIC_PATHS.has(url.pathname);
    const token = verifySecret(tokenStore, extractBearer(req) ?? extractQueryToken(url));
    if (!isPublic && !token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Missing or invalid token. Send it as "Authorization: Bearer <token>".'
      }));
      return;
    }

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
        return sendJson(200, { status: 'healthy', service: 'agent-nexus', version: '0.2.0' });
      }

      // 1.1 SSE 实时通知流 (GET /api/events)
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write(': connected\n\n');

        const filterProject = url.searchParams.get('project_id');
        const listener = (event, payload) => {
          if (filterProject && payload && payload.project_id && payload.project_id !== filterProject) {
            return;
          }
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        };

        const events = ['timeline:event', 'agent:woken', 'resource:freed', 'state:changed', 'message:sent', 'project:onboarded', 'milestone:reached', 'lead:broadcast', 'memory:saved', 'memory:deleted'];
        const handlers = new Map();
        for (const ev of events) {
          const handler = (p) => listener(ev, p);
          handlers.set(ev, handler);
          coordinator.eventBus.on(ev, handler);
        }

        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {}
        }, 15000);

        req.on('close', () => {
          clearInterval(heartbeat);
          for (const [ev, handler] of handlers.entries()) {
            coordinator.eventBus.removeListener(ev, handler);
          }
          handlers.clear();
        });
        return;
      }

      // 1.2 Projects 路由 (GET /api/projects, POST /api/projects/:id/onboard, etc.)
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        if (!projectRegistry) return sendJson(200, []);
        return sendJson(200, projectRegistry.listProjects());
      }

      if (url.pathname.startsWith('/api/projects/')) {
        const parts = url.pathname.split('/').slice(3); // /api/projects/:id/:action
        const projectId = parts[0];
        const action = parts[1];

        if (projectRegistry && projectId) {
          const lead = projectRegistry.getOrCreateLead(projectId);

          if (!action && req.method === 'GET') {
            const project = projectRegistry.getProject(projectId);
            const context = lead.getProjectContext();
            return sendJson(200, { ...project, context });
          }

          if (action === 'onboard' && req.method === 'POST') {
            const data = await readJson();
            const result = await lead.onboard({
              agentId: data.agent_id,
              plannedWork: data.planned_work || [],
              capabilities: data.capabilities || []
            });
            return sendJson(200, result);
          }

          if (action === 'advise' && req.method === 'POST') {
            const data = await readJson();
            const result = await lead.advisePlan({
              agentId: data.agent_id,
              plannedWork: data.planned_work || []
            });
            return sendJson(200, result);
          }

          if (action === 'depart' && req.method === 'POST') {
            const data = await readJson();
            const result = lead.depart(data.agent_id);
            return sendJson(200, result);
          }

          if (action === 'milestone' && req.method === 'POST') {
            const data = await readJson();
            const result = lead.reportMilestone({
              agentId: data.agent_id,
              description: data.description,
              leaseIdToRelease: data.lease_id_to_release,
              memory: data.memory
            });
            return sendJson(200, result);
          }

          if (action === 'memories') {
            const memSvc = memoryService || lead.memoryService;
            if (!memSvc) return sendJson(200, []);

            if (req.method === 'GET') {
              const query = url.searchParams.get('q') || url.searchParams.get('query');
              const category = url.searchParams.get('category') || null;
              const limit = parseInt(url.searchParams.get('limit') || '50', 10);
              if (query) {
                return sendJson(200, memSvc.search(projectId, query, { category, limit }));
              }
              return sendJson(200, memSvc.list(projectId, { category, limit }));
            }

            if (req.method === 'POST') {
              const body = await readJson();
              const saved = memSvc.set(projectId, {
                category: body.category,
                key: body.key,
                content: body.content,
                sourceAgentId: body.source_agent_id || token?.agent_id || null
              });
              return sendJson(201, saved);
            }

            if (req.method === 'DELETE') {
              const id = url.searchParams.get('id');
              const key = url.searchParams.get('key');
              const category = url.searchParams.get('category');
              let body = {};
              try { body = await readJson(); } catch {}

              const identifier = id || body.id || (key ? { key, category } : body.key ? { key: body.key, category: body.category } : null);
              if (!identifier) {
                return sendJson(400, { error: 'Missing memory identifier (id or key)', field: 'id' });
              }
              const res = memSvc.delete(projectId, identifier);
              return sendJson(200, res);
            }
          }

          if (action === 'broadcast' && req.method === 'POST') {
            const body = await readJson();
            if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
              return sendJson(400, { error: '"content" is required and must be a non-empty string', field: 'content' });
            }

            const senderId = body.from || token?.agent_id || 'sensei';
            const result = lead.broadcast({
              from: senderId,
              content: body.content,
              importance: body.importance,
              messageService,
              token
            });

            return sendJson(200, result);
          }
        }
      }

      // 1.3 Gateway Router 运维与代理路由
      if (url.pathname.startsWith('/api/gateway')) {
        const gwRouter = projectRegistry?.gatewayRouter;
        if (!gwRouter) {
          return sendJson(503, { error: 'Gateway router is not available' });
        }

        // GET /api/gateway/route 或 /api/gateway/status
        if ((url.pathname === '/api/gateway/route' || url.pathname === '/api/gateway/status') && req.method === 'GET') {
          return sendJson(200, {
            strategy: gwRouter.strategy,
            candidateCount: gwRouter.candidates.length,
            candidates: gwRouter.getCandidates()
          });
        }

        // POST /api/gateway/chat
        if (url.pathname === '/api/gateway/chat' && req.method === 'POST') {
          const body = await readJson();
          const { system_prompt, user_message, affinity_key, strategy } = body;
          if (!user_message || typeof user_message !== 'string') {
            return sendJson(400, { error: '"user_message" is required and must be a string', field: 'user_message' });
          }
          const result = await gwRouter.routeAndExecute(system_prompt || '', user_message, {
            affinityKey: affinity_key || null,
            strategy: strategy || null
          });
          if (!result) {
            return sendJson(503, { error: 'All gateway candidates failed or resting' });
          }
          return sendJson(200, result);
        }

        // POST /api/gateway/reset
        if (url.pathname === '/api/gateway/reset' && req.method === 'POST') {
          let body = {};
          try { body = await readJson(); } catch {}
          if (body.id) {
            const ok = gwRouter.resetCandidate(body.id);
            return sendJson(200, { success: ok, resetId: body.id });
          } else {
            const count = gwRouter.resetAll();
            return sendJson(200, { success: true, resetCount: count });
          }
        }
      }

      // 2. Agents
      if (url.pathname === '/api/agents' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id');
        return sendJson(200, coordinator.listAgents(pid));
      }
      if (url.pathname === '/api/agents/register' && req.method === 'POST') {
        const data = await readJson();
        const agent = coordinator.registerAgent(data);
        return sendJson(200, { success: true, agent });
      }

      // 3. Token minting
      if (url.pathname === '/api/tokens' && req.method === 'POST') {
        if (!token.scopes.includes('mint')) {
          return sendJson(403, { error: 'This token cannot mint agent tokens' });
        }
        const body = await readJson();
        const agentId = body.agent_id;
        if (typeof agentId !== 'string' || agentId.trim() === '') {
          return sendJson(400, { error: '"agent_id" is required and must be a non-empty string', field: 'agent_id' });
        }
        const previous = tokenStore.secretFor(agentId);
        if (previous) tokenStore.revoke(previous);

        if (!coordinator.getAgent(agentId)) {
          coordinator.registerAgent({
            id: agentId,
            name: agentId,
            provider: 'unknown',
            sessionId: agentId,
            projectId: body.project_id || 'default'
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
          ttlSeconds: data.ttl_seconds || 300,
          projectId: data.project_id || 'default'
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

      // 6. Universal Hook fast check (支持文件冲突与命名资源锁检查)
      if (url.pathname === '/api/hook/check' && req.method === 'POST') {
        const data = await readJson();
        const checkResult = coordinator.fastCheckAndAutoClaim({
          agentId: data.agent_id,
          provider: data.provider || 'unknown',
          sessionId: data.session_id || 'default',
          filePath: data.file_path || (data.tool_input && data.tool_input.file_path),
          resourceName: data.resource_name || data.resource || null,
          promptHint: data.prompt_hint,
          projectId: data.project_id || 'default',
          workspaceDir: data.workspace_dir || '',
          projectRoot: data.project_root || null
        });
        return sendJson(200, checkResult);
      }

      // 6.1 显式命名资源锁接口 (Resource Locks)
      if (url.pathname === '/api/resources/locks' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id') || 'default';
        return sendJson(200, coordinator.listResourceLocks(pid));
      }
      if (url.pathname === '/api/resources/lock' && req.method === 'POST') {
        const body = await readJson();
        const result = coordinator.acquireResourceLock({
          agentId: body.agent_id,
          resourceName: body.resource_name || body.resource,
          ttlSeconds: body.ttl_seconds || 300,
          reason: body.reason || 'Resource held',
          projectId: body.project_id || 'default',
          projectRoot: body.project_root || null
        });
        return sendJson(200, result);
      }
      if (url.pathname === '/api/resources/unlock' && req.method === 'POST') {
        const body = await readJson();
        const result = coordinator.releaseResourceLock({
          agentId: body.agent_id,
          resourceName: body.resource_name || body.resource,
          projectId: body.project_id || 'default'
        });
        return sendJson(200, result);
      }

      // 7. State & CAS
      if (url.pathname.startsWith('/api/state')) {
        const parts = url.pathname.split('/').slice(3); // /api/state/:ns/:key
        const namespace = parts[0] || url.searchParams.get('namespace') || 'default';
        const projectId = url.searchParams.get('project_id') || 'default';
        const RESERVED = new Set(['cas']);
        const key = parts[1] && !RESERVED.has(parts[1]) ? parts[1] : null;

        if (req.method === 'GET') {
          if (key) {
            const entry = stateService.get(namespace, key, projectId);
            return entry ? sendJson(200, entry) : sendJson(404, { error: 'Not Found' });
          } else {
            const prefix = url.searchParams.get('prefix') || '';
            return sendJson(200, stateService.list(namespace, prefix, projectId));
          }
        }
        if (req.method === 'POST') {
          const body = await readJson();
          const targetPid = body.project_id || projectId;
          if (parts[parts.length - 1] === 'cas') {
            const casKey = key || body.key || null;
            const result = stateService.compareAndSwap(namespace, casKey, body.expected, body.new_value, body.updated_by, body.ttl_seconds, targetPid);
            return sendJson(200, result);
          }
          const entry = stateService.set(namespace, key, body.value, body.updated_by, body.ttl_seconds, targetPid);
          return sendJson(200, entry);
        }
        if (req.method === 'DELETE' && key) {
          const ok = stateService.delete(namespace, key, projectId);
          return sendJson(200, { success: ok });
        }
      }

      // 8. Messages
      if (url.pathname === '/api/messages') {
        const pid = url.searchParams.get('project_id');
        if (req.method === 'GET') {
          const toAgent = url.searchParams.get('to');
          if (toAgent) {
            if (token && token.agent_id && token.agent_id !== toAgent) {
              return sendJson(403, { error: 'This token cannot read another agent\'s inbox' });
            }
            return sendJson(200, messageService.inbox(toAgent, 50, pid || 'default'));
          }
          if (token && token.agent_id) {
            return sendJson(403, { error: 'Use ?to=<your agent id> to read your inbox' });
          }
          return sendJson(200, messageService.list(50, pid));
        }
        if (req.method === 'POST') {
          const body = await readJson();
          const msg = messageService.send(body, token);
          return sendJson(200, msg);
        }
      }

      // 9. Dashboard Snapshot & 静态前端资产服务
      if (url.pathname === '/api/dashboard' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id');
        return sendJson(200, coordinator.getDashboardSnapshot(pid));
      }

      const staticFiles = {
        '/': { name: 'index.html', mime: 'text/html; charset=utf-8' },
        '/index.html': { name: 'index.html', mime: 'text/html; charset=utf-8' },
        '/style.css': { name: 'style.css', mime: 'text/css; charset=utf-8' },
        '/app.js': { name: 'app.js', mime: 'application/javascript; charset=utf-8' }
      };

      if (staticFiles[url.pathname]) {
        const target = staticFiles[url.pathname];
        let cached = staticCache.get(target.name);
        if (!cached) {
          const uiDir = dirname(uiPath);
          const filePath = join(uiDir, target.name);
          if (existsSync(filePath)) {
            cached = {
              buffer: readFileSync(filePath),
              mime: target.mime
            };
            staticCache.set(target.name, cached);
          }
        }
        if (cached) {
          res.writeHead(200, { 'Content-Type': cached.mime });
          res.end(cached.buffer);
          return;
        }
      }

      sendJson(404, { error: 'Not Found' });
    } catch (err) {
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
