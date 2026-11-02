// =============================================================================
// Agent-Nexus MCP Server Transport (Core Coordination & PowerContext Tools)
// =============================================================================

import { LEASE_POLICY } from '../daemon/coordinator.js';

export const NEXUS_TOOLS = [
  {
    name: 'nexus_declare_intent',
    description: 'Declare your work intent and resource claims (files, modules, symbols) before making code edits. Nexus will check for conflicts and grant a lease or place you in waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID (provider-session)' },
        project_id: { type: 'string', description: 'Project ID (default "default")' },
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
        lease_id: { type: 'string', description: 'Lease ID or Intent ID to release' },
        project_id: { type: 'string', description: 'Project ID' }
      },
      required: ['agent_id', 'lease_id']
    }
  },
  {
    name: 'nexus_status',
    description: 'Query current coordinator snapshot: active agents, claims, locks, and timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID (optional)' }
      }
    }
  },
  {
    name: 'nexus_lock_resource',
    description: 'Acquire an exclusive lock on a named shared resource (e.g., "tests", "dev-server", "build") to prevent concurrent collisions with sibling agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        resource_name: { type: 'string', description: 'Named exclusive resource (e.g. "tests", "dev-server", "build")' },
        reason: { type: 'string', description: 'Reason for holding the resource' },
        ttl_seconds: { type: 'number', description: 'Lock TTL in seconds (default 300)' },
        project_id: { type: 'string', description: 'Project ID (default "default")' }
      },
      required: ['agent_id', 'resource_name']
    }
  },
  {
    name: 'nexus_unlock_resource',
    description: 'Release an exclusive lock on a named shared resource (e.g., "tests", "dev-server", "build").',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        resource_name: { type: 'string', description: 'Named exclusive resource to release' },
        project_id: { type: 'string', description: 'Project ID (default "default")' }
      },
      required: ['agent_id', 'resource_name']
    }
  },
  {
    name: 'nexus_search_memory',
    description: 'Search long-term project memories (architecture decisions, rules, gotchas, milestones).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID (default "default")' },
        query: { type: 'string', description: 'Search keywords. Leave empty or omit to list latest memories.' },
        category: { type: 'string', enum: ['architecture', 'rule', 'gotcha', 'milestone', 'general'], description: 'Optional category filter' },
        limit: { type: 'number', description: 'Maximum results to return (default 20)' }
      }
    }
  },
  {
    name: 'nexus_save_memory',
    description: 'Save or update a piece of long-term project memory (e.g. an architectural decision, rule, gotcha, or milestone).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID (default "default")' },
        category: { type: 'string', enum: ['architecture', 'rule', 'gotcha', 'milestone', 'general'], description: 'Memory category' },
        key: { type: 'string', description: 'Unique slug/key (e.g. auth_protocol, oauth_callback)' },
        content: { type: 'string', description: 'The knowledge, rule, or decision details' },
        agent_id: { type: 'string', description: 'Agent ID or author' }
      },
      required: ['category', 'key', 'content']
    }
  }
];

export const NEXUS_PROJECT_TOOLS = NEXUS_TOOLS.slice(3);
export const ALL_NEXUS_TOOLS = NEXUS_TOOLS;

export function handleMcpTool(toolName, args, { coordinator, memoryService = null }) {
  const pid = args?.project_id || 'default';

  if (toolName === 'nexus_declare_intent') {
    return coordinator.declareIntent({
      agentId: args.agent_id,
      intentSummary: args.summary,
      claims: args.claims,
      ttlSeconds: args.ttl_seconds || LEASE_POLICY.fileTtlSeconds,
      projectId: pid
    });
  }

  if (toolName === 'nexus_release_lease') {
    return coordinator.releaseLease(args.lease_id, args.agent_id);
  }

  if (toolName === 'nexus_lock_resource') {
    return coordinator.acquireResourceLock({
      agentId: args.agent_id,
      resourceName: args.resource_name,
      ttlSeconds: args.ttl_seconds || LEASE_POLICY.resourceTtlSeconds,
      reason: args.reason || 'Resource held via MCP',
      projectId: pid
    });
  }

  if (toolName === 'nexus_unlock_resource') {
    return coordinator.releaseResourceLock({
      agentId: args.agent_id,
      resourceName: args.resource_name,
      projectId: pid
    });
  }

  if (toolName === 'nexus_search_memory') {
    if (!memoryService) return [];
    if (args.query) {
      return memoryService.search(pid, args.query, { category: args.category, limit: args.limit || 20 });
    }
    return memoryService.list(pid, { category: args.category, limit: args.limit || 20 });
  }

  if (toolName === 'nexus_save_memory') {
    if (!memoryService) throw new Error('MemoryService not initialized');
    return memoryService.set(pid, {
      category: args.category,
      key: args.key,
      content: args.content,
      sourceAgentId: args.agent_id || 'agent'
    });
  }

  if (toolName === 'nexus_status') {
    return coordinator.getDashboardSnapshot(args.project_id || null);
  }

  throw new Error(`Unknown Nexus MCP tool: ${toolName}`);
}
