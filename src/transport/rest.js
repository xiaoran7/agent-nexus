import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ValidationError, LEASE_POLICY } from '../daemon/coordinator.js';
import { extractBearer, extractQueryToken, verifySecret, generateToken, readSessionToken } from './auth.js';

let APP_VERSION = '0.3.2';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (pkg.version) APP_VERSION = pkg.version;
} catch {}

// 只放行探活与面板静态资源；/api/* 全部校验令牌。
const PUBLIC_PATHS = new Set(['/health', '/api/status', '/', '/index.html', '/style.css', '/app.js']);

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
  if (!origin) return false;
  if (req.headers.host && (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`)) {
    return true;
  }
  return allowedOrigins().includes(origin);
}

function applyCors(req, res) {
  if (isOriginAllowed(req)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-ID, Authorization');
    return true;
  }
  return false;
}

export function createRestRouter(
  coordinator,
  uiPath,
  tokenStore,
  { projectRegistry = null, memoryService = null, handoffService = null, clusterNodeService = null, cpaGatewayService = null } = {}
) {
  const staticCache = new Map();

  return async function handleRest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

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
      // 1. Health & Tray Status
      if (url.pathname === '/health') {
        return sendJson(200, { status: 'healthy', service: 'agent-nexus', version: APP_VERSION });
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        const counts = coordinator.getLiveAgentCounts();
        return sendJson(200, {
          status: 'ok',
          service: 'agent-nexus',
          version: APP_VERSION,
          active_agents_count: counts.total,
          working: counts.working,
          waiting: counts.waiting,
          idle: counts.idle,
          active_leases: counts.activeLeases,
          waiting_intents: counts.waitingIntents,
          timestamp: Date.now()
        });
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
          'timeline:event', 'agent:woken', 'agent:telemetry', 'agent:status',
          'resource:freed', 'memory:saved', 'memory:deleted',
          'handoff:created', 'handoff:consumed', 'node:status'
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

      // 1.2 Projects 路由 (项目列表、项目长期记忆与项目级交接工单)
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        if (!projectRegistry) return sendJson(200, []);
        return sendJson(200, projectRegistry.listProjects());
      }

      if (url.pathname.startsWith('/api/projects/')) {
        const parts = url.pathname.split('/').slice(3);
        const projectId = decodeURIComponent(parts[0] || '');
        const action = parts[1];

        if (projectId) {
          if (!action && req.method === 'GET') {
            if (!projectRegistry) return sendJson(404, { error: 'Not Found' });
            const project = projectRegistry.getProject(projectId);
            return project ? sendJson(200, project) : sendJson(404, { error: 'Not Found' });
          }

          if (action === 'memories') {
            if (!memoryService) return sendJson(200, []);

            if (req.method === 'GET') {
              const query = url.searchParams.get('q') || url.searchParams.get('query');
              const category = url.searchParams.get('category') || null;
              const limit = parseInt(url.searchParams.get('limit') || '50', 10);
              if (query) {
                return sendJson(200, memoryService.search(projectId, query, { category, limit }));
              }
              return sendJson(200, memoryService.list(projectId, { category, limit }));
            }

            if (req.method === 'POST') {
              projectRegistry?.ensureProject(projectId);
              const body = await readJson();
              const saved = memoryService.set(projectId, {
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
              const delRes = memoryService.delete(projectId, identifier);
              return sendJson(200, delRes);
            }
          }

          if (action === 'handoffs') {
            const hSvc = handoffService || coordinator.handoffService;
            if (!hSvc) return sendJson(200, []);

            if (req.method === 'GET') {
              const status = url.searchParams.get('status') || null;
              const limit = parseInt(url.searchParams.get('limit') || '20', 10);
              return sendJson(200, hSvc.list(projectId, { status, limit }));
            }

            if (req.method === 'POST') {
              projectRegistry?.ensureProject(projectId);
              const body = await readJson();
              const saved = hSvc.createHandoff(projectId, {
                sourceHostId: body.source_host_id || body.sourceHostId || 'local',
                sourceAgentId: body.source_agent_id || body.sourceAgentId || token?.agent_id || 'manual',
                sourceSessionId: body.source_session_id || body.sourceSessionId || null,
                targetHostId: body.target_host_id || body.targetHostId || null,
                objective: body.objective || '',
                stateSummary: body.state_summary || body.stateSummary || '',
                modifiedFiles: body.modified_files || body.modifiedFiles || [],
                nextAction: body.next_action || body.nextAction || '',
                metadata: body.metadata || {}
              });
              return sendJson(201, saved);
            }
          }
        }
      }

      // 1.3 Real-time Collaboration Graph (多 Session 实时协同图谱)
      if (url.pathname === '/api/collaboration-graph' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id');
        return sendJson(200, coordinator.getCollaborationGraph(pid));
      }

      // 2. Agents & Remote Edge Sync
      if (url.pathname === '/api/agents' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id');
        return sendJson(200, coordinator.listAgents(pid));
      }
      if (url.pathname === '/api/agents/register' && req.method === 'POST') {
        const data = await readJson();
        const agent = coordinator.registerAgent(data);
        return sendJson(200, { success: true, agent });
      }
      if (url.pathname === '/api/agents/sync-remote' && req.method === 'POST') {
        const data = await readJson();
        const hostId = data.host_id || data.hostId || data.node_id || 'remote';
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        const fullSnapshot = data.full_snapshot !== false && data.fullSnapshot !== false;
        const platform = data.platform || null;
        const syncRes = coordinator.syncRemoteClaudeSessions({
          hostId,
          sessions,
          fullSnapshot,
          platform
        });
        // 随快照上报的 CPA 网关事实，落到节点元数据供面板与集群视图展示。
        if (data.gateway && typeof data.gateway === 'object') {
          const nodeSvc = clusterNodeService || coordinator.clusterNodeService;
          if (nodeSvc) {
            try {
              nodeSvc.recordHeartbeat(hostId, {
                role: 'edge',
                platform: platform || undefined,
                metadata: {
                  gateway: data.gateway,
                  gateway_observed_at: data.gateway.observedAt || Date.now()
                }
              });
            } catch {}
          }
        }
        return sendJson(200, { success: true, host_id: hostId, ...syncRes });
      }

      // 2.1 跨机集群算力节点拓扑查询与心跳
      if (url.pathname === '/api/cluster/nodes' && req.method === 'GET') {
        const nodeSvc = clusterNodeService || coordinator.clusterNodeService;
        const projectId = url.searchParams.get('project_id') || null;
        return sendJson(200, nodeSvc ? nodeSvc.listNodes(projectId) : []);
      }
      if (url.pathname === '/api/cluster/heartbeat' && req.method === 'POST') {
        const data = await readJson();
        const nodeSvc = clusterNodeService || coordinator.clusterNodeService;
        if (!nodeSvc) return sendJson(200, { success: true });
        const record = nodeSvc.recordHeartbeat(data.node_id || data.host_id || 'remote', {
          role: data.role || 'edge',
          platform: data.platform || null,
          ip: data.ip || null,
          displayName: data.display_name || data.displayName || null,
          metadata: data.metadata || {}
        });
        return sendJson(200, { success: true, ok: true, node: record });
      }

      // 2.2 跨机会话工作交接 (PowerContext Work Handoffs)
      if (url.pathname === '/api/handoffs' && req.method === 'GET') {
        const hSvc = handoffService || coordinator.handoffService;
        const projectId = url.searchParams.get('project_id') || 'all';
        const status = url.searchParams.get('status') || null;
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        return sendJson(200, hSvc ? hSvc.list(projectId, { status, limit }) : []);
      }
      if (url.pathname === '/api/handoffs' && req.method === 'POST') {
        const body = await readJson();
        const hSvc = handoffService || coordinator.handoffService;
        if (!hSvc) return sendJson(500, { error: 'Handoff service unavailable' });
        const saved = hSvc.createHandoff(body.project_id || 'default', {
          sourceHostId: body.source_host_id || body.sourceHostId || 'local',
          sourceAgentId: body.source_agent_id || body.sourceAgentId || token?.agent_id || 'manual',
          sourceSessionId: body.source_session_id || body.sourceSessionId || null,
          targetHostId: body.target_host_id || body.targetHostId || null,
          objective: body.objective || '',
          stateSummary: body.state_summary || body.stateSummary || '',
          modifiedFiles: body.modified_files || body.modifiedFiles || [],
          nextAction: body.next_action || body.nextAction || '',
          metadata: body.metadata || {}
        });
        return sendJson(201, saved);
      }
      if (url.pathname.startsWith('/api/handoffs/') && url.pathname.endsWith('/consume') && req.method === 'POST') {
        const hId = url.pathname.replace('/api/handoffs/', '').replace('/consume', '');
        const body = await readJson();
        const hSvc = handoffService || coordinator.handoffService;
        if (!hSvc) return sendJson(500, { error: 'Handoff service unavailable' });
        const consumed = hSvc.consumeHandoff(hId, body.agent_id || token?.agent_id || 'unknown', body.host_id || null, body.status || null);
        return sendJson(200, { success: Boolean(consumed), handoff: consumed });
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
        const rawAgentId = data.agent_id || data.agentId;
        if (token?.agent_id && rawAgentId && rawAgentId !== token.agent_id) {
          throw new ValidationError(`agent_id "${rawAgentId}" does not match token identity "${token.agent_id}"`, 'agent_id');
        }
        const effectiveAgentId = rawAgentId || token?.agent_id;
        const result = coordinator.declareIntent({
          agentId: effectiveAgentId,
          intentSummary: data.summary || data.intent_summary || data.intentSummary || 'Work intent',
          claims: data.claims || [],
          ttlSeconds: data.ttl_seconds || data.ttlSeconds || 300,
          projectId: data.project_id || data.projectId || 'default'
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

      if ((url.pathname === '/api/leases/release-agent' || url.pathname === '/api/hook/git-release') && req.method === 'POST') {
        const data = await readJson();
        const agentId = data.agent_id || token?.agent_id;
        if (!agentId) {
          return sendJson(400, { error: 'Missing required field: agent_id' });
        }
        const result = coordinator.releaseAgentLeases({
          agentId,
          sessionId: data.session_id || null,
          hostId: data.host_id || null,
          projectId: data.project_id || 'default',
          workspaceDir: data.workspace_dir || '',
          projectRoot: data.project_root || null,
          gitRemote: data.git_remote || data.gitRemote || null,
          gitContext: data.git_context || data.gitContext || null,
          reason: data.reason || 'git_action',
          scope: data.scope || 'all'
        });
        return sendJson(200, result);
      }

      // 6. Universal Hook fast check & telemetry
      if (url.pathname === '/api/hook/check' && req.method === 'POST') {
        const data = await readJson();
        if (data.host_id && Array.isArray(data.peer_sessions)) {
          try {
            coordinator.syncRemoteClaudeSessions({
              hostId: data.host_id,
              sessions: data.peer_sessions,
              fullSnapshot: true
            });
          } catch {}
        }
        const checkResult = coordinator.fastCheckAndAutoClaim({
          agentId: data.agent_id,
          hostId: data.host_id || null,
          provider: data.provider || 'unknown',
          sessionId: data.session_id || 'default',
          name: data.name || null,
          filePath: data.file_path || (data.tool_input && data.tool_input.file_path),
          resourceName: data.resource_name || data.resource || null,
          promptHint: data.prompt_hint,
          projectId: data.project_id || 'default',
          workspaceDir: data.workspace_dir || '',
          projectRoot: data.project_root || null,
          gitRemote: data.git_remote || data.gitRemote || null,
          pid: data.pid || null,
          livenessVerified: Boolean(data.liveness_verified),
          lastTool: data.tool || data.tool_name || null,
          lastAction: data.action || data.tool_action || null,
          lastTarget: data.target || data.tool_target || null
        });
        return sendJson(200, checkResult);
      }

      if (url.pathname === '/api/hook/telemetry' && req.method === 'POST') {
        const data = await readJson();
        if (data.host_id && Array.isArray(data.peer_sessions)) {
          try {
            coordinator.syncRemoteClaudeSessions({
              hostId: data.host_id,
              sessions: data.peer_sessions,
              fullSnapshot: true
            });
          } catch {}
        }
        const result = coordinator.recordTelemetry({
          agentId: data.agent_id,
          hostId: data.host_id || null,
          provider: data.provider || 'unknown',
          sessionId: data.session_id || 'default',
          name: data.name || null,
          toolName: data.tool || data.tool_name,
          toolAction: data.action || data.tool_action,
          toolTarget: data.target || data.tool_target || data.file_path,
          workspaceDir: data.workspace_dir || '',
          projectRoot: data.project_root || null,
          gitRemote: data.git_remote || data.gitRemote || null,
          projectId: data.project_id || 'default',
          pid: data.pid || null,
          livenessVerified: Boolean(data.liveness_verified)
        });
        // 子代理内部发起的工具调用带着 agent_id。刷新它那一行的活跃时间与最近动作，
        // 树上的卡片才有真实进展可显示；没登记过的子代理不会被凭空造出来。
        if (data.subagent_id) {
          try {
            coordinator.touchAgentSpawn({
              agentId: data.subagent_id,
              sessionId: data.session_id || null,
              hostId: data.host_id || null,
              toolName: data.tool || data.tool_name,
              toolAction: data.action || data.tool_action,
              toolTarget: data.target || data.tool_target || data.file_path
            });
          } catch {}
        }
        return sendJson(200, result);
      }

      // 6.2 子代理生命周期上报 (SubagentStart / SubagentStop)
      // 只接受真实事件：没有 SubagentStart 不建行，没有 SubagentStop 不标完成。
      if (url.pathname === '/api/hook/subagent-start' && req.method === 'POST') {
        const data = await readJson();
        const record = coordinator.recordAgentSpawn({
          agentId: data.agent_id,
          parentAgentId: data.parent_agent_id || null,
          sessionId: data.session_id || null,
          hostId: data.host_id || null,
          projectId: data.project_id || 'default',
          agentType: data.agent_type || null,
          description: data.description || null,
          model: data.model || null,
          runInBackground: data.run_in_background,
          spawnDepth: data.spawn_depth,
          at: data.at || null
        });
        if (!record) return sendJson(400, { error: 'Missing required field: agent_id / session_id' });
        return sendJson(200, { success: true, id: record.id });
      }

      if (url.pathname === '/api/hook/subagent-stop' && req.method === 'POST') {
        const data = await readJson();
        const record = coordinator.recordAgentStop({
          agentId: data.agent_id,
          parentAgentId: data.parent_agent_id || null,
          sessionId: data.session_id || null,
          hostId: data.host_id || null,
          projectId: data.project_id || 'default',
          agentType: data.agent_type || null,
          description: data.description || null,
          model: data.model || null,
          spawnDepth: data.spawn_depth,
          startedAt: data.started_at || null,
          stopReason: data.stop_reason || null,
          at: data.at || null
        });
        if (!record) return sendJson(400, { error: 'Missing required field: agent_id / session_id' });
        return sendJson(200, { success: true, id: record.id });
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
          sessionId: body.session_id || null,
          hostId: body.host_id || null,
          resourceName,
          projectId: body.project_id || 'default'
        });
        return sendJson(200, result);
      }

      // 7. Dashboard Snapshot & Unified Cockpit
      if (url.pathname === '/api/dashboard' && req.method === 'GET') {
        const pid = url.searchParams.get('project_id');
        return sendJson(200, coordinator.getDashboardSnapshot(pid));
      }

      // 7.1 CPA 网关只读观测（本节点真实管理接口，不写入不重启）
      // 返回本机观测结果，外加各边缘探针随心跳上报的同名字段，便于面板看清"谁连着什么"。
      if (url.pathname === '/api/gateway' && req.method === 'GET') {
        const local = cpaGatewayService
          ? await cpaGatewayService.getStatus({ force: url.searchParams.get('refresh') === '1' })
          : { reachable: false, auth: null, config: null, note: 'gateway observer disabled' };

        const nodeSvc = clusterNodeService || coordinator.clusterNodeService;
        let peers = [];
        if (nodeSvc) {
          try {
            peers = nodeSvc.listNodes(null)
              .filter(n => n.role !== 'hub')
              .map(n => {
                const gw = n.metadata?.gateway || null;
                return {
                  node_id: n.id,
                  display_name: n.display_name || n.id,
                  status: n.status,
                  last_seen_sec: n.last_seen_sec,
                  gateway: gw ? {
                    reachable: gw.reachable === true,
                    unauthorized: gw.unauthorized === true,
                    totalAccounts: gw.totalAccounts ?? null,
                    enabledAccounts: gw.enabledAccounts ?? null,
                    coolingAccounts: gw.coolingAccounts ?? null,
                    providers: Array.isArray(gw.providers) ? gw.providers.slice(0, 4) : [],
                    observedAt: gw.observedAt || n.metadata?.gateway_observed_at || null
                  } : null
                };
              });
          } catch {}
        }

        return sendJson(200, { ...local, peers });
      }

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
            cached = {
              buffer: readFileSync(filePath),
              mime: target.mime,
              mtime: stat.mtimeMs
            };
            staticCache.set(target.name, cached);
          }
          let outBuffer = cached.buffer;
          if (target.name === 'index.html') {
            const remoteAddr = req.socket?.remoteAddress || '';
            const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
            const cleanIp = remoteAddr.replace(/^::ffff:/, '');
            const m = cleanIp.match(/^100\.(\d+)\.\d+\.\d+$/);
            const isTailscale = Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
            if (isLoopback || isTailscale) {
              const sessionToken = tokenStore?.localOperatorToken || readSessionToken() || '';
              if (sessionToken) {
                const scriptInject = `<script>window.__NEXUS_TOKEN__ = ${JSON.stringify(sessionToken)};</script>\n</head>`;
                const htmlStr = outBuffer.toString('utf8').replace('</head>', scriptInject);
                outBuffer = Buffer.from(htmlStr, 'utf8');
              }
            }
          }
          res.writeHead(200, {
            'Content-Type': cached.mime,
            'Cache-Control': 'no-cache'
          });
          res.end(outBuffer);
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
