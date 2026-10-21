// =============================================================================
// Agent-Nexus MCP Stdio Transport Server
// =============================================================================

import { createInterface } from 'node:readline';
import { resolveProject } from '../domain/project.js';
import { ALL_NEXUS_TOOLS, handleMcpTool } from './server.js';
import { readSessionToken } from '../transport/auth.js';

export function startMcpStdio(options = {}) {
  const targetDir = options.projectRoot || process.cwd();
  const info = resolveProject(targetDir);
  const projectId = options.projectId || info.projectId;
  const projectRoot = options.projectRoot || info.projectRoot;

  const port = options.port ?? parseInt(process.env.NEXUS_PORT || '4300', 10);
  const baseUrl = options.baseUrl || `http://127.0.0.1:${port}`;
  let cachedToken = options.token || process.env.NEXUS_TOKEN || process.env.NEXUS_ADMIN_TOKEN || readSessionToken() || '';

  function getActiveToken(forceRefresh = false) {
    if (options.token) return options.token;
    if (process.env.NEXUS_TOKEN) return process.env.NEXUS_TOKEN;
    if (process.env.NEXUS_ADMIN_TOKEN) return process.env.NEXUS_ADMIN_TOKEN;
    if (forceRefresh || !cachedToken) {
      cachedToken = readSessionToken() || '';
    }
    return cachedToken;
  }

  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

  const inProcessContext = options.inProcessContext || null;

  const defaultAgentId = options.agentId ||
    process.env.NEXUS_AGENT_ID ||
    (process.env.CLAUDE_CODE_SESSION_ID ? `claude-${process.env.CLAUDE_CODE_SESSION_ID}` :
      (process.env.CODEX_SESSION_ID ? `codex-${process.env.CODEX_SESSION_ID}` :
        `agent-${process.pid}`));

  function send(msg) {
    output.write(JSON.stringify(msg) + '\n');
  }

  async function executeHttpTool(name, rawArgs) {
    const args = { ...rawArgs };
    if (!args.project_id) args.project_id = projectId;
    if (!args.agent_id) args.agent_id = defaultAgentId;

    const apiFetch = async (endpoint, method = 'GET', body = null, isRetry = false) => {
      const currentToken = getActiveToken(isRetry);
      const headers = {
        'Content-Type': 'application/json',
        ...(currentToken ? { 'Authorization': `Bearer ${currentToken}` } : {})
      };

      let res;
      try {
        res = await fetch(`${baseUrl}${endpoint}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
      } catch (err) {
        throw new Error(
          `Agent-Nexus daemon is not reachable at ${baseUrl}. ` +
          `Run "nexus start" in a separate terminal to start coordination.\n(${err.message})`
        );
      }

      // 如果遇到 401 且未重试过，强制从磁盘重新读取 session.token 热重试一次
      if (res.status === 401 && !isRetry) {
        const refreshedToken = getActiveToken(true);
        if (refreshedToken) {
          return apiFetch(endpoint, method, body, true);
        }
      }

      if (!res.ok) {
        const text = await res.text();
        let errMsg = text;
        try {
          const json = JSON.parse(text);
          if (json.error) errMsg = json.error;
        } catch {}
        throw new Error(`[Nexus ${res.status}] ${errMsg}`);
      }
      return res.json();
    };

    switch (name) {
      case 'nexus_onboard':
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/onboard`, 'POST', {
          agent_id: args.agent_id,
          planned_work: args.planned_work || [],
          capabilities: args.capabilities || []
        });

      case 'nexus_advise_plan':
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/advise`, 'POST', {
          agent_id: args.agent_id,
          planned_work: args.planned_work || []
        });

      case 'nexus_report_milestone':
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/milestone`, 'POST', {
          agent_id: args.agent_id,
          description: args.description,
          lease_id_to_release: args.lease_id_to_release,
          memory: args.memory
        });

      case 'nexus_declare_intent':
        return apiFetch('/api/intents/declare', 'POST', {
          agent_id: args.agent_id,
          summary: args.summary,
          claims: args.claims || [],
          ttl_seconds: args.ttl_seconds || 300,
          project_id: args.project_id
        });

      case 'nexus_release_lease':
        return apiFetch(`/api/leases/${encodeURIComponent(args.lease_id)}/release`, 'POST', {
          agent_id: args.agent_id
        });

      case 'nexus_search_memory': {
        const params = new URLSearchParams();
        if (args.query) params.set('q', args.query);
        if (args.category) params.set('category', args.category);
        if (args.limit) params.set('limit', String(args.limit));
        const qs = params.toString() ? `?${params.toString()}` : '';
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/memories${qs}`, 'GET');
      }

      case 'nexus_save_memory':
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/memories`, 'POST', {
          category: args.category,
          key: args.key,
          content: args.content,
          source_agent_id: args.agent_id
        });

      case 'nexus_broadcast':
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/broadcast`, 'POST', {
          from: args.from || defaultAgentId,
          content: args.content,
          importance: args.importance || 'normal'
        });

      case 'nexus_status':
        return apiFetch(`/api/dashboard?project_id=${encodeURIComponent(args.project_id)}`, 'GET');

      case 'nexus_state': {
        const ns = encodeURIComponent(args.namespace || 'default');
        const key = args.key ? encodeURIComponent(args.key) : '';
        const pid = encodeURIComponent(args.project_id);

        if (args.action === 'get') {
          return apiFetch(`/api/state/${ns}/${key}?project_id=${pid}`, 'GET');
        }
        if (args.action === 'list') {
          const prefix = args.prefix ? `&prefix=${encodeURIComponent(args.prefix)}` : '';
          return apiFetch(`/api/state/${ns}?project_id=${pid}${prefix}`, 'GET');
        }
        if (args.action === 'set') {
          return apiFetch(`/api/state/${ns}/${key}`, 'POST', {
            value: args.value,
            updated_by: args.agent_id,
            ttl_seconds: args.ttl_seconds,
            project_id: args.project_id
          });
        }
        if (args.action === 'cas') {
          return apiFetch(`/api/state/${ns}/cas`, 'POST', {
            key: args.key,
            expected: args.expected,
            new_value: args.new_value,
            updated_by: args.agent_id,
            ttl_seconds: args.ttl_seconds,
            project_id: args.project_id
          });
        }
        if (args.action === 'delete') {
          return apiFetch(`/api/state/${ns}/${key}?project_id=${pid}`, 'DELETE');
        }
        throw new Error(`Unsupported state action: ${args.action}`);
      }

      case 'nexus_lock_resource':
        return apiFetch('/api/resources/lock', 'POST', {
          agent_id: args.agent_id,
          resource_name: args.resource_name,
          ttl_seconds: args.ttl_seconds || 300,
          reason: args.reason,
          project_id: args.project_id
        });

      case 'nexus_unlock_resource':
        return apiFetch('/api/resources/unlock', 'POST', {
          agent_id: args.agent_id,
          resource_name: args.resource_name,
          project_id: args.project_id
        });

      case 'nexus_report_progress':
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/progress`, 'POST', {
          agent_id: args.agent_id,
          summary: args.summary
        });

      case 'nexus_dialogue_send':
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/dialogue`, 'POST', {
          from: args.from || defaultAgentId,
          to: args.to || null,
          content: args.content,
          thread_id: args.thread_id || null,
          reply_to_id: args.reply_to_id || null,
          dialogue_type: args.dialogue_type || 'chat',
          importance: args.importance || 'normal'
        });

      case 'nexus_dialogue_read': {
        const params = new URLSearchParams();
        params.set('agent_id', args.agent_id);
        if (args.thread_id) params.set('thread_id', args.thread_id);
        if (args.unread_only) params.set('unread_only', 'true');
        if (args.mark_as_read !== undefined) params.set('mark_as_read', String(args.mark_as_read));
        if (args.limit) params.set('limit', String(args.limit));
        return apiFetch(`/api/projects/${encodeURIComponent(args.project_id)}/dialogue?${params.toString()}`, 'GET');
      }

      case 'nexus_message':
        return apiFetch('/api/messages', 'POST', {
          from: args.from || defaultAgentId,
          to: args.to || null,
          content: args.content,
          importance: args.importance || 'normal',
          project_id: args.project_id
        });

      default:
        throw new Error(`Unknown Nexus tool: ${name}`);
    }
  }

  async function executeTool(name, toolArgs) {
    if (inProcessContext) {
      return handleMcpTool(name, toolArgs, inProcessContext);
    }
    return executeHttpTool(name, toolArgs);
  }

  const rl = createInterface({
    input,
    output: null,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      // 忽略非 JSON 数据
      return;
    }

    if (!req || typeof req !== 'object') return;
    const { id, method, params } = req;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: {
            name: 'agent-nexus',
            version: '0.2.12'
          }
        }
      });
      return;
    }

    if (method === 'notifications/initialized') {
      // 客户端初始化确认通知，无需回复
      return;
    }

    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: ALL_NEXUS_TOOLS
        }
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      try {
        const result = await executeTool(toolName, toolArgs);
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
              }
            ]
          }
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: `[Agent-Nexus] Error: ${err.message}`
              }
            ]
          }
        });
      }
      return;
    }

    // 未知方法
    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      });
    }
  });

  return {
    rl,
    close: () => rl.close(),
    projectId,
    projectRoot
  };
}
