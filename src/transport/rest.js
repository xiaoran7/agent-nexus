import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ValidationError, LEASE_POLICY } from '../daemon/coordinator.js';
import { extractBearer, extractQueryToken, verifySecret, generateToken, readSessionToken } from './auth.js';

let APP_VERSION = '0.2.11';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (pkg.version) APP_VERSION = pkg.version;
} catch {}

const PUBLIC_PATHS = new Set(['/health', '/', '/index.html', '/style.css', '/app.js', '/api/dashboard', '/api/cockpit']);

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

export function createRestRouter(coordinator, stateService, messageService, uiPath, tokenStore, projectRegistry = null, memoryService = null, topologyService = null) {
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
      const chunks = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? JSON.parse(raw) : {});
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
        return sendJson(200, { status: 'healthy', service: 'agent-nexus', version: APP_VERSION });
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

        const events = [
          'timeline:event', 'agent:woken', 'resource:freed', 'state:changed', 'message:sent',
          'project:onboarded', 'milestone:reached', 'lead:broadcast', 'lead:awakened',
          'agent:progress', 'messages:read', 'memory:saved', 'memory:deleted'
        ];
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

          if (action === 'progress' && req.method === 'POST') {
            const data = await readJson();
            const result = messageService.reportProgress(data.agent_id, data.summary, projectId);
            return sendJson(200, result);
          }

          if (action === 'dialogue') {
            if (req.method === 'GET') {
              const agentId = url.searchParams.get('agent_id');
              const threadId = url.searchParams.get('thread_id') || null;
              const unreadOnly = url.searchParams.get('unread_only') === 'true';
              const markAsRead = url.searchParams.get('mark_as_read') !== 'false';
              const limit = parseInt(url.searchParams.get('limit') || '50', 10);

              if (!agentId) {
                // 若未指定 agentId，则返回该项目下的会话流或特定线程
                if (threadId) {
                  return sendJson(200, messageService.getThread(threadId, projectId));
                }
                return sendJson(200, messageService.list(limit, projectId));
              }

              if (token && token.agent_id && token.agent_id !== agentId) {
                return sendJson(403, { error: 'This token cannot read another agent\'s dialogue' });
              }

              const result = messageService.readDialogue(agentId, {
                threadId,
                unreadOnly,
                markAsRead,
                limit,
                projectId
              });
              return sendJson(200, result);
            }

            if (req.method === 'POST') {
              const data = await readJson();
              const msg = messageService.send({
                from: data.from,
                to: data.to || null,
                content: data.content,
                threadId: data.thread_id || null,
                replyToId: data.reply_to_id || null,
                dialogueType: data.dialogue_type || 'chat',
                importance: data.importance || 'normal',
                projectId
              }, token);
              return sendJson(200, msg);
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

        // POST /api/gateway/strategy
        if (url.pathname === '/api/gateway/strategy' && req.method === 'POST') {
          const body = await readJson();
          const validStrategies = ['smart', 'ordered', 'rotate', 'least-used'];
          if (!body.strategy || !validStrategies.includes(body.strategy)) {
            return sendJson(400, {
              error: `Invalid strategy "${body.strategy}". Allowed: ${validStrategies.join(', ')}`,
              field: 'strategy'
            });
          }
          gwRouter.strategy = body.strategy;
          return sendJson(200, { success: true, strategy: gwRouter.strategy });
        }
      }

      // 1.4 Topology (演进拓扑图数据查询)
      if (url.pathname === '/api/topology' && req.method === 'GET') {
        const topoSvc = topologyService || coordinator?.topologyService;
        if (!topoSvc) {
          return sendJson(503, { error: 'Topology service is not available' });
        }
        const projectId = url.searchParams.get('project_id') || 'default';
        const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10));
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const graph = topoSvc.getTopologyGraph(projectId, { limit, since });
        return sendJson(200, graph);
      }

      // 1.5 Real-time Collaboration Graph (多 Session 实时协同图谱)
      if (url.pathname === '/api/collaboration-graph' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id');
        return sendJson(200, coordinator.getCollaborationGraph(pid));
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

      // 5.1 Batch Release Leases by Agent (生命周期与 git commit/push 零感释放)
      if ((url.pathname === '/api/leases/release-agent' || url.pathname === '/api/hook/git-release') && req.method === 'POST') {
        const data = await readJson();
        const agentId = data.agent_id || token?.agent_id;
        if (!agentId) {
          return sendJson(400, { error: 'Missing required field: agent_id' });
        }
        const result = coordinator.releaseAgentLeases({
          agentId,
          projectId: data.project_id || 'default',
          reason: data.reason || 'git_action',
          scope: data.scope || 'all'
        });
        return sendJson(200, result);
      }

      // 6. Universal Hook fast check (支持文件冲突与命名资源锁检查)
      if (url.pathname === '/api/hook/check' && req.method === 'POST') {
        const data = await readJson();
        const checkResult = coordinator.fastCheckAndAutoClaim({
          agentId: data.agent_id,
          provider: data.provider || 'unknown',
          sessionId: data.session_id || 'default',
          name: data.name || null,
          filePath: data.file_path || (data.tool_input && data.tool_input.file_path),
          resourceName: data.resource_name || data.resource || null,
          promptHint: data.prompt_hint,
          projectId: data.project_id || 'default',
          workspaceDir: data.workspace_dir || '',
          projectRoot: data.project_root || null,
          pid: data.pid || null
        });
        return sendJson(200, checkResult);
      }

      // 6.01 Tool Telemetry 实时工具调用与活跃态势上报
      if (url.pathname === '/api/hook/telemetry' && req.method === 'POST') {
        const data = await readJson();
        const result = coordinator.recordTelemetry({
          agentId: data.agent_id,
          provider: data.provider || 'unknown',
          sessionId: data.session_id || 'default',
          name: data.name || null,
          toolName: data.tool || data.tool_name,
          toolAction: data.action || data.tool_action,
          toolTarget: data.target || data.tool_target || data.file_path,
          workspaceDir: data.workspace_dir || '',
          projectId: data.project_id || 'default',
          pid: data.pid || null
        });
        return sendJson(200, result);
      }

      // 6.1 显式命名资源锁接口 (Resource Locks)
      if (url.pathname === '/api/resources/locks' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id') || null;
        return sendJson(200, coordinator.listResourceLocks(pid));
      }
      if (url.pathname === '/api/resources/lock' && req.method === 'POST') {
        const body = await readJson();
        const result = coordinator.acquireResourceLock({
          agentId: body.agent_id,
          resourceName: body.resource_name || body.resource,
          ttlSeconds: body.ttl_seconds || LEASE_POLICY.resourceTtlSeconds,
          reason: body.reason || 'Resource held',
          projectId: body.project_id || 'default',
          projectRoot: body.project_root || null
        });
        return sendJson(200, result);
      }
      // 6.2 资源锁释放通道 (支持显式 /api/resources/unlock 与 Hook /api/hook/resource-release)
      if ((url.pathname === '/api/resources/unlock' || url.pathname === '/api/hook/resource-release') && req.method === 'POST') {
        const body = await readJson();
        const agentId = body.agent_id || token?.agent_id;
        if (!agentId) {
          return sendJson(400, { error: 'Missing required field: agent_id' });
        }
        const resourceName = body.resource_name || body.resource;
        if (!resourceName) {
          return sendJson(400, { error: 'Missing required field: resource_name' });
        }
        const result = coordinator.releaseResourceLock({
          agentId,
          resourceName,
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

      // 9. Dashboard Snapshot & 综合全览聚合数据
      if (url.pathname === '/api/dashboard' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id');
        return sendJson(200, coordinator.getDashboardSnapshot(pid));
      }

      // 9.0 Unified Cockpit (综合全览聚合视图数据)
      if (url.pathname === '/api/cockpit' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id') || null;
        return sendJson(200, coordinator.getUnifiedCockpit(pid));
      }

      const staticFiles = {
        '/': { name: 'index.html', mime: 'text/html; charset=utf-8' },
        '/index.html': { name: 'index.html', mime: 'text/html; charset=utf-8' },
        '/style.css': { name: 'style.css', mime: 'text/css; charset=utf-8' },
        '/app.js': { name: 'app.js', mime: 'application/javascript; charset=utf-8' }
      };

      if (staticFiles[url.pathname]) {
        const target = staticFiles[url.pathname];
        const uiDir = dirname(uiPath);
        const filePath = join(uiDir, target.name);
        if (existsSync(filePath)) {
          const stat = statSync(filePath);
          let cached = staticCache.get(target.name);
          if (!cached || cached.mtime !== stat.mtimeMs) {
            let buffer = readFileSync(filePath);
            if (target.name === 'index.html') {
              // 自动注入活动会话令牌，实现本地浏览器与 WebSocket 全双工零配置自动握手
              const sessionToken = readSessionToken() || '';
              const scriptInject = `<script>window.__NEXUS_TOKEN__ = ${JSON.stringify(sessionToken)};</script>\n</head>`;
              const htmlStr = buffer.toString('utf8').replace('</head>', scriptInject);
              buffer = Buffer.from(htmlStr, 'utf8');
            }
            cached = {
              buffer,
              mime: target.mime,
              mtime: stat.mtimeMs
            };
            staticCache.set(target.name, cached);
          }
          res.writeHead(200, {
            'Content-Type': cached.mime,
            'Cache-Control': 'no-cache'
          });
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
