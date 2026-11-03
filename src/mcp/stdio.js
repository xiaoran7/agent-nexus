// =============================================================================
// Agent-Nexus MCP Stdio Transport Server
// =============================================================================

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolveProject } from '../domain/project.js';
import { ALL_NEXUS_TOOLS, handleMcpTool } from './server.js';
import { readSessionToken, readRemoteConfig, resolveNexusEndpoint } from '../transport/auth.js';

let MCP_VERSION = '0.3.2';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (pkg.version) MCP_VERSION = pkg.version;
} catch {}

export function startMcpStdio(options = {}) {
  const targetDir = options.projectRoot || process.cwd();
  const info = resolveProject(targetDir);
  const projectId = options.projectId || info.projectId;
  const projectRoot = options.projectRoot || info.projectRoot;

  const endpoint = resolveNexusEndpoint({
    baseUrl: options.baseUrl,
    host: options.host,
    port: options.port,
    token: options.token,
    nodeId: options.nodeId
  });
  const baseUrl = endpoint.baseUrl;
  const nodeId = endpoint.nodeId;
  let cachedToken = endpoint.token || '';

  function getActiveToken(forceRefresh = false) {
    if (options.token) return options.token;
    if (process.env.NEXUS_TOKEN) return process.env.NEXUS_TOKEN;
    if (process.env.NEXUS_ADMIN_TOKEN) return process.env.NEXUS_ADMIN_TOKEN;
    if (forceRefresh || !cachedToken) {
      const remoteCfg = readRemoteConfig();
      cachedToken = remoteCfg?.token || readSessionToken() || '';
    }
    return cachedToken;
  }

  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const inProcessContext = options.inProcessContext || null;

  const defaultAgentId = options.agentId ||
    process.env.NEXUS_AGENT_ID ||
    (process.env.CLAUDE_CODE_SESSION_ID
      ? `claude-${process.env.CLAUDE_CODE_SESSION_ID}`
      : (endpoint.isRemoteHub ? `agent-${nodeId}-${process.pid}` : `agent-${process.pid}`));

  function send(msg) {
    output.write(JSON.stringify(msg) + '\n');
  }

  async function executeHttpTool(name, rawArgs) {
    const args = { ...rawArgs };
    if (!args.project_id) args.project_id = projectId;
    if (!args.agent_id) args.agent_id = defaultAgentId;

    const apiFetch = async (path, method = 'GET', body = null, isRetry = false) => {
      const currentToken = getActiveToken(isRetry);
      const headers = {
        'Content-Type': 'application/json',
        ...(currentToken ? { 'Authorization': `Bearer ${currentToken}` } : {})
      };

      let res;
      try {
        res = await fetch(`${baseUrl}${path}`, {
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

      if (res.status === 401 && !isRetry) {
        const refreshedToken = getActiveToken(true);
        if (refreshedToken) {
          return apiFetch(path, method, body, true);
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

      case 'nexus_lock_resource':
        return apiFetch('/api/resources/lock', 'POST', {
          agent_id: args.agent_id,
          resource_name: args.resource_name,
          ttl_seconds: args.ttl_seconds,
          reason: args.reason,
          project_id: args.project_id
        });

      case 'nexus_unlock_resource':
        return apiFetch('/api/resources/unlock', 'POST', {
          agent_id: args.agent_id,
          resource_name: args.resource_name,
          project_id: args.project_id
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

      case 'nexus_status':
        return apiFetch(`/api/dashboard?project_id=${encodeURIComponent(args.project_id)}`, 'GET');

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
            version: MCP_VERSION
          }
        }
      });
      return;
    }

    if (method === 'notifications/initialized') {
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
