// =============================================================================
// Agent-Nexus MCP Server Transport
//
// 提供给 Claude Desktop / Cursor / ZCode 等标准 MCP Client 连接:
// 1. nexus_declare_intent: 声明意图与资源 claims (file/module/symbol)
// 2. nexus_release_lease: 释放租约并唤醒排队等待者
// 3. nexus_state: 共享命名空间 KV 与 CAS (Compare-And-Swap)
// 4. nexus_message: 向其他 Agent 发送定向或广播消息
// 5. nexus_status: 查询当前全局协调总览与冲突队列
// =============================================================================

export const NEXUS_TOOLS = [
  {
    name: 'nexus_declare_intent',
    description: 'Declare your work intent and resource claims (files, modules, symbols) before making code edits. Nexus will check for conflicts and grant a lease or place you in waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID (provider-session)' },
        summary: { type: 'string', description: 'Brief human-readable summary of what you are about to do' },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['file', 'module', 'symbol'] },
              target: { type: 'string', description: 'File path, module folder, or symbol name' }
            },
            required: ['type', 'target']
          },
          description: 'List of resources you plan to touch'
        },
        ttl_seconds: { type: 'number', description: 'Lease TTL in seconds (default 300)' }
      },
      required: ['agent_id', 'summary', 'claims']
    }
  },
  {
    name: 'nexus_release_lease',
    description: 'Release a held lease upon finishing or aborting your task. This triggers automatic wake-up for waiting sibling agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        lease_id: { type: 'string', description: 'Lease ID or Intent ID to release' }
      },
      required: ['agent_id', 'lease_id']
    }
  },
  {
    name: 'nexus_state',
    description: 'Shared namespaced Key-Value store with atomic CAS (Compare-And-Swap) support.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'list', 'cas'] },
        namespace: { type: 'string', description: 'Namespace (default "default")' },
        key: { type: 'string' },
        value: { type: 'string' },
        expected: { type: ['string', 'null'], description: 'Expected current value for CAS' },
        new_value: { type: 'string', description: 'New value for CAS' },
        ttl_seconds: { type: 'number' }
      },
      required: ['action']
    }
  },
  {
    name: 'nexus_message',
    description: 'Send a coordination message or notify other agents working on the same workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Your agent ID' },
        to: { type: 'string', description: 'Target agent ID (omit for broadcast)' },
        content: { type: 'string', description: 'Message body' },
        importance: { type: 'string', enum: ['normal', 'urgent'], default: 'normal' }
      },
      required: ['from', 'content']
    }
  },
  {
    name: 'nexus_status',
    description: 'Query current coordinator snapshot: active agents, claims, locks, and timeline.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

export function handleMcpTool(toolName, args, { coordinator, stateService, messageService }) {
  if (toolName === 'nexus_declare_intent') {
    return coordinator.declareIntent({
      agentId: args.agent_id,
      intentSummary: args.summary,
      claims: args.claims,
      ttlSeconds: args.ttl_seconds || 300
    });
  }

  if (toolName === 'nexus_release_lease') {
    return coordinator.releaseLease(args.lease_id, args.agent_id);
  }

  if (toolName === 'nexus_state') {
    const ns = args.namespace || 'default';
    if (args.action === 'get') return stateService.get(ns, args.key);
    if (args.action === 'set') return stateService.set(ns, args.key, args.value, args.updated_by || 'agent', args.ttl_seconds);
    if (args.action === 'delete') return { success: stateService.delete(ns, args.key) };
    if (args.action === 'list') return stateService.list(ns, args.prefix || '');
    if (args.action === 'cas') return stateService.compareAndSwap(ns, args.key, args.expected, args.new_value, args.updated_by || 'agent', args.ttl_seconds);
  }

  if (toolName === 'nexus_message') {
    return messageService.send({
      from: args.from,
      to: args.to || null,
      content: args.content,
      importance: args.importance || 'normal'
    });
  }

  if (toolName === 'nexus_status') {
    return coordinator.getDashboardSnapshot();
  }

  throw new Error(`Unknown Nexus MCP tool: ${toolName}`);
}
